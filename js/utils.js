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

// 4. 🌟 엄격한 상호명·배송지명 추출 로직 (인명/수령인 완벽 차단)
export function extractStoreNameLogic(fullText, extractedAddress) {
    if (!fullText || !extractedAddress) return null;
    try {
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        const addrSnippet = extractedAddress.substring(0, 8);
        let targetIndex = lines.findIndex(line => line.includes(addrSnippet));
        if (targetIndex === -1) {
            targetIndex = lines.findIndex(line => extractedAddress.includes(line.substring(0, 6)));
        }

        let candidateLines = [];
        if (targetIndex !== -1) {
            if (targetIndex > 0) candidateLines.push({ text: lines[targetIndex - 1], weight: 2 });
            if (targetIndex > 1) candidateLines.push({ text: lines[targetIndex - 2], weight: 1 });
            if (targetIndex < lines.length - 1) candidateLines.push({ text: lines[targetIndex + 1], weight: 1 });
        } else {
            lines.forEach(l => candidateLines.push({ text: l, weight: 0 }));
        }

        // 🛑 [필터 1] 절대 상호로 보면 안 되는 수령인/인명 관련 레이블 및 단어
        const excludeKeywords = /성명|받는분|수령인|고객명|고객|담당자|연락처|전화번호|핸드폰|주소|소재지/i;
        
        // ✅ [필터 2] 상호/배송지명임을 명확히 보장하는 레이블
        const explicitStoreLabelRegex = /^(상호|상호명|거래처|거래처명|납품처|현장|현장명|매장|매장명|업체명|배송지)[\s:]+(.+)$/;
        
        // ✅ [필터 3] 상호 특유의 업종/법인 키워드
        const storeKeywords = /(주)|마트|상회|상사|유통|식당|가든|카페|커피|베이커리|클리닉|센터|빌딩|타워|오피스|공사|현장|스토어|약국|병원|학원|구내식당|상가|공업|농원|축산|영농|조합|건설|기업|상사|엔지니어링|물류|종합/i;

        for (let cand of candidateLines) {
            let txt = cand.text;
            
            // 제외 키워드가 포함된 줄은 무조건 스킵 (예: "성명: 홍길동" 등)
            if (excludeKeywords.test(txt)) continue;

            // 전화번호, 사업자번호, 주소 형태인 경우 스킵
            if (txt.includes('010-') || txt.includes('사업자') || txt.length < 2) continue;
            if (txt.includes('시 ') || txt.includes('구 ') || txt.includes('로 ') || txt.includes('길 ')) continue;

            // 1) 명시적 상호 레이블이 있는 경우 (예: "거래처: OO상사" -> "OO상사")
            let match = txt.match(explicitStoreLabelRegex);
            if (match && match[2].trim().length > 1) {
                let cleaned = match[2].trim();
                if (!excludeKeywords.test(cleaned)) return cleaned;
            }

            // 2) 상호 키워드가 포함되어 있는 경우 상호로 인정
            if (storeKeywords.test(txt)) {
                return txt.replace(/^[^가-힣a-zA-Z0-9]+/, '').trim();
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}