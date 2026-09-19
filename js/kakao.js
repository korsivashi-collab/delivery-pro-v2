// js/kakao.js

// 공통으로 사용할 카카오 REST API 키
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
    
    // 지번/도로명 검색 실패 시 키워드 검색으로 재시도 (건물명 등)
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
    } catch (e) {
        console.error("좌표->주소 변환 오류:", e);
    } 
    return null;
}

// 3. 주어진 좌표 반경 50m 이내의 배달 타겟 상가(POI) 목록 긁어오기
export async function getNearbyPOIs(lat, lng) {
    // 음식점(FD6), 카페(CE7), 편의점(CS2), 대형마트(MT1), 병원(HP8), 약국(PM9)
    const cats = ['FD6', 'CE7', 'CS2', 'MT1', 'HP8', 'PM9'];
    let places = [];
    
    await Promise.all(cats.map(async (cat) => {
        try {
            let res = await fetch(`https://dapi.kakao.com/v2/local/search/category.json?category_group_code=${cat}&y=${lat}&x=${lng}&radius=50`, { 
                headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
            });
            let data = await res.json();
            if (data.documents) {
                places.push(...data.documents.map(d => d.place_name));
            }
        } catch(e) {
            console.error(`POI 조회 오류 (${cat}):`, e);
        }
    }));
    
    return [...new Set(places)]; // 중복 제거 후 반환
}

// 4. 레벤슈타인 거리 기반 문자열 유사도 측정 (0~100%)
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
                    matrix[i - 1][j - 1] + 1, // substitution
                    Math.min(matrix[i][j - 1] + 1, // insertion
                             matrix[i - 1][j] + 1) // deletion
                );
            }
        }
    }
    
    let distance = matrix[s1.length][s2.length];
    let maxLength = Math.max(s1.length, s2.length);
    return ((maxLength - distance) / maxLength) * 100;
}

// 5. OCR 텍스트 뭉치와 주변 상호명 리스트를 대조하여 80% 이상 유사한 최종 상호명 추출
export function findStoreNameFromOCR(rawOCRText, places) {
    let cleanOCR = rawOCRText.replace(/\s+/g, '');
    let bestMatch = null;
    let highestSim = 0;

    for (let place of places) {
        // 지점명 등 괄호 안 내용과 특수문자 제거
        let cleanPlace = place.replace(/\(.*?\)/g, '').replace(/[^\w가-힣]/g, '');
        if (cleanPlace.length < 2) continue;
        
        // 방법 1: OCR 전체 텍스트 안에 정답지 상호가 그대로 포함된 경우 (100% 매칭)
        if (cleanOCR.includes(cleanPlace)) {
            return place; 
        }

        // 방법 2: 줄 단위로 쪼개어 유사도가 80% 이상인지 검증
        let lines = rawOCRText.split(/\n/);
        for (let line of lines) {
            let cleanLine = line.replace(/[^\w가-힣]/g, '');
            if(cleanLine.length < 2) continue;
            
            let sim = getSimilarity(cleanPlace, cleanLine);
            if (sim > highestSim && sim >= 80) {
                highestSim = sim;
                bestMatch = place;
            }
        }
    }
    return bestMatch;
}