// js/utils.js

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

// 4. 🌟 송장 표 양식 맞춤형 상호명·배송지명 직접 추출 로직
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        // 텍스트 평탄화 (줄바꿈 공백 처리)
        let flatText = fullText.replace(/\n/g, ' ').replace(/\s+/g, ' ');

        // 1) "배송지명(간판명)" 또는 "상호(법인명)" 같은 레이블 바로 뒤에 오는 상호 패턴 탐색
        // 예: "배송지명(간판명) 샤브항 홍창역점" 또는 "상호(법인명) 체이아이에치(JH) 컴퍼니"
        const labelPatterns = [
            /(?:배송지명|간판명|상호명|상호|법인명|거래처명|납품처)\s*(?:\([가-힣a-zA-Z\s]+\))?\s*[:\-]?\s*([가-힣a-zA-Z0-9\(\)\-\.\s]{2,25})/g
        ];

        for (let pat of labelPatterns) {
            let matches = [...flatText.matchAll(pat)];
            if (matches && matches.length > 0) {
                // 가장 마지막에 매칭된 유효한 상호 선택
                for (let i = matches.length - 1; i >= 0; i--) {
                    let candidate = matches[i][1].trim();
                    // 수령인/전화번호 등 제외 키워드 체크
                    if (/성명|받는분|수령인|고객명|전화번호|010-/.test(candidate)) continue;
                    if (candidate.length >= 2) {
                        return candidate.replace(/\s+/g, ' ');
                    }
                }
            }
        }

        // 2) 레이블이 명확하지 않은 경우, 줄 단위로 순회하며 상호 키워드 탐색
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const storeKeywords = /(주)|마트|상회|상사|유통|식당|가든|카페|커피|베이커리|클리닉|센터|빌딩|타워|오피스|공사|현장|스토어|약국|병원|학원|구내식당|상가|공업|농원|축산|영농|조합|건설|기업|엔지니어링|물류|종합|점$/i;

        for (let line of lines) {
            if (/성명|받는분|수령인|고객명|전화번호|010-|사업자등록번호|단가|수량|공급가액/.test(line)) continue;
            if (line.includes('시 ') || line.includes('구 ') || line.includes('로 ') || line.includes('길 ')) continue;
            
            if (storeKeywords.test(line) && line.length >= 2 && line.length <= 25) {
                return line.replace(/^[^가-힣a-zA-Z0-9]+/, '').trim();
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}