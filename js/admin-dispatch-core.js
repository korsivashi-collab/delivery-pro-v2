// js/admin-dispatch-core.js

import { db } from "./admin-api.js";
import { state, getLocalDateString, todayStr } from "./admin-state.js";
import { map } from "./admin-map.js";
import { doc, updateDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

export function formatNumber(num) {
    if (!num || isNaN(num)) return num || ''; 
    return Number(num).toLocaleString('ko-KR');
}

export function forceClearMap() {
    if (window.myMapOverlays) window.myMapOverlays.forEach(ov => ov.setMap(null));
    window.myMapOverlays = [];
    if (window.mapPlannedPolyline) { window.mapPlannedPolyline.setMap(null); window.mapPlannedPolyline = null; }
    if (window.mapCompletedPolyline) { window.mapCompletedPolyline.setMap(null); window.mapCompletedPolyline = null; }
    if (window.currentLocationOverlay) { window.currentLocationOverlay.setMap(null); window.currentLocationOverlay = null; }
}

export function getFilteredVisibleDrivers() {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const isMaster = (sessionStorage.getItem('deliveryProRole') === 'MASTER');
    let visibleLicenses = state.allLicenses.filter(l => l.type !== 'dispatch');
    if (!isMaster && dispatchKey) {
        visibleLicenses = visibleLicenses.filter(l => l.dispatchKey === dispatchKey);
    }
    return visibleLicenses;
}

// ==========================================
// 1. 관제 메인 네비게이션 및 사이드바 제어
// ==========================================
export function setDispatchMode(mode, keepSelected = false) {
    state.dispatchNavState = mode; 
    if (!keepSelected && mode === 'DELIVERY') state.selectedDeviceId = null;
    
    ['DELIVERY', 'MESSAGE', 'LOCATION'].forEach(m => {
        const btn = document.getElementById(`nav-btn-${m}`);
        if (btn) btn.className = (m === mode) ? "px-3 py-1.5 rounded-lg text-xs font-black bg-blue-600 text-white shadow-sm transition flex items-center gap-1.5" : "px-3 py-1.5 rounded-lg text-xs font-black text-gray-500 hover:text-gray-900 hover:bg-white transition flex items-center gap-1.5";
    });

    const mapSec = document.getElementById('map-section');
    const msgSec = document.getElementById('message-section');
    const dateBar = document.getElementById('sidebar-date-bar');
    const filterControls = document.getElementById('map-filter-controls');
    const fitAllBtn = document.getElementById('btn-fit-all-drivers');

    if (mode === 'MESSAGE') {
        if (mapSec) mapSec.classList.add('hidden');
        if (msgSec) msgSec.classList.remove('hidden');
        if (dateBar) dateBar.classList.add('hidden');
    } else {
        if (msgSec) msgSec.classList.add('hidden');
        if (mapSec) mapSec.classList.remove('hidden');
        if (dateBar) dateBar.classList.remove('hidden');
        setTimeout(() => { if (map) map.relayout(); }, 100);
    }

    forceClearMap();

    if (mode === 'LOCATION') {
        if (filterControls) filterControls.classList.add('hidden');
        if (fitAllBtn) fitAllBtn.classList.remove('hidden');
        if (window.drawAllDriversOnMap) window.drawAllDriversOnMap();
    } else if (mode === 'DELIVERY') {
        if (filterControls) filterControls.classList.remove('hidden');
        if (fitAllBtn) fitAllBtn.classList.add('hidden');
        if (state.selectedDeviceId) drawDriverOnMap(state.selectedDeviceId);
    }
    renderSidebar();
}

export function renderSidebar() {
    updateProButtonsUI();

    if (state.dispatchNavState === 'DELIVERY') {
        if (state.selectedDeviceId) renderDriverDetailView(state.selectedDeviceId);
        else renderDriverListView();
    } else if (state.dispatchNavState === 'MESSAGE') {
        if (window.renderMessageSidebar) window.renderMessageSidebar();
    } else if (state.dispatchNavState === 'LOCATION') {
        if (window.renderLocationSidebar) window.renderLocationSidebar();
    }
}

// ==========================================
// 2. 배송 관리 모드 - 기사 목록 및 상세 뷰
// ==========================================
export function renderDriverListView() {
    const headerEl = document.getElementById('sidebar-header');
    const contentEl = document.getElementById('sidebar-content');
    const visibleLicenses = getFilteredVisibleDrivers();

    headerEl.innerHTML = `
        <h2 class="text-xs font-black text-gray-700 uppercase tracking-wider flex items-center gap-1.5"><i class="fa-solid fa-truck text-blue-600"></i> 운행 기사 (<span id="driver-count">${visibleLicenses.length}</span>명)</h2>
        <button onclick="window.openLinkDriverModal()" id="btn-add-driver" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-black px-3 py-1.5 rounded-xl transition flex items-center gap-1 shadow-sm active:scale-95"><i class="fa-solid fa-user-plus"></i> 기사 등록</button>
    `;

    if (visibleLicenses.length === 0) {
        contentEl.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">연결된 운행 기사가 없습니다. [+ 기사 등록]을 눌러 기사를 추가하세요.</div>`; return;
    }

    const selectedDate = document.getElementById('dispatch-date-picker').value || todayStr;
    const dotDate = selectedDate.replace(/-/g, '.');
    const isToday = (selectedDate === todayStr);

    let html = '';
    visibleLicenses.forEach(lic => {
        const devId = lic.deviceId || lic.key;
        const phone = lic.phone || '연락처 미등록';
        
        const routeData = (lic.deviceId && state.activeRoutes[lic.deviceId]) ? state.activeRoutes[lic.deviceId] : null;
        let driverRoute = null;
        if (routeData && routeData.updatedAt) {
            const routeDateStr = getLocalDateString(new Date(routeData.updatedAt));
            if (isToday || routeDateStr === selectedDate) driverRoute = routeData;
        }
        const rawDests = driverRoute ? driverRoute.destinations || [] : [];

        const driverDone = state.allCompletions.filter(c => {
            const matchesDev = (lic.deviceId && c.deviceId === lic.deviceId) || (lic.phone && c.phone === lic.phone);
            const matchesDate = (c.timeString && c.timeString.startsWith(dotDate)) || 
                                (c.completedAt && getLocalDateString(new Date(c.completedAt)) === selectedDate);
            return matchesDev && matchesDate;
        });

        const doneMap = {}; driverDone.forEach(c => { doneMap[c.address] = c; });
        const remainingDests = rawDests.filter(d => !doneMap[d.address]);
        
        const pendingCount = isToday ? remainingDests.length : 0;
        const doneCount = driverDone.length;
        const totalCount = isToday ? (pendingCount + doneCount) : doneCount;
        const rate = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : (doneCount > 0 ? 100 : 0);

        html += `
        <div onclick="window.selectDriver('${devId}')" class="cursor-pointer p-3.5 rounded-2xl border bg-white hover:bg-blue-50/50 hover:border-blue-400 border-gray-200 shadow-sm transition relative mb-2">
            <div class="flex justify-between items-center mb-1.5">
                <span class="font-black text-sm text-gray-900 tracking-tight flex items-center gap-1.5"><i class="fa-solid fa-phone text-blue-500 text-xs"></i>${phone}<span class="text-[10px] text-gray-400 font-mono font-normal">[${lic.key}]</span></span>
                <div class="flex items-center gap-1.5"><span class="text-xs font-black px-2 py-0.5 rounded-full ${rate === 100 ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}">${rate}%</span><button onclick="event.stopPropagation(); window.removeOrUnlinkDriver('${devId}', '${lic.key}')" class="text-[10px] text-gray-400 hover:text-red-600 bg-gray-100 hover:bg-red-50 border border-gray-200 px-2 py-0.5 rounded-md font-bold transition">연결해제</button></div>
            </div>
            <div class="w-full bg-gray-100 rounded-full h-1.5 mb-2.5 overflow-hidden"><div class="bg-blue-600 h-1.5 rounded-full transition-all duration-500" style="width: ${rate}%"></div></div>
            <div class="flex justify-between text-[11px] font-bold text-gray-600"><span>잔여: <b class="text-blue-600 font-black text-xs">${pendingCount}</b>건</span><span>완료: <b class="text-emerald-600 font-black text-xs">${doneCount}</b>건</span></div>
        </div>`;
    });
    contentEl.innerHTML = html;
}

export function setDispatchDetailTab(tab) {
    state.dispatchDetailTab = tab; 
    if (state.selectedDeviceId) renderDriverDetailView(state.selectedDeviceId);
}

export function renderDriverDetailView(devId) {
    const headerEl = document.getElementById('sidebar-header');
    const contentEl = document.getElementById('sidebar-content');
    const matchedLic = state.allLicenses.find(l => l.deviceId === devId || l.key === devId);
    const driver = state.activeRoutes[devId] || null;
    const phone = driver?.phone || matchedLic?.phone || '기사';

    headerEl.innerHTML = `
        <div class="flex items-center justify-between w-full">
            <button onclick="window.clearSelectedDriver()" class="text-xs font-black text-blue-600 hover:bg-blue-50 px-2.5 py-1.5 rounded-xl transition flex items-center gap-1 border border-blue-200"><i class="fa-solid fa-arrow-left"></i> 기사 목록</button>
            <span class="text-xs font-black text-gray-900 bg-white border border-gray-200 shadow-sm px-3 py-1.5 rounded-xl truncate"><i class="fa-solid fa-phone text-blue-500 mr-1 text-[11px]"></i>${phone}</span>
        </div>
    `;

    const selectedDate = document.getElementById('dispatch-date-picker').value || todayStr;
    const dotDate = selectedDate.replace(/-/g, '.');
    const isToday = (selectedDate === todayStr);

    let driverRoute = null;
    if (driver && driver.updatedAt) {
        const routeDateStr = getLocalDateString(new Date(driver.updatedAt));
        if (isToday || routeDateStr === selectedDate) driverRoute = driver;
    }
    const rawDests = driverRoute ? (driverRoute.destinations || []) : [];

    const driverDone = state.allCompletions.filter(c => {
        const matchesDev = (c.deviceId === devId || (matchedLic && c.phone === matchedLic.phone));
        const matchesDate = (c.timeString && c.timeString.startsWith(dotDate)) || 
                            (c.completedAt && getLocalDateString(new Date(c.completedAt)) === selectedDate);
        return matchesDev && matchesDate;
    }).sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));

    const doneMap = {}; driverDone.forEach(c => { doneMap[c.address] = c; });
    const remainingDests = rawDests.filter(d => !doneMap[d.address]);

    const pendingCount = isToday ? remainingDests.length : 0;
    const doneCount = driverDone.length;
    const totalCount = isToday ? (pendingCount + doneCount) : doneCount;
    const rate = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;	

    let html = `
    <div class="bg-blue-50 border border-blue-200 rounded-2xl p-3.5 shadow-inner mb-3 text-xs">
        <div class="flex justify-between items-center mb-1.5 text-blue-950 font-black">
            <span class="flex items-center gap-1.5"><i class="fa-solid fa-chart-pie text-blue-600"></i> 배송 진척도</span>
            <span>완료 ${doneCount} / 전체 ${totalCount} 건 (${rate}%)</span>
        </div>
        <div class="w-full bg-white rounded-full h-2 overflow-hidden mb-2">
            <div class="bg-blue-600 h-2 rounded-full transition-all duration-500" style="width: ${rate}%"></div>
        </div>
        <div class="flex justify-between text-[11px] font-bold text-blue-800">
            <span>미배송 대기: <b class="text-blue-600 font-black">${pendingCount}</b>곳</span>
            <span>완료율: <b class="text-emerald-600 font-black">${rate}%</b></span>
        </div>
    </div>

    <div class="flex gap-1 mb-3 bg-gray-100 p-1 rounded-xl text-xs font-black">
        <button onclick="window.setDispatchDetailTab('ROUTE')" class="flex-1 py-2 rounded-lg transition ${state.dispatchDetailTab === 'ROUTE' ? 'bg-blue-600 text-white shadow-xs' : 'text-gray-600 hover:text-gray-900'}">
            <i class="fa-solid fa-route mr-1"></i> 동선 (${totalCount})
        </button>
        <button onclick="window.setDispatchDetailTab('PENDING')" class="flex-1 py-2 rounded-lg transition ${state.dispatchDetailTab === 'PENDING' ? 'bg-amber-600 text-white shadow-xs' : 'text-gray-600 hover:text-gray-900'}">
            <i class="fa-solid fa-clock mr-1"></i> 미처리 (${pendingCount})
        </button>
        <button onclick="window.setDispatchDetailTab('DONE')" class="flex-1 py-2 rounded-lg transition ${state.dispatchDetailTab === 'DONE' ? 'bg-emerald-600 text-white shadow-xs' : 'text-gray-600 hover:text-gray-900'}">
            <i class="fa-solid fa-circle-check mr-1"></i> 완료 (${doneCount})
        </button>
    </div>`;

    if (state.dispatchDetailTab === 'ROUTE') {
        if (rawDests.length === 0) {
            html += `<div class="text-center text-gray-400 py-16 text-xs font-bold space-y-1"><i class="fa-solid fa-route text-2xl text-gray-300 mb-1"></i><p>선택하신 날짜의 대기 중인 배송 동선이 없습니다.</p><p class="text-[11px] font-normal text-gray-400">과거 내역은 '배송 완료' 탭에서 확인해 주세요.</p></div>`;
        } else {
            html += `<div class="space-y-1.5 pb-4">`;
            rawDests.forEach((d, idx) => {
                const comp = doneMap[d.address];
                const isDone = !!comp;
                const num = d.displayNumber || (idx + 1);
                let numberBadge = isDone ? `<span class="w-5 h-5 bg-emerald-600 text-white rounded-full flex items-center justify-center font-black text-[10px] shrink-0 shadow-xs"><i class="fa-solid fa-check text-[9px]"></i></span>` : `<span class="w-5 h-5 bg-blue-600 text-white rounded-full flex items-center justify-center font-black text-[10px] shrink-0 shadow-xs">${num}</span>`;
                let addressHtml = isDone ? `<span class="font-bold text-gray-400 truncate line-through decoration-emerald-500 decoration-2">${d.address}</span>` : `<span class="font-bold text-gray-900 truncate">${d.address}</span>`;
                let timeOnly = comp && comp.timeString ? comp.timeString.split(' ')[1] : '';
                let statusBadge = isDone ? `<span class="bg-emerald-100 text-emerald-800 text-[10px] font-black px-2 py-0.5 rounded shadow-2xs shrink-0 whitespace-nowrap">✓ 완료 ${timeOnly ? timeOnly + ' ' : ''}[${comp.tag || '완료'}]</span>` : `<span class="bg-blue-50 text-blue-700 text-[10px] font-black px-2 py-0.5 rounded border border-blue-200 shadow-2xs shrink-0 whitespace-nowrap">대기</span>`;
                let photoBtn = comp && comp.photoUrl ? `<a href="${comp.photoUrl}" target="_blank" onclick="event.stopPropagation()" class="bg-blue-600 hover:bg-blue-700 text-white text-[9px] font-black px-1.5 py-0.5 rounded shadow-sm shrink-0 flex items-center gap-0.5"><i class="fa-solid fa-camera"></i> 사진</a>` : '';
                html += `
                <div onclick="window.focusMapPosition(${d.lat}, ${d.lng})" class="p-2.5 rounded-xl border ${isDone ? 'bg-emerald-50/40 border-emerald-200' : 'bg-white border-gray-200 hover:border-blue-400'} flex items-center justify-between text-xs shadow-xs cursor-pointer transition">
                    <div class="flex items-center gap-2 min-w-0 flex-1">${numberBadge}${addressHtml}</div><div class="flex items-center gap-1.5 shrink-0 ml-2">${photoBtn}${statusBadge}</div>
                </div>`;
            });
            html += `</div>`;
        }
    } else if (state.dispatchDetailTab === 'PENDING') {
        if (remainingDests.length === 0) {
            html += `<div class="text-center text-gray-400 py-16 text-xs font-bold space-y-1"><i class="fa-solid fa-circle-check text-2xl text-emerald-500 mb-1"></i><p>모든 배송이 완료되었습니다!</p></div>`;
        } else {
            html += `<div class="space-y-1.5 pb-4">`;
            remainingDests.forEach((d, idx) => {
                html += `
                <div onclick="window.focusMapPosition(${d.lat}, ${d.lng})" class="p-2.5 rounded-xl border bg-amber-50/40 border-amber-200 hover:border-amber-400 flex items-center justify-between text-xs shadow-xs cursor-pointer transition">
                    <div class="flex items-center gap-2 min-w-0 flex-1">
                        <span class="w-5 h-5 bg-amber-600 text-white rounded-full flex items-center justify-center font-black text-[10px] shrink-0 shadow-xs">${d.displayNumber || idx + 1}</span>
                        <span class="font-bold text-gray-900 truncate">${d.address}</span>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0 ml-2">
                        <span class="bg-amber-100 text-amber-800 text-[10px] font-black px-2 py-0.5 rounded border border-amber-200 shrink-0">배송 대기</span>
                    </div>
                </div>`;
            });
            html += `</div>`;
        }
    } else {
        if (driverDone.length === 0) {
            html += `<div class="text-center text-gray-400 py-16 text-xs font-bold space-y-1"><i class="fa-solid fa-box-open text-2xl text-gray-300 mb-1"></i><p>선택한 날짜(${selectedDate})에 완료된 배송 건이 없습니다.</p></div>`;
        } else {
            html += `<div class="space-y-1.5 pb-4">`;
            driverDone.forEach((c, idx) => {
                let timeOnly = c.timeString ? c.timeString.split(' ')[1] : '';
                let photoBtn = c.photoUrl ? `<a href="${c.photoUrl}" target="_blank" onclick="event.stopPropagation()" class="bg-blue-600 hover:bg-blue-700 text-white text-[9px] font-black px-2 py-0.5 rounded shadow-sm shrink-0 flex items-center gap-1"><i class="fa-solid fa-camera"></i> 사진</a>` : '';
                html += `
                <div onclick="window.focusMapPosition(${c.lat}, ${c.lng})" class="p-2.5 bg-white border border-emerald-200 hover:border-emerald-400 rounded-xl flex items-center justify-between text-xs shadow-xs cursor-pointer transition">
                    <div class="flex items-center gap-2 min-w-0 flex-1"><span class="w-5 h-5 bg-emerald-600 text-white rounded-full flex items-center justify-center font-black text-[10px] shrink-0">${idx + 1}</span><span class="font-bold text-gray-800 truncate">${c.address}</span></div>
                    <div class="flex items-center gap-1.5 shrink-0 ml-2">${photoBtn}<span class="bg-emerald-600 text-white text-[10px] font-black px-2 py-0.5 rounded shadow-sm whitespace-nowrap">✓ ${timeOnly} [${c.tag || '완료'}]</span></div>
                </div>`;
            });
            html += `</div>`;
        }
    }
    contentEl.innerHTML = html;
}

export function selectDriver(devId) {
    state.selectedDeviceId = devId; 
    renderSidebar();
    if (state.dispatchNavState === 'DELIVERY') drawDriverOnMap(devId);
}

export function clearSelectedDriver() { 
    state.selectedDeviceId = null; 
    forceClearMap(); 
    renderSidebar(); 
}

export async function removeOrUnlinkDriver(devId, key) {
    if (!confirm(`[${key}] 기사와의 관제 연결을 해제하시겠습니까?`)) return;
    try { await updateDoc(doc(db, "licenses", key), { dispatchKey: "" }); alert("연결이 해제되었습니다."); } catch (e) { alert("오류: " + e.message); }
}

// ==========================================
// 3. 지도 위에 경로 및 마커 렌더링
// ==========================================
export function drawDriverOnMap(devId) {
    forceClearMap(); 
    const matchedLic = state.allLicenses.find(l => l.deviceId === devId || l.key === devId);
    const driver = state.activeRoutes[devId] || null;
    if (!map) return;

    const selectedDate = document.getElementById('dispatch-date-picker').value || todayStr;
    const dotDate = selectedDate.replace(/-/g, '.');
    const isToday = (selectedDate === todayStr);

    let driverRoute = null;
    if (driver && driver.updatedAt) {
        const routeDateStr = getLocalDateString(new Date(driver.updatedAt));
        if (isToday || routeDateStr === selectedDate) {
            driverRoute = driver;
        }
    }
    const rawDests = driverRoute ? (driverRoute.destinations || []) : [];

    const completions = state.allCompletions.filter(c => {
        const matchesDev = (c.deviceId === devId || (matchedLic && c.phone === matchedLic.phone));
        const matchesDate = (c.timeString && c.timeString.startsWith(dotDate)) || 
                            (c.completedAt && getLocalDateString(new Date(c.completedAt)) === selectedDate);
        return matchesDev && matchesDate;
    });

    completions.sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
    const doneMap = {};
    completions.forEach(c => { doneMap[c.address] = c; });
    const remainingDests = rawDests.filter(d => !doneMap[d.address]);
    const currentTargetAddr = remainingDests.length > 0 ? remainingDests[0].address : null;

    const bounds = new kakao.maps.LatLngBounds();
    let pointsCount = 0;
    const plannedPath = [];
    const completedPath = [];
    const currentMode = state.currentMapPolylineMode || 'all';

    completions.forEach(comp => {
        if (comp.lat && comp.lng) {
            const pos = new kakao.maps.LatLng(comp.lat, comp.lng);
            bounds.extend(pos); completedPath.push(pos); pointsCount++;
            const content = document.createElement('div');
            content.className = 'custom-overlay completed';
            content.innerHTML = `<i class="fa-solid fa-check mr-1"></i>${comp.tag || '완료'}`;
            const overlay = new kakao.maps.CustomOverlay({ position: pos, content: content, yAnchor: 1.1 });
            overlay.customType = 'completed'; 
            
            if (currentMode === 'all' || currentMode === 'completed') {
                overlay.setMap(map); 
            }
            window.myMapOverlays.push(overlay);
        }
    });

    if (rawDests.length > 0) {
        rawDests.forEach(d => {
            if (d.lat && d.lng) {
                const pos = new kakao.maps.LatLng(d.lat, d.lng);
                plannedPath.push(pos);
                if (!doneMap[d.address]) {
                    bounds.extend(pos); pointsCount++;
                    const isCurrent = d.address === currentTargetAddr;
                    const content = document.createElement('div');
                    content.className = isCurrent ? 'custom-overlay current' : 'custom-overlay';
                    content.innerHTML = isCurrent ? `<i class="fa-solid fa-truck-fast mr-1"></i>${d.displayNumber}번 이동` : `${d.displayNumber}번`;
                    const overlay = new kakao.maps.CustomOverlay({ position: pos, content: content, yAnchor: 1.1 });
                    overlay.customType = 'planned'; 
                    
                    if (currentMode === 'all' || currentMode === 'planned') {
                        overlay.setMap(map); 
                    }
                    window.myMapOverlays.push(overlay);
                }
            }
        });
    }

    if (plannedPath.length > 1 && driverRoute) {
        window.mapPlannedPolyline = new kakao.maps.Polyline({
            path: plannedPath, strokeWeight: 4, strokeColor: '#2563eb', strokeOpacity: 0.7, strokeStyle: 'solid'
        });
        if (currentMode === 'all' || currentMode === 'planned') {
            window.mapPlannedPolyline.setMap(map);
        }
    }

    if (completedPath.length > 1) {
        window.mapCompletedPolyline = new kakao.maps.Polyline({
            path: completedPath, strokeWeight: 5, strokeColor: '#10b981', strokeOpacity: 0.85, strokeStyle: 'solid'
        });
        if (currentMode === 'all' || currentMode === 'completed') {
            window.mapCompletedPolyline.setMap(map);
        }
    }

    if (pointsCount > 0) map.setBounds(bounds);
}

export function setMapPolylineMode(mode) {
    state.currentMapPolylineMode = mode;
    ['all', 'planned', 'completed'].forEach(m => {
        const btn = document.getElementById(`btn-mode-${m}`);
        if (!btn) return;
        if (m === mode) {
            btn.classList.remove('text-gray-700', 'hover:bg-gray-100');
            btn.classList.add('bg-blue-600', 'text-white');
        } else {
            btn.classList.remove('bg-blue-600', 'text-white');
            btn.classList.add('text-gray-700', 'hover:bg-gray-100');
        }
    });

    if (window.mapPlannedPolyline) {
        window.mapPlannedPolyline.setMap((mode === 'all' || mode === 'planned') ? map : null);
    }
    if (window.mapCompletedPolyline) {
        window.mapCompletedPolyline.setMap((mode === 'all' || mode === 'completed') ? map : null);
    }
    
    if (window.myMapOverlays) {
        window.myMapOverlays.forEach(overlay => {
            if (overlay.customType === 'planned') {
                overlay.setMap((mode === 'all' || mode === 'planned') ? map : null);
            } else if (overlay.customType === 'completed') {
                overlay.setMap((mode === 'all' || mode === 'completed') ? map : null);
            }
        });
    }
}

// ==========================================
// 4. 날짜 및 전역 검색 기능
// ==========================================
export function changeDispatchDate(days) {
    const picker = document.getElementById('dispatch-date-picker');
    if (!picker) return;
    let parts = (picker.value || todayStr).split('-');
    const curDate = new Date(parts[0], parts[1] - 1, parts[2]);
    curDate.setDate(curDate.getDate() + days);
    picker.value = getLocalDateString(curDate);
    onDispatchDateChange();
}

export function onDispatchDateChange() {
    renderSidebar();
    if (state.selectedDeviceId && state.dispatchNavState === 'DELIVERY') drawDriverOnMap(state.selectedDeviceId);
}

export function resetDispatchDateToToday() {
    const picker = document.getElementById('dispatch-date-picker');
    if (picker) picker.value = todayStr;
    onDispatchDateChange();
}

export function clearSearchInput() {
    document.getElementById('global-search-input').value = '';
    document.getElementById('search-dropdown').classList.add('hidden');
    document.getElementById('search-clear-btn').classList.add('hidden');
}

export function jumpToDeliveryTarget(devId, lat, lng, dateStr) {
    document.getElementById('search-dropdown').classList.add('hidden');
    clearSearchInput();
    if (dateStr) document.getElementById('dispatch-date-picker').value = dateStr;
    setDispatchMode('DELIVERY', true);
    if (devId) window.selectDriver(devId);
    if (lat && lng && window.focusMapPosition) window.focusMapPosition(lat, lng);
}

export function handleGlobalSearch(query) {
    const dropdown = document.getElementById('search-dropdown');
    const clearBtn = document.getElementById('search-clear-btn');
    const q = query.trim().toLowerCase();
    if (!q) { dropdown.classList.add('hidden'); clearBtn.classList.add('hidden'); return; }
    clearBtn.classList.remove('hidden');

    const addressGroups = {};
    for (let devId in state.activeRoutes) {
        const r = state.activeRoutes[devId];
        const dests = r.destinations || [];
        const p = r.phone || '기사';
        dests.forEach(d => {
            if (d.address && (d.address.toLowerCase().includes(q) || p.includes(q))) {
                const addrKey = d.address.trim();
                if (!addressGroups[addrKey]) addressGroups[addrKey] = [];
                addressGroups[addrKey].push({
                    type: 'PENDING', address: d.address, dateStr: todayStr, timeStr: '이동/대기 중',
                    phone: p, devId: devId, lat: d.lat, lng: d.lng, displayNumber: d.displayNumber, timestamp: Date.now()
                });
            }
        });
    }
    state.allCompletions.forEach(c => {
        if (c.address && (c.address.toLowerCase().includes(q) || (c.phone && c.phone.includes(q)))) {
            const addrKey = c.address.trim();
            if (!addressGroups[addrKey]) addressGroups[addrKey] = [];
            let dStr = todayStr; let tStr = '';
            if (c.timeString && c.timeString.includes(' ')) { dStr = c.timeString.split(' ')[0].replace(/\./g, '-'); tStr = c.timeString.split(' ')[1]; } 
            else if (c.completedAt) { 
                dStr = getLocalDateString(new Date(c.completedAt)); 
                const dt = new Date(c.completedAt); 
                tStr = `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`; 
            }
            addressGroups[addrKey].push({
                type: 'DONE', address: c.address, dateStr: dStr, timeStr: tStr, tag: c.tag || '전달완료',
                phone: c.phone || '기사', devId: c.deviceId, lat: c.lat, lng: c.lng, timestamp: c.completedAt || 0
            });
        }
    });

    const uniqueAddresses = Object.keys(addressGroups);
    if (uniqueAddresses.length === 0) {
        dropdown.innerHTML = `<div class="p-6 text-center text-xs text-gray-400 font-bold">검색 결과가 없습니다.</div>`; dropdown.classList.remove('hidden'); return;
    }
    let html = '';
    uniqueAddresses.slice(0, 15).forEach((addr) => {
        const items = addressGroups[addr]; items.sort((a,b) => b.timestamp - a.timestamp);
        const latest = items[0]; const isToday = (latest.dateStr === todayStr);
        html += `
        <div class="border border-gray-200 rounded-2xl p-3 bg-white hover:border-blue-300 transition shadow-xs">
            <div class="flex justify-between items-center mb-1.5"><span class="font-black text-[13px] text-gray-900 truncate flex-1 pr-2"><i class="fa-solid fa-location-dot text-red-500 mr-1 text-xs"></i>${latest.address}</span><span class="bg-gray-100 text-gray-700 text-[10px] font-black px-2 py-0.5 rounded-full border border-gray-200 shrink-0">총 ${items.length}회 배송</span></div>
            <div onclick="window.jumpToDeliveryTarget('${latest.devId}', ${latest.lat}, ${latest.lng}, '${latest.dateStr}')" class="p-2.5 rounded-xl border ${latest.type === 'DONE' ? 'bg-emerald-50/40 border-emerald-200' : 'bg-blue-50/40 border-blue-200'} cursor-pointer hover:shadow-xs transition">
                <div class="flex justify-between items-center text-xs">
                    <div class="flex items-center gap-1.5"><span class="text-[10px] font-black px-1.5 py-0.5 rounded ${isToday ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}">${latest.dateStr} ${isToday ? '(오늘)' : ''}</span><span class="font-bold text-gray-800">${latest.phone}</span></div>
                    <span class="font-black text-[11px] ${latest.type === 'DONE' ? 'text-emerald-700' : 'text-blue-700'}">${latest.type === 'DONE' ? `✓ 완료 [${latest.tag}]${latest.timeStr}` : `➔ ${latest.displayNumber || 1}번 이동 대기`}</span>
                </div>
            </div>
        </div>`;
    });
    dropdown.innerHTML = html; dropdown.classList.remove('hidden');
}

// ==========================================
// 5. PRO 기능 및 기사 연결 팝업 제어
// ==========================================

export function updateProButtonsUI() {
    const isMaster = (sessionStorage.getItem('deliveryProRole') === 'MASTER');
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const myLic = state.allLicenses.find(l => l.key === dispatchKey || l.id === dispatchKey);
    const isPro = isMaster || (myLic && !!myLic.isPro);

    const btnAuto = document.getElementById('btn-pro-auto-dispatch');
    const btnInv = document.getElementById('btn-pro-invoice');

    if (btnAuto) {
        const badge = btnAuto.querySelector('span');
        if (badge) {
            if (isPro) {
                badge.className = "absolute -top-1.5 -right-1.5 bg-amber-400 text-slate-950 text-[9px] font-black px-1.5 py-0.5 rounded-full border border-white leading-none shadow-sm";
                badge.innerHTML = "PRO";
            } else {
                badge.className = "absolute -top-1.5 -right-1.5 bg-gray-500 text-white text-[9px] font-black px-1.5 py-0.5 rounded-full border border-white leading-none shadow-sm";
                badge.innerHTML = '<i class="fa-solid fa-lock text-[8px]"></i> PRO';
            }
        }
    }
    if (btnInv) {
        const badge = btnInv.querySelector('span');
        if (badge) {
            if (isPro) {
                badge.className = "absolute -top-1.5 -right-1.5 bg-amber-400 text-slate-950 text-[9px] font-black px-1.5 py-0.5 rounded-full border border-white leading-none shadow-sm";
                badge.innerHTML = "PRO";
            } else {
                badge.className = "absolute -top-1.5 -right-1.5 bg-gray-500 text-white text-[9px] font-black px-1.5 py-0.5 rounded-full border border-white leading-none shadow-sm";
                badge.innerHTML = '<i class="fa-solid fa-lock text-[8px]"></i> PRO';
            }
        }
    }
}

export function handleProFeature(featureName) {
    const isMaster = (sessionStorage.getItem('deliveryProRole') === 'MASTER');
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const myLic = state.allLicenses.find(l => l.key === dispatchKey || l.id === dispatchKey);
    const isPro = isMaster || (myLic && !!myLic.isPro);

    if (!isPro) {
        alert("🔒 [PRO 프리미엄 기능 제한]\n\n해당 기능(자동할당 및 주문서 통합관리)은 PRO 프리미엄 활성화 계정 전용 기능입니다.\n\n사용 권한 부여를 원하실 경우 본사 마스터 관리자에게 문의해 주세요.");
        return;
    }

    if (featureName === 'AUTO_DISPATCH') {
        const modal = document.getElementById('auto-dispatch-modal');
        if (!modal) { alert("🚨 시스템 안내\n현재 브라우저 화면이 최신 버전이 아닙니다. 새로고침을 진행해주세요."); return; }
        modal.classList.remove('hidden');
        renderDispatchDriverList();
        if (window.loadExcelFromFirebase) window.loadExcelFromFirebase();
        if (window.initExcelDropZone) window.initExcelDropZone(); 
        const savedBase = localStorage.getItem('deliveryProCompanyBase');
        if (savedBase) updateCompanyBaseUI(JSON.parse(savedBase));
        else updateCompanyBaseUI(null);

    } else if (featureName === 'INVOICE') {
        const modal = document.getElementById('pro-invoice-modal');
        if (!modal) { alert("🚨 시스템 안내\n주문서 통합관리 모듈을 찾을 수 없습니다."); return; }
        modal.classList.remove('hidden');
        
        state.printReadyList = (state.parsedExcelList && state.parsedExcelList.length > 0) ? [...state.parsedExcelList] : [];
        const countEl = document.getElementById('print-ready-count');
        if (countEl) countEl.innerText = state.printReadyList.length;
        
        if (window.loadSavedForms) window.loadSavedForms(); 
        if (state.printReadyList.length > 0) {
            if (window.previewInvoiceRow) window.previewInvoiceRow(0); 
            if (window.syncPreviewData) window.syncPreviewData(); 
        }
    }
}

export function closeAutoDispatchModal() { document.getElementById('auto-dispatch-modal')?.classList.add('hidden'); }
export function closeProInvoiceModal() { document.getElementById('pro-invoice-modal')?.classList.add('hidden'); }
export function closePremiumModal() { document.getElementById('premium-upgrade-modal')?.classList.add('hidden'); }

export function openLinkDriverModal() {
    document.getElementById('link-driver-key-input').value = '';
    document.getElementById('link-driver-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('link-driver-key-input').focus(), 100);
}

export function closeLinkDriverModal() {
    document.getElementById('link-driver-modal').classList.add('hidden');
}

export async function confirmLinkDriver() {
    const rawInput = document.getElementById('link-driver-key-input').value.trim().toUpperCase();
    if (!rawInput) { alert("기사 키 또는 전화번호를 입력하세요."); return; }
    const currentKey = sessionStorage.getItem('deliveryProDispatchKey') || 'MASTER';

    try {
        const cleanDigits = rawInput.replace(/[^0-9]/g, '');
        const rawKeyOnly = rawInput.replace(/^(PRO|TRIAL|CTRL)-/i, '');
        
        let targetLicKey = null;
        let targetLic = state.allLicenses.find(l => {
            if (l.type === 'dispatch') return false;
            const lKey = (l.key || '').toUpperCase();
            const lPhone = (l.phone || '').replace(/[^0-9]/g, '');
            const lRawKey = lKey.replace(/^(PRO|TRIAL|CTRL)-/i, '');
            return lKey === rawInput || lRawKey === rawKeyOnly || (cleanDigits.length >= 8 && lPhone === cleanDigits);
        });

        if (targetLic) {
            targetLicKey = targetLic.key || targetLic.id;
        } else {
            targetLicKey = rawInput; 
        }

        let docRef = doc(db, "licenses", targetLicKey);
        let directSnap = await getDoc(docRef);
        
        if (!directSnap.exists()) {
            docRef = doc(db, "licenses", `TRIAL-${targetLicKey}`);
            directSnap = await getDoc(docRef);
        }
        if (!directSnap.exists()) {
            docRef = doc(db, "licenses", `PRO-${targetLicKey}`);
            directSnap = await getDoc(docRef);
        }

        if (!directSnap.exists()) { 
            alert("기사 계정을 찾을 수 없습니다. 키 또는 번호를 다시 확인해 주세요."); 
            return; 
        }

        const freshLicData = directSnap.data();
        const finalKey = directSnap.id;

        if (freshLicData.allowTms === false || freshLicData.allowTms === "false") {
            alert(`해당 기사님([${freshLicData.phone || finalKey}])이 앱에서 'TMS 연결'을 차단(OFF) 상태로 설정했습니다.\n기사님에게 앱의 [연결설정]에서 스위치를 켜달라고 요청해 주셔야 연결이 가능합니다.`);
            return;
        }

        if (freshLicData.dispatchKey && freshLicData.dispatchKey !== currentKey && currentKey !== 'MASTER') {
            alert(`이미 다른 관제소([${freshLicData.dispatchKey}])에서 관리 중인 기사입니다.\n마스터 관리자를 통해서만 소속 변경이 가능합니다.`); 
            return;
        }

        await updateDoc(doc(db, "licenses", finalKey), { dispatchKey: currentKey });
        
        alert(`[등록 완료] 기사 [${freshLicData.phone || finalKey}] 님이 연결되었습니다.`);
        closeLinkDriverModal();
    } catch (e) { 
        alert("연결 처리 중 오류가 발생했습니다: " + e.message); 
    }
}

// ==========================================
// 6. 본사 거점 및 PRO 자동할당 패널 제어
// ==========================================
export function saveCompanyBaseAddress() {
    const input = document.getElementById('company-base-address').value.trim();
    if (!input) { alert("본사 거점 주소를 입력해주세요."); return; }
    
    if (window.kakao && kakao.maps && kakao.maps.services) {
        const geocoder = new kakao.maps.services.Geocoder();
        geocoder.addressSearch(input, (result, status) => {
            if (status === kakao.maps.services.Status.OK && result[0]) {
                let fullAddress = result[0].address_name;
                if (result[0].road_address && result[0].road_address.address_name) {
                    fullAddress = result[0].road_address.address_name;
                }

                const data = { address: fullAddress, lat: parseFloat(result[0].y), lng: parseFloat(result[0].x) };
                localStorage.setItem('deliveryProCompanyBase', JSON.stringify(data));
                updateCompanyBaseUI(data);
                alert("본사 거점이 성공적으로 저장되었습니다.");
            } else {
                alert("주소를 좌표로 변환할 수 없습니다. 정확한 도로명이나 지번 주소를 입력해주세요.");
            }
        });
    } else {
        alert("카카오맵 지도 API가 완전히 로드되지 않았습니다. 잠시 후 다시 시도해주세요.");
    }
}

export function clearCompanyBaseAddress() {
    localStorage.removeItem('deliveryProCompanyBase');
    updateCompanyBaseUI(null);
}

export function updateCompanyBaseUI(data) {
    const textEl = document.getElementById('saved-base-address-text');
    const clearBtn = document.getElementById('btn-clear-company-base');
    const inputEl = document.getElementById('company-base-address');
    if (textEl && clearBtn && inputEl) {
        if (data) {
            textEl.innerText = data.address;
            textEl.classList.add('text-blue-600');
            textEl.classList.remove('text-gray-500');
            clearBtn.classList.remove('hidden');
            inputEl.value = '';
        } else {
            textEl.innerText = '저장된 거점이 없습니다.';
            textEl.classList.remove('text-blue-600');
            textEl.classList.add('text-gray-500');
            clearBtn.classList.add('hidden');
        }
    }
}

export const autoDispatchState = {
    selectedDrivers: new Set(),
    weights: {},
    isInit: false
};

// 🌟 시야성 및 레이아웃 직관성이 개선된 운행 기사 자동할당 목록 렌더링
export function renderDispatchDriverList() {
    const listEl = document.getElementById('dispatch-driver-list');
    const countEl = document.getElementById('dispatch-driver-count');
    if (!listEl || !countEl) return;
    
    const drivers = getFilteredVisibleDrivers();
    
    if (!autoDispatchState.isInit && drivers.length > 0) {
        drivers.forEach(d => autoDispatchState.selectedDrivers.add(d.deviceId || d.key));
        autoDispatchState.isInit = true;
    }

    countEl.innerText = `${autoDispatchState.selectedDrivers.size} / ${drivers.length}명`;
    
    if (drivers.length === 0) {
        listEl.innerHTML = `<div class="text-center text-gray-400 py-10 text-[10px] font-bold">등록된 운행 기사가 없습니다.</div>`; return;
    }
    
    let html = '';
    drivers.forEach((d) => {
        const devId = d.deviceId || d.key; 
        const phoneDisplay = d.phone || d.key;
        const licKey = d.key || '';
        const tLat = d.territoryLat || ''; 
        const tLng = d.territoryLng || ''; 
        const tScale = d.territoryScale || ''; 
        const t1 = d.territory1 || ''; 
        const t2 = d.territory2 || '';
        
        let territoryBadge = '';
        if (tLat && tLng) {
            let scaleLabel = tScale === 'gu' ? '구/군' : (tScale === 'si' ? '시/도' : '동/읍/면');
            territoryBadge = `
                <div class="flex flex-col items-end gap-1" onclick="event.stopPropagation()">
                    <button type="button" onclick="window.openDriverTerritoryModal('${devId}', '${phoneDisplay}', '${tLat}', '${tLng}', '${tScale}')" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1.5 rounded-xl font-black shadow-xs transition active:scale-95 whitespace-nowrap flex items-center gap-1.5">
                        <i class="fa-solid fa-map-location-dot text-[11px]"></i> 권역 설정 (${scaleLabel})
                    </button>
                    <span class="text-[10px] text-gray-500 font-bold truncate max-w-[140px] text-right" title="${t1} ${t2}">
                        <i class="fa-solid fa-location-dot text-indigo-400 mr-0.5"></i>${t1 || t2 || '설정됨'}
                    </span>
                </div>`;
        } else {
            territoryBadge = `
                <div class="flex flex-col items-end gap-1" onclick="event.stopPropagation()">
                    <button type="button" onclick="window.openDriverTerritoryModal('${devId}', '${phoneDisplay}', '', '', '')" class="bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-300 text-xs px-3 py-1.5 rounded-xl font-black transition active:scale-95 whitespace-nowrap flex items-center gap-1.5">
                        <i class="fa-solid fa-triangle-exclamation text-amber-500 text-[11px]"></i> 권역 미설정
                    </button>
                    <span class="text-[10px] text-amber-600 font-bold">권역 설정 필요</span>
                </div>`;
        }

        const isFocus = state.selectedDispatchDriverId === devId;
        const isChecked = autoDispatchState.selectedDrivers.has(devId);
        const weight = autoDispatchState.weights[devId] || 0;
        const weightText = weight > 0 ? `+${weight}` : weight;

        html += `
        <div onclick="window.selectDispatchDriver('${devId}')" class="cursor-pointer bg-white border ${isFocus ? 'border-blue-500 ring-2 ring-blue-300 bg-blue-50/30' : 'border-gray-200 hover:border-blue-400'} p-3 rounded-2xl flex flex-col gap-2.5 shadow-xs transition mb-2.5">
            <div class="flex items-start justify-between gap-2">
                <label class="flex items-center gap-2.5 cursor-pointer mt-1 flex-1 min-w-0" onclick="event.stopPropagation()">
                    <input type="checkbox" onchange="window.toggleDispatchDriver('${devId}')" ${isChecked ? 'checked' : ''} class="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer shrink-0">
                    <div class="min-w-0">
                        <span class="font-black text-[13px] ${isFocus ? 'text-blue-700' : 'text-gray-900'} block truncate leading-tight">
                            <i class="fa-solid fa-truck ${isFocus ? 'text-blue-600' : 'text-gray-400'} mr-1 text-xs"></i>${phoneDisplay}
                        </span>
                        <span class="text-[10px] text-gray-400 font-mono block mt-0.5">ID: ${licKey}</span>
                    </div>
                </label>
                <div class="shrink-0">${territoryBadge}</div>
            </div>
            
            <div class="flex items-center justify-between bg-gray-50 p-2 rounded-xl border border-gray-100" onclick="event.stopPropagation()">
                <span class="text-[11px] font-black text-gray-600 flex items-center gap-1">
                    <i class="fa-solid fa-scale-balanced text-gray-400 text-xs"></i> 물량 가중치
                </span>
                <div class="flex items-center bg-white border border-gray-200 rounded-lg shadow-2xs">
                    <button onclick="window.adjustDriverWeight('${devId}', -0.5)" class="px-2.5 py-1 hover:bg-gray-100 text-gray-700 font-black text-xs border-r border-gray-200 transition active:scale-95" title="가중치 감소">-</button>
                    <span class="w-10 text-center text-xs font-black ${weight > 0 ? 'text-blue-600' : (weight < 0 ? 'text-red-500' : 'text-gray-700')}">${weightText}</span>
                    <button onclick="window.adjustDriverWeight('${devId}', 0.5)" class="px-2.5 py-1 hover:bg-gray-100 text-gray-700 font-black text-xs border-l border-gray-200 transition active:scale-95" title="가중치 증가">+</button>
                </div>
            </div>
        </div>`;
    });
    listEl.innerHTML = html;
}

export function toggleDispatchDriver(devId) {
    if(autoDispatchState.selectedDrivers.has(devId)) autoDispatchState.selectedDrivers.delete(devId);
    else autoDispatchState.selectedDrivers.add(devId);
    renderDispatchDriverList();
}

export function adjustDriverWeight(devId, delta) {
    let w = autoDispatchState.weights[devId] || 0;
    w += delta;
    autoDispatchState.weights[devId] = w;
    renderDispatchDriverList();
}

export function selectDispatchDriver(devId) {
    state.selectedDispatchDriverId = devId;
    renderDispatchDriverList(); 
    renderDispatchDriverDetail(); 
}

export function renderDispatchDriverDetail() {
    const header = document.getElementById('detail-driver-header');
    const table = document.getElementById('detail-driver-table');
    const tbody = document.getElementById('detail-driver-tbody');
    const badge = document.getElementById('detail-driver-count-badge');
    
    if (!state.selectedDispatchDriverId) {
        header.classList.remove('hidden'); table.classList.add('hidden'); badge.classList.add('hidden'); return;
    }

    const targetLic = state.allLicenses.find(l => l.deviceId === state.selectedDispatchDriverId || l.key === state.selectedDispatchDriverId);
    const driverName = targetLic ? (targetLic.phone || targetLic.key) : state.selectedDispatchDriverId;
    const assignedItems = state.parsedExcelList.filter(item => item.assignedDriver === driverName);

    header.classList.add('hidden'); table.classList.remove('hidden'); badge.classList.remove('hidden');
    badge.innerText = `총 ${assignedItems.length}건`;

    if (assignedItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="2" class="text-center py-16 text-gray-400 font-bold text-[11px]"><i class="fa-solid fa-box-open text-3xl text-gray-300 mb-2 block"></i>배정된 배송 건이 없습니다.</td></tr>`; return;
    }

    let html = '';
    assignedItems.forEach((item, idx) => { 
        html += `<tr class="hover:bg-blue-50/50 transition"><td class="text-center font-bold text-gray-500">${item.displayNumber || idx + 1}</td><td class="font-bold text-gray-800 whitespace-normal break-keep">${item.address || '-'}</td></tr>`; 
    });
    tbody.innerHTML = html;
}

// ==========================================
// 🌟 7. PRO 자동할당 배분 알고리즘 실행 로직
// [1원칙]: 본사 기준 최외곽 물량부터 내림차순 정렬 후 가장 가까운 기사 권역에 최우선 할당!
// ==========================================
export function runAutoDispatchAlgorithm() { 
    if (!state.parsedExcelList || state.parsedExcelList.length === 0) {
        alert("할당할 엑셀 데이터가 없습니다."); return;
    }
    
    const activeDrivers = getFilteredVisibleDrivers().filter(d => 
        autoDispatchState.selectedDrivers.has(d.deviceId || d.key)
    );
    
    if (activeDrivers.length === 0) {
        alert("자동 할당 대상 기사가 없습니다. 목록에서 배정할 기사를 체크해주세요."); return;
    }

    const unassignedOrders = state.parsedExcelList.filter(o => !o.assignedDriver);
    if (unassignedOrders.length === 0) {
        alert("모든 주문이 이미 기사들에게 할당되었습니다."); return;
    }

    const totalOrders = unassignedOrders.length;
    const numDrivers = activeDrivers.length;
    
    let totalWeights = 0;
    activeDrivers.forEach(d => { totalWeights += (autoDispatchState.weights[d.deviceId || d.key] || 0); });

    // 정밀 하버사인(Haversine) 최단 거리 계산 공식 (km 단위)
    const getDist = (lat1, lon1, lat2, lon2) => {
        if (!lat1 || !lon1 || !lat2 || !lon2) return 999999;
        const R = 6371; 
        const dLat = (lat2 - lat1) * Math.PI / 180; 
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + 
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    const companyBaseStr = localStorage.getItem('deliveryProCompanyBase');
    const companyBase = companyBaseStr ? JSON.parse(companyBaseStr) : null;

    // 기사별 목표 쿼터 및 중심 좌표 설정
    let driverStats = activeDrivers.map(d => {
        const devId = d.deviceId || d.key;
        let w = autoDispatchState.weights[devId] || 0;
        
        let exactCap = (totalOrders / numDrivers) + w - (totalWeights / numDrivers);
        if (exactCap < 0) exactCap = 0;

        const centerLat = d.territoryLat || (companyBase ? companyBase.lat : null);
        const centerLng = d.territoryLng || (companyBase ? companyBase.lng : null);

        return {
            devId,
            phone: d.phone || devId,
            exactCap,
            targetCap: Math.floor(exactCap),
            remainder: exactCap - Math.floor(exactCap),
            assignedCount: 0,
            tLat: centerLat,
            tLng: centerLng
        };
    });

    // 정수 잔여량 분배 (정확한 총합 일치)
    let currentSum = driverStats.reduce((sum, d) => sum + d.targetCap, 0);
    let diff = totalOrders - currentSum;
    
    driverStats.sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < diff; i++) {
        driverStats[i % driverStats.length].targetCap++;
    }

    // 🌟 [1원칙 핵심]: 모든 주문에 대해 본사 거점으로부터의 하버사인 거리를 계산
    const ordersWithDist = unassignedOrders.map(order => {
        let distFromBase = 0;
        if (order.lat && order.lng && companyBase && companyBase.lat && companyBase.lng) {
            distFromBase = getDist(order.lat, order.lng, companyBase.lat, companyBase.lng);
        }
        return { order, distFromBase };
    });

    // 🌟 본사 기준 가장 먼 '최외곽 물량'부터 내림차순 정렬 (외곽 물량 최우선 배분!)
    ordersWithDist.sort((a, b) => b.distFromBase - a.distFromBase);

    // 🌟 외곽부터 순서대로, 해당 주문지와 가장 가까운 기사 권역에 1순위로 배정하여 할당량을 채움!
    ordersWithDist.forEach(({ order }) => {
        let bestDriver = null;
        let minDistance = Infinity;

        // 1차: 아직 목표 수량(targetCap)이 남아있는 기사 중 이 외곽 주문과 가장 가까운 기사 선택
        driverStats.forEach(ds => {
            if (ds.assignedCount >= ds.targetCap) return;

            let d = 999999;
            if (order.lat && order.lng && ds.tLat && ds.tLng) {
                d = getDist(order.lat, order.lng, ds.tLat, ds.tLng);
            } else if (order.lat && order.lng && companyBase) {
                d = getDist(order.lat, order.lng, companyBase.lat, companyBase.lng);
            }

            if (d < minDistance) {
                minDistance = d;
                bestDriver = ds;
            }
        });

        // 2차: 만약 모든 기사의 쿼터가 찼을 경우, 전체 기사 중 물리적으로 가장 가까운 기사에게 예외 할당
        if (!bestDriver) {
            let absMinDist = Infinity;
            driverStats.forEach(ds => {
                let d = 999999;
                if (order.lat && order.lng && ds.tLat && ds.tLng) {
                    d = getDist(order.lat, order.lng, ds.tLat, ds.tLng);
                }
                if (d < absMinDist) {
                    absMinDist = d;
                    bestDriver = ds;
                }
            });
            if (!bestDriver) {
                bestDriver = driverStats.reduce((prev, curr) => (prev.assignedCount < curr.assignedCount) ? prev : curr);
            }
        }

        bestDriver.assignedCount++;
        order.assignedDriver = bestDriver.phone;
    });

    if (window.renderExcelTable) window.renderExcelTable();
    if (window.autoSaveExcelToFirebase) window.autoSaveExcelToFirebase();
    alert(`[자동할당 배분 완료]\n외곽 물량 우선 할당 원칙에 따라 총 ${totalOrders}건이 ${activeDrivers.length}명의 기사에게 성공적으로 배분되었습니다.`);
    
    if (window.renderDispatchDriverDetail) window.renderDispatchDriverDetail();
}

// ==========================================
// 8. 전역 Window 객체 바인딩
// ==========================================
window.toggleDispatchDriver = toggleDispatchDriver;
window.adjustDriverWeight = adjustDriverWeight;
window.saveCompanyBaseAddress = saveCompanyBaseAddress;
window.clearCompanyBaseAddress = clearCompanyBaseAddress;
window.updateCompanyBaseUI = updateCompanyBaseUI;
window.handleProFeature = handleProFeature;
window.updateProButtonsUI = updateProButtonsUI;