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

// 🌟 밀집 구역 기준 반경 (km) - 도심지 현실 동선을 반영하여 300m로 조정
const CLUSTER_RADIUS_KM = 0.35;
// 🌟 밀집 구역으로 판단하여 LLM을 호출할 최소 배송지 수 (지그재그가 발생할 수 있는 3개 이상부터 발동)
const MIN_CLUSTER_SIZE = 3;

// LLM API를 호출하여 밀집 구간을 최적화하는 비동기 함수
async function optimizeClusterWithLLM(clusterNodes) {
    const controller = new AbortController();
    let timer;
    try {
        // 응답 본문까지 제한 시간에 포함하고 실패 시 기본 경로를 유지한다.
        const data = await Promise.race([
            Promise.resolve().then(async () => {
                const response = await fetch('/api/optimize-llm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ destinations: clusterNodes }),
                    signal: controller.signal
                });
                if (!response.ok) return null;
                return response.json();
            }),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error('LLM_TIMEOUT'));
                    controller.abort();
                }, 20000);
            })
        ]);
        // LLM이 특정 조건에 따라 정리해준 순서가 있다면 경로에 반영
        const ids = new Set(clusterNodes.map(node => String(node.id)));
        if (Array.isArray(data?.optimized) && ids.size === clusterNodes.length &&
            data.optimized.length === clusterNodes.length &&
            new Set(data.optimized).size === clusterNodes.length &&
            data.optimized.every(id => typeof id === 'string' && ids.has(id))) {
            const orderMap = new Map(data.optimized.map((id, index) => [String(id), index]));
            return [...clusterNodes].sort((a, b) => {
                const idxA = orderMap.has(String(a.id)) ? orderMap.get(String(a.id)) : 999;
                const idxB = orderMap.has(String(b.id)) ? orderMap.get(String(b.id)) : 999;
                return idxA - idxB;
            });
        }
        return clusterNodes;
    } catch (error) {
        console.warn('LLM API 호출 실패:', error);
        return clusterNodes; // 에러 발생 시 앱이 멈추지 않도록 원본 경로 안전 유지
    } finally { clearTimeout(timer); }
}

// 동선 최적화 메인 알고리즘 (시작점, 종료점 확정 후 경로 생성 시작)
export async function calculateOptimizedRoute(destinations, startLocation, endLocation) {
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

    // 1단계: 하버사인 + 2-opt 알고리즘을 통한 뼈대 경로 구성
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

    // 🌟 2단계: 특정 조건(반경 300m 이내, 3개 이상 밀집) 감지 시 LLM 개입
    let finalRoute = [startPoint];
    let currentCluster = [];
    
    // 출발지와 종료지를 제외한 실제 배송지 목록 추출
    const macroRoute = fullRoute.slice(1, hasEnd ? -1 : undefined);
    
    for (let i = 0; i < macroRoute.length; i++) {
        const node = macroRoute[i];
        
        // 첫 번째 노드는 클러스터 검사 시작점
        if (currentCluster.length === 0) {
            currentCluster.push(node);
            continue;
        }
        
        // 이전 노드와의 거리 측정
        const prevNode = currentCluster[currentCluster.length - 1];
        const dist = getCachedDistance(prevNode, node);
        
        if (dist <= CLUSTER_RADIUS_KM) {
            // 반경 300m 이내에 있으면 검출 대기열에 담기
            currentCluster.push(node);
        } else {
            // 반경을 벗어나면 조건 충족 여부(3개 이상) 확인 후 분기 처리
            if (currentCluster.length >= MIN_CLUSTER_SIZE) {
                // 특정 조건에 부합하므로 LLM이 동선을 정리
                const optimizedCluster = await optimizeClusterWithLLM(currentCluster);
                finalRoute.push(...optimizedCluster);
            } else {
                // 조건에 걸리지 않으면 기존 하버사인 경로 그대로 통과
                finalRoute.push(...currentCluster);
            }
            
            // 새로운 클러스터 검사 시작
            currentCluster = [node];
        }
    }
    
    // 마지막 남은 클러스터 꼬리표 처리
    if (currentCluster.length >= MIN_CLUSTER_SIZE) {
        const optimizedCluster = await optimizeClusterWithLLM(currentCluster);
        finalRoute.push(...optimizedCluster);
    } else {
        finalRoute.push(...currentCluster);
    }

    if (hasEnd) finalRoute.push(endLocation);
    return finalRoute;
}
