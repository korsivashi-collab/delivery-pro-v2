// js/navigation.js

// =================================================================
// [배송 동선 PRO] 외부 내비게이션(티맵/네이버) 및 카카오 지도 연동 모듈
// =================================================================

import { state, hasValidDeliveryCoordinates } from './state.js';
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
// 1. 외부 내비게이션 (티맵 / 네이버) 전용 연동
// ==========================================
export function openTmap(lat, lng, name) { 
    if (!hasValidDeliveryCoordinates({ lat, lng })) {
        alert("목적지 좌표가 유효하지 않습니다.");
        return;
    }

    const cleanName = (name || '목적지').replace(/['"]/g, '').trim();
    window.location.href = `tmap://route?goalname=${encodeURIComponent(cleanName)}&goalx=${lng}&goaly=${lat}`; 
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
    window.location.href = `nmap://navigation?dlat=${lat}&dlng=${lng}&dname=${encodedName}&appname=com.deliverypro.app`;
}

// ==========================================
// 2. 카카오 지도 SDK 동적 로드 (출발지 선택 지도용)
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
// 3. 시작 지점 선택 뷰 모드 전환 (리스트 <-> 지도)
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
        
        if (tabList) tabList.className = "flex-1 py-1.5 rounded-lg text-gray-500 hover:text-gray-700 transition font-bold";
        if (tabMap) tabMap.className = "flex-1 py-1.5 rounded-lg bg-white shadow text-blue-600 transition font-bold";
        
        showLoading("지도 불러오는 중...");
        await loadKakaoMapSdk();
        hideLoading();
        
        setTimeout(() => {
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
