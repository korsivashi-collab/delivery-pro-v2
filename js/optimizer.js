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
            let dist = getDistance(curr.lat, curr.lng, n.lat, n.lng);
            let progressDiff = (curr.progress !== undefined && n.progress !== undefined) ? (curr.progress - n.progress) : 0;
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
                let d_curr = getDistance(nodeI_prev.lat, nodeI_prev.lng, nodeI.lat, nodeI.lng);
                if (nodeJ_next) d_curr += getDistance(nodeJ.lat, nodeJ.lng, nodeJ_next.lat, nodeJ_next.lng);
                let d_new = getDistance(nodeI_prev.lat, nodeI_prev.lng, nodeJ.lat, nodeJ.lng);
                if (nodeJ_next) d_new += getDistance(nodeI.lat, nodeI.lng, nodeJ_next.lat, nodeJ_next.lng);
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