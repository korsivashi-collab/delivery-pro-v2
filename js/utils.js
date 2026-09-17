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

// 🌟 [최종 개선] 상호명 띄어쓰기 허용, 줄바꿈(밀림) 인식 및 영수증 최상단 추론 강력 적용
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    
    try {
        // 빈 줄 제거 및 줄 단위 배열화
        let lines = fullText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
        
        // 1. 확장된 앵커 및 정지 키워드 (검색 범위를 넓히고 차단 기준은 정교화)
        const anchors = ['상호명', '상호(법인명)', '상호', '간판명', '배송지명', '업체명', '법인명', '가맹점명', '가맹점', '판매점'];
        const stopLabels = /(성명|대표|사업장|주소|업태|종목|전화|연락처|TEL|등록번호|사업자|공급|금액)/i;

        // [1단계] 앵커 기반 추출 (줄바꿈 밀림 방어 및 띄어쓰기 유지)
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            for (let anchor of anchors) {
                if (line.includes(anchor)) {
                    let idx = line.indexOf(anchor);
                    // 앵커 이후 텍스트 추출 후 특수문자 정리
                    let rightSide = line.substring(idx + anchor.length).replace(/^[:\s\->|()]+/, '').trim();
                    
                    // [핵심 보완] 명세서 칸이 안 맞아서 '상호명:' 은 여깄는데 실제 이름은 다음 줄로 넘어간 경우
                    if (rightSide.length === 0 && i + 1 < lines.length) {
                        rightSide = lines[i + 1].trim();
                    }

                    if (rightSide.length > 0) {
                        let tokens = rightSide.split(/\s+/);
                        let storeNameParts = [];

                        // 띄어쓰기가 있어도 정지 키워드나 숫자가 나오기 전까지는 모두 상호명으로 취급
                        for (let token of tokens) {
                            let cleanTok = token.replace(/[^\w가-힣]/g, '');
                            
                            // 다른 항목의 라벨이거나, 연속된 숫자(전화번호/사업자번호)가 나오면 수집 중단
                            if (stopLabels.test(cleanTok) || /^\d{4,}$/.test(cleanTok) || anchors.includes(cleanTok)) {
                                break;
                            }
                            if (cleanTok) storeNameParts.push(token);
                        }

                        let candidate = storeNameParts.join(' ').replace(/[^\w가-힣\s]/g, '').trim();
                        if (candidate.length >= 2) return candidate;
                    }
                }
            }
        }

        // [2단계] 접미사 패턴 탐색 (키워드가 아예 없는 텍스트 뭉치용)
        const suffixRegex = /(맛집|식당|상회|상사|농원|농장|마트|카페|커피|베이커리|편의점|약국|의원|통닭|고기|나라|유통|물류|F&B|에프앤비|점)$/;
        for (let line of lines) {
            let tokens = line.split(/\s+/);
            for (let i = 0; i < tokens.length; i++) {
                let tClean = tokens[i].replace(/[^\w가-힣]/g, '');
                if (suffixRegex.test(tClean) && tClean.length >= 2) {
                    // 지역명 단독 배제 (예: 강남구, 서울시 통과 방지)
                    if (/^[가-힣]+(시|구|동|로|길)$/.test(tClean)) continue;

                    let storeName = tokens[i];
                    // 앞 단어가 존재하고, 쓸데없는 라벨이 아니면 결합 (예: "스타벅스" + "강남점")
                    if (i > 0) {
                        let prevClean = tokens[i-1].replace(/[^\w가-힣]/g, '');
                        if (prevClean.length >= 2 && !/^\d+$/.test(prevClean) && !stopLabels.test(prevClean)) {
                            storeName = tokens[i-1] + " " + storeName;
                        }
                    }
                    
                    let finalName = storeName.replace(/[^\w가-힣\s]/g, '').trim();
                    if (!stopLabels.test(finalName) && finalName.length >= 2) return finalName;
                }
            }
        }

        // [3단계 폴백] 영수증 최상단 Heuristic (정보가 너무 많아 다 실패했을 때의 구원투수)
        // 일반적인 영수증이나 명세서는 최상단 1~3줄 내에 무조건 상호명이 굵게 찍히는 점을 이용
        const ignoreTopLines = /(영수증|신용카드|체크카드|명세서|매출|현금|취소|승인|거래)/;
        for (let i = 0; i < Math.min(3, lines.length); i++) {
            let cleanLine = lines[i].replace(/[^\w가-힣\s]/g, '').trim();
            // 숫자만 있거나, 일반적인 영수증 헤더가 아니면 최상단 텍스트를 상호로 간주
            if (cleanLine.length >= 2 && !ignoreTopLines.test(cleanLine) && !stopLabels.test(cleanLine) && !/^\d+$/.test(cleanLine)) {
                return cleanLine;
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}