// js/kakao.js

const KAKAO_REST_API_KEY = "625c74c7254b3dbf7eea75ba0cac4c5f";

export async function geocodeAddress(address) {
    let response = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`, { 
        headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
    });
    let data = await response.json();
    if (data.documents && data.documents.length > 0) return { lat: parseFloat(data.documents[0].y), lng: parseFloat(data.documents[0].x), address_name: data.documents[0].address_name };
    
    response = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(address)}`, { 
        headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
    });
    data = await response.json();
    if (data.documents && data.documents.length > 0) {
        let finalName = data.documents[0].place_name;
        if(data.documents[0].address_name) finalName += ` (${data.documents[0].address_name})`;
        return { lat: parseFloat(data.documents[0].y), lng: parseFloat(data.documents[0].x), address_name: finalName };
    }
    throw new Error('검색 실패');
}

export async function coordToAddress(x, y) {
    try {
        const response = await fetch(`https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${x}&y=${y}`, { headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } });
        const data = await response.json();
        if (data.documents && data.documents.length > 0) return data.documents[0].address.address_name;
    } catch (e) {} return null;
}

export async function getPOIsByAddress(addressStr) {
    if (!addressStr) return [];
    let places = [];
    try {
        let cleanAddr = addressStr.replace(/\[.*?\]/g, '').trim();
        let res = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(cleanAddr)}`, { headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } });
        let data = await res.json();
        if (data.documents) places.push(...data.documents.map(d => d.place_name));
    } catch(e) {}
    return [...new Set(places)];
}

export async function getNearbyPOIs(lat, lng) {
    const cats = ['FD6', 'CE7', 'CS2', 'MT1', 'HP8', 'PM9']; 
    let places = [];
    await Promise.all(cats.map(async (cat) => {
        try {
            let res = await fetch(`https://dapi.kakao.com/v2/local/search/category.json?category_group_code=${cat}&y=${lat}&x=${lng}&radius=100`, { headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } });
            let data = await res.json();
            if (data.documents) places.push(...data.documents.map(d => d.place_name));
        } catch(e) {}
    }));
    return [...new Set(places)]; 
}

// 레벤슈타인 거리 계산 (수정본)
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

export function findStoreNameFromOCR(rawOCRText, places) {
    let cleanOCR = rawOCRText.replace(/\s+/g, '');
    let bestMatch = null;
    let highestSim = 0;

    for (let place of places) {
        let cleanPlace = place.replace(/\(.*?\)/g, '').replace(/주식회사|유한회사/g, '').replace(/[^\w가-힣]/g, '');
        if (cleanPlace.length <= 1) continue; 
        
        // 1단계: 완전 포함 검사
        if (cleanOCR.includes(cleanPlace)) return place;

        // 2단계: 줄 단위 슬라이딩 윈도우 검사 (버그 수정됨)
        let ocrLines = rawOCRText.split(/\n/);
        for (let line of ocrLines) {
            let cleanLine = line.replace(/[^\w가-힣]/g, '');
            if (cleanLine.length < cleanPlace.length - 1) continue; 

            let targetLen = cleanPlace.length;
            // 허용 오차를 주어 부분 문자열 생성 (목표 길이의 -1 ~ +2)
            for (let i = 0; i <= cleanLine.length - targetLen + 1; i++) {
                for (let j = Math.max(2, targetLen - 1); j <= targetLen + 2; j++) {
                    let subStr = cleanLine.substring(i, i + j);
                    if (subStr.length < 2) continue;

                    let dist = getLevenshteinDistance(cleanPlace, subStr);
                    let maxLen = Math.max(cleanPlace.length, subStr.length);
                    let sim = ((maxLen - dist) / maxLen) * 100;

                    if (sim >= 80 && sim > highestSim) {
                        highestSim = sim;
                        bestMatch = place;
                    }
                }
            }
        }
    }
    return bestMatch;
}