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

// 4. 🌟 기사님 제안 반영: "주소 영역 철저히 배제 + 노이즈/순수 숫자 필터링 후 남은 상호명 출력"
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;

    try {
        // 1. 주소 영역을 먼저 정확히 찾아내서 텍스트 전체에서 도려냄 (주소 좌우 정보가 상호명으로 오인되는 것 원천 차단)
        let cleanText = fullText;
        let detectedAddress = extractAddressLogic(fullText);
        if (detectedAddress) {
            // 주소 문자열을 기준으로 앞뒤를 분리하거나 주소 자체를 빈 문자로 치환
            cleanText = cleanText.replace(detectedAddress, ' [주소제외됨] ');
        }

        // 2. 줄바꿈을 공백으로 펴서 한 줄로 만듦
        let text = cleanText.replace(/[\n\t\r]+/g, ' ').replace(/\s{2,}/g, ' ');

        // 3. 탐색할 타겟 키워드와 확실하게 걸러낼 필터링(Stop) 단어 정의
        const targets = ['상호', '법인', '간판', '배송지'];
        const stopWords = ['성명', '이름', '대표', '주소', '소재지', '연락처', '전화', 'tel', 'fax', 'el', '공급', '잔액', '금액', '수량', '단가', '종목', '업태', '합계', '영수', '청구', '품목', '품명', '규격'];

        let tokens = text.split(' ');

        for (let i = 0; i < tokens.length; i++) {
            let token = tokens[i];
            
            // 타겟 키워드가 포함된 블록 발견 시
            if (targets.some(t => token.includes(t))) {
                let collected = [];
                
                // 타겟 단어 자체는 필터링(출력 불가)하므로 버리고 우측 토큰들 수집 시작
                for (let j = i + 1; j < Math.min(i + 15, tokens.length); j++) {
                    let nextToken = tokens[j];
                    
                    if (targets.some(t => nextToken.includes(t))) continue;
                    let nextTokenLower = nextToken.toLowerCase();
                    
                    // 성명, 연락처, 잔액 등 필터링 단어를 만나면 즉시 중단
                    if (stopWords.some(sw => nextTokenLower.includes(sw)) || nextTokenLower === 'el:') {
                        break;
                    }
                    
                    // 🌟 기사님 제안: "순수 숫자만 있는 단어 출력 불가" (단, 글자 내부에 숫자가 섞인 상호는 허용)
                    // 예: "528,000", "0", "12" 처럼 숫자와 기호로만 이루어진 경우 버림
                    if (/^[\d\-,.]+$/.test(nextToken)) {
                        break; // 숫자가 나오면 상호명 끝으로 간주하고 중단
                    }
                    
                    // 전화번호 형태면 중단
                    if (nextToken.includes('010') || nextToken.includes('02-') || nextToken.includes('031-')) break;
                    
                    collected.push(nextToken);
                }
                
                if (collected.length > 0) {
                    let result = collected.join(' ').trim();
                    
                    // 찌꺼기 텍스트 한 번 더 필터링
                    for (let sw of stopWords) {
                        let swIndex = result.toLowerCase().indexOf(sw);
                        if (swIndex !== -1) {
                            result = result.substring(0, swIndex).trim();
                        }
                    }
                    
                    result = result.replace(/^[\]) :;|]+|[\[( :;|]+$/g, '').trim();
                    
                    // 최종 유효성 검사 (너무 짧거나 껍데기만 남았으면 무시)
                    if (result.length >= 2 && result !== '(주)' && result !== '주식회사' && !/^[\d\-,.]+$/.test(result)) {
                        return result; // 깔끔하게 정제된 상호명 출력!
                    }
                }
            }
        }
    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    
    return null; // 걸리는 게 없으면 무시하고 null 반환
}