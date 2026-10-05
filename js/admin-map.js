// js/admin-map.js
import { KAKAO_REST_API_KEY, getAddressFromCoords } from "./admin-utils.js";
import { db } from "./admin-api.js";
import { doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

export let map = null;
export let mapOverlays = [];
export let mapPlannedPolyline = null;
export let mapCompletedPolyline = null;
export let currentLocationOverlay = null;

// 🌟 전역 window 참조 배열 안전 초기화
if (!window.myMapOverlays) window.myMapOverlays = [];

export function initKakaoMap() {
    if (map) return;
    const container = document.getElementById('map');
    if (!container) return;
    const options = { center: new kakao.maps.LatLng(37.566826, 126.9786567), level: 7 };
    map = new kakao.maps.Map(container, options);
    window.kakaoMapInstance = map;
}

export function clearMapOverlays() {
    // 1. 현재 위치 오버레이 제거 (모듈 변수 및 window 객체 동시 클리어)
    if (currentLocationOverlay) {
        currentLocationOverlay.setMap(null);
        currentLocationOverlay = null;
    }
    if (window.currentLocationOverlay) {
        window.currentLocationOverlay.setMap(null);
        window.currentLocationOverlay = null;
    }

    // 2. 모듈 내부 오버레이 목록 제거
    if (mapOverlays && Array.isArray(mapOverlays)) {
        mapOverlays.forEach(ov => { if (ov && ov.setMap) ov.setMap(null); });
        mapOverlays = [];
    }

    // 3. 전역 window.myMapOverlays 제거 (다른 모듈에서 등록된 배송지 핀 잔상 완벽 소거)
    if (window.myMapOverlays && Array.isArray(window.myMapOverlays)) {
        window.myMapOverlays.forEach(ov => { if (ov && ov.setMap) ov.setMap(null); });
        window.myMapOverlays = [];
    }

    // 4. 계획 경로선(Polyline) 제거
    if (mapPlannedPolyline) { 
        mapPlannedPolyline.setMap(null); 
        mapPlannedPolyline = null; 
    }
    if (window.mapPlannedPolyline) { 
        window.mapPlannedPolyline.setMap(null); 
        window.mapPlannedPolyline = null; 
    }

    // 5. 완료 경로선(Polyline) 제거
    if (mapCompletedPolyline) { 
        mapCompletedPolyline.setMap(null); 
        mapCompletedPolyline = null; 
    }
    if (window.mapCompletedPolyline) { 
        window.mapCompletedPolyline.setMap(null); 
        window.mapCompletedPolyline = null; 
    }
}

export function focusMapPosition(lat, lng) {
    if (map && lat && lng) {
        map.setLevel(3);
        map.panTo(new kakao.maps.LatLng(lat, lng));
    }
}

// 🌟 어느 모듈에서 호출하더라도 단일 창구로 지도 잔상이 소거되도록 전역 바인딩
window.clearMapOverlays = clearMapOverlays;
window.focusMapPosition = focusMapPosition;