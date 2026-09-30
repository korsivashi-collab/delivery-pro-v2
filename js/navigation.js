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
    // 정상 작동 확인된 티맵 원본 호출 방식 유지
    window.location.href = `tmap://route?goalname=${encodeURIComponent(name)}&goalx=${lng}&goaly=${lat}`; 
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
    
    // 🌟 [핵심 수정] 카카오내비 네이티브 앱이 요구하는 정식 길안내 파라미터 직접 전달
    // x: 경도(lng), y: 위도(lat), coord_type: wgs84
    const kakaonaviScheme = `kakaonavi://navigate?name=${encodedName}&x=${lng}&y=${lat}&coord_type=wgs84`;

    const isAndroid = /Android/i.test(navigator.userAgent);

    // 안드로이드 앱(APK): 티맵과 동일하게 직접 스킴을 호출하여 목적지 길안내 즉시 실행
    if (isAndroid) {
        window.location.href = kakaonaviScheme;
        return;
    }

    // iOS 및 모바일 웹 브라우저 환경
    if (window.Kakao && window.Kakao.isInitialized()) {
        try {
            window.Kakao.Navi.start({
                name: cleanName,
                x: Number(lng),
                y: Number(lat),
                coordType: 'wgs84'
            });
            return;
        } catch (e) {
            console.warn("Kakao SDK 내비 실행 실패:", e);
        }
    }

    // 기타 환경 폴백
    window.location.href = kakaonaviScheme;
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