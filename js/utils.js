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

// 4. 🌟 거래명세서/영수증 표(테이블) 구조 맞춤형 스마트 추출 로직
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;

    try {
        // 1. OCR 인식 시 발생할 수 있는 띄어쓰기 오차 보정
        let normalizedText = fullText.replace(/상\s+호/g, '상호')
                                     .replace(/법\s+인\s+명/g, '법인명')
                                     .replace(/배\s+송\s+지/g, '배송지')
                                     .replace(/간\s+판/g, '간판');

        // 2. 거래명세표 핵심 패턴 검색 (사진에 있는 "상호(법인명)" 패턴 정확히 타겟팅)
        // 설명: "상호(법인명)" 텍스트 뒤에 오는 문자열을 일단 길게 캡처합니다.
        let match = normalizedText.match(/(?:상호명?|법인명|간판명?|배송지명?)\s*(?:\([^)]*\))?\s*[:;|\-]?\s*([가-힣a-zA-Z0-9\s()]+)/);

        if (match && match[1]) {
            let candidate = match[1].trim();

            // 3. 추출된 블록에서 '표의 다음 칸' 데이터(성명, 잔액, TEL 등)가 섞여 있다면 그 직전까지만 스마트하게 잘라내기
            let tokens = candidate.split(/[\s\n]+/);
            let finalName = [];

            for (let token of tokens) {
                // 🌟 핵심 방어막: 표의 다음 컬럼이나 불필요한 정보가 시작되는 키워드가 나오면 멈춤!
                if (/성명|이름|대표|귀하|사업장|주소|종목|업태|등록번호|전화|TEL|잔액|금액/.test(token)) {
                    break; 
                }
                // 숫자만 있거나 단가/수량/전화번호 형태가 나오면 멈춤
                if (/^[0-9,]+$/.test(token)) break;
                if (/원$|개$|박스$|ea$|kg$|g$/i.test(token)) break;
                if (/^\d{2,3}-\d{3,4}-\d{4}$/.test(token)) break;

                finalName.push(token);

                // 상호명이 너무 비정상적으로 길어지는 것 방지 (보통 4어절 이내)
                if (finalName.length >= 4) break;
            }

            let result = finalName.join(' ').trim();
            
            // "(인)", "귀하" 등 영수증 찌꺼기 텍스트 한 번 더 청소
            result = result.replace(/\(인\)$|귀하$|대표자.*/g, '').trim();

            // 유효성 검사 (너무 짧거나 '주식회사' 같은 단어만 달랑 있으면 상호명이 아니라고 판단)
            if (result.length >= 2 && result !== '주식회사' && result !== '(주)') {
                return result;
            }
        }
    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    
    // 🌟 확실하지 않으면 억지로 이상한 단어(EL 등)를 넣느니, 깔끔하게 null을 반환하여 주소만 표기되게 함
    return null;
}