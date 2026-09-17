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

// 🌟 4. [최종 완성본] 공급자 분리 + 사람 이름 블랙리스트 + 앵커 필터링 파이프라인
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        const breakRegex = /[\s\(\)\[\]\{\}\<\>\/,\+|;:]+/;
        const anchors = ['상호명', '상호(법인명)', '상호', '간판명', '배송지명', '업체명', '법인명'];
        const stopLabels = /(성명|대표자|대표|사업장소재지|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|단가|수량|총액|합계|인)/;

        // -----------------------------------------------------------------
        // [사전 준비 1] 공급받는 자 영역 우선 확보 (납품회사 '물봉' 등 혼선 방지)
        // -----------------------------------------------------------------
        let targetText = fullText;
        if (fullText.includes('공급받는자') || fullText.includes('공급받는 자')) {
            let splitIdx = fullText.indexOf('공급받는자');
            if (splitIdx === -1) splitIdx = fullText.indexOf('공급받는 자');
            if (splitIdx !== -1) {
                targetText = fullText.substring(splitIdx); // 공급받는 자 이후의 데이터만 분석
            }
        }

        // -----------------------------------------------------------------
        // [사전 준비 2] 사람 이름 동적 블랙리스트 구축 ('강경운', '윤희영', '한승제' 차단)
        // -----------------------------------------------------------------
        let personBlacklist = new Set();
        let allTokens = fullText.split(breakRegex).filter(t => t.trim().length > 0);
        
        for (let i = 0; i < allTokens.length; i++) {
            let clean = allTokens[i].replace(/[^\w가-힣]/g, '');
            // '성명', '대표자', '구매자명', '담당자' 뒤에 오는 2~4글자 단어는 무조건 이름으로 등록
            if (/(성명|대표자?|구매자명?|담당자)/.test(clean)) {
                for (let j = i + 1; j < Math.min(i + 4, allTokens.length); j++) {
                    let nextClean = allTokens[j].replace(/[^\w가-힣]/g, '');
                    if (nextClean === '인' || nextClean.length === 0) continue;
                    if (nextClean.length >= 2 && nextClean.length <= 4 && !stopLabels.test(nextClean) && !anchors.includes(nextClean)) {
                        personBlacklist.add(nextClean);
                    }
                    break;
                }
            }
        }

        // =====================================================================
        // [1단계] 라벨 포함 줄 단독 탐색 (앵커 우측 데이터 앞자리)
        // =====================================================================
        let lines = targetText.split(/\n/);
        for (let line of lines) {
            for (let anchor of anchors) {
                if (line.includes(anchor)) {
                    let idx = line.indexOf(anchor);
                    let rightSide = line.substring(idx + anchor.length).trim();
                    rightSide = rightSide.replace(/^[:\s\-]+/, '');
                    
                    let words = rightSide.split(breakRegex).filter(w => w.length > 0);
                    if (words.length > 0) {
                        let candidate = words[0].replace(/[^\w가-힣]/g, '');
                        if (candidate.length >= 2 && !stopLabels.test(candidate) && !anchors.includes(candidate) && !personBlacklist.has(candidate)) {
                            return candidate;
                        }
                    }
                }
            }
        }

        // =====================================================================
        // [2단계] 라벨링 & 노이즈 소거 후 앵커 필터링
        // =====================================================================
        let cleanedText = targetText;

        // 주소, 전화번호, 사업자등록번호, 금액/수량 소거
        const regionPrefixedRegex = /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도|시)?\s+[가-힣\s]+(?:구|군|시)\s+[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면|리)\s*\d+(?:-\d+)?(?:\s*,\s*\([가-힣\s]+\))?)/g;
        cleanedText = cleanedText.replace(regionPrefixedRegex, ' ');
        cleanedText = cleanedText.replace(/(010|050\d|070|0[2-9][0-9]?|1[5-9]\d{2})[\s\-\.]*(\d{3,4})[\s\-\.]*(\d{4})/g, ' ');
        cleanedText = cleanedText.replace(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/g, ' ');
        cleanedText = cleanedText.replace(/\b\d{10}\b/g, ' ');
        cleanedText = cleanedText.replace(/\b\d{1,3}(,\d{3})+(\s*원)?\b/g, ' ');
        cleanedText = cleanedText.replace(/\b\d+\s*(원|kg|BOX|판|개|포)\b/gi, ' ');
        cleanedText = cleanedText.replace(/\b\d{4,}\b/g, ' ');

        // 양식 라벨 소거
        cleanedText = cleanedText.replace(/(사업장소재지|사업장|업태|종목|등록번호|공급받는자|공급자|규격|단위|제조사|원산지|수량|단가|총액|합계|잔액|영수|청구)/g, ' ');

        // 앵커 추적
        let tokens = cleanedText.split(breakRegex).filter(t => t.trim().length > 0);
        for (let i = 0; i < tokens.length; i++) {
            let cleanTok = tokens[i].replace(/[^\w가-힣]/g, '');
            if (anchors.some(a => cleanTok === a || cleanTok.includes(a))) {
                for (let j = i + 1; j < tokens.length; j++) {
                    let cleanNext = tokens[j].replace(/[^\w가-힣]/g, '');
                    if (cleanNext.length === 0 || cleanNext === '인') continue;
                    if (anchors.includes(cleanNext)) continue;

                    // 💡 사람 이름 블랙리스트에 걸리면 즉시 제외
                    if (personBlacklist.has(cleanNext)) continue;

                    if (cleanNext.length >= 2 && !stopLabels.test(cleanNext) && !/^\d+$/.test(cleanNext)) {
                        return cleanNext;
                    }
                    break;
                }
            }
        }

        // =====================================================================
        // [3단계] 주소 뒷부분 데이터와 전체 데이터의 '교집합' 확인
        // =====================================================================
        let flatText = targetText.replace(/\n/g, ' ');
        let match = flatText.match(regionPrefixedRegex);
        if (match) {
            let matchStr = match[0];
            let idx = flatText.indexOf(matchStr);
            
            let tailStr = flatText.substring(idx + matchStr.length, idx + matchStr.length + 40);
            tailStr = tailStr.replace(/(주소|배송지|\[\d{5}\]|\d{5}|지하\s*\d+층|\d+층|지상\s*\d+층|B\d+|\([가-힣0-9\s]+\))/g, ' ');
            
            let tailWords = tailStr.split(breakRegex).filter(w => w.trim().length > 0);
            for (let tailWord of tailWords) {
                let candidate = tailWord.replace(/[^\w가-힣]/g, '');
                if (candidate.length >= 2 && !stopLabels.test(candidate) && !anchors.includes(candidate) && !personBlacklist.has(candidate) && !/^\d+$/.test(candidate)) {
                    let firstIdx = flatText.indexOf(candidate);
                    let lastIdx = flatText.lastIndexOf(candidate);
                    if (firstIdx !== -1 && firstIdx !== lastIdx) {
                        return candidate;
                    }
                }
            }
        }

        return null;

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}