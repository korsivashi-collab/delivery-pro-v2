// js/optimizer.js

// 1. 하버사인 거리 계산 (단위: km)
export function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + 
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// 2. 우회전(좌회전) 판별 및 가중치 (벡터 외적)
function getTurnPenalty(p1, p2, p3) {
    if (!p1 || !p2 || !p3) return 0;
    const latAvg = p2.lat * Math.PI / 180;
    const cosLat = Math.cos(latAvg);
    const v1_x = (p2.lng - p1.lng) * cosLat;
    const v1_y = (p2.lat - p1.lat);
    const v2_x = (p3.lng - p2.lng) * cosLat;
    const v2_y = (p3.lat - p2.lat);
    const crossProduct = (v1_x * v2_y) - (v1_y * v2_x);
    
    // 좌회전 시 0.2km(200m)의 가상 페널티 부여
    return crossProduct > 0 ? 0.2 : 0; 
}

// 3. 통합 비용 계산 (거리 + 우회전 페널티 + 가상의 선 역행 페널티)
// 이 함수가 "큰 그림을 깨뜨리지 못하게" 막아주는 핵심 방패 역할을 합니다.
function getPathCost(path) {
    let cost = 0;
    for (let i = 0; i < path.length - 1; i++) {
        let p1 = path[i];
        let p2 = path[i+1];
        
        cost += getDistance(p1.lat, p1.lng, p2.lat, p2.lng);
        
        if (i > 0) {
            cost += getTurnPenalty(path[i-1], p1, p2);
        }
        
        // 가상의 선(progress)을 거슬러 뒤로 가는 경우 강력한 페널티(15배) 부여
        if (p1.progress !== undefined && p2.progress !== undefined) {
            if (p1.progress > p2.progress) {
                cost += (p1.progress - p2.progress) * 15;
            }
        }
    }
    return cost;
}

// 4. 구역별 정밀 최적화 (초기 뼈대 유지 2-opt)
function optimizeSubRoute(zoneNodes, startNode, endNode) {
    if (!zoneNodes || zoneNodes.length === 0) return [];
    
    // 기존처럼 뒤섞지 않고, 1차 정렬된 뼈대 순서를 그대로 초기값으로 사용!
    let fullPath = [startNode, ...zoneNodes];
    if (endNode) fullPath.push(endNode);
    
    let improved = true;
    let iter = 0;
    let maxIter = 1000;
    let endIndex = endNode ? fullPath.length - 2 : fullPath.length - 1;
    
    while(improved && iter < maxIter) {
        improved = false;
        iter++;
        let currentCost = getPathCost(fullPath);
        
        for(let i = 1; i <= endIndex; i++) {
            for(let j = i + 1; j <= endIndex; j++) {
                let newPath = [
                    ...fullPath.slice(0, i),
                    ...fullPath.slice(i, j + 1).reverse(),
                    ...fullPath.slice(j + 1)
                ];
                
                let newCost = getPathCost(newPath);
                
                // 가상의 선 페널티까지 모두 뚫고 이득이 있을 때만 자리 교체 승인
                if (newCost < currentCost - 0.0001) {
                    fullPath = newPath;
                    currentCost = newCost;
                    improved = true;
                }
            }
        }
    }
    
    if (endNode) return fullPath.slice(1, fullPath.length - 1);
    else return fullPath.slice(1);
}

// 5. 메인 최적화 알고리즘
export function calculateOptimizedRoute(destinations, startLocation, endLocation) {
    if (destinations.length < 2) throw new Error("출발지를 포함하여 최소 2곳의 배송지가 필요합니다.");
    if (!startLocation || !startLocation.lat) throw new Error("시작 지점이 먼저 선택되어야 합니다.");

    let hasEnd = (endLocation && endLocation.lat && endLocation.lat !== 0);
    let startPoint = destinations[0];
    let unassigned = destinations.slice(1).sort((a, b) => a.id - b.id);
    let allPoints = [startPoint, ...unassigned];
    if (hasEnd) allPoints.push(endLocation);

    // ==========================================
    // [STEP 1] 가상의 선(Progress) 계산 및 거시적 뼈대 잡기 (원본 로직 유지)
    // ==========================================
    let axisStart = startPoint;
    let axisEnd = endLocation;

    if (!hasEnd) {
        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
        allPoints.forEach(p => {
            if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
            if (p.lng < minLng) minLng = p.lng; if (p.lng > maxLng) maxLng = p.lng;
        });
        axisEnd = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
    }

    let axisLat = axisEnd.lat - axisStart.lat;
    let axisLng = axisEnd.lng - axisStart.lng;
    let axisLenSq = (axisLat * axisLat) + (axisLng * axisLng);

    unassigned.forEach(n => {
        let vLat = n.lat - axisStart.lat;
        let vLng = n.lng - axisStart.lng;
        // 각 배송지마다 가상의 선 진척도를 영구 저장 (향후 페널티 계산에 사용)
        n.progress = axisLenSq > 0.000001 ? (vLat * axisLat + vLng * axisLng) / axisLenSq : 0;
    });

    let macroRoute = []; 
    let curr = startPoint;
    while(unassigned.length > 0) {
        let bestIdx = -1; let bestScore = Infinity;
        for(let i = 0; i < unassigned.length; i++) {
            let n = unassigned[i];
            let dist = getDistance(curr.lat, curr.lng, n.lat, n.lng);
            let progressDiff = (curr.progress !== undefined && n.progress !== undefined) ? (curr.progress - n.progress) : 0;
            let backwardPenalty = progressDiff > 0 ? (progressDiff * 10) : 0; 
            let score = dist + backwardPenalty;
            if(score < bestScore) { bestScore = score; bestIdx = i; }
        }
        macroRoute.push(unassigned[bestIdx]);
        curr = unassigned[bestIdx];
        unassigned.splice(bestIdx, 1);
    }

    // ==========================================
    // [STEP 2] 3구역 분할
    // ==========================================
    let total = macroRoute.length;
    if (total < 6) {
        return [startPoint, ...optimizeSubRoute(macroRoute, startPoint, hasEnd ? endLocation : null)];
    }

    let z1_end = Math.floor(total / 3);
    let z2_end = Math.floor((total * 2) / 3);
    
    let Z1 = macroRoute.slice(0, z1_end);
    let Z2 = macroRoute.slice(z1_end, z2_end);
    let Z3 = macroRoute.slice(z2_end);
    
    // ==========================================
    // [STEP 3] 꼬리물기 정밀 최적화 (뼈대 사수 + 우회전)
    // ==========================================
    let opt_Z1 = optimizeSubRoute(Z1, startPoint, Z2[0]);
    let opt_Z2 = optimizeSubRoute(Z2, opt_Z1[opt_Z1.length - 1], Z3[0]);
    let opt_Z3 = optimizeSubRoute(Z3, opt_Z2[opt_Z2.length - 1], hasEnd ? endLocation : null);
    
    let finalRoute = [startPoint, ...opt_Z1, ...opt_Z2, ...opt_Z3];
    if (hasEnd) finalRoute.push(endLocation);

    return finalRoute;
}