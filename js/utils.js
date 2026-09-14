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

// 2. OCR 텍스트에서 전화번호 추출 로직
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

// 3. OCR 텍스트에서 주소 추출 로직
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

// 4. 🌟 앵커(주소) 기반 상호명·배송지명 추출 로직 (신규 추가)
export function extractStoreNameLogic(fullText, extractedAddress) {
    if (!fullText || !extractedAddress) return null;
    try {
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        // 주소의 앞부분 키워드로 주소가 위치한 줄 인덱스 찾기
        const addrSnippet = extractedAddress.substring(0, 8);
        let targetIndex = lines.findIndex(line => line.includes(addrSnippet));
        
        // 만약 정확한 매칭이 안되면 전체 포함 여부 확인
        if (targetIndex === -1) {
            targetIndex = lines.findIndex(line => extractedAddress.includes(line.substring(0, 6)));
        }

        // 탐색할 후보 라인들 수집 (주소 라인 위아래 2~3줄 반경 탐색)
        let candidateLines = [];
        if (targetIndex !== -1) {
            // 주소 바로 윗줄과 아랫줄 우선순위 부여
            if (targetIndex > 0) candidateLines.push({ text: lines[targetIndex - 1], weight: 2 });
            if (targetIndex > 1) candidateLines.push({ text: lines[targetIndex - 2], weight: 1 });
            if (targetIndex < lines.length - 1) candidateLines.push({ text: lines[targetIndex + 1], weight: 1 });
        } else {
            // 주소 라인을 못 찾았으면 전체 라인을 후보로 사용
            lines.forEach(l => candidateLines.push({ text: l, weight: 0 }));
        }

        // 상호명/배송지명 레이블 또는 특징 키워드 정규식
        const labelPrefixRegex = /^(상호|상호명|거래처|거래처명|납품처|현장|현장명|매장|매장명|업체명|배송지)[\s:]+(.+)$/;
        const storeKeywords = /(주)|마트|상회|상사|유통|식당|가든|카페|커피|베이커리|마트|클리닉|센터|빌딩|타워|오피스|공사|현장|스토어|약국|병원|학원|마트|구내식당/i;

        for (let cand of candidateLines) {
            let txt = cand.text;
            
            // 레이블이 붙어 있는 경우 (예: "상호: OO상사" -> "OO상사" 추출)
            let match = txt.match(labelPrefixRegex);
            if (match && match[2].trim().length > 1) {
                return match[2].trim();
            }

            // 전화번호나 주소 자체, 사업자번호인 경우 제외
            if (txt.includes('010-') || txt.includes('전화') || txt.includes('사업자') || txt.length < 2) continue;
            if (txt.includes('시 ') || txt.includes('구 ') || txt.includes('로 ') || txt.includes('길 ')) continue;

            // 상호 특유의 키워드가 포함되어 있거나 가중치가 높은 경우 상호로 채택
            if (storeKeywords.test(txt) || cand.weight >= 2) {
                // 불필요한 특수문자 제거 후 반환
                return txt.replace(/^[^가-힣a-zA-Z0-9]+/, '').trim();
            }
        }

        // 만약 위 조건에 안 걸리더라도 주소 바로 윗줄이 존재하면 예비 상호명으로 활용
        if (targetIndex > 0 && lines[targetIndex - 1].length > 1) {
            let fallback = lines[targetIndex - 1];
            if (!fallback.includes('전화') && !fallback.includes('사업자')) {
                return fallback.replace(/^[^가-힣a-zA-Z0-9]+/, '').trim();
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}