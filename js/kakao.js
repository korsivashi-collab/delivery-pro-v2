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

// 3. 주소 문자열 자체를 키워드로 검색하여 해당 주소지의 상가 목록을 정확히 가져오기
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

// 4. 주변 좌표 반경 기반 보조 검색
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

// 5. 레벤슈타인 거리 알고리즘 (문자열 편집 거리 반환)
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
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    return matrix[s1.length][s2.length];
}

// 🌟 [핵심 개선] 부분 문자열 슬라이딩 윈도우 매칭 방식
export function findStoreNameFromOCR(rawOCRText, places) {
    let cleanOCR = rawOCRText.replace(/\s+/g, ''); // 띄어쓰기 완전 제거된 원본
    let bestMatch = null;
    let highestSim = 0;

    for (let place of places) {
        // 정답지(카카오 상호)에서 (주), 유한회사, 괄호 속 지점명 등을 떼어내고 핵심 단어만 남김
        let cleanPlace = place.replace(/\(.*?\)/g, '').replace(/주식회사|유한회사/g, '').replace(/[^\w가-힣]/g, '');
        if (cleanPlace.length < 2) continue; // 상호가 너무 짧으면 패스
        
        // 1단계: 가장 빠르고 완벽한 완전 포함 여부 검사
        if (cleanOCR.includes(cleanPlace)) {
            return place; 
        }

        // 2단계: 줄바꿈 무시하고 긴 텍스트 속에서 "부분 유사도(Sliding Window)" 검사
        // 예: OCR 원본이 "서울종로구종로40길18계림삼계탕홍대점1층" 처럼 뭉쳐있을 때
        // cleanPlace("계림삼계탕")의 길이만큼 창문을 이동시키며 가장 비슷한 덩어리를 찾음
        let ocrLines = rawOCRText.split(/\n/);
        
        for (let line of ocrLines) {
            let cleanLine = line.replace(/[^\w가-힣]/g, ''); // 특수문자, 띄어쓰기 제거
            if (cleanLine.length < cleanPlace.length) continue; // 줄이 상호보다 짧으면 비교 무의미

            // 슬라이딩 윈도우 방식으로 부분 문자열 추출하여 유사도 계산
            let targetLength = cleanPlace.length;
            for (let i = 0; i <= cleanLine.length - targetLength + 1; i++) { // +1은 오타(한 글자 삽입/삭제) 여유분
                for (let j = targetLength - 1; j <= targetLength + 1; j++) { // 창문 크기를 -1 ~ +1 글자로 유연하게 조절
                    let subStr = cleanLine.substring(i, i + j);
                    if (subStr.length < 2) continue;

                    let distance = getLevenshteinDistance(cleanPlace, subStr);
                    let maxLength = Math.max(cleanPlace.length, subStr.length);
                    let sim = ((maxLength - distance) / maxLength) * 100;

                    // 최고 유사도 갱신 (커트라인 80% 이상)
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