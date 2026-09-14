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

// 4. 🌟 '스마트 스킵' 기반 상호명 추출 로직
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        const targetKeywords = ['배송지명', '간판명', '상호명', '상호'];
        // OCR이 뒤섞어놓는 불필요한 라벨(항목명) 필터링 목록 강화 ('공급받는자' 등 추가)
        const skipLabels = ['연락처', '전화번호', '주소', '구매자명', '사업자등록번호', '공급가액', '세액', '합계', '단가', '수량', '공급받는자', '공급자', '보관용', '제조사', '원산지', '국내산', '총액', '비고'];

        // 주소, 전화번호, 단순 숫자, 우편번호인지를 판별하여 무시하도록 돕는 헬퍼 함수
        const isJunkOrAddress = (str) => {
            let s = str.replace(/[\(\)\[\]\,\-\.]/g, '').trim();
            if (/^\d+$/.test(s)) return true; // 순수 숫자 (우편번호 등)
            if (/^010|^050|^070|^02|^0[3-9]\d/.test(s) && s.length >= 8) return true; // 전화번호 형태
            if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/.test(str)) return true; // 광역 지명
            if (/^[가-힣]+(시|구|군|동|읍|면|로|길)\b/.test(str) && !str.includes('점')) return true; // 주소 조각 (단, '역점', '수점' 같은 지점명 제외)
            if (/^\d+층$/.test(str) || /^\[\d{5}\]$/.test(str) || /^\(\d{5}\)$/.test(str)) return true; // 층수/우편번호
            return false;
        };

        let tokens = fullText.split(/[\s\n]+/);

        for (let i = 0; i < tokens.length; i++) {
            let isTarget = targetKeywords.some(kw => tokens[i].includes(kw));

            if (isTarget) {
                let collected = [];
                // 키워드 발견 후 최대 20개의 다음 단어들을 스캔 (OCR이 섞어둔 단어들을 넘어가기 위함)
                for (let j = i + 1; j < Math.min(i + 20, tokens.length); j++) {
                    let tok = tokens[j].trim();
                    if (!tok) continue;

                    let cleanTok = tok.replace(/[\(\)\[\]]/g, '');
                    let isSkipLabel = skipLabels.some(skw => cleanTok.includes(skw));
                    let isJunk = isJunkOrAddress(tok);

                    // 만약 쓸데없는 라벨(연락처 등)이나 숫자, 주소가 나오면
                    if (isSkipLabel || isJunk) {
                        if (collected.length === 0) {
                            // 1. 아직 진짜 상호명을 못 찾았다면? -> 그냥 무시하고 다음 단어로 전진 (이게 핵심입니다!)
                            continue;
                        } else {
                            // 2. 이미 상호명(예: 샤브항)을 찾고 있었는데 연락처가 나왔다? -> 수집 종료
                            break;
                        }
                    }

                    // 위 필터를 통과한 알짜배기 텍스트만 모음
                    collected.push(tok);
                }

                // 텍스트 정제 후 반환
                if (collected.length > 0) {
                    let candidate = collected.join(' ').replace(/[\(\)\:\-\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
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