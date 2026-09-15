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
    // ... (기존 코드와 동일하므로 생략 없이 원본 그대로 사용하시면 됩니다) ...
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
    const repRegex = /(1[5-9]\d{2})[\s\-\.]*(\d{4})/g;
    const repMatches = [...text.matchAll(repRegex)];
    for (let m of repMatches) candidates.push(m[0].replace(/[^\d]/g, ''));
    candidates = [...new Set(candidates)];
    
    let bestPhone = null; let highestScore = -1;
    for (let num of candidates) {
        let score = 0;
        let is010 = num.startsWith('010') && (num.length === 10 || num.length === 11);
        let is050 = num.startsWith('050') && (num.length === 11 || num.length === 12);
        let is070 = num.startsWith('070') && (num.length === 10 || num.length === 11);
        let isRep = /^1[5-9]\d{6}$/.test(num); 
        let is02 = num.startsWith('02') && (num.length === 9 || num.length === 10);
        let isLocal = /^0[3-9]\d/.test(num) && (num.length === 10 || num.length === 11);
        
        if (is010) score += 100; else if (is050) score += 90; else if (is070) score += 80;
        else if (isRep) score += 70; else if (is02 || isLocal) score += 60; else score -= 100; 
        if (/(\d)\1{4,}/.test(num)) score -= 50;
        
        if (score > highestScore && score > 0) { highestScore = score; bestPhone = num; }
    }
    if (bestPhone) {
        let p = bestPhone;
        if (p.startsWith('010') || p.startsWith('070') || /^0[3-9]\d/.test(p)) {
            if (p.length === 11) return p.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
            if (p.length === 10) return p.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
        }
        if (p.startsWith('050')) {
            if (p.length === 12) return p.replace(/(\d{4})(\d{4})(\d{4})/, '$1-$2-$3');
            if (p.length === 11) return p.replace(/(\d{4})(\d{3})(\d{4})/, '$1-$2-$3');
        }
        if (/^1[5-9]\d{6}$/.test(p)) return p.replace(/(\d{4})(\d{4})/, '$1-$2');
        if (p.startsWith('02')) {
            if (p.length === 9) return p.replace(/(\d{2})(\d{3})(\d{4})/, '$1-$2-$3');
            if (p.length === 10) return p.replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3');
        }
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
        let backupRegex = /((?:[가-힣a-zA-Z0-9]+\s+){1,4}[가-힣a-zA-Z0-9]+(?:동|읍|면|리|대로|로|길)\s*\d+(?:-\d+)?)/g;
        let matches2 = [...flatText.matchAll(backupRegex)];
        if (matches2 && matches2.length > 0) {
            let candidate = matches2[matches2.length - 1][0].trim();
            candidate = candidate.replace(/^.*?(사업장\s*주소|주소|소재지|책임판매원|판매원|제조원)\s*[\:\-]?\s*/i, '');
            if (candidate.length > 5) return candidate.replace(/\s+/g, ' ');
        }
    } catch (e) {} 
    return null;
}

// 🌟 [1단계] 명시적 라벨(키워드) 기반 정밀 추출 (기존 코드 완벽 유지)
function runStage1_KeywordMatch(fullText) {
    try {
        let tokens = fullText.split(/[\s\n]+/);
        let badWords = new Set();
        for (let i = 0; i < tokens.length; i++) {
            let cleanT = tokens[i].replace(/[^\w가-힣]/g, '');
            if (/^\d{10}$/.test(cleanT) && tokens[i+1]) badWords.add(tokens[i+1].replace(/[^\w가-힣]/g, ''));
            if (/구매자명|성명/.test(cleanT) && tokens[i+1]) badWords.add(tokens[i+1].replace(/[^\w가-힣]/g, ''));
        }
        const targets = ['배송지명', '간판명', '상호명', '상호'];
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
                    let result = unique.join(' ').replace(/간판명|배송지명|상호명|상호/g, '').trim();
                    if (result.length >= 2) return result;
                }
            }
        }
    } catch (e) {}
    return null;
}

// 🌟 [2단계] 명시적 라벨이 없을 때의 폴백 (접미사 및 주소 역추적)
function runStage2_HeuristicMatch(fullText) {
    try {
        let tokens = fullText.split(/[\s\n]+/);
        let flatText = fullText.replace(/\n/g, ' ').replace(/\s+/g, ' ');

        // [전략 A] 기업/상점 식별용 접미사 스캐닝 (토박이농산주식회사 등을 즉시 포획)
        const businessSuffixes = /(주식회사|\(주\)|유통|물류|상사|상회|농산|농업회사법인|영농조합|농원|농장|마트|상단|팩토리)$/;
        
        for (let t of tokens) {
            let cleanT = t.replace(/[^\w가-힣()]/g, '');
            if (cleanT.length >= 3 && businessSuffixes.test(cleanT)) {
                // 주소 파편이 섞여 들어오지 않도록 방어
                if (!/시$|구$|군$|동$|읍$|면$|로$|길$/.test(cleanT)) {
                    // '(주)'나 '주식회사' 같은 텍스트는 깔끔하게 제거할 수도 있지만, 원본 유지가 안전할 때가 많습니다.
                    return cleanT; 
                }
            }
        }

        // [전략 B] 추출된 주소를 기반으로 바로 앞 단어(어절) 역추적
        let extractedAddress = extractAddressLogic(fullText);
        if (extractedAddress) {
            // 주소의 첫 번째 덩어리(예: '강북구', '덕릉로')를 찾음
            let addrFirstWord = extractedAddress.split(/\s+/)[0]; 
            let addrIndex = flatText.indexOf(addrFirstWord);
            
            if (addrIndex > 0) {
                let precedingText = flatText.substring(0, addrIndex).trim();
                let precedingTokens = precedingText.split(/\s+/);
                
                // 주소 앞쪽에 있는 단어들을 뒤에서부터 확인하여 상호명 발굴
                for (let i = precedingTokens.length - 1; i >= 0; i--) {
                    let candidate = precedingTokens[i].replace(/[^\w가-힣]/g, '');
                    // OCR 오타(예: '울')나 불필요한 예약어 패스
                    if (candidate.length >= 2 && !/^(보내는분|발송인|수신인|받는분|주소|전화|연락처|서울|경기|인천)$/.test(candidate)) {
                         return candidate;
                    }
                }
            }
        }
    } catch (e) {
        console.error("2차 상호 추출 오류:", e);
    }
    return null;
}

// 4. 🌟 최종 컨트롤러
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    
    // [1차 시도] 라벨(상호명:)이 존재하는 깔끔한 포맷
    let stage1Result = runStage1_KeywordMatch(fullText);
    if (stage1Result) return stage1Result;

    // [2차 시도] 라벨 없이 [상호명 + 주소] 형태로 붙어있는 불규칙 포맷
    let stage2Result = runStage2_HeuristicMatch(fullText);
    if (stage2Result) return stage2Result;

    return null;
}