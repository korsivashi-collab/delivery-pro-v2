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

// 4. 🌟 기사님 제안 반영 "일렬 배치 후 노이즈/주소 도려내기 및 필터링 출력 방식"
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;

    try {
        // 1. 인식된 모든 단어를 순서대로 한 줄에 공백으로 배치 (일렬 정렬)
        let flatText = fullText.replace(/[\n\t\r]+/g, ' ').replace(/\s{2,}/g, ' ');

        // 2. 주소 영역을 먼저 파악해서 텍스트에서 완전히 도려냄 (주소 간섭 원천 차단)
        let detectedAddress = extractAddressLogic(fullText);
        if (detectedAddress) {
            flatText = flatText.replace(detectedAddress, ' [주소제외] ');
        }

        // 3. 성명, 전화번호, 공급받는자 등 출력되면 안 되는 필터/노이즈 정보들 철저히 제거
        // 정규식을 이용해 불필요한 패턴들을 공백으로 치환
        flatText = flatText.replace(/(?:성명|이름|대표|연락처|전화번호|TEL|FAX|사업자등록번호|구매자명|공급받는자|공급자|단가|수량|금액|합계|잔액|세액|종목|업태)[\s\:\-\|]*/gi, ' [노이즈제외] ');

        // 4. 순수 숫자만 있는 단어 제거 (단, 글자 내부에 숫자가 섞인 상호는 허용하기 위해 단어별로 검사)
        let tokens = flatText.split(' ');
        let cleanedTokens = [];
        
        for (let token of tokens) {
            let cleanToken = token.replace(/^[|:;()\[\]{}]+|[|:;()\[\]{}]+$/g, '').trim();
            if (!cleanToken) continue;

            // 순수 숫자 및 콤마/하이픈 조합인 경우 (예: 528,000, 0, 101-12) 노이즈로 간주하고 제외
            if (/^[\d\-,.]+$/.test(cleanToken)) {
                continue;
            }
            // 전화번호 형태 제외
            if (cleanToken.includes('010') || cleanToken.includes('02-') || cleanToken.includes('031-')) {
                continue;
            }

            cleanedTokens.push(cleanToken);
        }

        // 5. 정제된 단어들을 다시 한 줄 문장으로 결합
        let processedText = cleanedTokens.join(' ');

        // 6. 필터링 대상 단어(상호, 간판, 배송지 등) 탐색 후 뒤에 남은 내용 추출
        const filterKeywords = ['상호', '법인', '간판', '배송지', '업체명'];
        const stopWords = ['성명', '대표', '주소', '연락처', '전화', '금액', '합계', '잔액'];

        for (let kw of filterKeywords) {
            let kwIndex = processedText.indexOf(kw);
            if (kwIndex !== -1) {
                // 키워드 발견 시, 그 키워드 이후의 텍스트를 잘라냄
                let subStr = processedText.substring(kwIndex + kw.length).trim();
                
                // 불필요한 기호나 콜론 제거
                subStr = subStr.replace(/^[:;|\-\s]+/, '').trim();

                let subTokens = subStr.split(' ');
                let finalCollected = [];

                for (let st of subTokens) {
                    // 또 다른 필터 단어나 스톱워드를 만나면 중단
                    if (filterKeywords.some(fk => st.includes(fk)) || stopWords.some(sw => st.includes(sw))) {
                        break;
                    }
                    // 주소 파편이 섞여 들어오면 중단
                    if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/.test(st)) {
                        break;
                    }

                    finalCollected.push(st);
                    if (finalCollected.length >= 4) break; // 상호명은 보통 4단어 이내
                }

                if (finalCollected.length > 0) {
                    let result = finalCollected.join(' ').trim();
                    result = result.replace(/^[\]) :;|]+|[\[( :;|]+$/g, '').trim();

                    // 최종 유효성 검사 (2글자 이상이고 의미 있는 단어인 경우)
                    if (result.length >= 2 && result !== '(주)' && result !== '주식회사') {
                        return result;
                    }
                }
            }
        }
    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    
    return null; // 검출된 게 없으면 무시
}