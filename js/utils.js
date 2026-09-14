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

// 3. OCR 텍스트에서 주소 추출 로직 (기존 유지)
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

// 4. 🌟 필터 단어(배송, 상호, 간판, 법인, 거래처, 도착, 회사) 자체를 제외하고 우측 데이터만 추출하는 로직
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        let flatText = fullText.replace(/\n/g, ' ').replace(/\s+/g, ' ');

        // 사용자가 지정한 7가지 필터링 단어
        const allowedFilters = ['배송', '상호', '간판', '법인', '거래처', '도착', '회사'];

        // 필터 단어 뒤에 붙는 불필요한 접미사(지, 명, 처, 장 등)와 콜론, 괄호 등을 유연하게 건너뛰고
        // '우측에 위치한 진짜 상호 데이터'만 캡처그룹으로 가져오는 정규식
        const targetPattern = new RegExp(`(?:${allowedFilters.join('|')})(?:지|명|처|장)?\\s*(?:\\([가-힣a-zA-Z\\s]+\\))?\\s*[\\:\\-\\s]*\\s*([가-힣a-zA-Z0-9\\(\\)\\-\\.\\s]{2,25})`, 'g');

        let matches = [...flatText.matchAll(targetPattern)];
        if (matches && matches.length > 0) {
            for (let i = matches.length - 1; i >= 0; i--) {
                let candidate = matches[i][1].trim();
                
                // 만약 추출된 우측 데이터가 필터 단어 자체이거나, 성명·전화번호 등 불필요한 경우 스킵
                if (allowedFilters.some(kw => candidate === kw || candidate.startsWith(kw))) continue;
                if (/성명|받는분|수령인|고객명|전화번호|010-/.test(candidate)) continue;
                
                if (candidate.length >= 2) {
                    return candidate.replace(/\s+/g, ' ');
                }
            }
        }

        // 줄 단위 백업 검사: 필터 단어가 포함된 라인에서 필터 단어 문자열을 깔끔하게 제거하고 우측 잔여 데이터만 추출
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        for (let line of lines) {
            let matchedKeyword = allowedFilters.find(kw => line.includes(kw));
            if (matchedKeyword) {
                if (/성명|받는분|수령인|고객명|전화번호|010-|사업자등록번호/.test(line)) continue;
                
                let cleaned = line;
                // 발견된 필터 단어들과 괄호 레이블(예: (간판명))을 통째로 제거
                allowedFilters.forEach(kw => {
                    cleaned = cleaned.replace(new RegExp(`${kw}(?:지|명|처|장)?`, 'g'), '');
                });
                cleaned = cleaned.replace(/\([가-힣a-zA-Z\s]+\)/g, ''); // 괄호 안의 설명글 제거
                cleaned = cleaned.replace(/[\:\-\(\)]+/g, ' ').trim(); // 남은 특수문자 정리
                
                if (cleaned.length >= 2 && !cleaned.includes('시 ') && !cleaned.includes('로 ')) {
                    return cleaned.replace(/\s+/g, ' ');
                }
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }

    // 🛑 필터 단어에 걸리지 않거나 우측 데이터가 없으면 무시하고 null 반환
    return null;
}