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

// 2. OCR 텍스트에서 전화번호 추출 로직 (기존 유지)
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
    
    const repRegex = /(1[5-9]\d{2})[\s\-\.]*(\d{4})/g;
    const repMatches = [...text.matchAll(repRegex)];
    for (let m of repMatches) candidates.push(m[0].replace(/[^\d]/g, ''));
    
    candidates = [...new Set(candidates)];
    
    let bestPhone = null; 
    let highestScore = -1;
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

// 🌟 [2단계] 거래명세표(표 양식) 특화 어드밴스드 폴백 (새로운 설계)
function runStage2_AdvancedHeuristics(fullText, addressStr) {
    try {
        let lines = fullText.split('\n').map(l => l.trim()).filter(l => l);
        let tokens = fullText.split(/[\s\n]+/);

        // [전략 1] 표 양식에서 '배송지명'이나 '간판명' 라벨 직접 공략
        for (let i = 0; i < lines.length; i++) {
            if (/(배송지명|간판명)/.test(lines[i])) {
                let inlineVal = lines[i].replace(/.*(배송지명|간판명)[^\w가-힣]*/, '').trim();
                inlineVal = inlineVal.replace(/[^\w가-힣\s]/g, '').trim();
                if (inlineVal.length >= 2 && !/^\d+$/.test(inlineVal)) return inlineVal;

                if (i + 1 < lines.length) {
                    let nextLineVal = lines[i+1].replace(/[^\w가-힣\s]/g, '').trim();
                    if (nextLineVal.length >= 2 && !/^\d+$/.test(nextLineVal) && !/주소|업태|종목|성명/.test(nextLineVal)) {
                        return nextLineVal.split(/\s+/)[0]; 
                    }
                }
            }
        }

        // [전략 2] 사업자등록번호 앵커 (이미지 2번 한촌설렁탕, 3번 엄마손 맛집 대응)
        // OCR이 표를 어떻게 읽었든 '000-00-00000' 형태 뒤에는 무조건 상호나 대표자명이 옴
        for (let i = 0; i < tokens.length; i++) {
            if (/^\d{3}-?\d{2}-?\d{5}$/.test(tokens[i])) {
                for (let j = i + 1; j <= i + 3 && j < tokens.length; j++) {
                    let nextTok = tokens[j].replace(/[^\w가-힣]/g, '');
                    if (nextTok.length >= 2 && !/^\d+$/.test(nextTok)) {
                        // 명백한 식당/기업 키워드가 있으면 확정
                        if (/(식당|맛집|점|가|집|향|주식회사|유통|물류|상사|상회|농산|농원|농장|마트|에프앤비)$/.test(nextTok) || tokens.slice(j, j+2).join('').includes('맛집')) {
                            let combined = tokens[j];
                            if (j + 1 < tokens.length && !/^\d/.test(tokens[j+1]) && !/^(성명|대표자|주소)/.test(tokens[j+1])) {
                                combined += ' ' + tokens[j+1]; // "엄마손" + "맛집" 등 띄어쓰기 결합
                            }
                            return combined.replace(/[^\w가-힣\s]/g, '').trim();
                        }
                        // 이름보다는 상호명에 가까운 길이 (4글자 이상)
                        if (nextTok.length >= 4 && !/^(서울특별시|경기도|인천광역시)/.test(nextTok)) {
                            return nextTok;
                        }
                    }
                }
            }
        }

        // [전략 3] 주소 라인 꼬리표 절단 (이미지 4, 5, 6, 7번 완벽 대응)
        // "[07008] 서울 동작구 동작대로27다길 11 (사당동) 1층 쭈꾸미도사" -> 주소, 층수 날리고 "쭈꾸미도사"만 발라냄
        if (addressStr) {
            // 구, 도로명 위주로 해당 라인 찾기
            let addrCore = addressStr.split(/\s+/).slice(1, 4).join(' '); 
            if (addrCore.length < 3) addrCore = addressStr.substring(0, 10);

            let targetLine = lines.find(l => l.replace(/\s+/g, '').includes(addrCore.replace(/\s+/g, '')));

            if (targetLine) {
                let tail = targetLine;
                
                // 1. 도로명/지번 주소 몸통 날리기 (숫자 번지수까지)
                tail = tail.replace(/(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\d]+(?:로|길|대로|동|읍|면|리)\s*\d+(?:-\d+)?/g, '');
                // 2. 우편번호, 괄호 안의 동/빌딩명 날리기 ([04087], (사당동) 등)
                tail = tail.replace(/\[\d{5}\]|\(\d{5}\)/g, ''); 
                tail = tail.replace(/^\s*\d{5}\s*/g, ''); 
                tail = tail.replace(/\([가-힣\s\d,]+\)/g, ''); 
                tail = tail.replace(/\b[가-힣]{2,3}동\b/g, ''); // 괄호 없이 적힌 '사당동' 같은 행정동 처리
                // 3. 층수 표시 날리기 (1층, 지하1층, B1층 등)
                tail = tail.replace(/(?:지하|B|F)?\s*\d+\s*층/g, ''); 
                // 4. 남은 특수문자 정리
                tail = tail.replace(/[^\w가-힣\s]/g, '').trim();
                
                // 찌꺼기를 다 날리고 2글자 이상 남았다면 99% 꼬리표 상호명
                if (tail.length >= 2 && !/^(주소|사업장|소재지|빌딩|상가)$/.test(tail)) {
                    return tail;
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

    // [2차 시도] 거래명세표 전용 어드밴스드 폴백 (사업자번호 앵커 + 주소 꼬리표 절단)
    let matchedAddrStr = extractAddressLogic(fullText); // 2차 방식에서 주소 꼬리표를 찾기 위해 주소 결과 전달
    let stage2Result = runStage2_AdvancedHeuristics(fullText, matchedAddrStr);
    if (stage2Result) return stage2Result;

    return null;
}