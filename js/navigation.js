// js/navigation.js

// =================================================================
// [배송 동선 PRO] 외부 내비게이션(티맵/네이버/카카오) 및 0초 반응 초경량 레이더 지도
// =================================================================

import { state } from './state.js';

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
// 1. 외부 내비게이션 (티맵 / 네이버 / 카카오) 앱 연동
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

    const kakaoKey = "893c5c6ec8613974d84fa75fd6d0be11"; 
    window.location.href = `kakaonavi://navigate?name=${encodeURIComponent(cleanName)}&x=${lng}&y=${lat}&coord_type=wgs84&appkey=${kakaoKey}&apiver=1.0`;
}

// ==========================================
// 2. 시작 지점 선택 뷰 모드 전환 (리스트 <-> 초경량 레이더)
// ==========================================
export function switchStartSelectViewMode(mode, selectStartDestCallback) {
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
        
        if (tabList) tabList.className = "flex-1 py-1.5 rounded-lg text-slate-500 hover:text-slate-700 transition font-bold";
        if (tabMap) tabMap.className = "flex-1 py-1.5 rounded-lg bg-slate-900 text-white shadow font-bold transition";
        
        // 딜레이/로딩 없이 0.001초 만에 즉시 상대위치 렌더링
        renderStartSelectMap(selectStartDestCallback);
    } else {
        if (listContainer) listContainer.classList.remove('hidden');
        if (mapContainer) {
            mapContainer.classList.add('hidden');
            mapContainer.classList.remove('flex');
        }
        
        if (tabList) tabList.className = "flex-1 py-1.5 rounded-lg bg-slate-900 text-white shadow font-bold transition";
        if (tabMap) tabMap.className = "flex-1 py-1.5 rounded-lg text-slate-500 hover:text-slate-700 transition font-bold";
    }
}

// ==========================================
// 3. 0초 반응 초경량 상대 좌표 레이더 뷰 렌더링
// ==========================================
export function renderStartSelectMap(selectStartDestCallback) {
    const container = document.getElementById('start-select-kakao-map');
    if (!container) return;
    
    const destinations = state.getDestinations();
    if (!destinations || destinations.length === 0) {
        container.innerHTML = `<div class="w-full h-full flex items-center justify-center text-slate-400 text-xs font-bold bg-slate-50">등록된 배송지가 없습니다.</div>`;
        return;
    }

    // 위/경도 경계값 계산
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    let validCount = 0;

    destinations.forEach(d => {
        const lat = parseFloat(d.lat);
        const lng = parseFloat(d.lng);
        if (lat && lng) {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            validCount++;
        }
    });

    const lastGps = state.getLastKnownGps();
    const hasGps = lastGps && lastGps.lat && lastGps.lng;
    if (hasGps) {
        const gLat = parseFloat(lastGps.lat);
        const gLng = parseFloat(lastGps.lng);
        if (gLat < minLat) minLat = gLat;
        if (gLat > maxLat) maxLat = gLat;
        if (gLng < minLng) minLng = gLng;
        if (gLng > maxLng) maxLng = gLng;
    }

    if (validCount === 0) {
        container.innerHTML = `<div class="w-full h-full flex items-center justify-center text-slate-400 text-xs font-bold bg-slate-50">배송지 위치 좌표를 찾을 수 없습니다.</div>`;
        return;
    }

    let spanLat = maxLat - minLat;
    let spanLng = maxLng - minLng;
    if (spanLat <= 0.0002) spanLat = 0.005;
    if (spanLng <= 0.0002) spanLng = 0.005;

    // 모바일 컨테이너 크기 확인
    const width = container.clientWidth || 340;
    const height = container.clientHeight || 450;
    
    // 버튼이 화면 밖으로 잘리지 않도록 안전 여백 설정 (상하 55px, 좌우 50px)
    const padX = 50;
    const padY = 55;
    const usableW = Math.max(width - (padX * 2), 160);
    const usableH = Math.max(height - (padY * 2), 160);

    // 레이더 캔버스 HTML 생성
    let html = `
        <div class="w-full h-full relative overflow-hidden bg-slate-50 border border-slate-200 select-none">
            <!-- 가이드 격자선 (십자 방위선) -->
            <div class="absolute inset-0 pointer-events-none opacity-25">
                <div class="w-full h-px bg-slate-400 absolute top-1/2 left-0"></div>
                <div class="h-full w-px bg-slate-400 absolute top-0 left-1/2"></div>
                <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 rounded-full border border-dashed border-slate-400"></div>
            </div>

            <!-- 방위 표시기 (N 북쪽) -->
            <div class="absolute top-2.5 right-2.5 z-20 flex items-center gap-1 bg-white/90 backdrop-blur-xs px-2 py-1 rounded-md border border-slate-300 shadow-2xs text-[10px] font-black text-slate-600">
                <i class="fa-solid fa-compass text-blue-600"></i> 북(N)
            </div>

            <!-- 도움말 문구 -->
            <div class="absolute top-2.5 left-2.5 z-20 bg-white/90 backdrop-blur-xs px-2 py-1 rounded-md border border-slate-200 shadow-2xs text-[10px] font-bold text-slate-600">
                출발할 가게를 터치하세요
            </div>
    `;

    // 1) 현위치(GPS)가 있을 경우 펄스 핀 표시
    if (hasGps) {
        const gxPct = (parseFloat(lastGps.lng) - minLng) / spanLng;
        const gyPct = (maxLat - parseFloat(lastGps.lat)) / spanLat;
        const gLeft = Math.round(padX + (gxPct * usableW));
        const gTop = Math.round(padY + (gyPct * usableH));

        html += `
            <div style="position:absolute; left:${gLeft}px; top:${gTop}px; transform:translate(-50%, -50%); z-index:10;" class="pointer-events-none flex flex-col items-center">
                <div class="w-3.5 h-3.5 bg-blue-600 rounded-full border-2 border-white shadow-md animate-pulse"></div>
                <span class="text-[9px] font-extrabold text-blue-700 bg-blue-50 px-1 rounded border border-blue-200 mt-0.5 whitespace-nowrap shadow-2xs">현위치</span>
            </div>
        `;
    }

    // 2) 배송지 칩 렌더링 (번호표 제거, 오직 상호명 중심)
    destinations.forEach((dest, idx) => {
        const lat = parseFloat(dest.lat);
        const lng = parseFloat(dest.lng);
        if (!lat || !lng) return;

        const xPct = (lng - minLng) / spanLng;
        const yPct = (maxLat - lat) / spanLat; // 위도가 높을수록 북쪽(상단)
        
        const left = Math.round(padX + (xPct * usableW));
        const top = Math.round(padY + (yPct * usableH));

        const fmt = formatDisplayAddress(dest.address, dest.storeName);
        let storeLabel = fmt.storeName;
        if (!storeLabel) {
            storeLabel = fmt.cleanAddr.length > 9 ? fmt.cleanAddr.substring(0, 9) + '..' : fmt.cleanAddr;
        }

        html += `
            <button 
                onclick="window.__selectStartFromRadar(${dest.id})" 
                style="position:absolute; left:${left}px; top:${top}px; transform:translate(-50%, -50%); z-index:15;" 
                class="bg-white hover:bg-slate-50 active:bg-slate-900 active:text-white text-slate-900 border border-slate-700 px-2.5 py-1.5 rounded-xl shadow-sm text-xs font-bold whitespace-nowrap active:scale-95 transition flex items-center gap-1 cursor-pointer">
                <span class="text-blue-600 text-[10px]">🏢</span>
                <span class="tracking-tight">${storeLabel}</span>
            </button>
        `;
    });

    html += `</div>`;
    container.innerHTML = html;

    // 터치 시 출발지 선택 콜백 실행 바인딩
    window.__selectStartFromRadar = (id) => {
        if (typeof selectStartDestCallback === 'function') {
            selectStartDestCallback(id);
        }
    };
}