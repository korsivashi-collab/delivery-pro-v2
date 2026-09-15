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

// 4. 🌟 2가지 고정 양식 맞춤형: "키워드 찾기 -> 우측/아랫방향 탐색 -> 2줄 상호명 보존 및 스톱워드 차단"
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;

    try {
        let text = fullText;

        // 1. 2가지 양식의 핵심 안내 키워드들을 탐색 목록으로 설정
        // 양식 A: "배송지명(간판명)" 또는 "간판명" 또는 "간판"
        // 양식 B: "업체명" 또는 "상호" 또는 "상인명"
        const anchorKeywords = ['배송지명', '간판명', '간판', '업체명', '상호', '상인명'];
        
        // 탐색을 멈추게 하는 강력한 스톱 워드 (다음 칸 정보들)
        const stopWords = ['성명', '이름', '대표', '주소', '소재지', '연락처', '전화', 'tel', 'fax', 'el', '공급', '잔액', '금액', '수량', '단가', '종목', '업태', '합계', '영수', '청구', '품목', '품명', '규격'];

        // 토큰 단위로 쪼개서 분석
        let tokens = text.split(/[\s\n,;|]+/);

        for (let i = 0; i < tokens.length; i++) {
            let token = tokens[i];
            
            // 2. 키워드 발견 시점 포착
            if (anchorKeywords.some(ak => token.includes(ak))) {
                let collected = [];
                
                // 3. 키워드 우측 또는 바로 아랫줄에 있는 실제 상호명 데이터 수집 시작 (최대 12개 토큰)
                for (let j = i + 1; j < Math.min(i + 14, tokens.length); j++) {
                    let nextToken = tokens[j];
                    if (!nextToken) continue;
                    
                    let cleanNext = nextToken.replace(/^[|:;()]+|[|:;()]+$/g, '').trim();
                    if (!cleanNext) continue;

                    // 또 다른 ânchor 키워드가 나오면 무시
                    if (anchorKeywords.some(ak => cleanNext.includes(ak))) continue;
                    
                    let lowerNext = cleanNext.toLowerCase();
                    
                    // 4. 스톱워드(성명, 주소, 연락처 등)를 만나면 즉시 수집 중단
                    if (stopWords.some(sw => lowerNext.includes(sw))) {
                        break;
                    }
                    
                    // 순수 숫자만 있는 단어(금액, 번호 등)는 상호명이 아니므로 중단
                    if (/^[\d\-,.]+$/.test(cleanNext)) {
                        break;
                    }
                    
                    // 전화번호 형태면 중단
                    if (cleanNext.includes('010') || cleanNext.includes('02-') || cleanNext.includes('031-')) break;

                    // 주소 형태(예: 서울시, 종로구 등)가 나오면 상호명 영역을 벗어난 것이므로 중단
                    if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/.test(cleanNext)) {
                        break;
                    }

                    collected.push(cleanNext);
                }
                
                if (collected.length > 0) {
                    let result = collected.join(' ').trim();
                    
                    // 중간에 묻어 들어온 스톱워드 뒷부분 잘라내기
                    for (let sw of stopWords) {
                        let swIdx = result.toLowerCase().indexOf(sw);
                        if (swIdx !== -1) {
                            result = result.substring(0, swIdx).trim();
                        }
                    }
                    
                    // 최종 기호 정리 ((주) 같은 괄호는 살리고 불필요한 특수문자만 제거)
                    result = result.replace(/^[-)\]}]+|[-)\]}]+$/g, '').trim();
                    
                    // 2글자 이상이고 단순 껍데기가 아니면 최종 채택!
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