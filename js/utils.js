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
                
                if (width > height) { 
                    if (width > MAX_SIZE) { height *= MAX_SIZE / width; width = MAX_SIZE; } 
                } else { 
                    if (height > MAX_SIZE) { width *= MAX_SIZE / height; height = MAX_SIZE; } 
                }
                canvas.width = width; 
                canvas.height = height;
                
                const ctx = canvas.getContext('2d'); 
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
// 5. 도로명 주소 정밀 추출 로직 (알고리즘 원칙 100% 엄격 준수)
// ==========================================
export function extractAddressLogic(text) {
    if (!text || typeof text !== 'string') return null;
    try {
        let processedText = text;

        // [원칙 2] 줄바꿈 및 공백에 걸친 번지수 결합 (19-\n2, 19 - 2, 19 - \n 2 -> 19-2)
        processedText = processedText.replace(/(\d+)\s*[-~ㅡ—–]\s*[\r\n]+[\s\t]*(\d+)/g, '$1-$2');
        processedText = processedText.replace(/(\d+)\s*[-~ㅡ—–]\s*(\d+)/g, '$1-$2');

        // 줄바꿈 평탄화
        let flatText = processedText.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');

        // 평탄화 후 잔여 공백 하이픈 최종 결합
        flatText = flatText.replace(/(\d+)\s*[-~ㅡ—–]\s*(\d+)/g, '$1-$2');

        // 대한민국 행정구역으로 시작하는 주소 후보 수집
        const provincePattern = '(?:서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:특별자치도|도)?|충북|충남|충청북도|충청남도|전북(?:특별자치도)?|전남|전라북도|전라남도|경북|경남|경상북도|경상남도|제주(?:특별자치도|도)?)';

        // 시/도 생략형도 함께 수집하고, 같은 주소의 시/군/구는 별도 후보로 나누지 않음
        const startRegex = new RegExp(`(^|[\\s\\[\\(])((?:${provincePattern}|[가-힣]{2,6}(?:시|군|구))\\s+(?:[가-힣]{1,10}(?:시|군|구)\\s+)*)`, 'g');
        const starts = [...flatText.matchAll(startRegex)].map(match => match.index + match[1].length);
        const stopLabels = /(?:\s+)(?:배송지|수령지|납품처|발송지|본사|간판명|상호|업체명|연락처|전화|010|받는\s*분|수령인|구매자|고객명|공급|금액|수량|단가|총액|품명|비고|메모|박스)/;
        const labelRegex = /배송지|수령지|받는\s*분|납품처|공급자|발송지|본사/g;
        const labels = [...flatText.matchAll(labelRegex)];
        let bestAddress = null;
        let bestScore = -Infinity;

        for (let i = 0; i < starts.length; i++) {
            const start = starts[i];
            let address = flatText.substring(start, starts[i + 1] ?? flatText.length).trim();
            const stopIndex = address.search(stopLabels);
            if (stopIndex !== -1) address = address.substring(0, stopIndex).trim();
            // 기존 괄호 절삭 및 공백/특수문자 정돈 유지
            address = address.split('(')[0].replace(/[,\s\-~ㅡ—–]+$/, '').trim().replace(/\s+/g, ' ');
            if (!address) continue;

            // 직전 주소와 현재 주소 사이의 가장 가까운 선행 라벨만 적용
            // 다음 주소의 라벨이 현재 후보에 섞이지 않도록 범위를 제한
            const contextStart = Math.max(i > 0 ? starts[i - 1] : 0, start - 100);
            const nearbyLabels = labels.filter(label => label.index >= contextStart && label.index + label[0].length <= start);
            const nearestLabel = nearbyLabels[nearbyLabels.length - 1];
            let score = 0;
            if (nearestLabel) {
                score = /^(?:배송지|수령지|받는\s*분|납품처)$/.test(nearestLabel[0]) ? 100 : -100;
            }
            // 동점이면 기존과 같이 문서에서 먼저 나온 주소 선택
            if (score > bestScore) {
                bestScore = score;
                bestAddress = address;
            }
        }
        return bestAddress;

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
        const lines = fullText.split(/\r?\n/);
        const anchor = /배송지명\s*(?:\(\s*간판명\s*\))?|간판명|상\s*호\s*(?:\(\s*법\s*인\s*명\s*\)|명)?|업\s*체\s*명|법\s*인\s*명/;
        const stopLabels = /(?:^|[\s|])(?:성명|대표자|사업장|주\s*소|업태|종목|전화|연락처|등록번호|사업자\s*(?:등록)?번호|공급받는\s*자|공급자|발송지|본사|배송지|수령지|납품처|받는\s*분|수령인|고객명|금액|수량|단가|총액|규격|제조사|원산지|단위|합계|품명|비고|상\s*호|간판명|업\s*체\s*명|법\s*인\s*명)(?=\s|[:：|\(]|$)/;
        const fieldValues = /\b\d{3}\s*-\s*\d{2}\s*-\s*\d{5}\b|\b0\d{1,3}[\s.-]*\d{3,4}[\s.-]*\d{4}\b|\d[\d,]*\s*(?:원|개|EA|박스|kg)(?=\s|$|[,;|])|\b\d{8,13}\b|\b\d{1,3}(?:,\d{3})+\b/i;
        const candidates = [];
        let section = '';

        for (let i = 0; i < lines.length; i++) {
            const sections = [...lines[i].matchAll(/공급받는\s*자|공급자|발송지|본사|배송지|수령지|납품처/g)];
            const labels = [...lines[i].matchAll(new RegExp(anchor.source, 'g'))];
            for (const label of labels) {
                const precedingSections = sections.filter(match => match.index < label.index);
                const currentSection = precedingSections.length ? precedingSections[precedingSections.length - 1][0] : section;
                const parts = [];
                let contamination = 0;
                let distance = 0;
                for (let j = i; j < lines.length && j <= i + 2 && parts.length < 2; j++) {
                    let part = j === i ? lines[j].slice(label.index + label[0].length) : lines[j];
                    part = part.replace(/^[\s:：=|/\-]+/, '').trim();
                    if (!part) continue;
                    const stop = part.search(stopLabels);
                    const pipe = part.indexOf('|');
                    const boundary = Math.min(stop < 0 ? part.length : stop, pipe < 0 ? part.length : pipe);
                    let namePart = part.slice(0, boundary).trim();
                    // 다음 줄이 주소·수치 항목이면 결합하지 않고, 같은 줄에 혼입되면 감점
                    const address = isStoreNameAddressText(namePart);
                    const otherField = namePart.match(fieldValues) || namePart.match(/^\d[\d,.\s]*$/);
                    if (address || otherField) {
                        if (parts.length) break;
                        contamination += address ? 100 : 60;
                        if (otherField) namePart = namePart.slice(0, otherField.index).trim();
                    }
                    if (namePart) {
                        if (!parts.length) distance = j - i;
                        parts.push(namePart);
                    }
                    if (boundary < part.length || address || otherField) break;
                }
                const name = parts.join(' ').replace(/\s+/g, ' ').trim();
                if (name.length < 2 || !/[A-Za-z가-힣]/.test(name)) continue;
                let score = 100 - distance * 10 - contamination;
                if (/배송지명|간판명/.test(label[0]) || /공급받는|배송지|수령지|납품처/.test(currentSection)) score += 15;
                if (/^(?:공급자|발송지|본사)$/.test(currentSection)) score -= 80;
                if (/상가|아파트|빌딩|타워|센터/.test(name)) score -= 8;
                if (/^(?:주식회사|유한회사|법인명|\(주\)|㈜)$/.test(name) || /^(?:지하|지상)?\s*B?\d+\s*층$/i.test(name)) score -= 100;
                candidates.push({ name, score });
            }
            if (sections.length) section = sections[sections.length - 1][0];
        }
        const ranked = [...new Set(candidates.map(candidate => candidate.name))]
            .map(name => ({ name, score: Math.max(...candidates.filter(candidate => candidate.name === name).map(candidate => candidate.score)) }))
            .sort((a, b) => b.score - a.score);
        if (!ranked.length || ranked[0].score < 75) return null;
        if (ranked[1] && ranked[0].score - ranked[1].score < 10) return null;
        return ranked[0].name;
    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}

// 상호 후보 판정 전용이며 기존 주소·전화번호 추출에는 사용하지 않음
export function isStoreNameAddressText(text) {
    if (!text) return false;
    return /(?:^|\s)주\s*소\s*[:：]?|[가-힣A-Za-z0-9]+(?:대로|로|길)\s*\d+|[가-힣]+(?:동|읍|면|리)\s+(?:산\s*)?\d+(?:-\d+)?|(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|특별자치도|도)?\s+[가-힣]+(?:시|군|구)|[가-힣]+(?:시|군|구)\s+[^\n]*\d+|\[\d{5}\]/.test(text);
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
