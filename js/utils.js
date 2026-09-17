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

// 🌟 4. [최종 완성본] 상호 추출 로직 (블록 방어 로직 탑재)
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        // =====================================================================
        // 🚀 [1차 알고리즘 - 최우선] 표준 거래명세표 맞춤형 구간 추출 (Strict Block Regex)
        // =====================================================================
        let flatForRegex = fullText.replace(/\n/g, ' ').replace(/\s+/g, ' '); 
        
        // 탐색 범위를 최대 40자로 엄격히 제한하여 표의 다른 칸으로 넘어가는 것을 1차로 막음
        const captureRegex = /(?:상\s*호\s*\(?\s*법\s*인\s*명\s*\)?|상\s*호\s*명?|업\s*체\s*명)\s*[:\-\]]?\s*(.{2,40}?)\s*(?:성\s*명|대\s*표\s*자|사\s*업\s*장|업\s*태|종\s*목|귀\s*하|주\s*소)/g;
        
        let matches = [...flatForRegex.matchAll(captureRegex)];
        let validCandidates = [];
        
        for (let m of matches) {
            let val = m[1].trim();
            val = val.replace(/^[:\-\s]+|[:\-\s]+$/g, '');
            val = val.replace(/(공급받는자|공급자|명세표|영수|청구|인$)/g, '').trim();
            
            // 💡 [핵심 방어 로직] 캡처된 텍스트 안에 다른 표 라벨이 섞여 들어왔다면?
            // -> OCR이 왼쪽, 오른쪽 컬럼을 뒤섞어 읽어서 범위가 오염된 것. 즉시 폐기!
            if (/(상호|법인명|성명|대표자|사업장|업태|종목|등록번호|단가|수량|금액|공급가|입금액|세액)/.test(val)) {
                continue; 
            }
            
            if (val.length >= 2 && val.length <= 25 && !/^\d+$/.test(val)) {
                validCandidates.push(val);
            }
        }
        
        // 유효한 후보가 존재한다면 (명세서는 2단 표 구조이므로 보통 마지막 추출값이 실제 배송지인 우측 고객 상호입니다)
        if (validCandidates.length > 0) {
            return validCandidates[validCandidates.length - 1];
        }

        // =====================================================================
        // [명세서 양식이 아니거나 OCR 인식이 심하게 깨졌을 때 실행되는 기존 로직 준비]
        // =====================================================================
        let lines = fullText.split(/\n/);
        const anchors = ['상호명', '상호(법인명)', '상호', '간판명', '배송지명', '업체명', '법인명'];
        const stopLabels = /(성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액)/;
        const breakRegex = /[\s\(\)\[\]\{\}\<\>\/,\+|;:]+/;

        // =====================================================================
        // [2차 알고리즘] 라벨 포함 줄 탐색 -> 우측 데이터 가져옴 -> 끊기면 앞자리만
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
        // [3차 알고리즘] 단어 단위 연쇄 탐색 -> 이중 라벨 건너뜀 -> 끊기면 앞자리만
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
        // [4차 알고리즘] 주소 주변 텍스트와 전체 텍스트의 '엄격한 교집합' 검증
        // =====================================================================
        let flatText2 = fullText.replace(/\n/g, ' ');
        const regionPrefixedRegex = /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도|시)?\s+[가-힣\s]+(?:구|군|시)\s+[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면|리)\s*\d+(?:-\d+)?(?:\s*,\s*\([가-힣\s]+\))?)/;
        
        let match2 = flatText2.match(regionPrefixedRegex);
        if (match2) {
            let matchStr = match2[0];
            let idx = flatText2.indexOf(matchStr);
            
            let headStr = flatText2.substring(Math.max(0, idx - 40), idx);
            let tailStr = flatText2.substring(idx + matchStr.length, idx + matchStr.length + 40);
            
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

            for (let candidate of candidates) {
                let firstIdx = flatText2.indexOf(candidate);
                let lastIdx = flatText2.lastIndexOf(candidate);
                if (firstIdx !== -1 && firstIdx !== lastIdx) {
                    return candidate;
                }
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null; 
}