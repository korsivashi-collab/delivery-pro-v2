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

// 🌟 4. [최종 개선판] 네거티브 섹터 스캔 + 경계선 방어 로직
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        const extractedAddress = extractAddressLogic(fullText) || "";
        const addrTokens = extractedAddress.split(/\s+/);

        // [지옥의 네거티브 필터] 상호가 될 수 없는 모든 조건을 배제합니다.
        const isInvalidToken = (str) => {
            let pureText = str.replace(/[\(\)]/g, ''); // 검사를 위해 괄호 임시 제거
            
            // 0. (핵심 수정) 라벨/앵커 단어 자체는 무조건 즉사 (법인명, 상호 등 출력 원천 차단)
            if (/^(상호|법인명?|간판명?|배송지명?|업체명?|공급받는자|명칭|성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|단가|수량|규격|품목|비고|구분|일자|월|일|합계|영수|청구|팩스|FAX|TEL|바코드|담당자)$/.test(pureText)) return true;
            // 1. 사업자번호 양식
            if (/^\d{3}-\d{2}-\d{5}$/.test(pureText)) return true;
            // 2. 전화번호 양식
            if (/^(010|02|0[3-9]\d)-?\d{3,4}-?\d{4}$/.test(pureText) || /^\d{8,12}$/.test(pureText)) return true;
            // 3. 주문번호 (영문+숫자 혼합)
            if (/(?=.*[a-zA-Z])(?=.*\d)[a-zA-Z\d-]{4,}/.test(pureText)) return true;
            // 4. 순수 숫자 또는 금액
            if (/^[0-9,]+원?$/.test(pureText)) return true;
            // 5. 단독 부속어
            if (/^(주|유|주식회사|유한회사)$/.test(pureText)) return true;
            // 6. 주소에 포함된 단어 중복 방지
            if (addrTokens.includes(str) || /동$|구$|시$|면$|읍$|리$|로\d*길?$/.test(pureText)) return true;

            return false; // 위 조건을 모두 피하면 생존
        };

        let lines = fullText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
        const anchors = ['상호', '법인', '배송', '간판', '업체명', '공급받는자'];
        const boundaryStopLabels = /^(성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|단가|수량|규격|품목|비고|구분|일자|월|일|합계)$/;

        // [1차 시도] 섹터 스캔 (경계선 방어 적용)
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            
            for (let anchor of anchors) {
                if (line.includes(anchor)) {
                    let survivors = []; 

                    // 1. 위로 1칸 스캔 (라벨보다 상호가 먼저 읽혔을 경우)
                    if (i > 0) {
                        let prevTokens = lines[i-1].split(/[\s,:;\|]+/).filter(w => w.trim().length > 0);
                        if (!boundaryStopLabels.test(prevTokens[0].replace(/[\(\)]/g, ''))) {
                            for (let token of prevTokens) {
                                let cleanTok = token.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
                                if (cleanTok.length >= 2 && !isInvalidToken(cleanTok)) survivors.push(cleanTok);
                            }
                        }
                    }

                    // 2. 현재 줄 스캔 (앵커 단어는 isInvalidToken에서 알아서 죽여줌)
                    let currentTokens = line.split(/[\s,:;\|]+/).filter(w => w.trim().length > 0);
                    for (let token of currentTokens) {
                        let cleanTok = token.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
                        if (cleanTok.length >= 2 && !isInvalidToken(cleanTok)) survivors.push(cleanTok);
                    }

                    // 3. 아래로 최대 3칸 스캔 (동대문엽기떡볶이 이신촌점 융합)
                    for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
                        let nextTokens = lines[j].split(/[\s,:;\|]+/).filter(w => w.trim().length > 0);
                        
                        // [핵심 방어선] 아랫줄이 '성명', '주소' 등 다른 칸의 라벨로 시작하면 즉시 아랫줄 스캔 중단!
                        if (boundaryStopLabels.test(nextTokens[0].replace(/[\(\)]/g, ''))) break;
                        
                        for (let token of nextTokens) {
                            let cleanTok = token.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
                            if (cleanTok.length >= 2 && !isInvalidToken(cleanTok)) survivors.push(cleanTok);
                        }
                    }

                    // 살아남은 조각 조립
                    if (survivors.length > 0) {
                        survivors = [...new Set(survivors)]; // 중복 단어 제거
                        let finalName = survivors.join(' '); 
                        
                        // 괄호 앞뒤 정리 (예: 원조남산왕돈가스 (주) -> 원조남산왕돈가스(주))
                        finalName = finalName.replace(/\s+\(/g, '(').replace(/\)\s+/g, ')');
                        
                        if (finalName.length >= 2) return finalName;
                    }
                }
            }
        }

        // [2차 시도] 최후의 보루: 주소 뒷부분 교집합 검증 로직 (기존 유지)
        if (extractedAddress) {
            let flatText = fullText.replace(/\n/g, ' ');
            let idx = flatText.indexOf(extractedAddress);
            
            if (idx !== -1) {
                let tailStr = flatText.substring(idx + extractedAddress.length).trim();
                tailStr = tailStr.replace(/^[,\s]*(지하\s*\d+층|지상\s*\d+층|B?\d+층|\d+층|[가-힣]+\([가-힣]+\)|[가-힣]+동)\s*/, '');
                let tailTokens = tailStr.split(/[\s,:;\|]+/).filter(w => w.trim().length > 0);
                
                for (let token of tailTokens) {
                    let cleanTok = token.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
                    if (cleanTok.length >= 2 && !isInvalidToken(cleanTok)) {
                        let headText = flatText.substring(0, idx); 
                        if (headText.includes(cleanTok.replace(/[\(\)]/g, ''))) return cleanTok; 
                    }
                }
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}