// js/admin-dispatch-pdf.js

import { state } from "./admin-state.js";

// PDF.js 워커 경로 초기화
if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
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
            
            // 텍스트 블록의 Y 좌표를 기준으로 라인별 텍스트 정렬 결합
            const pageLines = groupTextContentByLines(textContent.items);
            const orderData = parseOrderFromPageLines(pageLines, pageNum);

            if (orderData && (orderData.address || orderData.storeName || orderData.orderNo)) {
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

    // PDF 좌표계의 Y 기준 오차(3px 이내) 허용 그룹화
    const lineMap = new Map();

    items.forEach(item => {
        const str = item.str ? item.str.trim() : '';
        if (!str) return;

        const y = Math.round(item.transform[5]);
        const x = Math.round(item.transform[4]);

        let matchedY = null;
        for (const existingY of lineMap.keys()) {
            if (Math.abs(existingY - y) <= 3) {
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

    // Y 기준 위에서 아래로(내림차순), X 기준 왼쪽에서 오른쪽으로(오름차순) 정렬
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
// 3. 한 페이지(1개 주문 단위) 정보 구조화 정규식 엔진
// ==========================================
function parseOrderFromPageLines(lines, pageNum) {
    const rawFullText = lines.join('\n');

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
        items: [] // 🌟 한 주문에 속한 복수 상품 목록
    };

    // 1. 주문번호(orderNo) 추출
    const orderNoMatch = rawFullText.match(/(?:주문\s*번호|오더\s*번호|관리\s*번호|No\.)[:\s]*([A-Z0-9_\-]+)/i);
    if (orderNoMatch) {
        order.orderNo = orderNoMatch[1].trim();
    } else {
        order.orderNo = `PDF-${pageNum}-${Date.now().toString().slice(-4)}`;
    }

    // 2. 수령인 / 상호(storeName) 추출
    const storeMatch = rawFullText.match(/(?:받는\s*분|상호|수령인|수신자|고객명|간판명)[:\s]*([^\n\r,]+)/);
    if (storeMatch) {
        order.storeName = storeMatch[1].replace(/[\(\)\[\]]/g, '').trim();
    }

    // 3. 전화번호(phone) 추출 (휴대폰 우선 매칭)
    const phoneMatch = rawFullText.match(/01[016789]-?\d{3,4}-?\d{4}/) || rawFullText.match(/0\d{1,2}-?\d{3,4}-?\d{4}/);
    if (phoneMatch) {
        order.phone = phoneMatch[0].trim();
    }

    // 4. 주소(address) 추출 (도로명/지번 패턴 기반 자동 감지)
    const addrRegex = /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[\s\S]*?(?:동|읍|면|로|길|리)\s*[\d\-]+(?:\s*[가-힣0-9\s,\.\(\)\-]+)?/;
    const addrMatch = rawFullText.match(addrRegex);
    if (addrMatch) {
        order.address = addrMatch[0].replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    } else {
        const addrLine = lines.find(l => /주소|배송지/i.test(l));
        if (addrLine) {
            order.address = addrLine.replace(/.*(?:주소|배송지)[:\s]*/i, '').trim();
        }
    }

    // 5. 배송 메모 / 요청사항(memo) 추출
    const memoMatch = rawFullText.match(/(?:요청\s*사항|배송\s*메모|비고)[:\s]*([^\n\r]+)/);
    if (memoMatch) {
        order.memo = memoMatch[1].trim();
    }

    // 6. 다품목 상품 리스트(items) 파싱
    lines.forEach(line => {
        // 품목명 + 수량 패턴 감지 (예: 삼겹살 500g 2개 또는 사과박스 3EA)
        const qtyMatch = line.match(/(\d+)\s*(개|EA|박스|box|kg|g|팩|포|캔)/i);
        if (qtyMatch && !line.includes('전화') && !line.includes('주소') && !line.includes('사업자')) {
            const qtyNum = parseInt(qtyMatch[1], 10);
            const unitStr = qtyMatch[2];
            const namePart = line.replace(qtyMatch[0], '').replace(/[\d,]+원/g, '').trim();

            if (namePart && namePart.length >= 2) {
                order.items.push({
                    name: namePart,
                    qty: qtyNum || 1,
                    unit: unitStr || '개'
                });
            }
        }
    });

    // 대표 품목명 설정
    if (order.items.length > 0) {
        order.itemName = order.items.length === 1 
            ? `${order.items[0].name} (${order.items[0].qty}${order.items[0].unit})`
            : `${order.items[0].name} 외 ${order.items.length - 1}건`;
        order.qty = order.items.reduce((sum, item) => sum + (item.qty || 1), 0);
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
window.processSinglePdfFile = processSinglePdfFile;
window.batchGeocodePdfList = batchGeocodePdfList;