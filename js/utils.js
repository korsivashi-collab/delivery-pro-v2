// js/utils.js

// 1. 클라이언트단 사진 안전 압축 (기존 유지)
export function toBase64_SafeCompress(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image(); 
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 1600; 
                let width = img.width, height = img.height;
                if (width > height) { 
                    if (width > MAX_SIZE) { height *= MAX_SIZE / width; width = MAX_SIZE; } 
                } else { 
                    if (height > MAX_SIZE) { width *= MAX_SIZE / height; height = MAX_SIZE; } 
                }
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d'); 
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.85)); 
            };
            img.onerror = (e) => reject(e);
        };
        reader.onerror = error => reject(error);
    });
}

// 2. 전화번호 추출 로직 (기존 유지)
export function extractPhoneLogic(text) {
    if (!text) return null;
    let candidates = [];
    const tokens = text.split(/[\s\n,;|]+/);
    for (let token of tokens) {
        let digits = token.replace(/[^\d]/g, '');
        if (digits.length >= 8 && digits.length <= 12) candidates.push(digits);
    }
    const phoneRegex = /(010|050\d|070|0[2-9][0-9]?|1[5-9]\d{2})[\s\-\.]*(\d{3,4})[\s\-\.]*(\d{4})/g;
    const rawMatches = [...text.matchAll(phoneRegex)];
    for (let m of rawMatches) candidates.push(m[0].replace(/[^\d]/g, ''));
    
    candidates = [...new Set(candidates)];
    let bestPhone = null; let highestScore = -1;
    for (let num of candidates) {
        let score = 0;
        let is010 = num.startsWith('010') && (num.length === 10 || num.length === 11);
        let is050 = num.startsWith('050') && (num.length === 11 || num.length === 12);
        let isRep = /^1[5-9]\d{6}$/.test(num); 
        if (is010) score += 100; else if (is050) score += 90; else if (isRep) score += 70; else score -= 100; 
        if (score > highestScore && score > 0) { highestScore = score; bestPhone = num; }
    }
    if (bestPhone) {
        let p = bestPhone;
        if (p.length === 11) return p.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
        if (p.length === 10) return p.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
        return p;
    }
    return null;
}

// 3. 스마트 주소 추출 로직 (기존 유지)
export function extractAddressLogic(text) {
    if (!text || typeof text !== 'string') return null;
    try {
        let flatText = text.replace(/\n/g, ' ').replace(/\s+/g, ' ');
        let regionPrefixedRegex = /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도|시)?\s+[가-힣\s]+(?:구|군|시)\s+[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면|리)\s*\d+(?:-\d+)?(?:\s*,\s*\([가-힣\s]+\))?)/g;
        let matches = [...flatText.matchAll(regionPrefixedRegex)];
        if (matches && matches.length > 0) {
            return matches[matches.length - 1][0].trim().replace(/\s+/g, ' ');
        }
    } catch (e) {} 
    return null;
}

// 🌟 [1단계] 기존에 안정적으로 작동하던 정밀 키워드 탐색 엔진
function runBalancedStage1(fullText) {
    try {
        let tokens = fullText.split(/[\s\n]+/);
        let badWords = new Set();
        for (let i = 0; i < tokens.length; i++) {
            let cleanT = tokens[i].replace(/[^\w가-힣]/g, '');
            if (/^\d{10}$/.test(cleanT) && tokens[i+1]) badWords.add(tokens[i+1].replace(/[^\w가-힣]/g, ''));
            if (/구매자명|성명/.test(cleanT) && tokens[i+1]) badWords.add(tokens[i+1].replace(/[^\w가-힣]/g, ''));
        }

        const targets = ['배송지명', '간판명', '상호명', '상호', '업체명', '법인명'];
        const skips = ['연락처', '전화번호', '주소', '구매자명', '사업자등록번호', '공급가액', '세액', '단가', '수량', '공급받는자', '총액'];

        const isJunk = (rawStr) => {
            let s = rawStr.replace(/[^\w가-힣]/g, ''); 
            if (!s || s.length < 2) return true; 
            if (/^\d+$/.test(s) || /^0[1-9]\d{6,}/.test(s)) return true; 
            if (badWords.has(s)) return true; 
            if (/시$|구$|군$|동$|읍$|면$|로$|길$|층$/.test(s) && !s.includes('점')) return true; 
            if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주)/.test(s)) return true;
            if (rawStr.includes('[') || rawStr.includes(']')) return true; 
            return false;
        };

        for (let i = 0; i < tokens.length; i++) {
            if (targets.some(kw => tokens[i].includes(kw))) {
                let collected = [];
                for (let j = i + 1; j < Math.min(i + 15, tokens.length); j++) {
                    let tok = tokens[j];
                    if (skips.some(skw => tok.includes(skw))) {
                        if (collected.length > 0) break; 
                        continue; 
                    }
                    if (isJunk(tok)) continue; 
                    if (j + 1 < tokens.length) {
                        let nextClean = tokens[j+1].replace(/[^\w가-힣]/g, '');
                        if (/시$|구$|군$|동$|읍$|면$|로$|길$/.test(nextClean) && !nextClean.includes('점')) continue;
                    }
                    collected.push(tok.replace(/[^\w가-힣]/g, ''));
                }
                if (collected.length > 0) {
                    let unique = [...new Set(collected)];
                    let result = unique.join(' ').replace(/간판명|배송지명|상호명|상호|업체명|법인명/g, '').trim();
                    if (result.length >= 2) return result;
                }
            }
        }
    } catch (e) {}
    return null;
}

// 🌟 [2단계] 연쇄 우측 탐색 및 엄격한 인접 밀착 네거티브 필터링 엔진
function runStrictAdjacentRightStage2(fullText) {
    try {
        let lines = fullText.split(/\n/);
        
        // 선생님이 지정하신 5대 기준 키워드 (상호, 법인, 간판, 가게, 배송) 및 유의어
        const primaryAnchors = ['상호', '법인', '간판', '가게', '배송', '상호명', '간판명', '배송지명', '업체명'];
        const skips = ['연락처', '전화번호', '주소', '구매자명', '사업자등록번호', '공급가액', '세액', '단가', '수량', '총액', '성명', '대표자'];

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            let lineTokens = lines[lineIdx].split(/[\s,;|]+/).map(t => t.trim()).filter(t => t);
            
            for (let tokIdx = 0; tokIdx < lineTokens.length; tokIdx++) {
                let cleanTok = lineTokens[tokIdx].replace(/[^\w가-힣]/g, '');

                // 1. 5대 키워드 중 하나가 인식된 경우
                if (primaryAnchors.some(anchor => cleanTok.includes(anchor))) {
                    
                    // [요청 반영] 세로(라인) 영역은 완전히 배제하고, 인식된 단어의 '우측' 토큰들만 정밀 탐색 시작
                    let adjacentWords = [];
                    
                    // 바로 우측에 붙어 있는 최대 2개의 토큰만 엄격하게 검사
                    for (let r = tokIdx + 1; r <= Math.min(tokIdx + 2, lineTokens.length - 1); r++) {
                        let rightCandidate = lineTokens[r].replace(/^[|:;()\[\]{}]+|[|:;()\[\]{}]+$/g, '').trim();
                        if (!rightCandidate) continue;

                        let cleanCandidate = rightCandidate.replace(/[^\w가-힣]/g, '');

                        // 2. [엄격한 네거티브 필터링 규칙]
                        // - 숫자만 있는 경우 (출력 불가 판정 및 즉시 중단)
                        if (/^\d+$/.test(cleanCandidate)) break;
                        // - 주소 관련 행정구역 파편(시, 구, 동, 읍, 면, 로, 길, 층, 호 등)이 인식되면 즉시 차단
                        if (/시$|구$|군$|동$|읍$|면$|로$|길$|층$|호$/.test(cleanCandidate) && !cleanCandidate.includes('점') && !cleanCandidate.includes('식당')) break;
                        // - 지역명 포함 시 차단
                        if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주)/.test(cleanCandidate)) break;
                        // - 스킵 키워드 포함 시 차단
                        if (skips.some(skw => cleanCandidate.includes(skw))) break;
                        // - 1글자 미만 무시
                        if (cleanCandidate.length < 2) continue;

                        adjacentWords.push(cleanCandidate);
                    }

                    // 만약 바로 우측에서 조건을 통과한 순수 밀착 정보가 있다면 최종 확정
                    if (adjacentWords.length > 0) {
                        let finalResult = adjacentWords.join(' ').trim();
                        if (finalResult.length >= 2) return finalResult;
                    }
                }
            }
        }
    } catch (e) {
        console.error("2단계 우측 밀착 탐색 오류:", e);
    }
    return null;
}

// 4. 🌟 최종 컨트롤러
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    
    // [1차 시도] 기존 키워드 정밀 탐색
    let stage1Result = runBalancedStage1(fullText);
    if (stage1Result) return stage1Result;

    // [2차 시도] 연쇄 우측 탐색 및 엄격한 인접 밀착 네거티브 필터링
    let stage2Result = runStrictAdjacentRightStage2(fullText);
    if (stage2Result) return stage2Result;

    return null;
}