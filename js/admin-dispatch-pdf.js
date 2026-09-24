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
            
            // 좌표 기반 텍스트 라인화 (좌/우 공간 분리 포함)
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
        
        // PDF X좌표 230~250을 기준으로 보통 좌측(공급자), 우측(공급받는자)이 나뉨
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
// 4. 업계 표준 Line-by-Line 기반 키워드 파싱 엔진 (우선순위 적용)
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

    // 1단계: 라인(Line) 분류 및 1순위(공급자 정보) 원천 차단
    lines.forEach(line => {
        // 상품 테이블 진입 감지
        if (/No\.|상품명|단가|수량|규격/i.test(line.fullText)) isItemSection = true;

        if (isItemSection) {
            // 테이블 종료 감지
            if (/결제\s*수단|총\s*상품수량|배송비|총\s*주문금액|합계/i.test(line.fullText)) {
                isItemSection = false;
            } else if (/^\d+\s+/.test(line.fullText.trim())) {
                parseItemLine(line.fullText, items);
            }
        } else {
            // 우측 영역(공급받는 자) 텍스트가 명확히 있으면 우측만 사용, 없으면 전체 라인 사용
            let targetText = (line.rightText && line.rightText.length > 2) ? line.rightText : line.fullText;
            
            // 발송자(공급자)를 뜻하는 키워드가 포함된 줄은 수취자 데이터 공간에서 절대 배제
            if (!/공급자|대표자|윤진유통|사업자등록번호|통신판매/.test(targetText)) {
                buyerSectionLines.push(targetText);
            }
        }

        // 주문번호 및 메모는 포지션과 무관하게 감지
        if (!memo && /(?:배송\s*요청사항|배송메모|요청사항|비고)\s*[:|]?\s*(.+)/.test(line.fullText)) {
            memo = line.fullText.match(/(?:배송\s*요청사항|배송메모|요청사항|비고)\s*[:|]?\s*(.+)/)[1].trim();
        }
        if (/주문번호|오더번호|발주번호/.test(line.fullText)) {
            const m = line.fullText.match(/(?:주문번호|오더번호|발주번호)\s*[:|]?\s*([A-Z0-9_\-]+)/i);
            if (m) orderNo = m[1].trim();
        }
    });

    // 2단계: 수집된 수취자(Buyer) 영역을 한 줄씩 돌며 우선순위 매칭
    buyerSectionLines.forEach(text => {
        
        // [순위 1] 간판명 / 배송지명 / 매장 / 상호 (발견 시 덮어쓰기)
        if (/(?:배송지명|간판명|매장명|가게명|상호명|상호)/.test(text)) {
            let val = text.replace(/.*(?:배송지명\(간판명\)|배송지명|간판명|매장명|가게명|상호\(법인명\)|상호명|상호)\s*[:|]?\s*/i, '').trim();
            if (val && !/^\d+$/.test(val)) storeName = val; 
        }
        
        // [순위 2] 구매자 / 수령인 / 고객 / 이름 (상호명이 비어있을 때를 대비한 백업)
        if (!senderName && /(?:구매자명|주문자명|주문자|수령인|수신자|받는\s*분|받는분|고객명)/.test(text)) {
            let val = text.replace(/.*(?:구매자명|주문자명|주문자|수령인|수신자|받는\s*분|받는분|고객명)\s*[:|]?\s*/i, '').trim();
            if (val && !/^\d+$/.test(val)) senderName = val;
        }
        
        // [순위 3] 연락처
        if (!phone && /(?:연락처|전화|휴대폰|핸드폰)/.test(text)) {
            let m = text.match(/[0-9\-]{9,15}/);
            if (m) phone = formatPhoneNumber(m[0]);
        } else if (!phone) {
            let m = text.match(/01[016789]-?\d{3,4}-?\d{4}/);
            if (m) phone = formatPhoneNumber(m[0]);
        }
        
        // [순위 4] 주소 (행정구역명으로 시작하는 순수 주소 라인 매칭)
        if (!address && /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/.test(text)) {
            if (!/(배송지|연락처|구매자|상호|주문)/.test(text)) {
                // 우편번호 [00000] 제거 및 괄호(건물명 등) 뒷부분 절단
                address = text.replace(/\[\d+\]/, '').replace(/^[|:\s]+/, '').split('(')[0].trim();
            }
        }
    });

    // 3단계: 누락분 보완 (줄바꿈이 이상하게 되어 라인이 찢어진 경우를 대비한 보험 로직)
    const fullBuyerString = buyerSectionLines.join(' ');
    if (!storeName) {
        const m = fullBuyerString.match(/(?:배송지명\(간판명\)|배송지명|간판명|매장명|가게명|상호)\s*[:|]\s*([^\s\d]+(?:[ \t]+[^\s\d]+)*)/);
        if (m) storeName = m[1].trim();
    }
    if (!senderName) {
        const m = fullBuyerString.match(/(?:구매자명|수령인|받는\s*분)\s*[:|]\s*([^\s\d]+(?:[ \t]+[^\s\d]+)*)/);
        if (m) senderName = m[1].trim();
    }

    // 최종 정리: 상호명이 없으면 구매자명을 상호명으로 격상
    if (!storeName) storeName = senderName || '배송처 미상';
    if (!senderName) senderName = storeName;

    // 아이템 수량 합산 처리 (외 N품목 배지는 이 itemName을 기반으로 UI에서 출력됨)
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