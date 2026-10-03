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

// 동선 최적화 메인 알고리즘 (시작점, 종료점 반영)
export function calculateOptimizedRoute(destinations, startLocation, endLocation) {
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

    // 이번 실행의 실제 좌표로 인덱스를 부여합니다. id와 무관하게 같은 좌표는 공유합니다.
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
        // 비정상 입력의 기존 형 변환/계산 동작은 그대로 유지합니다.
        if (indexA === undefined || indexB === undefined) {
            return getDistance(pointA.lat, pointA.lng, pointB.lat, pointB.lng);
        }
        const key = indexA < indexB
            ? indexA * coordinateCount + indexB
            : indexB * coordinateCount + indexA;
        const cachedDistance = distanceCache[key];
        if (cachedDistance !== undefined) return cachedDistance;
        // 최초 계산은 기존 인자 순서를 유지하고 역방향에서도 같은 값을 재사용합니다.
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
            let progressDiff =
                (curr !== startPoint &&
                 curr.progress !== undefined &&
                 n.progress !== undefined)
                    ? (curr.progress - n.progress)
                    : 0;
            let backwardPenalty = progressDiff > 0 ? (progressDiff * 10) : 0; 
            let score = dist + backwardPenalty;
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

    // 2-opt 알고리즘을 통한 경로 정밀 개선
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

    if (hasEnd) return fullRoute.slice(0, fullRoute.length - 1);
    else return fullRoute.slice(0);
}
