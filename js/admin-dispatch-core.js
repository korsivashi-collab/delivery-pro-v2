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
        
        const routeData = state.activeRoutes[devId] || 
                          (lic.deviceId ? state.activeRoutes[lic.deviceId] : null) || 
                          (lic.key ? state.activeRoutes[lic.key] : null) || 
                          null;

        let driverRoute = null;
        if (routeData && routeData.updatedAt) {
            const routeDateStr = getLocalDateString(new Date(routeData.updatedAt));
            if (isToday || routeDateStr === selectedDate) driverRoute = routeData;
        }
        let rawDests = driverRoute ? driverRoute.destinations || [] : [];
        rawDests = [...rawDests].sort((a, b) => (a.displayNumber || 0) - (b.displayNumber || 0));

        const driverDone = state.allCompletions.filter(c => {
            const matchesDev = (lic.deviceId && c.deviceId === lic.deviceId) || 
                               (c.deviceId === lic.key) || 
                               (c.deviceId === devId) ||
                               (lic.phone && c.phone === lic.phone);
            const matchesDate = (c.timeString && c.timeString.startsWith(dotDate)) || 
                                (c.completedAt && getLocalDateString(new Date(c.completedAt)) === selectedDate);
            return matchesDev && matchesDate;
        });

        const doneMap = {}; 
        driverDone.forEach(c => { doneMap[c.address] = c; });
        const remainingDests = rawDests.filter(d => !doneMap[d.address]);
        
        const pendingCount = isToday ? remainingDests.length : 0;
        const doneCount = driverDone.length;
        const totalCount = isToday ? (pendingCount + doneCount) : doneCount;
        const rate = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : (doneCount > 0 ? 100 : 0);

        html += `
        <div onclick="window.selectDriver('${devId}')" class="cursor-pointer p-3.5 rounded-2xl border bg-white hover:bg-blue-50/50 hover:border-blue-400 border-gray-200 shadow-sm transition relative mb-2">
            <div class="flex justify-between items-center mb-1.5">
                <span class="font-black text-sm text-gray-900 tracking-tight flex items-center gap-1.5">
                    <i class="fa-solid fa-phone text-blue-500 text-xs"></i>${phone}
                    <span class="text-[10px] text-gray-400 font-mono font-normal">[${lic.key}]</span>
                </span>
                <div class="flex items-center gap-1.5">
                    <span class="text-xs font-black px-2 py-0.5 rounded-full ${rate === 100 ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}">${rate}%</span>
                    <button onclick="event.stopPropagation(); window.removeOrUnlinkDriver('${devId}', '${lic.key}')" class="text-[10px] text-gray-400 hover:text-red-600 bg-gray-100 hover:bg-red-50 border border-gray-200 px-2 py-0.5 rounded-md font-bold transition">연결해제</button>
                </div>
            </div>
            <div class="w-full bg-gray-100 rounded-full h-1.5 mb-2.5 overflow-hidden">
                <div class="bg-blue-600 h-1.5 rounded-full transition-all duration-500" style="width: ${rate}%"></div>
            </div>
            <div class="flex justify-between text-[11px] font-bold text-gray-600">
                <span>잔여: <b class="text-blue-600 font-black text-xs">${pendingCount}</b>건</span>
                <span>완료: <b class="text-emerald-600 font-black text-xs">${doneCount}</b>건</span>
            </div>
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
    
    const driver = state.activeRoutes[devId] || 
                   (matchedLic?.deviceId ? state.activeRoutes[matchedLic.deviceId] : null) || 
                   (matchedLic?.key ? state.activeRoutes[matchedLic.key] : null) || 
                   null;
                   
    const phone = driver?.phone || matchedLic?.phone || matchedLic?.key || '기사';

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
    
    let rawDests = driverRoute ? (driverRoute.destinations || []) : [];
    rawDests = [...rawDests].sort((a, b) => (a.displayNumber || 0) - (b.displayNumber || 0));

    const driverDone = state.allCompletions.filter(c => {
        const matchesDev = (c.deviceId === devId) || 
                           (matchedLic && c.deviceId === matchedLic.deviceId) || 
                           (matchedLic && c.deviceId === matchedLic.key) || 
                           (matchedLic && c.phone === matchedLic.phone);
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
                const storeBadge = d.storeName ? `<span class="bg-gray-100 text-gray-700 text-[10px] px-1.5 py-0.5 rounded font-black mr-1 shrink-0">${d.storeName}</span>` : '';
                
                let numberBadge = isDone 
                    ? `<span class="w-5 h-5 bg-emerald-600 text-white rounded-full flex items-center justify-center font-black text-[10px] shrink-0 shadow-xs"><i class="fa-solid fa-check text-[9px]"></i></span>` 
                    : `<span class="w-5 h-5 bg-blue-600 text-white rounded-full flex items-center justify-center font-black text-[10px] shrink-0 shadow-xs">${num}</span>`;
                
                let addressHtml = isDone 
                    ? `<span class="font-bold text-gray-400 truncate line-through decoration-emerald-500 decoration-2">${storeBadge}${d.address}</span>` 
                    : `<span class="font-bold text-gray-900 truncate">${storeBadge}${d.address}</span>`;
                
                let timeOnly = comp && comp.timeString ? comp.timeString.split(' ')[1] : '';
                let statusBadge = isDone 
                    ? `<span class="bg-emerald-100 text-emerald-800 text-[10px] font-black px-2 py-0.5 rounded shadow-2xs shrink-0 whitespace-nowrap">✓ 완료 ${timeOnly ? timeOnly + ' ' : ''}[${comp.tag || '완료'}]</span>` 
                    : `<span class="bg-blue-50 text-blue-700 text-[10px] font-black px-2 py-0.5 rounded border border-blue-200 shadow-2xs shrink-0 whitespace-nowrap">대기</span>`;
                
                let photoBtn = comp && comp.photoUrl 
                    ? `<a href="${comp.photoUrl}" target="_blank" onclick="event.stopPropagation()" class="bg-blue-600 hover:bg-blue-700 text-white text-[9px] font-black px-1.5 py-0.5 rounded shadow-sm shrink-0 flex items-center gap-0.5"><i class="fa-solid fa-camera"></i> 사진</a>` 
                    : '';

                html += `
                <div onclick="window.focusMapPosition(${d.lat}, ${d.lng})" class="p-2.5 rounded-xl border ${isDone ? 'bg-emerald-50/40 border-emerald-200' : 'bg-white border-gray-200 hover:border-blue-400'} flex items-center justify-between text-xs shadow-xs cursor-pointer transition">
                    <div class="flex items-center gap-2 min-w-0 flex-1">${numberBadge}${addressHtml}</div>
                    <div class="flex items-center gap-1.5 shrink-0 ml-2">${photoBtn}${statusBadge}</div>
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
                const num = d.displayNumber || (idx + 1);
                const storeBadge = d.storeName ? `<span class="bg-amber-100 text-amber-900 text-[10px] px-1.5 py-0.5 rounded font-black mr-1 shrink-0">${d.storeName}</span>` : '';
                html += `
                <div onclick="window.focusMapPosition(${d.lat}, ${d.lng})" class="p-2.5 rounded-xl border bg-amber-50/40 border-amber-200 hover:border-amber-400 flex items-center justify-between text-xs shadow-xs cursor-pointer transition">
                    <div class="flex items-center gap-2 min-w-0 flex-1">
                        <span class="w-5 h-5 bg-amber-600 text-white rounded-full flex items-center justify-center font-black text-[10px] shrink-0 shadow-xs">${num}</span>
                        <span class="font-bold text-gray-900 truncate">${storeBadge}${d.address}</span>
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
    const driver = state.activeRoutes[devId] || 
                   (matchedLic?.deviceId ? state.activeRoutes[matchedLic.deviceId] : null) || 
                   (matchedLic?.key ? state.activeRoutes[matchedLic.key] : null) || 
                   null;

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

    let rawDests = driverRoute ? (driverRoute.destinations || []) : [];
    rawDests = [...rawDests].sort((a, b) => (a.displayNumber || 0) - (b.displayNumber || 0));

    const completions = state.allCompletions.filter(c => {
        const matchesDev = (c.deviceId === devId) || 
                           (matchedLic && c.deviceId === matchedLic.deviceId) || 
                           (matchedLic && c.deviceId === matchedLic.key) || 
                           (matchedLic && c.phone === matchedLic.phone);
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

    const companyBaseStr = localStorage.getItem('deliveryProCompanyBase');
    if (companyBaseStr) {
        try {
            const companyBase = JSON.parse(companyBaseStr);
            if (companyBase.lat && companyBase.lng && rawDests.length > 0) {
                const basePos = new kakao.maps.LatLng(companyBase.lat, companyBase.lng);
                plannedPath.push(basePos);
                bounds.extend(basePos);
                pointsCount++;
            }
        } catch(e) {}
    }

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
        rawDests.forEach((d, idx) => {
            if (d.lat && d.lng) {
                const pos = new kakao.maps.LatLng(d.lat, d.lng);
                plannedPath.push(pos);
                if (!doneMap[d.address]) {
                    bounds.extend(pos); pointsCount++;
                    const isCurrent = d.address === currentTargetAddr;
                    const courseNum = d.displayNumber || (idx + 1);
                    const content = document.createElement('div');
                    content.className = isCurrent ? 'custom-overlay current' : 'custom-overlay';
                    content.innerHTML = isCurrent 
                        ? `<i class="fa-solid fa-truck-fast mr-1"></i>${courseNum}번 이동` 
                        : `${courseNum}번`;
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
            path: plannedPath, strokeWeight: 4, strokeColor: '#2563eb', strokeOpacity: 0.75, strokeStyle: 'solid'
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
// 🌟 4. 전역 검색 및 과거 내역 확장 조회 (최근 1주일/1달/기간설정)
// ==========================================
let currentSearchQuery = '';
let currentSearchRangeMode = 'today'; // 'today', '7days', '30days', 'custom'
let currentSearchCustomStart = '';
let currentSearchCustomEnd = '';

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

function ensureSearchSidePanel() {
    let sidePanel = document.getElementById('search-result-side-panel');
    if (!sidePanel) {
        const mapSec = document.getElementById('map-section');
        if (mapSec) {
            sidePanel = document.createElement('div');
            sidePanel.id = 'search-result-side-panel';
            sidePanel.className = 'absolute top-0 right-0 h-full w-1/2 max-w-[500px] min-w-[340px] bg-white shadow-2xl z-[400] transform translate-x-full transition-transform duration-300 flex flex-col border-l border-gray-200';
            sidePanel.innerHTML = `
                <div class="px-5 py-3.5 border-b border-gray-200 bg-gray-50 flex justify-between items-center flex-none">
                    <div>
                        <h3 class="font-black text-gray-900 text-sm flex items-center gap-2">
                            <i class="fa-solid fa-magnifying-glass text-blue-600"></i> 통합 검색 결과
                        </h3>
                        <p class="text-[11px] text-gray-500 font-bold mt-0.5">오늘 배송지 및 배정 기사 현황</p>
                    </div>
                    <button onclick="window.closeSearchSidePanel()" class="text-gray-400 hover:text-gray-700 bg-white border border-gray-200 rounded-lg p-1.5 shadow-sm transition active:scale-95">
                        <i class="fa-solid fa-xmark text-lg px-1"></i>
                    </button>
                </div>
                <div id="search-range-toolbar" class="px-4 py-2.5 bg-white border-b border-gray-200 flex-none"></div>
                <div id="search-result-content" class="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50 custom-scrollbar"></div>
            `;
            mapSec.appendChild(sidePanel);
        }
    }
    return sidePanel;
}

export function closeSearchSidePanel() {
    const sidePanel = document.getElementById('search-result-side-panel');
    if (sidePanel) sidePanel.classList.add('translate-x-full');
    clearSearchInput();
}

export function clearSearchInput() {
    const input = document.getElementById('global-search-input');
    if (input) input.value = '';
    const sidePanel = document.getElementById('search-result-side-panel');
    if (sidePanel) sidePanel.classList.add('translate-x-full');
    const clearBtn = document.getElementById('search-clear-btn');
    if (clearBtn) clearBtn.classList.add('hidden');
    currentSearchQuery = '';
    currentSearchRangeMode = 'today';
}

// 🌟 기사명/버튼 클릭 시 해당 기사의 배송 관리(동선) 뷰로 다이렉트 전환
export function inspectDriverRoute(devId, dateStr) {
    if (!devId || devId === '미배정') {
        alert("배정된 기사가 없는 주문건입니다.");
        return;
    }
    if (dateStr) {
        const picker = document.getElementById('dispatch-date-picker');
        if (picker) picker.value = dateStr;
    }
    setDispatchMode('DELIVERY', true);
    selectDriver(devId);
    
    // 지도가 잘 보이도록 우측 검색 패널 닫기
    const sidePanel = document.getElementById('search-result-side-panel');
    if (sidePanel) sidePanel.classList.add('translate-x-full');
}

// 🌟 배송 완료 사진 단독 뷰어 팝업
export function viewSearchCompletionPhoto(imgUrl, addr, phone, time) {
    let modal = document.getElementById('dispatch-search-photo-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'dispatch-search-photo-modal';
        modal.className = 'fixed inset-0 bg-black/80 z-[800] flex items-center justify-center p-4 backdrop-blur-sm';
        modal.onclick = () => modal.classList.add('hidden');
        modal.innerHTML = `
            <div class="bg-white rounded-3xl overflow-hidden shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col" onclick="event.stopPropagation()">
                <div class="p-4 border-b border-gray-200 flex justify-between items-center bg-gray-50">
                    <div class="min-w-0 pr-2">
                        <h4 id="disp-photo-addr" class="font-black text-sm text-gray-900 truncate leading-snug"></h4>
                        <p id="disp-photo-sub" class="text-[11px] text-gray-500 font-bold mt-0.5"></p>
                    </div>
                    <button onclick="document.getElementById('dispatch-search-photo-modal').classList.add('hidden')" class="w-8 h-8 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-700 flex items-center justify-center transition">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="flex-1 overflow-auto bg-black flex items-center justify-center p-2 min-h-[300px]">
                    <img id="disp-photo-img" src="" alt="배송 완료 사진" class="max-h-[65vh] max-w-full object-contain rounded-lg">
                </div>
                <div class="p-3 bg-white border-t border-gray-100 flex justify-between items-center text-xs">
                    <span class="bg-emerald-100 text-emerald-800 px-2.5 py-1 rounded-full font-black">배송 완료 사진</span>
                    <a id="disp-photo-link" href="#" target="_blank" class="bg-blue-600 hover:bg-blue-700 text-white font-black px-3.5 py-1.5 rounded-xl transition flex items-center gap-1.5 shadow-sm">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> 원본 새창 보기
                    </a>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    document.getElementById('disp-photo-addr').innerText = addr || '주소 정보 없음';
    document.getElementById('disp-photo-sub').innerText = `${phone || '기사'} | ${time || ''}`;
    document.getElementById('disp-photo-img').src = imgUrl;
    document.getElementById('disp-photo-link').href = imgUrl;
    modal.classList.remove('hidden');
}

// 🌟 기간 필터 범위 판정 헬퍼
function isTargetDateInRange(dStr, mode, customStart, customEnd) {
    if (!dStr) return false;
    if (mode === 'today') return dStr === todayStr;

    const now = new Date();
    const targetDate = new Date(dStr);
    if (isNaN(targetDate.getTime())) return false;

    if (mode === '7days') {
        const past = new Date();
        past.setDate(now.getDate() - 7);
        past.setHours(0,0,0,0);
        return targetDate >= past;
    } else if (mode === '30days') {
        const past = new Date();
        past.setDate(now.getDate() - 30);
        past.setHours(0,0,0,0);
        return targetDate >= past;
    } else if (mode === 'custom') {
        if (!customStart || !customEnd) return true;
        return dStr >= customStart && dStr <= customEnd;
    }
    return true;
}

export function setSearchRangeMode(mode) {
    currentSearchRangeMode = mode;
    handleGlobalSearch(currentSearchQuery, false);
}

export function applyCustomSearchRange() {
    const sInput = document.getElementById('search-custom-start');
    const eInput = document.getElementById('search-custom-end');
    if (!sInput?.value || !eInput?.value) {
        alert("시작일과 종료일을 모두 선택해 주세요.");
        return;
    }
    if (sInput.value > eInput.value) {
        alert("시작일이 종료일보다 클 수 없습니다.");
        return;
    }
    currentSearchCustomStart = sInput.value;
    currentSearchCustomEnd = eInput.value;
    currentSearchRangeMode = 'custom';
    handleGlobalSearch(currentSearchQuery, false);
}

export function resetSearchToToday() {
    currentSearchRangeMode = 'today';
    currentSearchCustomStart = '';
    currentSearchCustomEnd = '';
    handleGlobalSearch(currentSearchQuery, false);
}

export function handleGlobalSearch(query, isNewSearch = true) {
    const sidePanel = ensureSearchSidePanel();
    const contentEl = document.getElementById('search-result-content');
    const toolbarEl = document.getElementById('search-range-toolbar');
    const clearBtn = document.getElementById('search-clear-btn');
    
    if (isNewSearch) {
        currentSearchQuery = (query || '').trim();
        currentSearchRangeMode = 'today'; // 새 검색 시 항상 오늘 기본 노출
    }

    const q = currentSearchQuery.toLowerCase();
    if (!q) { 
        if (sidePanel) sidePanel.classList.add('translate-x-full'); 
        if (clearBtn) clearBtn.classList.add('hidden'); 
        return; 
    }
    if (clearBtn) clearBtn.classList.remove('hidden');

    // 1. 기간 확장 툴바 렌더링
    if (toolbarEl) {
        let rangeLabel = '';
        if (currentSearchRangeMode === 'today') rangeLabel = `<span class="bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-black text-[11px]">오늘 (${todayStr})</span>`;
        else if (currentSearchRangeMode === '7days') rangeLabel = `<span class="bg-purple-100 text-purple-800 px-2 py-0.5 rounded font-black text-[11px]">최근 1주일</span>`;
        else if (currentSearchRangeMode === '30days') rangeLabel = `<span class="bg-purple-100 text-purple-800 px-2 py-0.5 rounded font-black text-[11px]">최근 1달</span>`;
        else rangeLabel = `<span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-black text-[11px]">${currentSearchCustomStart} ~ ${currentSearchCustomEnd}</span>`;

        toolbarEl.innerHTML = `
            <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between text-xs">
                    <span class="font-bold text-gray-600 flex items-center gap-1.5">
                        <i class="fa-regular fa-calendar-check text-blue-600"></i> 조회 범위: ${rangeLabel}
                    </span>
                    ${currentSearchRangeMode !== 'today' ? `
                    <button onclick="window.resetSearchToToday()" class="text-[11px] font-black text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-0.5 rounded border border-blue-200 transition">
                        <i class="fa-solid fa-rotate-left mr-0.5"></i> 오늘만 보기
                    </button>` : ''}
                </div>
                <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="text-[10px] text-gray-400 font-bold shrink-0">과거 내역:</span>
                    <button onclick="window.setSearchRangeMode('7days')" class="px-2.5 py-1 rounded-lg text-[11px] font-bold transition shadow-2xs ${currentSearchRangeMode === '7days' ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}">
                        최근 1주일
                    </button>
                    <button onclick="window.setSearchRangeMode('30days')" class="px-2.5 py-1 rounded-lg text-[11px] font-bold transition shadow-2xs ${currentSearchRangeMode === '30days' ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}">
                        최근 1달
                    </button>
                    <button onclick="document.getElementById('custom-range-box').classList.toggle('hidden')" class="px-2.5 py-1 rounded-lg text-[11px] font-bold transition shadow-2xs ${currentSearchRangeMode === 'custom' ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}">
                        기간 설정
                    </button>
                </div>
                <div id="custom-range-box" class="${currentSearchRangeMode === 'custom' ? 'flex' : 'hidden'} items-center gap-1.5 bg-gray-50 p-2 rounded-xl border border-gray-200 mt-1">
                    <input type="date" id="search-custom-start" value="${currentSearchCustomStart || todayStr}" class="bg-white border border-gray-300 rounded px-1.5 py-1 text-[11px] font-bold outline-none cursor-pointer flex-1">
                    <span class="text-xs text-gray-400 font-bold">~</span>
                    <input type="date" id="search-custom-end" value="${currentSearchCustomEnd || todayStr}" class="bg-white border border-gray-300 rounded px-1.5 py-1 text-[11px] font-bold outline-none cursor-pointer flex-1">
                    <button onclick="window.applyCustomSearchRange()" class="bg-slate-800 hover:bg-slate-900 text-white text-[11px] font-black px-2.5 py-1 rounded transition shadow-2xs">
                        조회
                    </button>
                </div>
            </div>
        `;
    }

    const addressGroups = {};

    // 2. 활성 동선(routes) 데이터 매칭
    for (let devId in state.activeRoutes) {
        const r = state.activeRoutes[devId];
        const dests = r.destinations || [];
        const p = r.phone || '기사';
        dests.forEach(d => {
            const matchesAddr = d.address && d.address.toLowerCase().includes(q);
            const matchesFull = d.fullAddress && d.fullAddress.toLowerCase().includes(q);
            const matchesStore = d.storeName && d.storeName.toLowerCase().includes(q);
            const matchesPhone = p.includes(q) || (d.phone && d.phone.includes(q));
            
            if (matchesAddr || matchesFull || matchesStore || matchesPhone) {
                if (isTargetDateInRange(todayStr, currentSearchRangeMode, currentSearchCustomStart, currentSearchCustomEnd)) {
                    const addrKey = (d.address || d.fullAddress || '').trim();
                    if (!addressGroups[addrKey]) addressGroups[addrKey] = [];
                    addressGroups[addrKey].push({
                        type: 'PENDING', 
                        address: d.address || d.fullAddress, 
                        storeName: d.storeName || '',
                        dateStr: todayStr, 
                        timeStr: '이동/대기 중',
                        phone: p, 
                        devId: devId, 
                        lat: d.lat, 
                        lng: d.lng, 
                        displayNumber: d.displayNumber, 
                        timestamp: Date.now()
                    });
                }
            }
        });
    }

    // 3. 배송 완료 기록(completions) 매칭
    state.allCompletions.forEach(c => {
        const matchesAddr = c.address && c.address.toLowerCase().includes(q);
        const matchesPhone = (c.phone && c.phone.includes(q)) || (c.customerPhone && c.customerPhone.includes(q));
        if (matchesAddr || matchesPhone) {
            let dStr = '';
            let tStr = '';
            if (c.timeString && c.timeString.includes(' ')) { 
                dStr = c.timeString.split(' ')[0].replace(/\./g, '-'); 
                tStr = c.timeString.split(' ')[1]; 
            } else if (c.completedAt) { 
                dStr = getLocalDateString(new Date(c.completedAt)); 
                const dt = new Date(c.completedAt); 
                tStr = `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`; 
            }

            if (isTargetDateInRange(dStr, currentSearchRangeMode, currentSearchCustomStart, currentSearchCustomEnd)) {
                const addrKey = (c.address || '').trim();
                if (!addressGroups[addrKey]) addressGroups[addrKey] = [];
                addressGroups[addrKey].push({
                    type: 'DONE', 
                    address: c.address, 
                    dateStr: dStr, 
                    timeStr: tStr, 
                    tag: c.tag || '전달완료',
                    phone: c.phone || '기사', 
                    devId: c.deviceId, 
                    lat: c.lat, 
                    lng: c.lng, 
                    photoUrl: c.photoUrl || '',
                    timestamp: c.completedAt || 0
                });
            }
        }
    });

    // 4. 업로드된 관제 엑셀 주문 리스트 매칭
    if (state.parsedExcelList && state.parsedExcelList.length > 0) {
        state.parsedExcelList.forEach(o => {
            const matchesAddr = o.address && o.address.toLowerCase().includes(q);
            const matchesFull = o.fullAddress && o.fullAddress.toLowerCase().includes(q);
            const matchesStore = o.storeName && o.storeName.toLowerCase().includes(q);
            const matchesPhone = (o.phone && o.phone.includes(q)) || (o.assignedDriver && o.assignedDriver.toLowerCase().includes(q));
            
            if (matchesAddr || matchesFull || matchesStore || matchesPhone) {
                if (isTargetDateInRange(todayStr, currentSearchRangeMode, currentSearchCustomStart, currentSearchCustomEnd)) {
                    const addrKey = (o.address || o.fullAddress || '').trim();
                    if (!addressGroups[addrKey]) addressGroups[addrKey] = [];
                    addressGroups[addrKey].push({
                        type: 'EXCEL',
                        address: o.address || o.fullAddress,
                        storeName: o.storeName || '',
                        dateStr: todayStr,
                        timeStr: o.assignedDriver ? `담당: ${o.assignedDriver}` : '미배정',
                        phone: o.assignedDriver || '미배정',
                        devId: o.assignedDriver,
                        lat: o.lat,
                        lng: o.lng,
                        timestamp: 1
                    });
                }
            }
        });
    }

    const uniqueAddresses = Object.keys(addressGroups);
    if (!contentEl) return;

    if (uniqueAddresses.length === 0) {
        contentEl.innerHTML = `
            <div class="py-20 flex flex-col items-center justify-center space-y-2">
                <i class="fa-solid fa-magnifying-glass text-gray-300 text-3xl mb-1"></i>
                <p class="text-sm text-gray-600 font-bold">지정된 기간 내 검색 결과가 없습니다.</p>
                <p class="text-[11px] text-gray-400">상단의 [최근 1주일] 또는 [최근 1달]을 눌러 과거 내역을 확인해 보세요.</p>
            </div>`; 
        if (sidePanel) sidePanel.classList.remove('translate-x-full'); 
        return;
    }
    
    let html = '';
    uniqueAddresses.slice(0, 40).forEach((addr) => {
        const items = addressGroups[addr]; 
        items.sort((a,b) => b.timestamp - a.timestamp);
        const latest = items[0]; 
        const isToday = (latest.dateStr === todayStr);
        const storeLabel = latest.storeName ? `<span class="bg-indigo-50 text-indigo-700 border border-indigo-100 text-[10px] px-1.5 py-0.5 rounded font-black mr-1.5 shrink-0">${latest.storeName}</span>` : '';
        
        let statusBadge = '';
        if (latest.type === 'DONE') {
            statusBadge = `
                <div class="flex items-center gap-1.5">
                    <span class="font-black text-[11px] px-2 py-0.5 rounded-md text-emerald-700 bg-emerald-100">
                        ✓ 완료 [${latest.tag || '전달'}] ${latest.timeStr}
                    </span>
                    ${latest.photoUrl ? `
                    <button onclick="event.stopPropagation(); window.viewSearchCompletionPhoto('${latest.photoUrl}', '${(latest.address || '').replace(/'/g, "\\'")}', '${latest.phone}', '${latest.timeStr}')" class="bg-blue-600 hover:bg-blue-700 text-white font-black text-[10px] px-2 py-0.5 rounded shadow-xs flex items-center gap-1 transition active:scale-95">
                        <i class="fa-solid fa-camera"></i> 사진
                    </button>` : ''}
                </div>
            `;
        } else if (latest.type === 'PENDING') {
            statusBadge = `
                <span class="font-black text-[11px] px-2 py-0.5 rounded-md text-blue-700 bg-blue-100">
                    ➔ 이동 대기중
                </span>
            `;
        } else {
            statusBadge = `
                <span class="font-black text-[11px] px-2 py-0.5 rounded-md text-amber-700 bg-amber-100">
                    📦 배정 주문
                </span>
            `;
        }

        // 🌟 기사명을 클릭하면 바로 그 기사의 동선 뷰로 전환
        const driverBtn = latest.phone && latest.phone !== '미배정'
            ? `<button onclick="event.stopPropagation(); window.inspectDriverRoute('${latest.devId}', '${latest.dateStr}')" class="hover:bg-blue-100 bg-gray-100 text-blue-700 font-bold px-2 py-0.5 rounded text-[11px] flex items-center transition" title="클릭 시 기사의 오늘 배송 동선으로 이동합니다">
                 <i class="fa-solid fa-truck text-[10px] mr-1 text-blue-500"></i>${latest.phone}
               </button>`
            : `<span class="text-gray-400 font-bold text-[11px]">기사 미배정</span>`;

        html += `
        <div class="border border-gray-200 rounded-2xl p-4 bg-white hover:border-blue-400 hover:shadow-md transition shadow-sm cursor-pointer group" onclick="if(window.focusMapPosition && ${latest.lat} && ${latest.lng}){ window.focusMapPosition(${latest.lat}, ${latest.lng}); }">
            <div class="flex justify-between items-start mb-2.5">
                <div class="flex-1 min-w-0 pr-2">
                    <span class="font-black text-sm text-gray-900 leading-snug break-keep flex items-start">
                        <i class="fa-solid fa-location-dot text-red-500 mt-0.5 mr-1.5 text-xs shrink-0 group-hover:animate-bounce"></i>
                        <span>${storeLabel}${latest.address}</span>
                    </span>
                </div>
                <span class="bg-gray-100 text-gray-600 text-[10px] font-black px-2 py-0.5 rounded-full border border-gray-200 shrink-0 mt-0.5 whitespace-nowrap">총 ${items.length}회</span>
            </div>
            <div class="p-3 rounded-xl border ${latest.type === 'DONE' ? 'bg-emerald-50/50 border-emerald-200' : 'bg-blue-50/50 border-blue-200'}">
                <div class="flex justify-between items-center text-xs flex-wrap gap-1.5">
                    <div class="flex items-center gap-2">
                        <span class="text-[10px] font-black px-2 py-0.5 rounded shadow-sm ${isToday ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}">
                            ${latest.dateStr}
                        </span>
                        ${driverBtn}
                    </div>
                    ${statusBadge}
                </div>
            </div>
        </div>`;
    });

    contentEl.innerHTML = html; 
    if (sidePanel) sidePanel.classList.remove('translate-x-full');
}

// ==========================================
// 5. PRO 기능 버튼 및 기사 연결 모달 제어
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
        if (window.renderDispatchDriverList) window.renderDispatchDriverList();
        if (window.loadExcelFromFirebase) window.loadExcelFromFirebase();
        if (window.initExcelDropZone) window.initExcelDropZone(); 
        const savedBase = localStorage.getItem('deliveryProCompanyBase');
        if (window.updateCompanyBaseUI) {
            if (savedBase) window.updateCompanyBaseUI(JSON.parse(savedBase));
            else window.updateCompanyBaseUI(null);
        }

    } else if (featureName === 'INVOICE') {
        if (window.exportToInvoiceModal) {
            window.exportToInvoiceModal();
        } else {
            const modal = document.getElementById('pro-invoice-modal');
            if (!modal) { alert("🚨 시스템 안내\n주문서 통합관리 모듈을 찾을 수 없습니다."); return; }
            modal.classList.remove('hidden');
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
// 6. 전역 Window 객체 바인딩
// ==========================================
window.formatNumber = formatNumber;
window.getFilteredVisibleDrivers = getFilteredVisibleDrivers;
window.setDispatchMode = setDispatchMode;
window.renderSidebar = renderSidebar;
window.renderDriverListView = renderDriverListView;
window.setDispatchDetailTab = setDispatchDetailTab;
window.renderDriverDetailView = renderDriverDetailView;
window.selectDriver = selectDriver;
window.clearSelectedDriver = clearSelectedDriver;
window.removeOrUnlinkDriver = removeOrUnlinkDriver;
window.drawDriverOnMap = drawDriverOnMap;
window.setMapPolylineMode = setMapPolylineMode;
window.changeDispatchDate = changeDispatchDate;
window.onDispatchDateChange = onDispatchDateChange;
window.resetDispatchDateToToday = resetDispatchDateToToday;
window.clearSearchInput = clearSearchInput;
window.closeSearchSidePanel = closeSearchSidePanel;
window.handleGlobalSearch = handleGlobalSearch;
window.inspectDriverRoute = inspectDriverRoute;
window.viewSearchCompletionPhoto = viewSearchCompletionPhoto;
window.setSearchRangeMode = setSearchRangeMode;
window.applyCustomSearchRange = applyCustomSearchRange;
window.resetSearchToToday = resetSearchToToday;
window.updateProButtonsUI = updateProButtonsUI;
window.handleProFeature = handleProFeature;
window.closeAutoDispatchModal = closeAutoDispatchModal;
window.closeProInvoiceModal = closeProInvoiceModal;
window.closePremiumModal = closePremiumModal;
window.openLinkDriverModal = openLinkDriverModal;
window.closeLinkDriverModal = closeLinkDriverModal;
window.confirmLinkDriver = confirmLinkDriver;