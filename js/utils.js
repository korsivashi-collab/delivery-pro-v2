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

// 🌟 4. [신규 Document AI 맞춤형] 상호 추출 로직
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        // [개선 1] 괄호 보존: (주), (유) 및 (계림닭도리) 같은 텍스트가 쪼개지지 않도록 구분자에서 괄호 제외
        const breakRegex = /[\s,:;\|]+/; 

        const anchors = ['상호(법인명)', '상호명', '상호', '간판명', '배송지명', '업체명', '법인명', '공급받는자'];
        // [개선 2] 표 형태(세금계산서)에서 잘못 읽히는 테이블 헤더 라벨들 강력 필터링
        const stopLabels = /^(성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|단가|수량|규격|품목|비고|구분|일자|월|일)$/;
        
        let lines = fullText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);

        // =====================================================================
        // [1차 알고리즘] 라벨 기반 세로/가로 탐색 (세금계산서 줄바꿈 틀어짐 대응)
        // =====================================================================
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            for (let anchor of anchors) {
                if (line.includes(anchor)) {
                    let rightSide = line.substring(line.indexOf(anchor) + anchor.length).trim();
                    rightSide = rightSide.replace(/^[:\-\s]+/, ''); // 콜론, 대시 등 시작 특수문자 제거
                    
                    let candidate = null;
                    
                    // 1단계: 라벨과 같은 줄에 값이 있는지 탐색
                    let tokens = rightSide.split(breakRegex).filter(w => w.length > 0);
                    for (let token of tokens) {
                        let cleanTok = token.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, ''); // 앞뒤 특수문자만 제거, 내부 괄호는 유지
                        if (cleanTok.length >= 2 && !stopLabels.test(cleanTok) && !anchors.includes(cleanTok) && !/^\d+$/.test(cleanTok)) {
                            candidate = cleanTok;
                            break;
                        }
                    }
                    
                    // 2단계: [핵심] 같은 줄에서 못 찾았다면(표 양식이 틀어진 경우), 다음 1~2줄(아래 칸)을 세로로 탐색
                    if (!candidate) {
                        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
                            let nextTokens = lines[j].split(breakRegex).filter(w => w.length > 0);
                            for (let token of nextTokens) {
                                let cleanTok = token.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
                                if (cleanTok.length >= 2 && !stopLabels.test(cleanTok) && !anchors.includes(cleanTok) && !/^\d+$/.test(cleanTok)) {
                                    candidate = cleanTok;
                                    break;
                                }
                            }
                            if (candidate) break;
                        }
                    }
                    
                    if (candidate) return candidate;
                }
            }
        }

        // =====================================================================
        // [2차 알고리즘] 주소 뒷부분 직접 추출 (거래명세서 꼬리표 연속 기입 대응)
        // =====================================================================
        let flatText = fullText.replace(/\n/g, ' ');
        const regionPrefixedRegex = /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도|시)?\s+[가-힣\s]+(?:구|군|시)\s+[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면|리)\s*\d+(?:-\d+)?(?:\s*,\s*\([가-힣\s]+\))?)/;
        
        let match = flatText.match(regionPrefixedRegex);
        if (match) {
            let addrStr = match[0];
            let idx = flatText.indexOf(addrStr);
            let tailStr = flatText.substring(idx + addrStr.length).trim();
            
            // 1층, B1층 같은 층수 표기 건너뛰기
            tailStr = tailStr.replace(/^[,\s]*(지하\s*\d+층|지상\s*\d+층|B?\d+층|\d+층)\s*/, '');
            
            let tailTokens = tailStr.split(breakRegex).filter(w => w.length > 0);
            for (let token of tailTokens) {
                let cleanTok = token.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
                if (cleanTok.length >= 2 && !stopLabels.test(cleanTok) && !anchors.includes(cleanTok) && !/^\d+$/.test(cleanTok)) {
                    return cleanTok; 
                }
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}