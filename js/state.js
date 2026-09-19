// js/state.js

// =================================================================
// [배송 동선 PRO] 공용 상태(데이터) 저장소
// 배송지 목록, 시작/종료 위치, GPS 정보를 안전하게 중앙 관리합니다.
// =================================================================

let destinations = [];
let endLocation = { lat: 0, lng: 0, address: "" }; 
let startLocation = null;
let lastKnownGps = null;
let gpsWatchId = null;

export const state = {
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
    saveActiveData() {
        localStorage.setItem('deliveryPro_active_destinations', JSON.stringify(destinations));
        localStorage.setItem('deliveryPro_end_location', JSON.stringify(endLocation));
    },

    // 6. 로컬스토리지에서 기존 작업 데이터 복원
    loadActiveData() {
        const savedList = localStorage.getItem('deliveryPro_active_destinations');
        if (savedList) { 
            try { 
                destinations = JSON.parse(savedList); 
            } catch (e) { 
                destinations = []; 
            } 
        } else {
            destinations = [];
        }
        
        const savedEnd = localStorage.getItem('deliveryPro_end_location');
        if (savedEnd) { 
            try { 
                endLocation = JSON.parse(savedEnd); 
            } catch (e) {
                endLocation = { lat: 0, lng: 0, address: "" };
            } 
        } else {
            endLocation = { lat: 0, lng: 0, address: "" };
        }
    },

    // 7. 배송 순번(1, 2, 3...) 번호 재정렬 및 자동 저장
    updateDisplayNumbers() {
        destinations = destinations.filter(d => d != null);
        destinations.forEach((d, i) => {
            d.displayNumber = i + 1;
        });
        this.saveActiveData();
    }
};