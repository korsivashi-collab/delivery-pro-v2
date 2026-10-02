import { isStoreNameAddressText } from './utils.js';

// js/kakao.js

const KAKAO_REST_API_KEY = "625c74c7254b3dbf7eea75ba0cac4c5f";

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
// 0-1. 지수 백오프(Exponential Backoff with Jitter) 429 방어 통신 래퍼
// ==========================================
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
    const delays = [200, 500, 1000];
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url, options);
            // 429 Too Many Requests (호출 폭주) 또는 5xx 일시적 서버 오류 발생 시 재시도
            if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
                if (attempt < maxRetries) {
                    const jitter = Math.floor(Math.random() * 50);
                    const delay = (delays[attempt] || 1000) + jitter;
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
            }
            return res;
        } catch (err) {
            if (attempt < maxRetries) {
                const jitter = Math.floor(Math.random() * 50);
                const delay = (delays[attempt] || 1000) + jitter;
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
}

// ==========================================
// 1. 주소 지오코딩 (캐시 우선 확인 & 429 지수 백오프 탑재)
// ==========================================
export async function geocodeAddress(address) {
    if (!address) throw new Error('주소가 비어 있습니다.');
    const cleanKey = address.replace(/\[.*?\]/g, '').trim();
    if (!cleanKey) throw new Error('유효한 주소가 아닙니다.');

    // 🌟 1단계: 로컬 주소 캐시 우선 확인 (카카오 호출 0회, 0.001초 즉시 반환)
    const cache = getGeoCache();
    if (cache[cleanKey]) {
        return cache[cleanKey];
    }

    // 🌟 2단계: 카카오 1차 정밀 도로명/지번 주소 검색 (지수 백오프 적용)
    let response = await fetchWithRetry(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(cleanKey)}`, { 
        headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
    });
    
    if (response && response.ok) {
        let data = await response.json();
        if (data.documents && data.documents.length > 0) {
            const result = { 
                lat: parseFloat(data.documents[0].y), 
                lng: parseFloat(data.documents[0].x), 
                address_name: data.documents[0].address_name 
            };
            cache[cleanKey] = result;
            saveGeoCache(cache);
            return result;
        }
    }
    
    // 🌟 3단계: 카카오 2차 키워드 검색 (순수 도로명/지번 추출)
    response = await fetchWithRetry(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(cleanKey)}`, { 
        headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
    });
    
    if (response && response.ok) {
        let data = await response.json();
        if (data.documents && data.documents.length > 0) {
            const doc = data.documents[0];
            const cleanAddress = doc.road_address_name || doc.address_name || doc.place_name;
            const result = { 
                lat: parseFloat(doc.y), 
                lng: parseFloat(doc.x), 
                address_name: cleanAddress 
            };
            cache[cleanKey] = result;
            saveGeoCache(cache);
            return result;
        }
    }

    throw new Error('검색 실패');
}

// ==========================================
// 2. 좌표를 주소로 변환
// ==========================================
export async function coordToAddress(x, y) {
    try {
        const response = await fetchWithRetry(`https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${x}&y=${y}`, { 
            headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
        });
        if (response && response.ok) {
            const data = await response.json();
            if (data.documents && data.documents.length > 0) {
                const doc = data.documents[0];
                if (doc.road_address) return doc.road_address.address_name;
                if (doc.address) return doc.address.address_name;
            }
        }
    } catch (e) {} 
    return null;
}

// ==========================================
// 3. 주소지 기반 등록 상호/POI 목록 조회
// ==========================================
export async function getPOIsByAddress(addressStr) {
    if (!addressStr) return [];
    let places = [];
    try {
        let cleanAddr = addressStr.replace(/\[.*?\]/g, '').trim();
        let res = await fetchWithRetry(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(cleanAddr)}`, { 
            headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
        });
        if (res && res.ok) {
            let data = await res.json();
            if (data.documents) places.push(...data.documents.map(d => d.place_name));
        }
    } catch(e) {}
    return [...new Set(places)];
}

// ==========================================
// 4. 반경 100m 이내 주요 카테고리 POI 조회
// ==========================================
export async function getNearbyPOIs(lat, lng) {
    const cats = ['FD6', 'CE7', 'CS2', 'MT1', 'HP8', 'PM9']; 
    let places = [];
    await Promise.all(cats.map(async (cat) => {
        try {
            let res = await fetchWithRetry(`https://dapi.kakao.com/v2/local/search/category.json?category_group_code=${cat}&y=${lat}&x=${lng}&radius=100`, { 
                headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
            });
            if (res && res.ok) {
                let data = await res.json();
                if (data.documents) places.push(...data.documents.map(d => d.place_name));
            }
        } catch(e) {}
    }));
    return [...new Set(places)]; 
}

// 글자 순서 기반 레벤슈타인 편집거리 계산 함수
function getLevenshteinDistance(s1, s2) {
    if (!s1.length) return s2.length;
    if (!s2.length) return s1.length;
    let matrix = [];
    for (let i = 0; i <= s1.length; i++) matrix[i] = [i];
    for (let j = 0; j <= s2.length; j++) matrix[0][j] = j;
    
    for (let i = 1; i <= s1.length; i++) {
        for (let j = 1; j <= s2.length; j++) {
            if (s1.charAt(i - 1) === s2.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
            }
        }
    }
    return matrix[s1.length][s2.length];
}

// ==========================================
// 5. 1단계: 순서 동일률 기반 상호 매칭 (2글자 상호 100% 필수, 3글자 이상 50% 허용)
// ==========================================
export function findStoreNameFromOCR(rawOCRText, places, threshold = 85, addressStr = '') {
    if (!rawOCRText || !places || !places.length) return null;
    const clean = value => value.replace(/\(.*?\)/g, '').replace(/주식회사|유한회사/g, '').replace(/[^\w가-힣]/g, '');
    const addressKey = clean(addressStr);
    const evidence = [];
    let addressContinuation = false;
    let section = '';
    for (const line of rawOCRText.split(/\r?\n/)) {
        const sections = [...line.matchAll(/공급받는\s*자|공급자|발송지|본사|배송지|수령지|납품처/g)];
        if (sections.length) section = sections[sections.length - 1][0];
        if (/^(?:공급자|발송지|본사)$/.test(section)) continue;
        const hasLabel = /상\s*호|법\s*인\s*명|업\s*체\s*명|간판명|배송지명/.test(line);
        if (isStoreNameAddressText(line) || (addressKey && clean(line).includes(addressKey))) {
            addressContinuation = true;
            continue;
        }
        // 주소 다음 줄의 건물명도 주소 문맥으로 취급. 명시적 상호 라벨은 예외.
        if (addressContinuation && !hasLabel) {
            if (line.trim()) addressContinuation = false;
            continue;
        }
        addressContinuation = false;
        if (/전화|연락처|사업자|금액|수량|단가|총액|합계|품명|대표자|성명/.test(line) && !hasLabel) continue;
        const nameText = line.replace(/^.*?(?:상\s*호\s*(?:\(\s*법\s*인\s*명\s*\)|명)?|법\s*인\s*명|업\s*체\s*명|간판명|배송지명)\s*[:：|]?/, '')
            .split(/\s+(?:주\s*소|전화|연락처|사업자|금액|수량|단가|대표자|성명)/)[0];
        // OCR 단계에서 수치 혼입으로 낮게 평가한 후보를 fallback에서 재확정하지 않음
        if (/\b\d{3}\s*-\s*\d{2}\s*-\s*\d{5}\b|\b0\d{1,3}[\s.-]*\d{3,4}[\s.-]*\d{4}\b|\b\d{8,13}\b|\d[\d,]*\s*(?:원|개|EA|박스|kg)(?=\s|$|[,;|])|\b\d{1,3}(?:,\d{3})+\b/i.test(nameText)) continue;
        const normalized = clean(nameText);
        if (normalized.length >= 2 && /[A-Za-z가-힣]/.test(normalized)) evidence.push(normalized);
    }
    if (!evidence.length) return null;
    const ranked = [];
    for (const place of [...new Set(places)]) {
        if (isStoreNameAddressText(place)) continue;
        const fullName = clean(place);
        if (fullName.length < 2) continue;
        const core = clean(place.trim().split(/\s+/)[0]);
        let score = 0;
        for (const text of evidence) {
            if (text.includes(fullName)) score = Math.max(score, 100);
            else if (core.length >= 3 && text.includes(core)) score = Math.max(score, 90);
            else if (fullName.length >= 3) {
                // 전체 문서 연결 문자열 대신 주소를 제외한 개별 줄 안에서만 비교
                for (let i = 0; i < text.length; i++) {
                    for (let size = Math.max(3, fullName.length - 1); size <= fullName.length + 1; size++) {
                        const part = text.slice(i, i + size);
                        if (part.length < 3) continue;
                        const similarity = 100 * (1 - getLevenshteinDistance(fullName, part) / Math.max(fullName.length, part.length));
                        score = Math.max(score, similarity);
                    }
                }
            }
        }
        if (/상가|아파트|빌딩|타워|센터/.test(place)) score -= 8;
        if (score >= Math.max(85, threshold)) ranked.push({ place, score });
    }
    ranked.sort((a, b) => b.score - a.score);
    if (!ranked.length || (ranked[1] && ranked[0].score - ranked[1].score < 10)) return null;
    return ranked[0].place;
}

// 주소 영역의 일치만으로 상호를 확정하지 않고 별도의 OCR 상호 근거를 요구
export function findOverlappingPOIFromAddress(addressAreaText, places, nonAddressText = '') {
    if (!nonAddressText) return null;
    return findStoreNameFromOCR(nonAddressText, places, 85, addressAreaText);
}
