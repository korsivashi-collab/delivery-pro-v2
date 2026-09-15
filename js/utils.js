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

// 4. 🌟 표 형태 완벽 대응 정규식 기반 상호 추출 (기사님의 좌표 제한 아이디어 모방)
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;

    try {
        // 1. 모든 줄바꿈을 공백으로 펴서 좌표가 깨져도 같은 줄처럼 인식하게 만듦
        let text = fullText.replace(/\n/g, ' ');

        // 2. 표 형태를 정규식으로 직접 캡처 (가장 우선순위 높음)
        // 형식: "상호(법인명) [추출할 타겟] 성명" 형태에서 [추출할 타겟]만 뽑아냄
        const tablePatterns = [
            // 뒤에 성명, 주소, 연락처, 공급받는자 등의 표 헤더가 오는 경우 (여기서 강제 차단됨)
            /(?:상호명?|법인명|간판명?|배송지명?)\s*(?:\([^)]*\))?\s*[:;|\-]?\s*([가-힣a-zA-Z0-9\s()]+?)\s+(?:성명|이름|대표|주소|소재지|연락처|전화|TEL|종목|업태|등록번호|공급받는자|공급자)/i,
            
            // 뒤에 표 헤더 없이 바로 전화번호나 금액 숫자가 오는 경우
            /(?:상호명?|법인명|간판명?|배송지명?)\s*(?:\([^)]*\))?\s*[:;|\-]?\s*([가-힣a-zA-Z0-9\s()]+?)\s+(?:010|02|031|050|\d{3}-\d{4}|\d{1,3},\d{3})/i
        ];

        for (let pattern of tablePatterns) {
            let match = text.match(pattern);
            if (match && match[1]) {
                let result = match[1].trim();
                
                // 혹시라도 묻어들어온 찌꺼기 강제 삭제
                result = result.replace(/귀하$|\(인\)$|연락처$|공급받는자$/g, '').trim();
                
                if (result.length >= 2 && result !== '주식회사' && result !== '(주)') {
                    return result;
                }
            }
        }

        // 3. 만약 위 패턴에 안 걸리면, 기존처럼 단어 단위로 검사하되 브레이크(Stop) 기준을 대폭 강화
        let tokens = text.split(/\s+/);
        const keywords = ['상호', '법인명', '간판', '배송지'];
        // 기사님이 우려하신 '뒷부분'에 해당하는 단어들 (여기서 멈춤)
        const stopWords = ['성명', '이름', '대표', '주소', '소재지', '연락처', '전화', 'TEL', '공급받는자', '공급자', '수량', '단가', '금액', '합계', '종목', '업태'];

        for (let i = 0; i < tokens.length; i++) {
            if (keywords.some(kw => tokens[i].includes(kw))) {
                let collected = [];
                for (let j = i + 1; j < Math.min(i + 15, tokens.length); j++) {
                    let token = tokens[j];
                    
                    if (keywords.some(kw => token.includes(kw))) continue;

                    // 🛑 스톱워드가 포함된 단어(연락처, 공급받는자 등)를 만나면 즉시 수집 중단!
                    if (stopWords.some(sw => token.includes(sw))) break;

                    // 숫자만 있거나, 전화번호 형태면 중단
                    if (/^[\d\-,.]+$/.test(token) || token.includes('010')) break;

                    collected.push(token);
                }

                if (collected.length > 0) {
                    let result = collected.join(' ').replace(/귀하$|\(인\)$|연락처$|공급받는자$/g, '').trim();
                    if (result.length >= 2 && result !== '(주)' && result !== '주식회사') return result;
                }
            }
        }
    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    
    return null;
}