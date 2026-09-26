// js/admin-dispatch-algorithm.js

// ==========================================
// 1. 전국 주요 지형지물(강, 산, 행정구역) 가상 페널티 설정
// ==========================================

// 전국 대표 강줄기 가상 차단선 (한강, 낙동강, 금강, 영산강)
export const RIVER_BARRIER_LINES = [
    // 1. 한강 (일산/김포 ~ 여의도 ~ 잠실 ~ 팔당)
    [
        { lat: 37.605, lng: 126.745 }, { lat: 37.585, lng: 126.815 },
        { lat: 37.558, lng: 126.865 }, { lat: 37.534, lng: 126.935 },
        { lat: 37.518, lng: 126.985 }, { lat: 37.530, lng: 127.050 },
        { lat: 37.532, lng: 127.100 }, { lat: 37.565, lng: 127.155 },
        { lat: 37.545, lng: 127.240 }
    ],
    // 2. 낙동강 (부산 강서구와 사상/사하/북구 분리)
    [
        { lat: 35.320, lng: 128.990 }, { lat: 35.285, lng: 128.985 },
        { lat: 35.215, lng: 128.980 }, { lat: 35.155, lng: 128.960 },
        { lat: 35.095, lng: 128.940 }, { lat: 35.030, lng: 128.930 }
    ],
    // 3. 금강 (세종/대전/공주 분리 라인)
    [
        { lat: 36.560, lng: 127.180 }, { lat: 36.520, lng: 127.260 },
        { lat: 36.480, lng: 127.350 }, { lat: 36.440, lng: 127.420 }
    ],
    // 4. 영산강 (광주/나주 분리 라인)
    [
        { lat: 35.230, lng: 126.780 }, { lat: 35.160, lng: 126.820 },
        { lat: 35.080, lng: 126.750 }
    ]
];

// 서울 강북 14개 구 및 강남 11개 구 목록
export const SEOUL_GANGBUK_GU = ['종로구', '중구', '용산구', '성동구', '광진구', '동대문구', '중랑구', '성북구', '강북구', '도봉구', '노원구', '은평구', '서대문구', '마포구'];
export const SEOUL_GANGNAM_GU = ['양천구', '강서구', '구로구', '금천구', '영등포구', '동작구', '관악구', '서초구', '강남구', '송파구', '강동구'];

// ==========================================
// 2. 기하 및 거리 연산 함수 (순수 연산 엔진)
// ==========================================

// 수학적 선분 교차 검사 함수 (CCW)
function ccw(p1, p2, p3) {
    const cross = (p2.lng - p1.lng) * (p3.lat - p1.lat) - (p2.lat - p1.lat) * (p3.lng - p1.lng);
    if (Math.abs(cross) < 1e-9) return 0;
    return cross > 0 ? 1 : -1;
}

function linesIntersect(p1, p2, p3, p4) {
    const d1 = ccw(p3, p4, p1);
    const d2 = ccw(p3, p4, p2);
    const d3 = ccw(p1, p2, p3);
    const d4 = ccw(p1, p2, p4);
    return (d1 * d2 < 0) && (d3 * d4 < 0);
}

// 두 지점 사이가 전국 주요 강줄기 차단선을 가로지르는지 확인
export function checkRiverCrossings(p1, p2) {
    for (const river of RIVER_BARRIER_LINES) {
        for (let i = 0; i < river.length - 1; i++) {
            if (linesIntersect(p1, p2, river[i], river[i + 1])) {
                return true;
            }
        }
    }
    return false;
}

// 주소 문자열에서 시/도, 시/군/구 및 한강 강남/강북 특성 추출
export function parseAreaInfo(addr) {
    if (!addr || typeof addr !== 'string') {
        return { sido: '', sigungu: '', isSeoulGangbuk: false, isSeoulGangnam: false };
    }
    const clean = addr.trim();
    const match = clean.match(/(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별(?:시|자치시)|광역(?:시)|(?:특별)?자치도|도)?\s*([가-힣]+(?:시|군|구))?(?:\s*([가-힣]+구))?/);

    let sido = match ? (match[1] || '') : '';
    let sigungu = '';
    if (match) {
        const p1 = match[2] || '';
        const p2 = match[3] || '';
        sigungu = (p1 + (p2 ? ' ' + p2 : '')).trim();
    }

    const isSeoulGangbuk = sido === '서울' && SEOUL_GANGBUK_GU.some(gu => clean.includes(gu));
    const isSeoulGangnam = sido === '서울' && SEOUL_GANGNAM_GU.some(gu => clean.includes(gu));

    return { sido, sigungu, isSeoulGangbuk, isSeoulGangnam };
}

// 기본 직선거리 (Haversine 공식, km)
export function getBaseDist(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 999999;
    const R = 6371; 
    const dLat = (lat2 - lat1) * Math.PI / 180; 
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + 
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 지형지물(강, 산, 행정구역) 가상 페널티가 결합된 실질 거리 계산기
export function calculateGeoPenalizedDist(lat1, lon1, lat2, lon2, addr1 = '', addr2 = '') {
    const baseDistance = getBaseDist(lat1, lon1, lat2, lon2);
    if (baseDistance >= 999999) return baseDistance;

    let penalty = 0;

    // 1. 강줄기 가상 차단선 통과 여부 검사
    const p1 = { lat: lat1, lng: lon1 };
    const p2 = { lat: lat2, lng: lon2 };
    if (checkRiverCrossings(p1, p2)) {
        penalty += 25; // 강을 건너야 할 경우 25km 가상 벌점
    }

    // 2. 주소 기반 행정구역 및 한강 남북 분리 검사
    const area1 = parseAreaInfo(addr1);
    const area2 = parseAreaInfo(addr2);

    if (area1.sido && area2.sido) {
        // 서울 강남 ↔ 강북 교차 배정 강력 차단
        if ((area1.isSeoulGangbuk && area2.isSeoulGangnam) || (area1.isSeoulGangnam && area2.isSeoulGangbuk)) {
            penalty += 30;
        }
        // 광역 시/도가 서로 다른 경우
        else if (area1.sido !== area2.sido) {
            penalty += 12;
        }
        // 같은 시/도 내에서 시·군·구가 다른 경우 (자연 경계선 우선 분리)
        else if (area1.sigungu && area2.sigungu && area1.sigungu !== area2.sigungu) {
            penalty += 6;
        }
    }

    return baseDistance + penalty;
}

// ==========================================
// 3. 기사별 목표 수량(Cap) 및 가중치 균등 분배 산정
// ==========================================
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

        let exactCap = (totalOrders / numDrivers) + w - (totalWeights / numDrivers);
        if (exactCap < 0) exactCap = 0;

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
            tLat: centerLat,
            tLng: centerLng,
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
// 4. [핵심 알고리즘] 외곽 최우선 인접 클러스터링 자동 배차 실행기
// ==========================================
export function executeAutoDispatch({ targetOrders, activeDrivers, weights = {}, companyBase = null }) {
    if (!targetOrders || targetOrders.length === 0) {
        return { success: false, message: "할당할 배송 데이터가 없습니다." };
    }
    if (!activeDrivers || activeDrivers.length === 0) {
        return { success: false, message: "배정 대상 운행 기사가 없습니다." };
    }

    const totalOrders = targetOrders.length;
    const driverStats = calculateDriverCapacities(activeDrivers, totalOrders, weights, companyBase);

    // 거리 측정의 기준이 될 '본사 거점' (미설정 시 전체 배송지들의 평균 중심점 산출)
    let baseLat = companyBase ? companyBase.lat : null;
    let baseLng = companyBase ? companyBase.lng : null;
    let baseAddr = companyBase ? companyBase.address : '';

    if (!baseLat || !baseLng) {
        const validOrders = targetOrders.filter(o => o.lat && o.lng);
        if (validOrders.length > 0) {
            baseLat = validOrders.reduce((sum, o) => sum + o.lat, 0) / validOrders.length;
            baseLng = validOrders.reduce((sum, o) => sum + o.lng, 0) / validOrders.length;
            baseAddr = '임시 가상 중심점';
        } else {
            baseLat = 37.566826; baseLng = 126.978656; // 서울시청 (Fallback)
        }
    }

    // 아직 배정되지 않은 주문 목록 (원본 복사)
    let unassigned = [...targetOrders];

    // 모든 배송지가 배정될 때까지 반복
    while (unassigned.length > 0) {
        // 1. 현재 남은 오더 중 본사(또는 중심)에서 '가장 먼(외곽)' 배송지 탐색
        unassigned.sort((a, b) => {
            const distA = calculateGeoPenalizedDist(a.lat, a.lng, baseLat, baseLng, a.fullAddress || a.address, baseAddr);
            const distB = calculateGeoPenalizedDist(b.lat, b.lng, baseLat, baseLng, b.fullAddress || b.address, baseAddr);
            return distB - distA; // 거리가 먼 순서대로(내림차순) 정렬
        });

        let currentOrder = unassigned[0];
        let bestDriver = null;
        let minDistance = Infinity;

        // 2. 이 가장 먼 배송지를 처리할 최적의 기사 찾기 (정원이 남은 기사 중 권역 중심이 가장 가까운 기사)
        driverStats.forEach(ds => {
            if (ds.assignedCount >= ds.targetCap) return;
            const dist = calculateGeoPenalizedDist(currentOrder.lat, currentOrder.lng, ds.tLat, ds.tLng, currentOrder.fullAddress || currentOrder.address, ds.tAddr);
            if (dist < minDistance) {
                minDistance = dist;
                bestDriver = ds;
            }
        });

        // (안전장치) 모든 기사 정원이 찼는데도 남은 물량이 있다면 예외적으로 가장 가까운 기사에게 강제 초과 배정
        if (!bestDriver) {
            let absMin = Infinity;
            driverStats.forEach(ds => {
                const dist = calculateGeoPenalizedDist(currentOrder.lat, currentOrder.lng, ds.tLat, ds.tLng, currentOrder.fullAddress || currentOrder.address, ds.tAddr);
                if (dist < absMin) {
                    absMin = dist;
                    bestDriver = ds;
                }
            });
        }

        // 3. 찾은 기사에게 외곽 오더 첫 할당
        bestDriver.assignedCount++;
        currentOrder.assignedDriver = bestDriver.phone;
        unassigned.shift(); // 할당 완료된 0번째 항목 제거

        // 4. [핵심 개선] 해당 기사의 할당량(Cap)이 모두 찰 때까지, 
        // 방금 배정한 위치에서 '가장 가까운' 인접 오더를 싹쓸이로 묶음(클러스터링) 연속 할당
        while (bestDriver.assignedCount < bestDriver.targetCap && unassigned.length > 0) {
            // 남은 오더들을 '방금 배정한 위치(currentOrder)' 기준으로 다시 거리 오름차순 정렬
            unassigned.sort((a, b) => {
                const distA = calculateGeoPenalizedDist(a.lat, a.lng, currentOrder.lat, currentOrder.lng, a.fullAddress || a.address, currentOrder.fullAddress || currentOrder.address);
                const distB = calculateGeoPenalizedDist(b.lat, b.lng, currentOrder.lat, currentOrder.lng, b.fullAddress || b.address, currentOrder.fullAddress || currentOrder.address);
                return distA - distB; // 가까운 순서대로(오름차순) 정렬
            });

            // 가장 가까운 인접 배송지 선택 후 할당
            let nextOrder = unassigned[0];
            bestDriver.assignedCount++;
            nextOrder.assignedDriver = bestDriver.phone;
            unassigned.shift(); // 할당 완료 제거

            // 다음 인접 탐색의 중심축을 방금 할당한 배송지로 갱신 (지그재그 방지)
            currentOrder = nextOrder;
        }
    }

    return {
        success: true,
        totalOrders,
        driverStats,
        allocatedCount: targetOrders.length
    };
}