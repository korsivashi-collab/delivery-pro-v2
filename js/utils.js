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

// 3. 스마트 주소 추출 로직 (유지)
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

// 4. 🌟 고도화된 상호 추출 로직 (구매자명/성명 차단 및 찌꺼기 제거 완성본)
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;

    try {
        let flatText = fullText.replace(/[\n\t\r]+/g, ' ').replace(/\s{2,}/g, ' ');

        // 1. 주소 영역 도려내기
        let detectedAddress = extractAddressLogic(fullText);
        if (detectedAddress) {
            flatText = flatText.replace(detectedAddress, ' ');
        }

        // 2. 출력되면 안 되는 노이즈 필터 단어 및 구매자명/성명 계열 강력 차단
        // 구매자명 뒤에 오는 이름까지 통째로 날려버리도록 패턴 적용
        flatText = flatText.replace(/(?:구매자명|성명|이름|대표|연락처|전화번호|TEL|FAX|사업자등록번호|공급받는자|공급자|단가|수량|금액|합계|잔액|세액|종목|업태)[\s\:\-\|]*[가-힣a-zA-Z0-9]*/gi, ' ');

        // 3. 순수 숫자 및 전화번호 형태 토큰 제거
        let tokens = flatText.split(' ');
        let cleanedTokens = [];
        
        for (let token of tokens) {
            let cleanToken = token.replace(/^[|:;()\[\]{}]+|[|:;()\[\]{}]+$/g, '').trim();
            if (!cleanToken) continue;

            if (/^[\d\-,.]+$/.test(cleanToken)) continue;
            if (cleanToken.includes('010') || cleanToken.includes('02-') || cleanToken.includes('031-')) continue;
            if (cleanToken.toLowerCase() === 'el' || cleanToken.toLowerCase() === 'el:') continue;

            cleanedTokens.push(cleanToken);
        }

        let processedText = cleanedTokens.join(' ');

        // 4. 상호/간판/배송지 키워드 탐색 후 뒷내용 추출
        const filterKeywords = ['상호', '법인', '간판', '배송지', '업체명'];
        const stopWords = ['성명', '이름', '대표', '주소', '연락처', '전화', '금액', '합계', '잔액', '구매자명'];

        for (let kw of filterKeywords) {
            let kwIndex = processedText.indexOf(kw);
            if (kwIndex !== -1) {
                let subStr = processedText.substring(kwIndex + kw.length).trim();
                subStr = subStr.replace(/^[:;|\-\s]+/, '').trim();

                let subTokens = subStr.split(' ');
                let finalCollected = [];

                for (let st of subTokens) {
                    if (filterKeywords.some(fk => st.includes(fk)) || stopWords.some(sw => st.includes(sw))) {
                        break;
                    }
                    if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/.test(st)) {
                        break;
                    }

                    finalCollected.push(st);
                    if (finalCollected.length >= 4) break; 
                }

                if (finalCollected.length > 0) {
                    let result = finalCollected.join(' ').trim();
                    result = result.replace(/^[\]) :;|]+|[\[( :;|]+$/g, '').trim();

                    if (result.length >= 2 && result !== '(주)' && result !== '주식회사' && !/^[\d\-,.]+$/.test(result)) {
                        return result;
                    }
                }
            }
        }
    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    
    return null;
}