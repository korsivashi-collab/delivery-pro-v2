// js/admin-dispatch-pdf.js

import { state } from "./admin-state.js";

// PDF.js 워커 경로 초기화
if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// ==========================================
// 0. 전화번호 표준화 헬퍼 (010-XXXX-XXXX)
// ==========================================
export function formatPhoneNumber(val) {
    if (!val) return '';
    const s = String(val).split('.')[0].trim();
    let digits = s.replace(/[^0-9]/g, '');
    if (!digits) return '';

    if (digits.length === 10 && digits.startsWith('10')) digits = '0' + digits;
    else if (digits.length === 9 && digits.startsWith('11')) digits = '0' + digits;

    if (digits.length === 11 && digits.startsWith('01')) {
        return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    } else if (digits.length === 10) {
        if (digits.startsWith('02')) {
            return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
        } else {
            return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
        }
    } else if (digits.length === 8) {
        return `${digits.slice(0, 4)}-${digits.slice(4)}`;
    }
    return digits;
}

// ==========================================
// 1. 단일 PDF 파일 로드 및 페이지별 텍스트 파싱
// ==========================================
export async function processSinglePdfFile(file) {
    if (!window.pdfjsLib) {
        alert("PDF 라이브러리가 로드되지 않았습니다. 인터넷 연결 상태를 확인하고 새로고침해 주세요.");
        return [];
    }

    const dropZone = document.getElementById('excel-drop-zone');
    const originalDropHtml = dropZone ? dropZone.innerHTML : '';

    try {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
        const pdf = await loadingTask.promise;
        const totalPages = pdf.numPages;

        const extractedOrders = [];
        const seenOrderNos = new Set();

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            if (dropZone) {
                dropZone.innerHTML = `
                    <div class="flex items-center gap-3 text-indigo-600 font-black text-sm">
                        <i class="fa-solid fa-circle-notch fa-spin text-xl"></i>
                        <span>대용량 PDF 분석 중... (${pageNum} / ${totalPages} 페이지)</span>
                    </div>`;
            }

            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            
            // Y 좌표를 기준으로 라인별 텍스트 결합
            const pageLines = groupTextContentByLines(textContent.items);
            const orderData = parseOrderFromPageLines(pageLines, pageNum);

            if (orderData && (orderData.address || orderData.storeName || orderData.orderNo)) {
                // 동일 주문번호 중복 등록 방지
                if (orderData.orderNo && seenOrderNos.has(orderData.orderNo)) {
                    continue;
                }
                if (orderData.orderNo) seenOrderNos.add(orderData.orderNo);
                extractedOrders.push(orderData);
            }
        }

        return extractedOrders;
    } catch (error) {
        console.error("PDF 파싱 오류:", error);
        alert(`PDF 파일 분석 중 오류가 발생했습니다: ${error.message}`);
        return [];
    } finally {
        if (dropZone) dropZone.innerHTML = originalDropHtml;
    }
}

// ==========================================
// 2. Y 좌표 기반 텍스트 라인 그룹화 헬퍼
// ==========================================
function groupTextContentByLines(items) {
    if (!items || items.length === 0) return [];

    const lineMap = new Map();

    items.forEach(item => {
        const str = item.str ? item.str.trim() : '';
        if (!str) return;

        const y = Math.round(item.transform[5]);
        const x = Math.round(item.transform[4]);

        let matchedY = null;
        for (const existingY of lineMap.keys()) {
            if (Math.abs(existingY - y) <= 4) {
                matchedY = existingY;
                break;
            }
        }

        const targetY = matchedY !== null ? matchedY : y;
        if (!lineMap.has(targetY)) {
            lineMap.set(targetY, []);
        }
        lineMap.get(targetY).push({ x, text: str });
    });

    const sortedYKeys = Array.from(lineMap.keys()).sort((a, b) => b - a);
    const sortedLines = [];

    sortedYKeys.forEach(yKey => {
        const lineItems = lineMap.get(yKey).sort((a, b) => a.x - b.x);
        const lineText = lineItems.map(i => i.text).join(' ').trim();
        if (lineText) sortedLines.push(lineText);
    });

    return sortedLines;
}

// ==========================================
// 3. 🌟 공급자 / 공급받는 자 영역 분리 및 주소 오인식 완벽 차단 엔진
// ==========================================
function parseOrderFromPageLines(lines, pageNum) {
    const rawFullText = lines.join('\n');

    // 1페이지 내에 공급자용/공급받는자용 2부가 존재할 경우 상단 1부만 깔끔하게 분리
    const parts = rawFullText.split(/거래명세표\s*\(공급받는자용\)|거래명세표\s*\(공급받는\s*자용\)/);
    const cleanText = parts[0];

    const order = {
        id: Date.now() + Math.random(),
        assignedDriver: null,
        senderName: '',
        orderNo: '',
        bizNo: '',
        address: '',
        storeName: '',
        phone: '',
        itemName: '',
        unit: '',
        qty: 1,
        price: '',
        total: '',
        memo: '',
        lat: null,
        lng: null,
        items: [] // 다품목 상품 리스트
    };

    // 1. 주문번호(orderNo) 추출
    const orderNoMatch = cleanText.match(/(?:주문\s*번호|오더\s*번호|관리\s*번호|발주\s*번호|No\.)[:\s]*([A-Z0-9_\-]+)/i);
    if (orderNoMatch) {
        order.orderNo = orderNoMatch[1].trim();
    } else {
        order.orderNo = `PDF-${pageNum}-${Date.now().toString().slice(-4)}`;
    }

    // 2. 🌟 공급받는 자 영역(buyerSection) 정밀 분리 (공급자 정보 완벽 배제)
    let buyerSection = '';
    const buyerSplit = cleanText.split(/공급받는\s*자/);
    if (buyerSplit.length > 1) {
        buyerSection = buyerSplit[buyerSplit.length - 1].split(/(?:No\.|상품명|규격\(단위\)|거래명세표)/)[0];
    } else {
        buyerSection = cleanText;
    }

    // 상호(간판명) 추출
    const storeMatch = buyerSection.match(/(?:배송지명\(간판명\)|배송지명|간판명|매장명|가게명)[:\s]*([^\n\r]+)/);
    if (storeMatch) {
        order.storeName = storeMatch[1].split(/연락처|전화|주소/)[0].replace(/[\(\)\[\]]/g, '').trim();
    }

    // 구매자명 추출
    const buyerMatch = buyerSection.match(/(?:구매자명|주문자명|수령인|수신자|받는\s*분|고객명)[:\s]*([^\n\r]+)/);
    if (buyerMatch) {
        order.senderName = buyerMatch[1].split(/주소|연락처|상호/)[0].replace(/[\(\)\[\]]/g, '').trim();
    }
    if (!order.storeName) order.storeName = order.senderName || '배송처';
    if (!order.senderName) order.senderName = order.storeName;

    // 3. 수령인 전화번호 정밀 추출
    const phoneMatch = buyerSection.match(/(?<!추가)연락처(?!\/FAX)[:\s]*([0-9\-]{8,15})/);
    if (phoneMatch) {
        order.phone = formatPhoneNumber(phoneMatch[1]);
    } else {
        const allPhones = buyerSection.match(/01[016789]-?\d{3,4}-?\d{4}/g) || buyerSection.match(/01[016789]\d{7,8}/g);
        if (allPhones && allPhones.length > 0) {
            order.phone = formatPhoneNumber(allPhones[allPhones.length - 1]);
        }
    }

    // 4. 🌟 '받 주소' 오인식 및 공급자 주소 혼선 방지 수령인 주소 정제 추출
    let addressPart = '';
    const addrIndex = buyerSection.indexOf('주소');
    if (addrIndex !== -1) {
        let subStr = buyerSection.slice(addrIndex + 2).trim();
        // 콜론이나 파이프 기기 제거
        subStr = subStr.replace(/^[:\s|]+/, '');
        // 다음 항목 키워드 전까지만 자르기
        subStr = subStr.split(/배송지명|간판명|연락처|No\.|전화|사업자/)[0];
        addressPart = subStr.replace(/[\r\n]+/g, ' ').trim();
    } else {
        const addrRegex = /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[\s\S]*?(?:동|읍|면|로|길|리)\s*[\d\-]+(?:\s*[가-힣0-9\s,\.\(\)\-]+)?/;
        const match = buyerSection.match(addrRegex);
        if (match) {
            addressPart = match[0].replace(/[\r\n]+/g, ' ').trim();
        }
    }

    // 오인식된 불필요 접두사('받', '주소' 등) 및 우편번호 박스 정제
    order.address = addressPart
        .replace(/^(?:받\s*주소|주소|받)[:\s]*/i, '')
        .replace(/^\[\d+\]\s*/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    // 5. 배송 메모 / 요청사항 추출
    const memoMatch = cleanText.match(/(?:배송\s*요청사항|배송\s*메모|요청사항|전달사항|비고)[:\s]*([^\n\r]+)/);
    if (memoMatch) {
        order.memo = memoMatch[1].trim();
    }

    // 6. 다품목 상품 리스트(items) 파싱
    const cleanLines = cleanText.split('\n').map(l => l.trim()).filter(l => l);
    let inItemTable = false;

    for (const line of cleanLines) {
        if (line.includes('No.') && (line.includes('상품명') || line.includes('규격'))) {
            inItemTable = true;
            continue;
        }

        if (inItemTable) {
            if (/결제\s*수단|총\s*상품수량|배송\s*요청사항|총\s*주문금액|배송비/i.test(line)) {
                inItemTable = false;
                break;
            }

            const rowMatch = line.match(/^(\d+)\s+(.+)/);
            if (rowMatch) {
                const rest = rowMatch[2];
                const priceMatch = rest.match(/(\d+)\s+[\d,]+(?:\s+[\d,]+)*$/);
                if (priceMatch) {
                    const qtyNum = parseInt(priceMatch[1], 10) || 1;
                    const nameStr = rest.slice(0, priceMatch.index).trim();
                    const unitMatch = nameStr.match(/(개|EA|박스|box|kg|g|팩|포|캔|묶음|판|ea)/i);
                    const unitStr = unitMatch ? unitMatch[0] : '개';

                    order.items.push({ name: nameStr, qty: qtyNum, unit: unitStr });
                } else {
                    const qtyMatch = rest.match(/(\d+)\s*(개|EA|박스|box|kg|g|팩|포|캔|묶음|판|ea)/i);
                    if (qtyMatch) {
                        const qtyNum = parseInt(qtyMatch[1], 10) || 1;
                        const unitStr = qtyMatch[2];
                        const nameStr = rest.replace(qtyMatch[0], '').trim();
                        order.items.push({ name: nameStr || rest, qty: qtyNum, unit: unitStr });
                    } else {
                        order.items.push({ name: rest, qty: 1, unit: '개' });
                    }
                }
            }
        }
    }

    // 대표 품목명 설정
    if (order.items.length > 1) {
        order.qty = order.items.reduce((sum, item) => sum + (item.qty || 1), 0);
        order.itemName = `${order.items[0].name} 외 ${order.items.length - 1}건 (총 ${order.qty}개)`;
    } else if (order.items.length === 1) {
        order.qty = order.items[0].qty || 1;
        order.itemName = `${order.items[0].name} (${order.qty}${order.items[0].unit})`;
    }

    return order;
}

// ==========================================
// 4. 주소 좌표(위/경도) 변환 및 일괄 등록
// ==========================================
async function getCoordsFromAddress(address) {
    return new Promise((resolve) => {
        if (!address || !window.kakao || !window.kakao.maps || !window.kakao.maps.services) { 
            resolve(null); 
            return; 
        }
        const geocoder = new window.kakao.maps.services.Geocoder();
        geocoder.addressSearch(address.trim(), (result, status) => {
            if (status === window.kakao.maps.services.Status.OK && result[0]) {
                let fullAddress = result[0].address_name;
                if (result[0].road_address && result[0].road_address.address_name) {
                    fullAddress = result[0].road_address.address_name;
                }
                resolve({ lat: parseFloat(result[0].y), lng: parseFloat(result[0].x), fullAddress: fullAddress });
            } else { 
                resolve(null); 
            }
        });
    });
}

export async function batchGeocodePdfList(items) {
    const dropZone = document.getElementById('excel-drop-zone');
    const originalDropHtml = dropZone ? dropZone.innerHTML : '';

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (dropZone) {
            dropZone.innerHTML = `
                <div class="flex items-center gap-3 text-indigo-600 font-black text-sm">
                    <i class="fa-solid fa-circle-notch fa-spin text-xl"></i>
                    <span>PDF 배송지 좌표 분석 중... (${i + 1} / ${items.length})</span>
                </div>`;
        }

        if (item.address && (!item.lat || !item.lng)) {
            const coords = await getCoordsFromAddress(item.address);
            if (coords) {
                item.lat = coords.lat;
                item.lng = coords.lng;
            }
            await new Promise(r => setTimeout(r, 40));
        }
    }

    if (dropZone) dropZone.innerHTML = originalDropHtml;
}

// ==========================================
// 5. 전역 Window 객체 바인딩
// ==========================================
window.formatPhoneNumber = formatPhoneNumber;
window.processSinglePdfFile = processSinglePdfFile;
window.batchGeocodePdfList = batchGeocodePdfList;