// js/navigation.js

// =================================================================
// [배송 동선 PRO] 외부 내비게이션(티맵/카카오내비) 및 카카오 지도 연동 모듈
// =================================================================

import { state } from './state.js';
import { showLoading, hideLoading } from './utils.js';

let startMapInstance = null;
let startMapMarkers = [];
let isMapSdkLoaded = false;

// 상호명 분리 및 주소 원본 보존 헬퍼
function formatDisplayAddress(rawAddress, storeName = "") {
    let extractedStore = storeName ? String(storeName).trim() : "";
    let cleanAddr = (rawAddress || "").trim();

    const match = cleanAddr.match(/^\[(.*?)\]\s*(.*)$/);
    if (match) {
        if (!extractedStore) extractedStore = match[1].trim();
        cleanAddr = match[2].trim();
    }

    if (extractedStore && cleanAddr.startsWith(extractedStore)) {
        cleanAddr = cleanAddr.substring(extractedStore.length).trim();
    }

    return {
        storeName: extractedStore,
        cleanAddr: cleanAddr,
        fullAddr: cleanAddr
    };
}

// ==========================================
// 1. 외부 내비게이션(티맵 / 카카오내비) 연동
// ==========================================
export function openTmap(lat, lng, name) { 
    if (!lat || !lng) {
        alert("목적지 좌표가 유효하지 않습니다.");
        return;
    }

    const encodedName = encodeURIComponent(name);
    
    // [앱 버전 티맵] 정상 작동 순수 스킴 다이렉트 호출
    window.location.href = `tmap://route?goalname=${encodedName}&goalx=${lng}&goaly=${lat}`; 
}

export function openKakaoNaviDirect(lat, lng, name) { 
    if (!lat || !lng) {
        alert("목적지 좌표가 유효하지 않습니다.");
        return;
    }

    const cleanName = (name || '목적지')
        .replace(/[^\w\s가-힣0-9.-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || '목적지';

    const encodedName = encodeURIComponent(cleanName);
    const KAKAO_NATIVE_KEY = "d048b59aa93cf8d4fb1c1bd9e63b6861";

    // Capacitor 앱(네이티브) 환경 판별
    const isApp = (typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) ||
                  window.location.protocol === 'file:' || 
                  window.location.protocol === 'capacitor:' || 
                  window.location.hostname === 'localhost';

    if (!isApp) {
        // [웹 브라우저 환경] 카카오 공식 SDK 호출
        if (window.Kakao && window.Kakao.isInitialized()) {
            try {
                window.Kakao.Navi.start({
                    name: cleanName,
                    x: Number(lng),
                    y: Number(lat),
                    coordType: 'wgs84'
                });
            } catch (e) {
                console.warn("Kakao SDK 내비 실행 실패:", e);
            }
        }
        return; 
    }

    // =========================================================
    // 🌟 [앱(APK) 환경] 카카오내비 다이렉트 목적지 연동
    // =========================================================
    // name, x(경도), y(위도), coord_type(wgs84)을 최상위 쿼리로 직접 전달해야 카카오내비가 주소를 즉시 인식합니다.
    const paramObj = {
        destination: { name: cleanName, x: Number(lng), y: Number(lat) },
        option: { coordType: 'wgs84' }
    };
    
    const extrasObj = {
        KA: "sdk/2.7.2 os/android lang/ko-KR device/android origin/com.deliverypro.app"
    };

    const encodedParam = encodeURIComponent(JSON.stringify(paramObj));
    const encodedExtras = encodeURIComponent(JSON.stringify(extrasObj));
    
    // 🚨 주소/좌표(name, x, y, coord_type)와 보안 인증(appkey, param, extras)을 모두 전달
    window.location.href = `kakaonavi://navigate?name=${encodedName}&x=${lng}&y=${lat}&coord_type=wgs84&appkey=${KAKAO_NATIVE_KEY}&apiver=1.0&param=${encodedParam}&extras=${encodedExtras}`;
}

// ==========================================
// 2. 카카오 지도 SDK 동적 로드
// ==========================================
async function loadKakaoMapSdk() {
    return new Promise((resolve) => {
        if (window.kakao && window.kakao.maps) {
            isMapSdkLoaded = true;
            resolve();
            return;
        }
        const KAKAO_KEY = "893c5c6ec8613974d84fa75fd6d0be11"; 
        const script = document.createElement('script');
        script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_KEY}&autoload=false`;
        script.onload = () => {
            kakao.maps.load(() => {
                isMapSdkLoaded = true;
                resolve();
            });
        };
        script.onerror = () => {
            alert("지도 스크립트를 불러오는데 실패했습니다. 네트워크를 확인해주세요.");
            resolve();
        };
        document.head.appendChild(script);
    });
}

// ==========================================
// 3. 시작 지점 선택 뷰 모드 전환 (리스트 뷰 <-> 지도 뷰)
// ==========================================
export async function switchStartSelectViewMode(mode, selectStartDestCallback) {
    const listContainer = document.getElementById('start-select-list');
    const mapContainer = document.getElementById('start-select-map-container');
    const tabList = document.getElementById('modal-tab-list-view');
    const tabMap = document.getElementById('modal-tab-map-view');
    
    if (mode === 'map') {
        if (listContainer) listContainer.classList.add('hidden');
        if (mapContainer) {
            mapContainer.classList.remove('hidden');
            mapContainer.classList.add('flex');
        }
        
        if (tabList) tabList.className = "flex-1 py-1.5 rounded-lg text-gray-500 hover:text-gray-700 transition";
        if (tabMap) tabMap.className = "flex-1 py-1.5 rounded-lg bg-white shadow text-blue-600 transition font-bold";
        
        showLoading("지도 불러오는 중...");
        await loadKakaoMapSdk();
        hideLoading();
        
        setTimeout(() => {
            if (startMapInstance) startMapInstance.relayout();
            renderStartSelectMap(selectStartDestCallback);
        }, 100);
        
    } else {
        if (listContainer) listContainer.classList.remove('hidden');
        if (mapContainer) {
            mapContainer.classList.add('hidden');
            mapContainer.classList.remove('flex');
        }
        
        if (tabList) tabList.className = "flex-1 py-1.5 rounded-lg bg-white shadow text-blue-600 transition font-bold";
        if (tabMap) tabMap.className = "flex-1 py-1.5 rounded-lg text-gray-500 hover:text-gray-700 transition";
    }
}

// ==========================================
// 4. 시작 지점 선택용 초경량 최적화 지도 렌더링
// ==========================================
export function renderStartSelectMap(selectStartDestCallback) {
    if (!isMapSdkLoaded || !window.kakao || !window.kakao.maps) return;
    const container = document.getElementById('start-select-kakao-map');
    if (!container) return;
    
    const destinations = state.getDestinations();
    if (destinations.length === 0) return;

    if (!startMapInstance) {
        const options = {
            center: new kakao.maps.LatLng(destinations[0].lat, destinations[0].lng),
            level: 5
        };
        startMapInstance = new kakao.maps.Map(container, options);
    }
    
    startMapMarkers.forEach(m => m.setMap(null));
    startMapMarkers = [];
    
    const bounds = new kakao.maps.LatLngBounds();
    
    destinations.forEach((dest) => {
        const pos = new kakao.maps.LatLng(dest.lat, dest.lng);
        bounds.extend(pos);
        
        const fmt = formatDisplayAddress(dest.address, dest.storeName);
        const shortName = fmt.storeName || (fmt.cleanAddr.length > 8 ? fmt.cleanAddr.substring(0, 8) + '...' : fmt.cleanAddr);
        
        const content = document.createElement('div');
        content.className = "flex flex-col items-center justify-center translate-y-[-100%] cursor-pointer pb-1";
        content.innerHTML = `
            <div class="bg-blue-600 text-white font-bold w-7 h-7 rounded-full flex items-center justify-center text-[12px] border-2 border-white shadow-sm">
                출발
            </div>
            <div class="bg-white px-1.5 py-0.5 rounded border border-gray-400 text-[10px] font-bold text-gray-800 mt-0.5 whitespace-nowrap shadow-xs">
                ${shortName}
            </div>
        `;
        
        content.onclick = () => {
            if (typeof selectStartDestCallback === 'function') {
                selectStartDestCallback(dest.id);
            }
        };
        
        const customOverlay = new kakao.maps.CustomOverlay({
            position: pos,
            content: content,
            yAnchor: 1,
            clickable: true 
        });
        
        customOverlay.setMap(startMapInstance);
        startMapMarkers.push(customOverlay);
    });
    
    startMapInstance.setBounds(bounds, 50, 50, 50, 50);
}