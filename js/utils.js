// 상호 진단 로그의 유일한 출력 지점. false로 바꾸면 전체 출력을 끔.
const STORE_NAME_DIAGNOSTICS_ENABLED = true;
export function logStoreNameDiagnostic(stage, details) {
    if (!STORE_NAME_DIAGNOSTICS_ENABLED) return;
    try {
        console.log('[OCR 상호 진단] ' + stage, JSON.parse(JSON.stringify(details)));
    } catch (_) { /* 진단 실패가 인식 동작에 영향을 주지 않도록 함 */ }
}

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
// 페이지의 상대 좌표와 글자 높이로 값 영역을 구성. 기존 텍스트 판정은 별도 유지.
export function extractStoreNameByLayout(pages = []) {
    const candidates = [];
    const excludedTextSegments = [];
    const overlapY = (a, b) => Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) / Math.min(a.bottom - a.top, b.bottom - b.top);
    const union = items => ({ left: Math.min(...items.map(item => item.box.left)), top: Math.min(...items.map(item => item.box.top)), right: Math.max(...items.map(item => item.box.right)), bottom: Math.max(...items.map(item => item.box.bottom)) });
    const labelType = text => {
        const compact = text.replace(/[\s:：=|]/g, '');
        if (/^(?:상호(?:\(법인명\)|명)?|법인명|업체명|배송지명(?:\(간판명\))?|간판명)$/.test(compact)) return 'store';
        if (/^(?:성명|대표자|대표|담당자|받는분|수령인|고객명)$/.test(compact)) return 'person';
        if (/^(?:주소|사업장|전화|연락처|사업자(?:등록)?번호|등록번호|금액|수량|단가|총액|업태|종목|공급자|공급받는자)$/.test(compact)) return 'other';
        return null;
    };
    for (const page of Array.isArray(pages) ? pages : []) {
        const items = (page.tokens?.length ? page.tokens : page.lines || []).filter(item => item.text?.trim() && item.box &&
            Object.values(item.box).every(Number.isFinite) && item.box.right > item.box.left && item.box.bottom > item.box.top);
        const rows = [];
        const median = values => {
            const sorted = [...values].sort((a, b) => a - b);
            const middle = Math.floor(sorted.length / 2);
            return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
        };
        const center = item => (item.box.top + item.box.bottom) / 2;
        const updateRow = row => {
            row.box = union(row.items);
            row.center = median(row.items.map(center));
            row.height = median(row.items.map(item => item.box.bottom - item.box.top));
        };
        const membership = new Map();
        const lineGroups = new Map();
        const unassigned = [];
        for (const item of items) {
            const segments = (item.textSegments || []).filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);
            const length = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
            const matches = (page.tokens?.length && length ? page.lines || [] : []).map((line, index) => {
                // 여러 line의 anchor가 겹치면 소속을 단정하지 않고 좌표 추정으로 넘김.
                const covered = segments.reduce((sum, segment) => sum + (line.textSegments || []).reduce((part, anchor) =>
                    part + Math.max(0, Math.min(segment.end, anchor.end) - Math.max(segment.start, anchor.start)), 0), 0);
                return { index, coverage: Math.min(1, covered / length) };
            }).filter(match => match.coverage >= 0.8);
            if (matches.length === 1) {
                const index = matches[0].index;
                if (!lineGroups.has(index)) lineGroups.set(index, { items: [], lineIndices: [index] });
                lineGroups.get(index).items.push(item);
                membership.set(item, { source: 'line textSegments', lineIndex: index });
            } else {
                unassigned.push(item);
                membership.set(item, { source: 'token geometry', reason: length ? 'line 소속 누락 또는 중복' : 'textSegments 없음' });
            }
        }
        for (const group of lineGroups.values()) {
            updateRow(group);
            rows.push(group);
        }
        // OCR line이 별도 셀을 나타내더라도 같은 중심선의 셀은 같은 물리적 행으로 묶음.
        rows.sort((a, b) => a.center - b.center);
        for (let i = 0; i < rows.length; i++) {
            for (let j = i + 1; j < rows.length;) {
                if (Math.abs(rows[i].center - rows[j].center) <= 0.35 * Math.min(rows[i].height, rows[j].height)) {
                    rows[i].items.push(...rows[j].items);
                    rows[i].lineIndices.push(...rows[j].lineIndices);
                    rows.splice(j, 1);
                    updateRow(rows[i]);
                } else j++;
            }
        }
        for (const item of [...unassigned].sort((a, b) => center(a) - center(b) || a.box.left - b.box.left)) {
            const height = item.box.bottom - item.box.top;
            const nearby = rows.filter(row => Math.abs(row.center - center(item)) <= 0.35 * Math.min(row.height, height))
                .sort((a, b) => Math.abs(a.center - center(item)) - Math.abs(b.center - center(item)));
            const row = nearby[0] || { items: [], lineIndices: [] };
            if (!nearby.length) rows.push(row);
            row.items.push(item);
            updateRow(row);
        }
        rows.sort((a, b) => a.center - b.center || a.box.left - b.box.left);
        const rowOf = new Map();
        rows.forEach((row, index) => {
            row.items.sort((a, b) => a.box.left - b.box.left || center(a) - center(b));
            row.items.forEach(item => rowOf.set(item, index));
        });
        const describe = item => ({ text: item.text, box: item.box, row: rowOf.get(item), ...membership.get(item) });
        logStoreNameDiagnostic('위치 읽기 순서', {
            page: page.pageNumber,
            before: items.map(describe),
            after: rows.flatMap(row => row.items).map(describe)
        });
        const labels = [];
        for (const row of rows) {
            row.items.sort((a, b) => a.box.left - b.box.left);
            for (let i = 0; i < row.items.length; i++) {
                let found = null;
                const parts = [];
                for (let j = i; j < Math.min(row.items.length, i + 10); j++) {
                    const item = row.items[j];
                    if (j > i && item.box.left - row.items[j - 1].box.right > 2 * (item.box.bottom - item.box.top)) break;
                    parts.push(item);
                    const type = labelType(parts.map(part => part.text).join(''));
                    if (type) found = { type, items: [...parts], box: union(parts), text: parts.map(part => part.text).join(' '), row };
                }
                if (found) { labels.push(found); i += found.items.length - 1; }
            }
        }
        const labelItems = new Set(labels.flatMap(label => label.items));
        const adjacentItems = (items, height) => {
            const result = [];
            for (const item of items) {
                if (result.length && item.box.left - result[result.length - 1].box.right > 2 * height) break;
                result.push(item);
            }
            return result;
        };
        const valuesFor = label => {
            const height = label.box.bottom - label.box.top;
            const nextLabel = labels.filter(other => other !== label && overlapY(other.box, label.box) >= 0.5 && other.box.left >= label.box.right)
                .sort((a, b) => a.box.left - b.box.left)[0];
            const rightLimit = nextLabel ? nextLabel.box.left : 1;
            let valueItems = adjacentItems(label.row.items.filter(item => !labelItems.has(item) && item.box.left >= label.box.right && item.box.right <= rightLimit), height);
            let mode = 'right';
            let firstRow = label.row;
            if (!valueItems.length) {
                mode = 'below';
                firstRow = rows.find(row => row.box.top >= label.box.bottom && row.box.top - label.box.bottom <= 2 * height &&
                    row.items.some(item => !labelItems.has(item) && Math.abs(item.box.left - label.box.left) <= height && item.box.right <= rightLimit));
                if (firstRow) valueItems = adjacentItems(firstRow.items.filter(item => !labelItems.has(item) && item.box.left >= label.box.left - height && item.box.right <= rightLimit), height);
            }
            if (!valueItems.length) return { items: [], mode };
            const firstBox = union(valueItems);
            const secondRow = rows.find(row => row.box.top >= firstBox.bottom && row.box.top - firstBox.bottom <= 1.5 * height);
            if (secondRow) {
                const secondItems = adjacentItems(secondRow.items.filter(item => !labelItems.has(item) && item.box.right <= rightLimit && item.box.left >= firstBox.left - height), height);
                if (secondItems.length) {
                    const secondBox = union(secondItems);
                    const fieldBetween = labels.some(other => other !== label && other.box.top >= label.box.top && other.box.top < secondBox.bottom &&
                        other.box.right > firstBox.left - height && other.box.left < rightLimit);
                    // 두 줄은 같은 값 열에 정렬되고 중간에 다른 필드가 없을 때만 결합.
                    if (!fieldBetween && Math.abs(secondBox.left - firstBox.left) <= height && !isStoreNameAddressText(secondItems.map(item => item.text).join(' '))) valueItems.push(...secondItems);
                }
            }
            return { items: valueItems, mode, gap: mode === 'right' ? firstBox.left - label.box.right : firstBox.top - label.box.bottom, height };
        };
        const personItems = new Set();
        for (const label of labels.filter(label => label.type === 'person')) {
            for (const item of valuesFor(label).items) {
                personItems.add(item);
                excludedTextSegments.push(...(item.textSegments || []));
            }
        }
        logStoreNameDiagnostic('위치 라벨과 제외 영역', { page: page.pageNumber, labels: labels.map(label => ({ text: label.text, type: label.type, box: label.box })), excludedTextSegments });
        for (const label of labels.filter(label => label.type === 'store')) {
            const value = valuesFor(label);
            const unsortedParts = value.items.filter(item => !personItems.has(item));
            const parts = [...unsortedParts].sort((a, b) => rowOf.get(a) - rowOf.get(b) || a.box.left - b.box.left || center(a) - center(b));
            const name = parts.map(item => item.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
            logStoreNameDiagnostic('위치 상호 결합 순서', { page: page.pageNumber, label: label.text, before: items.filter(item => unsortedParts.includes(item)).map(describe), after: parts.map(describe), combinedText: name });
            const confidenceItems = [...label.items, ...parts];
            const confidences = confidenceItems.map(item => item.confidence);
            const completeConfidence = confidences.length > 0 && confidences.every(confidence => typeof confidence === 'number' && confidence >= 0 && confidence <= 1);
            const confidence = completeConfidence ? confidences.reduce((sum, confidence) => sum + confidence, 0) / confidences.length : 0;
            const adjustments = [
                { reason: '상호 라벨', points: 35 },
                { reason: value.mode === 'right' ? '오른쪽 같은 행' : '라벨 아래 정렬', points: value.mode === 'right' ? 30 : 20 },
                { reason: '상대 거리', points: Math.max(0, 10 - (value.gap || 0) / (value.height || 1) * 2) },
                { reason: 'OCR confidence', points: confidence * 25 },
                { reason: '주소 또는 번호/수치 혼입', points: isStoreNameAddressText(name) || /\d{3}-\d{2}-\d{5}|0\d{1,3}[\s.-]*\d{3,4}[\s.-]*\d{4}|\d[\d,]*\s*(?:원|개|kg)(?=\s|$)/.test(name) ? -100 : 0 },
                { reason: '건물명 관련 단어 의심', points: /상가|아파트|빌딩|타워|센터/.test(name) ? -8 : 0 }
            ];
            const score = adjustments.reduce((sum, adjustment) => sum + adjustment.points, 0);
            const validName = name.length >= 2 && /[A-Za-z가-힣]/.test(name) && !/^(?:주식회사|유한회사|\(주\)|㈜)$/.test(name);
            const closeEnough = value.height > 0 && value.gap / value.height <= 6;
            const reliable = validName && closeEnough && completeConfidence && confidence >= 0.7 && Math.min(...confidences) >= 0.5 && score >= 75;
            const candidate = { name, score, confidence, reliable, page: page.pageNumber, box: parts.length ? union(parts) : null, adjustments, reason: reliable ? '선택 비교 대상' : !validName ? '유효한 상호 값 없음' : !closeEnough ? '라벨과 값 사이 거리 과다' : !completeConfidence || confidence < 0.7 || Math.min(...confidences) < 0.5 ? 'confidence 부족' : '점수 75 미만' };
            candidates.push(candidate);
            logStoreNameDiagnostic('위치 상호 후보', candidate);
        }
    }
    const ranked = candidates.filter(candidate => candidate.reliable).sort((a, b) => b.score - a.score);
    const rival = ranked.find(candidate => candidate.name !== ranked[0]?.name);
    const name = ranked.length && (!rival || ranked[0].score - rival.score >= 10) ? ranked[0].name : null;
    logStoreNameDiagnostic('위치 선택 결과', { selected: name, ranked, reason: name ? '신뢰도와 후보 간 점수 차 통과' : '후보 부족 또는 후보 간 점수 차 부족: 텍스트 fallback' });
    return { name, candidates, excludedTextSegments };
}

export function extractStoreNameLogic(fullText) {
    if (!fullText || typeof fullText !== 'string') return null;
    try {
        const lines = fullText.split(/\r?\n/);
        const anchor = /배송지명\s*(?:\(\s*간판명\s*\))?|간판명|상\s*호\s*(?:\(\s*법\s*인\s*명\s*\)|명)?|업\s*체\s*명|법\s*인\s*명/;
        const stopLabels = /(?:^|[\s|])(?:성명|대표자|사업장|주\s*소|업태|종목|전화|연락처|등록번호|사업자\s*(?:등록)?번호|공급받는\s*자|공급자|발송지|본사|배송지|수령지|납품처|받는\s*분|수령인|고객명|금액|수량|단가|총액|규격|제조사|원산지|단위|합계|품명|비고|상\s*호|간판명|업\s*체\s*명|법\s*인\s*명)(?=\s|[:：|\(]|$)/;
        const fieldValues = /\b\d{3}\s*-\s*\d{2}\s*-\s*\d{5}\b|\b0\d{1,3}[\s.-]*\d{3,4}[\s.-]*\d{4}\b|\d[\d,]*\s*(?:원|개|EA|박스|kg)(?=\s|$|[,;|])|\b\d{8,13}\b|\b\d{1,3}(?:,\d{3})+\b/i;
        const candidates = [];
        logStoreNameDiagnostic('OCR 라벨 주변 원문', { contexts: lines.map((line, index) => ({ line: index + 1, labelLine: line, surroundingText: lines.slice(Math.max(0, index - 1), index + 3).join('\n') })).filter(item => anchor.test(item.labelLine)) });
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
                    const personField = findStoreNamePersonField(part, j !== i);
                    const boundary = Math.min(stop < 0 ? part.length : stop, pipe < 0 ? part.length : pipe, personField ? personField.index : part.length);
                    if (personField) logStoreNameDiagnostic('사람 필드 경계', { line: j + 1, text: part, ...personField });
                    let namePart = part.slice(0, boundary).trim();
                    // 다음 줄이 주소·수치 항목이면 결합하지 않고, 같은 줄에 혼입되면 감점
                    const address = isStoreNameAddressText(namePart);
                    const otherField = namePart.match(fieldValues) || namePart.match(/^\d[\d,.\s]*$/);
                    if (address || otherField) {
                        if (parts.length) { logStoreNameDiagnostic('OCR 결합 제외', { line: j + 1, text: namePart, reason: address ? '주소 패턴' : '수치 필드' }); break; }
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
                if (name.length < 2 || !/[A-Za-z가-힣]/.test(name)) { logStoreNameDiagnostic('OCR 후보', { name, score: null, label: label[0], line: i + 1, parts, rejected: true, reason: '최소 길이 또는 문자 조건 미충족: 점수 계산 전 탈락' }); continue; }
                let score = 100 - distance * 10 - contamination;
                if (/배송지명|간판명/.test(label[0]) || /공급받는|배송지|수령지|납품처/.test(currentSection)) score += 15;
                if (/^(?:공급자|발송지|본사)$/.test(currentSection)) score -= 80;
                if (/상가|아파트|빌딩|타워|센터/.test(name)) score -= 8;
                if (/^(?:주식회사|유한회사|법인명|\(주\)|㈜)$/.test(name) || /^(?:지하|지상)?\s*B?\d+\s*층$/i.test(name)) score -= 100;
                logStoreNameDiagnostic('OCR 후보', { name, score, label: label[0], line: i + 1, parts, section: currentSection,
                    adjustments: [
                        { reason: '상호 라벨 기본점수', points: 100 },
                        { reason: '라벨과 첫 후보 줄 거리', points: -distance * 10 },
                        { reason: '주소 또는 수치 혼입', points: -contamination },
                        { reason: '배송처 문맥 또는 간판 라벨', points: /배송지명|간판명/.test(label[0]) || /공급받는|배송지|수령지|납품처/.test(currentSection) ? 15 : 0 },
                        { reason: '공급자/발송지/본사 문맥', points: /^(?:공급자|발송지|본사)$/.test(currentSection) ? -80 : 0 },
                        { reason: '건물명 관련 단어 의심', points: /상가|아파트|빌딩|타워|센터/.test(name) ? -8 : 0 },
                        { reason: '법인 접두사만 존재하거나 층수', points: /^(?:주식회사|유한회사|법인명|\(주\)|㈜)$/.test(name) || /^(?:지하|지상)?\s*B?\d+\s*층$/i.test(name) ? -100 : 0 }
                    ], rejected: score < 75, reason: score < 75 ? 'OCR 신뢰도 기준 75점 미만' : '최종 순위 비교 대상' });
                candidates.push({ name, score });
            }
            if (sections.length) section = sections[sections.length - 1][0];
        }
        const ranked = [...new Set(candidates.map(candidate => candidate.name))]
            .map(name => ({ name, score: Math.max(...candidates.filter(candidate => candidate.name === name).map(candidate => candidate.score)) }))
            .sort((a, b) => b.score - a.score);
        logStoreNameDiagnostic('OCR 전체 후보와 순위', { candidates, ranked, minimumScore: 75, minimumMargin: 10 });
        if (!ranked.length || ranked[0].score < 75) { logStoreNameDiagnostic('OCR 선택 결과', { selected: null, reason: !ranked.length ? '유효 후보 없음' : '최고 점수 75점 미만', ranked }); return null; }
        if (ranked[1] && ranked[0].score - ranked[1].score < 10) { logStoreNameDiagnostic('OCR 선택 결과', { selected: null, reason: '상위 후보 점수 차 10점 미만', ranked }); return null; }
        logStoreNameDiagnostic('OCR 선택 결과', { selected: ranked[0].name, ranked, eliminated: ranked.slice(1).map(candidate => ({ ...candidate, reason: '선택 후보보다 낮은 점수' })) });
        return ranked[0].name;
    } catch (e) {
        console.error("상호 추출 오류:", e);
    }
    return null;
}

// 상호 후보 판정 전용이며 기존 주소·전화번호 추출에는 사용하지 않음
// 상호 판정 전용: 이름 자체가 아닌 사람 필드 라벨과 구분자를 찾음
export function findStoreNamePersonField(text, allowLeadingBareLabel = true) {
    const labels = '성\\s*명|대\\s*표\\s*자|담\\s*당\\s*자|대\\s*표';
    const matches = [];
    for (const match of text.matchAll(new RegExp('(' + labels + ')\\s*[:：=|]', 'g'))) {
        matches.push({ index: match.index, label: match[1], reason: '사람 필드 라벨과 명시적 구분자' });
    }
    for (const match of text.matchAll(new RegExp('(^|[\\s|;])(' + labels + ')(?=\\s|$)', 'g'))) {
        const index = match.index + match[1].length;
        // 상호 라벨 바로 뒤의 "대표 유통"은 단어만으로 절삭하지 않음
        if (index === 0 && !allowLeadingBareLabel && match[2].replace(/\s/g, '') === '대표' && text.slice(match[0].length).trim()) continue;
        matches.push({ index, label: match[2], reason: '사람 필드 라벨과 공백/줄 경계' });
    }
    for (const match of text.matchAll(/(^|[\s|;])(성\s*명|대\s*표\s*자|담\s*당\s*자)(?=[가-힣])/g)) {
        const index = match.index + match[1].length;
        if (index > 0 || allowLeadingBareLabel) matches.push({ index, label: match[2], reason: '필드 경계 뒤 라벨과 값 공백 누락' });
    }
    matches.sort((a, b) => a.index - b.index);
    return matches[0] || null;
}

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
