// js/admin-dispatch-territory.js

import { db } from "./admin-api.js";
import { state } from "./admin-state.js";
import { map } from "./admin-map.js";
import { getAddressFromCoords } from "./admin-utils.js";
import { doc, setDoc, updateDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// 지역(권역) 지도 관리를 위한 로컬 상태 변수
let territoryMap = null;
let territoryMarker = null;
let territoryCircles = [];
let otherTerritoryOverlays = [];
let allTerritoriesMap = null;
let allTerritoriesOverlays = [];
let isTerritoryPinMode = false; // 🌟 핀 이동 모드 기본값: OFF (지도 드래그 위주로 안전하게 시작)

// ==========================================
// 1. 실시간 위치 관제 사이드바
// ==========================================
export function renderLocationSidebar() {
    const headerEl = document.getElementById('sidebar-header');
    const contentEl = document.getElementById('sidebar-content');
    const visibleLicenses = window.getFilteredVisibleDrivers();

    headerEl.innerHTML = `
        <h2 class="text-xs font-black text-gray-700 uppercase tracking-wider flex items-center gap-1.5"><i class="fa-solid fa-tower-broadcast text-blue-600"></i> 실시간 위치 관제 (<span class="text-blue-600">${visibleLicenses.length}</span>대)</h2>
        <span class="bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded text-[10px] font-black flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span> GPS 수신중</span>
    `;

    if (visibleLicenses.length === 0) {
        contentEl.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">위치를 확인할 기사가 없습니다.</div>`; 
        return;
    }

    let html = `<div class="space-y-2.5">`;
    visibleLicenses.forEach(lic => {
        const devId = lic.deviceId || lic.key;
        const phone = lic.phone || '연락처 미등록';
        const driver = state.activeRoutes[devId];
        const driverComps = state.allCompletions.filter(c => c.deviceId === devId || (c.phone && c.phone === lic.phone)).sort((a,b) => b.completedAt - a.completedAt);
        
        let previewAddress = "최근 위치 데이터 대기중";
        let previewTime = "";
        if (driverComps.length > 0 && driverComps[0].address) {
            previewAddress = driverComps[0].address;
            previewTime = driverComps[0].timeString ? driverComps[0].timeString.split(' ')[1] : '';
        } else if (driver && driver.destinations && driver.destinations.length > 0 && driver.destinations[0].address) {
            previewAddress = driver.destinations[0].address; previewTime = "목적지";
        }

        html += `
        <div class="bg-white border border-gray-200 rounded-2xl p-3.5 shadow-xs flex flex-col gap-2.5 hover:border-blue-300 transition">
            <div class="flex items-center justify-between"><span class="font-black text-sm text-gray-900 tracking-tight flex items-center gap-1.5"><i class="fa-solid fa-phone text-blue-500 text-xs"></i> ${phone}</span><span class="text-[10px] font-mono text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">[${lic.key}]</span></div>
            <div class="bg-slate-50 border border-slate-200/70 rounded-xl p-2.5 flex items-start gap-2 text-xs">
                <i class="fa-solid fa-location-dot text-red-500 text-xs mt-0.5 shrink-0"></i>
                <div class="flex-1 min-w-0">
                    <p class="font-black text-gray-800 text-[11px] truncate leading-tight">${previewAddress}</p>
                    ${previewTime ? `<span class="text-[10px] text-gray-400 font-mono mt-0.5 block">수신: ${previewTime}</span>` : ''}
                </div>
            </div>
            <div class="grid grid-cols-2 gap-2 pt-1 border-t border-gray-100">
                <button onclick="window.focusDriverLocationOnMap('${devId}')" class="py-2 px-3 bg-blue-50 hover:bg-blue-100 text-blue-700 font-black rounded-xl text-xs flex items-center justify-center gap-1.5 transition active:scale-95 border border-blue-200 shadow-xs"><i class="fa-solid fa-crosshairs text-[11px]"></i> 위치 확인</button>
                <button onclick="window.jumpToDriverDelivery('${devId}')" class="py-2 px-3 bg-slate-900 hover:bg-slate-800 text-white font-black rounded-xl text-xs flex items-center justify-center gap-1.5 transition active:scale-95 shadow-xs"><i class="fa-solid fa-route text-[10px]"></i> 배송 관리</button>
            </div>
        </div>`;
    });
    html += `</div>`;
    contentEl.innerHTML = html;
}

export function jumpToDriverDelivery(devId) {
    window.setDispatchMode('DELIVERY');
    window.selectDriver(devId);
}

// ==========================================
// 2. 실시간 지도 위치 추적
// ==========================================
function isAllowedWorkingHours() {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    return (day >= 1 && day <= 5) && (hour >= 9 && hour < 17);
}

export async function focusDriverLocationOnMap(devId) {
    const matchedLic = state.allLicenses.find(l => l.deviceId === devId || l.key === devId);
    const phoneName = matchedLic?.phone || '기사님';

    if (!isAllowedWorkingHours()) {
        alert("[프라이버시 보호 기능]\n\n기사님의 평일(월~금) 오전 9시 ~ 오후 5시 업무 시간 외에는 실시간 위치를 추적할 수 없습니다.\n\n시스템에 저장된 마지막 확인 위치를 표시합니다.");
        showFallbackLocation(devId);
        return;
    }
    if (!map) return;
    closeCurrentLocationOverlay();

    const reqTime = Date.now();
    try { await setDoc(doc(db, "gps_requests", devId), { deviceId: devId, requestedAt: reqTime }); } catch(e) {}
    let isResolved = false;

    const unsub = onSnapshot(doc(db, "gps_reports", devId), async (snap) => {
        if (snap.exists()) {
            const data = snap.data();
            if (data.updatedAt && data.updatedAt >= reqTime) {
                isResolved = true; unsub(); 
                const lat = data.lat; const lng = data.lng;
                const pos = new kakao.maps.LatLng(lat, lng);
                map.setLevel(3); map.panTo(pos);

                const timeStr = new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const overlayContainer = document.createElement('div');
                overlayContainer.className = 'custom-location-overlay animate-pop-in';
                overlayContainer.innerHTML = `
                    <div style="transform: translate(-50%, -100%); margin-top: -15px;" class="bg-slate-900 text-white p-3.5 rounded-2xl shadow-2xl border-2 border-emerald-400 text-xs flex flex-col gap-1.5 min-w-[240px] max-w-[320px] relative z-50">
                        <div class="flex justify-between items-center pb-1.5 border-b border-slate-700">
                            <span class="font-black text-emerald-400 flex items-center gap-1.5 text-xs"><i class="fa-solid fa-satellite-dish animate-pulse text-emerald-400"></i> 실시간 위치 수신됨</span>
                            <span class="text-[10px] text-gray-400 font-mono">${timeStr}</span>
                        </div>
                        <div id="loc-overlay-addr" class="font-black text-gray-100 text-[13px] leading-snug py-0.5 break-keep"><i class="fa-solid fa-circle-notch fa-spin mr-1 text-emerald-400"></i>주소 확인 중...</div>
                        <div class="flex justify-between items-center pt-1.5 border-t border-slate-800 text-[11px]"><span class="font-bold text-gray-300"><i class="fa-solid fa-phone text-emerald-400 mr-1"></i>${phoneName}</span><button onclick="window.closeCurrentLocationOverlay()" class="text-gray-400 hover:text-white px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-bold transition active:scale-95">닫기</button></div>
                        <div class="absolute left-1/2 -bottom-2 -translate-x-1/2 w-0 h-0 border-x-8 border-x-transparent border-t-8 border-t-emerald-400"></div>
                    </div>`;
                window.currentLocationOverlay = new kakao.maps.CustomOverlay({ position: pos, content: overlayContainer, zIndex: 100 });
                window.currentLocationOverlay.setMap(map); 
                if (window.myMapOverlays) window.myMapOverlays.push(window.currentLocationOverlay);

                const resolvedAddr = await getAddressFromCoords(lat, lng);
                const finalAddr = resolvedAddr || "주소 정보를 변환할 수 없습니다.";
                const addrEl = document.getElementById('loc-overlay-addr');
                if (addrEl) addrEl.innerHTML = `<i class="fa-solid fa-map-pin text-emerald-400 mr-1 text-xs"></i>${finalAddr}`;
            }
        }
    });

    setTimeout(() => {
        if (!isResolved) {
            unsub(); alert(`[안내] 실시간 위치 응답을 받지 못했습니다.\n(앱 미실행, 통신 불량 등)\n\n시스템에 저장된 최근 마지막 위치를 표시합니다.`);
            showFallbackLocation(devId);
        }
    }, 7000);
}

export async function showFallbackLocation(devId) {
    const matchedLic = state.allLicenses.find(l => l.deviceId === devId || l.key === devId);
    const driver = state.activeRoutes[devId];
    let lat = null, lng = null, timeStr = '마지막 수신', knownAddress = null;

    const driverComps = state.allCompletions.filter(c => c.deviceId === devId || (c.phone && c.phone === matchedLic?.phone)).sort((a,b) => b.completedAt - a.completedAt);
    if (driverComps.length > 0 && driverComps[0].lat) {
        lat = driverComps[0].lat; lng = driverComps[0].lng; knownAddress = driverComps[0].address;
        timeStr = driverComps[0].timeString || (new Date(driverComps[0].completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } else if (driver && driver.destinations && driver.destinations.length > 0 && driver.destinations[0].lat) {
        lat = driver.destinations[0].lat; lng = driver.destinations[0].lng; knownAddress = driver.destinations[0].address; timeStr = '배송 목적지';
    }

    if (!lat || !lng || !map) { alert("해당 기사의 위치나 동선 데이터가 전혀 없습니다."); return; }
    const pos = new kakao.maps.LatLng(lat, lng); map.setLevel(3); map.panTo(pos);
    if (window.currentLocationOverlay) { window.currentLocationOverlay.setMap(null); window.currentLocationOverlay = null; }

    const phone = matchedLic?.phone || driver?.phone || '기사';
    const overlayContainer = document.createElement('div');
    overlayContainer.className = 'custom-location-overlay animate-pop-in';
    overlayContainer.innerHTML = `
        <div style="transform: translate(-50%, -100%); margin-top: -15px;" class="bg-slate-900 text-white p-3.5 rounded-2xl shadow-2xl border-2 border-sky-400 text-xs flex flex-col gap-1.5 min-w-[240px] max-w-[320px] relative z-50">
            <div class="flex justify-between items-center pb-1.5 border-b border-slate-700"><span class="font-black text-sky-400 flex items-center gap-1.5 text-xs"><i class="fa-solid fa-location-dot text-sky-400"></i> 기사 최근 위치</span><span class="text-[10px] text-gray-400 font-mono">${timeStr}</span></div>
            <div id="loc-overlay-addr" class="font-black text-gray-100 text-[13px] leading-snug py-0.5 break-keep"><i class="fa-solid fa-circle-notch fa-spin mr-1 text-sky-400"></i>주소 확인 중...</div>
            <div class="flex justify-between items-center pt-1.5 border-t border-slate-800 text-[11px]"><span class="font-bold text-gray-300"><i class="fa-solid fa-phone text-sky-400 mr-1"></i>${phone}</span><button onclick="window.closeCurrentLocationOverlay()" class="text-gray-400 hover:text-white px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-bold transition active:scale-95">닫기</button></div>
            <div class="absolute left-1/2 -bottom-2 -translate-x-1/2 w-0 h-0 border-x-8 border-x-transparent border-t-8 border-t-sky-400"></div>
        </div>`;
    window.currentLocationOverlay = new kakao.maps.CustomOverlay({ position: pos, content: overlayContainer, zIndex: 100 });
    window.currentLocationOverlay.setMap(map); 
    if (window.myMapOverlays) window.myMapOverlays.push(window.currentLocationOverlay);

    const resolvedAddr = await getAddressFromCoords(lat, lng);
    const finalAddr = resolvedAddr || knownAddress || "주소 정보를 변환할 수 없습니다.";
    const addrEl = document.getElementById('loc-overlay-addr');
    if (addrEl) addrEl.innerHTML = `<i class="fa-solid fa-map-pin text-sky-400 mr-1 text-xs"></i>${finalAddr}`;
}

export function closeCurrentLocationOverlay() {
    if (window.currentLocationOverlay) { 
        window.currentLocationOverlay.setMap(null); 
        window.currentLocationOverlay = null; 
    }
}

export function drawAllDriversOnMap() {
    if (window.forceClearMap) window.forceClearMap();
    if (!map) return;
    const visibleLicenses = window.getFilteredVisibleDrivers();
    const bounds = new kakao.maps.LatLngBounds();
    let hasPoints = false;
    
    visibleLicenses.forEach(lic => {
        const devId = lic.deviceId || lic.key; 
        const driver = state.activeRoutes[devId];
        let pos = null;
        const driverComps = state.allCompletions.filter(c => c.deviceId === devId || (c.phone && c.phone === lic.phone)).sort((a,b) => b.completedAt - a.completedAt);
        
        if (driverComps.length > 0 && driverComps[0].lat) pos = new kakao.maps.LatLng(driverComps[0].lat, driverComps[0].lng);
        else if (driver && driver.destinations && driver.destinations.length > 0 && driver.destinations[0].lat) pos = new kakao.maps.LatLng(driver.destinations[0].lat, driver.destinations[0].lng);
        
        if (pos) {
            bounds.extend(pos); hasPoints = true;
            const content = document.createElement('div'); content.className = 'driver-pin';
            content.innerHTML = `<i class="fa-solid fa-truck text-sky-400 text-xs"></i><span>${lic.phone || '기사'}</span>`;
            content.onclick = () => { window.jumpToDriverDelivery(devId); };
            const overlay = new kakao.maps.CustomOverlay({ position: pos, content: content, yAnchor: 1.3, zIndex: 30 });
            overlay.setMap(map); 
            if (window.myMapOverlays) window.myMapOverlays.push(overlay);
        }
    });
    if (hasPoints) map.setBounds(bounds);
}

export function fitMapToAllDrivers() { drawAllDriversOnMap(); }

// ==========================================
// 3. 기사 권역(Territory) 설정 모달 (지도 및 검색)
// ==========================================

// 🌟 핀 이동 모드 토글 (아이콘 클릭 시 UI 및 드래그 권한 교차 적용)
export function toggleTerritoryPinMode() {
    isTerritoryPinMode = !isTerritoryPinMode;
    const btn = document.getElementById('btn-territory-pin');
    
    if (btn) {
        if (isTerritoryPinMode) {
            // ON: 핀 드래그 가능, 지도 이동 불가, 텍스트와 UI 넓히기
            btn.className = "px-4 py-2 rounded-xl bg-blue-600 text-white flex items-center justify-center gap-2 shadow-md transition active:scale-95 font-black text-sm";
            btn.innerHTML = '<i class="fa-solid fa-map-pin"></i> 핀 이동 ON';
        } else {
            // OFF: 지도 드래그 가능, 핀 고정
            btn.className = "px-4 py-2 rounded-xl bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 flex items-center justify-center gap-2 shadow-sm transition active:scale-95 font-black text-sm";
            btn.innerHTML = '<i class="fa-solid fa-map-pin text-gray-400"></i> 핀 이동 OFF';
        }
    }

    // 지도 드래그 제어 (ON 이면 지도 이동 불가)
    if (territoryMap) {
        territoryMap.setDraggable(!isTerritoryPinMode);
    }
    // 마커 드래그 제어 (ON 이면 핀 이동 가능)
    if (territoryMarker) {
        territoryMarker.setDraggable(isTerritoryPinMode);
    }
}

// 🌟 주소 검색 및 해당 위치로 지도/핀 강제 이동
export function searchTerritoryAddress() {
    const inputEl = document.getElementById('territory-address-search');
    const query = inputEl ? inputEl.value.trim() : '';
    
    if (!query) { 
        alert("검색할 주소를 입력해 주세요."); 
        inputEl?.focus();
        return; 
    }

    if (window.kakao && kakao.maps && kakao.maps.services) {
        const geocoder = new kakao.maps.services.Geocoder();
        geocoder.addressSearch(query, (result, status) => {
            if (status === kakao.maps.services.Status.OK && result[0]) {
                const pos = new kakao.maps.LatLng(parseFloat(result[0].y), parseFloat(result[0].x));
                territoryMap.setCenter(pos);
                setTerritoryCenter(pos); // 검색한 주소 위치로 핀 강제 이동
            } else {
                alert("주소를 찾을 수 없습니다. 정확한 도로명이나 지번 주소를 다시 입력해 주세요.");
            }
        });
    } else {
        alert("지도 API가 아직 로드되지 않았습니다.");
    }
}

export function openDriverTerritoryModal(devId, phone, lat, lng, scale) {
    try { if (window.event) window.event.stopPropagation(); } catch(e) {}
    document.getElementById('territory-target-devid').value = devId;
    document.getElementById('territory-target-phone').innerText = phone;
    
    // 🌟 모달창 열 때 UI 상태 초기화 (검색어 비우기, 핀 이동 모드 무조건 OFF 상태로 시작)
    const searchInput = document.getElementById('territory-address-search');
    if (searchInput) searchInput.value = '';
    
    isTerritoryPinMode = false;
    const pinBtn = document.getElementById('btn-territory-pin');
    if (pinBtn) {
        pinBtn.className = "px-4 py-2 rounded-xl bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 flex items-center justify-center gap-2 shadow-sm transition active:scale-95 font-black text-sm";
        pinBtn.innerHTML = '<i class="fa-solid fa-map-pin text-gray-400"></i> 핀 이동 OFF';
    }

    const modal = document.getElementById('driver-territory-modal');
    if(!modal) return; modal.classList.remove('hidden');
    
    state.currentTerritoryScale = (scale && scale !== 'undefined' && scale !== '') ? scale : 'dong';
    setTerritoryScale(state.currentTerritoryScale, true); 

    setTimeout(() => {
        const container = document.getElementById('territory-map-container');
        if (!territoryMap) {
            territoryMap = new kakao.maps.Map(container, { center: new kakao.maps.LatLng(37.566826, 126.978656), level: 6 });
            
            // 🌟 지도를 클릭했을 때, '핀 이동 모드'가 켜져 있을 때만 핀을 새로운 곳으로 이동시킴
            kakao.maps.event.addListener(territoryMap, 'click', function(mouseEvent) { 
                if (isTerritoryPinMode) {
                    setTerritoryCenter(mouseEvent.latLng); 
                }
            });
        }
        
        // 처음 모달을 열 때는 지도는 움직일 수 있게 (OFF 상태)
        territoryMap.setDraggable(true); 
        territoryMap.relayout(); 
        
        if (territoryMarker) territoryMarker.setMap(null);
        territoryCircles.forEach(c => c.setMap(null)); territoryCircles = [];
        otherTerritoryOverlays.forEach(ov => ov.setMap(null)); otherTerritoryOverlays = [];

        let centerPos = new kakao.maps.LatLng(37.566826, 126.978656);

        if (lat && lng && lat !== 'undefined' && lng !== 'undefined' && lat !== '' && lng !== '') {
            centerPos = new kakao.maps.LatLng(parseFloat(lat), parseFloat(lng));
            territoryMap.setCenter(centerPos); 
            setTerritoryCenter(centerPos);
        } else {
            const savedBase = localStorage.getItem('deliveryProCompanyBase');
            if (savedBase) {
                const baseData = JSON.parse(savedBase);
                if (baseData.lat && baseData.lng) {
                    centerPos = new kakao.maps.LatLng(baseData.lat, baseData.lng);
                    territoryMap.setCenter(centerPos);
                }
            } else {
                territoryMap.setCenter(centerPos);
            }
            const addrDisplayEl = document.getElementById('territory-selected-address');
            if(addrDisplayEl) addrDisplayEl.innerHTML = `<i class="fa-solid fa-location-crosshairs text-gray-400 mr-1"></i> 지도에 핀을 찍어주세요`;
        }
        
        const allDrivers = window.getFilteredVisibleDrivers();
        allDrivers.forEach(d => {
            const dId = d.deviceId || d.key;
            if (dId === devId) return; 
            if (d.territoryLat && d.territoryLng) {
                const pos = new kakao.maps.LatLng(d.territoryLat, d.territoryLng);
                const marker = new kakao.maps.Marker({ position: pos, image: new kakao.maps.MarkerImage('https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/markerStar.png', new kakao.maps.Size(24, 35)) });
                marker.setMap(territoryMap); otherTerritoryOverlays.push(marker);
                const label = new kakao.maps.CustomOverlay({ position: pos, content: `<div class="bg-gray-800 text-white text-[10px] px-2 py-0.5 rounded shadow-sm font-bold mb-8">${d.phone || d.key}</div>`, yAnchor: 1 });
                label.setMap(territoryMap); otherTerritoryOverlays.push(label);
                let r3 = 5000; if (d.territoryScale === 'gu') r3 = 15000; else if (d.territoryScale === 'si') r3 = 45000;
                const circle = new kakao.maps.Circle({ center: pos, radius: r3, strokeWeight: 1, strokeColor: '#9ca3af', strokeOpacity: 0.6, fillColor: '#d1d5db', fillOpacity: 0.2 });
                circle.setMap(territoryMap); otherTerritoryOverlays.push(circle);
            }
        });

        // 🌟 모달 렌더링 애니메이션 딜레이로 인해 핀이 우측으로 밀리는 카카오맵 버그 해결
        setTimeout(() => { 
            if (territoryMap) {
                territoryMap.relayout(); 
                // relayout 직후에 저장해둔 중앙 좌표(또는 핀 위치)로 지도를 강제 재정렬
                territoryMap.setCenter(territoryMarker ? territoryMarker.getPosition() : centerPos);
            }
        }, 300);
    }, 200);
}

export function closeDriverTerritoryModal() { document.getElementById('driver-territory-modal')?.classList.add('hidden'); }

export function setTerritoryScale(scale, skipRedraw = false) {
    state.currentTerritoryScale = scale;
    const scaleInput = document.getElementById('input-territory-scale');
    if(scaleInput) scaleInput.value = scale;

    ['dong', 'gu', 'si'].forEach(s => {
        const btn = document.getElementById(`btn-scale-${s}`);
        if (!btn) return;
        if (s === scale) btn.className = "px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-black shadow-sm transition active:scale-95";
        else btn.className = "px-4 py-2 rounded-lg text-gray-600 hover:bg-gray-100 text-xs font-black transition active:scale-95";
    });

    if (territoryMap) {
        if (scale === 'dong') territoryMap.setLevel(7); 
        else if (scale === 'gu') territoryMap.setLevel(9); 
        else if (scale === 'si') territoryMap.setLevel(11); 
    }
    if (!skipRedraw && territoryMarker) setTerritoryCenter(territoryMarker.getPosition());
}

export function setTerritoryCenter(latLng) {
    if (territoryMarker) territoryMarker.setMap(null);
    territoryCircles.forEach(c => c.setMap(null)); territoryCircles = [];

    document.getElementById('input-territory-lat').value = latLng.getLat();
    document.getElementById('input-territory-lng').value = latLng.getLng();

    const geocoder = new kakao.maps.services.Geocoder();
    geocoder.coord2Address(latLng.getLng(), latLng.getLat(), function(result, status) {
        let displayAddr = "주소를 찾을 수 없는 지역입니다";
        if (status === kakao.maps.services.Status.OK) {
            let fullAddress = result[0].address.address_name;
            if (result[0].road_address) fullAddress = result[0].road_address.address_name;
            document.getElementById('input-territory-1').value = fullAddress; 
            document.getElementById('input-territory-2').value = ''; 
            displayAddr = fullAddress;
        }
        const addrDisplayEl = document.getElementById('territory-selected-address');
        if(addrDisplayEl) addrDisplayEl.innerHTML = `<i class="fa-solid fa-location-dot text-red-500 mr-1"></i> ${displayAddr}`;
    });

    // 🌟 마커 생성 시 현재 isTerritoryPinMode 에 맞춰 마커 드래그 속성 주입
    territoryMarker = new kakao.maps.Marker({ 
        position: latLng,
        draggable: isTerritoryPinMode 
    });
    territoryMarker.setMap(territoryMap);

    // 🌟 마커를 마우스로 직접 잡고 드래그(움직임) 완료 시, 원(반경) 범위도 함께 이동하도록 연결
    kakao.maps.event.addListener(territoryMarker, 'dragend', function() {
        setTerritoryCenter(territoryMarker.getPosition());
    });

    let r1, r2, r3;
    if (state.currentTerritoryScale === 'dong') { r1 = 1500; r2 = 3000; r3 = 5000; } 
    else if (state.currentTerritoryScale === 'gu') { r1 = 5000; r2 = 10000; r3 = 15000; } 
    else if (state.currentTerritoryScale === 'si') { r1 = 15000; r2 = 30000; r3 = 45000; }

    const c1 = new kakao.maps.Circle({ center: latLng, radius: r1, strokeWeight: 2, strokeColor: '#2563eb', strokeOpacity: 0.8, fillColor: '#3b82f6', fillOpacity: 0.5 });
    const c2 = new kakao.maps.Circle({ center: latLng, radius: r2, strokeWeight: 1, strokeColor: '#3b82f6', strokeOpacity: 0.6, fillColor: '#60a5fa', fillOpacity: 0.25 });
    const c3 = new kakao.maps.Circle({ center: latLng, radius: r3, strokeWeight: 1, strokeColor: '#93c5fd', strokeOpacity: 0.4, fillColor: '#bfdbfe', fillOpacity: 0.1 });

    c3.setMap(territoryMap); c2.setMap(territoryMap); c1.setMap(territoryMap);
    territoryCircles = [c3, c2, c1];
}

export async function saveDriverTerritory() {
    const devId = document.getElementById('territory-target-devid').value;
    const lat = document.getElementById('input-territory-lat').value;
    const lng = document.getElementById('input-territory-lng').value;
    const scale = document.getElementById('input-territory-scale').value;
    const t1 = document.getElementById('input-territory-1').value || '상세 주소 확인 불가'; 
    const t2 = document.getElementById('input-territory-2').value || '';

    if (!lat || !lng) { alert("지도에 핀을 찍어 배송 권역의 중심을 설정해주세요."); return; }

    const targetLic = state.allLicenses.find(l => l.deviceId === devId || l.key === devId);
    if (!targetLic) return;

    try {
        await updateDoc(doc(db, "licenses", targetLic.key), {
            territoryLat: parseFloat(lat), territoryLng: parseFloat(lng),
            territoryScale: scale, territory1: t1, territory2: t2
        });
        alert("기사 권역이 저장되었습니다.");
        closeDriverTerritoryModal();
        if (window.renderDispatchDriverList) window.renderDispatchDriverList();
    } catch(e) { alert("저장 오류: " + e.message); }
}

export function openAllTerritoriesMap() {
    const modal = document.getElementById('all-territories-modal');
    if (!modal) return; modal.classList.remove('hidden');

    setTimeout(() => {
        const container = document.getElementById('all-territories-map-container');
        if (!allTerritoriesMap) { 
            allTerritoriesMap = new kakao.maps.Map(container, { center: new kakao.maps.LatLng(37.566826, 126.978656), level: 8 }); 
        }
        allTerritoriesMap.relayout();
        allTerritoriesOverlays.forEach(ov => ov.setMap(null)); allTerritoriesOverlays = [];

        const allDrivers = window.getFilteredVisibleDrivers();
        let bounds = new kakao.maps.LatLngBounds();
        let hasValidPoint = false;

        allDrivers.forEach(d => {
            if (d.territoryLat && d.territoryLng) {
                hasValidPoint = true;
                const pos = new kakao.maps.LatLng(d.territoryLat, d.territoryLng);
                bounds.extend(pos);

                const marker = new kakao.maps.Marker({ position: pos });
                marker.setMap(allTerritoriesMap); allTerritoriesOverlays.push(marker);

                const label = new kakao.maps.CustomOverlay({ position: pos, content: `<div class="bg-blue-600 text-white text-[11px] px-2 py-0.5 rounded shadow-sm font-black mb-8">${d.phone || d.key}</div>`, yAnchor: 1 });
                label.setMap(allTerritoriesMap); allTerritoriesOverlays.push(label);

                let r1, r2, r3; const scale = d.territoryScale || 'dong';
                if (scale === 'dong') { r1 = 1500; r2 = 3000; r3 = 5000; } 
                else if (scale === 'gu') { r1 = 5000; r2 = 10000; r3 = 15000; } 
                else if (scale === 'si') { r1 = 15000; r2 = 30000; r3 = 45000; }

                const c1 = new kakao.maps.Circle({ center: pos, radius: r1, strokeWeight: 2, strokeColor: '#2563eb', strokeOpacity: 0.8, fillColor: '#3b82f6', fillOpacity: 0.3 });
                const c2 = new kakao.maps.Circle({ center: pos, radius: r2, strokeWeight: 1, strokeColor: '#3b82f6', strokeOpacity: 0.6, fillColor: '#60a5fa', fillOpacity: 0.15 });
                const c3 = new kakao.maps.Circle({ center: pos, radius: r3, strokeWeight: 1, strokeColor: '#93c5fd', strokeOpacity: 0.4, fillColor: '#bfdbfe', fillOpacity: 0.05 });

                c3.setMap(allTerritoriesMap); c2.setMap(allTerritoriesMap); c1.setMap(allTerritoriesMap);
                allTerritoriesOverlays.push(c3, c2, c1);
            }
        });

        if (hasValidPoint) allTerritoriesMap.setBounds(bounds);
        else {
            const savedBase = localStorage.getItem('deliveryProCompanyBase');
            if (savedBase) { 
                const baseData = JSON.parse(savedBase); 
                if (baseData.lat && baseData.lng) allTerritoriesMap.setCenter(new kakao.maps.LatLng(baseData.lat, baseData.lng)); 
            }
        }
    }, 200);
}

export function closeAllTerritoriesMap() { document.getElementById('all-territories-modal')?.classList.add('hidden'); }

// 🌟 추가된 함수들을 window 객체에 맵핑
window.toggleTerritoryPinMode = toggleTerritoryPinMode;
window.searchTerritoryAddress = searchTerritoryAddress;