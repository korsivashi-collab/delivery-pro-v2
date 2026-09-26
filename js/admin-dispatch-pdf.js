// js/admin-dispatch-pdf.js

import { state } from "./admin-state.js";

// PDF.js 워커 경로 초기화
if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// ==========================================
// 0. 로컬 스토리지 기반 주소 캐시(Cache) 관리 엔진
// ==========================================
const GEO_CACHE_KEY = 'deliveryPro_geoCache';
let memoryGeoCache = null;

function getGeoCache() {
    if (memoryGeoCache !== null) return memoryGeoCache;
    try {
        const stored = localStorage.getItem(GEO_CACHE_KEY);
        memoryGeoCache = stored ? JSON.parse(stored) : {};
    } catch (e) {
        memoryGeoCache = {};
    }
    return memoryGeoCache;
}

function saveGeoCache(cache) {
    try {
        const keys = Object.keys(cache);
        if (keys.length > 3000) {
            const trimmedCache = {};
            keys.slice(keys.length - 2000).forEach(k => { trimmedCache[k] = cache[k]; });
            memoryGeoCache = trimmedCache;
            localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(trimmedCache));
            return;
        }
        localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
        console.warn("주소 캐시 저장 실패:", e);
    }
}

// ==========================================
// 1. 전화번호 표준화 헬퍼 (010-XXXX-XXXX)
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
// 2. 단일 PDF 파일 로드 및 페이지별 파싱 실행
// ==========================================
export async function processSinglePdfFile(file) {
    if (!window.pdfjsLib) {
        alert("PDF 라이브러리가 로드되지 않았습니다. 새로고침 후 다시 시도해 주세요.");
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
        const seenOrderKeys = new Set();

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            if (dropZone) {
                dropZone.innerHTML = `
                    <div class="flex items-center gap-3 text-indigo-600 font-black text-sm">
                        <i class="fa-solid fa-circle-notch fa-spin text-xl"></i>
                        <span>대용량 PDF 정밀 분석 중... (${pageNum} / ${totalPages} 페이지)</span>
                    </div>`;
            }

            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent({ normalizeWhitespace: true });
            const viewport = page.getViewport({ scale: 1.0 });

            // X좌표 기준 좌(공급자) / 우(공급받는자) 분리 파싱
            const pageOrders = parseSinglePageOrder(textContent.items, pageNum, viewport.width, viewport.height, file.name);

            pageOrders.forEach(ord => {
                const uniqueKey = ord.orderNo && !ord.orderNo.startsWith('PDF-')
                    ? ord.orderNo
                    : `${ord.address}___${ord.storeName}`;

                if (!seenOrderKeys.has(uniqueKey) && (ord.address || ord.storeName)) {
                    seenOrderKeys.add(uniqueKey);
                    extractedOrders.push(ord);
                }
            });
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
// 3. X좌표 분리 및 공급받는 자(배송지) 전용 정밀 추출 엔진
// ==========================================
function parseSinglePageOrder(items, pageNum, pageWidth, pageHeight, fileName) {
    if (!items || items.length === 0) return [];

    // 유효한 텍스트 토큰 추출 및 좌표 정규화
    const validTokens = items.filter(it => it.str && it.str.trim() !== '').map(it => ({
        text: it.str.trim(),
        x: Math.round(it.transform[4]),
        y: Math.round(it.transform[5])
    }));

    if (validTokens.length === 0) return [];

    // 페이지 전체 텍스트
    const allTextJoined = validTokens.map(it => it.text).join(' ');

    // 1. 주문번호 감지
    let orderNo = `PDF-${pageNum}-${Date.now().toString().slice(-4)}`;
    const orderNoMatch = allTextJoined.match(/(?:주문번호|오더번호|발주번호)[\s:|]*([A-Z0-9_\-]+)/i);
    if (orderNoMatch) {
        orderNo = orderNoMatch[1].trim();
    }

    // 2. 담당 기사 감지
    let assignedDriver = null;
    const driverMatch = allTextJoined.match(/(?:담당기사|배송기사|기사명)[\s:|]*([가-힣A-Za-z0-9_\-]+)/);
    if (driverMatch) {
        const dVal = driverMatch[1].trim();
        if (!/^(주문|발주|배송|No|공급|거래)/.test(dVal)) {
            assignedDriver = dVal;
        }
    }

    // 3. 발송사(공급자 화주) 상호 감지
    let senderName = '';
    const provStoreMatch = allTextJoined.match(/공급자[\s\S]*?(?:상호\(법인명\)|상호명|상호)[\s:|]*([가-힣A-Za-z0-9\(\)\s]{2,20})/);
    if (provStoreMatch) {
        senderName = provStoreMatch[1].split(/[\n\r|]/)[0].trim();
    } else {
        const generalStoreMatch = allTextJoined.match(/상호\(법인명\)[\s:|]*([가-힣A-Za-z0-9\(\)\s]{2,20})/);
        if (generalStoreMatch) senderName = generalStoreMatch[1].split(/[\n\r|]/)[0].trim();
    }
    if (!senderName && fileName) {
        senderName = fileName.replace(/\.[^/.]+$/, '').split(/[_\-\s]+/)[0].trim();
    }
    if (!senderName) senderName = '정보 없음';

    // 🌟 핵심: A4 너비 기준 공급자(좌측)와 공급받는 자(우측) 영역 물리적 분리
    // 상단 인적사항 테이블 영역은 보통 X축 42%~45% 이상이 공급받는 자(수취처)
    const splitX = pageWidth * 0.42;

    // 상단 블록(수취자 인적사항 영역) 추출: 상품 테이블 시작 전(보통 y > pageHeight * 0.4)이면서 우측 영역
    const buyerTokens = validTokens.filter(t => t.x >= splitX && t.y >= pageHeight * 0.35);
    const buyerTextCombined = buyerTokens.map(t => t.text).join(' ');

    // 4. 배송지명(간판명) 추출
    let storeName = '';
    const storeRegexList = [
        /(?:배송지명\(간판명\)|배송지명|간판명|매장명|가게명)[\s:|]*([^\n\r|]+)/i,
        /공급받는\s*자[\s\S]*?(?:상호\(법인명\)|상호명|상호)[\s:|]*([^\n\r|]+)/i
    ];
    for (const reg of storeRegexList) {
        const m = buyerTextCombined.match(reg) || allTextJoined.match(reg);
        if (m) {
            let val = m[1].replace(/^[|:>\s]+/, '').trim();
            val = val.split(/(?:연락처|전화|주소|사업자|No\.|구매자)/)[0].trim();
            if (val && val !== '|' && val.length > 1) {
                storeName = val;
                break;
            }
        }
    }

    // 5. 구매자명 추출
    let buyerName = '';
    const buyerMatch = buyerTextCombined.match(/(?:구매자명|주문자명|수령인|수취인|받는분)[\s:|]*([가-힣A-Za-z0-9]{2,10})/);
    if (buyerMatch) {
        buyerName = buyerMatch[1].trim();
    }

    if (!storeName) storeName = buyerName || '배송처';
    storeName = storeName.replace(/^[)|\]}>\s]+/, '').trim();

    // 6. 고객 연락처 추출 (공급자 추가연락처 010-8776-5400 배제)
    let phone = '';
    // 수취자 영역에서 우선 검색
    const buyerPhones = buyerTextCombined.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g) || [];
    if (buyerPhones.length > 0) {
        phone = formatPhoneNumber(buyerPhones[0]);
    } else {
        // 하이픈 없는 11자리 휴대폰 번호 검색
        const noHyphenMatches = buyerTextCombined.match(/01[016789]\d{7,8}/g) || [];
        if (noHyphenMatches.length > 0) {
            phone = formatPhoneNumber(noHyphenMatches[0]);
        }
    }

    // 7. 배송지 주소 정밀 추출 (수취자 영역 전용)
    let rawAddress = '';

    // 수취자 토큰들 중 대한민국 시/도로 시작하는 도로명/지번 패턴 검색
    const regionRegex = /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[가-힣A-Za-z0-9\s\(\)\-\,\.]{5,80}?(?:로|길|대로|동|읍|면|리|가)\s*[\d\-]+(?:\s*[가-힣A-Za-z0-9\(\)\,\-\.\s]*)/g;
    
    const buyerAddrMatches = buyerTextCombined.match(regionRegex) || [];
    if (buyerAddrMatches.length > 0) {
        rawAddress = buyerAddrMatches[0];
    } else {
        // 공급자 주소(예: 건원대로 등)를 배제하고 전체 텍스트에서 2번째 매칭 탐색
        const allAddrMatches = allTextJoined.match(regionRegex) || [];
        const filtered = allAddrMatches.filter(a => !a.includes('건원대로') && !a.includes('공급자'));
        if (filtered.length > 0) {
            rawAddress = filtered[0];
        } else if (allAddrMatches.length > 1) {
            rawAddress = allAddrMatches[1];
        } else if (allAddrMatches.length > 0) {
            rawAddress = allAddrMatches[0];
        }
    }

    // 라벨 및 잡음 제거
    rawAddress = rawAddress.split(/(?:연락처|전화|배송지명|간판명|매장명|상호|구매자|No\.|결제|인수자)/)[0];
    rawAddress = rawAddress.replace(/\[\d+\]/g, ' ')
                           .replace(/받\s*주소/g, ' ')
                           .replace(/\b받\b/g, ' ')
                           .replace(/\b주소\b/g, ' ')
                           .replace(/\|/g, ' ')
                           .replace(/[:]/g, ' ')
                           .trim();

    // 🌟 전체 원본 주소 (상세 호수, 층수 보존)
    const fullAddress = rawAddress.replace(/\s{2,}/g, ' ').trim();

    // 🌟 내비/관제용 정제 주소:
    // 도로명+숫자+길(예: 공원로6나길 43-2)이 손상되지 않도록 괄호 앞까지만 안전하게 절삭
    let cleanAddr = fullAddress;
    const parenIdx = cleanAddr.indexOf('(');
    if (parenIdx !== -1) {
        cleanAddr = cleanAddr.slice(0, parenIdx);
    }
    const address = cleanAddr.replace(/\s{2,}/g, ' ').trim();

    // 8. 수취자 사업자번호 추출
    let bizNo = '';
    const bizMatches = buyerTextCombined.match(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/g) || [];
    if (bizMatches.length > 0) {
        bizNo = bizMatches[0].replace(/\s+/g, '-');
    } else {
        const allBiz = allTextJoined.match(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/g) || [];
        if (allBiz.length >= 2) bizNo = allBiz[1].replace(/\s+/g, '-');
    }

    // 9. 배송 요청사항 추출
    let memo = '';
    const memoMatch = allTextJoined.match(/(?:배송\s*요청사항|배송메모|요청사항|비고)[\s:|]*([^\n\r|]+)/);
    if (memoMatch) {
        memo = memoMatch[1].split(/(?:총\s*상품수량|총주문금액|인수자|배송비|총\s*상품금액)/)[0].trim();
    }

    // 10. 품목 테이블 파싱
    // 행 단위로 묶기
    const lineMap = new Map();
    validTokens.forEach(t => {
        let matchedY = null;
        for (const ey of lineMap.keys()) {
            if (Math.abs(ey - t.y) <= 4) { matchedY = ey; break; }
        }
        const targetY = matchedY !== null ? matchedY : t.y;
        if (!lineMap.has(targetY)) lineMap.set(targetY, []);
        lineMap.get(targetY).push(t);
    });

    const sortedYKeys = Array.from(lineMap.keys()).sort((a, b) => b - a);
    const orderItems = [];

    sortedYKeys.forEach(yKey => {
        const lineTokens = lineMap.get(yKey).sort((a, b) => a.x - b.x);
        const lineStr = lineTokens.map(t => t.text).join(' ').trim();

        // 번호(1~99)로 시작하는 상품 라인 탐색
        const rowMatch = lineStr.match(/^(\d{1,2})\s+([★\[\(\w가-힣\s\/\-\.]+?)(?:\s+(\d+(?:\.\d+)?[a-zA-Z가-힣\*]*))?\s+(?:국내산|중국산|수입산)?\s*(\d+)\s+([\d,]+)/);
        if (rowMatch) {
            const pName = rowMatch[2].trim().replace(/^[|>\s]+/, '');
            const pUnit = rowMatch[3] ? rowMatch[3].trim() : '개';
            const pQty = parseInt(rowMatch[4], 10) || 1;
            const pPrice = parseInt(rowMatch[5].replace(/,/g, ''), 10) || 0;
            const pTotal = pPrice * pQty;

            orderItems.push({
                name: pName,
                qty: pQty,
                unit: pUnit,
                price: pPrice,
                total: pTotal
            });
        }
    });

    let qty = orderItems.length > 0 ? orderItems.reduce((sum, it) => sum + it.qty, 0) : 1;
    let itemName = '';
    if (orderItems.length > 1) {
        itemName = `${orderItems[0].name} 외 ${orderItems.length - 1}건 (총 ${qty}개)`;
    } else if (orderItems.length === 1) {
        itemName = `${orderItems[0].name} (${orderItems[0].qty}${orderItems[0].unit})`;
    } else {
        itemName = '상품 정보 미등록';
    }

    return [{
        id: Date.now() + Math.random(),
        assignedDriver: assignedDriver,
        senderName: senderName,
        buyerName: buyerName,
        orderNo: orderNo,
        bizNo: bizNo,
        address: address,
        fullAddress: fullAddress || address,
        storeName: storeName,
        phone: phone,
        itemName: itemName,
        unit: orderItems.length > 0 ? orderItems[0].unit : '개',
        qty: qty,
        price: '',
        total: '',
        memo: memo,
        lat: null,
        lng: null,
        items: orderItems
    }];
}

// ==========================================
// 4. 주소 좌표(위/경도) 지오코딩 엔진 (캐시 우선 확인)
// ==========================================
async function getCoordsFromAddress(address) {
    if (!address) return null;
    const cleanKey = address.trim();
    if (!cleanKey) return null;

    const cache = getGeoCache();
    if (cache[cleanKey]) {
        return cache[cleanKey];
    }

    return new Promise((resolve) => {
        if (!window.kakao || !window.kakao.maps || !window.kakao.maps.services) { 
            resolve(null); 
            return; 
        }
        const geocoder = new window.kakao.maps.services.Geocoder();
        geocoder.addressSearch(cleanKey, (result, status) => {
            if (status === window.kakao.maps.services.Status.OK && result[0]) {
                let fullAddress = result[0].address_name;
                if (result[0].road_address && result[0].road_address.address_name) {
                    fullAddress = result[0].road_address.address_name;
                }
                const resData = { 
                    lat: parseFloat(result[0].y), 
                    lng: parseFloat(result[0].x), 
                    fullAddress: fullAddress 
                };

                cache[cleanKey] = resData;
                saveGeoCache(cache);

                resolve(resData);
            } else { 
                resolve(null); 
            }
        });
    });
}

export async function batchGeocodePdfList(items) {
    const dropZone = document.getElementById('excel-drop-zone');
    const originalDropHtml = dropZone ? dropZone.innerHTML : '';
    const cache = getGeoCache();

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (dropZone) {
            dropZone.innerHTML = `
                <div class="flex items-center gap-3 text-indigo-600 font-black text-sm">
                    <i class="fa-solid fa-circle-notch fa-spin text-xl"></i>
                    <span>배송지 정밀 좌표 분석 중... (${i + 1} / ${items.length})</span>
                </div>`;
        }

        if (item.address) {
            if (!item.fullAddress) item.fullAddress = item.address;

            const isCached = !!cache[item.address.trim()];
            const coords = await getCoordsFromAddress(item.address);
            if (coords) {
                item.lat = coords.lat;
                item.lng = coords.lng;
                if (coords.fullAddress) {
                    item.address = coords.fullAddress;
                }
            }
            if (!isCached) {
                await new Promise(r => setTimeout(r, 40));
            }
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