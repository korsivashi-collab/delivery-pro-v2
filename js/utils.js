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

// 4. 🌟 정확한 레이블(배송지명, 간판명 등) 뒤에 오는 실제 상호 데이터만 타겟팅하는 추출 로직
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        let tokens = fullText.split(/[\s\n]+/);
        
        // 상호/배송지명을 나타내는 핵심 타겟 레이블
        const targetKeywords = ['배송지명', '간판명', '상호명', '상호'];
        // 데이터 수집을 중단해야 하는 다른 항목의 레이블들
        const stopKeywords = ['연락처', '전화번호', '주소', '구매자명', '사업자등록번호', '공급가액', '세액', '합계', '단가', '수량'];

        for (let i = 0; i < tokens.length; i++) {
            let token = tokens[i].trim();
            let isTarget = targetKeywords.some(kw => token.includes(kw));

            if (isTarget) {
                let collected = [];
                // 타겟 레이블 바로 다음 토큰부터 최대 5개 단어 수집
                for (let j = i + 1; j < Math.min(i + 6, tokens.length); j++) {
                    let nextTok = tokens[j].trim();
                    if (!nextTok) continue;
                    // 다른 항목 레이블이나 전화번호, 주소 형태를 만나면 수집 중단
                    if (stopKeywords.some(skw => nextTok.includes(skw))) break;
                    if (/^010-|^\d{8,}|서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주/.test(nextTok)) break;
                    
                    collected.push(nextTok);
                }

                if (collected.length > 0) {
                    let candidate = collected.join(' ').replace(/[\(\)\:\-\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
                    candidate = candidate.replace(/간판명|배송지명/g, '').trim();
                    if (candidate.length >= 2) {
                        return candidate;
                    }
                }
            }
        }

        // 백업 라인 단위 검색
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        for (let line of lines) {
            if (line.includes('배송지명') || line.includes('간판명') || line.includes('상호')) {
                let cleaned = line
                    .replace(/.*(?:배송지명|간판명|상호명|상호)\s*[\(\)\:\-\s]*/, '')
                    .replace(/연락처|전화번호|주소|구매자명.*/g, '')
                    .replace(/[\(\)\:\-\[\]]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                
                if (cleaned.length >= 2 && !cleaned.includes('서울') && !cleaned.includes('마포구')) {
                    return cleaned;
                }
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}