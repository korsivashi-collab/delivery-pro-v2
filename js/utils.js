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

// 3. 🌟 스마트 주소 추출 로직
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

// 🌟 [핵심] 상위 5대 성씨(김, 이, 박, 최, 정) 기반 인명 판별기
function isKoreanName(str) {
    if (!str) return false;
    let clean = str.replace(/[^\w가-힣]/g, '');
    if (clean.length < 2 || clean.length > 3) return false;
    
    // 대한민국 상위 5대 성씨로 축소 (엄마손 등의 오인식 방지)
    const majorSurnames = ['김', '이', '박', '최', '정'];
    return majorSurnames.includes(clean[0]);
}

// 🌟 [1단계] 정밀 키워드 탐색 엔진
function runStage1(fullText) {
    try {
        let tokens = fullText.split(/[\s\n]+/);
        let badWords = new Set();

        for (let i = 0; i < tokens.length; i++) {
            let cleanT = tokens[i].replace(/[^\w가-힣]/g, '');
            if (/^\d{10}$/.test(cleanT) && tokens[i+1]) badWords.add(tokens[i+1].replace(/[^\w가-힣]/g, ''));
            if (/구매자명|성명|대표/.test(cleanT) && tokens[i+1]) badWords.add(tokens[i+1].replace(/[^\w가-힣]/g, ''));
        }

        const targets = ['배송지명', '간판명', '상호명', '상호', '업체명', '상인명', '(간판명)', '법인명'];
        const skips = ['연락처', '전화번호', '주소', '구매자명', '사업자등록번호', '공급가액', '세액', '단가', '수량', '공급받는자', '총액', '출고액', '입금액', '잔액'];

        const isJunk = (rawStr) => {
            let s = rawStr.replace(/[^\w가-힣]/g, ''); 
            if (!s || s.length < 2) return true; 
            if (/^\d+$/.test(s) || /^0[1-9]\d{6,}/.test(s)) return true; 
            if (badWords.has(s)) return true; 
            if (/^(tel|fax|el)$/i.test(s)) return true;
            
            if (isKoreanName(s)) return true;

            if (/^(법인명|상호|업체명|간판명|배송지명|상인명|공급자|공급자용|보관용|사업자|등록|대표자|대표|성명|이름)$/i.test(s)) return true;
            
            if (/시$|구$|군$|동$|읍$|면$|로$|길$|층$/.test(s) && !s.includes('점') && !s.includes('식당')) return true; 
            if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주)/.test(s)) return true;
            if (rawStr.includes('[') || rawStr.includes(']')) return true; 
            return false;
        };

        for (let i = 0; i < tokens.length; i++) {
            if (targets.some(kw => tokens[i].includes(kw))) {
                let collected = [];
                for (let j = i + 1; j < Math.min(i + 15, tokens.length); j++) {
                    let tok = tokens[j];
                    if (skips.some(skw => tok.includes(skw))) {
                        if (collected.length > 0) break; 
                        continue; 
                    }
                    if (isJunk(tok)) continue; 

                    let cleanTokCheck = tok.replace(/[^\w가-힣]/g, '');
                    if (isKoreanName(cleanTokCheck)) break;

                    if (j + 1 < tokens.length) {
                        let nextClean = tokens[j+1].replace(/[^\w가-힣]/g, '');
                        if (/시$|구$|군$|동$|읍$|면$|로$|길$/.test(nextClean) && !nextClean.includes('점')) {
                            continue;
                        }
                    }

                    collected.push(tok.replace(/^[|:;\[\]{}]+|[|:;\[\]{}]+$/g, '').trim());
                }

                if (collected.length > 0) {
                    let unique = [...new Set(collected)];
                    let result = unique.join(' ').replace(/간판명|배송지명|상호명|상호|업체명|상인명|\(간판명\)|법인명/g, '').trim();
                    
                    // 🌟 음식 이름(한식 등)은 꼬리표에서 제외하여 한촌설렁탕 등이 보호되도록 함
                    const trailingNoise = /(조사|원산지|제조사|정돌섭|전규복|권진우|이영석|출고액|잔액|법인명).*$/;
                    result = result.replace(trailingNoise, '').trim();
                    result = result.replace(/^[)\]}]+|[)\]}]+$/g, '').trim();

                    if (result.length >= 2 && !/^(tel|fax|el)$/i.test(result)) {
                        return result;
                    }
                }
            }
        }
    } catch (e) {}
    return null;
}

// 🌟 [2단계] 네거티브 필터링 백업 시스템
function runStage2(fullText) {
    try {
        let text = fullText.replace(/[\n\t\r]+/g, ' ').replace(/\s{2,}/g, ' ');
        
        let addr = extractAddressLogic(fullText);
        if (addr) text = text.replace(addr, ' ');

        const negativeWords = new Set([
            '공급가액', '세액', '단가', '수량', '총액', '출고액', '입금액', '전잔액', '잔액', 
            '합계', '영수', '청구', '품목', '품명', '규격', '단위', '사업자등록번호', '구매자명', 
            '성명', '이름', '대표', '대표자', '주소', '소재지', '연락처', '전화', '전화번호', 
            'tel', 'fax', 'el', '공급받는자', '공급자', '제조사', '원산지', '비고', '업태', '종목', 
            '사업장', '조사', '구수', '구수동', '간판명', '배송지명', '상호명', '상호', '업체명', '상인명',
            '국내산', '수입산', '공급자용', '보관용', '인수자', '확인', '일자', '번호', '거래명세표', '법인명', '등록'
        ]);

        let tokens = text.split(' ');
        let validTokens = [];

        for (let tok of tokens) {
            let clean = tok.replace(/^[|:;()\[\]{}]+|[|:;()\[\]{}]+$/g, '').trim();
            if (!clean || clean.length < 2) continue;
            if (/^[\d\-,.]+$/.test(clean)) continue;
            if (clean.includes('010') || clean.includes('02-') || clean.includes('031-')) continue;
            if (negativeWords.has(clean.toLowerCase())) continue;
            if (isKoreanName(clean)) continue;
            if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주)/.test(clean)) continue;

            validTokens.push(clean);
        }

        if (validTokens.length > 0) {
            let candidate = validTokens.slice(0, 3).join(' ');
            if (candidate.length >= 2) {
                return candidate;
            }
        }
    } catch (e) {}
    return null;
}

// 4. 🌟 다단 필터링 컨트롤러
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    
    let stage1Result = runStage1(fullText);
    if (stage1Result) return stage1Result;

    let stage2Result = runStage2(fullTest);
    if (stage2Result) return stage2Result;

    return null;
}