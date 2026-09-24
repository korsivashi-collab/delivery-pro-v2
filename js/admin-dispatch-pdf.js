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
            
            const pageLines = groupTextContentByLines(textContent.items);
            const orderData = parseOrderFromPageLines(pageLines, pageNum);

            if (orderData && (orderData.address || orderData.storeName || orderData.orderNo)) {
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
// 2. Y축 정렬 및 공급받는 자(우측) 텍스트 분리
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
        const fullText = lineItems.map(i => i.text).join(' ').trim();
        
        // 2단 양식(좌측 공급자 / 우측 공급받는자) 분리를 위한 x 좌표 필터링
        const rightItems = lineItems.filter(i => i.x > 220);
        const rightText = rightItems.map(i => i.text).join(' ').trim();

        if (fullText) {
            sortedLines.push({
                y: yKey,
                fullText: fullText,
                rightText: rightText
            });
        }
    });

    return sortedLines;
}

// ==========================================
// 3. 범용 우선순위 가점(Scoring) 파싱 헬퍼
// ==========================================
const NEXT_STOP_WORDS = /(?=\s*(?:연락처|전화|휴대폰|핸드폰|주소|배송지\s*주소|사업자|구매자|수령인|수신자|받는\s*분|고객|간판|상호|매장|가게|결제|총\s*상품|배송비|요청사항|비고|메모|No\.|상품명|$))/i;

function cleanExtractedValue(val) {
    if (!val) return '';
    return val
        .replace(/^[|:\-\s]+/, '')
        .replace(/[|:\-\s]+$/, '')
        .replace(/\(공급받는자용\)|\(공급자보관용\)|\(보관용\)/gi, '')
        .trim();
}

// 🌟 단어 조각 기반 가점 평가 엔진
function extractByPriorityScoring(text) {
    const candidateStoreList = [];
    const candidateBuyerList = [];

    // 정규식: 라벨 키워드 감지 (간판, 배송, 매장, 상호, 가게, 구매자, 고객, 수령, 이름 등)
    const labelRegex = /(?:([가-힣a-zA-Z0-9\(\)\s]{2,15})[:\s|]+)([\s\S]*?)(?=(?:[가-힣a-zA-Z0-9\(\)\s]{2,15}[:\s|]+)|$)/g;

    let match;
    while ((match = labelRegex.exec(text)) !== null) {
        const rawLabel = match[1].trim();
        let rawVal = match[2];

        // 다음 필드 키워드가 나오면 그 앞까지만 절단
        const stopIdx = rawVal.search(NEXT_STOP_WORDS);
        if (stopIdx !== -1) {
            rawVal = rawVal.substring(0, stopIdx);
        }

        const cleanVal = cleanExtractedValue(rawVal);
        if (!cleanVal || cleanVal.length < 2 || cleanVal.length > 35) continue;

        // 주소/전화번호 형태는 상호명 점수에서 배제
        if (/(?:시|구|동|로|길)\s*\d+/.test(cleanVal) || /^[0-9\-]+$/.test(cleanVal)) continue;

        let storeScore = 0;
        let buyerScore = 0;

        // 🌟 1. 간판 단어 인식 (+50점)
        if (rawLabel.includes('간판')) {
            storeScore += 50;
        }
        // 🌟 2. 배송 단어 인식 (+40점) - 주소/메모/비용 제외
        else if (rawLabel.includes('배송') && !rawLabel.includes('주소') && !rawLabel.includes('메모') && !rawLabel.includes('요청') && !rawLabel.includes('비')) {
            storeScore += 40;
        }
        // 🌟 3. 매장 / 가게 / 점포 단어 인식 (+35점)
        else if (rawLabel.includes('매장') || rawLabel.includes('가게') || rawLabel.includes('점포')) {
            storeScore += 35;
        }
        // 🌟 4. 상호 / 법인 단어 인식 (+30점)
        else if (rawLabel.includes('상호') || rawLabel.includes('법인')) {
            storeScore += 30;
        }

        // 🌟 5. 구매자 / 수령인 / 이름 단어 인식 (+10 ~ 20점)
        if (rawLabel.includes('구매자') || rawLabel.includes('주문자')) {
            buyerScore += 20;
        } else if (rawLabel.includes('수령') || rawLabel.includes('수신') || rawLabel.includes('받는') || rawLabel.includes('고객')) {
            buyerScore += 15;
        } else if (rawLabel.includes('이름') || rawLabel.includes('성명')) {
            buyerScore += 10;
        }

        if (storeScore > 0) {
            candidateStoreList.push({ val: cleanVal, score: storeScore });
        }
        if (buyerScore > 0) {
            candidateBuyerList.push({ val: cleanVal, score: buyerScore });
        }
    }

    // 가장 높은 점수의 항목 채택
    candidateStoreList.sort((a, b) => b.score - a.score);
    candidateBuyerList.sort((a, b) => b.score - a.score);

    const bestStore = candidateStoreList.length > 0 ? candidateStoreList[0].val : '';
    const bestBuyer = candidateBuyerList.length > 0 ? candidateBuyerList[0].val : '';

    return { storeName: bestStore, senderName: bestBuyer };
}

// ==========================================
// 4. 정보 추출 및 주문 객체 파싱 엔진
// ==========================================
function parseOrderFromPageLines(lines, pageNum) {
    const rawFullText = lines.map(l => l.fullText).join('\n');
    
    // 🌟 1순위: 공급자 / 발송자 / 판매자 정보 원천 차단 (공급자 블록 전체 제거)
    let safeText = rawFullText.replace(/(?:공급자|발송자|판매자|보내는\s*분|출하지)[\s\S]*?(?=(?:공급받는\s*자|구매자|수령인|수신자|받는\s*분|배송지|주문자|No\.|상품명|$))/gi, ' ');

    // 2단 문서 우측(공급받는 자 영역) 텍스트 분리
    let buyerSectionLines = [];
    let isHeaderArea = true;
    lines.forEach(line => {
        if (line.fullText.includes('No.') && (line.fullText.includes('상품명') || line.fullText.includes('규격'))) {
            isHeaderArea = false;
        }
        if (isHeaderArea && line.rightText) {
            buyerSectionLines.push(line.rightText);
        }
    });
    const buyerSectionText = buyerSectionLines.join(' ');
    const searchTargetText = buyerSectionText.length > 25 ? buyerSectionText : safeText;

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
        items: []
    };

    // 1. 주문번호
    const orderNoMatch = safeText.match(/(?:주문\s*번호|오더\s*번호|관리\s*번호|발주\s*번호)[:\s|]*([A-Z0-9_\-]+)/i);
    if (orderNoMatch) order.orderNo = orderNoMatch[1].trim();
    else order.orderNo = `PDF-${pageNum}-${Date.now().toString().slice(-4)}`;

    // 2. 상호(간판/배송/매장/상호) 및 구매자명 가점 기반 추출
    const { storeName, senderName } = extractByPriorityScoring(searchTargetText);
    order.storeName = storeName;
    order.senderName = senderName;

    // 만약 한쪽만 추출된 경우 보완 매칭
    if (!order.storeName) order.storeName = order.senderName || '배송처';
    if (!order.senderName) order.senderName = order.storeName;

    // 3. 연락처 추출 및 포맷팅
    const phoneMatch = searchTargetText.match(/(?:연락처|전화|휴대폰|핸드폰)[:\s|]*([0-9\-]{8,15})/i) || searchTargetText.match(/01[016789]-?\d{3,4}-?\d{4}/) || searchTargetText.match(/01[016789]\d{7,8}/);
    if (phoneMatch) {
        order.phone = formatPhoneNumber(phoneMatch[1] || phoneMatch[0]);
    }

    // 4. 주소 추출 (행정구역 감지 + 괄호 뒷부분 삭제 규칙 유지)
    const addrRegex = /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\n\r|]*(?=\s*(?:연락처|전화|배송지|간판|상호|No\.|결제|$))/i;
    const match = searchTargetText.match(addrRegex);

    if (match) {
        let rawAddr = match[0];
        // 우편번호 및 라벨 잡음 제거
        rawAddr = rawAddr.replace(/받\s*주소/g, ' ').replace(/\b받\b/g, ' ').replace(/\b주소\b/g, ' ').replace(/\[\d+\]/g, ' ').trim();
        
        // 괄호 '(' 인식 시 뒷부분 통째로 삭제
        const parenIndex = rawAddr.indexOf('(');
        if (parenIndex !== -1) {
            rawAddr = rawAddr.slice(0, parenIndex);
        }
        order.address = rawAddr.replace(/\s{2,}/g, ' ').trim();
    }

    // 5. 배송 메모
    const memoMatch = safeText.match(/(?:배송\s*요청사항|배송요청사항|배송\s*메모|요청사항|전달사항|비고)[:\s|]*([^\n\r]+)/i);
    if (memoMatch) {
        order.memo = memoMatch[1].split(/거래명세표|No\.|총\s*주문금액/)[0].trim();
    }

    // 6. 다품목 상품 리스트 파싱 (표 형식)
    const cleanLines = safeText.split('\n').map(l => l.trim()).filter(l => l);
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
// 5. 주소 좌표(위/경도) 변환 및 일괄 등록
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
// 6. 전역 Window 객체 바인딩
// ==========================================
window.formatPhoneNumber = formatPhoneNumber;
window.processSinglePdfFile = processSinglePdfFile;
window.batchGeocodePdfList = batchGeocodePdfList;