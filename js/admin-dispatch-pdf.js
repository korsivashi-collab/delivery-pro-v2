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
// 2. 단일 PDF 파일 로드 및 페이지별 범용 파싱 엔진
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
        const seenOrderKeys = new Set();

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            if (dropZone) {
                dropZone.innerHTML = `
                    <div class="flex items-center gap-3 text-indigo-600 font-black text-sm">
                        <i class="fa-solid fa-circle-notch fa-spin text-xl"></i>
                        <span>재가공 PDF 지능형 분석 중... (${pageNum} / ${totalPages} 페이지)</span>
                    </div>`;
            }

            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent({ normalizeWhitespace: true });
            
            // 🌟 새롭게 적용된 1D 플랫 텍스트 기반 지능형 파싱 실행
            const pageOrders = parseOrdersFromPage(textContent.items, pageNum, file.name);

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
// 3. 인공지능형 1D 플랫 텍스트 추출 알고리즘 (좌표계 붕괴 완벽 대응)
// ==========================================
function parseOrdersFromPage(rawPdfItems, pageNum, fileName) {
    if (!rawPdfItems || rawPdfItems.length === 0) return [];

    // 1단계: 글자 파편화 및 좌표계 붕괴 방지를 위해 모든 텍스트를 파이프(|) 기호 없이 하나의 긴 문자열로 병합
    const validTokens = rawPdfItems.filter(it => it.str && it.str.trim() !== '');
    if (validTokens.length === 0) return [];

    // 🌟 이 한 줄이 핵심입니다! 내부 좌표계를 무시하고 순수 텍스트 스트림으로 변환
    const flatText = validTokens.map(t => t.str.trim()).join(' ').replace(/\|/g, ' ').replace(/\s+/g, ' ');

    // 2단계: 양식 내 메타데이터 추출 (주문번호, 담당기사, 공급자 상호)
    let orderNo = `PDF-${pageNum}-${Date.now().toString().slice(-4)}`;
    const orderNoMatch = flatText.match(/(?:주문번호|오더번호|발주번호)\s*[:]?\s*([A-Z0-9_\-]+)/i);
    if (orderNoMatch) orderNo = orderNoMatch[1].trim();

    let assignedDriver = null;
    const driverMatch = flatText.match(/(?:담당기사|배송기사|기사명)\s*[:]?\s*([가-힣A-Za-z0-9_\-]+)/);
    if (driverMatch) {
        const dVal = driverMatch[1].trim();
        if (!/^(주문|발주|배송|No|공급|거래)/.test(dVal)) assignedDriver = dVal;
    }

    let senderName = '';
    const senderMatch = flatText.match(/(?:공급자|출고처|발송처|화주)\s*[^]*?(?:상호\(법인명\)|상호명|상호)\s*([가-힣A-Za-z0-9\(\)\s]{2,20})/);
    if (senderMatch) senderName = senderMatch[1].trim();
    if (!senderName && fileName) senderName = fileName.replace(/\.[^/.]+$/, '').split(/[_\-\s]+/)[0].trim();
    if (!senderName) senderName = '정보 없음';

    // 3단계: [공급받는 자 / 수취처] 배송지 정보 정밀 추출 (키워드 스캔 방식)
    
    // 1) 수령처 상호(간판명)
    let storeName = '';
    const storeMatch = flatText.match(/(?:배송지명\(간판명\)|배송지명|간판명|매장명|가게명|수령처)\s+([^]+?)(?=\s*(?:연락처|전화|주문번호|담당기사|No\.|결제수단|$))/);
    if (storeMatch) storeName = storeMatch[1].trim();
    
    if (!storeName) {
        const altMatch = flatText.match(/(?:구매자명|주문자명|수령인|수취인|받는분)\s+([^]+?)(?=\s*(?:주소|배송지명|연락처|전화|주문번호|No\.|결제|$))/);
        if (altMatch) storeName = altMatch[1].trim();
    }
    if (!storeName) storeName = '배송처';
    storeName = storeName.replace(/^[)|\]}>\s]+/, '').trim();

    // 2) 연락처 추출 (모든 번호를 수집한 뒤 공급자 번호 필터링, 그리고 가장 마지막 번호를 고객 번호로 확정)
    const allPhones = flatText.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g) || [];
    // 🌟 화주 번호(4742, 8776 등)가 아니면 고객 번호로 인식!
    const buyerPhones = allPhones.filter(p => !p.replace(/[^0-9]/g, '').includes('47423376') && !p.replace(/[^0-9]/g, '').includes('87765400'));
    let phone = '';
    if (buyerPhones.length > 0) {
        phone = formatPhoneNumber(buyerPhones[buyerPhones.length - 1]);
    }

    // 3) 배송지 주소 정밀 추출
    let rawAddress = '';
    const regionRegex = /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[가-힣A-Za-z0-9\s\(\)\-\,\.]{5,80}?(?:로|길|대로|동|읍|면|리|가)\s*[\d\-]+(?:\s*[가-힣A-Za-z0-9\(\)\,\-\.\s]*)/g;
    const allAddrs = flatText.match(regionRegex) || [];
    
    // 공급자 주소 배제하고 남은 것 중 가장 마지막 주소를 고객 주소로 사용
    const buyerAddrs = allAddrs.filter(a => !a.includes('건원대로') && !a.includes('구리시 건원대로'));
    if (buyerAddrs.length > 0) {
        rawAddress = buyerAddrs[buyerAddrs.length - 1];
    } else if (allAddrs.length > 0) {
        rawAddress = allAddrs[allAddrs.length - 1];
    }

    // 쓰레기 라벨 텍스트 잘라내기
    rawAddress = rawAddress.split(/(?:연락처|전화|배송지명|간판명|매장명|상호|구매자|No\.|결제|인수자|담당기사)/)[0];
    rawAddress = rawAddress.replace(/\[\d+\]/g, ' ').replace(/\b받\b/g, ' ').replace(/\b주소\b/g, ' ').trim();

    const fullAddress = rawAddress.replace(/\s{2,}/g, ' ').trim();

    // 내비/관제용 정제 주소: 도로명숫자+길 (예: 공원로6나길) 보호를 위해 괄호'(' 이전까지만 안전하게 절삭
    let cleanAddr = fullAddress;
    const parenIdx = cleanAddr.indexOf('(');
    if (parenIdx !== -1) {
        cleanAddr = cleanAddr.slice(0, parenIdx);
    }
    const address = cleanAddr.replace(/\s{2,}/g, ' ').trim();

    // 4) 배송 요청사항
    let memo = '';
    const memoMatch = flatText.match(/(?:배송\s*요청사항|배송메모|요청사항|비고)\s+([^]+?)(?=\s*(?:총\s*상품수량|총주문금액|인수자|배송비|총\s*상품금액|$))/);
    if (memoMatch) {
        memo = memoMatch[1].trim();
    }

    // 4단계: 🌟 상품 품목 라인 테이블 파싱 (Y좌표 허용 오차를 늘려 찌그러진 표 완벽 복원)
    const lineMap = new Map();
    validTokens.forEach(t => {
        let matchedY = null;
        for (const ey of lineMap.keys()) {
            if (Math.abs(ey - t.y) <= 8) { matchedY = ey; break; } // 오차 허용 범위를 8로 확대
        }
        const targetY = matchedY !== null ? matchedY : t.y;
        if (!lineMap.has(targetY)) lineMap.set(targetY, []);
        lineMap.get(targetY).push({ text: t.text, x: t.x });
    });

    const sortedYKeys = Array.from(lineMap.keys()).sort((a, b) => b - a);
    const orderItems = [];

    sortedYKeys.forEach(yKey => {
        const lineTokens = lineMap.get(yKey).sort((a, b) => a.x - b.x);
        const lineStr = lineTokens.map(t => t.text).join(' ').replace(/\|/g, ' ').trim();

        // 정규식: 순번(1~99)으로 시작 + 텍스트 + 제일 뒤에 3개 이상의 숫자 그룹(수량, 단가, 총액)
        const rowMatch = lineStr.match(/^(\d{1,2})\s+(.+?)\s+([\d,\s]+)$/);
        
        if (rowMatch) {
            const namePart = rowMatch[2];
            const numTokens = rowMatch[3].replace(/[^\d,\s]/g, ' ').trim().split(/\s+/);
            
            if (numTokens.length >= 3) {
                const pQty = parseInt(numTokens[0].replace(/,/g, ''), 10) || 1;
                const pPrice = parseInt(numTokens[1].replace(/,/g, ''), 10) || 0;
                const pTotal = parseInt(numTokens[numTokens.length - 1].replace(/,/g, ''), 10) || 0;
                
                let pName = namePart.trim();
                let pUnit = '개';
                const unitMatch = pName.match(/(\d+(?:\.\d+)?)\s*(kg|g|L|ml|ea|판|봉|박스|box|팩)/i);
                if (unitMatch) pUnit = unitMatch[0].trim();

                orderItems.push({
                    name: pName,
                    qty: pQty,
                    unit: pUnit,
                    price: pPrice,
                    total: pTotal
                });
            }
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
        bizNo: '',
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