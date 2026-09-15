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
    
    candidates = [...new Set(candidates)];
    let bestPhone = null; 
    let highestScore = -1;
    for (let num of candidates) {
        let score = 0;
        let is010 = num.startsWith('010') && (num.length === 10 || num.length === 11);
        let is050 = num.startsWith('050') && (num.length === 11 || num.length === 12);
        let isRep = /^1[5-9]\d{6}$/.test(num); 
        if (is010) score += 100; 
        else if (is050) score += 90; 
        else if (isRep) score += 70; 
        else score -= 100; 
        
        if (score > highestScore && score > 0) { 
            highestScore = score; 
            bestPhone = num; 
        }
    }
    
    if (bestPhone) {
        let p = bestPhone;
        if (p.length === 11) return p.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
        if (p.length === 10) return p.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
        return p;
    }
    return null;
}

// 3. 스마트 주소 추출 로직 (기준선 앵커 용도)
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

// 🌟 [1단계] 기존에 안정적으로 작동하던 정밀 키워드 탐색 엔진
function runBalancedStage1(fullText) {
    try {
        let tokens = fullText.split(/[\s\n]+/);
        let badWords = new Set();

        for (let i = 0; i < tokens.length; i++) {
            let cleanT = tokens[i].replace(/[^\w가-힣]/g, '');
            if (/^\d{10}$/.test(cleanT) && tokens[i+1]) badWords.add(tokens[i+1].replace(/[^\w가-힣]/g, ''));
            if (/구매자명|성명/.test(cleanT) && tokens[i+1]) badWords.add(tokens[i+1].replace(/[^\w가-힣]/g, ''));
        }

        const targets = ['배송지명', '간판명', '상호명', '상호', '업체명', '법인명'];
        const skips = ['연락처', '전화번호', '주소', '구매자명', '사업자등록번호', '공급가액', '세액', '단가', '수량', '공급받는자', '총액'];

        const isJunk = (rawStr) => {
            let s = rawStr.replace(/[^\w가-힣]/g, ''); 
            if (!s || s.length < 2) return true; 
            if (/^\d+$/.test(s) || /^0[1-9]\d{6,}/.test(s)) return true; 
            if (badWords.has(s)) return true; 
            if (/시$|구$|군$|동$|읍$|면$|로$|길$|층$/.test(s) && !s.includes('점')) return true; 
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
                    
                    if (j + 1 < tokens.length) {
                        let nextClean = tokens[j+1].replace(/[^\w가-힣]/g, '');
                        if (/시$|구$|군$|동$|읍$|면$|로$|길$/.test(nextClean) && !nextClean.includes('점')) continue;
                    }
                    collected.push(tok.replace(/[^\w가-힣]/g, ''));
                }

                if (collected.length > 0) {
                    let unique = [...new Set(collected)];
                    let result = unique.join(' ').replace(/간판명|배송지명|상호명|상호|업체명|법인명/g, '').trim();
                    if (result.length >= 2) return result;
                }
            }
        }
    } catch (e) {}
    return null;
}

// 🌟 [2단계] 주소 38선 기준 4구역 배틀로얄 (비교 및 삭제) 엔진
function run4QuadrantBattleStage2(fullText) {
    try {
        let lines = fullText.split(/\n/);
        let addressLineIdx = -1;
        let matchedAddrStr = extractAddressLogic(fullText);

        // 1. 주소 라인 (38선) 찾기
        for (let i = 0; i < lines.length; i++) {
            if (matchedAddrStr && lines[i].includes(matchedAddrStr.substring(0, 10))) {
                addressLineIdx = i;
                break;
            }
        }
        
        if (addressLineIdx === -1) return null; // 주소가 없으면 2단계 작동 불가

        // 2. 4구역 배열 초기화
        let quadrants = {
            TL: [], TR: [], // 윗줄 좌, 우
            BL: [], BR: []  // 아랫줄 좌, 우
        };

        // [윗구역 수집] (주소 라인 제외, 위로 최대 3줄)
        for (let k = Math.max(0, addressLineIdx - 3); k < addressLineIdx; k++) {
            let tokens = lines[k].split(/[\s,;|]+/).map(t => t.replace(/^[|:;()\[\]{}]+|[|:;()\[\]{}]+$/g, '').trim()).filter(t => t);
            if (tokens.length === 0) continue;
            
            let mid = Math.ceil(tokens.length / 2); // 반으로 갈라 좌우 배정
            quadrants.TL.push(...tokens.slice(0, mid));
            quadrants.TR.push(...tokens.slice(mid));
        }

        // [아랫구역 수집] (주소 라인 제외, 아래로 최대 2줄)
        for (let k = addressLineIdx + 1; k <= Math.min(lines.length - 1, addressLineIdx + 2); k++) {
            let tokens = lines[k].split(/[\s,;|]+/).map(t => t.replace(/^[|:;()\[\]{}]+|[|:;()\[\]{}]+$/g, '').trim()).filter(t => t);
            if (tokens.length === 0) continue;
            
            let mid = Math.ceil(tokens.length / 2);
            quadrants.BL.push(...tokens.slice(0, mid));
            quadrants.BR.push(...tokens.slice(mid));
        }

        // 3. 개별 토큰 삭제 필터 (숫자 탈락, 2글자 미만 탈락, 행정구역 탈락)
        const filterTokens = (tokens) => {
            return tokens.filter(t => {
                if (t.length < 2) return false; // 글씨수 부족 탈락
                if (/^\d+$/.test(t) || /^[\d\-,.]+$/.test(t)) return false; // 순수 숫자 탈락
                if (/(010|02|031|032|033|041|042|043|044|051|052|053|054|055|061|062|063|064)-?/.test(t)) return false; // 전화번호 탈락
                if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주)/.test(t)) return false; // 주소 파편 탈락
                if (/시$|구$|군$|동$|읍$|면$|로$|길$|층$/.test(t) && !t.includes('점') && !t.includes('식당')) return false;
                return true;
            });
        };

        quadrants.TL = filterTokens(quadrants.TL);
        quadrants.TR = filterTokens(quadrants.TR);
        quadrants.BL = filterTokens(quadrants.BL);
        quadrants.BR = filterTokens(quadrants.BR);

        // 4. [핵심] 구역 폭파 (Zone Killer) 조건
        // 구역 내에 영수증 표 관련 찌꺼기 단어가 하나라도 있다면 그 구역은 설명문/금액란이므로 통째로 삭제
        const toxicWords = /잔액|금액|장소|아래|영수|합계|수량|단가|품목|규격|성명|수취인|공급자|보관용/;
        
        const isToxicZone = (tokens) => tokens.some(t => toxicWords.test(t));
        
        if (isToxicZone(quadrants.TL)) quadrants.TL = [];
        if (isToxicZone(quadrants.TR)) quadrants.TR = [];
        if (isToxicZone(quadrants.BL)) quadrants.BL = [];
        if (isToxicZone(quadrants.BR)) quadrants.BR = [];

        // 5. 최후의 1구역 선정 (남아있는 구역 중 상호명 위치 확률이 높은 순서대로 우선순위 반환)
        if (quadrants.TL.length > 0) return [...new Set(quadrants.TL)].join(' ');
        if (quadrants.TR.length > 0) return [...new Set(quadrants.TR)].join(' ');
        if (quadrants.BL.length > 0) return [...new Set(quadrants.BL)].join(' ');
        if (quadrants.BR.length > 0) return [...new Set(quadrants.BR)].join(' ');

    } catch (e) {}
    return null;
}

// 4. 🌟 최종 컨트롤러 (1차 엔진 실패 시 2차 4구역 배틀로얄 실행)
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    
    // [1차 시도] 기존 키워드 정밀 탐색
    let stage1Result = runBalancedStage1(fullText);
    if (stage1Result) return stage1Result;

    // [2차 시도] 주소 38선 기준 4구역 비교 및 삭제 방식
    let stage2Result = run4QuadrantBattleStage2(fullText);
    if (stage2Result) return stage2Result;

    return null;
}