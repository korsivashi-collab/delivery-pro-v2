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
        if (exactCap < 1) exactCap = 1;

        // 기사의 반고정 권역 중심 좌표 (미설정 시 거점 좌표 참조)
        const centerLat = d.territoryLat || (companyBase ? companyBase.lat : null);
        const centerLng = d.territoryLng || (companyBase ? companyBase.lng : null);
        const centerAddr = d.territory1 || (companyBase ? companyBase.address : '') || '';

        return {
            devId,
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

/**
 * 기사에게 배정된 배송지들을 거점에서 출발하여 순차적으로 이어지도록 정렬하고 번호 부여
 */
export function optimizeRoute2Opt(orderList, basePos = null) {
    if (!orderList || orderList.length === 0) return orderList;

    // 유효한 좌표가 있는 주문과 없는 주문 분리
    const validOrders = orderList.filter(o => o.lat && o.lng && !isNaN(o.lat) && !isNaN(o.lng));
    const noCoordOrders = orderList.filter(o => !o.lat || !o.lng || isNaN(o.lat) || isNaN(o.lng));

    if (validOrders.length <= 1) {
        orderList.forEach((ord, idx) => { ord.displayNumber = idx + 1; });
        return orderList;
    }

    // 1단계: 거점(또는 첫 배송지)에서 가장 가까운 주문을 1번으로 시작
    const unvisited = [...validOrders];
    let firstOrder = null;

    if (basePos && basePos.lat && basePos.lng) {
        let minDist = Infinity;
        let minIdx = 0;
        unvisited.forEach((ord, i) => {
            const d = getBaseDist(basePos.lat, basePos.lng, ord.lat, ord.lng);
            if (d < minDist) { minDist = d; minIdx = i; }
        });
        firstOrder = unvisited.splice(minIdx, 1)[0];
    } else {
        firstOrder = unvisited.shift();
    }

    // 최근접 이웃(Nearest Neighbor) 기본 연결
    const route = [firstOrder];
    while (unvisited.length > 0) {
        const curr = route[route.length - 1];
        let bestIdx = 0;
        let minDist = Infinity;

        for (let i = 0; i < unvisited.length; i++) {
            const d = getBaseDist(curr.lat, curr.lng, unvisited[i].lat, unvisited[i].lng);
            if (d < minDist) {
                minDist = d;
                bestIdx = i;
            }
        }
        route.push(unvisited.splice(bestIdx, 1)[0]);
    }

    // 2단계: 2-opt 교차 선분 풀기 알고리즘
    const n = route.length;
    let improved = true;
    let iterations = 0;
    const maxIterations = 50;

    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;

        for (let i = 0; i < n - 1; i++) {
            for (let j = i + 2; j < n; j++) {
                const pA = route[i];
                const pB = route[i + 1];
                const pC = route[j];
                const pD = (j + 1 < n) ? route[j + 1] : null;

                const currentDist = getBaseDist(pA.lat, pA.lng, pB.lat, pB.lng) +
                                    (pD ? getBaseDist(pC.lat, pC.lng, pD.lat, pD.lng) : 0);

                const newDist = getBaseDist(pA.lat, pA.lng, pC.lat, pC.lng) +
                                (pD ? getBaseDist(pB.lat, pB.lng, pD.lat, pD.lng) : 0);

                if (newDist < currentDist - 0.001) {
                    const reversedSegment = route.slice(i + 1, j + 1).reverse();
                    route.splice(i + 1, reversedSegment.length, ...reversedSegment);
                    improved = true;
                }
            }
        }
    }

    // 좌표가 없는 주문은 맨 뒤로 배치
    const finalRoute = [...route, ...noCoordOrders];
    finalRoute.forEach((ord, idx) => {
        ord.displayNumber = idx + 1;
    });

    return finalRoute;
}

// ==========================================
// 4. [메인 배차 알고리즘] 외곽 최원거리 우선 하버사인 클러스터링
// ==========================================

/**
 * 1) 거점에서 가장 먼 배송지를 확인
 * 2) 해당 배송지 기준 하버사인 최근접 주문들을 모아 가장 가까운 가용 기사의 쿼터만큼 배정
 * 3) 거점 주변 잔여 물량까지 자연스럽게 내부 기사에게 순차 할당
 */
export function executeAutoDispatch({ targetOrders, activeDrivers, weights = {}, companyBase = null }) {
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

    // 각 주문의 거점 대비 거리 사전 계산 (좌표 없는 건은 최후순위인 -1 처리)
    targetOrders.forEach(o => {
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
                order.assignedDriver = bestDriver.phone;
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
            o.assignedDriver = bestDriver.phone;
            bestDriver.assignedOrders.push(o);
            bestDriver.assignedCount++;
        });
    }

    // 4. 각 기사별 배정 결과에 대해 2-opt 순서 최적화 실행 (현장 퇴근을 위한 동선 정렬)
    driverStats.forEach(ds => {
        if (ds.assignedOrders.length > 0) {
            optimizeRoute2Opt(ds.assignedOrders, { lat: baseLat, lng: baseLng });
        }
    });

    return {
        success: true,
        totalOrders,
        driverStats,
        allocatedCount: targetOrders.length
    };
}