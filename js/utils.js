// js/utils.js

// 1. 클라이언트단 사진 안전 압축 (기존 유지)
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

// 2. 전화번호 추출 로직 (기존 유지)
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

// 3. 스마트 주소 추출 로직 (기존 유지)
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

// 🌟 4. [최종 완성본] 상호 추출 로직 (1차 줄 탐색 -> 2차 단어 탐색 -> 3차 주소 교집합 검증)
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        let lines = fullText.split(/\n/);
        
        // 완벽하게 제거할 대상 앵커 키워드들 (라벨)
        const anchors = ['상호명', '상호(법인명)', '상호', '간판명', '배송지명', '업체명', '법인명'];
        // 수집을 차단하는 경계선 라벨들
        const stopLabels = /(성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액)/;
        
        // 💡 [핵심] 띄어쓰기 및 괄호, 쉼표, 콜론 등 "연결이 끊기는" 모든 기호를 감지
        const breakRegex = /[\s\(\)\[\]\{\}\<\>\/,\+|;:]+/;

        // =====================================================================
        // [1차 알고리즘] 라벨 포함 줄 탐색 -> 우측 데이터 가져옴 -> 끊기면 앞자리만
        // =====================================================================
        for (let line of lines) {
            for (let anchor of anchors) {
                if (line.includes(anchor)) {
                    let idx = line.indexOf(anchor);
                    // 앵커 단어 이후의 우측 텍스트만 추출
                    let rightSide = line.substring(idx + anchor.length).trim();
                    rightSide = rightSide.replace(/^[:\s\-]+/, '');
                    
                    // 기호나 띄어쓰기로 텍스트를 분해
                    let words = rightSide.split(breakRegex).filter(w => w.length > 0);
                    if (words.length > 0) {
                        // 가장 먼저 등장하는 조각(앞자리)만 추출하고 뒷자리는 과감히 버림
                        let candidate = words[0].replace(/[^\w가-힣]/g, '');
                        if (candidate.length >= 2 && !stopLabels.test(candidate) && !anchors.includes(candidate)) {
                            return candidate;
                        }
                    }
                }
            }
        }

        // =====================================================================
        // [2차 알고리즘] 단어 단위 연쇄 탐색 -> 이중 라벨 건너뜀 -> 끊기면 앞자리만
        // =====================================================================
        let tokens = fullText.split(breakRegex).filter(t => t.trim().length > 0);
        
        for (let i = 0; i < tokens.length; i++) {
            let cleanTok = tokens[i].replace(/[^\w가-힣]/g, '');
            if (anchors.some(a => cleanTok === a || cleanTok.includes(a))) {
                // 앵커 바로 다음 단어들을 탐색
                for (let j = i + 1; j < tokens.length; j++) {
                    let cleanNext = tokens[j].replace(/[^\w가-힣]/g, '');
                    if (cleanNext.length === 0) continue;
                    
                    // 우측 단어가 다시 인식되는 단어(이중 라벨)이면 건너뛰고 다음 우측 데이터를 읽어옴
                    if (anchors.includes(cleanNext)) {
                        continue; 
                    }
                    
                    // 조건에 맞는 실질 데이터 첫 단어(앞자리)를 잡은 경우 채택하고 종료
                    if (cleanNext.length >= 2 && !stopLabels.test(cleanNext) && !/^\d+$/.test(cleanNext)) {
                        return cleanNext;
                    }
                    
                    // 첫 번째 실질 데이터가 상호명 조건에 안 맞으면 뒷자리는 버림 (탐색 중단)
                    break;
                }
            }
        }

        // =====================================================================
        // [3차 알고리즘] 1, 2차 실패 시 -> 주소 뒷부분과 남은 데이터의 '교집합' 추출
        // =====================================================================
        const regionPrefixedRegex = /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도|시)?\s+[가-힣\s]+(?:구|군|시)\s+[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면|리)\s*\d+(?:-\d+)?(?:\s*,\s*\([가-힣\s]+\))?)/;
        
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            let match = line.match(regionPrefixedRegex);
            if (match) {
                // 주소 줄에서 '실제 주소 부분(match[0])'을 공백으로 날려버림
                let remainder = line.replace(match[0], ' ');
                
                // 우편번호, 층수, '주소' 라벨 등 명세서에 흔히 붙는 불필요한 정보 소거
                remainder = remainder.replace(/(주소|배송지|\[\d{5}\]|\d{5}|지하\s*\d+층|\d+층|지상\s*\d+층|B\d+)/g, ' ');
                
                // 주소 뒷부분에 남은 텍스트 조각들 추출
                let tailWords = remainder.split(breakRegex).filter(w => w.trim().length > 0);
                
                for (let tailWord of tailWords) {
                    let candidate = tailWord.replace(/[^\w가-힣]/g, '');
                    
                    if (candidate.length >= 2 && !stopLabels.test(candidate) && !anchors.includes(candidate) && !/^\d+$/.test(candidate)) {
                        
                        // 💡 [교집합 검증] 이 단어가 주소 줄이 아닌 '다른 줄'에도 겹쳐서 나오는지 확인
                        let isOverlapping = false;
                        for (let j = 0; j < lines.length; j++) {
                            if (i === j) continue; // 주소가 있던 원본 줄은 제외
                            
                            // 다른 줄에 이 단어가 존재한다면 교집합 성립
                            if (lines[j].includes(candidate)) {
                                isOverlapping = true;
                                break;
                            }
                        }
                        
                        // 겹치는 내용(교집합)이 확인되면 상호명으로 확실시하고 내보냄
                        if (isOverlapping) {
                            return candidate;
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