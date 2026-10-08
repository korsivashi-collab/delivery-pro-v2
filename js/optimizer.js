// js/optimizer.js

// 두 지점 간의 거리 계산 (하버사인 공식)
export function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + 
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const MIN_CLUSTER_SIZE = 3;
const ZIGZAG_WINDOW_SIZE = 5;
const ZIGZAG_SCORE_THRESHOLD = 2;
// Distance is only a guard on the whole inspected window, not the AI trigger.
const MAX_LOCAL_SPAN_KM = 1;

function scoreZigzag(nodes) {
    const reasons = { directionReversals: 0, progressRecovery: 0, crossings: 0, consecutiveSharpTurns: 0 };
    const vectors = [];
    let previousProgressSign = 0, previousSharpTurn = false;
    for (let i = 1; i < nodes.length; i++) {
        const a = nodes[i - 1], b = nodes[i];
        const vector = { x: (b.lng - a.lng) * Math.cos((a.lat + b.lat) * Math.PI / 360), y: b.lat - a.lat };
        const length = Math.hypot(vector.x, vector.y);
        if (length > 0) vectors.push({ ...vector, length });
        if (Number.isFinite(a.progress) && Number.isFinite(b.progress)) {
            const delta = b.progress - a.progress;
            const sign = Math.abs(delta) > 0.000001 ? Math.sign(delta) : 0;
            if (previousProgressSign < 0 && sign > 0) reasons.progressRecovery++;
            if (sign) previousProgressSign = sign;
        }
    }
    for (let i = 1; i < vectors.length; i++) {
        const a = vectors[i - 1], b = vectors[i];
        const dot = a.x * b.x + a.y * b.y;
        if (dot < 0) reasons.directionReversals++;
        const sharp = dot < -Math.SQRT1_2 * a.length * b.length; // turn > 135 degrees
        if (previousSharpTurn && sharp) reasons.consecutiveSharpTurns++;
        previousSharpTurn = sharp;
    }
    const side = (a, b, c) => (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
    for (let i = 0; i < nodes.length - 1; i++) {
        for (let j = i + 2; j < nodes.length - 1; j++) {
            const a = nodes[i], b = nodes[i + 1], c = nodes[j], d = nodes[j + 1];
            // Proper crossings only: touching endpoints and collinear segments do not count.
            if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) reasons.crossings++;
        }
    }
    const score = reasons.directionReversals + reasons.progressRecovery + reasons.crossings * 2 + reasons.consecutiveSharpTurns;
    return { score, reasons };
}

// LLM API를 호출하여 밀집 구간을 최적화하는 비동기 함수
async function optimizeClusterWithLLM(clusterNodes, diagnostic = {}) {
    diagnostic.fallback = true;
    const controller = new AbortController();
    let timer;
    try {
        // 응답 본문까지 제한 시간에 포함하고 실패 시 기본 경로를 유지한다.
        const data = await Promise.race([
            Promise.resolve().then(async () => {
                const response = await fetch('/api/optimize-llm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ destinations: clusterNodes.map(({ id, address, storeName, lat, lng }) =>
                        ({ id, address, storeName, lat, lng })) }),
                    signal: controller.signal
                });
                if (!response.ok) return null;
                return response.json();
            }),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error('LLM_TIMEOUT'));
                    controller.abort();
                }, 20000);
            })
        ]);
        // LLM이 특정 조건에 따라 정리해준 순서가 있다면 경로에 반영
        const ids = new Set(clusterNodes.map(node => String(node.id)));
        if (Array.isArray(data?.optimized) && ids.size === clusterNodes.length &&
            data.optimized.length === clusterNodes.length &&
            new Set(data.optimized).size === clusterNodes.length &&
            data.optimized.every(id => typeof id === 'string' && ids.has(id))) {
            diagnostic.fallback = false;
            const orderMap = new Map(data.optimized.map((id, index) => [String(id), index]));
            return [...clusterNodes].sort((a, b) => {
                const idxA = orderMap.has(String(a.id)) ? orderMap.get(String(a.id)) : 999;
                const idxB = orderMap.has(String(b.id)) ? orderMap.get(String(b.id)) : 999;
                return idxA - idxB;
            });
        }
        return clusterNodes;
    } catch (error) {
        console.warn('LLM API 호출 실패:', error);
        return clusterNodes; // 에러 발생 시 앱이 멈추지 않도록 원본 경로 안전 유지
    } finally { clearTimeout(timer); }
}

// 동선 최적화 메인 알고리즘 (시작점, 종료점 확정 후 경로 생성 시작)
export async function calculateOptimizedRoute(destinations, startLocation, endLocation) {
    if (destinations.length < 2) {
        throw new Error("출발지를 포함하여 최소 2곳의 배송지가 필요합니다.");
    }
    if (!startLocation || !startLocation.lat) {
        throw new Error("시작 지점이 먼저 선택되어야 합니다.");
    }

    let hasEnd = (endLocation && endLocation.lat && endLocation.lat !== 0);
    let startPoint = destinations[0];
    let unassigned = destinations.slice(1).sort((a, b) => a.id - b.id);
    let allPoints = [startPoint, ...unassigned];
    if (hasEnd) allPoints.push(endLocation);

    const coordinateIndices = new Map();
    const pointIndices = new WeakMap();
    allPoints.forEach(point => {
        if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
        const lat = Object.is(point.lat, -0) ? '-0' : point.lat;
        const lng = Object.is(point.lng, -0) ? '-0' : point.lng;
        const key = `${lat},${lng}`;
        if (!coordinateIndices.has(key)) coordinateIndices.set(key, coordinateIndices.size);
        pointIndices.set(point, coordinateIndices.get(key));
    });
    
    const coordinateCount = coordinateIndices.size;
    const distanceCache = [];
    
    function getCachedDistance(pointA, pointB) {
        const indexA = pointIndices.get(pointA);
        const indexB = pointIndices.get(pointB);
        if (indexA === undefined || indexB === undefined) {
            return getDistance(pointA.lat, pointA.lng, pointB.lat, pointB.lng);
        }
        const key = indexA < indexB
            ? indexA * coordinateCount + indexB
            : indexB * coordinateCount + indexA;
        const cachedDistance = distanceCache[key];
        if (cachedDistance !== undefined) return cachedDistance;
        const distance = getDistance(pointA.lat, pointA.lng, pointB.lat, pointB.lng);
        distanceCache[key] = distance;
        return distance;
    }

    let axisStart = startPoint;
    let axisEnd = endLocation;

    if (!hasEnd) {
        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
        allPoints.forEach(p => {
            if (p.lat < minLat) minLat = p.lat; 
            if (p.lat > maxLat) maxLat = p.lat;
            if (p.lng < minLng) minLng = p.lng; 
            if (p.lng > maxLng) maxLng = p.lng;
        });
        axisEnd = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
    }

    let axisLat = axisEnd.lat - axisStart.lat;
    let axisLng = axisEnd.lng - axisStart.lng;
    let axisLenSq = (axisLat * axisLat) + (axisLng * axisLng);

    unassigned.forEach(n => {
        let vLat = n.lat - axisStart.lat;
        let vLng = n.lng - axisStart.lng;
        n.progress = axisLenSq > 0.000001 ? (vLat * axisLat + vLng * axisLng) / axisLenSq : 0;
    });

    let route = []; 
    let curr = startPoint;
    
    while(unassigned.length > 0) {
        let bestIdx = -1; 
        let bestScore = Infinity;
        for(let i = 0; i < unassigned.length; i++) {
            let n = unassigned[i];
            let dist = getCachedDistance(curr, n);
            // Progress remains available to zigzag detection; selection uses distance only.
            let score = dist;
            if(score < bestScore) { 
                bestScore = score; 
                bestIdx = i; 
            }
        }
        route.push(unassigned[bestIdx]);
        curr = unassigned[bestIdx];
        unassigned.splice(bestIdx, 1);
    }

    let fullRoute = [startPoint, ...route];
    if (hasEnd) fullRoute.push(endLocation);

    // 1단계: 하버사인 + 2-opt 알고리즘을 통한 뼈대 경로 구성
    let improved = true; 
    let iter = 0;
    let endIndex = hasEnd ? fullRoute.length - 2 : fullRoute.length - 1;

    while(improved && iter < 1000) {
        improved = false; 
        iter++;
        for(let i = 1; i < endIndex; i++) {
            for(let j = i + 1; j <= endIndex; j++) {
                let nodeI_prev = fullRoute[i-1]; 
                let nodeI = fullRoute[i]; 
                let nodeJ = fullRoute[j]; 
                let nodeJ_next = fullRoute[j+1];
                let d_curr = getCachedDistance(nodeI_prev, nodeI);
                if (nodeJ_next) d_curr += getCachedDistance(nodeJ, nodeJ_next);
                let d_new = getCachedDistance(nodeI_prev, nodeJ);
                if (nodeJ_next) d_new += getCachedDistance(nodeI, nodeJ_next);
                if (d_new < d_curr - 0.0001) {
                    let subArray = fullRoute.slice(i, j + 1).reverse();
                    fullRoute.splice(i, subArray.length, ...subArray);
                    improved = true;
                }
            }
        }
    }

    // 2단계 실험: baseline 경로의 짧은 window만 검사하고 겹치는 호출은 제외한다.
    const candidates = [];
    const windowSize = Math.min(ZIGZAG_WINDOW_SIZE, fullRoute.length);
    const mutableEnd = hasEnd ? fullRoute.length - 1 : fullRoute.length;
    const inspectPoint = point => ({ ...point,
        progress: point === startPoint || (hasEnd && point === endLocation)
            ? (axisLenSq > 0.000001 ? ((point.lat - axisStart.lat) * axisLat + (point.lng - axisStart.lng) * axisLng) / axisLenSq : 0)
            : point.progress });
    const inspectedRoute = fullRoute.map(inspectPoint);
    for (let offset = 0; offset <= fullRoute.length - windowSize; offset++) {
        const from = Math.max(1, offset), to = Math.min(mutableEnd, offset + windowSize);
        if (to - from < MIN_CLUSTER_SIZE) continue;
        const window = inspectedRoute.slice(offset, offset + windowSize);
        const { score, reasons } = scoreZigzag(window);
        if (score < ZIGZAG_SCORE_THRESHOLD) continue;
        let spanKm = 0;
        for (let i = offset; i < offset + windowSize; i++) {
            for (let j = i + 1; j < offset + windowSize; j++) spanKm = Math.max(spanKm, getCachedDistance(fullRoute[i], fullRoute[j]));
        }
        const ids = fullRoute.slice(from, to).map(node => node.id);
        const local = Number.isFinite(spanKm) && spanKm <= MAX_LOCAL_SPAN_KM;
        if (!local) {
            console.debug?.('[Zigzag AI]', { ids, score, reasons, spanKm, local: false, called: false,
                before: ids, after: ids, fallback: true, skipped: 'NON_LOCAL' });
            continue;
        }
        candidates.push({ from, to, windowFrom: offset, windowTo: offset + windowSize, score, reasons, spanKm });
    }
    // Prefer the strongest signal; each delivery can be passed to AI at most once.
    const selected = [];
    candidates.sort((a, b) => b.score - a.score || a.from - b.from);
    for (const candidate of candidates) {
        if (selected.some(other => candidate.from < other.to && other.from < candidate.to)) {
            const ids = fullRoute.slice(candidate.from, candidate.to).map(node => node.id);
            console.debug?.('[Zigzag AI]', { ids, score: candidate.score, reasons: candidate.reasons,
                spanKm: candidate.spanKm, local: true, called: false, before: ids, after: ids,
                fallback: true, skipped: 'OVERLAP' });
        } else selected.push(candidate);
    }
    const finalRoute = fullRoute.slice();
    selected.sort((a, b) => a.from - b.from);
    for (const candidate of selected) {
        const clusterNodes = fullRoute.slice(candidate.from, candidate.to);
        const diagnostic = {};
        const optimized = await optimizeClusterWithLLM(clusterNodes, diagnostic);
        const proposedRoute = finalRoute.slice();
        proposedRoute.splice(candidate.from, clusterNodes.length, ...optimized);
        const scoreWindow = route => scoreZigzag(route.slice(candidate.windowFrom, candidate.windowTo).map(inspectPoint)).score;
        const beforeScore = scoreWindow(finalRoute), afterScore = scoreWindow(proposedRoute);
        // A valid ID permutation can still make the detected problem worse.
        const worsened = afterScore > beforeScore;
        if (!worsened) finalRoute.splice(candidate.from, clusterNodes.length, ...optimized);
        console.debug?.('[Zigzag AI]', { ids: clusterNodes.map(node => node.id), score: candidate.score,
            reasons: candidate.reasons, spanKm: candidate.spanKm, local: true, called: true,
            before: clusterNodes.map(node => node.id), proposed: optimized.map(node => node.id),
            after: finalRoute.slice(candidate.from, candidate.to).map(node => node.id), beforeScore, afterScore,
            fallback: diagnostic.fallback || worsened, ...(worsened ? { skipped: 'SCORE_WORSENED' } : {}) });
    }
    // endLocation is a calculation anchor, not a delivery destination.
    return hasEnd ? finalRoute.slice(0, -1) : finalRoute;
}
