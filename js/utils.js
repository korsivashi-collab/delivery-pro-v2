// js/utils.js

// 1. 클라이언트단 사진 안전 압축 (유지)
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

// 2. 전화번호 추출 로직 (유지)
export function extractPhoneLogic(text) {
    // ... (두 번째 파일의 extractPhoneLogic 내용과 동일하게 유지)
}

// 3. 스마트 주소 추출 로직 (유지)
export function extractAddressLogic(text) {
    // ... (두 번째 파일의 extractAddressLogic 내용과 동일하게 유지)
}

// 🌟 [1단계] 기존에 안정적으로 작동하던 정밀 키워드 탐색 엔진 (두 번째 파일 방식 적용)
function runBalancedStage1(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
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

// 🌟 [2단계] 주소 앵커 기준 4구역 배틀로얄 엔진 (Scoring System)
function run4QuadrantBattleStage2(fullText, addressStr) {
    try {
        let lines = fullText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
        let addressLineIdx = -1;

        // 1. 주소 라인 찾기 (앞의 8글자 정도만 매칭하여 유연성 확보)
        let addrSnippet = addressStr.substring(0, 8).replace(/\s/g, '');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].replace(/\s/g, '').includes(addrSnippet)) {
                addressLineIdx = i;
                break;
            }
        }
        
        if (addressLineIdx === -1) return null; 

        // 2. 4구역 배열 초기화
        let quadrants = { TL: [], TR: [], BL: [], BR: [] };

        const splitToTokens = (line) => line.split(/[\s,;|]+/).map(t => t.replace(/^[|:;()\[\]{}]+|[|:;()\[\]{}]+$/g, '').trim()).filter(t => t);

        // [윗구역 수집] 주소 위 최대 3줄
        for (let k = Math.max(0, addressLineIdx - 3); k < addressLineIdx; k++) {
            let tokens = splitToTokens(lines[k]);
            if (tokens.length === 0) continue;
            let mid = Math.ceil(tokens.length / 2);
            quadrants.TL.push(...tokens.slice(0, mid));
            quadrants.TR.push(...tokens.slice(mid));
        }

        // [아랫구역 수집] 주소 아래 최대 2줄
        for (let k = addressLineIdx + 1; k <= Math.min(lines.length - 1, addressLineIdx + 2); k++) {
            let tokens = splitToTokens(lines[k]);
            if (tokens.length === 0) continue;
            let mid = Math.ceil(tokens.length / 2);
            quadrants.BL.push(...tokens.slice(0, mid));
            quadrants.BR.push(...tokens.slice(mid));
        }

        // 3. 개별 토큰 기초 필터링 (주소, 번호, 쓸데없는 기호 삭제)
        const isJunkToken = (t) => {
            if (t.length < 2) return true;
            if (/^\d+$/.test(t) || /^[\d\-,.]+$/.test(t)) return true;
            if (/(010|02|031|032|033|041|042|043|044|051|052|053|054|055|061|062|063|064)-?/.test(t)) return true;
            if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|전라|경상|제주)/.test(t)) return true;
            if (/시$|구$|군$|동$|읍$|면$|로$|길$|층$/.test(t) && !t.includes('점') && !t.includes('식당')) return true;
            return false;
        };

        // 4. 배틀로얄 참가자 세팅 및 점수제 도입
        let candidates = [
            { name: 'TL', tokens: quadrants.TL.filter(t => !isJunkToken(t)), score: 10 }, // 좌상단 프리미엄 (가장 유력)
            { name: 'TR', tokens: quadrants.TR.filter(t => !isJunkToken(t)), score: 5 },  // 우상단
            { name: 'BL', tokens: quadrants.BL.filter(t => !isJunkToken(t)), score: 0 },  // 좌하단
            { name: 'BR', tokens: quadrants.BR.filter(t => !isJunkToken(t)), score: -5 }  // 우하단 (보통 금액란)
        ];

        const toxicWords = /잔액|금액|장소|아래|영수|합계|수량|단가|품목|규격|성명|수취인|공급자|보관용|과세|면세|할부|승인|카드|결제/;
        const storeSuffixes = /점$|식당$|카페$|상사$|기업$|마트$|편의점$|농원$|농장$|법인$|본점$|영업소$/;

        candidates.forEach(zone => {
            if (zone.tokens.length === 0) {
                zone.score = -9999; // 데이터가 없으면 즉시 탈락
                return;
            }
            
            let joinedText = zone.tokens.join(' ');
            
            // 영수증 하단 찌꺼기 단어가 있으면 치명타 (감점)
            if (toxicWords.test(joinedText)) zone.score -= 100;
            
            // 상호명스러운 접미사가 있으면 가산점
            if (storeSuffixes.test(joinedText)) zone.score += 50;
            
            // 문자열 길이가 적절하면 약간의 가산점 (상호명은 보통 3~10글자 사이)
            if (joinedText.length >= 3 && joinedText.length <= 15) zone.score += 10;
        });

        // 5. 점수순 내림차순 정렬 (최후의 승자 결정)
        candidates.sort((a, b) => b.score - a.score);

        let winner = candidates[0];
        
        // 승자의 점수가 양수이고 유효한 텍스트가 남아있다면 반환
        if (winner.score > 0 && winner.tokens.length > 0) {
            return [...new Set(winner.tokens)].join(' ');
        }

    } catch (e) {
        console.error("2차 배틀로얄 추출 오류:", e);
    }
    return null;
}

// 4. 🌟 최종 컨트롤러 (1차 엔진 실패 시 2차 4구역 배틀로얄 실행)
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    
    // [1차 시도] 기존 키워드 정밀 탐색
    let stage1Result = runBalancedStage1(fullText);
    if (stage1Result) return stage1Result;

    // [2차 시도] 주소 추출 후, 이를 기준으로 4구역 배틀로얄 실행
    let matchedAddrStr = extractAddressLogic(fullText); // utils에 이미 있는 함수 활용
    if (matchedAddrStr) {
        let stage2Result = run4QuadrantBattleStage2(fullText, matchedAddrStr);
        if (stage2Result) return stage2Result;
    }

    return null;
}