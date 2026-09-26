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

            // 🌟 재가공된 PDF의 글자 파편화 및 텍스트 엉킴을 해결한 스마트 파싱 실행
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
// 3. 다중 양식 대응 인공지능형 PDF 데이터 추출 알고리즘 (글자 파편화 및 좌표 보정)
// ==========================================
function parseOrdersFromPage(rawPdfItems, pageNum, pageWidth, pageHeight, fileName) {
    if (!rawPdfItems || rawPdfItems.length === 0) return [];

    // 1단계: 글자 파편화 방지를 위한 Y좌표(줄/Line) 기반 텍스트 완벽 병합 조립
    const lineMap = new Map();
    rawPdfItems.filter(it => it.str && it.str.trim() !== '').forEach(it => {
        const text = it.str.trim();
        const x = Math.round(it.transform[4]);
        const y = Math.round(it.transform[5]);
        const width = Math.round(it.width || text.length * 5);
        
        let matchedY = null;
        for (const ey of lineMap.keys()) {
            if (Math.abs(ey - y) <= 4) { matchedY = ey; break; }
        }
        const targetY = matchedY !== null ? matchedY : y;
        if (!lineMap.has(targetY)) lineMap.set(targetY, []);
        lineMap.get(targetY).push({ text, x, y, width });
    });

    const sortedYKeys = Array.from(lineMap.keys()).sort((a, b) => b - a); // 위에서 아래 정렬
    const validLines = []; // 전체 라인 
    const buyerLines = []; // 우측(공급받는 자/배송지) 라인

    // A4 기준 좌측(공급자)과 우측(공급받는 자)을 분리하는 X 좌표 임계점
    const splitX = pageWidth ? pageWidth * 0.42 : 250;

    sortedYKeys.forEach(yKey => {
        const lineTokens = lineMap.get(yKey).sort((a, b) => a.x - b.x);
        
        let fullLineStr = '';
        let buyerLineStr = '';
        let lastX = -1000;
        let lastWidth = 0;
        
        lineTokens.forEach(t => {
            // 글자 간격이 넓으면 공백 추가 (가까우면 붙여쓰기)
            if (lastX !== -1000 && (t.x - (lastX + lastWidth)) > 5) {
                fullLineStr += ' ';
                if (t.x >= splitX) buyerLineStr += ' ';
            }
            fullLineStr += t.text;
            if (t.x >= splitX) buyerLineStr += t.text;
            
            lastX = t.x;
            lastWidth = t.width;
        });
        
        validLines.push({ text: fullLineStr.trim(), y: yKey });
        if (buyerLineStr.trim()) {
            buyerLines.push({ text: buyerLineStr.trim(), y: yKey });
        }
    });

    // 🌟 안전하게 줄바꿈(\n)으로 합쳐서 타 영역 정규식 침범을 원천 차단
    const allTextJoined = validLines.map(l => l.text).join('\n');
    const buyerTextCombined = buyerLines.map(l => l.text).join('\n');

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

    let senderName = '';
    const senderMatch = allTextJoined.match(/(?:공급자|출고처|발송처|화주)[\s\S]*?(?:상호\(법인명\)|상호명|상호)[\s:|]*([가-힣A-Za-z0-9\(\)\s]{2,20})/);
    if (senderMatch) {
        senderName = senderMatch[1].split(/[\n\r|]/)[0].trim();
    } else {
        const generalStore = allTextJoined.match(/상호\(법인명\)[\s:|]*([가-힣A-Za-z0-9\(\)\s]{2,20})/);
        if (generalStore) senderName = generalStore[1].split(/[\n\r|]/)[0].trim();
    }
    if (!senderName && fileName) {
        senderName = fileName.replace(/\.[^/.]+$/, '').split(/[_\-\s]+/)[0].trim();
    }
    if (!senderName) senderName = '정보 없음';

    // 3단계: [공급받는 자 / 수취처] 배송지 정보 정밀 추출
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

    let buyerName = '';
    const buyerMatch = buyerTextCombined.match(/(?:구매자명|주문자명|수령인|수취인|받는분)[\s:|]*([가-힣A-Za-z0-9]{2,10})/);
    if (buyerMatch) {
        buyerName = buyerMatch[1].trim();
    }

    if (!storeName) storeName = buyerName || '배송처';
    storeName = storeName.replace(/^[)|\]}>\s]+/, '').trim();

    let phone = '';
    const buyerPhones = buyerTextCombined.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g) || [];
    if (buyerPhones.length > 0) {
        phone = formatPhoneNumber(buyerPhones[0]);
    } else {
        const noHyphenMatches = buyerTextCombined.match(/01[016789]\d{7,8}/g) || [];
        if (noHyphenMatches.length > 0) phone = formatPhoneNumber(noHyphenMatches[0]);
    }

    // 🌟 배송지 주소 추출 시, 줄바꿈을 띄어쓰기로 바꿔서 매칭 (주소가 여러 줄로 쪼개진 경우 완벽 커버)
    let rawAddress = '';
    const regionRegex = /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[가-힣A-Za-z0-9\s\(\)\-\,\.]{5,80}?(?:로|길|대로|동|읍|면|리|가)\s*[\d\-]+(?:\s*[가-힣A-Za-z0-9\(\)\,\-\.\s]*)/g;
    
    const flatBuyerText = buyerTextCombined.replace(/\n/g, ' ');
    const buyerAddrMatches = flatBuyerText.match(regionRegex) || [];
    
    if (buyerAddrMatches.length > 0) {
        rawAddress = buyerAddrMatches[0];
    } else {
        const flatAllText = allTextJoined.replace(/\n/g, ' ');
        const allAddrMatches = flatAllText.match(regionRegex) || [];
        const filtered = allAddrMatches.filter(a => !a.includes('건원대로') && !a.includes('공급자'));
        if (filtered.length > 0) {
            rawAddress = filtered[0];
        } else if (allAddrMatches.length > 1) {
            rawAddress = allAddrMatches[1];
        } else if (allAddrMatches.length > 0) {
            rawAddress = allAddrMatches[0];
        }
    }

    rawAddress = rawAddress.split(/(?:연락처|전화|배송지명|간판명|매장명|상호|구매자|No\.|결제|인수자)/)[0];
    rawAddress = rawAddress.replace(/\[\d+\]/g, ' ')
                           .replace(/받\s*주소/g, ' ')
                           .replace(/\b받\b/g, ' ')
                           .replace(/\b주소\b/g, ' ')
                           .replace(/\|/g, ' ')
                           .replace(/[:]/g, ' ')
                           .trim();

    const fullAddress = rawAddress.replace(/\s{2,}/g, ' ').trim();

    let cleanAddr = fullAddress;
    const parenIdx = cleanAddr.indexOf('(');
    if (parenIdx !== -1) {
        cleanAddr = cleanAddr.slice(0, parenIdx);
    }
    const address = cleanAddr.replace(/\s{2,}/g, ' ').trim();

    let bizNo = '';
    const bizMatches = buyerTextCombined.match(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/g) || [];
    if (bizMatches.length > 0) bizNo = bizMatches[0].replace(/\s+/g, '-');

    let memo = '';
    const memoMatch = allTextJoined.match(/(?:배송\s*요청사항|배송메모|요청사항|비고)[\s:|]*([^\n\r|]+)/);
    if (memoMatch) {
        memo = memoMatch[1].split(/(?:총\s*상품수량|총주문금액|인수자|배송비|총\s*상품금액)/)[0].trim();
    }

    // 4단계: 🌟 표(테이블) 파이프(|) 무시 및 상품 품목 정밀 파싱
    const orderItems = [];

    validLines.forEach(line => {
        const lineStr = line.text;
        
        // 정규식: 순번(1~99)으로 시작하고, 중간에 파이프(|)나 공백을 무시하며 끝부분에 3개 이상의 숫자(수량/단가/금액)가 배열된 문장 구조 추출
        const rowMatch = lineStr.match(/^(\d{1,2})\s*[|]*\s*(.+?)\s+([\d,\s|]+)$/);
        
        if (rowMatch) {
            const namePart = rowMatch[2];
            // 뒷부분의 숫자들만 깨끗하게 배열로 추출
            const numTokens = rowMatch[3].replace(/[^\d,\s]/g, ' ').trim().split(/\s+/);
            
            if (numTokens.length >= 3) {
                const pQty = parseInt(numTokens[0].replace(/,/g, ''), 10) || 1;
                const pPrice = parseInt(numTokens[1].replace(/,/g, ''), 10) || 0;
                const pTotal = parseInt(numTokens[numTokens.length - 1].replace(/,/g, ''), 10) || 0;
                
                let pName = namePart.replace(/\|/g, ' ').trim();
                let pUnit = '개';
                const unitMatch = pName.match(/(\d+(?:\.\d+)?)\s*(kg|g|L|ml|ea|판|봉|박스|box|팩)/i);
                if (unitMatch) {
                    pUnit = unitMatch[0].trim();
                }

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