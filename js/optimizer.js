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

// 2. [신규] 차량 진행 방향(우회전) 판별 및 가중치 계산 (벡터 외적 활용)
// P1 -> P2 -> P3 로 이동할 때 꺾이는 각도를 계산합니다.
function getTurnPenalty(p1, p2, p3) {
    if (!p1 || !p2 || !p3) return 0;
    
    // 경도(Longitude)에 따른 거리 왜곡을 보정하기 위해 위도(Latitude) 코사인 값 적용
    const latAvg = p2.lat * Math.PI / 180;
    const cosLat = Math.cos(latAvg);
    
    const v1_x = (p2.lng - p1.lng) * cosLat;
    const v1_y = (p2.lat - p1.lat);
    
    const v2_x = (p3.lng - p2.lng) * cosLat;
    const v2_y = (p3.lat - p2.lat);
    
    // 벡터 외적 (Cross Product)
    const crossProduct = (v1_x * v2_y) - (v1_y * v2_x);
    
    // crossProduct > 0 이면 반시계 방향(좌회전/중앙선 횡단)을 의미함
    // 좌회전일 경우 가상의 거리 페널티 300m(0.3km)를 부여하여 우회전을 유도함
    return crossProduct > 0 ? 0.3 : 0; 
}

// 3. [신규] 특정 경로의 전체 비용(거리 + 회전 페널티)을 계산하는 함수
function getPathCost(path) {
    let cost = 0;
    for (let i = 0; i < path.length - 1; i++) {
        cost += getDistance(path[i].lat, path[i].lng, path[i+1].lat, path[i+1].lng);
        // 이전 노드가 존재하면(즉, 3개의 점이 형성되면) 회전 페널티 계산
        if (i > 0) {
            cost += getTurnPenalty(path[i-1], path[i], path[i+1]);
        }
    }
    return cost;
}

// 4. [신규] 소규모 구역(Zone) 정밀 최적화 엔진 (Nearest Neighbor + 2-opt)
function optimizeSubRoute(nodesToOpt, startNode, endNode) {
    if (!nodesToOpt || nodesToOpt.length === 0) return [];
    if (nodesToOpt.length === 1) return nodesToOpt;
    
    // [1단계] 구역 내부 그리디(Nearest Neighbor) 초기 배정
    let unassigned = [...nodesToOpt];
    let route = [];
    let curr = startNode;
    
    while(unassigned.length > 0) {
        let bestIdx = -1;
        let bestScore = Infinity;
        for(let i = 0; i < unassigned.length; i++) {
            let n = unassigned[i];
            let dist = getDistance(curr.lat, curr.lng, n.lat, n.lng);
            if (route.length > 0) {
                dist += getTurnPenalty(route[route.length-1], curr, n);
            }
            if (dist < bestScore) {
                bestScore = dist;
                bestIdx = i;
            }
        }
        route.push(unassigned[bestIdx]);
        curr = unassigned[bestIdx];
        unassigned.splice(bestIdx, 1);
    }
    
    // [2단계] 정밀 2-opt 알고리즘 (우회전 페널티를 고려한 스왑 검사)
    let fullPath = [startNode, ...route];
    if (endNode) fullPath.push(endNode);
    
    let improved = true;
    let iter = 0;
    let maxIter = 1500;
    // 시작점(0)과 종료점(endIndex 초과)은 스왑하지 않음
    let endIndex = endNode ? fullPath.length - 2 : fullPath.length - 1;
    
    while(improved && iter < maxIter) {
        improved = false;
        iter++;
        let currentTotalCost = getPathCost(fullPath);
        
        for(let i = 1; i <= endIndex; i++) {
            for(let j = i + 1; j <= endIndex; j++) {
                // 배열의 i부터 j까지의 순서를 뒤집어 새로운 경로 생성
                let newPath = [
                    ...fullPath.slice(0, i),
                    ...fullPath.slice(i, j + 1).reverse(),
                    ...fullPath.slice(j + 1)
                ];
                
                let newTotalCost = getPathCost(newPath);
                
                // 부동소수점 오차 방지를 위해 0.0001km(10cm) 이상의 이득이 있을 때만 교환
                if (newTotalCost < currentTotalCost - 0.0001) {
                    fullPath = newPath;
                    currentTotalCost = newTotalCost;
                    improved = true;
                }
            }
        }
    }
    
    // 시작점과 종료점을 떼어내고 내부 노드들만 반환
    if (endNode) {
        return fullPath.slice(1, fullPath.length - 1);
    } else {
        return fullPath.slice(1);
    }
}

// 5. 동선 최적화 메인 알고리즘 (Macro Routing ➔ Zone Splitting ➔ Merge)
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
    // [STEP 1] 전체 거시적 흐름(Macro Routing) 뼈대 잡기
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

    let macroRoute = []; 
    let curr = startPoint;
    
    while(unassigned.length > 0) {
        let bestIdx = -1; 
        let bestScore = Infinity;
        for(let i = 0; i < unassigned.length; i++) {
            let n = unassigned[i];
            let dist = getDistance(curr.lat, curr.lng, n.lat, n.lng);
            let progressDiff = (curr.progress !== undefined && n.progress !== undefined) ? (curr.progress - n.progress) : 0;
            // 진행률(축)을 거스르는 역행에 강한 페널티 부여
            let backwardPenalty = progressDiff > 0 ? (progressDiff * 10) : 0; 
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

    // 배송지가 너무 적을 경우 굳이 3구역으로 쪼개지 않고 전체를 한 번에 정밀 최적화
    let total = macroRoute.length;
    if (total < 6) { 
        return [startPoint, ...optimizeSubRoute(macroRoute, startPoint, hasEnd ? endLocation : null)];
    }

    // ==========================================
    // [STEP 2 & 3] 3구역 클러스터 분할 및 꼬리물기 정밀 최적화
    // ==========================================
    let z1_endIdx = Math.floor(total / 3);
    let z2_endIdx = Math.floor((total * 2) / 3);
    
    let Z1 = macroRoute.slice(0, z1_endIdx);
    let Z2 = macroRoute.slice(z1_endIdx, z2_endIdx);
    let Z3 = macroRoute.slice(z2_endIdx);
    
    // Zone 1: 시작점(startPoint) ~ Zone 2의 첫 지점(Z2[0])을 향해 최적화
    let opt_Z1 = optimizeSubRoute(Z1, startPoint, Z2[0]);
    let z1_last = opt_Z1[opt_Z1.length - 1]; // Z1의 마지막 지점이 Z2의 시작점이 됨
    
    // Zone 2: Zone 1의 끝(z1_last) ~ Zone 3의 첫 지점(Z3[0])을 향해 최적화
    let opt_Z2 = optimizeSubRoute(Z2, z1_last, Z3[0]);
    let z2_last = opt_Z2[opt_Z2.length - 1]; // Z2의 마지막 지점이 Z3의 시작점이 됨
    
    // Zone 3: Zone 2의 끝(z2_last) ~ 최종 도착지(endLocation)를 향해 최적화
    let opt_Z3 = optimizeSubRoute(Z3, z2_last, hasEnd ? endLocation : null);
    
    // ==========================================
    // [STEP 4] 최종 병합 반환
    // ==========================================
    return [startPoint, ...opt_Z1, ...opt_Z2, ...opt_Z3];
}