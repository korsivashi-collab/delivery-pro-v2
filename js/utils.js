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

// 3. 🌟 스마트 주소 추출 로직 (행정구역 자동 감지 및 탐욕 방지 적용)
export function extractAddressLogic(text) {
    if (!text || typeof text !== 'string') return null;
    try {
        let flatText = text.replace(/\n/g, ' ').replace(/\s+/g, ' ');

        let regionPrefixedRegex = /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도|시)?\s+[가-힣\s]+(?:구|군|시)\s+[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면|리)\s*\d+(?:-\d+)?(?:\s*,\s*\([가-힣\s]+\))?)/g;
        
        let matches = [...flatText.matchAll(regionPrefixedRegex)];
        if (matches && matches.length > 0) {
            return matches[matches.length - 1][0].trim().replace(/\s+/g, ' ');
        }

        let backupRegex = /((?:[가-힣a-zA-Z0-9]+\s+){1,4}[가-힣a-zA-Z0-9]+(?:동|읍|면|리|대로|로|길)\s*\d+(?:-\d+)?)/g;
        let matches2 = [...flatText.matchAll(backupRegex)];
        if (matches2 && matches2.length > 0) {
            let candidate = matches2[matches2.length - 1][0].trim();
            candidate = candidate.replace(/^.*?(사업장\s*주소|주소|소재지|책임판매원|판매원|제조원)\s*[\:\-]?\s*/i, '');
            if (candidate.length > 5) return candidate.replace(/\s+/g, ' ');
        }
    } catch (e) {} 
    return null;
}

// 4. 🌟 성능 최적화 utils_3 버전 + "세로 읽기 방어 및 동적 이름 차단기" 탑재
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        let tokens = fullText.split(/[\s\n,;|]+/);
        let badWords = new Set(); // 여기에 잡동사니와 사람 이름이 들어갑니다.

        // [방어막 1] 표 헤더 단어들 (발견해도 멈추지 않고 폴짝 뛰어넘음)
        const skips = [
            '연락처', '전화번호', '주소', '구매자명', '사업자등록번호', '공급가액', '세액', '단가', '수량', 
            '공급받는자', '총액', '성명', '이름', '대표', '대표자', '종목', '업태', '제조사', '원산지',
            '청구', '영수', '품목', '품명', '규격', '사업장', '소재지', '합계', '금액', '잔액',
            'tel', 'fax', 'el', '명', '태', '동'
        ];

        // [방어막 2] 완벽한 쓰레기값 판별기
        const isJunk = (rawStr) => {
            let s = rawStr.replace(/[^\w가-힣]/g, ''); 
            if (!s || s.length < 2) return true; // 1글자짜리 찌꺼기 무시
            if (/^[\d\-,.]+$/.test(rawStr)) return true; // 528,000 같은 순수 숫자 무시
            if (/^\d+$/.test(s) || /^0[1-9]\d{6,}/.test(s)) return true; // 전화번호 무시
            if (s.toLowerCase() === 'el' || s.toLowerCase() === 'tel' || s.toLowerCase() === 'fax') return true;
            
            // 주소 파편 무시 (단, 식당 이름이나 지점명은 살려줌!)
            if (/시$|구$|군$|동$|읍$|면$|로$|길$|층$/.test(s) && !s.includes('점') && !s.includes('식당')) return true; 
            if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주)/.test(s)) return true;
            return false;
        };

        // 🌟 [핵심 고도화] 동적 이름 차단기 (전규복, 정돌섭 등을 찾아내서 블랙리스트에 추가)
        const nameHeaders = ['구매자명', '성명', '이름', '대표자', '대표'];
        for (let i = 0; i < tokens.length; i++) {
            if (nameHeaders.some(nh => tokens[i].includes(nh))) {
                // 이름 헤더 밑으로 최대 20칸을 뒤져서 진짜 사람 이름을 찾아냄
                for (let j = i + 1; j < Math.min(i + 25, tokens.length); j++) {
                    let tok = tokens[j];
                    if (skips.some(sk => tok.toLowerCase().includes(sk.toLowerCase()))) continue;
                    if (isJunk(tok)) continue;
                    
                    // 찾아낸 사람 이름을 블랙리스트(badWords)에 영구 등록!
                    let cleanName = tok.replace(/[^\w가-힣]/g, '');
                    badWords.add(cleanName);
                    break; 
                }
            }
        }

        // 🌟 상호명 본격 탐색 시작
        const targets = ['배송지명', '간판명', '상호명', '상호', '업체명', '상인명'];
        
        for (let i = 0; i < tokens.length; i++) {
            if (targets.some(kw => tokens[i].includes(kw))) {
                let collected = [];
                // 세로로 꼬인 표를 다 건너뛰기 위해 탐색 거리를 35칸으로 대폭 늘림
                for (let j = i + 1; j < Math.min(i + 35, tokens.length); j++) {
                    let tok = tokens[j];
                    let cleanTok = tok.replace(/[^\w가-힣]/g, '');
                    
                    // 표 헤더(연락처, 공급가액 등)를 만나면 가볍게 무시하고 다음 칸으로 전진
                    if (skips.some(skw => tok.toLowerCase().includes(skw.toLowerCase()))) continue; 
                    if (isJunk(tok)) continue; 
                    
                    // 🌟 블랙리스트에 등록된 사람 이름(전규복 등)이면 상호명에 절대 끼워주지 않음!
                    if (badWords.has(cleanTok)) continue; 

                    // 특수기호 껍데기만 살짝 벗겨서 수집 ((주) 같은 괄호는 보존)
                    let finalTok = tok.replace(/^[|:;\[\]{}]+|[|:;\[\]{}]+$/g, '');
                    if (finalTok) {
                        collected.push(finalTok);
                    }
                    
                    // 상호명은 보통 4어절을 넘지 않으므로 4개 모으면 퇴근
                    if (collected.length >= 4) break; 
                }

                if (collected.length > 0) {
                    // 혹시라도 타겟 단어가 섞여 들어왔다면 청소
                    let result = collected.join(' ').replace(/간판명|배송지명|상호명|상호|업체명|상인명/g, '').trim();
                    result = result.replace(/^[\]) :;|]+|[\[( :;|]+$/g, '').trim();
                    
                    if (result.length >= 2 && result !== '(주)' && result !== '주식회사') {
                        // '사브향 사브향' 처럼 중복 인식된 단어가 있으면 하나로 합쳐주는 센스
                        let resTokens = result.split(' ');
                        let uniqueRes = [...new Set(resTokens)];
                        return uniqueRes.join(' ');
                    }
                }
            }
        }
    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}