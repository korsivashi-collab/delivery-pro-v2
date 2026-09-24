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

            // 좌우 분할 기반 정밀 주문 파서 실행
            const orderData = parseOrderFromPageItems(textContent.items, viewport, pageNum);

            if (orderData && (orderData.address || orderData.storeName || orderData.orderNo)) {
                if (orderData.orderNo && seenOrderNos.has(orderData.orderNo)) {
                    continue; // 중복 주문 방지
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
// 🌟 3. 좌우 컬럼 분할 및 공급받는 자(배송처) 정밀 추출 엔진
// ==========================================
function parseOrderFromPageItems(items, viewport, pageNum) {
    if (!items || items.length === 0) return null;

    const pageWidth = viewport.width || 595;
    const pageHeight = viewport.height || 842;

    // 1. 하단 2부(공급받는자용 복제본) 분리점 감지 (상단 1부만 파싱하여 중복 방지)
    let cutOffY = 0;
    items.forEach(it => {
        if (/거래명세표\s*\(공급받는자용\)/.test(it.str)) {
            cutOffY = Math.max(cutOffY, it.transform[5]);
        }
    });

    // 2. 공급자와 공급받는 자를 나누는 가로 경계선(splitX) 자동 감지
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

    // 3. 품목 테이블 시작 높이(tableStartY) 감지
    let tableStartY = pageHeight * 0.55;
    items.forEach(it => {
        if (it.transform[5] > cutOffY && (it.str.includes('No.') || it.str.includes('상품명'))) {
            tableStartY = it.transform[5];
        }
    });

    // 4. 아이템 영역별 분류
    // (1) 상단 공급받는 자(배송 목적지) 전용 영역: X >= splitX & Y > tableStartY
    const buyerItems = [];
    // (2) 전체 상단 텍스트 (주문번호 추출용)
    const upperItems = [];
    // (3) 품목 및 하단 요약 영역: Y <= tableStartY & Y > cutOffY
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

    // [1] 주문번호(orderNo) 추출
    const orderNoMatch = upperFullText.match(/(?:주문\s*번호|오더\s*번호|관리\s*번호|발주\s*번호|No\.)[:\s]*([A-Z0-9_\-]+)/i);
    if (orderNoMatch) {
        order.orderNo = orderNoMatch[1].trim();
    } else {
        order.orderNo = `PDF-${pageNum}-${Date.now().toString().slice(-4)}`;
    }

    // [2] 공급받는 자 정보 추출 (buyerLines에서만 안전하게 추출 -> 공급자 주소 혼입 100% 차단)
    let rawAddressParts = [];
    let isCollectingAddr = false;

    buyerLines.forEach((line) => {
        const cleanLine = line.trim();

        // (가) 사업자등록번호
        const bizMatch = cleanLine.match(/(?:사업자등록번호|사업자번호)[:\s]*([0-9\-]+)/);
        if (bizMatch) order.bizNo = bizMatch[1].trim();

        // (나) 구매자명 / 주문자명
        const buyerMatch = cleanLine.match(/(?:구매자명|주문자명|수령인|고객명)[:\s]*([가-힣a-zA-Z0-9\s]+)/);
        if (buyerMatch && !cleanLine.includes('사업자') && !cleanLine.includes('상호')) {
            order.senderName = buyerMatch[1].replace(/주소|배송지|연락처/g, '').trim();
        }

        // (다) 배송지명(간판명) / 상호명 -> storeName
        if (cleanLine.includes('배송지명') || cleanLine.includes('간판명') || cleanLine.includes('상호')) {
            const rawStore = cleanLine.replace(/.*(?:배송지명\(간판명\)|배송지명|간판명|상호\(법인명\)|상호)[:\s]*/, '').trim();
            const filteredStore = rawStore.split(/연락처|전화|주소|구매자/)[0].trim();
            if (filteredStore) {
                order.storeName = filteredStore;
            }
        }

        // (라) 연락처 / 전화번호
        const phoneMatch = cleanLine.match(/01[016789]-?\d{3,4}-?\d{4}/) || cleanLine.match(/0\d{1,2}-?\d{3,4}-?\d{4}/) || cleanLine.match(/01[016789]\d{7,8}/);
        if (phoneMatch) {
            order.phone = formatPhoneNumber(phoneMatch[0]);
        }

        // (마) 배송지 주소 정밀 수집
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

    // 주소 완성 및 정제
    let fullAddr = rawAddressParts.join(' ').replace(/^\[\d+\]\s*/, '').replace(/\s{2,}/g, ' ').trim();
    fullAddr = fullAddr.split(/배송지명|간판명|연락처|전화/)[0].trim();
    order.address = fullAddr;

    // 상호명이 비어있을 경우 구매자명으로 폴백, 둘 다 없으면 '배송처'
    if (!order.storeName && order.senderName) order.storeName = order.senderName;
    if (!order.storeName) order.storeName = '배송처';

    // [3] 품목 리스트 및 배송 요청사항 파싱
    let inItemTable = false;

    bottomLines.forEach(line => {
        const cleanLine = line.trim();

        // 배송 요청사항
        const memoMatch = cleanLine.match(/(?:배송\s*요청사항|배송\s*메모|요청사항|전달사항|비고)[:\s]*([^\n\r]+)/);
        if (memoMatch) {
            order.memo = memoMatch[1].trim();
        }

        // 품목 테이블 행 감지
        if (cleanLine.includes('No.') && (cleanLine.includes('상품명') || cleanLine.includes('규격'))) {
            inItemTable = true;
            return;
        }

        if (inItemTable) {
            if (/결제\s*수단|총\s*상품수량|총\s*주문금액|배송비/i.test(cleanLine)) {
                inItemTable = false;
                return;
            }

            // 행 번호(1, 2, 3...)로 시작하는 상품 파싱
            const rowMatch = cleanLine.match(/^(\d+)\s+(.+)/);
            if (rowMatch) {
                const rest = rowMatch[2];
                // 수량 + 가격 패턴 탐색
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

    // 대표 품목명 및 수량 설정
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
// 4. 주소 좌표(위/경도) 정밀 변환 엔진
// ==========================================
function cleanAddressForSearch(addr) {
    if (!addr) return '';
    let clean = addr.replace(/^\[\d+\]\s*/, '');
    clean = clean.replace(/\([^)]*\)/g, ' ');
    clean = clean.replace(/\s+(지하|지상)?\s*\d+층.*$/i, '');
    clean = clean.replace(/\s+\d+호.*$/i, '');
    clean = clean.replace(/\s+B\d+.*$/i, '');
    return clean.replace(/\s{2,}/g, ' ').trim();
}

async function getCoordsFromAddress(address) {
    return new Promise((resolve) => {
        if (!address || !window.kakao || !window.kakao.maps || !window.kakao.maps.services) { 
            resolve(null); 
            return; 
        }
        const geocoder = new window.kakao.maps.services.Geocoder();

        // 1차 검색: 원본 주소
        geocoder.addressSearch(address.trim(), (res1, stat1) => {
            if (stat1 === window.kakao.maps.services.Status.OK && res1[0]) {
                const fullAddr = (res1[0].road_address && res1[0].road_address.address_name) 
                    ? res1[0].road_address.address_name 
                    : res1[0].address_name;
                resolve({ lat: parseFloat(res1[0].y), lng: parseFloat(res1[0].x), fullAddress: fullAddr });
                return;
            }

            // 2차 검색: 상세 층/호수 정제 주소
            const cleanAddr = cleanAddressForSearch(address);
            if (cleanAddr && cleanAddr !== address.trim()) {
                geocoder.addressSearch(cleanAddr, (res2, stat2) => {
                    if (stat2 === window.kakao.maps.services.Status.OK && res2[0]) {
                        const fullAddr = (res2[0].road_address && res2[0].road_address.address_name) 
                            ? res2[0].road_address.address_name 
                            : res2[0].address_name;
                        resolve({ lat: parseFloat(res2[0].y), lng: parseFloat(res2[0].x), fullAddress: fullAddr });
                        return;
                    }

                    // 3차 검색: 도로명/지번 기본 패턴
                    const basicMatch = cleanAddr.match(/^(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[\s\S]*?(?:로|길|동|읍|면|리)\s*[\d\-]+/);
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