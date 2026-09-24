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
// 2. Y축 정렬 및 X축 기준 좌/우(공급자/수취자) 분리 엔진
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
            if (Math.abs(existingY - y) <= 4) matchedY = existingY;
        }

        const targetY = matchedY !== null ? matchedY : y;
        if (!lineMap.has(targetY)) lineMap.set(targetY, []);
        lineMap.get(targetY).push({ x, text: str });
    });

    const sortedYKeys = Array.from(lineMap.keys()).sort((a, b) => b - a);
    const sortedLines = [];

    sortedYKeys.forEach(yKey => {
        const lineItems = lineMap.get(yKey).sort((a, b) => a.x - b.x);
        const fullText = lineItems.map(i => i.text).join(' ').trim();
        
        const leftItems = lineItems.filter(i => i.x < 240);
        const rightItems = lineItems.filter(i => i.x >= 240);
        
        const leftText = leftItems.map(i => i.text).join(' ').trim();
        const rightText = rightItems.map(i => i.text).join(' ').trim();

        if (fullText) {
            sortedLines.push({ y: yKey, fullText, leftText, rightText });
        }
    });

    return sortedLines;
}

// ==========================================
// 3. 상품 테이블 전용 파싱 헬퍼
// ==========================================
function parseItemLine(text, itemsArray) {
    const rowMatch = text.match(/^(\d+)\s+(.+)/);
    if (!rowMatch) return;
    
    const rest = rowMatch[2];
    const priceMatch = rest.match(/(\d+)\s+[\d,]+(?:\s+[\d,]+)*$/);
    
    if (priceMatch) {
        const qtyNum = parseInt(priceMatch[1], 10) || 1;
        const nameStr = rest.slice(0, priceMatch.index).trim();
        const unitMatch = nameStr.match(/(개|EA|박스|box|kg|g|팩|포|캔|묶음|판|ea)/i);
        const unitStr = unitMatch ? unitMatch[0] : '개';
        itemsArray.push({ name: nameStr, qty: qtyNum, unit: unitStr });
    } else {
        const qtyMatch = rest.match(/(\d+)\s*(개|EA|박스|box|kg|g|팩|포|캔|묶음|판|ea)/i);
        if (qtyMatch) {
            const qtyNum = parseInt(qtyMatch[1], 10) || 1;
            const unitStr = qtyMatch[2];
            const nameStr = rest.replace(qtyMatch[0], '').trim();
            itemsArray.push({ name: nameStr || rest, qty: qtyNum, unit: unitStr });
        } else {
            itemsArray.push({ name: rest, qty: 1, unit: '개' });
        }
    }
}

// ==========================================
// 4. 주문 정보 파싱 및 특수 주소/상호 규칙 적용 엔진
// ==========================================
function parseOrderFromPageLines(lines, pageNum) {
    let storeName = '';
    let senderName = '';
    let phone = '';
    let address = '';
    let memo = '';
    let orderNo = `PDF-${pageNum}-${Date.now().toString().slice(-4)}`;
    let items = [];

    let isItemSection = false;
    let buyerSectionLines = [];
    let fullRawTextLines = [];

    lines.forEach(line => {
        fullRawTextLines.push(line.fullText);

        if (/No\.|상품명|단가|수량|규격/i.test(line.fullText)) isItemSection = true;

        if (isItemSection) {
            if (/결제\s*수단|총\s*상품수량|배송비|총\s*주문금액|합계/i.test(line.fullText)) {
                isItemSection = false;
            } else if (/^\d+\s+/.test(line.fullText.trim())) {
                parseItemLine(line.fullText, items);
            }
        } else {
            let targetText = (line.rightText && line.rightText.length > 2) ? line.rightText : line.fullText;
            // 공급자(발송자) 정보 원천 차단
            if (!/공급자|대표자|윤진유통|사업자등록번호|통신판매/.test(targetText)) {
                buyerSectionLines.push(targetText);
            }
        }

        if (!memo && /(?:배송\s*요청사항|배송메모|요청사항|비고)\s*[:|]?\s*(.+)/.test(line.fullText)) {
            memo = line.fullText.match(/(?:배송\s*요청사항|배송메모|요청사항|비고)\s*[:|]?\s*(.+)/)[1].trim();
        }
        if (/주문번호|오더번호|발주번호/.test(line.fullText)) {
            const m = line.fullText.match(/(?:주문번호|오더번호|발주번호)\s*[:|]?\s*([A-Z0-9_\-]+)/i);
            if (m) orderNo = m[1].trim();
        }
    });

    // 1단계: 수취자 영역에서 상호, 구매자, 전화번호 추출
    buyerSectionLines.forEach(text => {
        if (/(?:배송지명|간판명|매장명|가게명|상호명|상호)/.test(text)) {
            let val = text.replace(/.*(?:배송지명\(간판명\)|배송지명|간판명|매장명|가게명|상호\(법인명\)|상호명|상호)\s*[:|]?\s*/i, '').trim();
            if (val && !/^\d+$/.test(val)) storeName = val; 
        }
        
        if (!senderName && /(?:구매자명|주문자명|주문자|수령인|수신자|받는\s*분|받는분|고객명)/.test(text)) {
            let val = text.replace(/.*(?:구매자명|주문자명|주문자|수령인|수신자|받는\s*분|받는분|고객명)\s*[:|]?\s*/i, '').trim();
            if (val && !/^\d+$/.test(val)) senderName = val;
        }
        
        if (!phone && /(?:연락처|전화|휴대폰|핸드폰)/.test(text)) {
            let m = text.match(/[0-9\-]{9,15}/);
            if (m) phone = formatPhoneNumber(m[0]);
        } else if (!phone) {
            let m = text.match(/01[016789]-?\d{3,4}-?\d{4}/);
            if (m) phone = formatPhoneNumber(m[0]);
        }
    });

    // 보완 매칭
    const fullBuyerString = buyerSectionLines.join(' ');
    if (!storeName) {
        const m = fullBuyerString.match(/(?:배송지명\(간판명\)|배송지명|간판명|매장명|가게명|상호)\s*[:|]\s*([^\s\d]+(?:[ \t]+[^\s\d]+)*)/);
        if (m) storeName = m[1].trim();
    }
    if (!senderName) {
        const m = fullBuyerString.match(/(?:구매자명|수령인|받는\s*분)\s*[:|]\s*([^\s\d]+(?:[ \t]+[^\s\d]+)*)/);
        if (m) senderName = m[1].trim();
    }

    if (!storeName) storeName = senderName || '배송처 미상';
    if (!senderName) senderName = storeName;

    // 🌟 2단계: 상호명 앞의 불필요한 특수기호 및 공백 정제 (예: ") ", ")" 제거)
    storeName = storeName.replace(/^[)|\]}>\s]+/, '').trim();

    // 🌟 3단계: 특수 주소 파싱 규칙 적용
    // (서울, 대전, 대구, 부산 등 행정구역 인식 시점부터 주소를 긁어오고, '('가 나타나면 그 뒷부분은 모두 날림)
    const combinedRawText = fullRawTextLines.join(' ');
    const regionRegex = /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\n\r]*/i;
    const regionMatch = combinedRawText.match(regionRegex);

    if (regionMatch) {
        let rawAddr = regionMatch[0];
        // 불필요한 라벨이나 전화번호 영역 전까지만 컷팅
        rawAddr = rawAddr.split(/(?:연락처|전화|배송지|간판|상호|구매자|No\.|결제)/)[0];
        rawAddr = rawAddr.replace(/\[\d+\]/g, '').trim();

        // 🌟 핵심 규칙: '('가 인식이 되면 '('와 그 뒷부분은 모두 날림
        const parenIdx = rawAddr.indexOf('(');
        if (parenIdx !== -1) {
            rawAddr = rawAddr.slice(0, parenIdx);
        }

        address = rawAddr.replace(/\s{2,}/g, ' ').trim();
    }

    // 아이템 수량 합산 처리
    let qty = 1;
    let itemName = '';
    if (items.length > 1) {
        qty = items.reduce((sum, item) => sum + (item.qty || 1), 0);
        itemName = `${items[0].name} 외 ${items.length - 1}건`;
    } else if (items.length === 1) {
        qty = items[0].qty || 1;
        itemName = `${items[0].name} (${qty}${items[0].unit})`;
    }

    return {
        id: Date.now() + Math.random(),
        assignedDriver: null,
        senderName,
        orderNo,
        bizNo: '',
        address,
        storeName,
        phone,
        itemName,
        unit: items.length > 0 ? items[0].unit : '개',
        qty,
        price: '',
        total: '',
        memo,
        lat: null,
        lng: null,
        items
    };
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