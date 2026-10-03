// js/state.js

// =================================================================
// [배송 동선 PRO] 공용 상태(데이터) 저장소
// 배송지 목록, 시작/종료 위치, GPS 정보를 안전하게 중앙 관리합니다.
// =================================================================

let destinations = [];
let endLocation = { lat: 0, lng: 0, address: "" }; 
let startLocation = null;
let routeOwnerId = null;
let routeUpdatedAt = 0;
let onActiveDataSaved = null;
let lastKnownGps = null;
let gpsWatchId = null;
let lastGeneratedDestinationId = 0;

function isDestinationId(id) {
    return (typeof id === 'number' && Number.isSafeInteger(id)) ||
        (typeof id === 'string' && id.trim().length > 0);
}

function createDestinationId(reservedIds) {
    let id = Math.max(Date.now(), lastGeneratedDestinationId + 1);
    while (reservedIds.has(String(id))) id++;
    lastGeneratedDestinationId = id;
    return id;
}

// DOM IDs use string keys too, so numeric 1 and string "1" must not coexist.
// Reserve the entire input first so repairs never replace a later valid ID.
function ensureUniqueDestinationIds(list) {
    const reservedIds = new Set(list.filter(item => item && isDestinationId(item.id)).map(item => String(item.id)));
    const seenIds = new Set();
    let changed = false;
    const normalized = list.map(item => {
        if (!item || typeof item !== 'object') return item;
        if (isDestinationId(item.id) && !seenIds.has(String(item.id))) {
            seenIds.add(String(item.id));
            return item;
        }
        const id = createDestinationId(reservedIds);
        reservedIds.add(String(id));
        seenIds.add(String(id));
        changed = true;
        return { ...item, id };
    });
    return changed ? normalized : list;
}

export function destinationIdAttribute(id) {
    return String(id).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Preserve legacy string IDs and their type when used in inline button handlers.
export function destinationIdArgument(id) {
    return destinationIdAttribute(JSON.stringify(id));
}

export const state = {
    getRouteOwnerId() { return routeOwnerId; },
    getRouteUpdatedAt() { return routeUpdatedAt; },
    setActiveDataSavedHandler(handler) { onActiveDataSaved = handler; },
    activateRouteOwner(ownerId) {
        routeOwnerId = ownerId || null;
        this.loadActiveData();
    },
    deactivateRouteOwner() {
        routeOwnerId = null;
        routeUpdatedAt = 0;
        destinations = [];
        endLocation = { lat: 0, lng: 0, address: '' };
        startLocation = null;
    },

    // 1. 배송지 목록(destinations) 관리
    getDestinations() {
        return destinations;
    },
    setDestinations(newList) {
        destinations = ensureUniqueDestinationIds(newList);
    },
    addDestination(item) {
        const reservedIds = new Set(destinations.map(destination => String(destination.id)));
        const addedItem = isDestinationId(item.id) && !reservedIds.has(String(item.id))
            ? item : { ...item, id: createDestinationId(reservedIds) };
        destinations.push(addedItem);
        return addedItem;
    },
    removeDestination(id) {
        destinations = destinations.filter(d => d.id !== id);
    },

    // 2. 종료 지점(endLocation) 관리
    getEndLocation() {
        return endLocation;
    },
    setEndLocation(loc) {
        endLocation = loc;
    },

    // 3. 시작 지점(startLocation) 관리
    getStartLocation() {
        return startLocation;
    },
    setStartLocation(loc) {
        startLocation = loc;
    },

    // 4. GPS 센서 상태 관리
    getLastKnownGps() {
        return lastKnownGps;
    },
    setLastKnownGps(gps) {
        lastKnownGps = gps;
    },
    getGpsWatchId() {
        return gpsWatchId;
    },
    setGpsWatchId(id) {
        gpsWatchId = id;
    },

    // 5. 로컬스토리지에 현재 작업 데이터 저장
    saveActiveData(updatedAt = null) {
        if (!routeOwnerId) return;
        routeUpdatedAt = updatedAt === null ? Math.max(Date.now(), routeUpdatedAt + 1) : updatedAt;
        localStorage.setItem('deliveryPro_active_destinations', JSON.stringify(destinations));
        localStorage.setItem('deliveryPro_end_location', JSON.stringify(endLocation));
        localStorage.setItem('deliveryPro_route_metadata', JSON.stringify({ routeOwnerId, updatedAt: routeUpdatedAt, destinations, endLocation }));
        if (updatedAt === null && onActiveDataSaved) onActiveDataSaved();
    },

    // 소유자 없는 기존 캐시는 추측해서 가져오지 않습니다.
    loadActiveData() {
        destinations = [];
        endLocation = { lat: 0, lng: 0, address: '' };
        startLocation = null;
        routeUpdatedAt = 0;
        if (!routeOwnerId) return;
        try {
            const metadata = JSON.parse(localStorage.getItem('deliveryPro_route_metadata') || 'null');
            if (!metadata || metadata.routeOwnerId !== routeOwnerId || !Number.isFinite(metadata.updatedAt)) return;
            // 하나의 소유자 스냅샷을 읽어 다른 탭의 별도 키 쓰기와 섞이지 않게 합니다.
            const savedList = metadata.destinations;
            if (!Array.isArray(savedList)) return;
            destinations = ensureUniqueDestinationIds(savedList);
            endLocation = metadata.endLocation || endLocation;
            routeUpdatedAt = metadata.updatedAt;
            if (destinations[0]) startLocation = { lat: destinations[0].lat, lng: destinations[0].lng, address: destinations[0].address };
            // Persist only repaired IDs, without advancing the server revision.
            if (destinations !== savedList) this.saveActiveData(routeUpdatedAt);
        } catch (error) {
            destinations = [];
            endLocation = { lat: 0, lng: 0, address: '' };
            routeUpdatedAt = 0;
        }
    },

    // 7. 배송 순번(1, 2, 3...) 번호 재정렬 및 자동 저장
    updateDisplayNumbers(updatedAt = null) {
        destinations = destinations.filter(d => d != null);
        destinations.forEach((d, i) => {
            d.displayNumber = i + 1;
        });
        this.saveActiveData(updatedAt);
    }
};
