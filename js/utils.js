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

// 🌟 4. [최종 완성] 클리너 + 더블 앵커(라벨&사업자번호) 네거티브 섹터 스캔
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        const extractedAddress = extractAddressLogic(fullText) || "";
        const addrTokens = extractedAddress.split(/\s+/);

        // [핵심 1] 토큰에 달라붙은 "배송지명(간판명)" 같은 라벨 찌꺼기를 강제로 도려내는 클리너
        const cleanLabelGarbage = (str) => {
            return str.replace(/배송지명?\(?간판명?\)?|제조사\(?원산지\)?|공급받는자|상호\(?법인명\)?|상호명?|법인명?|위\)/g, '')
                      .replace(/^(명칭|성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|단가|수량|규격|품목|비고|구분|일자|월|일|합계|영수|청구|팩스|FAX|TEL|바코드|담당자)$/g, '');
        };

        // [지옥의 네거티브 필터]
        const isInvalidToken = (str) => {
            let pureText = str.replace(/[\(\)]/g, '');
            // 1. 단독 라벨 단어 차단
            if (/^(상호|법인명?|간판명?|배송지명?|업체명?|공급받는자|명칭|성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|단가|수량|규격|품목|비고|구분|일자|월|일|합계|영수|청구|팩스|FAX|TEL|바코드|담당자|제조사|원산지|위)$/.test(pureText)) return true;
            // 2. 사업자번호
            if (/^\d{3}-\d{2}-\d{5}$/.test(pureText)) return true;
            // 3. 전화번호
            if (/^(010|02|0[3-9]\d)-?\d{3,4}-?\d{4}$/.test(pureText) || /^\d{8,12}$/.test(pureText)) return true;
            // 4. 주문/송장번호 (영문+숫자 혼합)
            if (/(?=.*[a-zA-Z])(?=.*\d)[a-zA-Z\d-]{4,}/.test(pureText)) return true;
            // 5. 순수 숫자/금액
            if (/^[0-9,\.]+원?$/.test(pureText)) return true;
            // 6. 단독 부속어
            if (/^(주|유|주식회사|유한회사)$/.test(pureText)) return true;
            // 7. 주소 토큰 중복 방지
            if (addrTokens.includes(str) || /동$|구$|시$|면$|읍$|리$|로\d*길?$/.test(pureText)) return true;

            return false;
        };

        let lines = fullText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
        const boundaryStopLabels = /^(성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|단가|수량|규격|품목|비고|구분|일자|월|일|합계|제조사|원산지)$/;
        const anchors = ['상호', '법인', '배송', '간판', '업체명', '공급받는자'];
        let targetLines = []; // 스캔을 시작할 기준점(앵커)이 있는 줄 번호 모음

        // [핵심 2] 스캔 앵커 찾기 (라벨 + 사업자번호 더블 체크)
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (anchors.some(a => line.includes(a))) {
                targetLines.push(i);
            }
            // 세금계산서 맹점 극복: 사업자번호(XXX-XX-XXXXX) 근처에 무조건 상호가 있음!
            else if (/\d{3}-\d{2}-\d{5}/.test(line)) {
                targetLines.push(i);
            }
        }

        // 찾아낸 앵커들을 기준으로 상하단 섹터 스캔
        for (let i of targetLines) {
            let survivors = [];
            let scanStart = Math.max(0, i - 1);
            let scanEnd = Math.min(lines.length - 1, i + 3);

            for (let j = scanStart; j <= scanEnd; j++) {
                let nextTokens = lines[j].split(/[\s,:;\|]+/).filter(w => w.trim().length > 0);
                
                // 경계선 방어: 아랫줄 탐색 중 다른 구역 라벨 만나면 스톱
                if (j > i && boundaryStopLabels.test(nextTokens[0].replace(/[\(\)]/g, ''))) break;

                for (let token of nextTokens) {
                    // 전처리: "배송지명(간판명)Atlas" -> "Atlas" 로 분리
                    let cleanedFromLabel = cleanLabelGarbage(token);
                    if (cleanedFromLabel.length === 0) continue; 
                    
                    let cleanTok = cleanedFromLabel.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
                    
                    if (cleanTok.length >= 2 && !isInvalidToken(cleanTok)) {
                        survivors.push(cleanTok);
                    }
                }
            }

            if (survivors.length > 0) {
                survivors = [...new Set(survivors)];
                let finalName = survivors.join(' '); 
                finalName = finalName.replace(/\s+\(/g, '(').replace(/\)\s+/g, ')');
                if (finalName.length >= 2) return finalName;
            }
        }

        // [최후의 보루] 주소 뒷부분 꼬리표 교집합 검증 (기존 유지)
        if (extractedAddress) {
            let flatText = fullText.replace(/\n/g, ' ');
            let idx = flatText.indexOf(extractedAddress);
            
            if (idx !== -1) {
                let tailStr = flatText.substring(idx + extractedAddress.length).trim();
                tailStr = tailStr.replace(/^[,\s]*(지하\s*\d+층|지상\s*\d+층|B?\d+층|\d+층|[가-힣]+\([가-힣]+\)|[가-힣]+동)\s*/, '');
                let tailTokens = tailStr.split(/[\s,:;\|]+/).filter(w => w.trim().length > 0);
                
                for (let token of tailTokens) {
                    let cleanedFromLabel = cleanLabelGarbage(token);
                    let cleanTok = cleanedFromLabel.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
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