import { withRequestDeadline } from './utils.js';

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
    const { onRequest, ...fetchOptions } = options;
    return withRequestDeadline(async signal => {
    const delays = [200, 500, 1000];
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let responseReceived = false;
        try {
            const res = await withRequestDeadline(async requestSignal => {
                onRequest?.();
                const response = await fetch(url, { ...fetchOptions, signal: requestSignal });
                responseReceived = true;
                // 성공 응답의 본문까지 읽어야 fetch 이후 JSON pending도 상한에 포함된다.
                const data = response.ok ? await response.json() : null;
                return { ok: response.ok, status: response.status, json: async () => data };
            }, KAKAO_REQUEST_TIMEOUT_MS, { signal, label: 'Kakao 조회' });
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
            if (responseReceived || err.name === 'TimeoutError' || err.name === 'AbortError') throw err;
            if (attempt < maxRetries) {
                const jitter = Math.floor(Math.random() * 50);
                const delay = (delays[attempt] || 1000) + jitter;
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
    }, KAKAO_OPERATION_TIMEOUT_MS, { signal: options.signal, label: 'Kakao 조회' });
}

export const KAKAO_REQUEST_TIMEOUT_MS = 10000;
export const KAKAO_OPERATION_TIMEOUT_MS = 25000;

// ==========================================
// 1. 주소 지오코딩 (캐시 우선 확인 & 429 지수 백오프 탑재)
// ==========================================
export async function geocodeAddress(address, { signal, onRequest } = {}) {
    return withRequestDeadline(async requestSignal => {
    if (!address) throw new Error('주소가 비어 있습니다.');
    const cleanKey = address.replace(/\[.*?\]/g, '').trim();
    if (!cleanKey) throw new Error('유효한 주소가 아닙니다.');

    // 🌟 1단계: 로컬 주소 캐시 우선 확인 (카카오 호출 0회, 0.001초 즉시 반환)
    const cache = getGeoCache();
    // Refresh legacy cache entries once so road/parcel aliases are available for validation.
    if (cache[cleanKey]?.search_source) {
        return cache[cleanKey];
    }

    // 🌟 2단계: 카카오 1차 정밀 도로명/지번 주소 검색 (지수 백오프 적용)
    let response = await fetchWithRetry(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(cleanKey)}`, { 
        headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` }, signal: requestSignal, onRequest
    });
    
    if (response && response.ok) {
        let data = await response.json();
        if (data.documents && data.documents.length > 0) {
            const doc = data.documents[0];
            const result = { 
                lat: parseFloat(doc.y),
                lng: parseFloat(doc.x),
                address_name: doc.address_name,
                road_address_name: doc.road_address?.address_name || '',
                jibun_address_name: doc.address?.address_name || '',
                address_type: doc.address_type,
                search_source: 'address'
            };
            cache[cleanKey] = result;
            saveGeoCache(cache);
            return result;
        }
    }
    
    // 🌟 3단계: 카카오 2차 키워드 검색 (순수 도로명/지번 추출)
    response = await fetchWithRetry(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(cleanKey)}`, { 
        headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` }, signal: requestSignal, onRequest
    });
    
    if (response && response.ok) {
        let data = await response.json();
        if (data.documents && data.documents.length > 0) {
            const doc = data.documents[0];
            const cleanAddress = doc.road_address_name || doc.address_name || doc.place_name;
            const result = { 
                lat: parseFloat(doc.y), 
                lng: parseFloat(doc.x), 
                address_name: cleanAddress,
                road_address_name: doc.road_address_name || '',
                jibun_address_name: doc.address_name || '',
                search_source: 'keyword'
            };
            cache[cleanKey] = result;
            saveGeoCache(cache);
            return result;
        }
    }

    throw new Error('검색 실패');
    }, KAKAO_OPERATION_TIMEOUT_MS, { signal, label: '주소 조회' });
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

