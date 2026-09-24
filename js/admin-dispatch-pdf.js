// js/admin-dispatch-pdf.js

import { state } from "./admin-state.js";

// PDF.js 워커 경로 초기화
if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// ==========================================
// 0. 전화번호 복원 및 표준화 헬퍼 (010-XXXX-XXXX)
// ==========================================
export function formatPhoneNumber(val) {
    if (!val) return '';
    const s = String(val).split('.')[0].trim();
    let digits = s.replace(/[^0-9]/g, '');
    if (!digits) return '';

    if (digits.length === 10 && digits.startsWith('10')) digits = '0' + digits;
    else if (digits.length === 9 && digits.startsWith('11')) digits = '0' + digits;
    else if (digits.length === 9 && digits.startsWith('16')) digits = '0' + digits;
    else if (digits.length === 9 && digits.startsWith('17')) digits = '0' + digits;
    else if (digits.length === 9 && digits.startsWith('18')) digits = '0' + digits;
    else if (digits.length === 9 && digits.startsWith('19')) digits = '0' + digits;

    if (digits.length === 11 && digits.startsWith('01')) {
        return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    } else if (digits.length === 10) {
        if (digits.startsWith('02')) {
            return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
        } else {
            return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
        }
    } else if (digits.length === 9 && digits.startsWith('02')) {
        return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
    } else if (digits.length === 8) {
        return `${digits.slice(0, 4)}-${digits.slice(4)}`;
    }
    return digits;
}

// ==========================================
// 1. 단일 PDF 파일 로드 및 정밀 파싱
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
                        <span>대용량 PDF 배송 데이터 분석 중... (${pageNum} / ${totalPages} 페이지)</span>
                    </div>`;
            }

            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const viewport = page.getViewport({ scale: 1.0 });

            const orderData = parseOrderFromPageItems(textContent.items, viewport, pageNum);

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
// 3. 공급받는 자(배송처) 추출 및 정밀 파싱
// ==========================================
function parseOrderFromPageItems(items, viewport, pageNum) {
    if (!items || items.length === 0) return null;

    const pageWidth = viewport.width || 595;
    const pageHeight = viewport.height || 842;

    let cutOffY = 0;
    items.forEach(it => {
        if (/거래명세표\s*\(공급받는자용\)/.test(it.str)) {
            cutOffY = Math.max(cutOffY, it.transform[5]);
        }
    });

    let supplierX = null;
    let buyerX = null;
    items.forEach(it => {
        if (it.transform[5] > cutOffY) {
            if (/공급자/.test(it.str) && supplierX === null) supplierX = it.transform[4];
            if (/공급받는\s*자/.test(it.str) && buyerX === null) buyerX = it.transform[4];
        }
    });

    const splitX = (supplierX !== null && buyerX !== null && buyerX > supplierX)
        ? (supplierX + buyerX) / 2
        : (pageWidth * 0.48);

    let tableStartY = pageHeight * 0.55;
    items.forEach(it => {
        if (it.transform[5] > cutOffY && (it.str.includes('No.') || it.str.includes('상품명'))) {
            tableStartY = it.transform[5];
        }
    });

    const buyerItems = [];
    const upperItems = [];
    const bottomItems = [];

    items.forEach(it => {
        const y = it.transform[5];
        const x = it.transform[4];
        if (y > cutOffY) {
            upperItems.push(it);
            if (y > tableStartY) {
                if (x >= (splitX - 15)) {
                    buyerItems.push(it);
                }
            } else {
                bottomItems.push(it);
            }
        }
    });

    const upperFullText = upperItems.map(i => i.str).join(' ');
    const buyerLines = groupTextContentByLines(buyerItems);
    const bottomLines = groupTextContentByLines(bottomItems);

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

    // 1. 주문번호 추출
    const orderNoMatch = upperFullText.match(/(?:주문\s*번호|오더\s*번호|관리\s*번호|발주\s*번호|No\.)[:\s]*([A-Z0-9_\-]+)/i);
    if (orderNoMatch) {
        order.orderNo = orderNoMatch[1].trim();
    } else {
        order.orderNo = `PDF-${pageNum}-${Date.now().toString().slice(-4)}`;
    }

    // 2. 공급받는 자 정보 추출
    let rawAddressParts = [];
    let isCollectingAddr = false;

    buyerLines.forEach((line) => {
        const cleanLine = line.trim();

        // 사업자등록번호
        const bizMatch = cleanLine.match(/(?:사업자등록번호|사업자번호)[:\s]*([0-9\-]+)/);
        if (bizMatch) order.bizNo = bizMatch[1].trim();

        // 구매자명
        const buyerMatch = cleanLine.match(/(?:구매자명|주문자명|수령인|고객명)[:\s]*([가-힣a-zA-Z0-9\s]+)/);
        if (buyerMatch && !cleanLine.includes('사업자') && !cleanLine.includes('상호')) {
            order.senderName = buyerMatch[1].replace(/주소|배송지|연락처/g, '').trim();
        }

        // 배송지명(간판명)
        if (cleanLine.includes('배송지명') || cleanLine.includes('간판명')) {
            const rawStore = cleanLine.replace(/.*(?:배송지명\(간판명\)|배송지명|간판명)[:\s]*/, '').trim();
            const filteredStore = rawStore.split(/연락처|전화|주소|구매자/)[0].trim();
            if (filteredStore) {
                order.storeName = filteredStore;
            }
        }

        // 연락처
        const phoneMatch = cleanLine.match(/01[016789]-?\d{3,4}-?\d{4}/) || cleanLine.match(/0\d{1,2}-?\d{3,4}-?\d{4}/) || cleanLine.match(/01[016789]\d{7,8}/);
        if (phoneMatch) {
            order.phone = formatPhoneNumber(phoneMatch[0]);
        }

        // 배송지 주소 수집
        if (cleanLine.includes('주소')) {
            isCollectingAddr = true;
            const afterAddr = cleanLine.replace(/.*주소[:\s]*/, '').trim();
            if (afterAddr) rawAddressParts.push(afterAddr);
        } else if (isCollectingAddr) {
            if (cleanLine.includes('배송지명') || cleanLine.includes('간판명') || cleanLine.includes('연락처') || cleanLine.includes('전화')) {
                isCollectingAddr = false;
            } else {
                rawAddressParts.push(cleanLine);
            }
        }
    });

    // 주소 정제 (우편번호 [08289] 등 제거)
    let fullAddr = rawAddressParts.join(' ').replace(/^\[\d+\]\s*/, '').replace(/\s{2,}/g, ' ').trim();
    fullAddr = fullAddr.split(/배송지명|간판명|연락처|전화/)[0].trim();
    order.address = fullAddr;

    if (!order.storeName && order.senderName) order.storeName = order.senderName;
    if (!order.storeName) order.storeName = '배송처';

    // 3. 품목 및 요청사항 파싱
    let inItemTable = false;

    bottomLines.forEach(line => {
        const cleanLine = line.trim();

        const memoMatch = cleanLine.match(/(?:배송\s*요청사항|배송\s*메모|요청사항|전달사항|비고)[:\s]*([^\n\r]+)/);
        if (memoMatch) {
            order.memo = memoMatch[1].trim();
        }

        if (cleanLine.includes('No.') && (cleanLine.includes('상품명') || cleanLine.includes('규격'))) {
            inItemTable = true;
            return;
        }

        if (inItemTable) {
            if (/결제\s*수단|총\s*상품수량|총\s*주문금액|배송비/i.test(cleanLine)) {
                inItemTable = false;
                return;
            }

            const rowMatch = cleanLine.match(/^(\d+)\s+(.+)/);
            if (rowMatch) {
                const rest = rowMatch[2];
                const priceMatch = rest.match(/(\d+)\s+[\d,]+(?:\s+[\d,]+)*$/);
                if (priceMatch) {
                    const qtyNum = parseInt(priceMatch[1], 10) || 1;
                    const namePart = rest.slice(0, priceMatch.index).trim();
                    const unitMatch = namePart.match(/(개|EA|박스|box|kg|g|팩|포|캔|묶음|판|ea)/i);
                    const unitStr = unitMatch ? unitMatch[0] : '개';

                    order.items.push({
                        name: namePart,
                        qty: qtyNum,
                        unit: unitStr
                    });
                } else {
                    const qtyMatch = rest.match(/(\d+)\s*(개|EA|박스|box|kg|g|팩|포|캔|묶음|판|ea)/i);
                    if (qtyMatch) {
                        const qtyNum = parseInt(qtyMatch[1], 10) || 1;
                        const unitStr = qtyMatch[2];
                        const namePart = rest.replace(qtyMatch[0], '').trim();
                        order.items.push({
                            name: namePart || rest,
                            qty: qtyNum,
                            unit: unitStr
                        });
                    } else {
                        order.items.push({
                            name: rest,
                            qty: 1,
                            unit: '개'
                        });
                    }
                }
            }
        }
    });

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
// 🌟 4. 주소 좌표(위/경도) 지오코딩 엔진 (요청 규칙: '(' 감지 시 '(' 포함 뒷부분 완전 삭제)
// ==========================================
function cleanAddressByOpenParen(addr) {
    if (!addr) return '';
    let s = addr.replace(/^\[\d+\]\s*/, '').trim(); // 우편번호만 제거
    
    // 🌟 요청 규칙: '(' 문자가 걸리면 '('를 포함한 뒷부분 전체 삭제
    const parenIndex = s.indexOf('(');
    if (parenIndex !== -1) {
        s = s.substring(0, parenIndex).trim();
    }
    return s;
}

async function getCoordsFromAddress(address) {
    return new Promise((resolve) => {
        if (!address || !window.kakao || !window.kakao.maps || !window.kakao.maps.services) { 
            resolve(null); 
            return; 
        }
        const geocoder = new window.kakao.maps.services.Geocoder();

        // 🌟 1차 검색: '(' 걸리면 뒷부분을 통째로 삭제한 정제 주소로 직접 검색
        // 예: "서울 구로구 공원로6나길 43-2 (구로동)..." -> "서울 구로구 공원로6나길 43-2" (도로명+번지수 보존)
        // 예: "서울 종로구 종로40길 18 (종로5가)..." -> "서울 종로구 종로40길 18" (도로명+번지수 보존)
        const targetCleanAddr = cleanAddressByOpenParen(address);

        geocoder.addressSearch(targetCleanAddr, (res1, stat1) => {
            if (stat1 === window.kakao.maps.services.Status.OK && res1[0]) {
                const fullAddr = (res1[0].road_address && res1[0].road_address.address_name) 
                    ? res1[0].road_address.address_name 
                    : res1[0].address_name;
                resolve({ lat: parseFloat(res1[0].y), lng: parseFloat(res1[0].x), fullAddress: fullAddr });
                return;
            }

            // 2차 검색: 원본 주소로 폴백 시도
            geocoder.addressSearch(address.trim(), (res2, stat2) => {
                if (stat2 === window.kakao.maps.services.Status.OK && res2[0]) {
                    const fullAddr = (res2[0].road_address && res2[0].road_address.address_name) 
                        ? res2[0].road_address.address_name 
                        : res2[0].address_name;
                    resolve({ lat: parseFloat(res2[0].y), lng: parseFloat(res2[0].x), fullAddress: fullAddr });
                    return;
                }

                // 3차 검색: 도로명/지번 기본 패턴만 탐색
                const basicMatch = targetCleanAddr.match(/^(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[\s\S]*?(?:로|길|동|읍|면|리)\s*[\d\-]+/);
                if (basicMatch) {
                    geocoder.addressSearch(basicMatch[0], (res3, stat3) => {
                        if (stat3 === window.kakao.maps.services.Status.OK && res3[0]) {
                            resolve({ lat: parseFloat(res3[0].y), lng: parseFloat(res3[0].x), fullAddress: res3[0].address_name });
                        } else {
                            resolve(null);
                        }
                    });
                } else {
                    resolve(null);
                }
            });
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
                    <span>배송지 좌표 정밀 분석 중... (${i + 1} / ${items.length})</span>
                </div>`;
        }

        if (item.address && (!item.lat || !item.lng)) {
            const coords = await getCoordsFromAddress(item.address);
            if (coords) {
                item.lat = coords.lat;
                item.lng = coords.lng;
            }
            await new Promise(r => setTimeout(r, 45));
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