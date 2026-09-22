// js/kakao.js

const KAKAO_REST_API_KEY = "625c74c7254b3dbf7eea75ba0cac4c5f";

// 1. 주소 지오코딩 (대표 상호명이 주소에 강제로 합쳐지는 현상 방지)
export async function geocodeAddress(address) {
    // 1차: 정밀 도로명/지번 주소 검색
    let response = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`, { 
        headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
    });
    let data = await response.json();
    if (data.documents && data.documents.length > 0) {
        return { 
            lat: parseFloat(data.documents[0].y), 
            lng: parseFloat(data.documents[0].x), 
            address_name: data.documents[0].address_name 
        };
    }
    
    // 2차: 키워드 검색 (순수 도로명/지번 주소만 추출하여 주소 오염 방지)
    response = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(address)}`, { 
        headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
    });
    data = await response.json();
    if (data.documents && data.documents.length > 0) {
        const doc = data.documents[0];
        const cleanAddress = doc.road_address_name || doc.address_name || doc.place_name;
        return { 
            lat: parseFloat(doc.y), 
            lng: parseFloat(doc.x), 
            address_name: cleanAddress 
        };
    }
    throw new Error('검색 실패');
}

// 2. 좌표를 주소로 변환
export async function coordToAddress(x, y) {
    try {
        const response = await fetch(`https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${x}&y=${y}`, { 
            headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
        });
        const data = await response.json();
        if (data.documents && data.documents.length > 0) {
            const doc = data.documents[0];
            if (doc.road_address) return doc.road_address.address_name;
            if (doc.address) return doc.address.address_name;
        }
    } catch (e) {} 
    return null;
}

// 3. 주소지 기반 등록 상호/POI 목록 조회
export async function getPOIsByAddress(addressStr) {
    if (!addressStr) return [];
    let places = [];
    try {
        let cleanAddr = addressStr.replace(/\[.*?\]/g, '').trim();
        let res = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(cleanAddr)}`, { 
            headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
        });
        let data = await res.json();
        if (data.documents) places.push(...data.documents.map(d => d.place_name));
    } catch(e) {}
    return [...new Set(places)];
}

// 4. 반경 100m 이내 주요 카테고리 POI 조회
export async function getNearbyPOIs(lat, lng) {
    const cats = ['FD6', 'CE7', 'CS2', 'MT1', 'HP8', 'PM9']; 
    let places = [];
    await Promise.all(cats.map(async (cat) => {
        try {
            let res = await fetch(`https://dapi.kakao.com/v2/local/search/category.json?category_group_code=${cat}&y=${lat}&x=${lng}&radius=100`, { 
                headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
            });
            let data = await res.json();
            if (data.documents) places.push(...data.documents.map(d => d.place_name));
        } catch(e) {}
    }));
    return [...new Set(places)]; 
}

// 글자 순서 기반 레벤슈타인 편집거리 계산 함수 (순서가 다르면 거리가 멀어짐)
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

// 5. 1단계: 순서 동일률(50% 이상) 기반 핵심 상호 매칭 알고리즘
export function findStoreNameFromOCR(rawOCRText, places, threshold = 50) {
    if (!rawOCRText || !places || places.length === 0) return null;

    let fullCleanOCR = rawOCRText.replace(/[^\w가-힣]/g, '');
    let bestMatch = null;
    let highestSim = 0;

    for (let place of places) {
        let cleanPlace = place.replace(/\(.*?\)/g, '').replace(/주식회사|유한회사/g, '').replace(/[^\w가-힣]/g, '');
        if (cleanPlace.length <= 1) continue; 
        
        // 100% 완전 포함 시 즉시 확정 반환
        if (fullCleanOCR.includes(cleanPlace)) return place;

        // 지점명('~점') 및 띄어쓰기 뒷부분 분리 후 순서 비교 대상 추출
        let corePlace = place.replace(/\(.*?\)/g, '').replace(/주식회사|유한회사/g, '').trim().split(/\s+/)[0];
        corePlace = corePlace.replace(/[가-힣0-9]{1,4}점$/, '').replace(/[^\w가-힣]/g, '');
        if (corePlace.length <= 1) corePlace = cleanPlace;

        if (fullCleanOCR.includes(corePlace)) return place;

        let targetWord = corePlace.length >= 2 ? corePlace : cleanPlace;
        let targetLen = targetWord.length;
        if (fullCleanOCR.length < targetLen - 1) continue;

        let effectiveThreshold = threshold; // 50% 순차 일치 적용

        for (let i = 0; i <= fullCleanOCR.length - targetLen + 1; i++) {
            for (let j = Math.max(2, targetLen - 1); j <= targetLen + 2; j++) {
                let subStr = fullCleanOCR.substring(i, i + j);
                if (subStr.length < 2) continue;

                // 글자 순서가 유지된 상태에서의 편집 거리 및 유사도 산출
                let dist = getLevenshteinDistance(targetWord, subStr);
                let maxLen = Math.max(targetWord.length, subStr.length);
                let sim = ((maxLen - dist) / maxLen) * 100;

                // 50% 이상 순차 일치하며 가장 유사도가 높은 최상위 POI 선정
                if (sim >= effectiveThreshold && sim > highestSim) {
                    highestSim = sim;
                    bestMatch = place;
                }
            }
        }
    }
    return bestMatch;
}

// 6. 2단계: 주소지 영역 텍스트와 POI 간 중복(교집합) 매칭
export function findOverlappingPOIFromAddress(addressAreaText, places) {
    if (!addressAreaText || !places || places.length === 0) return null;
    let cleanAddr = addressAreaText.replace(/[^\w가-힣]/g, '');

    for (let place of places) {
        let cleanPlace = place.replace(/\(.*?\)/g, '').replace(/주식회사|유한회사/g, '').replace(/[^\w가-힣]/g, '');
        if (cleanPlace.length <= 1) continue;

        if (cleanAddr.includes(cleanPlace)) {
            return place;
        }

        let corePlace = place.replace(/\(.*?\)/g, '').replace(/주식회사|유한회사/g, '').trim().split(/\s+/)[0];
        corePlace = corePlace.replace(/[^\w가-힣]/g, '');
        if (corePlace.length >= 2 && cleanAddr.includes(corePlace)) {
            return place;
        }
    }
    return null;
}