// js/optimizer.js
import { apiFetch } from './native-platform.js';

// =================================================================
// [배송 동선 PRO] 하버사인 기본 경로 + 종료지점 포함 총 도로 거리 비교
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

// 첨부 27건의 밀집도 기준: 배송지 간 최대 직선거리 900m, 최소 3곳.
const MIN_CLUSTER_SIZE = 3;
const MAX_CLUSTER_SIZE = 6;
const MAX_LOCAL_SPAN_KM = 0.9;

// 앞뒤 앵커를 포함한 실제 도로 경로를 서버에서 비교한다. LLM은 호출하지 않는다.
async function optimizeClusterWithKakao(nodes, context, prevAnchor, nextAnchor, originAngle, mode = 'dense', fixedLastId = null, collector = null) {
    const controller = new AbortController();
    let timer;
    const coordinate = point => point ? { lat: point.lat, lng: point.lng } : null;
    const body = {
        destinations: nodes.map(({ id, lat, lng }) => ({ id: String(id), lat, lng })),
        context: context.map(({ id, lat, lng }) => ({ id: String(id), lat, lng })),
        prevAnchor: coordinate(prevAnchor), nextAnchor: coordinate(nextAnchor), originAngle, mode, fixedLastId
    };
    if (collector) { collector.push(body); return context; }
    body.comparisonMode = 'exhaustive';
    try {
        const data = await Promise.race([
            Promise.resolve().then(async () => {
                // 기존 배포 주소를 유지하며 서버 구현은 카카오 경로 비교로 교체했다.
                const response = await apiFetch('/api/optimize-llm', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body), signal: controller.signal
                });
                if (!response.ok) throw new Error('KAKAO_ROUTE_UNAVAILABLE');
                return response.json();
            }),
            new Promise((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Error('KAKAO_ROUTE_TIMEOUT')); }, 43000);
            })
        ]);
        const expected = new Set(context.map(point => String(point.id)));
        if (data?.source !== 'kakao' || !Array.isArray(data.optimized) ||
            expected.size !== context.length || data.optimized.length !== context.length ||
            new Set(data.optimized).size !== context.length ||
            !data.optimized.every(id => typeof id === 'string' && expected.has(id)) ||
            !Number.isFinite(data.duration) || data.duration < 0 ||
            !Number.isFinite(data.distance) || data.distance < 0 ||
            (fixedLastId != null && data.optimized.at(-1) !== fixedLastId)) throw new Error('KAKAO_ROUTE_INVALID');
        const byId = new Map(context.map(point => [String(point.id), point]));
        return data.optimized.map(id => byId.get(id));
    } catch (_) {
        return null;
    } finally { clearTimeout(timer); }
}

// 동선 최적화 메인 오케스트레이터 알고리즘
export async function calculateOptimizedRoute(destinations, startLocation, endLocation, options = {}) {
    // The legacy exhaustive policy is explicitly available for comparison only.
    // Normal optimization measures two full routes within four calls (up to 62 stops).
    // Larger inputs use bounded local distance correction.
    const budgetWindows = options.roadCorrection === 'full' ? null : [];
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

    if (options.roadCorrection === 'none') {
        // Temporary offline comparison: keep the nearby-stop excursion idea,
        // evaluate its front/back attachments without contacting the server.
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
            correctionPolicy: 'haversine-test', kakaoCalls: 0, kakaoCallLimit: 0 });
        return hasEnd ? fullRoute.slice(0, -1) : fullRoute;
    }

    // 경로상 떨어져 있어도 좌표가 가까우면 같은 묶음으로 찾는다.
    // 긴 연결 사슬은 만들지 않고 모든 배송지 쌍이 900m 이내인 묶음만 허용한다.
    const finalRoute = fullRoute.slice();
    // 마지막 배송지를 포함한 밀집 구간도 비교하되, 선택한 마지막 위치는 고정한다.
    const fixedTerminal = hasEnd ? fullRoute.at(-2) : null;
    const mutableEnd = hasEnd ? fullRoute.length - 1 : fullRoute.length;
    let pool = fullRoute.slice(1, mutableEnd);
    const clusters = [];
    while (pool.length >= MIN_CLUSTER_SIZE) {
        let best = [];
        for (const seed of pool) {
            const neighbors = pool.filter(point => point !== seed)
                .sort((a, b) => getCachedDistance(seed, a) - getCachedDistance(seed, b));
            const group = [seed];
            for (const point of neighbors) {
                if (group.every(other => getCachedDistance(other, point) <= MAX_LOCAL_SPAN_KM)) group.push(point);
            }
            const size = group.length === 7 ? 4 : group.length === 8 ? 5 : Math.min(MAX_CLUSTER_SIZE, group.length);
            const candidate = group.slice(0, size);
            const positions = candidate.map(point => fullRoute.indexOf(point));
            const context = fullRoute.slice(Math.min(...positions), Math.max(...positions) + 1);
            if (context.length <= MAX_CLUSTER_SIZE && context.every((point, i) => context.slice(i + 1)
                .every(other => getCachedDistance(point, other) <= MAX_LOCAL_SPAN_KM)) && candidate.length > best.length) best = candidate;
        }
        if (best.length < MIN_CLUSTER_SIZE) break;
        const size = best.length === 7 ? 4 : best.length === 8 ? 5 : Math.min(MAX_CLUSTER_SIZE, best.length);
        const group = best.slice(0, size).sort((a, b) => fullRoute.indexOf(a) - fullRoute.indexOf(b));
        clusters.push(group);
        const members = new Set(group);
        pool = pool.filter(point => !members.has(point));
    }
    clusters.sort((a, b) => fullRoute.indexOf(a[0]) - fullRoute.indexOf(b[0]));
    const bearing = (a, b) => {
        if (!a || (a.lat === b.lat && a.lng === b.lng)) return null;
        const rad = Math.PI / 180, dl = (b.lng - a.lng) * rad;
        const angle = Math.atan2(Math.sin(dl) * Math.cos(b.lat * rad),
            Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos(dl));
        return Math.round((angle * 180 / Math.PI + 360) % 360) % 360;
    };
    let failed = 0;
    for (let index = 0; index < clusters.length; index++) {
        const nodes = clusters[index];
        const positions = nodes.map(point => finalRoute.indexOf(point));
        // 큰 권역 흐름은 고정한다. 묶음 사이에 먼 배송지가 끼어 있으면 이동시키지 않는다.
        let from = Math.min(...positions), to = Math.max(...positions) + 1;
        const local = points => points.every((point, i) => points.slice(i + 1)
            .every(other => getCachedDistance(point, other) <= MAX_LOCAL_SPAN_KM));
        if (to - from > MAX_CLUSTER_SIZE || !local(finalRoute.slice(from, to))) { failed++; continue; }
        // 앞/뒤 붙이기는 같은 900m 구간 안에서만 비교한다. 최대 6곳, 앵커는 고정.
        for (let step = 0; step < 2; step++) {
            if (from > 1 && to - from < MAX_CLUSTER_SIZE && local(finalRoute.slice(from - 1, to))) from--;
            if (to < mutableEnd && to - from < MAX_CLUSTER_SIZE && local(finalRoute.slice(from, to + 1))) to++;
        }
        const context = finalRoute.slice(from, to);
        options.onProgress?.({ current: index + 1, total: clusters.length });
        const prevAnchor = finalRoute[from - 1], nextAnchor = finalRoute[to] || null;
        const optimized = await optimizeClusterWithKakao(nodes, context, prevAnchor, nextAnchor,
            bearing(finalRoute[from - 2], prevAnchor), 'dense',
            fixedTerminal && context.includes(fixedTerminal) ? String(fixedTerminal.id) : null, budgetWindows);
        if (optimized) {
            // 가까운 배송지를 모아 앞뒤로 이동한다. 다른 배송지끼리의 상대 순서는 유지한다.
            finalRoute.splice(from, context.length, ...optimized);
        } else failed++;
    }
    // 가까운 두 배송지 사이의 먼 왕복: 앞/뒤 묶음 배치를 별도로 비교한다.
    const excursions = [];
    for (let from = 1; from < mutableEnd - 2; from++) {
        for (let to = from + 3; to <= Math.min(mutableEnd, from + 6); to++) {
            const context = finalRoute.slice(from, to);
            const close = getCachedDistance(context[0], context.at(-1));
            const travel = pathCost(context);
            const span = Math.max(...context.flatMap((point, i) => context.slice(i + 1).map(other => getCachedDistance(point, other))));
            if (close <= MAX_LOCAL_SPAN_KM && travel - close >= 1.2 && travel >= close * 2 && span <= 6) {
                excursions.push({ from, to, excess: travel - close });
            }
        }
    }
    const selected = [];
    for (const candidate of excursions.sort((a, b) => b.excess - a.excess || a.from - b.from)) {
        if (!selected.some(other => candidate.from < other.to && other.from < candidate.to)) selected.push(candidate);
    }
    selected.sort((a, b) => a.from - b.from);
    for (let index = 0; index < selected.length; index++) {
        const { from, to } = selected[index];
        const context = finalRoute.slice(from, to), prev = finalRoute[from - 1];
        options.onProgress?.({ current: clusters.length + index + 1, total: clusters.length + selected.length });
        const optimized = await optimizeClusterWithKakao([context[0], context.at(-1)], context, prev,
            finalRoute[to] || null, bearing(finalRoute[from - 2], prev), 'excursion',
            fixedTerminal && context.includes(fixedTerminal) ? String(fixedTerminal.id) : null, budgetWindows);
        if (optimized) finalRoute.splice(from, context.length, ...optimized); else failed++;
    }
    if (budgetWindows) {
        const base = hasEnd ? finalRoute.slice(0, -1) : finalRoute;
        let result = base, kakaoCalls = 0, callCountKnown = true, correctionPolicy = 'total-distance-4';
        if (base.length <= 62 || budgetWindows.length) {
            const controller = new AbortController();
            let timer;
            try {
                const token = options.getAuthToken ? await options.getAuthToken() : null;
                const response = await Promise.race([
                    apiFetch('/api/optimize-llm', {
                        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, signal: controller.signal,
                        body: JSON.stringify({ mode: 'budget-four', strategy: 'total-distance', route: base.map(({ id, lat, lng }) => ({ id: String(id), lat, lng })),
                            endLocation: hasEnd ? { lat: endLocation.lat, lng: endLocation.lng } : null, windows: budgetWindows })
                    }),
                    new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('BUDGET_TIMEOUT')); }, 43000); })
                ]);
                if (!response.ok) throw new Error('BUDGET_UNAVAILABLE');
                const data = await response.json(), ids = data.optimized, byId = new Map(base.map(p => [String(p.id), p]));
                if (data.source === 'haversine' && data.selectionPolicy === 'daily-haversine' && data.calls === 0 &&
                    Array.isArray(ids) && ids.length === base.length && ids.every((id, i) => id === String(base[i].id))) {
                    options.onComplete?.({ clusters: budgetWindows.length, failed: 0, excursions: selected.length, terminalCandidates,
                        correctionPolicy: 'daily-haversine', kakaoCalls: 0, kakaoCallLimit: 4, quota: data.quota, quotaReason: data.reason });
                    return base;
                }
                if (data.source !== 'kakao' || !['total-distance-4', 'packed-reverse-4'].includes(data.selectionPolicy) ||
                    !Number.isInteger(data.calls) || data.calls < 0 || data.calls > 4 ||
                    !Array.isArray(ids) || ids.length !== base.length || new Set(ids).size !== base.length ||
                    !ids.every(id => byId.has(id)) || ids[0] !== String(base[0].id) ||
                    (hasEnd && data.selectionPolicy !== 'total-distance-4' && ids.at(-1) !== String(base.at(-1).id))) throw new Error('BUDGET_RESULT_INVALID');
                if (data.selectionPolicy === 'total-distance-4' && data.baselineMeters != null &&
                    (!Number.isFinite(data.baselineMeters) || data.baselineMeters < 0 || !Number.isFinite(data.selectedMeters) ||
                    data.selectedMeters < 0 || data.selectedMeters > data.baselineMeters)) throw new Error('BUDGET_DISTANCE_INVALID');
                if (data.selectionPolicy === 'total-distance-4' && (data.objective !== 'DISTANCE' || data.includesEnd !== hasEnd ||
                    (data.baselineMeters == null && (data.selectedMeters !== null || !data.failedCalls ||
                    ids.some((id, i) => id !== String(base[i].id)))))) throw new Error('BUDGET_DISTANCE_INVALID');
                result = ids.map(id => byId.get(id)); kakaoCalls = data.calls;
                correctionPolicy = data.selectionPolicy;
                failed += Number.isInteger(data.failedWindows) ? data.failedWindows : 0;
            } catch (_) {
                // Keep the Haversine backbone. Never retry through the costly policy.
                failed++; callCountKnown = false;
            } finally { clearTimeout(timer); }
        }
        options.onComplete?.({ clusters: budgetWindows.length, failed, excursions: selected.length, terminalCandidates,
            correctionPolicy, kakaoCalls: callCountKnown ? kakaoCalls : null, kakaoCallLimit: 4 });
        return result;
    }
    options.onComplete?.({ clusters: clusters.length + selected.length, failed, excursions: selected.length, terminalCandidates });



    // 종료 지점(endLocation)은 계산용 앵커이므로 배송 목록에서 제외하고 반환
    return hasEnd ? finalRoute.slice(0, -1) : finalRoute;
}
