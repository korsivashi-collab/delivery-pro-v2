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

// 🌟 4. [최종 완성본] 상호 추출 로직 (1차 줄 -> 2차 단어 -> 3차 엄격한 교집합 검증 -> 4차 표준 명세서 블록 정규식)
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        let lines = fullText.split(/\n/);
        
        // 완벽하게 제거할 대상 앵커 키워드들 (라벨)
        const anchors = ['상호명', '상호(법인명)', '상호', '간판명', '배송지명', '업체명', '법인명'];
        // 수집을 차단하는 경계선 라벨들
        const stopLabels = /(성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액)/;
        
        // 💡 [핵심] 띄어쓰기 및 괄호, 쉼표, 콜론 등 "연결이 끊기는" 모든 기호를 감지
        const breakRegex = /[\s\(\)\[\]\{\}\<\>\/,\+|;:]+/;

        // =====================================================================
        // [1차 알고리즘] 라벨 포함 줄 탐색 -> 우측 데이터 가져옴 -> 끊기면 앞자리만
        // =====================================================================
        for (let line of lines) {
            for (let anchor of anchors) {
                if (line.includes(anchor)) {
                    let idx = line.indexOf(anchor);
                    let rightSide = line.substring(idx + anchor.length).trim();
                    rightSide = rightSide.replace(/^[:\s\-]+/, '');
                    
                    let words = rightSide.split(breakRegex).filter(w => w.length > 0);
                    if (words.length > 0) {
                        let candidate = words[0].replace(/[^\w가-힣]/g, '');
                        if (candidate.length >= 2 && !stopLabels.test(candidate) && !anchors.includes(candidate)) {
                            return candidate;
                        }
                    }
                }
            }
        }

        // =====================================================================
        // [2차 알고리즘] 단어 단위 연쇄 탐색 -> 이중 라벨 건너뜀 -> 끊기면 앞자리만
        // =====================================================================
        let tokens = fullText.split(breakRegex).filter(t => t.trim().length > 0);
        
        for (let i = 0; i < tokens.length; i++) {
            let cleanTok = tokens[i].replace(/[^\w가-힣]/g, '');
            if (anchors.some(a => cleanTok === a || cleanTok.includes(a))) {
                for (let j = i + 1; j < tokens.length; j++) {
                    let cleanNext = tokens[j].replace(/[^\w가-힣]/g, '');
                    if (cleanNext.length === 0) continue;
                    
                    if (anchors.includes(cleanNext)) continue; 
                    
                    if (cleanNext.length >= 2 && !stopLabels.test(cleanNext) && !/^\d+$/.test(cleanNext)) {
                        return cleanNext;
                    }
                    break;
                }
            }
        }

        // =====================================================================
        // [3차 알고리즘] 주소 주변 텍스트와 전체 텍스트의 '엄격한 교집합' 검증
        // =====================================================================
        let flatText = fullText.replace(/\n/g, ' ');
        const regionPrefixedRegex = /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도|시)?\s+[가-힣\s]+(?:구|군|시)\s+[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면|리)\s*\d+(?:-\d+)?(?:\s*,\s*\([가-힣\s]+\))?)/;
        
        let match = flatText.match(regionPrefixedRegex);
        if (match) {
            let matchStr = match[0];
            let idx = flatText.indexOf(matchStr);
            
            // 주소 기준 양방향 탐색
            let headStr = flatText.substring(Math.max(0, idx - 40), idx);
            let tailStr = flatText.substring(idx + matchStr.length, idx + matchStr.length + 40);
            
            const cleanUpRegex = /(주소|배송지|\[\d{5}\]|\d{5}|지하\s*\d+층|\d+층|지상\s*\d+층|B\d+|\([가-힣0-9\s]+\))/g;
            headStr = headStr.replace(cleanUpRegex, ' ');
            tailStr = tailStr.replace(cleanUpRegex, ' ');
            
            let headWords = headStr.split(breakRegex).filter(w => w.trim().length > 0);
            let tailWords = tailStr.split(breakRegex).filter(w => w.trim().length > 0);
            
            let candidates = [];
            
            for (let i = headWords.length - 1; i >= 0; i--) {
                let candidate = headWords[i].replace(/[^\w가-힣]/g, '');
                if (candidate.length >= 2 && !stopLabels.test(candidate) && !anchors.includes(candidate) && !/^\d+$/.test(candidate)) {
                    candidates.push(candidate);
                }
            }
            for (let i = 0; i < tailWords.length; i++) {
                let candidate = tailWords[i].replace(/[^\w가-힣]/g, '');
                if (candidate.length >= 2 && !stopLabels.test(candidate) && !anchors.includes(candidate) && !/^\d+$/.test(candidate)) {
                    candidates.push(candidate);
                }
            }

            // 💡 [대표님 규칙] 오직 2번 이상 겹치는(교집합) 데이터만 상호로 확정
            for (let candidate of candidates) {
                let firstIdx = flatText.indexOf(candidate);
                let lastIdx = flatText.lastIndexOf(candidate);
                
                if (firstIdx !== -1 && firstIdx !== lastIdx) {
                    return candidate;
                }
            }
        }

        // =====================================================================
        // 🚀 [4차 알고리즘] (추가) 표준 거래명세표 맞춤형 구간 추출 (Block Regex)
        // 1~3차에서 실패했을 경우, 정형화된 양식의 "시작 단어"와 "종료 단어" 사이를 캡처합니다.
        // =====================================================================
        // 1. 모든 줄바꿈과 다중 공백을 1칸 공백으로 통일하여 텍스트를 길게 폅니다.
        let flatForRegex = fullText.replace(/\n/g, ' ').replace(/\s+/g, ' '); 

        // 2. 붉은 명세서에 자주 등장하는 시작 라벨 (OCR이 띄어쓰기를 맘대로 하는 것을 대비)
        const startRegex = /(?:상\s*호\s*\(?\s*법\s*인\s*명\s*\)?|상\s*호\s*명?|업\s*체\s*명)/;
        
        // 3. 상호 바로 아래나 옆에 항상 따라붙는 종료 라벨
        const endRegex = /(?:성\s*명|대\s*표\s*자|사\s*업\s*장|업\s*태|종\s*목)/;

        // 4. "시작라벨 [가져올 텍스트] 종료라벨" 구조를 정규식으로 묶어 추출
        const captureRegex = new RegExp(startRegex.source + "\\s*[:\\-]?\\s*(.+?)\\s*" + endRegex.source);
        let match4 = flatForRegex.match(captureRegex);
        
        if (match4 && match4[1]) {
            let candidate4 = match4[1].trim();
            
            // 앞뒤 쓸데없는 기호 제거 (콜론, 하이픈 등)
            candidate4 = candidate4.replace(/^[:\-\s]+|[:\-\s]+$/g, '');
            
            // 혹시 섞여 들어왔을 수 있는 서식용 단어 제거
            candidate4 = candidate4.replace(/(공급받는자|공급자|귀하)/g, '').trim(); 

            // 추출된 텍스트가 2자 이상, 25자 이하이고, 숫자로만 이루어지지 않았다면 상호로 확정!
            if (candidate4.length >= 2 && candidate4.length <= 25 && !/^\d+$/.test(candidate4)) {
                return candidate4;
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null; // 모든 규칙(1~4차)에서 실패하면 깔끔하게 null 반환
}