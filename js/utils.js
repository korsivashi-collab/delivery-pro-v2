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
// 5. 도로명/지번 주소 정밀 추출 로직 (분기 도로명 및 건물번호 보존)
// ==========================================
export function extractAddressLogic(text) {
    if (!text || typeof text !== 'string') return null;
    try {
        // 1) 전화번호 및 타 필드 라벨 직전에 줄바꿈을 두어 한 줄 엉킴 사전 분리
        let safeText = text
            .replace(/(전화(?:번호)?|연락처|TEL|H\.?P|대표자|검수자|성명|상호|수령인|업태|종목|등록번호)\s*[:\s]/gi, '\n')
            .replace(/(01[0-9]|0[2-8][0-9]?)[-\s]?\d{3,4}[-\s]?\d{4}/g, '\n');

        let flatText = safeText.replace(/\r/g, ' ').replace(/\n/g, '  ').replace(/\s+/g, ' ');

        const sidoPattern = '(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도|시)?';
        const sigunguPattern = '[가-힣]+(?:구|군|시)(?:\\s+[가-힣]+(?:구|군))?';
        
        // 🌟 분기 도로명(예: 시흥대로150길, 마포대로11길, 대학로 등) 완벽 지원
        const roadNamePattern = '[가-힣]+(?:대로|로|길|거리)(?:\\s*\\d+(?:번)?(?:길|로))?';
        const buildingNumPattern = '\\d+(?:-\\d+)?';
        const floorUnitPattern = '(?:\\s*,?\\s*(?:지하|지상)?\\s*B?\\d+\\s*(?:층|호))?';
        const refParensPattern = '(?:\\s*,?\\s*\\([가-힣0-9\\s,·\\.]+\\))?';

        // 정밀 도로명 주소 정규식
        const roadRegex = new RegExp(
            `(${sidoPattern}\\s+${sigunguPattern}\\s+${roadNamePattern}\\s*${buildingNumPattern})${floorUnitPattern}(${refParensPattern})`,
            'g'
        );

        // 정밀 지번 주소 정규식
        const jibunRegex = new RegExp(
            `(${sidoPattern}\\s+${sigunguPattern}\\s+[가-힣0-9\\s]+?(?:동|읍|면|리)\\s*${buildingNumPattern})${floorUnitPattern}(${refParensPattern})`,
            'g'
        );

        let roadMatches = [...flatText.matchAll(roadRegex)];
        let jibunMatches = [...flatText.matchAll(jibunRegex)];

        let candidate = null;
        let targetMatch = null;

        if (roadMatches.length > 0) {
            targetMatch = roadMatches[roadMatches.length - 1];
        } else if (jibunMatches.length > 0) {
            targetMatch = jibunMatches[jibunMatches.length - 1];
        }

        if (targetMatch) {
            let baseAddr = (targetMatch[1] || '').trim();
            let parens = (targetMatch[2] || '').trim().replace(/^,\s*/, '');
            candidate = parens ? `${baseAddr} ${parens}` : baseAddr;
        }

        if (candidate) {
            // 3) 후처리 정제: 전화번호 및 찌꺼기 절삭
            candidate = candidate
                .replace(/\s*(?:전화|연락처|TEL|HP|핸드폰|성명|대표).*$/i, '')
                .replace(/\s*(?:01[0-9]|0[2-8][0-9]?)[-\s]?\d+.*$/, '')
                .replace(/\s+/g, ' ')
                .trim();

            if (candidate.length >= 8) {
                return candidate;
            }
        }
    } catch (e) {
        console.error("주소 추출 오류:", e);
    } 
    return null;
}

// ==========================================
// 6. 상호명 라벨 정밀 추출 로직 (행정구역 오인 방지 및 복합 상호명 보존)
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
        
        const stopLabels = /(성명|대표자|대표|사업장|주소|업태|종목|전화|연락처|등록번호|공급|금액|수량|단가|총액|규격|제조사|원산지|단위|합계)/;
        const adminKeywords = /^(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|시)?$/;
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
                    let storeWords = [];
                    for (let w of words) {
                        let candidate = w.replace(/[^\w가-힣]/g, '');
                        if (!candidate) continue;
                        if (anchors.some(a => a.includes(candidate) || candidate.includes(a))) continue;
                        if (stopLabels.test(candidate)) break;
                        if (adminKeywords.test(candidate)) break;
                        if (/^\d+$/.test(candidate)) continue;
                        storeWords.push(candidate);
                        if (storeWords.length >= 3) break;
                    }
                    if (storeWords.length > 0) {
                        return storeWords.join(' ');
                    }
                    
                    // 같은 줄 우측에 내용이 없을 경우 바로 다음 줄 확인 (표 서식 대응)
                    if (i + 1 < lines.length) {
                        let nextWords = lines[i + 1].split(breakRegex).filter(w => w.length > 0);
                        let nextStoreWords = [];
                        for (let w of nextWords) {
                            let candidate = w.replace(/[^\w가-힣]/g, '');
                            if (!candidate) continue;
                            if (anchors.some(a => a.includes(candidate) || candidate.includes(a))) continue;
                            if (stopLabels.test(candidate)) break;
                            if (adminKeywords.test(candidate)) break;
                            if (/^\d+$/.test(candidate)) continue;
                            nextStoreWords.push(candidate);
                            if (nextStoreWords.length >= 3) break;
                        }
                        if (nextStoreWords.length > 0) {
                            return nextStoreWords.join(' ');
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
                let tokenStoreWords = [];
                for (let j = i + 1; j < Math.min(tokens.length, i + 6); j++) {
                    let cleanNext = tokens[j].replace(/[^\w가-힣]/g, '');
                    if (cleanNext.length === 0) continue;
                    if (anchors.some(a => cleanNext === a || cleanNext.includes(a))) continue;
                    if (stopLabels.test(cleanNext)) break;
                    if (adminKeywords.test(cleanNext)) break;
                    if (/^\d+$/.test(cleanNext)) continue;
                    tokenStoreWords.push(cleanNext);
                    if (tokenStoreWords.length >= 3) break;
                }
                if (tokenStoreWords.length > 0) {
                    return tokenStoreWords.join(' ');
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