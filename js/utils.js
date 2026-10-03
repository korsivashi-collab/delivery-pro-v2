// js/utils.js
// =================================================================
// [배송 동선 PRO] 범용 문서 영역 분할(Zone Segmentation) 및 데이터 슬롯 추출 엔진
// =================================================================

const STORE_NAME_DIAGNOSTICS_ENABLED = true;

export function logStoreNameDiagnostic(stage, details) {
    if (!STORE_NAME_DIAGNOSTICS_ENABLED) return;
    try {
        console.log(`[OCR 영역 진단] ${stage}:`, JSON.parse(JSON.stringify(details)));
    } catch (_) {}
}

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
// 2. 순수 도로명/지번 주소 추출 (상호명 대괄호 제거)
// ==========================================
export function getPureAddress(address) {
    if (!address) return "";
    let match = address.match(/^\[(.*?)\]\s*(.*)$/);
    return match ? match[2].trim() : address.trim();
}

// ==========================================
// 3. 사진 고속 안전 압축 및 OCR 전처리 엔진
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
                // 황색/분홍 명세표 노이즈 제거 및 명암 선명화
                ctx.filter = 'grayscale(100%) contrast(145%) brightness(105%)';
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.85)); 
            };
            img.onerror = (e) => reject(e);
        };
        reader.onerror = error => reject(error);
    });
}

// ==========================================
// 4. 범용 문서 영역 자동 분할 엔진 (3-Zone Partitioning)
// ==========================================
export function extractDocumentZones(fullText, includeStoreLabels = false) {
    if (!fullText || typeof fullText !== 'string') {
        return { supplierZone: "", recipientZone: "", tableZone: "", cleanTargetText: "" };
    }

    const lines = fullText.split(/\r?\n/);
    let supplierLines = [];
    let recipientLines = [];
    let tableLines = [];

    // 구역 플래그
    let currentZone = 'unknown'; // 'supplier' | 'recipient' | 'table'

    const supplierAnchor = /공급자|출하처|발송처|보내는\s*분|화주|본사/i;
    const recipientAnchor = /공급받는\s*자|배송지|납품처|수령지|수하인|받는\s*분|도착지|거래처|배송처/i;
    const tableAnchor = /품\s*명|규\s*격|단\s*위|수\s*량|단\s*가|공급가액|세\s*액|총\s*액|합\s*계|금\s*액|비\s*고/i;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // 테이블(품목) 시작 지점 감지
        if (tableAnchor.test(line) && !recipientAnchor.test(line) && !line.includes('배송지명')) {
            currentZone = 'table';
        } 
        // 배송처(공급받는 자) 시작 지점 감지
        else if (recipientAnchor.test(line)) {
            currentZone = 'recipient';
        } 
        // 공급자(보낸 곳) 감지
        else if (supplierAnchor.test(line) && currentZone !== 'recipient') {
            currentZone = 'supplier';
        }

        if (currentZone === 'recipient') {
            recipientLines.push(line);
        } else if (currentZone === 'supplier') {
            supplierLines.push(line);
        } else if (currentZone === 'table') {
            tableLines.push(line);
        } else {
            // 구역 판별 전 헤더 라인 중 배송처 관련 라벨이 있으면 배송처로 편입
            if (/배송지명|간판명|상호|주소|연락처/.test(line) || (includeStoreLabels && /업\s*체\s*명|매\s*장\s*명|법\s*인\s*명|가맹점명/.test(line))) {
                recipientLines.push(line);
            }
        }
    }

    // 만약 배송처 라벨이 명시적으로 분리되지 않은 경우 전체 텍스트에서 테이블 이전까지를 타겟으로 지정
    let targetText = recipientLines.join('\n');
    if (!targetText || targetText.length < 10) {
        targetText = fullText;
        const stopIdx = targetText.search(tableAnchor);
        if (stopIdx !== -1) {
            targetText = targetText.substring(0, stopIdx);
        }
    }

    return {
        supplierZone: supplierLines.join('\n'),
        recipientZone: recipientLines.join('\n'),
        tableZone: tableLines.join('\n'),
        cleanTargetText: targetText
    };
}

// ==========================================
// 5. 범용 전화번호 추출 슬롯 엔진
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
    let bestPhone = null; 
    let highestScore = -1;
    
    for (let num of candidates) {
        let score = 0;
        let is010 = num.startsWith('010') && (num.length === 10 || num.length === 11);
        let isLocal = /^0[2-6][1-5]?\d{7,8}$/.test(num);
        let is050 = num.startsWith('050') && (num.length === 11 || num.length === 12);
        let isRep = /^1[5-9]\d{6}$/.test(num); 
        
        if (is010) score += 100; 
        else if (isLocal) score += 85; 
        else if (is050) score += 80; 
        else if (isRep) score += 60; 
        else score -= 50; 
        
        if (score > highestScore && score > 0) { 
            highestScore = score; 
            bestPhone = num; 
        }
    }
    if (bestPhone) {
        let p = bestPhone;
        if (p.length === 11) return p.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
        if (p.length === 10) {
            if (p.startsWith('02')) return p.replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3');
            return p.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
        }
        return p;
    }
    return null;
}

// ==========================================
// 6. 범용 도로명/지번 주소 정밀 추출 슬롯 엔진
// ==========================================
export function extractAddressLogic(text) {
    const fallback = extractAddressSingleLegacy(text);
    if (!text || typeof text !== 'string') return fallback;
    const flat = text.replace(/(\d+)\s*[-~ㅡ—–]\s*(\d+)/g, '$1-$2').replace(/\s+/g, ' ');
    const provincePattern = '(?:서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:특별자치도|도)?|충북|충남|충청북도|충청남도|전북(?:특별자치도)?|전남|전라북도|전라남도|경북|경남|경상북도|경상남도|제주(?:특별자치도|도)?)';
    const startRegex = new RegExp(`(^|[\\s\\[\\(])((?:${provincePattern}|[가-힣]{2,6}(?:시|군|구))\\s+(?:[가-힣]{1,10}(?:시|군|구)\\s+)*)`, 'g');
    const starts = [...flat.matchAll(startRegex)].map(m => m.index + m[1].length);
    const candidates = starts.map((start, i) => ({ start, end: starts[i + 1] ?? flat.length, address: extractAddressSingleLegacy(flat.slice(start, starts[i + 1])) })).filter(c => c.address);
    if (new Set(candidates.map(c => c.address)).size < 2) return fallback;
    // 공급받는 자/배송지명 복합어를 먼저 매칭해 공급자/배송지로 잘못 분할하지 않는다.
    const roles = [...flat.matchAll(/배송지명\s*\(\s*간판명\s*\)|공급\s*받는\s*자|받으시는\s*분|보내는\s*분|받는\s*분|배송지|배송처|납품처|수령지|수취인|수하인|도착지|거래처|공급자|발송처|출하처|본사|화주/g)];
    for (const c of candidates) {
        const preceding = roles.filter(r => r.index + r[0].length <= c.start && !r[0].startsWith('배송지명'));
        const role = preceding.at(-1)?.[0].replace(/\s/g, '') || '';
        c.role = role;
        c.score = /^(?:공급자|발송처|보내는분|출하처|본사|화주)$/.test(role) ? -100 : role ? 100 : 0;
        // 간판명 단독은 사용하지 않고, 복합 배송지명은 이미 확인된 배송 역할을 보조한다.
        if (c.score > 0 && roles.some(r => r.index >= c.start && r.index < c.end && r[0].startsWith('배송지명'))) c.score += 10;
    }
    const scores = [...new Set(candidates.map(c => c.address))].map(address => ({ address, score: Math.max(...candidates.filter(c => c.address === address).map(c => c.score)) })).sort((a, b) => b.score - a.score);
    const selected = scores[0].score > scores[1].score ? scores[0].address : fallback;
    logStoreNameDiagnostic('복수 주소 역할 선택', { candidates, fallback, selected });
    return selected;
}

function extractAddressSingleLegacy(text) {
    if (!text || typeof text !== 'string') return null;
    try {
        let processedText = text;

        // 줄바꿈 및 분리된 번지수 하이픈 결합 (예: 19 - 2, 19-\n2 -> 19-2)
        processedText = processedText.replace(/(\d+)\s*[-~ㅡ—–]\s*[\r\n]+[\s\t]*(\d+)/g, '$1-$2');
        processedText = processedText.replace(/(\d+)\s*[-~ㅡ—–]\s*(\d+)/g, '$1-$2');

        let flatText = processedText.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');
        flatText = flatText.replace(/(\d+)\s*[-~ㅡ—–]\s*(\d+)/g, '$1-$2');

        const provincePattern = '(?:서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:특별자치도|도)?|충북|충남|충청북도|충청남도|전북(?:특별자치도)?|전남|전라북도|전라남도|경북|경남|경상북도|경상남도|제주(?:특별자치도|도)?)';

        const startRegex = new RegExp(`(^|[\\s\\[\\(])(${provincePattern}(?:\\s+|$))`, 'i');
        const startMatch = flatText.match(startRegex);

        let rawAddressBlock = null;

        if (startMatch) {
            const startIndex = startMatch.index + (startMatch[1] ? startMatch[1].length : 0);
            let textFromProvince = flatText.substring(startIndex).trim();

            const stopLabels = /(?:\s+)(?:배송지명|간판명|상호|업체명|배송처|거래처|연락처|전화|010|받는분|수령인|구매자|고객명|공급|금액|수량|단가|총액|품명|비고|메모|박스)/;
            const stopMatch = textFromProvince.search(stopLabels);
            rawAddressBlock = stopMatch !== -1 ? textFromProvince.substring(0, stopMatch).trim() : textFromProvince.trim();
        } else {
            const localRegex = /(?:[가-힣]{2,6}(?:시|군|구))\s+[가-힣0-9\s,\-\(\)]+/;
            const localMatch = flatText.match(localRegex);
            if (localMatch) {
                const stopLabels = /(?:\s+)(?:배송지명|간판명|상호|업체명|배송처|거래처|연락처|전화|010|받는분|수령인|구매자|고객명|공급|금액|수량|단가|총액|품명|비고|메모|박스)/;
                const stopMatch = localMatch[0].search(stopLabels);
                rawAddressBlock = (stopMatch !== -1 ? localMatch[0].substring(0, stopMatch) : localMatch[0]).trim();
            }
        }

        if (!rawAddressBlock) return null;

        // 도로명/지번 정규 코어 탐색
        // 숫자/한글 분기명/길 사이 OCR 공백을 허용하고 건물번호는 별도로 캡처.
        const roadCoreRegex = /((?:[가-힣A-Za-z0-9·.]+(?:대로|로)(?:\s*\d+\s*(?:[가-힣]\s*)*길)?|[가-힣A-Za-z0-9·.]+길))\s*(\d+(?:-\d+)?)/;
        const parcelCoreRegex = /[가-힣A-Za-z0-9·]+(?:동|읍|면|리)\s+(?:산\s*)?\d+(?:-\d+)?/;
        
        const roadMatch = rawAddressBlock.match(roadCoreRegex);
        const coreMatch = roadMatch || rawAddressBlock.match(parcelCoreRegex);

        if (!coreMatch) {
            return rawAddressBlock.split(/[(.]/)[0].trim().replace(/[,\s\-~ㅡ—–]+$/, '');
        }

        const addressCore = roadMatch
            ? rawAddressBlock.slice(0, roadMatch.index) + roadMatch[1].replace(/\s+/g, '') + ' ' + roadMatch[2]
            : rawAddressBlock.slice(0, coreMatch.index + coreMatch[0].length);
        const finalAddress = addressCore
            .replace(/[,\s\-~ㅡ—–]+$/, '').trim().replace(/\s+/g, ' ');

        return finalAddress;
    } catch (e) {
        console.error("주소 추출 오류:", e);
    } 
    return null;
}

// ==========================================
// 7. 범용 비상호(Garbage) 엔티티 검증기
// ==========================================
export function isInvalidStoreCandidate(text) {
    if (!text || typeof text !== 'string') return true;
    const clean = text.trim();
    if (clean.length < 2) return true;

    // 1) 수치/단위/금액/사업자번호/전화번호 패턴
    if (/^\d+$/.test(clean)) return true;
    if (/\b\d{3}\s*-\s*\d{2}\s*-\s*\d{5}\b/.test(clean)) return true; // 사업자등록번호
    if (/\b0\d{1,3}[\s.-]*\d{3,4}[\s.-]*\d{4}\b/.test(clean)) return true; // 전화번호
    if (/\d[\d,]*\s*(?:원|개|EA|박스|BOX|kg|g|L|ml)(?=\s|$|[,;|])/i.test(clean)) return true;
    if (/^(?:합계|공급가액|세액|총액|배송비|운임|단가|수량)$/.test(clean)) return true;

    // 2) 층수/호수 단독 표기
    if (/^(?:지하|지상)?\s*B?\d+\s*층$/i.test(clean)) return true;
    if (/^\d+\s*호$/i.test(clean)) return true;
    if (/^(?:1층|2층|3층|지하1층)$/.test(clean)) return true;

    // 3) 단순 법인격 명칭 단독 표기
    if (/^(?:주식회사|유한회사|\(주\)|㈜|법인명)$/.test(clean)) return true;

    // 4) 주소 패턴 자체인 경우
    if (isStoreNameAddressText(clean)) return true;

    return false;
}

// ==========================================
// 8. 주소 후미 상호명 범용 추출 엔진 (2차 백업)
// ==========================================
// 호환용 함수: 주소 후미는 상호 후보로 추정하지 않는다.
export function extractStoreNameFromAddressSuffix(fullText) {
    return null;
}

// ==========================================
// 9. 2D 좌표 기반 상호 추출 엔진 (범용 회전/상대위치 탐색)
// ==========================================
export function extractStoreNameByLayout(pages = []) {
    const candidates = [], excludedTextSegments = [], cells = [];
    const compact = text => text.replace(/[\s:：=|()（）]/g, '');
    const fieldType = text => {
        if (/^(?:배송지명(?:간판명)?|상호(?:법인명|명)?|법인명|업체명|매장명|간판명|거래처명|가맹점명)$/.test(text)) return 'store';
        if (/^(?:주소|사업장주소|배송주소)$/.test(text)) return 'address';
        if (/^(?:연락처|전화|전화번호)$/.test(text)) return 'phone';
        if (/^(?:성명|대표자|담당자|등록번호|사업자등록번호|업태|종목|금액|수량|단가|총액|공급자|공급받는자)$/.test(text)) return 'other';
        return null;
    };
    const union = parts => ({ left: Math.min(...parts.map(t => t.box.left)), right: Math.max(...parts.map(t => t.box.right)), top: Math.min(...parts.map(t => t.box.top)), bottom: Math.max(...parts.map(t => t.box.bottom)) });
    const center = t => (t.box.top + t.box.bottom) / 2;
    for (const page of Array.isArray(pages) ? pages : []) {
        const tokens = (page.tokens?.length ? page.tokens : page.lines || []).filter(t => t?.text?.trim() && t.box && Object.values(t.box).every(Number.isFinite) && t.box.right > t.box.left && t.box.bottom > t.box.top);
        if (!tokens.length) continue;
        const heights = tokens.map(t => t.box.bottom - t.box.top).sort((x, y) => x - y);
        const h = heights[Math.floor(heights.length / 2)];
        const rows = [], used = new Set();
        for (const line of page.tokens?.length ? page.lines || [] : []) {
            const parts = tokens.filter(t => !used.has(t) && (t.textSegments || []).some(segment => (line.textSegments || []).some(anchor => anchor.start <= segment.start && anchor.end >= segment.end)));
            if (parts.length) { rows.push(parts); parts.forEach(t => used.add(t)); }
        }
        for (const token of [...tokens].sort((x, y) => center(x) - center(y) || x.box.left - y.box.left)) {
            if (used.has(token)) continue;
            const row = rows.find(parts => Math.abs(center({ box: union(parts) }) - center(token)) <= 0.5 * h);
            if (row) row.push(token); else rows.push([token]);
        }
        rows.sort((x, y) => union(x).top - union(y).top);
        const labels = [], labelTokens = new Set();
        rows.forEach((row, rowIndex) => {
            row.sort((x, y) => x.box.left - y.box.left);
            for (let i = 0; i < row.length; i++) {
                let longest = null;
                for (let j = i; j < Math.min(row.length, i + 12); j++) {
                    if (j > i && row[j].box.left - row[j - 1].box.right > 2 * h) break;
                    const parts = row.slice(i, j + 1);
                    const text = compact(parts.map(t => t.text).join(''));
                    const type = fieldType(text);
                    if (type) longest = { type, text, parts, box: union(parts), rowIndex, end: j };
                }
                if (longest) {
                    labels.push(longest);
                    longest.parts.forEach(t => labelTokens.add(t));
                    i = longest.end;
                }
            }
        });
        for (const label of labels) {
            const nextRight = labels.filter(other => other.rowIndex === label.rowIndex && other.box.left > label.box.right).sort((x, y) => x.box.left - y.box.left)[0];
            const right = nextRight?.box.left ?? Infinity;
            const first = rows[label.rowIndex].filter(t => !labelTokens.has(t) && t.box.left >= label.box.right - 0.2 * h && t.box.right <= right);
            let parts = [...first];
            let previousBox = first.length ? union(first) : label.box;
            const valueLeft = first.length ? previousBox.left : label.box.left;
            for (let r = label.rowIndex + 1; r < rows.length; r++) {
                const rowBox = union(rows[r]);
                if (rowBox.top - previousBox.bottom > 1.5 * h) break;
                if (labels.some(other => other.rowIndex === r && other.box.left < right && other.box.right >= Math.min(label.box.left, valueLeft) - h)) break;
                const continuation = rows[r].filter(t => !labelTokens.has(t) && t.box.left >= valueLeft - h && t.box.right <= right);
                if (!continuation.length || Math.abs(union(continuation).left - valueLeft) > h) break;
                if (label.type === 'store' && isStoreNameAddressText(continuation.map(t => t.text).join(' '))) break;
                parts.push(...continuation);
                previousBox = union(continuation);
            }
            const value = parts.map(t => t.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
            const confidences = parts.map(t => t.confidence);
            const confidenceReliable = confidences.length > 0 && confidences.every(c => typeof c === 'number' && c >= 0.5) && confidences.reduce((a, b) => a + b, 0) / confidences.length >= 0.7;
            const cell = { confidenceReliable, page: page.pageNumber, label: label.text, type: label.type, box: parts.length ? union(parts) : null, value, tokenCount: parts.length };
            cells.push(cell);
            if (label.type === 'address') parts.forEach(t => excludedTextSegments.push(...(t.textSegments || [])));
            if (label.type === 'store' && value && !isInvalidStoreCandidate(value)) candidates.push({ name: value, score: 95, source: 'layout-cell', cell });
        }
    }
    const names = [...new Set(candidates.map(c => c.name))];
    logStoreNameDiagnostic('가상 셀', { cells, candidates, excludedTextSegments, ambiguous: names.length > 1 });
    return { name: names.length === 1 ? names[0] : null, candidates, excludedTextSegments };
}

// ==========================================
// 10. 범용 텍스트 스트림 상호 추출 슬롯 엔진
// ==========================================
export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        // 1단계: 배송처 영역(Recipient Zone)으로 텍스트 한정
        const zones = extractDocumentZones(fullText, true);
        const targetText = zones.cleanTargetText || fullText;

        const lines = targetText.split(/\r?\n/);
        
        const anchorRegex = /(?:배송지명\s*(?:\(\s*간판명\s*\))?|간판명|상\s*호\s*(?:\(\s*법\s*인\s*명\s*\)|명)?|업\s*체\s*명|법\s*인\s*명|거래처명|가맹점명|매장명)/;
        const stopPattern = /(?:성명|대표자|사업장|주\s*소|업태|종목|전화|연락처|등록번호|사업자번호|공급|금액|수량|단가|총액|규격|합계|품명|비고)/;

        const candidates = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(anchorRegex);
            if (!match) continue;

            // 라벨 우측 값 탐색
            let rightSide = line.substring(match.index + match[0].length).replace(/^[\s:：=|/\-]+/, '').trim();
            const stopIdx = rightSide.search(stopPattern);
            if (stopIdx !== -1) rightSide = rightSide.substring(0, stopIdx).trim();

            if (rightSide && !isInvalidStoreCandidate(rightSide)) {
                candidates.push({ name: rightSide, score: 95 });
            }

            // 라벨 아래 행 탐색
            if (!rightSide || rightSide.length < 2) {
                for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
                    let nextLine = lines[j].replace(/^[\s:：=|/\-]+/, '').trim();
                    if (!nextLine || anchorRegex.test(nextLine)) break;
                    
                    const nextStop = nextLine.search(stopPattern);
                    if (nextStop !== -1) nextLine = nextLine.substring(0, nextStop).trim();

                    if (nextLine && !isInvalidStoreCandidate(nextLine)) {
                        candidates.push({ name: nextLine, score: 85 - (j - i) * 5 });
                        break;
                    }
                }
            }
        }

        // 명시적 상호 라벨에서 수집한 값만 선택한다.
        if (candidates.length > 0) {
            candidates.sort((a, b) => b.score - a.score);
            logStoreNameDiagnostic('범용 상호 추출 완료', candidates);
            return candidates[0].name;
        }
    } catch (e) {
        console.error("범용 상호 추출 오류:", e);
    }
    return null;
}

// 상호 판정용 보조 유틸
export function isStoreNameAddressText(text) {
    if (!text) return false;
    return /(?:^|\s)주\s*소\s*[:：]?|[가-힣A-Za-z0-9]+(?:대로|로|길)\s*\d+|[가-힣]+(?:동|읍|면|리)\s+(?:산\s*)?\d+(?:-\d+)?|(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|특별자치도|도)?\s+[가-힣]+(?:시|군|구)|\[\d{5}\]/.test(text);
}

export function findStoreNamePersonField(text, allowLeadingBareLabel = true) {
    const labels = '성\\s*명|대\\s*표\\s*자|담\\s*당\\s*자|대\\s*표';
    const matches = [];
    for (const match of text.matchAll(new RegExp('(' + labels + ')\\s*[:：=|]', 'g'))) {
        matches.push({ index: match.index, label: match[1] });
    }
    for (const match of text.matchAll(new RegExp('(^|[\\s|;])(' + labels + ')(?=\\s|$)', 'g'))) {
        const index = match.index + match[1].length;
        if (index === 0 && !allowLeadingBareLabel && match[2].replace(/\s/g, '') === '대표' && text.slice(match[0].length).trim()) continue;
        matches.push({ index, label: match[2] });
    }
    matches.sort((a, b) => a.index - b.index);
    return matches[0] || null;
}

// ==========================================
// 11. 기기별 뷰포트 반응형 최적화
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
    window.addEventListener('orientationchange', () => setTimeout(applyViewportMetrics, 100));
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', applyViewportMetrics, { passive: true });
    }
}