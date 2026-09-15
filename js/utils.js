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

// 🌟 [핵심] 키워드 차단 및 우측 데이터 정밀 포획 엔진
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        let lines = fullText.split(/\n/);
        
        // 탐지할 상호명 관련 키워드 (인식되면 이 단어는 출력 금지 및 우측 탐색 시작)
        const storeLabelRegex = /(상호명|상호\(법인명\)|상호|간판명|배송지명|업체명|법인명)/;
        // 탐색을 멈추게 하는 경계선 라벨들 (성명, 주소 등을 만나면 즉시 수집 중단)
        const stopLabels = /(성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액)/;

        // [1단계] 라벨 기반 우측 데이터 정밀 추출
        for (let line of lines) {
            if (storeLabelRegex.test(line)) {
                // 키워드 기준 우측 문자열 분리
                let parts = line.split(storeLabelRegex);
                if (parts.length >= 3) {
                    let rightSide = parts.slice(2).join(' ').trim();
                    let cleaned = cleanStoreValue(rightSide, stopLabels);
                    if (cleaned) return cleaned;
                }
            }
        }

        // [2단계] 줄바꿈 등으로 쪼개진 토큰들 순차 탐색
        let tokens = fullText.split(/[\s\n,;|]+/);
        for (let i = 0; i < tokens.length; i++) {
            let cleanTok = tokens[i].replace(/[^\w가-힣]/g, '');
            if (/^(상호명|상호|법인명|간판명|배송지명|업체명)$/.test(cleanTok)) {
                let collected = [];
                for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
                    let t = tokens[j].replace(/^[|:;()\[\]{}]+|[|:;()\[\]{}]+$/g, '').trim();
                    if (!t) continue;
                    // 경계 라벨이나 숫자, 주소 파편을 만나면 즉시 중단
                    if (stopLabels.test(t) || /^\d+$/.test(t) || /시$|구$|동$|로$|길$/.test(t)) break;
                    collected.push(t);
                }
                if (collected.length > 0) {
                    let res = collected.join(' ').replace(/[^\w가-힣\s]/g, '').trim();
                    if (res.length >= 2 && !stopLabels.test(res)) return res;
                }
            }
        }

        // [3단계 폴백] 키워드가 아예 없는 경우: 상호 접미사 패턴(맛집, 식당, 점 등) 단독 탐색
        let allTokens = fullText.split(/[\s\n]+/);
        const suffixRegex = /(맛집|식당|점|상회|상사|농원|농장|마트|카페|통닭|고기|나라|유통|물류|F&B|에프앤비)$/;
        for (let i = 0; i < allTokens.length; i++) {
            let tClean = allTokens[i].replace(/[^\w가-힣]/g, '');
            if (suffixRegex.test(tClean) && tClean.length >= 3) {
                if (/시$|구$|동$|로$|길$/.test(tClean)) continue;
                let storeName = tClean;
                if (i > 0) {
                    let prevClean = allTokens[i-1].replace(/[^\w가-힣]/g, '');
                    if (prevClean.length >= 2 && !/^\d+$/.test(prevClean) && !stopLabels.test(prevClean) && !/시$|구$|동$/.test(prevClean)) {
                        storeName = prevClean + ' ' + storeName;
                    }
                }
                if (!stopLabels.test(storeName)) return storeName;
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}

// 우측 추출 데이터 정제 및 경계선(Stop Label) 검증 함수
function cleanStoreValue(text, stopLabels) {
    if (!text) return null;
    let cleaned = text.replace(/^[|:;()\[\]{}]+|[|:;()\[\]{}]+$/g, '').trim();
    
    // 다음 라벨(성명, 주소 등)이 붙어있다면 그 앞까지만 깔끔하게 잘라냄
    let parts = cleaned.split(stopLabels);
    let target = parts[0].trim();
    
    // 주소나 숫자가 포함되어 있으면 상호명 영역까지만 남기고 차단
    target = target.replace(/(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주)[\s\S]*/g, '').trim();
    target = target.replace(/[0-9].*/g, '').trim();
    target = target.replace(/[^\w가-힣\s]/g, '').trim();
    
    if (target.length >= 2 && !stopLabels.test(target)) {
        return target;
    }
    return null;
}