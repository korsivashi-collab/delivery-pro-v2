// js/navigation.js

// =================================================================
// [배송 동선 PRO] 외부 내비게이션(티맵/네이버) 및 카카오 지도 연동 모듈
// =================================================================

import { state, hasValidDeliveryCoordinates } from './state.js';
import { isNativeApp, KakaoNavigation } from './native-platform.js';
import { showLoading, hideLoading, withRequestDeadline } from './utils.js';


// 사용자가 선택한 내비는 기기에 저장하고 모든 배송지에 공통 적용한다.
const NAVIGATION_PREFERENCE_KEY = 'deliveryPro_preferredNavigation';
let preferredNavigation = 'tmap';
try {
    const saved = localStorage.getItem(NAVIGATION_PREFERENCE_KEY);
    if (saved === 'naver' || saved === 'kakao') preferredNavigation = saved;
} catch (_) { /* 저장소를 사용할 수 없어도 현재 세션에서는 선택 가능 */ }

export function getPreferredNavigation() { return preferredNavigation; }

export function navigationButtonContent(provider = preferredNavigation) {
    const isNaver = provider === 'naver';
    const isKakao = provider === 'kakao';
    return '<span class="navigation-brand" aria-hidden="true">' + (isKakao ? 'K' : isNaver ? 'N' : 'T') + '</span>' +
        '<span>' + (isKakao ? '카카오내비로 안내' : isNaver ? '네이버지도로 안내' : '티맵으로 안내') + '</span>' +
        '<svg class="navigation-arrow" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

export function openNavigationPicker() {
    const dialog = document.getElementById('navigation-picker');
    if (!dialog) return;
    dialog.querySelectorAll('[data-navigation-option]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.navigationOption === preferredNavigation));
    });
    if (!dialog.open) dialog.showModal();
}

export function selectNavigation(provider) {
    if (provider !== 'tmap' && provider !== 'naver' && provider !== 'kakao') return;
    preferredNavigation = provider;
    try { localStorage.setItem(NAVIGATION_PREFERENCE_KEY, provider); } catch (_) { /* 세션 선택 유지 */ }
    document.querySelectorAll('[data-navigation-launch]').forEach(button => {
        button.dataset.navigationProvider = provider;
        button.innerHTML = navigationButtonContent(provider);
    });
    document.getElementById('navigation-picker')?.close();
}

export function openPreferredNavigation(lat, lng, name) {
    if (preferredNavigation === 'kakao') return openKakaoNavi(lat, lng, name);
    if (preferredNavigation === 'naver') return openNaverMap(lat, lng, name);
    return openTmap(lat, lng, name);
}

window.openNavigationPicker = openNavigationPicker;
window.selectNavigation = selectNavigation;
window.openPreferredNavigation = openPreferredNavigation;

let startMapInstance = null;
let startMapMarkers = [];
let isMapSdkLoaded = false;
let mapSdkPromise = null;
let mapViewGeneration = 0;
let mapViewController = null;
let mapRenderTimer = null;
export const MAP_SDK_TIMEOUT_MS = 15000;

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
// 1. 외부 내비게이션 (티맵 / 네이버) 전용 연동
// ==========================================
function launchNavigationApp(url, appName) {
    const failureMessage = `${appName} 앱을 실행할 수 없습니다. 설치 여부를 확인해주세요.`;
    try {
        // 웹은 Safari/OS 동작에 맡기고, Android의 실제 실패 안내는 네이티브 플러그인이 처리한다.
        window.location.href = url;
    } catch (error) {
        alert(failureMessage);
    }
}

// 웹은 기존 JavaScript 키, Android는 별도 네이티브 키를 사용하는 공식 SDK로 실행한다.
export async function openKakaoNavi(lat, lng, name) {
    if (!hasValidDeliveryCoordinates({ lat, lng })) {
        alert('목적지 좌표가 유효하지 않습니다.');
        return;
    }
    const destinationName = String(name || '목적지').trim() || '목적지';
    try {
        if (isNativeApp()) {
            await KakaoNavigation.navigate({ lat, lng, name: destinationName });
            return;
        }
        if (!window.Kakao?.Navi) throw new Error('카카오내비 모듈을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침해 주세요.');
        if (!window.Kakao.isInitialized()) window.Kakao.init('893c5c6ec8613974d84fa75fd6d0be11');
        window.Kakao.Navi.start({ name: destinationName, x: lng, y: lat, coordType: 'wgs84', routeInfo: true });
    } catch (error) {
        alert(error?.message || '카카오내비를 실행하지 못했습니다. 설치 여부를 확인해 주세요.');
    }
}

export function openTmap(lat, lng, name) { 
    if (!hasValidDeliveryCoordinates({ lat, lng })) {
        alert("목적지 좌표가 유효하지 않습니다.");
        return;
    }

    const cleanName = (name || '목적지').replace(/['"]/g, '').trim();
    launchNavigationApp(`tmap://route?goalname=${encodeURIComponent(cleanName)}&goalx=${lng}&goaly=${lat}`, '티맵');
}

export function openNaverMap(lat, lng, name) {
    if (!hasValidDeliveryCoordinates({ lat, lng })) {
        alert("목적지 좌표가 유효하지 않습니다.");
        return;
    }
    
    // 특수문자 제거 및 띄어쓰기 정규화 (네이버 내비 인식률 극대화)
    const cleanName = (name || '목적지')
        .replace(/[^\w\s가-힣0-9.-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || '목적지';
        
    const encodedName = encodeURIComponent(cleanName);
    
    // 네이버 지도/내비게이션 앱 다이렉트 호출 스킴
    launchNavigationApp(`nmap://navigation?dlat=${lat}&dlng=${lng}&dname=${encodedName}&appname=com.deliverypro.app`, '네이버지도');
}

// ==========================================
// 2. 카카오 지도 SDK 동적 로드 (출발지 선택 지도용)
// ==========================================
async function loadKakaoMapSdk() {
    if (isMapSdkLoaded && window.kakao?.maps) return;
    if (mapSdkPromise) return mapSdkPromise;
    let script = null;
    const promise = new Promise((resolve, reject) => {
        let settled = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (script) { script.onload = null; script.onerror = null; if (error) script.remove(); }
            if (error) reject(error);
            else { isMapSdkLoaded = true; resolve(); }
        };
        const timer = setTimeout(() => {
            const error = new Error('지도 불러오기 대기 시간이 초과되었습니다.'); error.name = 'TimeoutError'; finish(error);
        }, MAP_SDK_TIMEOUT_MS);
        const initialize = () => {
            if (settled) return;
            try { window.kakao.maps.load(() => finish()); }
            catch (error) { finish(error); }
        };
        if (window.kakao?.maps) { initialize(); return; }
        const KAKAO_KEY = "893c5c6ec8613974d84fa75fd6d0be11"; 
        script = document.createElement('script');
        script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_KEY}&autoload=false`;
        script.onload = initialize;
        script.onerror = () => finish(new Error('지도 스크립트를 불러오지 못했습니다.'));
        document.head.appendChild(script);
    });
    mapSdkPromise = promise;
    try { await promise; }
    finally { if (mapSdkPromise === promise) mapSdkPromise = null; }
}

export function cancelStartMapLoad() {
    mapViewGeneration++;
    clearTimeout(mapRenderTimer);
    mapRenderTimer = null;
    startMapMarkers.forEach(marker => marker.setMap(null));
    startMapMarkers = [];
    if (mapViewController) { mapViewController.abort(); mapViewController = null; hideLoading(); }
}

// ==========================================
// 3. 시작 지점 선택 뷰 모드 전환 (리스트 <-> 지도)
// ==========================================
export async function switchStartSelectViewMode(mode, selectStartDestCallback) {
    cancelStartMapLoad();
    const generation = mapViewGeneration;
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
        
        if (tabList) tabList.className = "flex-1 py-1.5 rounded-lg text-gray-500 hover:text-gray-700 transition font-bold";
        if (tabMap) tabMap.className = "flex-1 py-1.5 rounded-lg bg-white shadow text-blue-600 transition font-bold";
        
        const controller = new AbortController();
        mapViewController = controller;
        showLoading("지도 불러오는 중...", () => switchStartSelectViewMode('list', selectStartDestCallback));
        try {
            await withRequestDeadline(() => loadKakaoMapSdk(), MAP_SDK_TIMEOUT_MS, { signal: controller.signal, label: '지도 로딩' });
            if (generation !== mapViewGeneration) return;
        } catch (error) {
            if (generation === mapViewGeneration && error.name !== 'AbortError') {
                alert('지도를 불러오지 못했습니다. 목록에서 배송지를 선택해 주세요.');
                await switchStartSelectViewMode('list', selectStartDestCallback);
            }
            return;
        } finally {
            if (generation === mapViewGeneration) { mapViewController = null; hideLoading(); }
        }
        
        mapRenderTimer = setTimeout(() => {
            mapRenderTimer = null;
            if (generation !== mapViewGeneration || document.getElementById('start-select-modal')?.classList.contains('hidden')) return;
            if (startMapInstance) startMapInstance.relayout();
            renderStartSelectMap(selectStartDestCallback);
        }, 120);
        
    } else {
        if (listContainer) listContainer.classList.remove('hidden');
        if (mapContainer) {
            mapContainer.classList.add('hidden');
            mapContainer.classList.remove('flex');
        }
        
        if (tabList) tabList.className = "flex-1 py-1.5 rounded-lg bg-white shadow text-blue-600 transition font-bold";
        if (tabMap) tabMap.className = "flex-1 py-1.5 rounded-lg text-gray-500 hover:text-gray-700 transition font-bold";
    }
}

// ==========================================
// 4. 시작 지점 선택용 지도 렌더링 (번호표 제거 & 상호명 단독 칩)
// ==========================================
export function renderStartSelectMap(selectStartDestCallback) {
    if (!isMapSdkLoaded || !window.kakao || !window.kakao.maps) return;
    const container = document.getElementById('start-select-kakao-map');
    if (!container) return;
    
    const destinations = state.getDestinations().filter(hasValidDeliveryCoordinates);
    if (destinations.length === 0) {
        startMapMarkers.forEach(marker => marker.setMap(null));
        startMapMarkers = [];
        return;
    }

    if (!startMapInstance) {
        const options = {
            center: new kakao.maps.LatLng(destinations[0].lat, destinations[0].lng),
            level: 5
        };
        startMapInstance = new kakao.maps.Map(container, options);
    } else {
        startMapInstance.relayout();
    }
    
    // 기존 마커 초기화
    startMapMarkers.forEach(m => m.setMap(null));
    startMapMarkers = [];
    
    const bounds = new kakao.maps.LatLngBounds();
    
    destinations.forEach((dest) => {
        const pos = new kakao.maps.LatLng(dest.lat, dest.lng);
        bounds.extend(pos);
        
        const fmt = formatDisplayAddress(dest.address, dest.storeName);
        const shortName = fmt.storeName || (fmt.cleanAddr.length > 8 ? fmt.cleanAddr.substring(0, 8) + '...' : fmt.cleanAddr);
        
        // 🌟 요청 반영: 복잡한 원형 번호표를 완전히 제거하고, 가볍고 직관적인 상호명 칩만 단독 렌더링
        const content = document.createElement('div');
        content.className = "cursor-pointer transform -translate-x-1/2 -translate-y-full pb-1 select-none active:scale-95 transition";
        content.innerHTML = `
            <div class="bg-slate-900 hover:bg-blue-600 text-white font-extrabold text-[11px] px-2.5 py-1 rounded-full shadow-md border-2 border-white flex items-center gap-1 whitespace-nowrap">
                <span class="text-blue-400 text-[10px]">🏢</span>
                <span>${shortName}</span>
            </div>
            <div class="w-1.5 h-1.5 bg-slate-900 mx-auto rotate-45 -mt-1 border-r border-b border-white"></div>
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

// Window 전역 바인딩 (인라인 HTML 호출 대응)
window.openTmap = openTmap;
window.openNaverMap = openNaverMap;
