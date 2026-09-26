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
                        <span>대용량 PDF 정밀 분석 중... (${pageNum} / ${totalPages} 페이지)</span>
                    </div>`;
            }

            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent({ normalizeWhitespace: true });
            const viewport = page.getViewport({ scale: 1.0 });

            // 범용 스마트 텍스트 블록 파싱 실행
            const pageOrders = parseOrdersFromPage(textContent.items, pageNum, viewport.width, viewport.height, file.name);

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
// 3. 다중 양식 대응 인공지능형 PDF 데이터 추출 알고리즘
// ==========================================
function parseOrdersFromPage(rawPdfItems, pageNum, pageWidth, pageHeight, fileName) {
    if (!rawPdfItems || rawPdfItems.length === 0) return [];

    // 1단계: 유효한 텍스트 토큰 추출 및 좌표 정규화
    const validTokens = rawPdfItems.filter(it => it.str && it.str.trim() !== '').map(it => ({
        text: it.str.trim(),
        x: Math.round(it.transform[4]),
        y: Math.round(it.transform[5])
    }));

    if (validTokens.length === 0) return [];

    // 페이지 전체 텍스트 (순차적 렌더링 순서)
    const allTextJoined = validTokens.map(it => it.text).join(' ');

    // 2단계: 양식 내 메타데이터 추출 (주문번호, 담당기사, 공급자 상호)
    let orderNo = `PDF-${pageNum}-${Date.now().toString().slice(-4)}`;
    const orderNoMatch = allTextJoined.match(/(?:주문번호|오더번호|발주번호)[\s:|]*([A-Z0-9_\-]+)/i);
    if (orderNoMatch) {
        orderNo = orderNoMatch[1].trim();
    }

    let assignedDriver = null;
    const driverMatch = allTextJoined.match(/(?:담당기사|배송기사|기사명)[\s:|]*([가-힣A-Za-z0-9_\-]+)/);
    if (driverMatch) {
        const dVal = driverMatch[1].trim();
        if (!/^(주문|발주|배송|No|공급|거래)/.test(dVal)) assignedDriver = dVal;
    }

    // 공급자(화주사)명 감지
    let senderName = '';
    const senderMatch = allTextJoined.match(/(?:공급자|출고처|발송처|화주)[\s\S]*?(?:상호\(법인명\)|상호명|상호)[\s:|]*([가-힣A-Za-z0-9\(\)\s]{2,20})/);
    if (senderMatch) {
        senderName = senderMatch[1].split(/[\n\r|]/)[0].trim();
    }
    if (!senderName) {
        const generalStore = allTextJoined.match(/상호\(법인명\)[\s:|]*([가-힣A-Za-z0-9\(\)\s]{2,20})/);
        if (generalStore) senderName = generalStore[1].split(/[\n\r|]/)[0].trim();
    }
    if (!senderName && fileName) {
        senderName = fileName.replace(/\.[^/.]+$/, '').split(/[_\-\s]+/)[0].trim();
    }
    if (!senderName) senderName = '정보 없음';

    // 3단계: [공급받는 자 / 수취처] 배송지 정보 정밀 추출
    // 🌟 렉 방지 및 브라우저 프린터 PDF Y좌표 역전 대응을 위해 Y좌표 검사 삭제, X좌표(절반 우측)만으로 안전하게 수취자 필터링
    const splitX = pageWidth ? pageWidth * 0.42 : 250;
    const buyerTokens = validTokens.filter(t => t.x >= splitX);
    const buyerTextCombined = buyerTokens.map(t => t.text).join(' ');

    // 1) 수령처 상호(간판명)
    let storeName = '';
    const storeRegexList = [
        /(?:배송지명\(간판명\)|배송지명|간판명|매장명|가게명|수령처)[\s:|]*([^\n\r|]+)/i,
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

    // 2) 구매자명 / 주문자명
    let buyerName = '';
    const buyerMatch = buyerTextCombined.match(/(?:구매자명|주문자명|수령인|수취인|받는분)[\s:|]*([가-힣A-Za-z0-9]{2,10})/);
    if (buyerMatch) {
        buyerName = buyerMatch[1].trim();
    }

    if (!storeName) storeName = buyerName || '배송처';
    storeName = storeName.replace(/^[)|\]}>\s]+/, '').trim();

    // 3) 수취인 연락처 (공급자 연락처와 혼선 방지를 위해 buyerTextCombined 최우선 검색)
    let phone = '';
    const buyerPhones = buyerTextCombined.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g) || [];
    if (buyerPhones.length > 0) {
        phone = formatPhoneNumber(buyerPhones[0]);
    } else {
        const noHyphenMatches = buyerTextCombined.match(/01[016789]\d{7,8}/g) || [];
        if (noHyphenMatches.length > 0) phone = formatPhoneNumber(noHyphenMatches[0]);
    }

    // 4) 배송지 주소 정밀 추출
    let rawAddress = '';
    const regionRegex = /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[가-힣A-Za-z0-9\s\(\)\-\,\.]{5,80}?(?:로|길|대로|동|읍|면|리|가)\s*[\d\-]+(?:\s*[가-힣A-Za-z0-9\(\)\,\-\.\s]*)/g;
    
    const buyerAddrMatches = buyerTextCombined.match(regionRegex) || [];
    if (buyerAddrMatches.length > 0) {
        rawAddress = buyerAddrMatches[0];
    } else {
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

    // 🌟 라벨 텍스트 잘라내기
    rawAddress = rawAddress.split(/(?:연락처|전화|배송지명|간판명|매장명|상호|구매자|No\.|결제|인수자)/)[0];
    rawAddress = rawAddress.replace(/\[\d+\]/g, ' ')
                           .replace(/받\s*주소/g, ' ')
                           .replace(/\b받\b/g, ' ')
                           .replace(/\b주소\b/g, ' ')
                           .replace(/\|/g, ' ')
                           .replace(/[:]/g, ' ')
                           .trim();

    const fullAddress = rawAddress.replace(/\s{2,}/g, ' ').trim();

    // 🌟 내비/관제용 정제 주소: 도로명숫자+길 (예: 공원로6나길) 보호를 위해 괄호'(' 이전까지만 절삭
    let cleanAddr = fullAddress;
    const parenIdx = cleanAddr.indexOf('(');
    if (parenIdx !== -1) {
        cleanAddr = cleanAddr.slice(0, parenIdx);
    }
    const address = cleanAddr.replace(/\s{2,}/g, ' ').trim();

    // 5) 사업자번호
    let bizNo = '';
    const bizMatches = buyerTextCombined.match(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/g) || [];
    if (bizMatches.length > 0) bizNo = bizMatches[0].replace(/\s+/g, '-');

    // 6) 배송 요청사항
    let memo = '';
    const memoMatch = allTextJoined.match(/(?:배송\s*요청사항|배송메모|요청사항|비고)[\s:|]*([^\n\r|]+)/);
    if (memoMatch) {
        memo = memoMatch[1].split(/(?:총\s*상품수량|총주문금액|인수자|배송비|총\s*상품금액)/)[0].trim();
    }

    // 4단계: 상품 품목 테이블 정밀 파싱 (스마트 라인 그룹핑 + 후위 숫자 인식)
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

    const sortedYKeys = Array.from(lineMap.keys()).sort((a, b) => b - a); // Y좌표 내림차순 (보통 위에서 아래)
    const orderItems = [];

    sortedYKeys.forEach(yKey => {
        const lineTokens = lineMap.get(yKey).sort((a, b) => a.x - b.x);
        const lineStr = lineTokens.map(t => t.text).join(' ').trim();

        // 🌟 정규식: "순번(1~99) + 상품명 및 텍스트 + 끝부분 숫자 그룹(수량, 단가, 총액 등 3~5개)" 매칭
        const rowMatch = lineStr.match(/^(\d{1,2})\s+(.+?)\s+([\d,\s]+)$/);
        if (rowMatch) {
            const namePart = rowMatch[2];
            const numTokens = rowMatch[3].trim().split(/\s+/);
            
            // 숫자가 최소 3개 (수량, 단가, 총액) 이상 잡혔을 때만 유효 품목으로 인정
            if (numTokens.length >= 3) {
                const pQty = parseInt(numTokens[0].replace(/,/g, ''), 10) || 1;
                const pPrice = parseInt(numTokens[1].replace(/,/g, ''), 10) || 0;
                const pTotal = parseInt(numTokens[numTokens.length - 1].replace(/,/g, ''), 10) || 0;
                
                orderItems.push({
                    name: namePart.trim().replace(/^[|>\s]+/, ''),
                    qty: pQty,
                    unit: '개',
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