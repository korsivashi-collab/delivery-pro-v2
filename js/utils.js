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

// 2. OCR 텍스트에서 전화번호 추출 로직
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

// [1단계] 엄격 정밀 키워드 탐색 엔진
function runStrictStage1(fullText) {
    try {
        let tokens = fullText.split(/[\s\n]+/);
        let badWords = new Set();

        for (let i = 0; i < tokens.length; i++) {
            let cleanT = tokens[i].replace(/[^\w가-힣]/g, '');
            if (/^\d{10}$/.test(cleanT) && tokens[i+1]) badWords.add(tokens[i+1].replace(/[^\w가-힣]/g, ''));
            if (/구매자명|성명|수취인|대표/.test(cleanT) && tokens[i+1]) badWords.add(tokens[i+1].replace(/[^\w가-힣]/g, ''));
        }

        const targets = ['배송지명', '간판명', '상호명', '상호', '업체명', '법인명'];
        const skips = ['연락처', '전화번호', '주소', '구매자명', '사업자등록번호', '공급가액', '세액', '단가', '수량', '공급받는자', '총액', '출고액', '입금액', '잔액', '성명', '수취인'];

        const isJunk = (rawStr) => {
            let s = rawStr.replace(/[^\w가-힣]/g, ''); 
            if (!s || s.length < 2) return true; 
            if (/^\d+$/.test(s) || /^0[1-9]\d{6,}/.test(s)) return true; 
            if (badWords.has(s)) return true; 
            if (/^(tel|fax|el)$/i.test(s)) return true;
            
            if (/^(법인명|상호|업체명|간판명|배송지명|상인명|공급자|공급자용|보관용|사업자|등록|대표자|대표|성명|이름|수취인|받으시는분|담당자)$/i.test(s)) return true;

            if (/시$|구$|군$|동$|읍$|면$|로$|길$|층$/.test(s) && !s.includes('점') && !s.includes('식당')) return true; 
            if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주)/.test(s)) return true;
            if (rawStr.includes('[') || rawStr.includes(']')) return true; 
            return false;
        };

        for (let i = 0; i < tokens.length; i++) {
            if (targets.some(kw => tokens[i].includes(kw))) {
                let collected = [];
                for (let j = i + 1; j < Math.min(i + 12, tokens.length); j++) {
                    let tok = tokens[j];
                    if (skips.some(skw => tok.includes(skw))) {
                        if (collected.length > 0) break; 
                        continue; 
                    }
                    if (isJunk(tok)) continue; 

                    collected.push(tok.replace(/^[|:;\[\]{}]+|[|:;\[\]{}]+$/g, '').trim());
                }

                if (collected.length > 0) {
                    let unique = [...new Set(collected)];
                    let result = unique.join(' ').replace(/간판명|배송지명|상호명|상호|업체명|법인명/g, '').trim();
                    
                    const trailingNoise = /(조사|원산지|제조사|출고액|잔액|법인명|성명|수취인).*$/;
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

// [2단계] 주소 앵커 기준 상하단 구역 + 연쇄 비교 삭제 엔진
function runAnchorFunnelStage2(fullText) {
    try {
        let lines = fullText.split(/\n/);
        let addressLineIdx = -1;

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (/(로|길|동|읍|면|리)\s*\d+/.test(line) && /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주|[시구군])/.test(line)) {
                addressLineIdx = i;
                break;
            }
        }

        let scanLines = [];
        if (addressLineIdx !== -1) {
            if (addressLineIdx - 1 >= 0) scanLines.push(lines[addressLineIdx - 1]);
            if (addressLineIdx + 1 < lines.length) scanLines.push(lines[addressLineIdx + 1]);
        } else {
            scanLines = lines;
        }

        let targetTokens = [];
        for (let l of scanLines) {
            let tokens = l.split(/[\s,;|]+/);
            for (let t of tokens) {
                let clean = t.replace(/^[|:;()\[\]{}]+|[|:;()\[\]{}]+$/g, '').trim();
                if (clean) targetTokens.push(clean);
            }
        }

        let funnel = targetTokens;

        funnel = funnel.filter(t => t.length >= 2);
        funnel = funnel.filter(t => !/^[\d\-,.]+$/.test(t) && !/^\d+$/.test(t));
        funnel = funnel.filter(t => !/(010|02|031|032|033|041|042|043|044|051|052|053|054|055|061|062|063|064)-?/.test(t));

        const strictForbidden = new Set([
            '성명', '이름', '수취인', '받으시는분', '담당자', '법인명', '공급자', 
            '등록', '사업자', '대표', '주소', '소재지', '연락처', '전화', '전화번호',
            'tel', 'fax', 'el', '공급가액', '세액', '단가', '수량', '총액', '출고액', 
            '입금액', '잔액', '합계', '영수', '청구', '품목', '품명', '규격', '단위',
            '업장명', '상호', '상호명', '간판명', '배송지명', '상인명', '공급자용', '보관용'
        ]);
        funnel = funnel.filter(t => !strictForbidden.has(t.toLowerCase()));

        funnel = funnel.filter(t => {
            if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주)/.test(t)) return false;
            if (/시$|구$|군$|동$|읍$|면$|로$|길$|층$/.test(t) && !t.includes('점') && !t.includes('식당')) return false;
            return true;
        });

        let survivedTokens = [...new Set(funnel)];
        if (survivedTokens.length > 0) {
            return survivedTokens.slice(0, 2).join(' ');
        }
    } catch (e) {}
    return null;
}

// 4. 최종 컨트롤러
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    
    let stage1Result = runStrictStage1(fullText);
    if (stage1Result) return stage1Result;

    let stage2Result = runAnchorFunnelStage2(fullText);
    if (stage2Result) return stage2Result;

    return null;
}