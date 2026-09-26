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

            // 좌표 기반 분리 및 추출 실행
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
// 🌟 3. 고도화된 정보 분류 엔진 (공급자명 클린 파싱 적용)
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
    const allTextJoined = validTokens.map(it => it.text).join(' ');

    // 1. 주문번호 감지
    let orderNo = `PDF-${pageNum}-${Date.now().toString().slice(-4)}`;
    const orderNoMatch = allTextJoined.match(/(?:주문번호|오더번호|발주번호)[\s:|]*([A-Z0-9_\-]+)/i);
    if (orderNoMatch) orderNo = orderNoMatch[1].trim();

    // 2. 담당 기사 감지
    let assignedDriver = null;
    const driverMatch = allTextJoined.match(/담당기사[\s:|]*([0-9\-\.]+)/);
    if (driverMatch) {
        assignedDriver = formatPhoneNumber(driverMatch[1]);
    } else {
        const driverMatch2 = allTextJoined.match(/(?:담당기사|배송기사|기사명)[\s:|]*([가-힣A-Za-z0-9_\-]+)/);
        if (driverMatch2) {
            const dVal = driverMatch2[1].trim();
            if (!/^(주문|발주|배송|No|공급|거래)/.test(dVal)) assignedDriver = dVal;
        }
    }

    // 🌟 3. 발송사(공급자) 정밀 감지 (구매자명/주소/사업자 등 다음 항목 침범 차단)
    let senderName = '';
    const provStoreMatch = allTextJoined.match(/공급자[\s\S]*?(?:상호\(법인명\)|상호명|상호)[\s:|]*([가-힣A-Za-z0-9\(\)\s]{2,30})/);
    if (provStoreMatch) {
        senderName = provStoreMatch[1].split(/(?:구매자|주문자|공급받는|주소|사업자|연락처|전화|No\.|결제|배송)/)[0].trim();
    } else {
        const generalStoreMatch = allTextJoined.match(/상호\(법인명\)[\s:|]*([가-힣A-Za-z0-9\(\)\s]{2,30})/);
        if (generalStoreMatch) {
            senderName = generalStoreMatch[1].split(/(?:구매자|주문자|공급받는|주소|사업자|연락처|전화|No\.|결제|배송)/)[0].trim();
        }
    }

    // 불필요한 특수문자나 괄호 잔여물 제거
    if (senderName) {
        senderName = senderName.replace(/^[|:>\s]+/, '').replace(/[|:>\s]+$/, '').trim();
    }

    if (!senderName && fileName) senderName = fileName.replace(/\.[^/.]+$/, '').split(/[_\-\s]+/)[0].trim();
    if (!senderName) senderName = '정보 없음';

    // 화면 우측 절반(배송받는곳) 텍스트를 집중 분석하기 위한 필터링
    const splitX = pageWidth * 0.42;
    const buyerTokens = validTokens.filter(t => t.x >= splitX && t.y >= pageHeight * 0.35);
    const buyerTextCombined = buyerTokens.map(t => t.text).join(' ');

    // 4. 배송지명(간판명) 추출
    let storeName = '';
    const storeRegexList = [
        /(?:배송지명\(간판명\)|배송지명|간판명|매장명|가게명)[\s:|]*(.+?)(?:\s+(?:연락처|전화|주소|사업자|No\.|구매자|결제|배송비|총|배송요청사항|$))/i,
        /공급받는\s*자[\s\S]*?(?:상호\(법인명\)|상호명|상호)[\s:|]*(.+?)(?:\s+(?:연락처|전화|주소|사업자|No\.|구매자|결제|배송비|총|배송지명|간판명|$))/i
    ];
    for (const reg of storeRegexList) {
        const m = buyerTextCombined.match(reg) || allTextJoined.match(reg);
        if (m) {
            let val = m[1].replace(/^[|:>\s]+/, '').trim();
            if (val && val !== '|' && val.length > 1) { storeName = val; break; }
        }
    }

    // 5. 구매자명 추출
    let buyerName = '';
    const buyerMatch = buyerTextCombined.match(/(?:구매자명|주문자명|수령인|수취인|받는분)[\s:|]*([가-힣A-Za-z0-9]{2,10})/);
    if (buyerMatch) buyerName = buyerMatch[1].trim();

    if (!storeName) storeName = buyerName || '배송처';
    storeName = storeName.replace(/^[)|\]}>\s]+/, '').trim();

    // 6. 고객 연락처 추출
    let phone = '';
    const buyerPhones = buyerTextCombined.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g) || [];
    if (buyerPhones.length > 0) {
        phone = formatPhoneNumber(buyerPhones[0]);
    } else {
        const noHyphenMatches = buyerTextCombined.match(/01[016789]\d{7,8}/g) || [];
        if (noHyphenMatches.length > 0) phone = formatPhoneNumber(noHyphenMatches[0]);
    }
    if (!phone) {
        const allPhones = allTextJoined.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g) || [];
        if (allPhones.length > 1) phone = formatPhoneNumber(allPhones[allPhones.length - 1]);
        else if (allPhones.length === 1) phone = formatPhoneNumber(allPhones[0]);
    }

    // 7. 배송지 주소 추출
    let rawAddress = '';
    const regionRegex = /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[가-힣A-Za-z0-9\s\(\)\-\,\.]{5,80}?(?:로|길|대로|동|읍|면|리|가)\s*[\d\-]+(?:\s*[가-힣A-Za-z0-9\(\)\,\-\.\s]*)/g;
    
    const buyerAddrMatches = buyerTextCombined.match(regionRegex) || [];
    if (buyerAddrMatches.length > 0) {
        rawAddress = buyerAddrMatches[0];
    } else {
        const allAddrMatches = allTextJoined.match(regionRegex) || [];
        if (allAddrMatches.length > 0) rawAddress = allAddrMatches[allAddrMatches.length - 1];
    }

    rawAddress = rawAddress.split(/(?:연락처|전화|배송지명|간판명|매장명|상호|구매자|No\.|결제|인수자)/)[0];
    rawAddress = rawAddress.replace(/\[\d+\]/g, ' ').replace(/받\s*주소/g, ' ').replace(/\b받\b/g, ' ').replace(/\b주소\b/g, ' ').replace(/\|/g, ' ').replace(/[:]/g, ' ').trim();

    const fullAddress = rawAddress.replace(/\s{2,}/g, ' ').trim();
    let cleanAddr = fullAddress;
    const parenIdx = cleanAddr.indexOf('(');
    if (parenIdx !== -1) cleanAddr = cleanAddr.slice(0, parenIdx);
    const address = cleanAddr.replace(/\s{2,}/g, ' ').trim();

    // 8. 구매자 사업자번호 추출
    let bizNo = '';
    const bizMatches = buyerTextCombined.match(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/g) || [];
    if (bizMatches.length > 0) {
        bizNo = bizMatches[0].replace(/\s+/g, '-');
    } else {
        const allBiz = allTextJoined.match(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/g) || [];
        if (allBiz.length >= 2) bizNo = allBiz[allBiz.length - 1].replace(/\s+/g, '-');
    }

    // 9. 결제 수단 및 배송 요청사항 (메모) 추출
    let memo = '';
    let payMethod = '';
    const payMatch = allTextJoined.match(/결제\s*수단[\s:|]*([가-힣a-zA-Z\s]+)/);
    if (payMatch) payMethod = payMatch[1].split(/(?:총|배송|No|인수)/)[0].trim();

    const memoMatch = allTextJoined.match(/(?:배송\s*요청사항|배송메모|요청사항|비고)[\s:|]*(.+?)(?:총\s*상품수량|총주문금액|인수자|배송비|총\s*상품금액|거래명세표|$)/);
    if (memoMatch) memo = memoMatch[1].trim();

    if (payMethod && !memo.includes(payMethod)) {
        memo = `[결제: ${payMethod}] ` + memo;
    }

    // 10. 품목(Table) 정밀 추출 및 중복 제거
    const lineMap = new Map();
    validTokens.forEach(t => {
        let matchedY = null;
        for (const ey of lineMap.keys()) {
            if (Math.abs(ey - t.y) <= 6) { matchedY = ey; break; }
        }
        const targetY = matchedY !== null ? matchedY : t.y;
        if (!lineMap.has(targetY)) lineMap.set(targetY, []);
        lineMap.get(targetY).push(t);
    });

    const sortedYKeys = Array.from(lineMap.keys()).sort((a, b) => b - a);
    const rawOrderItems = [];

    sortedYKeys.forEach(yKey => {
        const lineTokens = lineMap.get(yKey).sort((a, b) => a.x - b.x);
        const lineStr = lineTokens.map(t => t.text).join(' ').trim();

        if (/^\d{1,3}\s+/.test(lineStr)) {
            const tokens = lineStr.split(/\s+/);
            if (tokens.length >= 3 && /^\d+$/.test(tokens[0])) {
                let numCount = 0;
                for (let i = tokens.length - 1; i >= 1; i--) {
                    if (/^[\d,]+$/.test(tokens[i])) numCount++;
                    else break;
                }
                
                if (numCount > 5) numCount = 5;
                
                if (numCount >= 2) {
                    const total = parseInt(tokens[tokens.length - 1].replace(/,/g, ''), 10);
                    let qty = 1, price = 0;
                    
                    if (numCount === 2) {
                        qty = parseInt(tokens[tokens.length - 2].replace(/,/g, ''), 10);
                        price = total;
                    } else {
                        qty = parseInt(tokens[tokens.length - numCount].replace(/,/g, ''), 10);
                        price = parseInt(tokens[tokens.length - numCount + 1].replace(/,/g, ''), 10);
                    }
                    
                    const nameTokens = tokens.slice(1, tokens.length - numCount);
                    let pName = nameTokens.join(' ').replace(/^\s+|\s+$/g, '');
                    
                    rawOrderItems.push({ name: pName, qty: qty, unit: '개', price: price, total: total });
                }
            }
        }
    });

    const orderItems = [];
    const seenItems = new Set();
    rawOrderItems.forEach(it => {
        const key = `${it.name}_${it.qty}_${it.total}`;
        if (!seenItems.has(key)) {
            seenItems.add(key);
            orderItems.push(it);
        }
    });

    let qtySum = orderItems.length > 0 ? orderItems.reduce((sum, it) => sum + it.qty, 0) : 1;
    let totalAmt = orderItems.length > 0 ? orderItems.reduce((sum, it) => sum + it.total, 0) : 0;
    
    let itemName = '';
    if (orderItems.length > 1) {
        itemName = `${orderItems[0].name} 외 ${orderItems.length - 1}건`;
    } else if (orderItems.length === 1) {
        itemName = `${orderItems[0].name}`;
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
        qty: qtySum,
        price: orderItems.length === 1 ? orderItems[0].price : '',
        total: totalAmt || '',
        memo: memo,
        lat: null,
        lng: null,
        items: orderItems
    }];
}

// ==========================================
// 4. 주소 좌표(위/경도) 지오코딩 엔진 (캐시 우선 확인 & 429 지수 백오프 방어)
// ==========================================
async function getCoordsFromAddress(address) {
    if (!address) return null;
    const cleanKey = address.trim();
    if (!cleanKey) return null;

    const cache = getGeoCache();
    if (cache[cleanKey]) {
        return cache[cleanKey];
    }

    if (!window.kakao || !window.kakao.maps || !window.kakao.maps.services) { 
        return null; 
    }
    const geocoder = new window.kakao.maps.services.Geocoder();

    const queryKakaoWithRetry = async (queryStr) => {
        const maxRetries = 3;
        const delays = [200, 500, 1000];

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const result = await new Promise((resolve) => {
                try {
                    geocoder.addressSearch(queryStr, (res, status) => {
                        if (status === window.kakao.maps.services.Status.OK && res && res[0]) {
                            const fullAddr = (res[0].road_address && res[0].road_address.address_name) 
                                ? res[0].road_address.address_name 
                                : res[0].address_name;
                            resolve({ success: true, data: { lat: parseFloat(res[0].y), lng: parseFloat(res[0].x), fullAddress: fullAddr } });
                        } else if (status === window.kakao.maps.services.Status.ZERO_RESULT) {
                            resolve({ success: false, retryable: false });
                        } else {
                            resolve({ success: false, retryable: true });
                        }
                    });
                } catch (err) {
                    resolve({ success: false, retryable: true });
                }
            });

            if (result.success) return result.data;
            if (!result.retryable || attempt === maxRetries) break;

            const jitter = Math.floor(Math.random() * 50);
            const delay = (delays[attempt] || 1000) + jitter;
            await new Promise(r => setTimeout(r, delay));
        }
        return null;
    };

    let coords = await queryKakaoWithRetry(cleanKey);

    if (!coords) {
        const basicMatch = cleanKey.match(/^(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[\s\S]*?(?:로|길|동|읍|면|리)\s*[\d\-]+/);
        if (basicMatch && basicMatch[0] !== cleanKey) {
            coords = await queryKakaoWithRetry(basicMatch[0]);
        }
    }

    if (coords) {
        cache[cleanKey] = coords;
        saveGeoCache(cache);
        return coords;
    }

    return null;
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