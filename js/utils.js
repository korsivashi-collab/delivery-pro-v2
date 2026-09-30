// js/utils.js

// ==========================================
// 1. 공통 로딩 오버레이 제어 함수
// ==========================================
export function showLoading(text) { 
    const elText = document.getElementById('loading-text');
    const elOverlay = document.getElementById('loading-overlay');
    if (elText) elText.innerText = text; 
    if (elOverlay) elOverlay.classList.remove('hidden'); 
}

export function hideLoading() { 
    const elOverlay = document.getElementById('loading-overlay');
    if (elOverlay) elOverlay.classList.add('hidden'); 
}

// ==========================================
// 2. 순수 도로명/지번 주소 추출 (상호명 대괄호 제거용)
// ==========================================
export function getPureAddress(address) {
    if (!address) return "";
    let match = address.match(/^\[(.*?)\]\s*(.*)$/);
    return match ? match[2].trim() : address.trim();
}

// ==========================================
// 3. 사진 고속 안전 압축 및 OCR 전처리 엔진 (클라이언트단)
// ==========================================
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
                
                // 비율 유지하며 최대 해상도 제한
                if (width > height) { 
                    if (width > MAX_SIZE) { height *= MAX_SIZE / width; width = MAX_SIZE; } 
                } else { 
                    if (height > MAX_SIZE) { width *= MAX_SIZE / height; height = MAX_SIZE; } 
                }
                canvas.width = width; 
                canvas.height = height;
                
                const ctx = canvas.getContext('2d'); 
                
                // [핵심 OCR 전처리]: 속도 저하 없이 하드웨어 가속으로 이미지 품질 극대화
                // 1. grayscale(100%): 황색 명세표 등 컬러 노이즈 제거
                // 2. contrast(150%): 글자와 배경의 명암비를 높여 선명도 극대화
                // 3. brightness(110%): 차량 내부 등 어두운 환경 보정
                ctx.filter = 'grayscale(100%) contrast(150%) brightness(110%)';
                
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.85)); 
            };
            img.onerror = (e) => reject(e);
        };
        reader.onerror = error => reject(error);
    });
}

// ==========================================
// 4. 전화번호 추출 로직
// ==========================================
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

// ==========================================
// 5. 도로명 주소 정밀 추출 로직 (줄바꿈 번지 연계 + '(' 괄호 발견 시 삭제 탑재)
// ==========================================
export function extractAddressLogic(text) {
    if (!text || typeof text !== 'string') return null;
    try {
        let processedText = text;

        // 1. 번지수 하이픈(-) 앞뒤에 줄바꿈이나 공백이 끼어있는 경우 무조건 하나의 번지수(예: 35-2)로 결합
        processedText = processedText.replace(/(\d+)\s*[-~ㅡ]\s*[\r\n]+\s*(\d+)/g, '$1-$2');
        processedText = processedText.replace(/(\d+)\s+[-~ㅡ]\s+(\d+)/g, '$1-$2');

        // 줄바꿈을 공백으로 통합하여 단일 행으로 평탄화
        let flatText = processedText.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');

        // 시/도 접두사 패턴 기반 정밀 주소 추출
        let regionPrefixedRegex = /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도|시)?\s+[가-힣\s]+(?:구|군|시)\s+[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면|리)\s*\d+(?:\s*-\s*\d+)?[\s\S]*?)(?=(?:배송지명|간판명|상호|업체명|연락처|전화|010|받는분|수령인|구매자|고객명|공급|금액|수량|단가|\n|$))/g;
        let matches = [...flatText.matchAll(regionPrefixedRegex)];
        
        let targetAddr = null;
        if (matches && matches.length > 0) {
            targetAddr = matches[matches.length - 1][0].trim().replace(/\s+/g, ' ');
        } else {
            // 보조: 도로명 패턴으로 재탐색
            let fallbackRegex = /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[가-힣a-zA-Z0-9\s,\-\(\)]+(?:로|길|동|읍|면|리)\s*\d+(?:\s*-\s*\d+)?)/g;
            let fbMatches = [...flatText.matchAll(fallbackRegex)];
            if (fbMatches && fbMatches.length > 0) {
                targetAddr = fbMatches[fbMatches.length - 1][0].trim().replace(/\s+/g, ' ');
            }
        }

        if (targetAddr) {
            // 🌟 [핵심 반영]: 주소를 읽어오다가 '(' 기호를 만나면 '('부터 뒷부분을 모두 삭제
            if (targetAddr.includes('(')) {
                targetAddr = targetAddr.split('(')[0].trim();
            }

            // 하이픈 공백 정리 (예: "35 - 2" -> "35-2")
            targetAddr = targetAddr.replace(/(\d+)\s*-\s*(\d+)/g, '$1-$2');

            // 끝에 남은 콤마나 특수문자 정리
            targetAddr = targetAddr.replace(/[,\s\-]+$/, '').trim();

            return targetAddr;
        }
    } catch (e) {
        console.error("주소 추출 오류:", e);
    } 
    return null;
}

// ==========================================
// 6. 상호명 라벨 정밀 추출 로직
// ==========================================
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        let lines = fullText.split(/\n/);
        
        const anchors = [
            '배송지명(간판명)', 
            '상호(법인명)', 
            '배송지명', 
            '간판명', 
            '상호명', 
            '상호', 
            '업체명', 
            '법인명'
        ];
        
        const stopLabels = /(성명|대표자|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|수량|단가|총액|규격|제조사|원산지|단위|합계)/;
        const breakRegex = /[\s\(\)\[\]\{\}\<\>\/,\+|;:]+/;

        // [1차 알고리즘] 줄 단위 라벨 우측 탐색
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            for (let anchor of anchors) {
                if (line.includes(anchor)) {
                    let idx = line.indexOf(anchor);
                    let rightSide = line.substring(idx + anchor.length).trim();
                    rightSide = rightSide.replace(/^[:\s\-\=\|\/]+/, '');
                    
                    let words = rightSide.split(breakRegex).filter(w => w.length > 0);
                    for (let w of words) {
                        let candidate = w.replace(/[^\w가-힣]/g, '');
                        if (anchors.some(a => a.includes(candidate) || candidate.includes(a))) continue;
                        if (stopLabels.test(candidate)) break;
                        if (/^\d+$/.test(candidate)) continue;
                        if (candidate.length >= 2) {
                            return candidate;
                        }
                    }
                    
                    if (i + 1 < lines.length) {
                        let nextWords = lines[i + 1].split(breakRegex).filter(w => w.length > 0);
                        for (let w of nextWords) {
                            let candidate = w.replace(/[^\w가-힣]/g, '');
                            if (anchors.some(a => a.includes(candidate) || candidate.includes(a))) continue;
                            if (stopLabels.test(candidate)) break;
                            if (/^\d+$/.test(candidate)) continue;
                            if (candidate.length >= 2) {
                                return candidate;
                            }
                        }
                    }
                }
            }
        }

        // [2차 알고리즘] 토큰 연쇄 탐색
        let tokens = fullText.split(breakRegex).filter(t => t.trim().length > 0);
        for (let i = 0; i < tokens.length; i++) {
            let cleanTok = tokens[i].replace(/[^\w가-힣]/g, '');
            if (anchors.some(a => cleanTok === a || cleanTok.includes(a))) {
                for (let j = i + 1; j < Math.min(tokens.length, i + 6); j++) {
                    let cleanNext = tokens[j].replace(/[^\w가-힣]/g, '');
                    if (cleanNext.length === 0) continue;
                    if (anchors.some(a => cleanNext === a || cleanNext.includes(a))) continue;
                    if (stopLabels.test(cleanNext)) break;
                    if (/^\d+$/.test(cleanNext)) continue;
                    if (cleanNext.length >= 2) {
                        return cleanNext;
                    }
                }
            }
        }

    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}

// ==========================================
// 7. 안드로이드 / iOS 기기별 해상도 및 뷰포트 자동 최적화 엔진
// ==========================================
export function initResponsiveViewport() {
    function applyViewportMetrics() {
        const vh = window.innerHeight * 0.01;
        document.documentElement.style.setProperty('--vh', `${vh}px`);

        const screenWidth = window.innerWidth || document.documentElement.clientWidth;

        if (screenWidth <= 360) {
            document.body.classList.add('screen-compact');
        } else {
            document.body.classList.remove('screen-compact');
        }

        if (window.visualViewport) {
            const visualHeight = window.visualViewport.height * 0.01;
            document.documentElement.style.setProperty('--vvh', `${visualHeight}px`);
        }
    }

    applyViewportMetrics();

    window.addEventListener('resize', applyViewportMetrics, { passive: true });
    window.addEventListener('orientationchange', () => {
        setTimeout(applyViewportMetrics, 100);
    });

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', applyViewportMetrics, { passive: true });
    }
}