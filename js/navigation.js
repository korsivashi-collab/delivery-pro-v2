// js/navigation.js

// =================================================================
// [배송 동선 PRO] 외부 내비게이션(티맵/네이버/카카오) 및 초경량 지도 모듈
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
// 1. 외부 내비게이션 (티맵 / 네이버 / 카카오) 연동
// ==========================================
export function openTmap(lat, lng, name) { 
    if (!lat || !lng) {
        alert("목적지 좌표가 유효하지 않습니다.");
        return;
    }
    const cleanName = (name || '목적지').replace(/['"]/g, '').trim();
    window.location.href = `tmap://route?goalname=${encodeURIComponent(cleanName)}&goalx=${lng}&goaly=${lat}`; 
}

export function openNaverMap(lat, lng, name) {
    if (!lat || !lng) {
        alert("목적지 좌표가 유효하지 않습니다.");
        return;
    }
    const cleanName = (name || '목적지')
        .replace(/[^\w\s가-힣0-9.-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || '목적지';
        
    window.location.href = `nmap://navigation?dlat=${lat}&dlng=${lng}&dname=${encodeURIComponent(cleanName)}&appname=com.deliverypro.app`;
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
            console.warn("Kakao SDK 내비 실행 실패, 웹 스킴 대체:", e);
        }
    }

    const kakaoKey = "893c5c6ec8613974d84fa75fd6d0be11"; 
    window.location.href = `kakaonavi://navigate?name=${encodeURIComponent(cleanName)}&x=${lng}&y=${lat}&coord_type=wgs84&appkey=${kakaoKey}&apiver=1.0`;
}

// ==========================================
// 2. 카카오 지도 SDK 동적 로드 (필요 시에만 1회 로드)
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
            alert("지도 모듈 로드 실패. 네트워크 연결을 확인해 주세요.");
            resolve();
        };
        document.head.appendChild(script);
    });
}

// ==========================================
// 3. 시작 지점 선택 뷰 모드 전환 (반응성 최적화)
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
        if (tabMap) tabMap.className = "flex-1 py-1.5 rounded-lg bg-black text-white shadow font-bold transition";
        
        if (!isMapSdkLoaded) {
            showLoading("초경량 지도 로딩 중...");
            await loadKakaoMapSdk();
            hideLoading();
        }
        
        // 브라우저 렌더링 프레임에 맞춰 부드럽게 지도 크기 갱신
        requestAnimationFrame(() => {
            if (startMapInstance) {
                startMapInstance.relayout();
            }
            renderStartSelectMap(selectStartDestCallback);
        });
        
    } else {
        if (listContainer) listContainer.classList.remove('hidden');
        if (mapContainer) {
            mapContainer.classList.add('hidden');
            mapContainer.classList.remove('flex');
        }
        
        if (tabList) tabList.className = "flex-1 py-1.5 rounded-lg bg-black text-white shadow font-bold transition";
        if (tabMap) tabMap.className = "flex-1 py-1.5 rounded-lg text-gray-500 hover:text-gray-700 transition";
    }
}

// ==========================================
// 4. 초경량 반응형 지도 및 마커 렌더링 (렉/멈춤 방지)
// ==========================================
export function renderStartSelectMap(selectStartDestCallback) {
    if (!isMapSdkLoaded || !window.kakao || !window.kakao.maps) return;
    const container = document.getElementById('start-select-kakao-map');
    if (!container) return;
    
    const destinations = state.getDestinations();
    if (destinations.length === 0) return;

    // 지도 인스턴스가 없을 때 1회만 생성
    if (!startMapInstance) {
        const options = {
            center: new kakao.maps.LatLng(destinations[0].lat, destinations[0].lng),
            level: 5
        };
        startMapInstance = new kakao.maps.Map(container, options);
    } else {
        startMapInstance.relayout();
    }
    
    // 기존 마커 메모리 해제
    for (let i = 0; i < startMapMarkers.length; i++) {
        startMapMarkers[i].setMap(null);
    }
    startMapMarkers = [];
    
    const bounds = new kakao.maps.LatLngBounds();
    
    destinations.forEach((dest, index) => {
        const pos = new kakao.maps.LatLng(dest.lat, dest.lng);
        bounds.extend(pos);
        
        const fmt = formatDisplayAddress(dest.address, dest.storeName);
        const shortName = fmt.storeName || (fmt.cleanAddr.length > 7 ? fmt.cleanAddr.substring(0, 7) + '..' : fmt.cleanAddr);
        const num = dest.displayNumber || (index + 1);

        // 🌟 [초경량 DOM]: 복잡한 중첩 구조 대신 단일 칩 형태로 렌더링 (GPU 하드웨어 가속)
        const markerEl = document.createElement('div');
        markerEl.style.cssText = `
            display: inline-flex;
            align-items: center;
            background: #111827;
            color: #ffffff;
            font-size: 11px;
            font-weight: 800;
            padding: 3px 7px;
            border-radius: 9999px;
            border: 1.5px solid #ffffff;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
            white-space: nowrap;
            cursor: pointer;
            user-select: none;
            touch-action: pan-x pan-y;
            transform: translate3d(-50%, -100%, 0);
            will-change: transform;
        `;

        markerEl.innerHTML = `
            <span style="background:#2563eb; color:#fff; border-radius:50%; width:16px; height:16px; display:inline-flex; align-items:center; justify-content:center; font-size:9.5px; margin-right:4px;">${num}</span>
            <span>${shortName}</span>
        `;

        // 마커 클릭 시 출발지 지정 (지도를 터치해서 스크롤할 때는 클릭 무시)
        let isTouching = false;
        markerEl.addEventListener('touchstart', () => { isTouching = false; }, { passive: true });
        markerEl.addEventListener('touchmove', () => { isTouching = true; }, { passive: true });
        markerEl.addEventListener('touchend', (e) => {
            if (!isTouching) {
                e.preventDefault();
                if (typeof selectStartDestCallback === 'function') {
                    selectStartDestCallback(dest.id);
                }
            }
        });
        markerEl.addEventListener('click', () => {
            if (typeof selectStartDestCallback === 'function') {
                selectStartDestCallback(dest.id);
            }
        });
        
        const customOverlay = new kakao.maps.CustomOverlay({
            position: pos,
            content: markerEl,
            yAnchor: 1,
            clickable: true 
        });
        
        customOverlay.setMap(startMapInstance);
        startMapMarkers.push(customOverlay);
    });
    
    // 애니메이션 없이 즉시 최적 줌 레벨로 맞춰 모바일 끊김 현상 원천 차단
    startMapInstance.setBounds(bounds, 40, 40, 40, 40);
}