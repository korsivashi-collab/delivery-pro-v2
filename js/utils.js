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

// 4. 🌟 표(테이블) 양식 최적화 스마트 상호 추출 로직 (강력한 정지 단어 필터 적용)
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;

    try {
        // 1. 방해되는 괄호 키워드 사전 제거 (상호명 추출을 쉽게 만들기 위함)
        let normalized = fullText.replace(/\(간판명?\)/g, '')
                                 .replace(/\(법인명?\)/g, '')
                                 .replace(/상\s+호/g, '상호')
                                 .replace(/배\s+송\s+지/g, '배송지')
                                 .replace(/간\s+판/g, '간판');

        let tokens = normalized.split(/[\s\n,;|]+/);

        const keywords = ['상호', '법인명', '간판명', '간판', '배송지명', '배송지'];
        
        // 🌟 정밀한 정지(Stop) 키워드 목록 ('연락처', '공급받는자' 등 표의 다음 칸을 의미하는 단어들 추가)
        const stopWords = ['성명', '이름', '대표', '귀하', '사업장', '주소', '소재지', '종목', '업태', '등록번호', '전화', '연락처', 'tel', '잔액', '금액', '공급받는자', '공급자', '공급가액', '단가', '수량', '세액', '비고', '합계', '영수', '청구', '품목', '품명', '규격'];

        for (let i = 0; i < tokens.length; i++) {
            let token = tokens[i];
            // 타겟 키워드(예: 배송지명, 상호)를 발견하면
            if (keywords.some(kw => token.includes(kw))) {
                let collected = [];
                // 타겟 단어 우측으로 글자들을 하나씩 검사하며 수집
                for (let j = i + 1; j < Math.min(i + 12, tokens.length); j++) {
                    let nextToken = tokens[j];

                    // 콜론(:)이나 파이프(|) 같은 시작 특수문자만 부드럽게 제거 ((주) 같은 괄호는 살려둠)
                    let cleanToken = nextToken.replace(/^[|:;]+|[|:;]+$/g, '').trim();
                    if (!cleanToken) continue;

                    // 자기 자신이 키워드이거나 의미없는 '명' 이면 건너뜀
                    if (keywords.some(kw => cleanToken.includes(kw)) || cleanToken === '명') continue;

                    // 🛑 핵심 로직: 스톱 워드(예: 연락처, 성명)를 만나면 그 즉시 수집 중단!
                    if (stopWords.some(sw => cleanToken.toLowerCase().includes(sw))) {
                        break;
                    }

                    // 숫자만 있거나, 전화번호, 금액 형식이면 중단
                    if (/^[\d\-,.]+$/.test(cleanToken)) break;
                    if (/[0-9]+(?:원|개|박스|ea|kg|g|l|ml)$/i.test(cleanToken)) break;

                    // 주소 형태가 튀어나오면 중단 (단, '점'으로 끝나는 건 지점명이므로 정상 수집)
                    let textForAddrCheck = cleanToken.replace(/[^\w가-힣]/g, '');
                    if (/(시|구|군|동|읍|면|로|길|층)$/.test(textForAddrCheck) && !textForAddrCheck.endsWith('점')) {
                        if (collected.length > 0) break; // 이미 수집된 게 있으면 주소 앞에서 멈춤
                        else continue;
                    }

                    collected.push(cleanToken);
                }

                if (collected.length > 0) {
                    let finalName = collected.join(' ');
                    // 찌꺼기 문자(닫는 괄호 등) 한 번 더 정리
                    finalName = finalName.replace(/^[-)\]}]+|[-)\]}]+$/g, '').trim();

                    // 유효성 검사 (너무 짧거나 '주식회사' 같은 단어만 달랑 있으면 상호명이 아니라고 판단)
                    if (finalName.length >= 2 && finalName !== '주식회사' && finalName !== '(주)') {
                        return finalName;
                    }
                }
            }
        }
    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    
    return null;
}