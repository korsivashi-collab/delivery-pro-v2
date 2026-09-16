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

// 동선 최적화 메인 알고리즘 (시작점, 종료점 반영 및 2-opt 축 교차 튜닝 적용)
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

    // 🌟 지그재그 방지를 위한 튜닝 가중치 (km 단위. 예: 0.3 = 300m 돌아가는 것과 동일한 페널티)
    const CROSSING_PENALTY_WEIGHT = 0.3; 

    unassigned.forEach(n => {
        let vLat = n.lat - axisStart.lat;
        let vLng = n.lng - axisStart.lng;
        
        // 기존 진행도(Progress) 계산
        n.progress = axisLenSq > 0.000001 ? (vLat * axisLat + vLng * axisLng) / axisLenSq : 0;
        
        // 🌟 튜닝 추가: 기준 축(Axis)을 중심으로 좌/우측 위치 판별
        let crossProduct = (axisLng * vLat) - (axisLat * vLng);
        n.side = crossProduct > 0 ? 1 : -1;
    });

    // 시작점은 축 위에 있으므로 페널티 계산에서 제외하기 위해 0 부여
    startPoint.side = 0; 

    // [1단계] 튜닝된 그리디(Greedy) 탐색 
    let route = []; 
    let curr = startPoint;
    
    while(unassigned.length > 0) {
        let bestIdx = -1; 
        let bestScore = Infinity;
        
        for(let i = 0; i < unassigned.length; i++) {
            let n = unassigned[i];
            let dist = getDistance(curr.lat, curr.lng, n.lat, n.lng);
            
            // 역방향 페널티 (기존 로직 유지)
            let progressDiff = (curr.progress !== undefined && n.progress !== undefined) ? (curr.progress - n.progress) : 0;
            let backwardPenalty = progressDiff > 0 ? (progressDiff * 10) : 0; 
            
            // 🌟 튜닝: 중앙선 교차(지그재그) 시 페널티 합산
            let crossingPenalty = 0;
            if (curr.side !== undefined && n.side !== undefined && curr.side !== 0 && curr.side !== n.side) {
                crossingPenalty = CROSSING_PENALTY_WEIGHT;
            }

            let score = dist + backwardPenalty + crossingPenalty;
            
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

    // [2단계] 🌟 튜닝된 2-opt 알고리즘 (거리 + 교차 페널티 동시 평가)
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
                
                // 1. 현재 연결 상태의 비용(거리 + 페널티) 계산
                let d_curr = getDistance(nodeI_prev.lat, nodeI_prev.lng, nodeI.lat, nodeI.lng);
                let pen_curr = (nodeI_prev.side !== undefined && nodeI.side !== undefined && nodeI_prev.side !== 0 && nodeI_prev.side !== nodeI.side) ? CROSSING_PENALTY_WEIGHT : 0;
                
                if (nodeJ_next) {
                    d_curr += getDistance(nodeJ.lat, nodeJ.lng, nodeJ_next.lat, nodeJ_next.lng);
                    pen_curr += (nodeJ.side !== undefined && nodeJ_next.side !== undefined && nodeJ.side !== 0 && nodeJ.side !== nodeJ_next.side) ? CROSSING_PENALTY_WEIGHT : 0;
                }

                // 2. 꼬임을 풀고 새롭게 연결했을 때의 비용 계산
                let d_new = getDistance(nodeI_prev.lat, nodeI_prev.lng, nodeJ.lat, nodeJ.lng);
                let pen_new = (nodeI_prev.side !== undefined && nodeJ.side !== undefined && nodeI_prev.side !== 0 && nodeI_prev.side !== nodeJ.side) ? CROSSING_PENALTY_WEIGHT : 0;
                
                if (nodeJ_next) {
                    d_new += getDistance(nodeI.lat, nodeI.lng, nodeJ_next.lat, nodeJ_next.lng);
                    pen_new += (nodeI.side !== undefined && nodeJ_next.side !== undefined && nodeI.side !== 0 && nodeI.side !== nodeJ_next.side) ? CROSSING_PENALTY_WEIGHT : 0;
                }
                
                // 3. 🌟 최종 평가: 순수 거리가 단축되더라도, 교차 페널티를 더한 '총비용(cost)'이 개선되어야만 변경을 허용함
                let cost_curr = d_curr + pen_curr;
                let cost_new = d_new + pen_new;

                if (cost_new < cost_curr - 0.0001) {
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