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

// 3. 스마트 주소 추출 로직 (유지)
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

// 4. 🌟 기사님 아이디어 완벽 적용: "필터 단어 차단 + 우측 긁어오기 + 멈춤 단어에서 강제 정지"
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;

    try {
        // 1. 모든 줄바꿈과 탭을 공백 하나로 통일하여 한 줄로 만듦 (좌표 엉킴 방지)
        let text = fullText.replace(/[\n\t\r]+/g, ' ').replace(/\s{2,}/g, ' ');

        // 2. 필터 단어와 멈춤(Stop) 단어 강력하게 정의
        const targets = ['상호', '법인', '간판', '배송'];
        const stopWords = ['성명', '이름', '대표', '주소', '소재지', '연락처', '전화', 'tel', 'fax', 'el', '공급', '잔액', '금액', '수량', '단가', '종목', '업태', '합계', '영수', '청구', '품목', '품명', '규격'];

        let tokens = text.split(' ');

        for (let i = 0; i < tokens.length; i++) {
            let token = tokens[i];
            
            // 3. 필터 단어가 현재 토큰에 포함되어 있는지 확인
            if (targets.some(t => token.includes(t))) {
                let collected = [];
                
                let cleanToken = token;
                // 🌟 핵심 1: 필터 단어(간판명, 상호명 등) 자체는 출력되지 않도록 텍스트에서 강제 삭제!
                cleanToken = cleanToken.replace(/상호명?|법인명?|간판명?|배송지명?/g, '');
                // 앞뒤에 붙은 불필요한 기호 껍데기 제거
                cleanToken = cleanToken.replace(/^[():;|\[\]]+|[():;|\[\]]+$/g, '');
                
                if (cleanToken.length >= 1) {
                    collected.push(cleanToken);
                }
                
                // 4. 필터 단어의 우측(다음 순서) 토큰들을 하나씩 수집
                for (let j = i + 1; j < Math.min(i + 15, tokens.length); j++) {
                    let nextToken = tokens[j];
                    
                    // 또 다른 필터 단어가 연달아 나오면 수집하지 않고 스킵 (예: 배송지명 옆에 또 간판명이 있는 경우)
                    if (targets.some(t => nextToken.includes(t))) continue;
                    
                    let nextTokenLower = nextToken.toLowerCase();
                    
                    // 🌟 핵심 2: 멈춤 단어(연락처, 잔액 등)가 포함되어 있으면 즉시 수집 중단!
                    if (stopWords.some(sw => nextTokenLower.includes(sw)) || nextTokenLower === 'el:') {
                        break;
                    }
                    
                    // 숫자, 전화번호, 단가 형태면 즉시 중단
                    if (/^[\d\-,.]+$/.test(nextToken)) break;
                    if (/[0-9]+(?:원|개|박스|ea|kg|g|l|ml)$/i.test(nextToken)) break;
                    if (nextToken.includes('010') || nextToken.includes('02-') || nextToken.includes('031-')) break;
                    
                    collected.push(nextToken);
                }
                
                // 5. 수집된 단어들 조합 및 찌꺼기 최종 정리
                if (collected.length > 0) {
                    let result = collected.join(' ').trim();
                    
                    // 혹시라도 '잔액', '연락처' 같은 멈춤 단어가 결과물 중간에 섞였다면 그 앞부분까지만 싹둑 자르기
                    for (let sw of stopWords) {
                        let swIndex = result.toLowerCase().indexOf(sw);
                        if (swIndex !== -1) {
                            result = result.substring(0, swIndex).trim();
                        }
                    }
                    
                    // 최종 찌꺼기 기호 정리
                    result = result.replace(/^[\]) :;|]+|[\[( :;|]+$/g, '').trim();
                    
                    // 유효성 검사 (너무 짧거나 껍데기 단어만 남은 경우는 무시)
                    if (result.length >= 2 && result !== '(주)' && result !== '주식회사') {
                        return result; // 깔끔하게 찾았으면 반환!
                    }
                }
            }
        }
    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    
    return null; // 못 찾았으면 차라리 안 띄우는 게 안전함
}