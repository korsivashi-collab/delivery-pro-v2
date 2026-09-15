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

// 🌟 [2단계] 사용자 지정 5대 앵커 기반 인접 데이터 필터링 엔진
function runAdjacentAnchorStage2(fullText) {
    try {
        let tokens = fullText.split(/[\s\n]+/);
        
        // 선생님이 지정하신 핵심 필터링 5대 단어 및 확장 키워드 앵커
        const targetAnchors = ['상호', '법인', '간판', '가게', '배송', '상호명', '간판명', '배송지명', '업체명'];
        const skips = ['연락처', '전화번호', '주소', '구매자명', '사업자등록번호', '공급가액', '세액', '단가', '수량', '총액', '성명', '대표자'];

        for (let i = 0; i < tokens.length; i++) {
            let cleanTok = tokens[i].replace(/[^\w가-힣]/g, '');
            
            // 1. 5대 핵심 앵커 단어가 인식되면 수직/해당 라인은 차단하고 우측(바로 다음 토큰) 정보 공략
            if (targetAnchors.some(anchor => cleanTok.includes(anchor))) {
                
                // 바로 붙어 있는 인접 데이터(오른쪽) 수집 시도 (최대 2개 토큰까지 연속 확인)
                let extractedWords = [];
                for (let j = i + 1; j <= Math.min(i + 2, tokens.length - 1); j++) {
                    let candidate = tokens[j].replace(/^[|:;()\[\]{}]+|[|:;()\[\]{}]+$/g, '').trim();
                    if (!candidate) continue;

                    // 2. [네거티브 필터 규칙 적용]
                    // - 숫자만 있는 경우 출력 불가 판정 (제외)
                    if (/^\d+$/.test(candidate)) break; 
                    // - 주소 관련 행정구역 파편(시, 구, 동, 로, 길 등)이 인식되면 해당 부분 출력 불가 판정 (제외)
                    if (/시$|구$|군$|동$|읍$|면$|로$|길$|층$|호$/.test(candidate) && !candidate.includes('점') && !candidate.includes('식당')) break;
                    // - 지역명 포함 시 제외
                    if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주)/.test(candidate)) break;
                    // - 금지(스킵) 단어 포함 시 제외
                    if (skips.some(skw => candidate.includes(skw))) break;
                    // - 글자수가 너무 짧으면(1글자) 무시
                    if (candidate.length < 2) continue;

                    extractedWords.push(candidate);
                }

                if (extractedWords.length > 0) {
                    let finalResult = extractedWords.join(' ').replace(/[^\w가-힣\s]/g, '').trim();
                    if (finalResult.length >= 2) return finalResult;
                }
            }
        }
    } catch (e) {
        console.error("2단계 인접 앵커 추출 오류:", e);
    }
    return null;
}

// 4. 🌟 최종 컨트롤러
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    
    // [1차 시도] 기존 키워드 정밀 탐색
    let stage1Result = runBalancedStage1(fullText);
    if (stage1Result) return stage1Result;

    // [2차 시도] 5대 핵심 앵커(상호, 법인, 간판, 가게, 배송) 기반 인접 데이터 추출 및 필터링
    let stage2Result = runAdjacentAnchorStage2(fullText);
    if (stage2Result) return stage2Result;

    return null;
}