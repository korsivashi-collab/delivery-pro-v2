// js/optimizer.js

// 1. 두 지점 간의 직선 거리 계산 (하버사인 공식 - 단위: km)
export function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + 
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// 2. 차량 진행 방향(우회전/좌회전) 판별 및 가중치 계산 (벡터 외적 활용)
function getTurnPenalty(p1, p2, p3) {
    if (!p1 || !p2 || !p3) return 0;
    
    const latAvg = p2.lat * Math.PI / 180;
    const cosLat = Math.cos(latAvg);
    
    const v1_x = (p2.lng - p1.lng) * cosLat;
    const v1_y = (p2.lat - p1.lat);
    
    const v2_x = (p3.lng - p2.lng) * cosLat;
    const v2_y = (p3.lat - p2.lat);
    
    const crossProduct = (v1_x * v2_y) - (v1_y * v2_x);
    
    // crossProduct > 0 은 반시계 방향(좌회전/중앙선 횡단) ➔ 페널티 200m(0.2km) 부여
    return crossProduct > 0 ? 0.2 : 0; 
}

// 3. 경로의 전체 비용 (거리 + 회전 페널티) 계산
function getPathCost(path) {
    let cost = 0;
    for (let i = 0; i < path.length - 1; i++) {
        cost += getDistance(path[i].lat, path[i].lng, path[i+1].lat, path[i+1].lng);
        if (i > 0) {
            cost += getTurnPenalty(path[i-1], path[i], path[i+1]);
        }
    }
    return cost;
}

// 4. 거시적 뼈대를 지키며 인접 범위 내에서만 미세 조정하는 스무딩 엔진
function applyLocalSmoothing(routePoints, startPoint, endPoint) {
    let fullPath = [startPoint, ...routePoints];
    let hasEnd = (endPoint && endPoint.lat && endPoint.lat !== 0);
    if (hasEnd) fullPath.push(endPoint);
    
    let improved = true;
    let iter = 0;
    let maxIter = 500;
    
    // 뼈대를 완전히 뒤바꾸지 않고, 인접한 5개 이내의 노드들 간에 꼬인 순서만 국소적으로 바로잡음
    const WINDOW_SIZE = 5; 
    let endIndex = hasEnd ? fullPath.length - 2 : fullPath.length - 1;
    
    while(improved && iter < maxIter) {
        improved = false;
        iter++;
        let currentCost = getPathCost(fullPath);
        
        for(let i = 1; i <= endIndex; i++) {
            let limitJ = Math.min(i + WINDOW_SIZE, endIndex);
            for(let j = i + 1; j <= limitJ; j++) {
                let newPath = [
                    ...fullPath.slice(0, i),
                    ...fullPath.slice(i, j + 1).reverse(),
                    ...fullPath.slice(j + 1)
                ];
                
                let newCost = getPathCost(newPath);
                
                if (newCost < currentCost - 0.0001) {
                    fullPath = newPath;
                    currentCost = newCost;
                    improved = true;
                }
            }
        }
    }
    
    // 시작점과 종료점 제외하고 내부 순서만 추출
    if (hasEnd) {
        return fullPath.slice(1, fullPath.length - 1);
    } else {
        return fullPath.slice(1);
    }
}

// 5. 동선 최적화 메인 알고리즘 (Macro Backbone 우선 생성 + Local Smoothing)
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
    
    // ==========================================
    // [STEP 1] 전체 거시적 뼈대(Macro Backbone) 생성
    // ==========================================
    let allPoints = [startPoint, ...unassigned];
    if (hasEnd) allPoints.push(endLocation);

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

    // 진척도(Progress)를 기준으로 거시적 정렬 수행 (가상의 선 기준 뼈대 완성)[cite: 3]
    let macroRoute = []; 
    let curr = startPoint;
    
    while(unassigned.length > 0) {
        let bestIdx = -1; 
        let bestScore = Infinity;
        for(let i = 0; i < unassigned.length; i++) {
            let n = unassigned[i];
            let dist = getDistance(curr.lat, curr.lng, n.lat, n.lng);
            let progressDiff = (curr.progress !== undefined && n.progress !== undefined) ? (curr.progress - n.progress) : 0;
            let backwardPenalty = progressDiff > 0 ? (progressDiff * 15) : 0; 
            let score = dist + backwardPenalty;
            if(score < bestScore) { 
                bestScore = score; 
                bestIdx = i; 
            }
        }
        macroRoute.push(unassigned[bestIdx]);
        curr = unassigned[bestIdx];
        unassigned.splice(bestIdx, 1);
    }

    // ==========================================
    // [STEP 2] 뼈대를 훼손하지 않는 범위 내에서 국소 미세 정렬 (Smoothing)
    // ==========================================
    let smoothedRoute = applyLocalSmoothing(macroRoute, startPoint, hasEnd ? endLocation : null);

    // ==========================================
    // [STEP 3] 최종 반환
    // ==========================================
    let fullResult = [startPoint, ...smoothedRoute];
    if (hasEnd) fullResult.push(endLocation);

    return fullResult;
}