// js/utils.js

// 1. 클라이언트단 사진 안전 압축
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

// 2. 전화번호 추출 로직
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

// 3. 스마트 주소 추출 로직
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

// 🌟 4. [패러다임 전환] 가중치 점수 모델(Scoring System) 도입 상호명 추출
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;

    try {
        // 1. 방해물(노이즈) 텍스트 공백 치환
        let cleanText = fullText.replace(/\n/g, ' ');
        
        // 주소, 전화번호, 사업자번호, 금액 패턴 삭제
        const addressRegex = /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면|리)\s*\d+(?:-\d+)?)/g;
        cleanText = cleanText.replace(addressRegex, ' ');
        cleanText = cleanText.replace(/(010|050\d|070|0[2-9][0-9]?|1[5-9]\d{2})[\s\-\.]*(\d{3,4})[\s\-\.]*(\d{4})/g, ' ');
        cleanText = cleanText.replace(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/g, ' ');
        cleanText = cleanText.replace(/\b\d{1,3}(,\d{3})+(\s*원)?\b/g, ' ');

        // (주), (유) 같은 법인 텍스트 보존을 위한 치환
        cleanText = cleanText.replace(/\(주\)/g, '주식회사').replace(/\(유\)/g, '유한회사');

        // 2. 단어 덩어리(1-gram, 2-gram) 추출 ('밥은화 명지대점' 같은 띄어쓰기 상호 보존)
        const breakRegex = /[\(\)\[\]\{\}\<\>\/,\+|;:]+/; // 괄호 등은 자르되 띄어쓰기는 유지
        let chunks = cleanText.split(breakRegex).filter(c => c.trim().length > 0);
        
        let allWords = [];
        chunks.forEach(chunk => {
            let words = chunk.split(/\s+/).filter(w => w.length > 0);
            for(let i = 0; i < words.length; i++) {
                allWords.push(words[i]); // 단일 단어
                if (i < words.length - 1) {
                    allWords.push(words[i] + " " + words[i+1]); // 두 단어 결합 (예: 밥은화 명지대점)
                }
            }
        });

        // 3. 블랙리스트 (절대 상호가 될 수 없는 라벨 단어들)
        const stopLabels = /^(성명|대표자?|사업장소재지|사업장|주소|업태|종목|전화|연락처|등록번호|공급받는자|공급자|규격|단위|제조사|원산지|수량|단가|총액|합계|잔액|영수|청구|일반음식|한식|음식|과세|면세|품목|금액|비고|아래|금액을|영수함|청구함|인)$/;
        
        // 🚨 사람 이름 초강력 동적 블랙리스트 구축 (강경운, 윤희영 원천 차단)
        let personNames = new Set();
        let rawWords = fullText.split(/[\s\n\(\)\[\]]+/); // 모든 공백, 괄호로 완전 분해
        for (let i = 0; i < rawWords.length; i++) {
            if (/(성명|대표자?|담당자?)/.test(rawWords[i])) {
                // 라벨이 발견되면, 그 주변 3단어 이내에 있는 2~4글자 이름 색출
                for (let j = 1; j <= 3; j++) {
                    if (i + j < rawWords.length) {
                        let name = rawWords[i+j].replace(/[^\w가-힣]/g, '');
                        if (name.length >= 2 && name.length <= 4 && !stopLabels.test(name)) {
                            personNames.add(name);
                        }
                    }
                }
            }
        }

        // 4. 상호명 접미사 힌트 사전
        const storeSuffixes = /(점|식당|식육|가든|회관|맛집|카페|커피|베이커리|상회|상사|유통|물류|농산|수산|축산|농원|농장|마트|편의점|약국|의원|치킨|피자|버거|통닭|고기|나라|F&B|에프앤비|푸드|주식회사|유한회사|탕|집|관)$/;

        // 5. 후보군 채점 (Scoring) 시작
        let candidates = {};
        
        for (let word of allWords) {
            let cleanWord = word.replace(/[^\w가-힣\s]/g, '').trim();
            
            // 필터 조건 (쓰레기 단어는 채점판에 올리지 않음)
            if (cleanWord.length < 2 || cleanWord.length > 15) continue;
            if (stopLabels.test(cleanWord.replace(/\s/g,''))) continue;
            if (/^\d+$/.test(cleanWord.replace(/\s/g,''))) continue; 
            
            // 이름 블랙리스트에 단어의 일부라도 걸리면 즉시 탈락
            let nameBlocked = false;
            let subWords = cleanWord.split(' ');
            for (let sub of subWords) {
                if (personNames.has(sub)) nameBlocked = true;
            }
            if (nameBlocked) continue;

            if (!candidates[cleanWord]) candidates[cleanWord] = 0;

            let score = 0;

            // [가중치 1] 상호 접미사 포함 여부 (+50점)
            if (storeSuffixes.test(cleanWord)) score += 50;

            // [가중치 2] 문서 내 앵커(배송지명, 상호명)와의 물리적 거리 (+30점)
            let anchorIdx = Math.max(fullText.indexOf('상호'), fullText.indexOf('간판명'), fullText.indexOf('배송지명'));
            if (anchorIdx !== -1) {
                let wordIdx = fullText.indexOf(cleanWord.split(' ')[0]);
                let dist = Math.abs(wordIdx - anchorIdx);
                // 앵커와 가까운 위치(50글자 이내)에 있으면 점수 획득
                if (dist > 0 && dist < 50) score += 30;
            }

            // [페널티] 공급자(납품업체) 영역에 있으면 배제 (-100점) -> '물봉' 차단
            let supplierIdx = fullText.indexOf('공급자');
            let receiverIdx = Math.max(fullText.indexOf('공급받는'), fullText.indexOf('배송지명'));
            if (supplierIdx !== -1) {
                let wordIdx = fullText.indexOf(cleanWord.split(' ')[0]);
                // 단어가 공급자 근처에 있고, 배송지 영역보다 상단/좌측에 나왔다면 100% 납품업체이므로 감점
                if (wordIdx > supplierIdx && (receiverIdx === -1 || wordIdx < receiverIdx)) {
                    score -= 100;
                }
            }

            candidates[cleanWord] += score;
        }

        // 6. 1등 단어 선정 (가장 점수가 높은 단어)
        let bestWord = null;
        let highestScore = 0; // 최소 점수 0점 (근거 없는 단어 뱉기 방지)

        for (let word in candidates) {
            if (candidates[word] > highestScore) {
                highestScore = candidates[word];
                bestWord = word;
            }
        }

        if (bestWord) {
            // 주식회사로 풀어서 계산했던 것을 다시 (주)로 깔끔하게 롤백하여 출력
            return bestWord.replace('주식회사', '(주)').replace('유한회사', '(유)');
        }

        return null;

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}