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

// 🌟 4. [4세대] 네거티브(배제) 필터링 기반 섹터 스캔 상호 추출 로직
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        // [사전 준비] 추출된 주소를 가져와서 네거티브 필터용으로 분해해 둡니다.
        const extractedAddress = extractAddressLogic(fullText) || "";
        const addrTokens = extractedAddress.split(/\s+/);

        // [네거티브 필터 함수 정의] 상호가 될 수 없는 조건들 (대표님 제안)
        const isInvalidToken = (str) => {
            let pureText = str.replace(/[\(\)]/g, ''); // 괄호 제거 후 검사
            
            // 1. 사업자번호 양식 (000-00-00000)
            if (/^\d{3}-\d{2}-\d{5}$/.test(pureText)) return true;
            // 2. 전화번호 양식
            if (/^(010|02|0[3-9]\d)-?\d{3,4}-?\d{4}$/.test(pureText) || /^\d{8,12}$/.test(pureText)) return true;
            // 3. 주문번호 (영문+숫자 혼합)
            if (/(?=.*[a-zA-Z])(?=.*\d)[a-zA-Z\d-]{4,}/.test(pureText)) return true;
            // 4. 순수 숫자 또는 금액 (콤마 포함)
            if (/^[0-9,]+$/.test(pureText)) return true;
            // 5. 표 라벨 노이즈
            if (/^(성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|단가|수량|규격|품목|비고|구분|일자|월|일|합계)$/.test(pureText)) return true;
            // 6. 단독 부속어
            if (/^(주|유|주식회사|유한회사)$/.test(pureText)) return true;
            // 7. 주소에 포함된 단어 (주소 중복 방지)
            if (addrTokens.includes(str) || /동$|구$|시$|면$|읍$|리$|로\d*길?$/.test(pureText)) return true;

            return false; // 위 지옥의 필터를 모두 통과하면 상호 후보로 생존(false)
        };

        let lines = fullText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
        const anchors = ['상호', '법인', '배송', '간판', '업체명', '공급받는자'];

        // [1차 시도] 앵커 기반 위아래 섹터 스캔
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            
            for (let anchor of anchors) {
                if (line.includes(anchor)) {
                    let survivors = []; // 살아남은 단어들을 담을 배열

                    // 섹터 스캔 (위로 1줄, 현재 줄 우측, 아래로 2줄)
                    let sectorLines = [];
                    if (i > 0) sectorLines.push(lines[i-1]); // 위로 1칸
                    sectorLines.push(line.substring(line.indexOf(anchor) + anchor.length)); // 현재 줄 우측
                    if (i + 1 < lines.length) sectorLines.push(lines[i+1]); // 아래로 1칸
                    if (i + 2 < lines.length) sectorLines.push(lines[i+2]); // 아래로 2칸

                    // 수집한 섹터를 토큰으로 쪼개어 네거티브 필터에 통과시킴
                    for (let sLine of sectorLines) {
                        let tokens = sLine.split(/[\s,:;\|]+/).filter(w => w.trim().length > 0);
                        
                        for (let token of tokens) {
                            let cleanTok = token.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
                            
                            // 네거티브 필터 통과 & 2글자 이상인 경우만 생존
                            if (cleanTok.length >= 2 && !isInvalidToken(cleanTok)) {
                                survivors.push(cleanTok);
                            }
                        }
                    }

                    // 살아남은 조각 조립
                    if (survivors.length > 0) {
                        // 중복 단어 제거 (예: 위아래 줄에서 겹치게 읽힌 경우)
                        survivors = [...new Set(survivors)];
                        let finalName = survivors.join(' '); 
                        
                        // 분리된 괄호 밀착 (예: 원조남산왕돈가스 (주) -> 원조남산왕돈가스(주))
                        finalName = finalName.replace(/\s+\(/g, '(');
                        
                        if (finalName.length >= 2) return finalName;
                    }
                }
            }
        }

        // [2차 시도] 최후의 보루: 주소 뒷부분 꼬리표 교집합 검증
        if (extractedAddress) {
            let flatText = fullText.replace(/\n/g, ' ');
            let idx = flatText.indexOf(extractedAddress);
            
            if (idx !== -1) {
                let tailStr = flatText.substring(idx + extractedAddress.length).trim();
                // 층수 등 불필요한 꼬리표 1차 제거
                tailStr = tailStr.replace(/^[,\s]*(지하\s*\d+층|지상\s*\d+층|B?\d+층|\d+층|[가-힣]+\([가-힣]+\)|[가-힣]+동)\s*/, '');
                
                let tailTokens = tailStr.split(/[\s,:;\|]+/).filter(w => w.trim().length > 0);
                
                for (let token of tailTokens) {
                    let cleanTok = token.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
                    
                    // 네거티브 필터를 통과한 꼬리표 단어가...
                    if (cleanTok.length >= 2 && !isInvalidToken(cleanTok)) {
                        let headText = flatText.substring(0, idx); // 주소 앞부분 전체 텍스트
                        
                        // ...주소 앞부분 텍스트 어딘가에 똑같이 존재한다면 (교집합 검증 통과)
                        if (headText.includes(cleanTok.replace(/[\(\)]/g, ''))) {
                            return cleanTok; 
                        }
                    }
                }
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}