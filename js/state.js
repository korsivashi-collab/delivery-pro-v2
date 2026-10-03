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
        destinations = newList;
    },
    addDestination(item) {
        destinations.push(item);
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
            destinations = savedList;
            endLocation = metadata.endLocation || endLocation;
            routeUpdatedAt = metadata.updatedAt;
            if (destinations[0]) startLocation = { lat: destinations[0].lat, lng: destinations[0].lng, address: destinations[0].address };
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