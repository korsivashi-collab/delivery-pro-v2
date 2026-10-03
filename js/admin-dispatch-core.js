// js/admin-dispatch-core.js

import { db } from "./admin-api.js";
import { state, getLocalDateString, todayStr } from "./admin-state.js";
import { selectLatestOwnedRoute } from "./route-owner.js";
import { map } from "./admin-map.js";
import { doc, updateDoc, getDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// 🌟 분리된 검색 전용 모듈에서 함수들을 재연결 (안전한 호환성 유지)
export {
    closeSearchSidePanel,
    clearSearchInput,
    jumpToDeliveryTarget,
    inspectDriverRoute,
    viewSearchCompletionPhoto,
    setSearchRangeMode,
    applyCustomSearchRange,
    resetSearchToToday,
    handleGlobalSearch
} from "./admin-dispatch-search.js";

export function formatNumber(num) {
    if (!num || isNaN(num)) return num || ''; 
    return Number(num).toLocaleString('ko-KR');
}

export function forceClearMap() {
    if (window.clearMapOverlays) {
        window.clearMapOverlays();
    } else {
        if (window.myMapOverlays) window.myMapOverlays.forEach(ov => ov.setMap(null));
        window.myMapOverlays = [];
        if (window.mapPlannedPolyline) { window.mapPlannedPolyline.setMap(null); window.mapPlannedPolyline = null; }
        if (window.mapCompletedPolyline) { window.mapCompletedPolyline.setMap(null); window.mapCompletedPolyline = null; }
        if (window.currentLocationOverlay) { window.currentLocationOverlay.setMap(null); window.currentLocationOverlay = null; }
    }
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
// 🌟 [핵심] 기사 활성 동선 정밀 판별 엔진 (오래된 과거 키 9건 잔상 완전 차단)
// ==========================================
export function getDriverRouteData(lic, selectedDate) {
    if (!lic) return null;

    // 기사 앱과 같은 소유자 경로를 우선 선택합니다. 빈 최신 경로도 그대로 반영합니다.
    if (lic.routeOwnerId) {
        const ownedRoute = selectLatestOwnedRoute(
            Object.entries(state.activeRoutes || {}).map(([id, data]) => ({ ...data, routeDocumentId: id })),
            lic.routeOwnerId
        );
        if (ownedRoute) {
            const routeDate = getLocalDateString(new Date(ownedRoute.updatedAt));
            return selectedDate === todayStr || routeDate === selectedDate ? ownedRoute : null;
        }
    }

    // 🌟 핵심 방어: 앱 로그인 기기(deviceId)가 등록된 기사는 오직 기기 ID 문서만 확인
    // (옛날 테스트 때 라이선스키 문서에 남아있던 9건 잔상이 차선책으로 부활하는 것을 원천 차단)
    let candidateKeys = [];
    if (lic.deviceId) {
        candidateKeys = [lic.deviceId];
    } else {
        candidateKeys = [lic.key, lic.phone].filter(Boolean);
    }

    let foundRoute = null;
    for (const k of candidateKeys) {
        if (state.activeRoutes && state.activeRoutes[k]) {
            const candidate = state.activeRoutes[k];
            // 다른 라이선스의 소유자가 명시된 문서는 deviceId가 같아도 가져오지 않습니다.
            if (candidate.routeOwnerId && candidate.routeOwnerId !== lic.routeOwnerId) continue;
            foundRoute = candidate;
            break;
        }
    }

    if (!foundRoute || !foundRoute.updatedAt) return null;

    // 🌟 선택된 관제 날짜와 당일 생성된 동선인지 엄격 검증 (과거 날짜 유령 데이터 차단)
    const routeDateStr = getLocalDateString(new Date(foundRoute.updatedAt));
    if (routeDateStr === selectedDate) {
        return foundRoute;
    }
    return null;
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
// 2. 배송 관리 모드 - 기사 목록 및 상세 뷰 (9건 잔상 소거 연동)
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

    const selectedDate = document.getElementById('dispatch-date-picker')?.value || todayStr;
    const dotDate = selectedDate.replace(/-/g, '.');
    const isToday = (selectedDate === todayStr);

    let html = '';
    visibleLicenses.forEach(lic => {
        const devId = lic.deviceId || lic.key;
        const phone = lic.phone || '연락처 미등록';
        
        // 🌟 기사별 정밀 활성 동선 조회
        const driverRoute = getDriverRouteData(lic, selectedDate);
        let rawDests = driverRoute ? (driverRoute.destinations || []) : [];
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
    const matchedLic = state.allLicenses.find(l => l.deviceId === devId || l.key === devId || l.phone === devId);
    const licObj = matchedLic || { deviceId: devId, key: devId, phone: devId };
    const phone = licObj.phone || licObj.key || '기사';

    headerEl.innerHTML = `
        <div class="flex items-center justify-between w-full">
            <button onclick="window.clearSelectedDriver()" class="text-xs font-black text-blue-600 hover:bg-blue-50 px-2.5 py-1.5 rounded-xl transition flex items-center gap-1 border border-blue-200"><i class="fa-solid fa-arrow-left"></i> 기사 목록</button>
            <span class="text-xs font-black text-gray-900 bg-white border border-gray-200 shadow-sm px-3 py-1.5 rounded-xl truncate"><i class="fa-solid fa-phone text-blue-500 mr-1 text-[11px]"></i>${phone}</span>
        </div>
    `;

    const selectedDate = document.getElementById('dispatch-date-picker')?.value || todayStr;
    const dotDate = selectedDate.replace(/-/g, '.');
    const isToday = (selectedDate === todayStr);

    const driverRoute = getDriverRouteData(licObj, selectedDate);
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
    try { 
        await updateDoc(doc(db, "licenses", key), { dispatchKey: "" }); 
        try {
            await deleteDoc(doc(db, "routes", devId));
            if (key && key !== devId) await deleteDoc(doc(db, "routes", key));
        } catch(err){}
        alert("연결이 해제되었습니다."); 
    } catch (e) { 
        alert("오류: " + e.message); 
    }
}

// ==========================================
// 3. 지도 위에 경로 및 마커 렌더링
// ==========================================
export function drawDriverOnMap(devId) {
    forceClearMap(); 
    const matchedLic = state.allLicenses.find(l => l.deviceId === devId || l.key === devId || l.phone === devId);
    const licObj = matchedLic || { deviceId: devId, key: devId, phone: devId };

    if (!map) return;

    const selectedDate = document.getElementById('dispatch-date-picker')?.value || todayStr;
    const dotDate = selectedDate.replace(/-/g, '.');

    const driverRoute = getDriverRouteData(licObj, selectedDate);
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
// 4. 날짜 변경 제어
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
window.getDriverRouteData = getDriverRouteData;
window.forceClearMap = forceClearMap;
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
window.updateProButtonsUI = updateProButtonsUI;
window.handleProFeature = handleProFeature;
window.closeAutoDispatchModal = closeAutoDispatchModal;
window.closeProInvoiceModal = closeProInvoiceModal;
window.closePremiumModal = closePremiumModal;
window.openLinkDriverModal = openLinkDriverModal;
window.closeLinkDriverModal = closeLinkDriverModal;
window.confirmLinkDriver = confirmLinkDriver;
