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

// 🌟 4. [완성본] 대표님 설계 파이프라인 (1단계 -> 2단계 소거/필터링 -> 3단계 교집합 -> 4단계 없음 처리)
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        let lines = fullText.split(/\n/);
        
        // 앵커 키워드 목록
        const anchors = ['상호명', '상호(법인명)', '상호', '간판명', '배송지명', '업체명', '법인명'];
        // 경계선 및 차단 라벨
        const stopLabels = /(성명|대표자|대표|사업장소재지|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|단가|수량|총액|합계)/;
        // 💡 띄어쓰기, 괄호, 쉼표, 콜론 등 "연결이 끊기는" 기호
        const breakRegex = /[\s\(\)\[\]\{\}\<\>\/,\+|;:]+/;

        // =====================================================================
        // [1단계] 라벨 포함 줄 단독 탐색 (기존 1단계 유지)
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
        // [2단계] 라벨링 & 노이즈 데이터 소거 작업 후 남은 데이터 필터링
        // =====================================================================
        let cleanedText = fullText;

        // 2-1. 확정 주소 패턴 소거
        const regionPrefixedRegex = /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도|시)?\s+[가-힣\s]+(?:구|군|시)\s+[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면|리)\s*\d+(?:-\d+)?(?:\s*,\s*\([가-힣\s]+\))?)/g;
        cleanedText = cleanedText.replace(regionPrefixedRegex, ' ');

        // 2-2. 전화번호 및 팩스번호 소거
        cleanedText = cleanedText.replace(/(010|050\d|070|0[2-9][0-9]?|1[5-9]\d{2})[\s\-\.]*(\d{3,4})[\s\-\.]*(\d{4})/g, ' ');

        // 2-3. 사업자등록번호 소거 (xxx-xx-xxxxx 및 10자리 연속 숫자)
        cleanedText = cleanedText.replace(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/g, ' ');
        cleanedText = cleanedText.replace(/\b\d{10}\b/g, ' ');

        // 2-4. 금액, 단위, 단순 숫자 소거
        cleanedText = cleanedText.replace(/\b\d{1,3}(,\d{3})+(\s*원)?\b/g, ' ');
        cleanedText = cleanedText.replace(/\b\d+\s*(원|kg|BOX|판|개|포)\b/gi, ' ');
        cleanedText = cleanedText.replace(/\b\d{4,}\b/g, ' ');

        // 2-5. [핵심] '성명 강경운' 등 사람 이름 및 노이즈 라벨 덩어리 제거
        cleanedText = cleanedText.replace(/(성명|대표자?)\s*[:\s\-]?\s*[가-힣]{2,4}/g, ' ');
        cleanedText = cleanedText.replace(/(사업장소재지|사업장|업태|종목|등록번호|공급받는자|공급자|규격|단위|제조사|원산지|수량|단가|총액|합계|잔액|영수|청구)/g, ' ');

        // 2-6. 불필요한 데이터가 날아간 상태에서 앵커 필터링 진행
        let tokens = cleanedText.split(breakRegex).filter(t => t.trim().length > 0);
        for (let i = 0; i < tokens.length; i++) {
            let cleanTok = tokens[i].replace(/[^\w가-힣]/g, '');
            if (anchors.some(a => cleanTok === a || cleanTok.includes(a))) {
                // 앵커를 찾았으면 뒤따라오는 토큰 중 유효한 첫 번째 상호 데이터 추출
                for (let j = i + 1; j < tokens.length; j++) {
                    let cleanNext = tokens[j].replace(/[^\w가-힣]/g, '');
                    if (cleanNext.length === 0) continue;

                    // 또 다른 앵커 라벨이면 건너뜀
                    if (anchors.includes(cleanNext)) continue;

                    // 노이즈가 제거된 상태이므로 처음 마주친 2글자 이상 한글/영문 단어가 곧 상호명!
                    if (cleanNext.length >= 2 && !stopLabels.test(cleanNext) && !/^\d+$/.test(cleanNext)) {
                        return cleanNext; // 붙어있던 정보(괄호 끊김 앞자리) 출력!
                    }
                    break;
                }
            }
        }

        // =====================================================================
        // [3단계] 주소 뒷부분 데이터와 전체 데이터의 '교집합' 확인
        // =====================================================================
        let flatText = fullText.replace(/\n/g, ' ');
        let match = flatText.match(regionPrefixedRegex);
        if (match) {
            let matchStr = match[0];
            let idx = flatText.indexOf(matchStr);
            
            // 주소 뒷부분 40글자 추출
            let tailStr = flatText.substring(idx + matchStr.length, idx + matchStr.length + 40);
            tailStr = tailStr.replace(/(주소|배송지|\[\d{5}\]|\d{5}|지하\s*\d+층|\d+층|지상\s*\d+층|B\d+|\([가-힣0-9\s]+\))/g, ' ');
            
            let tailWords = tailStr.split(breakRegex).filter(w => w.trim().length > 0);
            for (let tailWord of tailWords) {
                let candidate = tailWord.replace(/[^\w가-힣]/g, '');
                if (candidate.length >= 2 && !stopLabels.test(candidate) && !anchors.includes(candidate) && !/^\d+$/.test(candidate)) {
                    // 전체 문서에서 2번 이상 등장(겹침)하는지 확인
                    let firstIdx = flatText.indexOf(candidate);
                    let lastIdx = flatText.lastIndexOf(candidate);
                    if (firstIdx !== -1 && firstIdx !== lastIdx) {
                        return candidate; // 교집합 확인되어 출력
                    }
                }
            }
        }

        // =====================================================================
        // [4단계] 위 모든 단계에서 없으면 상호 정보가 없는 것으로 간주
        // =====================================================================
        return null;

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}