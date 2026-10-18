import { calculateOptimizedRouteSync } from './optimizer.js';
// js/admin-dispatch-algorithm.js

// ==========================================
// 1. 하버사인(Haversine) 구면 거리 계산 엔진
// ==========================================

/**
 * 두 좌표 간의 실제 구면 거리 계산 (단위: km)
 */
export function getBaseDist(lat1, lon1, lat2, lon2) {
    if (lat1 === null || lat1 === undefined || isNaN(lat1) ||
        lon1 === null || lon1 === undefined || isNaN(lon1) ||
        lat2 === null || lat2 === undefined || isNaN(lat2) ||
        lon2 === null || lon2 === undefined || isNaN(lon2)) {
        return Infinity;
    }
    const R = 6371; // 지구 반지름 (km)
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ==========================================
// 2. 가중치 기반 기사별 목표 할당량(Cap) 산출
// ==========================================

/**
 * 관리자가 화면에서 설정한 가중치(weights)를 반영하여 기사별 쿼터를 정확히 분배
 */
export function calculateDriverCapacities(activeDrivers, totalOrders, weights = {}, companyBase = null) {
    const numDrivers = activeDrivers.length;
    if (numDrivers === 0) return [];

    let totalWeights = 0;
    activeDrivers.forEach(d => {
        const devId = d.deviceId || d.key;
        totalWeights += (weights[devId] || 0);
    });

    let driverStats = activeDrivers.map(d => {
        const devId = d.deviceId || d.key;
        const w = weights[devId] || 0;

        // 가중치에 따른 물량 Cap 조정
        let exactCap = (totalOrders / numDrivers) + w - (totalWeights / numDrivers);
        if (exactCap < 0) exactCap = 0;

        // 기사의 반고정 권역 중심 좌표 (미설정 시 거점 좌표 참조)
        const centerLat = d.territoryLat || (companyBase ? companyBase.lat : null);
        const centerLng = d.territoryLng || (companyBase ? companyBase.lng : null);
        const centerAddr = d.territory1 || (companyBase ? companyBase.address : '') || '';

        return {
            devId,
            key: d.key || devId,
            phone: d.phone || devId,
            exactCap,
            targetCap: Math.floor(exactCap),
            remainder: exactCap - Math.floor(exactCap),
            assignedCount: 0,
            assignedOrders: [],
            tLat: centerLat ? parseFloat(centerLat) : null,
            tLng: centerLng ? parseFloat(centerLng) : null,
            tAddr: centerAddr
        };
    });

    // 음수 가중치 보정 후에도 목표 합계가 실제 주문 수를 초과하지 않게 한다.
    const capSum = driverStats.reduce((sum,d)=>sum+d.exactCap,0);
    if (capSum > totalOrders && capSum > 0) driverStats.forEach(d => {
        d.exactCap *= totalOrders / capSum;
        d.targetCap = Math.floor(d.exactCap);
        d.remainder = d.exactCap - d.targetCap;
    });

    // 소수점 잔여 물량을 나머지가 큰 기사부터 공정하게 1건씩 추가 배분
    const currentSum = driverStats.reduce((sum, d) => sum + d.targetCap, 0);
    const diff = totalOrders - currentSum;

    driverStats.sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < diff; i++) {
        driverStats[i % driverStats.length].targetCap++;
    }

    return driverStats;
}

// ==========================================
// 3. 2-opt 기반 동선 순서 최적화 엔진 (꼬인 선 풀기)
// ==========================================

// 이미 수신한 경로에서 종료 설정만 읽습니다. 날짜와 배송 건수는 설정의 유효성과 무관합니다.
export function resolveDriverEndLocation(driver, routes, companyBase = null) {
    const entries = Object.entries(routes || {});
    const owned = driver.routeOwnerId
        ? entries.filter(([, route]) => route?.routeOwnerId === driver.routeOwnerId) : [];
    const candidates = owned.length ? owned : entries.filter(([id, route]) =>
        id === (driver.deviceId || driver.key) && route &&
        (!route.routeOwnerId || route.routeOwnerId === driver.routeOwnerId));
    candidates.sort(([aId, a], [bId, b]) =>
        (Number.isFinite(b.updatedAt) ? b.updatedAt : -1) -
        (Number.isFinite(a.updatedAt) ? a.updatedAt : -1) || aId.localeCompare(bId));
    const endpoint = candidates[0]?.[1]?.endLocation;
    const valid = p => p && p.lat !== null && p.lat !== undefined && p.lat !== '' &&
        p.lng !== null && p.lng !== undefined && p.lng !== '' &&
        Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) &&
        Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180 &&
        (Number(p.lat) !== 0 || Number(p.lng) !== 0);
    const selected = valid(endpoint) ? endpoint : companyBase;
    return valid(selected) ? {
        lat: Number(selected.lat), lng: Number(selected.lng), address: selected.address || ''
    } : null;
}

/** 기사에게 배정된 배송지를 거점 인근부터 기사별 종료지점 방향으로 정렬하고 번호를 부여합니다. */
export function optimizeRoute2Opt(orderList, basePos = null, endPos = basePos) {
    if (!orderList?.length) return orderList;
    const valid = p => p && p.lat !== null && p.lng !== null && p.lat !== '' && p.lng !== '' &&
        Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) &&
        Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180;
    const located = orderList.filter(valid);
    const missing = orderList.filter(p => !valid(p));
    if (valid(basePos) && located.length) {
        let nearest = 0;
        located.forEach((point, i) => {
            if (getBaseDist(basePos.lat, basePos.lng, point.lat, point.lng) <
                getBaseDist(basePos.lat, basePos.lng, located[nearest].lat, located[nearest].lng)) nearest = i;
        });
        located.unshift(located.splice(nearest, 1)[0]);
    }
    const points = located.map((order, i) => ({ id: i, lat: Number(order.lat), lng: Number(order.lng), order }));
    const end = valid(endPos) ? { lat: Number(endPos.lat), lng: Number(endPos.lng) } : null;
    const ordered = points.length > 1 ? calculateOptimizedRouteSync(points, points[0], end) : points;
    const result = [...ordered.map(point => point.order), ...missing];
    result.forEach((order, i) => { order.displayNumber = i + 1; });
    return result;
}

// ==========================================
// 4. [메인 배차 알고리즘] 외곽 최원거리 우선 하버사인 클러스터링
// ==========================================

/**
 * 1) 거점에서 가장 먼 배송지를 확인
 * 2) 해당 배송지 기준 하버사인 최근접 주문들을 모아 가장 가까운 가용 기사의 쿼터만큼 배정
 * 3) 거점 주변 잔여 물량까지 자연스럽게 내부 기사에게 순차 할당
 */
export function executeAutoDispatch({ targetOrders, activeDrivers, weights = {}, companyBase = null, activeRoutes = {} }) {
    if (!targetOrders || targetOrders.length === 0) {
        return { success: false, message: "할당할 배송 데이터가 없습니다." };
    }
    if (!activeDrivers || activeDrivers.length === 0) {
        return { success: false, message: "배정 대상 운행 기사가 없습니다." };
    }

    const totalOrders = targetOrders.length;

    // 1. 본사 거점 좌표 동적 바인딩 (주소 하드코딩 금지, 사용자 등록 거점 우선 반영)
    let baseLat = companyBase && companyBase.lat ? parseFloat(companyBase.lat) : null;
    let baseLng = companyBase && companyBase.lng ? parseFloat(companyBase.lng) : null;

    // 등록된 거점이 없을 경우 전체 유효 배송지의 중심점을 동적 거점으로 활용
    if (!baseLat || !baseLng) {
        const validCoords = targetOrders.filter(o => o.lat && o.lng && !isNaN(o.lat) && !isNaN(o.lng));
        if (validCoords.length > 0) {
            baseLat = validCoords.reduce((sum, o) => sum + parseFloat(o.lat), 0) / validCoords.length;
            baseLng = validCoords.reduce((sum, o) => sum + parseFloat(o.lng), 0) / validCoords.length;
        }
    }

    // 2. 가중치가 반영된 기사별 목표 쿼터 산출
    const driverStats = calculateDriverCapacities(activeDrivers, totalOrders, weights, companyBase);

    // 각 주문의 거점 대비 거리 계산 및 이전 번호 초기화
    targetOrders.forEach(o => {
        delete o.displayNumber; // 이전 배정 순번 잔상 소거
        if (o.lat && o.lng && baseLat && baseLng) {
            o._distFromBase = getBaseDist(baseLat, baseLng, parseFloat(o.lat), parseFloat(o.lng));
        } else {
            o._distFromBase = -1;
        }
    });

    // 미배정 주문 풀
    let unassigned = [...targetOrders];

    // 3. 외곽 우선 하버사인 클러스터링 반복 루프
    while (unassigned.length > 0) {
        const availableDrivers = driverStats.filter(ds => ds.assignedCount < ds.targetCap);

        // 모든 기사의 정원이 찼으나 남은 주문이 있는 경우 (좌표 누락 등), 가장 적합한 기사에게 수용
        if (availableDrivers.length === 0) {
            unassigned.forEach(order => {
                let bestDriver = driverStats[0];
                let minDist = Infinity;
                driverStats.forEach(ds => {
                    const d = (order.lat && order.lng && ds.tLat && ds.tLng)
                        ? getBaseDist(parseFloat(order.lat), parseFloat(order.lng), ds.tLat, ds.tLng)
                        : ds.assignedCount;
                    if (d < minDist) { minDist = d; bestDriver = ds; }
                });
                bestDriver.assignedCount++;
                bestDriver.assignedOrders.push(order);
                order.assignedDriver = bestDriver.key;
            });
            break;
        }

        // 🌟 [원칙 1] 거점에서 가장 먼 배송지 탐색 (외곽 배송지 우선)
        let farthestOrder = unassigned[0];
        let maxDist = -Infinity;

        unassigned.forEach(o => {
            if (o._distFromBase > maxDist) {
                maxDist = o._distFromBase;
                farthestOrder = o;
            }
        });

        // 🌟 [원칙 2] 이 외곽 배송지와 가장 가까운 가용 기사 매칭 (반고정식 권역 반영)
        let bestDriver = availableDrivers[0];
        let minDriverDist = Infinity;

        availableDrivers.forEach(ds => {
            const d = (farthestOrder.lat && farthestOrder.lng && ds.tLat && ds.tLng)
                ? getBaseDist(parseFloat(farthestOrder.lat), parseFloat(farthestOrder.lng), ds.tLat, ds.tLng)
                : 999999;
            if (d < minDriverDist) {
                minDriverDist = d;
                bestDriver = ds;
            }
        });

        // 해당 기사가 더 채워야 할 수량 (가중치 적용된 남은 쿼터)
        const neededCount = Math.max(1, bestDriver.targetCap - bestDriver.assignedCount);

        // 🌟 [원칙 2-2] 외곽 배송지를 중심으로 하버사인 최근접 배송지들을 필요한 수량만큼 묶음
        unassigned.sort((a, b) => {
            const distA = (farthestOrder.lat && farthestOrder.lng && a.lat && a.lng)
                ? getBaseDist(parseFloat(farthestOrder.lat), parseFloat(farthestOrder.lng), parseFloat(a.lat), parseFloat(a.lng))
                : 999999;
            const distB = (farthestOrder.lat && farthestOrder.lng && b.lat && b.lng)
                ? getBaseDist(parseFloat(farthestOrder.lat), parseFloat(farthestOrder.lng), parseFloat(b.lat), parseFloat(b.lng))
                : 999999;
            return distA - distB;
        });

        const takeCount = Math.min(neededCount, unassigned.length);
        const batch = unassigned.splice(0, takeCount);

        // 묶인 배송지들을 해당 기사에게 확정 배정
        batch.forEach(o => {
            o.assignedDriver = bestDriver.key;
            bestDriver.assignedOrders.push(o);
            bestDriver.assignedCount++;
        });
    }

    // 4. 출발 기준은 유지하고, 기사 종료 설정이 없을 때만 회사 복귀를 적용합니다.
    driverStats.forEach(ds => {
        if (ds.assignedOrders.length > 0) {
            const driver = activeDrivers.find(d => (d.deviceId || d.key) === ds.devId);
            ds.endLocation = resolveDriverEndLocation(driver, activeRoutes, { lat: baseLat, lng: baseLng, address: companyBase?.address || '' });
            ds.assignedOrders = optimizeRoute2Opt(ds.assignedOrders, { lat: baseLat, lng: baseLng }, ds.endLocation);
        }
    });

    // 🌟 연산용 임시 속성(_distFromBase) 완전 삭제 (메모리 및 DB 저장 데이터 클린업)
    targetOrders.forEach(o => {
        delete o._distFromBase;
    });

    return {
        success: true,
        totalOrders,
        driverStats,
        allocatedCount: targetOrders.length
    };
}

/**
 * 기존 배정에서 배송지를 이동·교환해 기사별 직선거리 부담을 조정합니다.
 * 검증한 조건: 최장 거리 + 0.05 × 표준편차, 총거리 증가 10% 이내,
 * 평균 건수 -5~+5건, 상위 후보 3개 정밀 평가, 최대 30회 개선.
 * 가중치가 있으면 목표 건수를 정확히 유지하고 교환만 허용합니다.
 */
export function executeDistanceBalancedDispatch(options) {
    const validPoint = point => point && point.lat != null && point.lng != null &&
        point.lat !== '' && point.lng !== '' && Number.isFinite(Number(point.lat)) &&
        Number.isFinite(Number(point.lng)) && Math.abs(Number(point.lat)) <= 90 &&
        Math.abs(Number(point.lng)) <= 180 && (Number(point.lat) !== 0 || Number(point.lng) !== 0);
    const orders = options.targetOrders || [];
    if (!validPoint(options.companyBase) || orders.some(order => !validPoint(order))) {
        return { success: false, message: '이동 거리 기준으로 배정하려면 회사 거점과 선택한 모든 배송지의 좌표가 필요합니다. 주소와 좌표를 확인해 주세요.' };
    }
    const result = executeAutoDispatch(options);
    if (!result.success) return result;

    // 계산 순서는 입력 기사 순서로 고정합니다. 기존 건수 배정의 정렬은 바꾸지 않습니다.
    const stats = options.activeDrivers.map(driver => result.driverStats.find(ds => ds.devId === (driver.deviceId || driver.key)));
    const index = new Map(orders.map((order, i) => [order, i]));
    const base = { lat: Number(options.companyBase.lat), lng: Number(options.companyBase.lng) };
    const ends = stats.map((ds, d) => ds.endLocation || resolveDriverEndLocation(options.activeDrivers[d], options.activeRoutes, options.companyBase));
    const n = orders.length, k = stats.length, baseIndex = n, endIndex = d => n + 1 + d;
    const points = [...orders, base, ...ends];
    const matrix = points.map(a => Float64Array.from(points, b => getBaseDist(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng))));
    const length = (route, d) => {
        if (!route.length) return 0;
        let sum = matrix[baseIndex][route[0]] + matrix[route.at(-1)][endIndex(d)];
        for (let i = 1; i < route.length; i++) sum += matrix[route[i - 1]][route[i]];
        return sum;
    };
    const cache = new Map();
    const optimize = (route, d) => {
        const key = d + ':' + route.join(',');
        if (!cache.has(key)) {
            const lightweight = route.map(i => ({ index: i, lat: Number(orders[i].lat), lng: Number(orders[i].lng) }));
            cache.set(key, optimizeRoute2Opt(lightweight, base, ends[d]).map(order => order.index));
        }
        return cache.get(key).slice();
    };
    const total = values => values.reduce((sum, value) => sum + value, 0);
    const objective = values => {
        const mean = total(values) / k;
        const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / k);
        return Math.max(...values) + 0.05 * deviation;
    };
    let routes = stats.map(ds => ds.assignedOrders.map(order => index.get(order)));
    let costs = routes.map(length);
    const baselineTotal = total(costs), baselineMax = Math.max(...costs);
    const ceiling = baselineTotal * 1.1;
    const weighted = stats.some(ds => Number(options.weights?.[ds.devId] || 0) !== 0);
    const limits = stats.map((ds, d) => weighted || ds.targetCap === 0
        ? [routes[d].length, routes[d].length]
        : [Math.max(1, Math.floor(n / k) - 5), Math.ceil(n / k) + 5]);
    const near = orders.map((_, i) => Array.from({ length: n }, (__, j) => j).filter(j => j !== i)
        .sort((a, b) => matrix[i][a] - matrix[i][b] || a - b).slice(0, 16));
    const insert = (route, item, d) => {
        if (!route.length) return { route: [item], delta: matrix[baseIndex][item] + matrix[item][endIndex(d)] };
        let delta = Infinity, position = 0;
        for (let i = 0; i <= route.length; i++) {
            const a = i ? route[i - 1] : baseIndex, b = i < route.length ? route[i] : endIndex(d);
            const next = matrix[a][item] + matrix[item][b] - matrix[a][b];
            if (next < delta) { delta = next; position = i; }
        }
        const added = route.slice();
        added.splice(position, 0, item);
        return { route: added, delta };
    };

    let iterations = 0;
    for (; iterations < 30; iterations++) {
        const owner = Array(n), removed = new Map(), candidates = [], current = objective(costs);
        routes.forEach((route, d) => route.forEach(item => {
            owner[item] = d;
            const shortened = route.filter(i => i !== item);
            removed.set(item, { route: shortened, cost: length(shortened, d) });
        }));
        const consider = (a, b, ra, rb, ca, cb) => {
            const predicted = costs.slice();
            predicted[a] = ca; predicted[b] = cb;
            const score = objective(predicted);
            if (score < current - 1e-8 && total(predicted) <= ceiling + 1e-8) candidates.push({ a, b, ra, rb, score });
        };
        if (!weighted) for (let a = 0; a < k; a++) if (routes[a].length > limits[a][0]) {
            for (const item of routes[a]) for (let b = 0; b < k; b++) if (a !== b && routes[b].length < limits[b][1]) {
                const rm = removed.get(item), add = insert(routes[b], item, b);
                consider(a, b, rm.route, add.route, rm.cost, costs[b] + add.delta);
            }
        }
        const seen = new Set();
        for (let item = 0; item < n; item++) for (const other of near[item]) {
            const a = owner[item], b = owner[other], key = [Math.min(item, other), Math.max(item, other)].join(':');
            if (a === b || seen.has(key)) continue;
            seen.add(key);
            const rmA = removed.get(item), rmB = removed.get(other);
            const addA = insert(rmA.route, other, a), addB = insert(rmB.route, item, b);
            consider(a, b, addA.route, addB.route, rmA.cost + addA.delta, rmB.cost + addB.delta);
        }
        candidates.sort((a, b) => a.score - b.score);
        let best = null;
        for (const candidate of candidates.slice(0, 3)) {
            const ra = optimize(candidate.ra, candidate.a), rb = optimize(candidate.rb, candidate.b), next = costs.slice();
            next[candidate.a] = length(ra, candidate.a); next[candidate.b] = length(rb, candidate.b);
            const score = objective(next);
            if (total(next) > ceiling + 1e-8 || score >= current - 1e-8) continue;
            if (!best || score < best.score) best = { ...candidate, ra, rb, costs: next, score };
        }
        if (!best) break;
        routes[best.a] = best.ra; routes[best.b] = best.rb; costs = best.costs;
    }

    const assigned = routes.flat();
    if (assigned.length !== n || new Set(assigned).size !== n || assigned.some(i => !Number.isInteger(i) || i < 0 || i >= n) ||
        routes.some((route, d) => route.length < limits[d][0] || route.length > limits[d][1])) {
        throw new Error('거리 배정 결과 검증에 실패했습니다.');
    }
    routes.forEach((route, d) => {
        stats[d].assignedOrders = route.map((i, position) => {
            orders[i].assignedDriver = stats[d].key;
            orders[i].displayNumber = position + 1;
            return orders[i];
        });
        stats[d].assignedCount = route.length;
    });
    result.distanceBalance = { iterations, weightedCountsPreserved: weighted, baselineTotalKm: baselineTotal,
        totalKm: total(costs), baselineMaxKm: baselineMax, maxKm: Math.max(...costs) };
    return result;
}

// 동일한 엔진을 전용 작업 스레드에서도 실행하여 계산 중 관제 화면을 멈추지 않습니다.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
    self.onmessage = event => {
        if (event.data?.type !== 'distance-dispatch') return;
        try {
            const options = event.data.options;
            const indices = new Map(options.targetOrders.map((order, i) => [order, i]));
            const result = executeDistanceBalancedDispatch(options);
            self.postMessage({ result: { ...result, driverStats: result.driverStats?.map(ds => ({ ...ds,
                assignedOrders: ds.assignedOrders.map(order => indices.get(order)) })) } });
        } catch (error) {
            self.postMessage({ error: error.message || '거리 배정 계산 중 오류가 발생했습니다.' });
        }
    };
}
