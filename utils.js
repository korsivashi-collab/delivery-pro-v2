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

// 🌟 4. [5세대 최종판] 강제 분리 + 네거티브 스캔 + 점수 경쟁 시스템
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        // [1단계: 데이터 분리 작업 (Separation)] - 대표님 피드백 반영
        // 사업자번호(000-00-00000)와 한글이 붙어있으면 사이에 공백을 강제로 삽입
        let preprocessedText = fullText.replace(/(\d{3}-\d{2}-\d{5})([가-힣a-zA-Z\(]+)/g, '$1 $2');
        preprocessedText = preprocessedText.replace(/([가-힣a-zA-Z\)]+)(\d{3}-\d{2}-\d{5})/g, '$1 $2');
        
        // 라벨 찌꺼기가 텍스트에 붙어있는 경우 강제 분리
        const labelsToDetach = /(배송지명?\(?간판명?\)?|제조사\(?원산지\)?|공급받는자|상호\(?법인명\)?)/g;
        preprocessedText = preprocessedText.replace(labelsToDetach, ' $1 ');

        const extractedAddress = extractAddressLogic(preprocessedText) || "";
        const addrTokens = extractedAddress.split(/\s+/);

        // [2단계: 네거티브 필터 (Death Filter)]
        const isInvalidToken = (str) => {
            let pureText = str.replace(/[\(\)]/g, '');
            if (/^(상호|법인명?|간판명?|배송지명?|업체명?|공급받는자|명칭|성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|단가|수량|규격|품목|비고|구분|일자|월|일|합계|영수|청구|팩스|FAX|TEL|바코드|담당자|제조사|원산지|위)$/.test(pureText)) return true;
            if (/^\d{3}-\d{2}-\d{5}$/.test(pureText)) return true;
            if (/^(010|02|0[3-9]\d)-?\d{3,4}-?\d{4}$/.test(pureText) || /^\d{8,12}$/.test(pureText)) return true;
            if (/(?=.*[a-zA-Z])(?=.*\d)[a-zA-Z\d-]{4,}/.test(pureText)) return true;
            if (/^[0-9,\.]+원?$/.test(pureText)) return true;
            if (/^(주|유|주식회사|유한회사)$/.test(pureText)) return true;
            if (addrTokens.includes(str) || /동$|구$|시$|면$|읍$|리$|로\d*길?$/.test(pureText)) return true;
            return false;
        };

        // [3단계: AI 흉내내기 - 적합도 비교 점수 시스템 (Scoring)]
        const calculateScore = (name) => {
            let score = 50; // 기본 점수
            let pureText = name.replace(/[\(\)\s]/g, '');

            // 상호명에 자주 쓰이는 접미사가 있으면 가산점 폭발
            if (/(식당|가게|상회|점|식품|유통|마트|시장|돈가스|돈까스|떡볶이|치킨|피자|푸드|레스토랑|Restaurant)$/i.test(pureText)) score += 50;
            // 법인 표기가 있으면 가산점
            if (/\(주\)|\(유\)|주식회사/.test(name)) score += 30;
            // 영문과 한글이 섞여 있으면 (예: Atlas Restaurant) 트렌디한 상호명일 확률 높음
            if (/[a-zA-Z]/.test(name) && name.length > 3) score += 20;
            
            // 패널티 (감점) 요인
            if (pureText.length > 15) score -= 40; // 너무 길면 안내문구일 확률 높음
            if ((name.match(/\d/g) || []).length > 3) score -= 30; // 숫자가 너무 많으면 상호가 아닐 확률 높음

            return score;
        };

        let lines = preprocessedText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
        const boundaryStopLabels = /^(성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|단가|수량|규격|품목|비고|구분|일자|월|일|합계|제조사|원산지)$/;
        const anchors = ['상호', '법인', '배송', '간판', '업체명', '공급받는자'];
        let targetLines = []; 
        let finalCandidates = []; // 살아남은 상호명 후보들을 모두 모아둘 배열

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (anchors.some(a => line.includes(a)) || /\d{3}-\d{2}-\d{5}/.test(line)) {
                targetLines.push(i);
            }
        }

        for (let i of targetLines) {
            let survivors = [];
            let scanStart = Math.max(0, i - 1);
            let scanEnd = Math.min(lines.length - 1, i + 3);

            for (let j = scanStart; j <= scanEnd; j++) {
                let nextTokens = lines[j].split(/[\s,:;\|]+/).filter(w => w.trim().length > 0);
                if (j > i && boundaryStopLabels.test(nextTokens[0].replace(/[\(\)]/g, ''))) break;

                for (let token of nextTokens) {
                    let cleanTok = token.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
                    if (cleanTok.length >= 2 && !isInvalidToken(cleanTok)) {
                        survivors.push(cleanTok);
                    }
                }
            }

            if (survivors.length > 0) {
                survivors = [...new Set(survivors)];
                let joinedName = survivors.join(' '); 
                joinedName = joinedName.replace(/\s+\(/g, '(').replace(/\)\s+/g, ')');
                if (joinedName.length >= 2) {
                    // 후보 발견 시 바로 반환(return)하지 않고 배열에 수집
                    finalCandidates.push({
                        text: joinedName,
                        score: calculateScore(joinedName)
                    });
                }
            }
        }

        // 최후의 보루 (주소 뒤 꼬리표) 검출된 녀석도 후보에 추가
        if (extractedAddress) {
            let flatText = preprocessedText.replace(/\n/g, ' ');
            let idx = flatText.indexOf(extractedAddress);
            if (idx !== -1) {
                let tailStr = flatText.substring(idx + extractedAddress.length).trim();
                tailStr = tailStr.replace(/^[,\s]*(지하\s*\d+층|지상\s*\d+층|B?\d+층|\d+층|[가-힣]+\([가-힣]+\)|[가-힣]+동)\s*/, '');
                let tailTokens = tailStr.split(/[\s,:;\|]+/).filter(w => w.trim().length > 0);
                
                for (let token of tailTokens) {
                    let cleanTok = token.replace(/^[^\w가-힣\(]+|[^\w가-힣\)]+$/g, '');
                    if (cleanTok.length >= 2 && !isInvalidToken(cleanTok)) {
                        let headText = flatText.substring(0, idx); 
                        if (headText.includes(cleanTok.replace(/[\(\)]/g, ''))) {
                            finalCandidates.push({
                                text: cleanTok,
                                score: calculateScore(cleanTok)
                            });
                        }
                    }
                }
            }
        }

        // [4단계: 최종 승자 결정] 점수가 가장 높은 1등 상호명을 출력!
        if (finalCandidates.length > 0) {
            // 점수(score)를 기준으로 내림차순 정렬
            finalCandidates.sort((a, b) => b.score - a.score);
            return finalCandidates[0].text; // 가장 점수가 높은 녀석의 텍스트만 반환
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}