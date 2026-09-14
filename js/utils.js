// js/utils.js

// 1. 클라이언트단 사진 안전 압축 (왜곡 및 명암 필터 제거)
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

                canvas.width = width; 
                canvas.height = height;
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
        
        if (is010) score += 100; 
        else if (is050) score += 90; 
        else if (is070) score += 80;
        else if (isRep) score += 70; 
        else if (is02 || isLocal) score += 60; 
        else score -= 100; 
        
        if (/(\d)\1{4,}/.test(num)) score -= 50;
        if (score > highestScore && score > 0) { 
            highestScore = score; 
            bestPhone = num; 
        }
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

// 3. OCR 텍스트에서 주소 추출 로직 (기존 유지)
export function extractAddressLogic(text) {
    if (!text || typeof text !== 'string') return null;
    try {
        let flatText = text.replace(/\n/g, ' ').replace(/\s+/g, ' ');
        let regionPrefixedRegex = /((?:서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:도)?|충청북(?:도)?|충청남(?:도)?|전라북(?:도)?|전라남(?:도)?|경상북(?:도)?|경상남(?:도)?|제주(?:특별자치도)?)\s+[가-힣\s]+(?:구|군|시)\s+[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면)\s*\d+(?:-\d+)?(?:\s*,\s*\([가-힣]+\))?)/g;
        
        let matches = [...flatText.matchAll(regionPrefixedRegex)];
        if (matches && matches.length > 0) {
            return matches[matches.length - 1][0].trim().replace(/\s+/g, ' ');
        }

        let regex2 = /([가-힣a-zA-Z0-9\s,\-\(\)]+(?:동|읍|면|리|대로|로|길)\s*\d+(?:-\d+)?)/g;
        let matches2 = [...flatText.matchAll(regex2)];
        if (matches2 && matches2.length > 0) {
            let candidate = matches2[matches2.length - 1][0].trim();
            candidate = candidate.replace(/^.*?(사업장\s*주소|주소|소재지)\s*/i, '');
            if (candidate.length > 5) return candidate.replace(/\s+/g, ' ');
        }
    } catch (e) {} 
    return null;
}

// 4. 🌟 동적 블랙리스트 기반 상호명 추출 로직 (구매자명 필터링 추가)
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        let tokens = fullText.split(/[\s\n]+/);
        
        // 1. 동적 블랙리스트 생성: '구매자명'을 스캔하여 상호명 탐색 시 함정을 파놓음
        let dynamicBlacklist = [];
        for (let k = 0; k < tokens.length; k++) {
            let t = tokens[k].trim();
            let cleanT = t.replace(/[\(\)\[\]\,\-\.]/g, '').trim();
            
            // 패턴 A: 사업자번호(10자리 숫자) 바로 다음 토큰은 구매자명일 확률이 매우 높음
            if (/^\d{10}$/.test(cleanT) && k + 1 < tokens.length) {
                let nextT = tokens[k+1].replace(/[\(\)\[\]\,\-\.]/g, '').trim();
                if (nextT.length >= 2 && nextT.length <= 5 && !/^\d/.test(nextT)) {
                    dynamicBlacklist.push(nextT);
                }
            }
            // 패턴 B: '구매자명' 라벨 자체의 다음 토큰
            if ((t.includes('구매자명') || t.includes('성명')) && k + 1 < tokens.length) {
                let nextT = tokens[k+1].replace(/[\(\)\[\]\,\-\.]/g, '').trim();
                if (nextT.length >= 2 && nextT.length <= 5 && !/^\d/.test(nextT) && !nextT.includes('명')) {
                    dynamicBlacklist.push(nextT);
                }
            }
        }

        const targetKeywords = ['배송지명', '간판명', '상호명', '상호'];
        const skipLabels = ['연락처', '전화번호', '주소', '구매자명', '사업자등록번호', '공급가액', '세액', '합계', '단가', '수량', '공급받는자', '공급자', '보관용', '제조사', '원산지', '국내산', '총액', '비고'];

        // 주소나 쓸데없는 단어를 가려내는 함수 (블랙리스트에 잡힌 이름도 무시함)
        const isJunkOrAddress = (str) => {
            let s = str.replace(/[\(\)\[\]\,\-\.]/g, '').trim();
            if (/^\d+$/.test(s)) return true;
            if (/^010|^050|^070|^02|^0[3-9]\d/.test(s) && s.length >= 8) return true;
            // 지명 관련 오작동을 막기 위해 정확하게 분절된 행정구역만 스킵
            if (/^(서울특별시|서울시|서울|부산광역시|부산시|부산|대구광역시|대구시|대구|인천광역시|인천시|인천|광주광역시|광주시|광주|대전광역시|대전시|대전|울산광역시|울산시|울산|세종특별자치시|세종시|세종|경기도|경기|강원도|강원|충청북도|충북|충청남도|충남|전라북도|전북|전라남도|전남|경상북도|경북|경상남도|경남|제주도|제주)$/.test(s)) return true;
            if (/^[가-힣]+(시|구|군|동|읍|면|로|길)$/.test(s)) return true;
            if (/^\d+층$/.test(s) || /^\[\d{5}\]$/.test(s) || /^\(\d{5}\)$/.test(s)) return true;
            
            // 🌟 동적으로 찾아낸 구매자 이름(전규복 등)이면 쓰레기 데이터로 취급하고 건너뜀
            if (dynamicBlacklist.includes(s)) return true; 
            
            return false;
        };

        for (let i = 0; i < tokens.length; i++) {
            let isTarget = targetKeywords.some(kw => tokens[i].includes(kw));

            if (isTarget) {
                let collected = [];
                for (let j = i + 1; j < Math.min(i + 25, tokens.length); j++) {
                    let tok = tokens[j].trim();
                    if (!tok) continue;

                    let cleanTok = tok.replace(/[\(\)\[\]]/g, '');
                    let isSkipLabel = skipLabels.some(skw => cleanTok.includes(skw));
                    let isJunk = isJunkOrAddress(tok);

                    if (isSkipLabel || isJunk) {
                        if (collected.length === 0) continue; // 아직 유효한 단어를 못 찾았으면 계속 전진
                        else break; // 상호명을 수집하던 중에 라벨이나 전화번호를 만나면 수집 종료
                    }

                    collected.push(tok);
                }

                if (collected.length > 0) {
                    // 동일한 단어가 연속으로 인식되었을 때 깔끔하게 중복 제거 (예: 사브항 샤브항)
                    let unique = [];
                    collected.forEach(w => { if(unique[unique.length-1] !== w) unique.push(w); });
                    
                    let candidate = unique.join(' ').replace(/[\(\)\:\-\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
                    candidate = candidate.replace(/간판명|배송지명|상호명/g, '').trim();
                    if (candidate.length >= 2) {
                        return candidate;
                    }
                }
            }
        }
    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}