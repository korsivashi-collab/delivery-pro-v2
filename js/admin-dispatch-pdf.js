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
            const pageOrders = parseOrdersFromPage(textContent.items, pageNum, viewport.width, file.name);

            pageOrders.forEach(ord => {
                // 고유 식별 키 생성 (주문번호 또는 배송지주소+상호명)
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
function parseOrdersFromPage(items, pageNum, pageWidth, fileName) {
    if (!items || items.length === 0) return [];

    // 1단계: 텍스트 아이템들을 좌표 기반으로 정렬 (위 -> 아래, 좌 -> 우)
    const sortedItems = [...items].filter(it => it.str && it.str.trim() !== '').map(it => ({
        text: it.str.trim(),
        x: Math.round(it.transform[4]),
        y: Math.round(it.transform[5])
    }));

    sortedItems.sort((a, b) => {
        if (Math.abs(b.y - a.y) > 4) return b.y - a.y; // 상단 행 우선
        return a.x - b.x; // 좌측 우선
    });

    const fullTextLines = [];
    let currentY = null;
    let currentLineTokens = [];

    sortedItems.forEach(item => {
        if (currentY === null || Math.abs(item.y - currentY) > 4) {
            if (currentLineTokens.length > 0) {
                fullTextLines.push(currentLineTokens);
            }
            currentY = item.y;
            currentLineTokens = [item];
        } else {
            currentLineTokens.push(item);
        }
    });
    if (currentLineTokens.length > 0) fullTextLines.push(currentLineTokens);

    // 플랫 텍스트 리스트
    const flatTokens = sortedItems.map(it => it.text);
    const combinedFullText = flatTokens.join(' ');

    // 2단계: 양식 내 주요 메타데이터 추출 (주문번호, 담당기사, 공급자 상호)
    let orderNo = '';
    const orderNoMatch = combinedFullText.match(/(?:주문번호|오더번호|발주번호)[\s:|]*([A-Z0-9_\-]+)/i);
    if (orderNoMatch) {
        orderNo = orderNoMatch[1].trim();
    } else {
        orderNo = `PDF-${pageNum}-${Date.now().toString().slice(-4)}`;
    }

    let assignedDriver = null;
    const driverMatch = combinedFullText.match(/(?:담당기사|배송기사|기사명)[\s:|]*([가-힣A-Za-z0-9_\-]+)/);
    if (driverMatch) {
        const dVal = driverMatch[1].trim();
        if (!/^(주문|발주|배송|No|공급)/.test(dVal)) assignedDriver = dVal;
    }

    // 공급자(화주사)명 감지
    let senderName = '';
    const senderMatch = combinedFullText.match(/(?:공급자|출고처|발송처|화주)[\s\S]*?(?:상호\(법인명\)|상호명|상호)[\s:|]*([가-힣A-Za-z0-9\(\)\s]{2,20})/);
    if (senderMatch) {
        senderName = senderMatch[1].split(/[\n\r|]/)[0].trim();
    }
    if (!senderName) {
        const generalStore = combinedFullText.match(/상호\(법인명\)[\s:|]*([가-힣A-Za-z0-9\(\)\s]{2,20})/);
        if (generalStore) senderName = generalStore[1].split(/[\n\r|]/)[0].trim();
    }
    if (!senderName && fileName) {
        senderName = fileName.replace(/\.[^/.]+$/, '').split(/[_\-\s]+/)[0].trim();
    }
    if (!senderName) senderName = '정보 없음';

    // 3단계: [공급받는 자 / 수취처] 배송지 정보 정밀 추출
    // 표에서 라벨과 값이 셀로 분리되어 있는 경우를 완벽 해결하기 위해 인접 토큰 검색기 활용
    function findValueAfterLabel(labelKeywords) {
        for (let i = 0; i < flatTokens.length; i++) {
            const tok = flatTokens[i];
            for (const kw of labelKeywords) {
                if (tok.includes(kw)) {
                    // 같은 토큰 안에 콜론이나 값으로 들어있는 경우
                    let directVal = tok.replace(new RegExp(`.*${kw}\\s*[:|]?\\s*`, 'i'), '').trim();
                    directVal = directVal.replace(/^[|:>\s]+/, '').trim();
                    if (directVal && directVal !== '|' && directVal.length > 1) {
                        return directVal;
                    }
                    // 다음 토큰 1~3개 뒤 탐색 (중간의 '|' 기호 건너뜀)
                    for (let step = 1; step <= 3; step++) {
                        if (i + step < flatTokens.length) {
                            let nextTok = flatTokens[i + step].trim();
                            nextTok = nextTok.replace(/^[|:>\s]+/, '').trim();
                            if (nextTok && nextTok !== '|' && nextTok.length > 0 && !labelKeywords.some(k => nextTok.includes(k))) {
                                return nextTok;
                            }
                        }
                    }
                }
            }
        }
        return '';
    }

    // 1) 수령처 상호(간판명)
    let storeName = findValueAfterLabel(['배송지명(간판명)', '배송지명', '간판명', '매장명', '가게명', '수령처']);
    if (!storeName) {
        storeName = findValueAfterLabel(['상호명', '상호', '수령인', '수취인', '받는분']);
    }

    // 2) 구매자명 / 주문자명
    let buyerName = findValueAfterLabel(['구매자명', '주문자명', '발주자', '구매자', '고객명']);
    if (!buyerName) buyerName = storeName || '고객';

    // 3) 수취인 연락처
    let phone = '';
    const phoneCandidates = combinedFullText.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g) || [];
    if (phoneCandidates.length > 0) {
        // 공급자 연락처(보통 상단 첫 번째)를 제외하고 배송지 연락처를 우선 매칭
        phone = formatPhoneNumber(phoneCandidates[phoneCandidates.length - 1]);
        if (phoneCandidates.length >= 2) {
            phone = formatPhoneNumber(phoneCandidates[1]);
        }
    }

    // 4) 배송지 주소 (가장 핵심: 한국 주소 패턴 기반 자동 탐지)
    let rawAddress = '';

    // A. 라벨 뒤의 주소 우선 탐색
    for (let i = 0; i < flatTokens.length; i++) {
        if (flatTokens[i] === '주소' || flatTokens[i].endsWith('주소')) {
            for (let step = 1; step <= 4; step++) {
                if (i + step < flatTokens.length) {
                    const candidate = flatTokens[i + step].replace(/^[|:>\s]+/, '').trim();
                    if (/(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/.test(candidate)) {
                        // 공급자 주소(보통 구리시 본사 등 첫 번째 주소)와 공급받는 자 주소가 있을 때 두 번째 주소를 우선 채택
                        rawAddress = candidate;
                    }
                }
            }
        }
    }

    // B. 주소 라벨이 없거나 토큰이 분리된 경우, 전체 텍스트에서 배송 주소 패턴 다중 검출
    if (!rawAddress || rawAddress.includes('건원대로')) {
        const regionRegex = /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[가-힣A-Za-z0-9\s\(\)\-\,\.]{6,60}?(?:로|길|동|읍|면|가)\s*[\d\-]+(?:\s*[가-힣A-Za-z0-9\(\)\,\-\.\s]*)/g;
        const allAddrMatches = combinedFullText.match(regionRegex) || [];
        
        if (allAddrMatches.length > 0) {
            // 본사 공급자 주소(예: 건원대로 등)를 거르고 실제 배송 수취 주소 선택
            const buyerAddrs = allAddrMatches.filter(a => !a.includes('건원대로') && !a.includes('공급자'));
            if (buyerAddrs.length > 0) {
                rawAddress = buyerAddrs[0];
            } else {
                rawAddress = allAddrMatches[allAddrMatches.length - 1];
            }
        }
    }

    // C. 주소 뒤쪽에 붙은 라벨 및 잡음 텍스트 정밀 제거
    rawAddress = rawAddress.split(/(?:연락처|전화|배송지명|간판명|매장명|상호|구매자|No\.|결제|인수자)/)[0];
    rawAddress = rawAddress.replace(/\[\d+\]/g, ' ')
                           .replace(/받\s*주소/g, ' ')
                           .replace(/\b받\b/g, ' ')
                           .replace(/\b주소\b/g, ' ')
                           .replace(/\|/g, ' ')
                           .replace(/[:]/g, ' ')
                           .trim();

    const fullAddress = rawAddress.replace(/\s{2,}/g, ' ').trim();

    // 내비/관제용 정제 주소: 괄호'(' 이전 주소 추출
    let cleanAddr = fullAddress;
    const parenIdx = cleanAddr.indexOf('(');
    if (parenIdx !== -1) {
        cleanAddr = cleanAddr.slice(0, parenIdx);
    }
    const address = cleanAddr.replace(/\s{2,}/g, ' ').trim();

    // 5) 사업자번호 추출
    let bizNo = '';
    const bizMatches = combinedFullText.match(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/g) || [];
    if (bizMatches.length >= 2) {
        bizNo = bizMatches[1].replace(/\s+/g, '-');
    } else if (bizMatches.length === 1) {
        bizNo = bizMatches[0].replace(/\s+/g, '-');
    }

    // 6) 배송 요청사항(메모) 추출
    let memo = '';
    const memoMatch = combinedFullText.match(/(?:배송\s*요청사항|배송메모|요청사항|비고)[\s:|]*([^\n\r|]+)/);
    if (memoMatch) {
        memo = memoMatch[1].split(/(?:총\s*상품수량|총주문금액|인수자|배송비)/)[0].trim();
    }

    // 7) 상품 품목(Items) 파싱
    const items = [];
    fullTextLines.forEach(lineTokens => {
        const lineStr = lineTokens.map(t => t.text).join(' ').trim();
        // 번호로 시작하는 상품 테이블 행 패턴 (예: "1 ★공산 핫★ 참치 ... 1 13,840 ...")
        const rowMatch = lineStr.match(/^(\d+)\s+([★\[\(\w가-힣\s\/\-\.]+?)(?:\s+(\d+(?:\.\d+)?[a-zA-Z가-힣]*))?\s+(?:국내산|중국산|수입산)?\s*(\d+)\s+([\d,]+)/);
        if (rowMatch) {
            const pName = rowMatch[2].trim().replace(/^[|>\s]+/, '');
            const pUnit = rowMatch[3] ? rowMatch[3].trim() : '개';
            const pQty = parseInt(rowMatch[4], 10) || 1;
            const pPrice = parseInt(rowMatch[5].replace(/,/g, ''), 10) || 0;
            const pTotal = pPrice * pQty;

            items.push({
                name: pName,
                qty: pQty,
                unit: pUnit,
                price: pPrice,
                total: pTotal
            });
        }
    });

    let qty = items.length > 0 ? items.reduce((sum, it) => sum + it.qty, 0) : 1;
    let itemName = '';
    if (items.length > 1) {
        itemName = `${items[0].name} 외 ${items.length - 1}건 (총 ${qty}개)`;
    } else if (items.length === 1) {
        itemName = `${items[0].name} (${items[0].qty}${items[0].unit})`;
    } else {
        itemName = '상품 정보 미등록';
    }

    // 상호명이 비어있을 경우 보정
    if (!storeName) storeName = buyerName || '배송처';
    storeName = storeName.replace(/^[)|\]}>\s]+/, '').trim();

    return [{
        id: Date.now() + Math.random(),
        assignedDriver: assignedDriver,
        senderName: senderName,
        buyerName: buyerName,
        orderNo: orderNo,
        bizNo: bizNo,
        address: address, // 내비/관제용 도로명 번지 주소
        fullAddress: fullAddress || address, // 🌟 인쇄용 층/호수 원본 상세 주소
        storeName: storeName,
        phone: phone,
        itemName: itemName,
        unit: items.length > 0 ? items[0].unit : '개',
        qty: qty,
        price: '',
        total: '',
        memo: memo,
        lat: null,
        lng: null,
        items: items
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