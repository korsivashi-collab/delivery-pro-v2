// js/admin-map.js
import { KAKAO_REST_API_KEY, getAddressFromCoords } from "./admin-utils.js";
import { db } from "./admin-api.js";
import { doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

export let map = null;
export let mapOverlays = [];
export let mapPlannedPolyline = null;
export let mapCompletedPolyline = null;
export let currentLocationOverlay = null;

export function initKakaoMap() {
    if (map) return;
    const container = document.getElementById('map');
    const options = { center: new kakao.maps.LatLng(37.566826, 126.9786567), level: 7 };
    map = new kakao.maps.Map(container, options);
}

export function clearMapOverlays() {
    if (currentLocationOverlay) {
        currentLocationOverlay.setMap(null);
        currentLocationOverlay = null;
    }
    mapOverlays.forEach(ov => ov.setMap(null));
    mapOverlays = [];
    if (mapPlannedPolyline) { mapPlannedPolyline.setMap(null); mapPlannedPolyline = null; }
    if (mapCompletedPolyline) { mapCompletedPolyline.setMap(null); mapCompletedPolyline = null; }
}

export function focusMapPosition(lat, lng) {
    if (map && lat && lng) {
        map.setLevel(3);
        map.panTo(new kakao.maps.LatLng(lat, lng));
    }
}