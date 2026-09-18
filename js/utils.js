// js/utils.js

// 1. 클라이언트단 사진 안전 압축 (기존 유지)
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
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d'); 
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.85)); 
            };
            img.onerror = (e) => reject(e);
        };
        reader.onerror = error => reject(error);
    });
}

// 2. 전화번호 추출 로직 (기존 유지)
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
    
    candidates = [...new Set(candidates)];
    let bestPhone = null; let highestScore = -1;
    for (let num of candidates) {
        let score = 0;
        let is010 = num.startsWith('010') && (num.length === 10 || num.length === 11);
        let is050 = num.startsWith('050') && (num.length === 11 || num.length === 12);
        let isRep = /^1[5-9]\d{6}$/.test(num); 
        if (is010) score += 100; else if (is050) score += 90; else if (isRep) score += 70; else score -= 100; 
        if (score > highestScore && score > 0) { highestScore = score; bestPhone = num; }
    }
    if (bestPhone) {
        let p = bestPhone;
        if (p.length === 11) return p.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
        if (p.length === 10) return p.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
        return p;
    }
    return null;
}

// 3. 스마트 주소 추출 로직 (기존 유지)
export function extractAddressLogic(text) {
    if (!text || typeof text !== 'string') return null;
    try {
        let flatText = text.replace(/\n/g, ' ').replace(/\s+/g, ' ');
        let regionPrefixedRegex = /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도|시)?\s+[가-힣\s]+(?:구|군|시)\s+[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면|리)\s*\d+(?:-\d+)?(?:\s*,\s*\([가-힣\s]+\))?)/g;
        let matches = [...flatText.matchAll(regionPrefixedRegex)];
        if (matches && matches.length > 0) {
            return matches[matches.length - 1][0].trim().replace(/\s+/g, ' ');
        }
    } catch (e) {} 
    return null;
}

// 🌟 4. [3세대] 다중 줄 병합(Multi-line Aggregation) 상호 추출 로직
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        const anchors = ['상호(법인명)', '상호명', '상호', '간판명', '배송지명', '업체명', '법인명', '공급받는자'];
        const stopLabels = /(성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|단가|수량|규격|품목|비고|구분|일자|월|일|합계)/;
        const skipWords = /^\(?(주|유|주식회사|유한회사)\)?$/;
        
        let lines = fullText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            
            for (let anchor of anchors) {
                if (line.includes(anchor)) {
                    let rightSide = line.substring(line.indexOf(anchor) + anchor.length).trim();
                    rightSide = rightSide.replace(/^[:\-\s]+/, ''); 
                    
                    // 여러 줄에 걸친 상호명을 담을 배열
                    let extractedPieces = [];
                    
                    // 1. 첫 번째 줄 데이터 수집
                    if (rightSide.length > 0) {
                        let cleanText = rightSide.split(stopLabels)[0].trim();
                        if (cleanText.length > 0 && !skipWords.test(cleanText)) {
                            extractedPieces.push(cleanText);
                        }
                    }
                    
                    // 2. 아래 2줄까지 추가 탐색 (동대문엽기떡볶이 + 이신촌점 결합용)
                    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
                        let nextLine = lines[j];
                        
                        // 아랫줄이 다른 칸의 제목(예: 성명, 주소)으로 시작하면 병합 즉시 중단
                        if (stopLabels.test(nextLine.split(/[\s:]+/)[0])) break;
                        
                        let cleanNextLine = nextLine.split(stopLabels)[0].trim();
                        // 주소처럼 너무 긴 문장이거나 숫자로만 된 값이 아니면 병합 배열에 추가
                        if (cleanNextLine.length > 0 && cleanNextLine.length < 20 && !/^\d+$/.test(cleanNextLine)) {
                            extractedPieces.push(cleanNextLine);
                        }
                    }
                    
                    // 3. 수집된 조각들을 하나로 조립
                    if (extractedPieces.length > 0) {
                        let candidate = extractedPieces.join(' '); // 띄어쓰기로 연결
                        
                        // '(주)' 앞의 불필요한 띄어쓰기 정리 (예: 원조남산왕돈가스 (주) -> 원조남산왕돈가스(주))
                        candidate = candidate.replace(/\s+\(주\)/g, '(주)').replace(/\s+\(유\)/g, '(유)');
                        // 맨 앞뒤의 의미 없는 특수문자 제거
                        candidate = candidate.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
                        
                        if (candidate.length >= 2 && !skipWords.test(candidate)) {
                            return candidate;
                        }
                    }
                }
            }
        }

        // 최후의 보루: 주소 뒤 꼬리표 추출 (기존 유지)
        let flatText = fullText.replace(/\n/g, ' ');
        const regionPrefixedRegex = /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도|시)?\s+[가-힣\s]+(?:구|군|시)\s+[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면|리)\s*\d+(?:-\d+)?(?:\s*,\s*\([가-힣\s]+\))?)/;
        
        let match = flatText.match(regionPrefixedRegex);
        if (match) {
            let addrStr = match[0];
            let idx = flatText.indexOf(addrStr);
            let tailStr = flatText.substring(idx + addrStr.length).trim();
            
            tailStr = tailStr.replace(/^[,\s]*(지하\s*\d+층|지상\s*\d+층|B?\d+층|\d+층|[가-힣]+\([가-힣]+\)|[가-힣]+동)\s*/, '');
            
            let splitByLabel = tailStr.split(stopLabels);
            let candidate = splitByLabel[0].trim().split(/[\s,:;\|]+/)[0]; 
            
            if (candidate.length >= 2 && !skipWords.test(candidate)) {
                candidate = candidate.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
                return candidate; 
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}