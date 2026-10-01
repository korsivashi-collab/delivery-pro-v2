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
// 5. 도로명/지번 주소 전국 통합 정밀 추출 로직
// ==========================================
export function extractAddressLogic(text) {
    if (!text || typeof text !== 'string') return null;
    try {
        let processedText = text;

        // 🌟 [보강 1]: 줄바꿈에 걸친 번지수 하이픈 결합 (예: "19-\n2" 또는 "19 -\r\n 2" -> "19-2")
        processedText = processedText.replace(/(\d+)\s*[-~ㅡ—–]\s*[\r\n]+[\s\t]*(\d+)/g, '$1-$2');
        
        // 🌟 [보강 2]: 같은 줄 내에서 공백이 끼어있는 하이픈 결합 (예: "19 - 2" -> "19-2")
        processedText = processedText.replace(/(\d+)[\s\t]*[-~ㅡ—–][\s\t]*(\d+)/g, '$1-$2');

        // 줄바꿈을 공백으로 통합하여 단일 행으로 평탄화
        let flatText = processedText.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');

        // 🌟 [보강 3]: 평탄화 이후에도 공백 분리된 하이픈 번지수가 남아있는 경우 최종 재결합
        flatText = flatText.replace(/(\d+)\s*-\s*(\d+)/g, '$1-$2');

        // 전국 광역 지자체 패턴 (풀네임 및 축약어 모두 완벽 지원)
        const provincePattern = '(?:서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:특별자치도|도)?|충북|충남|충청북도|충청남도|전북(?:특별자치도)?|전남|전라북도|전라남도|경북|경남|경상북도|경상남도|제주(?:특별자치도|도)?)';

        // 주소 탐색 중단 라벨 (다음 항목명)
        const stopPattern = '(?=(?:\\s+(?:배송지명|간판명|상호|업체명|연락처|전화|010|받는분|수령인|구매자|고객명|공급|금액|수량|단가|품명|비고|메모|박스|수량|운송장)|\\n|$))';

        let targetAddr = null;

        // [1순위] 광역시/도 접두사가 포함된 전국 주소 (도로명 및 지번/읍/면/리/산 번지 모두 지원)
        const regexLevel1 = new RegExp(
            `(${provincePattern}\\s+[가-힣0-9\\s]+?(?:로|길|동|읍|면|리)\\s*(?:산\\s*)?\\d+(?:-\\d+)?(?:번지)?(?:\\s*[가-힣a-zA-Z0-9\\-\\s]+?)?)${stopPattern}`,
            'g'
        );
        let matches = [...flatText.matchAll(regexLevel1)];
        if (matches && matches.length > 0) {
            targetAddr = matches[matches.length - 1][0].trim().replace(/\s+/g, ' ');
        }

        // [2순위] 시/도가 생략되고 바로 '시/군/구'부터 시작하는 전국 지방 주소 대응 (예: "천안시 서북구 쌍용동 123", "포항시 북구 장량로 45", "김해시 진영읍 ...")
        if (!targetAddr) {
            const regexLevel2 = new RegExp(
                `([가-힣]{2,6}(?:시|군|구)\\s+[가-힣0-9\\s]+?(?:로|길|동|읍|면|리)\\s*(?:산\\s*)?\\d+(?:-\\d+)?(?:번지)?(?:\\s*[가-힣a-zA-Z0-9\\-\\s]+?)?)${stopPattern}`,
                'g'
            );
            let matches2 = [...flatText.matchAll(regexLevel2)];
            if (matches2 && matches2.length > 0) {
                targetAddr = matches2[matches2.length - 1][0].trim().replace(/\s+/g, ' ');
            }
        }

        // [3순위] 보조 폴백: 일반 도로명/지번 패턴 탐색
        if (!targetAddr) {
            const fallbackRegex = new RegExp(
                `(${provincePattern}?[가-힣a-zA-Z0-9\\s,\\-\\(\\)]+?(?:로|길|동|읍|면|리)\\s*(?:산\\s*)?\\d+(?:-\\d+)?(?:번지)?)`,
                'g'
            );
            let fbMatches = [...flatText.matchAll(fallbackRegex)];
            if (fbMatches && fbMatches.length > 0) {
                targetAddr = fbMatches[fbMatches.length - 1][0].trim().replace(/\s+/g, ' ');
            }
        }

        if (targetAddr) {
            // 🌟 [보강 4]: 괄호('(')가 포함된 경우 뒷부분 상세 안전 절삭
            if (targetAddr.includes('(')) {
                targetAddr = targetAddr.split('(')[0].trim();
            }

            // 번지수 하이픈 공백 최종 정리 (예: "19 - 2" -> "19-2")
            targetAddr = targetAddr.replace(/(\d+)\s*-\s*(\d+)/g, '$1-$2');

            // 끝에 불필요하게 남은 특수기호나 콤마, 하이픈 정리
            targetAddr = targetAddr.replace(/[,\s\-~ㅡ—–]+$/, '').trim();

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