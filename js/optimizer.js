// js/optimizer.js

// =================================================================
// [배송 동선 PRO] 하버사인 + 2-opt 기반 뼈대 경로 및 LLM 밀집구간 정밀 최적화 엔진
// =================================================================

// 두 지점 간의 거리 계산 (하버사인 공식, 단위: km)
export function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + 
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const MIN_CLUSTER_SIZE = 3;
const ZIGZAG_WINDOW_SIZE = 6;
const ZIGZAG_SCORE_THRESHOLD = 2;
// 도심지 연속 배송 권역을 충분히 포용하도록 반경 상한을 2km로 완화
const MAX_LOCAL_SPAN_KM = 2.0;

// 지그재그 및 꼬임 현상 점수화 함수
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
        const sharp = dot < -Math.SQRT1_2 * a.length * b.length; // 135도 초과 급회전
        if (previousSharpTurn && sharp) reasons.consecutiveSharpTurns++;
        previousSharpTurn = sharp;
    }

    const side = (a, b, c) => (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
    for (let i = 0; i < nodes.length - 1; i++) {
        for (let j = i + 2; j < nodes.length - 1; j++) {
            const a = nodes[i], b = nodes[i + 1], c = nodes[j], d = nodes[j + 1];
            if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) {
                reasons.crossings++;
            }
        }
    }

    const score = reasons.directionReversals + reasons.progressRecovery + reasons.crossings * 2 + reasons.consecutiveSharpTurns;
    return { score, reasons };
}

// 구간 이동 거리 합산 계산 보조 함수
function calculateSectionDistance(points) {
    let sum = 0;
    for (let i = 0; i < points.length - 1; i++) {
        sum += getDistance(points[i].lat, points[i].lng, points[i + 1].lat, points[i + 1].lng);
    }
    return sum;
}

// 진입점(prevAnchor)과 진출점(nextAnchor)을 함께 고려하여 LLM을 호출하는 비동기 함수
async function optimizeClusterWithLLM(clusterNodes, prevAnchor = null, nextAnchor = null, diagnostic = {}) {
    diagnostic.fallback = true;
    const controller = new AbortController();
    let timer;

    try {
        const requestPayload = {
            destinations: clusterNodes.map(({ id, address, storeName, lat, lng }) => ({ id, address, storeName, lat, lng })),
            prevAnchor: prevAnchor ? { address: prevAnchor.address, storeName: prevAnchor.storeName, lat: prevAnchor.lat, lng: prevAnchor.lng } : null,
            nextAnchor: nextAnchor ? { address: nextAnchor.address, storeName: nextAnchor.storeName, lat: nextAnchor.lat, lng: nextAnchor.lng } : null
        };

        const data = await Promise.race([
            Promise.resolve().then(async () => {
                const response = await fetch('/api/optimize-llm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestPayload),
                    signal: controller.signal
                });
                if (!response.ok) return null;
                return response.json();
            }),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error('LLM_TIMEOUT'));
                    controller.abort();
                }, 18000);
            })
        ]);

        const ids = new Set(clusterNodes.map(node => String(node.id)));
        if (Array.isArray(data?.optimized) && ids.size === clusterNodes.length &&
            data.optimized.length === clusterNodes.length &&
            new Set(data.optimized).size === clusterNodes.length &&
            data.optimized.every(id => typeof id === 'string' && ids.has(id))) {
            
            diagnostic.fallback = false;
            const orderMap = new Map(data.optimized.map((id, index) => [String(id), index]));
            let orderedNodes = [...clusterNodes].sort((a, b) => {
                const idxA = orderMap.has(String(a.id)) ? orderMap.get(String(a.id)) : 999;
                const idxB = orderMap.has(String(b.id)) ? orderMap.get(String(b.id)) : 999;
                return idxA - idxB;
            });

            // 🌟 방향 역전 방어 로직: LLM 정렬 순서와 그 역순(Reverse)을 비교하여
            // 진입점(prevAnchor) -> 진출점(nextAnchor) 흐름에 더 자연스러운 방향을 자동 선택
            if (prevAnchor || nextAnchor) {
                const forwardPath = [prevAnchor, ...orderedNodes, nextAnchor].filter(Boolean);
                const reversedPath = [prevAnchor, ...[...orderedNodes].reverse(), nextAnchor].filter(Boolean);
                
                const forwardDist = calculateSectionDistance(forwardPath);
                const reverseDist = calculateSectionDistance(reversedPath);

                if (reverseDist < forwardDist * 0.92) {
                    orderedNodes = orderedNodes.reverse();
                }
            }

            return orderedNodes;
        }

        return clusterNodes;
    } catch (error) {
        console.warn('LLM 동선 최적화 API 호출 실패(기존 동선 유지):', error);
        return clusterNodes;
    } finally {
        clearTimeout(timer);
    }
}

// 동선 최적화 메인 오케스트레이터 알고리즘
export async function calculateOptimizedRoute(destinations, startLocation, endLocation) {
    if (destinations.length < 2) {
        throw new Error("출발지를 포함하여 최소 2곳의 배송지가 필요합니다.");
    }
    if (!startLocation || !startLocation.lat) {
        throw new Error("시작 지점이 먼저 선택되어야 합니다.");
    }

    let hasEnd = Boolean(endLocation && endLocation.lat && endLocation.lat !== 0);
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
    
    // 1단계: 진행 방향(progress)과 거리를 균형 있게 고려한 최근접 이웃 뼈대 생성
    while (unassigned.length > 0) {
        let bestIdx = -1; 
        let bestScore = Infinity;
        for (let i = 0; i < unassigned.length; i++) {
            let n = unassigned[i];
            let dist = getCachedDistance(curr, n);
            let progressDiff = (curr !== startPoint && curr.progress !== undefined && n.progress !== undefined)
                ? (curr.progress - n.progress) : 0;
            // 목적지와 반대 방향으로 과도하게 되돌아가는 현상 억제 (가중치 3.0)
            let backwardPenalty = progressDiff > 0 ? (progressDiff * 3.0) : 0;
            let score = dist + backwardPenalty;

            if (score < bestScore) { 
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

    // 2-opt 알고리즘 교차선 해소
    let improved = true; 
    let iter = 0;
    let endIndex = hasEnd ? fullRoute.length - 2 : fullRoute.length - 1;

    while (improved && iter < 1000) {
        improved = false; 
        iter++;
        for (let i = 1; i < endIndex; i++) {
            for (let j = i + 1; j <= endIndex; j++) {
                let nodeI_prev = fullRoute[i - 1]; 
                let nodeI = fullRoute[i]; 
                let nodeJ = fullRoute[j]; 
                let nodeJ_next = fullRoute[j + 1];
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

    // 2단계: 지그재그 의심 밀집 구역 추출 및 LLM 정밀 교정
    const candidates = [];
    const windowSize = Math.min(ZIGZAG_WINDOW_SIZE, fullRoute.length);
    const mutableEnd = hasEnd ? fullRoute.length - 1 : fullRoute.length;
    
    const inspectPoint = point => ({
        ...point,
        progress: point === startPoint || (hasEnd && point === endLocation)
            ? (axisLenSq > 0.000001 ? ((point.lat - axisStart.lat) * axisLat + (point.lng - axisStart.lng) * axisLng) / axisLenSq : 0)
            : point.progress
    });
    
    const inspectedRoute = fullRoute.map(inspectPoint);

    for (let offset = 0; offset <= fullRoute.length - windowSize; offset++) {
        const from = Math.max(1, offset);
        const to = Math.min(mutableEnd, offset + windowSize);
        if (to - from < MIN_CLUSTER_SIZE) continue;

        const window = inspectedRoute.slice(offset, offset + windowSize);
        const { score, reasons } = scoreZigzag(window);
        if (score < ZIGZAG_SCORE_THRESHOLD) continue;

        let spanKm = 0;
        for (let i = offset; i < offset + windowSize; i++) {
            for (let j = i + 1; j < offset + windowSize; j++) {
                spanKm = Math.max(spanKm, getCachedDistance(fullRoute[i], fullRoute[j]));
            }
        }

        const local = Number.isFinite(spanKm) && spanKm <= MAX_LOCAL_SPAN_KM;
        if (local) {
            candidates.push({ from, to, windowFrom: offset, windowTo: offset + windowSize, score, reasons, spanKm });
        }
    }

    // 겹치지 않게 최우선 점수의 밀집 후보 선별
    const selected = [];
    candidates.sort((a, b) => b.score - a.score || a.from - b.from);
    for (const candidate of candidates) {
        if (!selected.some(other => candidate.from < other.to && other.from < candidate.to)) {
            selected.push(candidate);
        }
    }

    const finalRoute = fullRoute.slice();
    selected.sort((a, b) => a.from - b.from);

    for (const candidate of selected) {
        const clusterNodes = finalRoute.slice(candidate.from, candidate.to);
        const prevAnchor = candidate.from > 0 ? finalRoute[candidate.from - 1] : null;
        const nextAnchor = candidate.to < finalRoute.length ? finalRoute[candidate.to] : null;

        const diagnostic = {};
        const optimized = await optimizeClusterWithLLM(clusterNodes, prevAnchor, nextAnchor, diagnostic);

        if (!diagnostic.fallback && optimized && optimized.length === clusterNodes.length) {
            // 🌟 이전 기하학적 SCORE_WORSENED 취소 버그 제거:
            // 도로/건물 묶음으로 인한 미세 곡률 증가는 허용하되, 총 거리가 비정상적으로 폭증(1.3배 초과)하지만 않으면 AI 결과 확정 적용
            const origPath = [prevAnchor, ...clusterNodes, nextAnchor].filter(Boolean);
            const optPath = [prevAnchor, ...optimized, nextAnchor].filter(Boolean);
            const origDist = calculateSectionDistance(origPath);
            const optDist = calculateSectionDistance(optPath);

            if (optDist <= origDist * 1.30) {
                finalRoute.splice(candidate.from, clusterNodes.length, ...optimized);
            }
        }
    }

    // 종료 지점(endLocation)은 계산용 앵커이므로 배송 목록에서 제외하고 반환
    return hasEnd ? finalRoute.slice(0, -1) : finalRoute;
}