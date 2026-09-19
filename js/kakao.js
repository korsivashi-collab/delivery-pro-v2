// js/kakao.js

const KAKAO_REST_API_KEY = "625c74c7254b3dbf7eea75ba0cac4c5f";

// 1. 텍스트 주소를 위도/경도 좌표로 변환
export async function geocodeAddress(address) {
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
    
    response = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(address)}`, { 
        headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
    });
    data = await response.json();
    
    if (data.documents && data.documents.length > 0) {
        let finalName = data.documents[0].place_name;
        if(data.documents[0].address_name) {
            finalName += ` (${data.documents[0].address_name})`;
        }
        return { 
            lat: parseFloat(data.documents[0].y), 
            lng: parseFloat(data.documents[0].x), 
            address_name: finalName 
        };
    }
    
    throw new Error('검색 실패');
}

// 2. 위도/경도 좌표를 텍스트 주소로 변환
export async function coordToAddress(x, y) {
    try {
        const response = await fetch(`https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${x}&y=${y}`, { 
            headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
        });
        const data = await response.json();
        if (data.documents && data.documents.length > 0) {
            return data.documents[0].address.address_name;
        }
    } catch (e) {} 
    return null;
}

// 3. 🌟 [개선됨] 주변 상가(POI) 탐색 반경을 100m로 넓히고 키워드 검색 병행
export async function getNearbyPOIs(lat, lng) {
    const cats = ['FD6', 'CE7', 'CS2', 'MT1', 'HP8', 'PM9']; // 음식점, 카페, 편의점 등
    let places = [];
    
    // 반경을 50m -> 100m로 확대하여 건물 오차 커버
    await Promise.all(cats.map(async (cat) => {
        try {
            let res = await fetch(`https://dapi.kakao.com/v2/local/search/category.json?category_group_code=${cat}&y=${lat}&x=${lng}&radius=100`, { 
                headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
            });
            let data = await res.json();
            if (data.documents) {
                places.push(...data.documents.map(d => d.place_name));
            }
        } catch(e) {}
    }));

    // 주변 주소 기반 키워드 검색도 함께 수행하여 상가 누락 방지
    try {
        let resKw = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?y=${lat}&x=${lng}&radius=100&query=상회`, { 
            headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
        });
        let dataKw = await resKw.json();
        if (dataKw.documents) {
            places.push(...dataKw.documents.map(d => d.place_name));
        }
    } catch(e) {}
    
    return [...new Set(places)]; 
}

// 레벤슈타인 거리 기반 유사도 측정
export function getSimilarity(s1, s2) {
    if (!s1.length || !s2.length) return 0;
    let matrix = [];
    for (let i = 0; i <= s1.length; i++) matrix[i] = [i];
    for (let j = 0; j <= s2.length; j++) matrix[0][j] = j;
    
    for (let i = 1; i <= s1.length; i++) {
        for (let j = 1; j <= s2.length; j++) {
            if (s1.charAt(i - 1) == s2.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    
    let distance = matrix[s1.length][s2.length];
    let maxLength = Math.max(s1.length, s2.length);
    return ((maxLength - distance) / maxLength) * 100;
}

// 4. 🌟 [개선됨] 괄호, (주), 특수문자를 유연하게 무시하고 매칭하는 상호 판별 로직
export function findStoreNameFromOCR(rawOCRText, places) {
    let cleanOCR = rawOCRText.replace(/\s+/g, '');
    let bestMatch = null;
    let highestSim = 0;

    for (let place of places) {
        // (주), 유한회사, 괄호 내용 및 특수문자 완벽 제거 후 비교
        let cleanPlace = place.replace(/\(.*?\)/g, '').replace(/주식회사|유한회사/g, '').replace(/[^\w가-힣]/g, '');
        if (cleanPlace.length < 2) continue;
        
        // 1. OCR 텍스트 안에 상호명이 포함된 경우
        if (cleanOCR.includes(cleanPlace)) {
            return place; 
        }

        // 2. 줄 단위 비교 (유사도 기준을 75%로 살짝 완화하여 오인식 대응)
        let lines = rawOCRText.split(/\n/);
        for (let line of lines) {
            let cleanLine = line.replace(/주식회사|유한회사/g, '').replace(/[^\w가-힣]/g, '');
            if(cleanLine.length < 2) continue;
            
            let sim = getSimilarity(cleanPlace, cleanLine);
            if (sim > highestSim && sim >= 75) {
                highestSim = sim;
                bestMatch = place;
            }
        }
    }
    return bestMatch;
}