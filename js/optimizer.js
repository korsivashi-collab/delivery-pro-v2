// js/optimizer.js

// =================================================================
// [배송 동선 PRO] 하버사인 · 다중 시작 후보 · 종료지점 비교 · 근접 배송지 묶음
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

// 근접 배송지 왕복 구간을 찾는 최대 직선거리(km).
const MAX_LOCAL_SPAN_KM = 0.9;

// 동선 최적화 메인 오케스트레이터 알고리즘
export async function calculateOptimizedRoute(destinations, startLocation, endLocation, options = {}) {
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
    
    // 1단계: 거리 기반 최근접 이웃 뼈대 생성
    while (unassigned.length > 0) {
        let bestIdx = -1; 
        let bestScore = Infinity;
        for (let i = 0; i < unassigned.length; i++) {
            let n = unassigned[i];
            let dist = getCachedDistance(curr, n);
            // 방향 투영값은 진단에만 사용한다. 짧은 출발-도착 축의 우회 편향을 제거한다.
            let score = dist;

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

    // 출발/도착을 고정한 2-opt 및 단일 배송지 이동. 지역 최솟값을 피하기 위해
    // 첫 배송지를 달리한 후보도 비교하며, 기존 후보보다 짧은 결과만 채택한다.
    function improvePath(path, mutableLast = hasEnd ? path.length - 2 : path.length - 1) {
        const last = mutableLast;
        for (let pass = 0; pass < 100; pass++) {
            let changed = false;
            for (let i = 1; i < last; i++) {
                for (let j = i + 1; j <= last; j++) {
                    const before = getCachedDistance(path[i - 1], path[i]) +
                        (path[j + 1] ? getCachedDistance(path[j], path[j + 1]) : 0);
                    const after = getCachedDistance(path[i - 1], path[j]) +
                        (path[j + 1] ? getCachedDistance(path[i], path[j + 1]) : 0);
                    if (after < before - 0.0001) {
                        path.splice(i, j - i + 1, ...path.slice(i, j + 1).reverse());
                        changed = true;
                    }
                }
            }
            // 2-opt로 해결되지 않는 고립 배송지는 다른 두 배송지 사이로 이동한다.
            let bestDelta = -0.0001, moveFrom = -1, moveAfter = -1;
            for (let from = 1; from <= last; from++) {
                const point = path[from], prev = path[from - 1], next = path[from + 1];
                const removal = (next ? getCachedDistance(prev, next) - getCachedDistance(point, next) : 0)
                    - getCachedDistance(prev, point);
                for (let after = 0; after <= last; after++) {
                    if (after === from || after === from - 1) continue;
                    const a = path[after], b = path[after + 1];
                    const delta = removal + getCachedDistance(a, point) +
                        (b ? getCachedDistance(point, b) - getCachedDistance(a, b) : 0);
                    if (delta < bestDelta) { bestDelta = delta; moveFrom = from; moveAfter = after; }
                }
            }
            if (moveFrom >= 0) {
                const [point] = path.splice(moveFrom, 1);
                path.splice(moveAfter + (moveAfter < moveFrom ? 1 : 0), 0, point);
                changed = true;
            }
            if (!changed) break;
        }
        return path;
    }
    const pathCost = path => path.slice(1).reduce((sum, point, i) =>
        sum + getCachedDistance(path[i], point), 0);
    fullRoute = improvePath(fullRoute);
    let bestCost = pathCost(fullRoute);
    const stops = allPoints.slice(1, hasEnd ? -1 : undefined);
    // 작은 경로는 모든 시작 후보, 큰 경로는 가까운/먼 후보를 포함한 최대 12개만 탐색.
    const seeds = [...stops].sort((a, b) => getCachedDistance(startPoint, a) - getCachedDistance(startPoint, b));
    const sampled = seeds.length <= 32 ? seeds :
        Array.from({ length: 12 }, (_, i) => seeds[Math.round(i * (seeds.length - 1) / 11)]);
    for (const seed of sampled) {
        const remaining = stops.filter(point => point !== seed);
        const candidate = [startPoint, seed];
        while (remaining.length) {
            let next = 0;
            for (let i = 1; i < remaining.length; i++) {
                if (getCachedDistance(candidate.at(-1), remaining[i]) <
                    getCachedDistance(candidate.at(-1), remaining[next])) next = i;
            }
            candidate.push(remaining.splice(next, 1)[0]);
        }
        if (hasEnd) candidate.push(endLocation);
        improvePath(candidate);
        const cost = pathCost(candidate);
        if (cost < bestCost - 0.0001) { fullRoute = candidate; bestCost = cost; }
    }

    // 집까지의 귀환을 합산해 마지막 배송지 후보를 비교한다.
    // 작은 경로는 모든 마지막 후보, 큰 경로는 집 인근 및 분산 후보 최대 12곳.
    let terminalCandidates = 0;
    if (hasEnd && stops.length > 1) {
        const nearHome = [...stops].sort((a, b) => getCachedDistance(a, endLocation) - getCachedDistance(b, endLocation));
        const finals = stops.length <= 32 ? stops : [...new Set([
            ...nearHome.slice(0, 6),
            ...Array.from({ length: 6 }, (_, i) => nearHome[Math.round(i * (nearHome.length - 1) / 5)])
        ])];
        terminalCandidates = finals.length;
        for (const terminal of finals) {
            const inner = stops.filter(point => point !== terminal);
            const firsts = [...inner].sort((a, b) => getCachedDistance(startPoint, a) - getCachedDistance(startPoint, b));
            const firstCandidates = inner.length <= 32 ? firsts :
                [firsts[0], firsts[Math.floor(firsts.length / 2)], firsts.at(-1)];
            for (const first of firstCandidates) {
                const remaining = inner.filter(point => point !== first);
                const candidate = [startPoint, first];
                while (remaining.length) {
                    let next = 0;
                    for (let i = 1; i < remaining.length; i++) {
                        if (getCachedDistance(candidate.at(-1), remaining[i]) <
                            getCachedDistance(candidate.at(-1), remaining[next])) next = i;
                    }
                    candidate.push(remaining.splice(next, 1)[0]);
                }
                candidate.push(terminal, endLocation);
                improvePath(candidate, candidate.length - 3);
                const cost = pathCost(candidate); // 마지막 배송지 → 집까지 포함.
                if (cost < bestCost - 0.0001) { fullRoute = candidate; bestCost = cost; }
            }
        }
    }

    // 근접 배송지 사이의 먼 왕복은 앞/뒤 묶음 후보를 전체 거리로 비교한다.
    let grouped = 0;
    for (let pass = 0; pass < 4; pass++) {
        let best = pathCost(fullRoute), chosen = null;
        const stopCount = fullRoute.length - (hasEnd ? 1 : 0);
        for (let i = 1; i < stopCount - 2; i++) for (let j = i + 2; j < stopCount; j++) {
            const a = fullRoute[i], b = fullRoute[j], close = getCachedDistance(a, b);
            if (close > MAX_LOCAL_SPAN_KM) continue;
            const middle = fullRoute.slice(i + 1, j);
            const travel = pathCost(fullRoute.slice(i, j + 1));
            if (travel - close < 1.2 || travel < close * 2) continue;
            for (const local of [[a, b, ...middle], [b, a, ...middle], [...middle, a, b], [...middle, b, a]]) {
                const trial = [...fullRoute.slice(0, i), ...local, ...fullRoute.slice(j + 1)];
                const cost = pathCost(trial); // Includes the final delivery → home.
                if (cost < best - 0.0001) { best = cost; chosen = trial; }
            }
        }
        if (!chosen) break;
        fullRoute = chosen; grouped++;
    }
    options.onComplete?.({ clusters: 0, failed: 0, excursions: grouped, terminalCandidates,
        correctionPolicy: 'haversine-local', kakaoCalls: 0, kakaoCallLimit: 0 });
    return hasEnd ? fullRoute.slice(0, -1) : fullRoute;
}
