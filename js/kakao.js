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

// 3. 🌟 [핵심 추가] 주소 문자열 자체를 키워드로 검색하여 해당 주소지의 상가 목록을 정확히 가져오기
export async function getPOIsByAddress(addressStr) {
    if (!addressStr) return [];
    let places = [];
    try {
        let cleanAddr = addressStr.replace(/\[.*?\]/g, '').trim();
        let res = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(cleanAddr)}`, { 
            headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
        });
        let data = await res.json();
        if (data.documents) {
            places.push(...data.documents.map(d => d.place_name));
        }
    } catch(e) {
        console.error("주소 키워드 POI 조회 오류:", e);
    }
    return [...new Set(places)];
}

// 4. 주변 좌표 반경 기반 보조 검색 (기존 유지)
export async function getNearbyPOIs(lat, lng) {
    const cats = ['FD6', 'CE7', 'CS2', 'MT1', 'HP8', 'PM9']; 
    let places = [];
    
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
    return [...new Set(places)]; 
}

// 5. 레벤슈타인 거리 기반 유사도 측정
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

// 6. 상호 판별 로직 (기준을 60%로 완화하여 유사 매칭 성공률 극대화)
export function findStoreNameFromOCR(rawOCRText, places) {
    let cleanOCR = rawOCRText.replace(/\s+/g, '');
    let bestMatch = null;
    let highestSim = 0;

    for (let place of places) {
        let cleanPlace = place.replace(/\(.*?\)/g, '').replace(/주식회사|유한회사/g, '').replace(/[^\w가-힣]/g, '');
        if (cleanPlace.length < 2) continue;
        
        if (cleanOCR.includes(cleanPlace)) {
            return place; 
        }

        let lines = rawOCRText.split(/\n/);
        for (let line of lines) {
            let cleanLine = line.replace(/주식회사|유한회사/g, '').replace(/[^\w가-힣]/g, '');
            if(cleanLine.length < 2) continue;
            
            let sim = getSimilarity(cleanPlace, cleanLine);
            // 유사도 기준을 60%로 완화하여 오인식 극복
            if (sim > highestSim && sim >= 60) {
                highestSim = sim;
                bestMatch = place;
            }
        }
    }
    return bestMatch;
}