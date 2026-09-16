// js/admin-dispatch.js
import { db } from "./admin-api.js";
import { state, getLocalDateString, todayStr } from "./admin-state.js";
import { map, focusMapPosition } from "./admin-map.js";
import { playBeepSound, getAddressFromCoords } from "./admin-utils.js";
import { collection, doc, setDoc, updateDoc, deleteDoc, addDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

export function formatNumber(num) {
    if (!num || isNaN(num)) return num || ''; 
    return Number(num).toLocaleString('ko-KR');
}

window.myMapOverlays = [];
let territoryMap = null;
let territoryMarker = null;
let territoryCircles = [];
let otherTerritoryOverlays = [];
let allTerritoriesMap = null;
let allTerritoriesOverlays = [];

export function forceClearMap() {
    if (window.myMapOverlays) window.myMapOverlays.forEach(ov => ov.setMap(null));
    window.myMapOverlays = [];
    if (window.mapPlannedPolyline) { window.mapPlannedPolyline.setMap(null); window.mapPlannedPolyline = null; }
    if (window.mapCompletedPolyline) { window.mapCompletedPolyline.setMap(null); window.mapCompletedPolyline = null; }
    if (window.currentLocationOverlay) { window.currentLocationOverlay.setMap(null); window.currentLocationOverlay = null; }
}

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
        drawAllDriversOnMap();
    } else if (mode === 'DELIVERY') {
        if (filterControls) filterControls.classList.remove('hidden');
        if (fitAllBtn) fitAllBtn.classList.add('hidden');
        if (state.selectedDeviceId) drawDriverOnMap(state.selectedDeviceId);
    }
    renderSidebar();
}

export function renderSidebar() {
    if (state.dispatchNavState === 'DELIVERY') {
        if (state.selectedDeviceId) renderDriverDetailView(state.selectedDeviceId);
        else renderDriverListView();
    } else if (state.dispatchNavState === 'MESSAGE') {
        renderMessageSidebar();
    } else if (state.dispatchNavState === 'LOCATION') {
        renderLocationSidebar();
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

export function renderMessageSidebar() {
    const headerEl = document.getElementById('sidebar-header');
    const contentEl = document.getElementById('sidebar-content');
    const visibleLicenses = getFilteredVisibleDrivers();

    headerEl.innerHTML = `
        <h2 class="text-xs font-black text-gray-700 uppercase tracking-wider flex items-center gap-1.5"><i class="fa-solid fa-comments text-blue-600"></i> 수신 기사 선택</h2>
        <button onclick="window.toggleAllMessageSelection()" class="text-[11px] font-black text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md border border-blue-200 hover:bg-blue-100 transition">
            ${state.selectedMessageDrivers.size === visibleLicenses.length && visibleLicenses.length > 0 ? '선택 해제' : '전체 선택'}
        </button>`;

    if (visibleLicenses.length === 0) {
        contentEl.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">등록된 기사가 없습니다.</div>`; return;
    }
    let html = `<div class="space-y-2">`;
    visibleLicenses.forEach(lic => {
        const devId = lic.deviceId || lic.key;
        const phone = lic.phone || '연락처 미등록';
        const isChecked = state.selectedMessageDrivers.has(devId);
        html += `
        <label class="flex items-center justify-between p-3.5 bg-white border ${isChecked ? 'border-blue-500 bg-blue-50/40 ring-1 ring-blue-300' : 'border-gray-200 hover:bg-gray-50'} rounded-2xl cursor-pointer transition shadow-xs">
            <div class="flex items-center gap-3">
                <input type="checkbox" onchange="window.toggleMessageDriver('${devId}')" ${isChecked ? 'checked' : ''} class="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer">
                <div><span class="font-black text-sm text-gray-900 block leading-tight">${phone}</span><span class="text-[10px] text-gray-400 font-mono">ID: ${lic.key}</span></div>
            </div>
            <span class="text-[10px] font-black px-2 py-0.5 rounded-full ${isChecked ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'}">${isChecked ? '선택됨' : '대기'}</span>
        </label>`;
    });
    html += `</div>`;
    contentEl.innerHTML = html;
    document.getElementById('msg-selected-count').innerText = state.selectedMessageDrivers.size;
}

export function toggleMessageDriver(devId) {
    if (state.selectedMessageDrivers.has(devId)) state.selectedMessageDrivers.delete(devId);
    else state.selectedMessageDrivers.add(devId);
    renderMessageSidebar();
}

export function toggleAllMessageSelection() {
    const visibleLicenses = getFilteredVisibleDrivers();
    if (state.selectedMessageDrivers.size === visibleLicenses.length) state.selectedMessageDrivers.clear();
    else visibleLicenses.forEach(lic => state.selectedMessageDrivers.add(lic.deviceId || lic.key));
    renderMessageSidebar();
}

export function updateMessageCharCount() {
    const len = document.getElementById('message-input').value.length;
    document.getElementById('message-char-count').innerText = `${len} / 300자`;
}

export async function sendDispatchMessage() {
    const textarea = document.getElementById('message-input');
    const text = textarea.value.trim();
    const btn = document.getElementById('btn-send-message');
    if (state.selectedMessageDrivers.size === 0) { alert("좌측 목록에서 회사 알림을 수신할 기사님을 1명 이상 선택해 주세요."); return; }
    if (!text) { alert("전송할 회사 알림 내용을 입력해 주세요."); textarea.focus(); return; }

    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey') || 'MASTER';
    const targets = Array.from(state.selectedMessageDrivers);
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 전송 중...';

    try {
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const dateStr = getLocalDateString(now);

        const targetPhones = [];
        targets.forEach(tId => {
            const lic = state.allLicenses.find(l => (l.deviceId && l.deviceId === tId) || l.key === tId);
            if (lic && lic.phone) targetPhones.push(lic.phone);
            else targetPhones.push(tId);
        });

        await addDoc(collection(db, "dispatch_messages"), {
            senderKey: dispatchKey, senderType: "DISPATCH", senderTitle: "회사 알림", 
            targetDeviceIds: targets, targetPhones: targetPhones, content: text,
            createdAt: now.getTime(), dateStr: dateStr, timeStr: timeStr, acknowledged: []
        });
        alert(`[회사 알림 발송 완료]\n${targets.length}명의 기사 스마트폰으로 알림이 실시간 전송되었습니다.`);
        textarea.value = ''; updateMessageCharCount();
    } catch (e) { alert("알림 전송 오류: " + e.message); } 
    finally { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane text-xs"></i><span>회사 알림 발송</span>'; }
}

export async function deleteDispatchMessage(msgId) {
    if (!confirm("이 발송 알림 기록을 삭제하시겠습니까?")) return;
    try { await deleteDoc(doc(db, "dispatch_messages", msgId)); } catch (e) { alert("삭제 오류: " + e.message); }
}

export function renderMessageFeed() {
    const feedEl = document.getElementById('dispatch-message-feed');
    if (!feedEl) return;
    const currentDispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const mySentMessages = state.allDispatchMessages.filter(msg => {
        if (msg.senderKey === 'MASTER' || msg.senderType === 'MASTER') return false;
        if (state.currentUserRole === 'DISPATCH') return msg.senderKey === currentDispatchKey;
        return true;
    });

    if (mySentMessages.length === 0) {
        feedEl.innerHTML = `<div class="text-center text-gray-400 py-20 text-xs font-bold space-y-2"><div class="w-14 h-14 bg-white border border-gray-200 rounded-2xl flex items-center justify-center mx-auto text-xl text-gray-300 shadow-xs"><i class="fa-regular fa-bell"></i></div><p>발송된 회사 알림 내역이 없습니다.</p></div>`;
        return;
    }

    let html = '';
    mySentMessages.forEach(msg => {
        const targetPreview = msg.targetPhones && msg.targetPhones.length > 0 ? (msg.targetPhones.length === 1 ? msg.targetPhones[0] : `${msg.targetPhones[0]} 외 ${msg.targetPhones.length - 1}명`) : '전체 기사';
        html += `
        <div class="bg-white border border-gray-200 rounded-2xl p-4 shadow-xs flex flex-col gap-2 hover:border-blue-300 transition">
            <div class="flex justify-between items-center text-xs">
                <div class="flex items-center gap-2">
                    <span class="bg-blue-600 text-white font-black text-[10px] px-2 py-0.5 rounded-md shadow-xs">${msg.senderTitle || '회사 알림'}</span>
                    <span class="font-bold text-gray-800"><i class="fa-solid fa-user-check text-blue-500 mr-1"></i>수신: ${targetPreview}</span>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-[11px] font-mono text-gray-400">${msg.dateStr || ''} ${msg.timeStr || ''}</span>
                    <button type="button" onclick="window.deleteDispatchMessage('${msg.id}')" class="text-gray-400 hover:text-red-500 p-1 transition" title="이 기록 삭제"><i class="fa-solid fa-trash-can text-xs"></i></button>
                </div>
            </div>
            <div class="p-3 bg-slate-50 border border-slate-200/80 rounded-xl text-xs font-bold text-gray-800 whitespace-pre-line leading-relaxed">${msg.content}</div>
        </div>`;
    });
    feedEl.innerHTML = html;
}

export async function saveCustomTemplate() {
    const titleInput = document.getElementById('tpl-title-input');
    const contentInput = document.getElementById('tpl-content-input');
    const title = titleInput.value.trim(); const content = contentInput.value.trim();
    if (!title) { alert("알림 틀의 제목을 입력해 주세요."); titleInput.focus(); return; }
    if (!content) { alert("알림 틀 본문을 입력해 주세요."); contentInput.focus(); return; }

    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey') || 'MASTER';
    try {
        await addDoc(collection(db, "dispatch_templates"), { title: title, content: content, dispatchKey: dispatchKey, createdAt: Date.now() });
        titleInput.value = ''; contentInput.value = ''; alert(`[${title}] 알림 틀이 저장되었습니다.`);
    } catch (e) { alert("틀 저장 오류: " + e.message); }
}

export function insertCustomTemplate(content) {
    const textarea = document.getElementById('message-input');
    textarea.value = content; textarea.focus(); updateMessageCharCount();
}

export async function deleteCustomTemplate(id) {
    if (!confirm("이 알림 틀을 삭제하시겠습니까?")) return;
    try { await deleteDoc(doc(db, "dispatch_templates", id)); } catch (e) { alert("삭제 오류: " + e.message); }
}

export function renderCustomTemplates() {
    const listEl = document.getElementById('custom-template-list');
    if (!listEl) return;
    if (state.allDispatchTemplates.length === 0) { listEl.innerHTML = `<div class="text-center text-gray-400 py-12 text-xs font-bold">저장된 알림 틀이 없습니다.</div>`; return; }

    let html = '';
    state.allDispatchTemplates.forEach(tpl => {
        const escapedContent = (tpl.content || '').replace(/"/g, '&quot;').replace(/'/g, "\\'").replace(/\n/g, '\\n');
        html += `
        <div class="group p-3 bg-white border border-gray-200 rounded-2xl hover:border-blue-400 hover:shadow-xs transition flex flex-col gap-1.5 relative">
            <div class="flex justify-between items-start gap-2">
                <span onclick="window.insertCustomTemplate('${escapedContent}')" class="font-black text-xs text-gray-900 cursor-pointer hover:text-blue-600 flex items-center gap-1.5 truncate flex-1"><i class="fa-solid fa-file-lines text-blue-500 text-[11px] shrink-0"></i><span class="truncate">${tpl.title || '제목 없음'}</span></span>
                <button onclick="window.deleteCustomTemplate('${tpl.id}')" class="text-gray-300 hover:text-red-500 p-1 text-xs transition" title="틀 삭제"><i class="fa-solid fa-trash-can text-[11px]"></i></button>
            </div>
            <p onclick="window.insertCustomTemplate('${escapedContent}')" class="text-[11px] text-gray-600 font-medium line-clamp-2 leading-relaxed cursor-pointer hover:text-gray-800">${tpl.content || ''}</p>
        </div>`;
    });
    listEl.innerHTML = html;
}

export function showDispatchPopupAlert(msg) {
    state.activeDispatchPopupMsgId = msg.id;
    const contentEl = document.getElementById('dispatch-popup-alert-content');
    const timeEl = document.getElementById('dispatch-popup-alert-time');
    const modal = document.getElementById('dispatch-popup-alert-modal');
    if (!contentEl || !modal) return;
    contentEl.innerText = msg.content || '';
    timeEl.innerText = `${msg.timeStr || '방금'} 수신`;
    modal.classList.remove('hidden');
    playBeepSound();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

export function closeDispatchPopupAlertModal() {
    if (state.activeDispatchPopupMsgId) localStorage.setItem(`acked_disp_inbox_${state.activeDispatchPopupMsgId}`, 'true');
    const modal = document.getElementById('dispatch-popup-alert-modal');
    if (modal) modal.classList.add('hidden');
    state.activeDispatchPopupMsgId = null;
    checkDispatchInboxNotifications();
}

export function checkDispatchInboxNotifications() {
    if (state.currentUserRole !== 'DISPATCH') return;
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const sessionToken = sessionStorage.getItem('deliveryProSessionToken');
    const matchedLic = state.allLicenses.find(l => l.key === dispatchKey);
    const phone = (matchedLic?.phone || '').replace(/[^0-9]/g, '');

    const normalizeKey = (k) => k ? k.toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '') : '';
    const normalizedDispatchKey = normalizeKey(dispatchKey);

    const myReceivedMasterNotices = state.allDispatchMessages.filter(msg => {
        if (msg.senderKey !== 'MASTER' && msg.senderType !== 'MASTER') return false;
        if (localStorage.getItem(`deleted_disp_msg_${msg.id}`)) return false;

        const hasTargets = msg.targetDeviceIds && msg.targetDeviceIds.length > 0;
        let keyMatch = false;
        if (hasTargets) {
            keyMatch = msg.targetDeviceIds.some(targetKey => normalizeKey(targetKey) === normalizedDispatchKey || targetKey === sessionToken);
        }
        const phoneMatch = phone && msg.targetPhones && msg.targetPhones.some(p => p.replace(/[^0-9]/g, '') === phone);
        return keyMatch || phoneMatch;
    });

    const unreadMessages = myReceivedMasterNotices.filter(m => !localStorage.getItem(`acked_disp_inbox_${m.id}`));
    const unreadCount = unreadMessages.length;

    const badge = document.getElementById('dispatch-inbox-badge');
    const btn = document.getElementById('btn-dispatch-inbox');
    if (badge) {
        if (unreadCount > 0) { badge.innerText = unreadCount; badge.classList.remove('hidden'); badge.classList.add('animate-pulse'); }
        else { badge.classList.add('hidden'); badge.classList.remove('animate-pulse'); }
    }
    if (btn) {
        if (unreadCount > 0) { btn.classList.add('ring-2', 'ring-red-500', 'animate-pulse', 'bg-amber-100'); btn.classList.remove('bg-amber-50'); }
        else { btn.classList.remove('ring-2', 'ring-red-500', 'animate-pulse', 'bg-amber-100'); btn.classList.add('bg-amber-50'); }
    }

    if (unreadMessages.length > 0) {
        const latest = unreadMessages[0];
        const alreadyPopped = sessionStorage.getItem(`popped_disp_alert_${latest.id}`);
        if (!alreadyPopped) {
            sessionStorage.setItem(`popped_disp_alert_${latest.id}`, 'true');
            showDispatchPopupAlert(latest);
        }
    }
}

export function openDispatchInboxModal() {
    const container = document.getElementById('dispatch-inbox-container');
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const sessionToken = sessionStorage.getItem('deliveryProSessionToken');
    const matchedLic = state.allLicenses.find(l => l.key === dispatchKey);
    const phone = (matchedLic?.phone || '').replace(/[^0-9]/g, '');

    const normalizeKey = (k) => k ? k.toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '') : '';
    const normalizedDispatchKey = normalizeKey(dispatchKey);

    const myReceivedMasterNotices = state.allDispatchMessages.filter(msg => {
        if (msg.senderKey !== 'MASTER' && msg.senderType !== 'MASTER') return false;
        if (localStorage.getItem(`deleted_disp_msg_${msg.id}`)) return false;

        const hasTargets = msg.targetDeviceIds && msg.targetDeviceIds.length > 0;
        let keyMatch = false;
        if (hasTargets) {
            keyMatch = msg.targetDeviceIds.some(targetKey => normalizeKey(targetKey) === normalizedDispatchKey || targetKey === sessionToken);
        }
        const phoneMatch = phone && msg.targetPhones && msg.targetPhones.some(p => p.replace(/[^0-9]/g, '') === phone);
        return keyMatch || phoneMatch;
    });

    if (myReceivedMasterNotices.length === 0) {
        container.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">수신된 알림이 없습니다.</div>`;
    } else {
        let html = '';
        myReceivedMasterNotices.forEach(m => {
            localStorage.setItem(`acked_disp_inbox_${m.id}`, 'true');
            html += `
            <div class="bg-amber-50/40 border border-amber-200 rounded-2xl p-4 shadow-2xs flex flex-col gap-1.5 hover:border-amber-300 transition">
                <div class="flex justify-between items-center text-xs">
                    <span class="bg-amber-500 text-white font-black text-[10px] px-2 py-0.5 rounded-md">${m.senderTitle || '운영사 알림'}</span>
                    <div class="flex items-center gap-2"><span class="text-[11px] font-mono text-gray-400">${m.dateStr || ''} ${m.timeStr || ''}</span><button type="button" onclick="window.deleteNoticeFromDispatchInbox('${m.id}')" class="text-gray-400 hover:text-red-500 p-1 transition active:scale-95" title="알림 삭제"><i class="fa-solid fa-trash-can text-xs"></i></button></div>
                </div>
                <p class="text-xs font-bold text-gray-800 whitespace-pre-line leading-relaxed mt-1">${m.content}</p>
            </div>`;
        });
        container.innerHTML = html;
    }
    checkDispatchInboxNotifications();
    document.getElementById('dispatch-inbox-modal').classList.remove('hidden');
}

export function closeDispatchInboxModal() { document.getElementById('dispatch-inbox-modal').classList.add('hidden'); }

export async function deleteNoticeFromDispatchInbox(msgId) {
    if (!confirm("이 알림을 삭제하시겠습니까?")) return;
    try {
        localStorage.setItem(`deleted_disp_msg_${msgId}`, 'true');
        openDispatchInboxModal();
        checkDispatchInboxNotifications();
    } catch(e) { alert("삭제 오류: " + e.message); }
}

export async function clearAllDispatchInbox() {
    if (!confirm("알림함의 모든 알림을 삭제하시겠습니까?")) return;
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const sessionToken = sessionStorage.getItem('deliveryProSessionToken');
    const matchedLic = state.allLicenses.find(l => l.key === dispatchKey);
    const phone = (matchedLic?.phone || '').replace(/[^0-9]/g, '');

    const normalizeKey = (k) => k ? k.toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '') : '';
    const normalizedDispatchKey = normalizeKey(dispatchKey);

    const myNotices = state.allDispatchMessages.filter(msg => {
        if (msg.senderKey !== 'MASTER' && msg.senderType !== 'MASTER') return false;
        if (localStorage.getItem(`deleted_disp_msg_${msg.id}`)) return false;
        const hasTargets = msg.targetDeviceIds && msg.targetDeviceIds.length > 0;
        let keyMatch = false;
        if (hasTargets) {
            keyMatch = msg.targetDeviceIds.some(targetKey => normalizeKey(targetKey) === normalizedDispatchKey || targetKey === sessionToken);
        }
        const phoneMatch = phone && msg.targetPhones && msg.targetPhones.some(p => p.replace(/[^0-9]/g, '') === phone);
        return keyMatch || phoneMatch;
    });

    for (const m of myNotices) localStorage.setItem(`deleted_disp_msg_${m.id}`, 'true');
    openDispatchInboxModal();
    checkDispatchInboxNotifications();
}

export function renderLocationSidebar() {
    const headerEl = document.getElementById('sidebar-header');
    const contentEl = document.getElementById('sidebar-content');
    const visibleLicenses = getFilteredVisibleDrivers();

    headerEl.innerHTML = `
        <h2 class="text-xs font-black text-gray-700 uppercase tracking-wider flex items-center gap-1.5"><i class="fa-solid fa-tower-broadcast text-blue-600"></i> 실시간 위치 관제 (<span class="text-blue-600">${visibleLicenses.length}</span>대)</h2>
        <span class="bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded text-[10px] font-black flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span> GPS 수신중</span>
    `;

    if (visibleLicenses.length === 0) {
        contentEl.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">위치를 확인할 기사가 없습니다.</div>`; return;
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
    setDispatchMode('DELIVERY');
    selectDriver(devId);
}

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
                window.myMapOverlays.push(window.currentLocationOverlay);

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
    window.myMapOverlays.push(window.currentLocationOverlay);

    const resolvedAddr = await getAddressFromCoords(lat, lng);
    const finalAddr = resolvedAddr || knownAddress || "주소 정보를 변환할 수 없습니다.";
    const addrEl = document.getElementById('loc-overlay-addr');
    if (addrEl) addrEl.innerHTML = `<i class="fa-solid fa-map-pin text-sky-400 mr-1 text-xs"></i>${finalAddr}`;
}

export function closeCurrentLocationOverlay() {
    if (window.currentLocationOverlay) { window.currentLocationOverlay.setMap(null); window.currentLocationOverlay = null; }
}

export function drawAllDriversOnMap() {
    forceClearMap();
    if (!map) return;
    const visibleLicenses = getFilteredVisibleDrivers();
    const bounds = new kakao.maps.LatLngBounds();
    let hasPoints = false;
    visibleLicenses.forEach(lic => {
        const devId = lic.deviceId || lic.key; const driver = state.activeRoutes[devId];
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
            window.myMapOverlays.push(overlay);
        }
    });
    if (hasPoints) map.setBounds(bounds);
}

export function fitMapToAllDrivers() { drawAllDriversOnMap(); }

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
    if (lat && lng) window.focusMapPosition(lat, lng);
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
                    <span class="font-black text-[11px] ${latest.type === 'DONE' ? 'text-emerald-700' : 'text-blue-700'}">${latest.type === 'DONE' ? `✓ 완료 [${latest.tag}] ${latest.timeStr}` : `➔ ${latest.displayNumber || 1}번 이동 대기`}</span>
                </div>
            </div>
        </div>`;
    });
    dropdown.innerHTML = html; dropdown.classList.remove('hidden');
}

export function handleProFeature(featureName) {
    if (featureName === 'AUTO_DISPATCH') {
        const modal = document.getElementById('auto-dispatch-modal');
        if (!modal) { 
            alert("🚨 시스템 안내\n현재 브라우저 화면이 최신 버전이 아닙니다. 새로고침을 진행해주세요."); 
            return; 
        }
        modal.classList.remove('hidden');
        window.renderDispatchDriverList();
        window.loadExcelFromFirebase();
        if (window.initExcelDropZone) window.initExcelDropZone(); 
        const savedBase = localStorage.getItem('deliveryProCompanyBase');
        if (savedBase && window.updateCompanyBaseUI) window.updateCompanyBaseUI(JSON.parse(savedBase));

    } else if (featureName === 'INVOICE') {
        const modal = document.getElementById('pro-invoice-modal');
        if (!modal) { 
            alert("🚨 시스템 안내\n인쇄 모듈을 찾을 수 없습니다."); 
            return; 
        }
        modal.classList.remove('hidden');
        
        state.printReadyList = (state.parsedExcelList && state.parsedExcelList.length > 0) ? [...state.parsedExcelList] : [];
        
        const countEl = document.getElementById('print-ready-count');
        if (countEl) countEl.innerText = state.printReadyList.length;
        
        if(window.loadSavedForms) window.loadSavedForms(); 
        if (state.printReadyList.length > 0) {
            if(window.previewInvoiceRow) window.previewInvoiceRow(0); 
            if(window.syncPreviewData) window.syncPreviewData(); 
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

// 🌟 [강력 방어 패치] 기사가 차단했는데도 관제가 강제로 연결하는 문제 완벽 해결
export async function confirmLinkDriver() {
    const rawInput = document.getElementById('link-driver-key-input').value.trim().toUpperCase();
    if (!rawInput) { alert("기사 키 또는 전화번호를 입력하세요."); return; }
    const currentKey = sessionStorage.getItem('deliveryProDispatchKey') || 'MASTER';

    try {
        const cleanDigits = rawInput.replace(/[^0-9]/g, '');
        const rawKeyOnly = rawInput.replace(/^(PRO|TRIAL|CTRL)-/i, '');
        
        // 1차: 브라우저 메모리에 있는 데이터에서 검색
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
            targetLicKey = rawInput; // 못 찾았으면 입력값 그대로 DB 강제 조회
        }

        // 🌟 [핵심 방어] 관리자 웹브라우저의 캐시나 과거 데이터를 절대 믿지 않고,
        // 현재 DB에 기록된 최신 상태(허용/차단 여부)를 실시간으로 즉시 다시 읽어옵니다.
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

        // 🌟 방금 읽어온 "최신" 서버 데이터 기준으로 차단 여부(allowTms: false) 검사
        if (freshLicData.allowTms === false || freshLicData.allowTms === "false") {
            alert(`해당 기사님([${freshLicData.phone || finalKey}])이 앱에서 'TMS 연결'을 차단(OFF) 상태로 설정했습니다.\n기사님에게 앱의 [연결설정]에서 스위치를 켜달라고 요청해 주셔야 연결이 가능합니다.`);
            return;
        }

        // 타 관제 연결 여부 검사
        if (freshLicData.dispatchKey && freshLicData.dispatchKey !== currentKey && currentKey !== 'MASTER') {
            alert(`이미 다른 관제소([${freshLicData.dispatchKey}])에서 관리 중인 기사입니다.\n마스터 관리자를 통해서만 소속 변경이 가능합니다.`); 
            return;
        }

        // 🌟 모든 안전 검사를 통과했을 때만 최종적으로 DB에 소속 업데이트
        await updateDoc(doc(db, "licenses", finalKey), { dispatchKey: currentKey });
        
        alert(`[등록 완료] 기사 [${freshLicData.phone || finalKey}] 님이 연결되었습니다.`);
        closeLinkDriverModal();
    } catch (e) { 
        alert("연결 처리 중 오류가 발생했습니다: " + e.message); 
    }
}

export function renderDispatchDriverList() {
    const listEl = document.getElementById('dispatch-driver-list');
    const countEl = document.getElementById('dispatch-driver-count');
    if (!listEl || !countEl) return;
    
    const drivers = getFilteredVisibleDrivers();
    countEl.innerText = `${drivers.length}명`;
    
    if (drivers.length === 0) {
        listEl.innerHTML = `<div class="text-center text-gray-400 py-10 text-[10px] font-bold">등록된 운행 기사가 없습니다.</div>`; return;
    }
    
    let html = '';
    drivers.forEach((d, idx) => {
        const devId = d.deviceId || d.key; const phoneDisplay = d.phone || d.key;
        const tLat = d.territoryLat || ''; const tLng = d.territoryLng || ''; const tScale = d.territoryScale || ''; const t1 = d.territory1 || ''; const t2 = d.territory2 || '';
        
        let territoryBadge = '';
        if (tLat && tLng) {
            let scaleLabel = tScale === 'gu' ? '구/군' : (tScale === 'si' ? '시/도' : '동/읍/면');
            territoryBadge = `
                <div class="flex flex-col items-end gap-0.5">
                    <button type="button" onclick="window.openDriverTerritoryModal('${devId}', '${phoneDisplay}', '${tLat}', '${tLng}', '${tScale}')" class="bg-indigo-100 hover:bg-indigo-200 text-indigo-800 border border-indigo-200 text-[10px] px-2 py-0.5 rounded font-black transition whitespace-nowrap"><i class="fa-solid fa-map-location-dot"></i> 권역 설정 (${scaleLabel})</button>
                    <span class="text-[9px] text-gray-500 font-bold truncate max-w-[130px]" title="${t1} ${t2}">${t1} ${t2}</span>
                </div>`;
        } else {
            territoryBadge = `
                <div class="flex flex-col items-end gap-0.5">
                    <button type="button" onclick="window.openDriverTerritoryModal('${devId}', '${phoneDisplay}', '', '', '')" class="bg-gray-100 hover:bg-gray-200 text-gray-600 border border-gray-200 text-[10px] px-2 py-0.5 rounded font-bold transition whitespace-nowrap">권역 설정</button>
                    <span class="text-[9px] text-gray-400">미설정</span>
                </div>`;
        }

        const isSelected = state.selectedDispatchDriverId === devId;
        html += `
        <div onclick="window.selectDispatchDriver('${devId}')" class="cursor-pointer bg-white border ${isSelected ? 'border-blue-500 ring-1 ring-blue-300 bg-blue-50/40' : 'border-gray-200 hover:border-blue-300'} p-2.5 rounded-xl flex items-center justify-between shadow-xs transition">
            <span class="font-black text-xs ${isSelected ? 'text-blue-700' : 'text-gray-800'} flex items-center gap-2 min-w-0"><span class="w-5 h-5 bg-slate-100 rounded-full flex items-center justify-center text-[10px] font-bold text-gray-500 shrink-0">${idx + 1}</span><i class="fa-solid fa-truck ${isSelected ? 'text-blue-600' : 'text-gray-400'} shrink-0"></i><span class="truncate">${phoneDisplay}</span></span>
            <div class="shrink-0 ml-2">${territoryBadge}</div>
        </div>`;
    });
    listEl.innerHTML = html;
}

export function selectDispatchDriver(devId) {
    state.selectedDispatchDriverId = devId;
    renderDispatchDriverList(); renderDispatchDriverDetail(); 
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
    assignedItems.forEach((item, idx) => { html += `<tr class="hover:bg-blue-50/50 transition"><td class="text-center font-bold text-gray-500">${item.displayNumber || idx + 1}</td><td class="font-bold text-gray-800 whitespace-normal break-keep">${item.address || '-'}</td></tr>`; });
    tbody.innerHTML = html;
}

export async function loadExcelFromFirebase() {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey'); if (!dispatchKey) return;
    const dateVal = document.getElementById('dispatch-assign-date')?.value || todayStr;
    try {
        const snap = await getDoc(doc(db, "dispatch_orders", `${dateVal}_${dispatchKey}`));
        state.parsedExcelList = (snap.exists() && snap.data().orders) ? snap.data().orders : []; 
        renderExcelTable();
    } catch (error) {}
}

export async function autoSaveExcelToFirebase() {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey'); if (!dispatchKey) return; 
    const dateVal = document.getElementById('dispatch-assign-date')?.value || todayStr; 
    try {
        await setDoc(doc(db, "dispatch_orders", `${dateVal}_${dispatchKey}`), { date: dateVal, dispatchKey: dispatchKey, orders: state.parsedExcelList || [], updatedAt: Date.now() }, { merge: true });
    } catch (error) {}
}

export function renderExcelTable() {
    const tbody = document.getElementById('invoice-excel-tbody'); if (!tbody) return;
    if (state.parsedExcelList.length === 0) {
        tbody.innerHTML = `<tr id="empty-excel-row"><td colspan="5" class="text-center py-20"><i class="fa-solid fa-file-excel text-3xl text-gray-300 mb-2 block"></i><span class="text-gray-400 font-bold text-[11px]">업로드된 데이터가 없습니다.</span></td></tr>`;
        const chkAll = document.getElementById('chk-excel-all'); if (chkAll) chkAll.checked = false;
        renderDispatchDriverDetail(); return;
    }

    let html = '';
    state.parsedExcelList.forEach((item, idx) => {
        const assignedBadge = item.assignedDriver ? `<span class="bg-blue-100 text-blue-800 text-[10px] px-2 py-0.5 rounded font-black border border-blue-200">${item.assignedDriver}</span>` : `<span class="bg-gray-100 text-gray-400 text-[10px] px-2 py-0.5 rounded font-bold border border-gray-200">미배정</span>`;
        const coordIcon = (item.lat && item.lng) ? `<i class="fa-solid fa-map-pin text-emerald-500 mr-1" title="위치 확인됨"></i>` : `<i class="fa-solid fa-triangle-exclamation text-amber-400 mr-1" title="좌표 미확인 주소"></i>`;

        html += `
        <tr class="hover:bg-blue-50/50 cursor-pointer transition" onclick="window.toggleRowCheckbox(event, ${idx})">
            <td class="text-center"><input type="checkbox" class="cursor-pointer row-checkbox" data-idx="${idx}"></td>
            <td class="text-center font-bold text-gray-500">${idx + 1}</td>
            <td class="text-center">${assignedBadge}</td>
            <td class="font-bold text-gray-800 truncate max-w-[300px]" title="${item.address}">${coordIcon}${item.address || '-'}</td>
            <td class="text-center" onclick="event.stopPropagation()"><button onclick="window.deleteExcelRow(${idx})" class="text-red-400 hover:text-red-600 bg-red-50 hover:bg-red-100 rounded px-2 py-1 transition shadow-sm active:scale-95"><i class="fa-solid fa-trash-can text-[10px]"></i></button></td>
        </tr>`;
    });
    tbody.innerHTML = html;
    
    const chkAll = document.getElementById('chk-excel-all');
    if (chkAll) { chkAll.checked = false; chkAll.onchange = (e) => { const isChecked = e.target.checked; document.querySelectorAll('.row-checkbox').forEach(cb => { cb.checked = isChecked; }); }; }
    renderDispatchDriverDetail(); 
}

export function processExcelData(jsonData) {
    const newItems = [];
    jsonData.forEach((row) => {
        const mappedRow = { id: Date.now() + Math.random(), assignedDriver: null, senderName: '', orderNo: '', bizNo: '', address: '', storeName: '', phone: '', itemName: '', unit: '', qty: '', price: '', total: '', memo: '', lat: null, lng: null };
        for (let key in row) {
            const val = row[key]; const k = key.replace(/\s+/g, ''); 
            if (/보내는분|발송자|주문자|고객명/.test(k)) mappedRow.senderName = val;
            else if (/주문번호|오더번호|주문코드/.test(k)) mappedRow.orderNo = val;
            else if (/사업자/.test(k)) mappedRow.bizNo = val;
            else if (/상호|간판|배송지명|받는분|수령인|수신자/.test(k)) mappedRow.storeName = val;
            else if (/주소|배송지(?!(명|간판))/.test(k)) mappedRow.address = val;
            else if (/연락처|전화|핸드폰|휴대폰|폰/.test(k)) mappedRow.phone = val;
            else if (/상품|품목|제품|내역/.test(k)) mappedRow.itemName = val;
            else if (/규격|단위|포장/.test(k)) mappedRow.unit = val;
            else if (/수량|개수|갯수/.test(k)) mappedRow.qty = val;
            else if (/총액|합계|총금액|결제금액/.test(k)) mappedRow.total = val; 
            else if (/단가|가격|금액/.test(k)) mappedRow.price = val; 
            else if (/메모|요청|사항|배송메모/.test(k)) mappedRow.memo = val;
        }
        if (mappedRow.senderName || mappedRow.address || mappedRow.itemName || mappedRow.storeName) newItems.push(mappedRow);
    });
    state.parsedExcelList.push(...newItems); return newItems;
}

export function initExcelDropZone() {
    const dropZone = document.getElementById('excel-drop-zone');
    if (!dropZone || dropZone.dataset.bound === 'true') return;

    let fileInput = document.getElementById('global-excel-file-input');
    if (!fileInput) {
        fileInput = document.createElement('input'); fileInput.id = 'global-excel-file-input'; fileInput.type = 'file'; fileInput.accept = '.xlsx, .xls, .csv'; fileInput.multiple = true; fileInput.style.display = 'none'; document.body.appendChild(fileInput);
        fileInput.addEventListener('change', window.handleExcelUpload);
    }

    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('bg-indigo-100', 'border-indigo-500'); });
    dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.classList.remove('bg-indigo-100', 'border-indigo-500'); });
    dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('bg-indigo-100', 'border-indigo-500'); if (e.dataTransfer.files && e.dataTransfer.files.length > 0) { fileInput.files = e.dataTransfer.files; window.handleExcelUpload({ target: fileInput }); } });
    dropZone.addEventListener('click', () => { fileInput.click(); }); dropZone.dataset.bound = 'true';
}

export async function handleExcelUpload(e) {
    const files = e.target.files; if (!files || files.length === 0) return;
    const newlyAddedList = [];
    for (let i = 0; i < files.length; i++) {
        const parsed = await processSingleExcelFile(files[i]);
        newlyAddedList.push(...parsed);
    }
    if (newlyAddedList.length > 0) {
        renderExcelTable(); 
        await batchGeocodeExcelList(newlyAddedList); 
        renderExcelTable(); await autoSaveExcelToFirebase(); 
        alert(`[업로드 완료]\n${files.length}개 파일에서 ${newlyAddedList.length}건의 주문 데이터가 좌표 변환과 함께 성공적으로 추가되었습니다.`);
    } else { alert(`업로드 완료.\n하지만 올바른 양식의 주문 데이터를 찾을 수 없어 추가된 항목이 없습니다.`); }
    e.target.value = ''; 
}

export function processSingleExcelFile(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = function(evt) {
            try {
                const data = new Uint8Array(evt.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const json = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                resolve(processExcelData(json));
            } catch(err) { resolve([]); }
        };
        reader.readAsArrayBuffer(file);
    });
}

function getCoordsFromAddress(address) {
    return new Promise((resolve) => {
        if (!address || !window.kakao || !window.kakao.maps || !window.kakao.maps.services) { resolve(null); return; }
        const geocoder = new kakao.maps.services.Geocoder();
        geocoder.addressSearch(address.trim(), (result, status) => {
            if (status === kakao.maps.services.Status.OK && result[0]) {
                let fullAddress = result[0].address_name;
                if (result[0].road_address && result[0].road_address.address_name) fullAddress = result[0].road_address.address_name;
                resolve({ lat: parseFloat(result[0].y), lng: parseFloat(result[0].x), fullAddress: fullAddress });
            } else { resolve(null); }
        });
    });
}

async function batchGeocodeExcelList(items) {
    const dropZone = document.getElementById('excel-drop-zone');
    const originalDropHtml = dropZone ? dropZone.innerHTML : '';
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (dropZone) dropZone.innerHTML = `<div class="flex items-center gap-3 text-indigo-600 font-black text-sm"><i class="fa-solid fa-circle-notch fa-spin text-xl"></i><span>배송지 좌표 분석 중... (${i + 1} / ${items.length})</span></div>`;
        if (item.address && (!item.lat || !item.lng)) {
            const coords = await getCoordsFromAddress(item.address);
            if (coords) { item.lat = coords.lat; item.lng = coords.lng; }
            await new Promise(r => setTimeout(r, 50));
        }
    }
    if (dropZone) dropZone.innerHTML = originalDropHtml;
}

export function toggleRowCheckbox(e, idx) {
    if (e && e.target.tagName === 'INPUT') return; 
    const cb = document.querySelector(`.row-checkbox[data-idx="${idx}"]`); 
    if(cb) cb.checked = !cb.checked;
}

export async function deleteExcelRow(idx) {
    if(!confirm("해당 주문건을 리스트에서 삭제하시겠습니까?")) return;
    state.parsedExcelList.splice(idx, 1); 
    renderExcelTable(); 
    await autoSaveExcelToFirebase();
}

export async function deleteSelectedExcelRows() {
    const checkboxes = document.querySelectorAll('.row-checkbox:checked');
    if(checkboxes.length === 0) { alert("삭제할 주문건을 좌측 체크박스에서 1개 이상 선택해주세요."); return; }
    if(!confirm(`선택하신 ${checkboxes.length}개의 주문건을 삭제하시겠습니까?`)) return;
    const indicesToRemove = Array.from(checkboxes).map(cb => parseInt(cb.getAttribute('data-idx')));
    state.parsedExcelList = state.parsedExcelList.filter((_, idx) => !indicesToRemove.includes(idx));
    renderExcelTable(); 
    await autoSaveExcelToFirebase(); 
}

export async function clearAllExcelRows() {
    if(state.parsedExcelList.length === 0) return;
    if(!confirm("업로드된 모든 주문 리스트를 비우시겠습니까?")) return;
    state.parsedExcelList = []; 
    renderExcelTable(); 
    await autoSaveExcelToFirebase();
}

export function exportToInvoiceModal() {
    const checkboxes = document.querySelectorAll('.row-checkbox:checked');
    if (checkboxes.length === 0) { alert("명세서로 출력할 주문건을 리스트 체크박스에서 1개 이상 선택해주세요."); return; }
    state.printReadyList = [];
    checkboxes.forEach(cb => { 
        const idx = parseInt(cb.getAttribute('data-idx')); 
        if (state.parsedExcelList[idx]) state.printReadyList.push(state.parsedExcelList[idx]); 
    });

    closeAutoDispatchModal(); 
    document.getElementById('pro-invoice-modal')?.classList.remove('hidden');
    document.getElementById('print-ready-count').innerText = state.printReadyList.length;
    window.loadSavedForms(); 
    window.previewInvoiceRow(0); 
    window.syncPreviewData();
}

export function previewInvoiceRow(idx) {
    if (!state.printReadyList || !state.printReadyList[idx]) return;
    const item = state.printReadyList[idx];

    document.querySelectorAll('.prev-cust-regno').forEach(el => el.innerText = item.bizNo || '');
    document.querySelectorAll('.prev-cust-name').forEach(el => el.innerText = item.senderName || ''); 
    document.querySelectorAll('.prev-cust-store').forEach(el => el.innerText = item.storeName || '');
    document.querySelectorAll('.prev-cust-tel').forEach(el => el.innerText = item.phone || '');
    document.querySelectorAll('.prev-cust-addr').forEach(el => el.innerText = item.address || '');

    document.querySelectorAll('.prev-item-name').forEach(el => el.innerText = item.itemName || '');
    document.querySelectorAll('.prev-item-unit').forEach(el => el.innerText = item.unit || '');
    document.querySelectorAll('.prev-item-qty').forEach(el => el.innerText = window.formatNumber(item.qty) || '');
    document.querySelectorAll('.prev-item-price').forEach(el => el.innerText = window.formatNumber(item.price) || '');
    document.querySelectorAll('.prev-item-total').forEach(el => el.innerText = window.formatNumber(item.total) || '');
    
    let payMethod = ''; if (item.memo && item.memo.includes('네이버페이')) payMethod = '네이버페이'; else if (item.memo && item.memo.includes('카드')) payMethod = '카드결제';
    
    document.querySelectorAll('.prev-pay-method').forEach(el => el.innerText = payMethod);
    document.querySelectorAll('.prev-total-qty').forEach(el => el.innerText = (item.qty ? window.formatNumber(item.qty) + '개' : ''));
    document.querySelectorAll('.prev-cust-memo').forEach(el => el.innerText = item.memo || '');
    document.querySelectorAll('.prev-shipping-fee').forEach(el => el.innerText = '0원');
    document.querySelectorAll('.prev-item-total-amt').forEach(el => el.innerText = (item.total ? window.formatNumber(item.total) + '원' : ''));
    document.querySelectorAll('.prev-total-order-amt').forEach(el => el.innerText = (item.total ? window.formatNumber(item.total) + '원' : ''));
    document.querySelectorAll('span.font-normal.inline-block').forEach(span => { if (span.classList.contains('w-32')) span.innerText = item.orderNo || ''; });

    window.syncPreviewData(); 
}

function generateInvoiceHTML(item, providerInfo) {
    const originalTemplate = document.getElementById('print-area'); if (!originalTemplate) return '';
    const template = originalTemplate.cloneNode(true); template.id = ''; 

    template.querySelectorAll('.prev-prov-regno').forEach(el => el.innerText = providerInfo.regno);
    template.querySelectorAll('.prev-prov-name').forEach(el => el.innerText = providerInfo.name);
    template.querySelectorAll('.prev-prov-addr').forEach(el => el.innerText = providerInfo.addr);
    template.querySelectorAll('.prev-prov-tel').forEach(el => el.innerText = providerInfo.tel);
    template.querySelectorAll('.prev-prov-add-tel').forEach(el => el.innerText = providerInfo.addTel);

    template.querySelectorAll('.prev-cust-regno').forEach(el => el.innerText = item.bizNo || '');
    template.querySelectorAll('.prev-cust-name').forEach(el => el.innerText = item.senderName || '');
    template.querySelectorAll('.prev-cust-store').forEach(el => el.innerText = item.storeName || '');
    template.querySelectorAll('.prev-cust-tel').forEach(el => el.innerText = item.phone || '');
    template.querySelectorAll('.prev-cust-addr').forEach(el => el.innerText = item.address || '');

    template.querySelectorAll('.prev-item-name').forEach(el => el.innerText = item.itemName || '');
    template.querySelectorAll('.prev-item-unit').forEach(el => el.innerText = item.unit || '');
    template.querySelectorAll('.prev-item-qty').forEach(el => el.innerText = window.formatNumber(item.qty) || '');
    template.querySelectorAll('.prev-item-price').forEach(el => el.innerText = window.formatNumber(item.price) || '');
    template.querySelectorAll('.prev-item-total').forEach(el => el.innerText = window.formatNumber(item.total) || '');

    let payMethod = ''; if (item.memo && item.memo.includes('네이버페이')) payMethod = '네이버페이'; else if (item.memo && item.memo.includes('카드')) payMethod = '카드결제';
    template.querySelectorAll('.prev-pay-method').forEach(el => el.innerText = payMethod);
    template.querySelectorAll('.prev-total-qty').forEach(el => el.innerText = (item.qty ? window.formatNumber(item.qty) + '개' : ''));
    template.querySelectorAll('.prev-cust-memo').forEach(el => el.innerText = item.memo || '');
    template.querySelectorAll('.prev-shipping-fee').forEach(el => el.innerText = '0원');
    template.querySelectorAll('.prev-item-total-amt').forEach(el => el.innerText = (item.total ? window.formatNumber(item.total) + '원' : ''));
    template.querySelectorAll('.prev-total-order-amt').forEach(el => el.innerText = (item.total ? window.formatNumber(item.total) + '원' : ''));

    template.querySelectorAll('.invoice-table').forEach(table => {
        table.querySelectorAll('tr').forEach(tr => {
            const text = tr.innerText;
            if ((text.includes('주 소') || text.includes('배 송 요 청 사 항')) && !tr.classList.contains('double-height')) {
                tr.classList.add('double-height');
                tr.querySelectorAll('td').forEach(td => { if (!td.classList.contains('invoice-label') && !td.classList.contains('inv-text-right')) td.classList.add('multi-line-text'); });
            }
        });
    });

    const dateStr = getLocalDateString();
    const dateSpan1 = template.querySelector('#prev-date-1'); if (dateSpan1) { dateSpan1.id = ''; dateSpan1.innerText = dateStr; }
    const dateSpan2 = template.querySelector('#prev-date-2'); if (dateSpan2) { dateSpan2.id = ''; dateSpan2.innerText = dateStr; }
    template.querySelectorAll('span.font-normal.inline-block').forEach(span => { if (span.classList.contains('w-32')) span.innerText = item.orderNo || ''; });

    return template.outerHTML;
}

export function executeBatchPrint() {
    if (state.printReadyList.length === 0) { alert("출력할 주문건이 없습니다."); return; }
    const btn = document.getElementById('btn-batch-print');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 문서 생성 중...'; }

    const providerInfo = {
        title: document.getElementById('input-form-title')?.value || '', regno: document.getElementById('input-prov-regno')?.value || '',
        name: document.getElementById('input-prov-name')?.value || '', addr: document.getElementById('input-prov-addr')?.value || '',
        tel: document.getElementById('input-prov-tel')?.value || '', addTel: document.getElementById('input-prov-add-tel')?.value || ''
    };

    let printContents = ''; state.printReadyList.forEach(item => { printContents += generateInvoiceHTML(item, providerInfo); });

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;z-index:-1;'; document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document; doc.open();
    doc.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>배송 동선 PRO - 거래명세표 출력</title><style>
        * { box-sizing: border-box; } @media print { @page { size: A4 portrait; margin: 0; } body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: white; } .invoice-container { box-shadow: none !important; border: none !important; margin: 0 !important; page-break-after: always; width: 210mm; height: 297mm; } .invoice-half { height: 148mm; page-break-inside: avoid; } }
        body { background: white; margin: 0; padding: 0; font-family: 'Malgun Gothic', sans-serif; } .invoice-container { width: 210mm; height: 297mm; margin: 0 auto; display: flex; flex-direction: column; } .invoice-half { height: 148mm; background-color: #ffeb5c !important; padding: 5mm 8mm; display: flex; flex-direction: column; -webkit-print-color-adjust: exact; print-color-adjust: exact; } .invoice-cut-line { border-top: 1px dashed #6b7280; width: 100%; margin: 0; } .invoice-title { text-align: center; font-size: 21px; font-weight: 900; letter-spacing: 6px; text-decoration: underline; margin-bottom: 5px; } .invoice-table { width: 100%; border-collapse: collapse; border: 2px solid #000; font-size: 10px; margin-bottom: 4px; table-layout: fixed; } .invoice-table th, .invoice-table td { border: 1px solid #000; padding: 2px 5px; height: 27px; vertical-align: middle; overflow: hidden; word-break: break-all; } .double-height { height: 54px !important; } .double-height td { height: 54px !important; } .multi-line-text { white-space: normal !important; line-height: 1.3; } .invoice-table th { font-weight: bold; text-align: center; } .invoice-label { font-weight: bold; text-align: center; white-space: nowrap; } .writing-mode-vertical { writing-mode: vertical-rl; text-orientation: upright; text-align: center; letter-spacing: 3px; } .text-fit-auto { font-size: 9.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .inv-text-center { text-align: center; } .inv-text-left { text-align: left; padding-left: 6px !important; } .inv-text-right { text-align: right; padding-right: 6px !important; } .inv-font-bold { font-weight: bold; }
    </style></head><body>${printContents}</body></html>`);
    doc.close();

    iframe.onload = function() {
        setTimeout(() => {
            iframe.contentWindow.focus(); iframe.contentWindow.print();
            setTimeout(() => { document.body.removeChild(iframe); if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-print text-sm"></i> 명세서 일괄 출력`; } }, 1000);
        }, 800); 
    };
}

export function syncPreviewData() {
    const regno = document.getElementById('input-prov-regno')?.value || '';
    const name = document.getElementById('input-prov-name')?.value || '';
    const addr = document.getElementById('input-prov-addr')?.value || '';
    const tel = document.getElementById('input-prov-tel')?.value || '';
    const addTel = document.getElementById('input-prov-add-tel')?.value || '';
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    if (document.getElementById('prev-date-1')) document.getElementById('prev-date-1').innerText = dateStr;
    if (document.getElementById('prev-date-2')) document.getElementById('prev-date-2').innerText = dateStr;
    document.querySelectorAll('.prev-prov-regno').forEach(el => el.innerText = regno);
    document.querySelectorAll('.prev-prov-name').forEach(el => el.innerText = name);
    document.querySelectorAll('.prev-prov-addr').forEach(el => el.innerText = addr);
    document.querySelectorAll('.prev-prov-tel').forEach(el => el.innerText = tel);
    document.querySelectorAll('.prev-prov-add-tel').forEach(el => el.innerText = addTel);
}

export function updateLivePreview() {
    clearTimeout(state.previewDebounceTimer);
    state.previewDebounceTimer = setTimeout(() => { window.syncPreviewData(); }, 150);
}

export function loadSavedForms() {
    const listEl = document.getElementById('saved-forms-list');
    if (!listEl) return;
    let savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    if (savedForms.length === 0) { listEl.innerHTML = `<div class="text-center text-gray-400 py-10 text-[10px] font-bold">저장된 폼이 없습니다.<br>아래에서 새 폼을 작성하고 저장하세요.</div>`; return; }
    let html = '';
    savedForms.forEach((form, idx) => {
        const isSelected = (state.currentSelectedFormIndex === idx);
        html += `
        <div class="border ${isSelected ? 'border-indigo-600 bg-indigo-50/70 ring-1 ring-indigo-400' : 'border-gray-200 bg-white hover:border-indigo-300'} rounded-xl p-2.5 shadow-xs transition flex items-center justify-between group">
            <div class="flex items-center gap-3 overflow-hidden flex-1 pl-1">
                <input type="checkbox" onchange="window.toggleSelectForm(${idx})" ${isSelected ? 'checked' : ''} class="w-4 h-4 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500 cursor-pointer shrink-0">
                <div class="min-w-0 cursor-pointer flex-1" onclick="window.previewSavedForm(${idx})">
                    <p class="text-[11px] font-black ${isSelected ? 'text-indigo-800' : 'text-gray-800'} truncate leading-tight hover:text-indigo-600 transition">${form.title}</p>
                    <p class="text-[9px] text-gray-400 truncate mt-0.5">${form.name}</p>
                </div>
            </div>
            <button type="button" onclick="window.deleteSavedForm(${idx})" class="text-gray-300 hover:text-red-500 px-1.5 py-1 transition shrink-0"><i class="fa-solid fa-trash-can text-[10px]"></i></button>
        </div>`;
    });
    listEl.innerHTML = html;
}

export function toggleSelectForm(idx) {
    if (state.currentSelectedFormIndex === idx) { 
        state.currentSelectedFormIndex = null; 
        window.cancelProviderFormEdit(); 
        window.loadSavedForms(); 
    } else { window.applySavedForm(idx); }
}

export function previewSavedForm(idx) { window.applySavedForm(idx); }

export function applySavedForm(idx) {
    let savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    const form = savedForms[idx]; if (!form) return;
    state.currentSelectedFormIndex = idx;

    document.getElementById('input-form-title').value = form.title || '';
    document.getElementById('input-prov-regno').value = form.regno || '';
    document.getElementById('input-prov-name').value = form.name || '';
    document.getElementById('input-prov-addr').value = form.addr || '';
    document.getElementById('input-prov-tel').value = form.tel || '';
    document.getElementById('input-prov-add-tel').value = form.addTel || '';

    window.loadSavedForms(); window.syncPreviewData();
}

export function selectFormTemplate(type) {
    document.getElementById('form-template-modal')?.classList.add('hidden');
    const accordion = document.getElementById('form-setup-accordion');
    if (accordion && accordion.classList.contains('hidden')) { accordion.classList.remove('hidden'); accordion.classList.add('flex'); }
    setTimeout(() => { document.getElementById('input-form-title')?.focus(); }, 300);
}

export function saveProviderForm() {
    const title = document.getElementById('input-form-title')?.value.trim();
    if (!title) { alert("저장할 폼의 '제목'을 입력해주세요."); return; }
    const newForm = {
        title, regno: document.getElementById('input-prov-regno')?.value.trim(),
        name: document.getElementById('input-prov-name')?.value.trim(),
        addr: document.getElementById('input-prov-addr')?.value.trim(),
        tel: document.getElementById('input-prov-tel')?.value.trim(),
        addTel: document.getElementById('input-prov-add-tel')?.value.trim(),
        savedAt: Date.now()
    };
    let savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    const existingIdx = savedForms.findIndex(f => f.title === title);
    if(existingIdx >= 0) {
        if(confirm(`'${title}'(으)로 이미 저장된 폼이 있습니다. 덮어쓰시겠습니까?`)) savedForms[existingIdx] = newForm;
        else return;
    } else { savedForms.push(newForm); }
    localStorage.setItem('deliveryPro_savedForms', JSON.stringify(savedForms));
    alert(`[${title}] 폼이 성공적으로 저장되었습니다.`);
    window.loadSavedForms();
}

export function deleteSavedForm(idx) {
    let savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    if(!confirm(`[${savedForms[idx].title}] 폼을 삭제하시겠습니까?`)) return;
    savedForms.splice(idx, 1);
    localStorage.setItem('deliveryPro_savedForms', JSON.stringify(savedForms));
    if (state.currentSelectedFormIndex === idx) state.currentSelectedFormIndex = null;
    window.loadSavedForms();
}

export function cancelProviderFormEdit() {
    state.currentSelectedFormIndex = null;
    ['input-form-title', 'input-prov-regno', 'input-prov-name', 'input-prov-addr', 'input-prov-tel', 'input-prov-add-tel'].forEach(id => {
        if(document.getElementById(id)) document.getElementById(id).value = '';
    });
    const accordion = document.getElementById('form-setup-accordion');
    if (accordion) { accordion.classList.add('hidden'); accordion.classList.remove('flex'); }
    window.loadSavedForms(); window.syncPreviewData();
}

export async function saveCompanyBaseAddress() {
    const input = document.getElementById('company-base-address');
    const addr = input.value.trim();
    if (!addr) { alert("본사 거점 주소를 입력해주세요."); input.focus(); return; }
    const btn = document.getElementById('btn-save-company-base');
    btn.disabled = true; btn.innerText = "확인중...";
    
    const geocoder = new kakao.maps.services.Geocoder();
    geocoder.addressSearch(addr, function(result, status) {
        btn.disabled = false; btn.innerText = "저장";
        if (status === kakao.maps.services.Status.OK) {
            const fullAddress = result[0].address_name;
            const baseData = { address: fullAddress, lat: parseFloat(result[0].y), lng: parseFloat(result[0].x) };
            localStorage.setItem('deliveryProCompanyBase', JSON.stringify(baseData));
            window.updateCompanyBaseUI(baseData);
            input.value = fullAddress; 
        } else { alert("주소 위치를 찾을 수 없습니다."); }
    });
}

export function clearCompanyBaseAddress() {
    localStorage.removeItem('deliveryProCompanyBase');
    document.getElementById('company-base-address').value = '';
    window.updateCompanyBaseUI(null);
}

export function updateCompanyBaseUI(baseData) {
    const textEl = document.getElementById('saved-base-address-text');
    const clearBtn = document.getElementById('btn-clear-company-base');
    if (baseData) {
        textEl.innerText = baseData.address; textEl.classList.add('text-indigo-600'); textEl.classList.remove('text-gray-500'); clearBtn.classList.remove('hidden');
    } else {
        textEl.innerText = "저장된 거점이 없습니다."; textEl.classList.add('text-gray-500'); textEl.classList.remove('text-indigo-600'); clearBtn.classList.add('hidden');
    }
}

export function openDriverTerritoryModal(devId, phone, lat, lng, scale) {
    try { if (window.event) window.event.stopPropagation(); } catch(e) {}
    document.getElementById('territory-target-devid').value = devId;
    document.getElementById('territory-target-phone').innerText = phone;
    const modal = document.getElementById('driver-territory-modal');
    if(!modal) return; modal.classList.remove('hidden');
    
    state.currentTerritoryScale = (scale && scale !== 'undefined' && scale !== '') ? scale : 'dong';
    window.setTerritoryScale(state.currentTerritoryScale, true); 

    setTimeout(() => {
        const container = document.getElementById('territory-map-container');
        if (!territoryMap) {
            territoryMap = new kakao.maps.Map(container, { center: new kakao.maps.LatLng(37.566826, 126.978656), level: 6 });
            kakao.maps.event.addListener(territoryMap, 'click', function(mouseEvent) { window.setTerritoryCenter(mouseEvent.latLng); });
        }
        territoryMap.relayout(); 
        
        if (territoryMarker) territoryMarker.setMap(null);
        territoryCircles.forEach(c => c.setMap(null)); territoryCircles = [];
        otherTerritoryOverlays.forEach(ov => ov.setMap(null)); otherTerritoryOverlays = [];

        if (lat && lng && lat !== 'undefined' && lng !== 'undefined' && lat !== '' && lng !== '') {
            const pos = new kakao.maps.LatLng(parseFloat(lat), parseFloat(lng));
            territoryMap.setCenter(pos); window.setTerritoryCenter(pos);
        } else {
            const savedBase = localStorage.getItem('deliveryProCompanyBase');
            if (savedBase) {
                const baseData = JSON.parse(savedBase);
                if (baseData.lat && baseData.lng) territoryMap.setCenter(new kakao.maps.LatLng(baseData.lat, baseData.lng));
            } else territoryMap.setCenter(new kakao.maps.LatLng(37.566826, 126.978656));
            const addrDisplayEl = document.getElementById('territory-selected-address');
            if(addrDisplayEl) addrDisplayEl.innerHTML = `<i class="fa-solid fa-location-crosshairs text-gray-400 mr-1"></i> 지도에 핀을 찍어주세요`;
        }
        
        const allDrivers = getFilteredVisibleDrivers();
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

        setTimeout(() => { if (territoryMap) territoryMap.relayout(); }, 200);
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
    if (!skipRedraw && territoryMarker) window.setTerritoryCenter(territoryMarker.getPosition());
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

    territoryMarker = new kakao.maps.Marker({ position: latLng });
    territoryMarker.setMap(territoryMap);

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
        window.closeDriverTerritoryModal();
        window.renderDispatchDriverList();
    } catch(e) { alert("저장 오류: " + e.message); }
}

export function openAllTerritoriesMap() {
    const modal = document.getElementById('all-territories-modal');
    if (!modal) return; modal.classList.remove('hidden');

    setTimeout(() => {
        const container = document.getElementById('all-territories-map-container');
        if (!allTerritoriesMap) { allTerritoriesMap = new kakao.maps.Map(container, { center: new kakao.maps.LatLng(37.566826, 126.978656), level: 8 }); }
        allTerritoriesMap.relayout();
        
        allTerritoriesOverlays.forEach(ov => ov.setMap(null)); allTerritoriesOverlays = [];

        const allDrivers = getFilteredVisibleDrivers();
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
                if (scale === 'dong') { r1 = 1500; r2 = 3000; r3 = 5000; } else if (scale === 'gu') { r1 = 5000; r2 = 10000; r3 = 15000; } else if (scale === 'si') { r1 = 15000; r2 = 30000; r3 = 45000; }

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
            if (savedBase) { const baseData = JSON.parse(savedBase); if (baseData.lat && baseData.lng) allTerritoriesMap.setCenter(new kakao.maps.LatLng(baseData.lat, baseData.lng)); }
        }
    }, 200);
}

export function closeAllTerritoriesMap() { document.getElementById('all-territories-modal')?.classList.add('hidden'); }

export function openExcelExportModal() {
    const today = getLocalDateString();
    document.getElementById('export-start-date').value = today;
    document.getElementById('export-end-date').value = today;
    document.getElementById('excel-export-modal').classList.remove('hidden');
}

export function closeExcelExportModal() {
    document.getElementById('excel-export-modal').classList.add('hidden');
}

export function executeExcelExport() {
    const startDateStr = document.getElementById('export-start-date').value;
    const endDateStr = document.getElementById('export-end-date').value;
    const isCompleted = document.getElementById('chk-export-completed').checked;
    const isPending = document.getElementById('chk-export-pending').checked;
    const isCanceled = document.getElementById('chk-export-canceled').checked;

    if (!startDateStr || !endDateStr) { alert("시작일과 종료일을 모두 선택해주세요."); return; }
    if (startDateStr > endDateStr) { alert("시작일이 종료일보다 클 수 세 없습니다. 날짜를 다시 확인해주세요."); return; }
    if (!isPending && !isCompleted && !isCanceled) { alert("출력할 데이터를 하나 이상 선택해주세요."); return; }

    const startTs = new Date(`${startDateStr}T00:00:00`).getTime();
    const endTs = new Date(`${endDateStr}T23:59:59`).getTime();

    const visibleLicenses = getFilteredVisibleDrivers();
    const visibleDeviceIds = visibleLicenses.map(l => l.deviceId || l.key);
    const visiblePhones = visibleLicenses.map(l => l.phone).filter(p => p);

    const wb = XLSX.utils.book_new();
    let hasData = false;

    if (isCompleted) {
        const targetCompletions = state.allCompletions.filter(c => {
            if (!c.completedAt) return false;
            const matchesDev = visibleDeviceIds.includes(c.deviceId) || (c.phone && visiblePhones.includes(c.phone));
            const inRange = c.completedAt >= startTs && c.completedAt <= endTs;
            const isCancelTag = c.tag && (c.tag.includes('취소') || c.tag.includes('반품') || c.tag.includes('거부'));
            return matchesDev && inRange && !isCancelTag;
        }).sort((a, b) => a.completedAt - b.completedAt);

        if (targetCompletions.length > 0) {
            hasData = true;
            const excelData = [["순번", "완료 일시", "기사 연락처", "배송지 주소", "고객 번호", "처리 상태", "사진 링크"]];
            
            targetCompletions.forEach((c, idx) => {
                const dt = new Date(c.completedAt);
                const dStr = `${dt.getFullYear()}.${String(dt.getMonth()+1).padStart(2,'0')}.${String(dt.getDate()).padStart(2,'0')} ${dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
                excelData.push([
                    idx + 1, dStr, c.phone || '연락처 없음', c.address || '', c.customerPhone || '미등록', c.tag || '전달완료', c.photoUrl || '사진 없음'
                ]);
            });
            const ws = XLSX.utils.aoa_to_sheet(excelData);
            ws['!cols'] = [{wch:6}, {wch:20}, {wch:15}, {wch:45}, {wch:15}, {wch:12}, {wch:60}];
            XLSX.utils.book_append_sheet(wb, ws, "배송완료");
        }
    }

    if (isPending) {
        let pendingList = [];
        for (const devId in state.activeRoutes) {
            if (!visibleDeviceIds.includes(devId)) continue;
            const driver = state.activeRoutes[devId];
            if (!driver || !driver.updatedAt) continue;

            if (driver.updatedAt >= startTs && driver.updatedAt <= endTs) {
                const dests = driver.destinations || [];
                dests.forEach(d => {
                    const isDone = state.allCompletions.some(c => c.deviceId === devId && c.address === d.address && c.completedAt >= startTs && c.completedAt <= endTs);
                    if (!isDone) {
                        pendingList.push({ ...d, driverPhone: driver.phone || '미등록', updatedAt: driver.updatedAt });
                    }
                });
            }
        }

        if (pendingList.length > 0) {
            hasData = true;
            const excelData = [["순번(코스)", "최종 업데이트", "기사 연락처", "배송지 주소", "처리 상태"]];
            pendingList.forEach((p, idx) => {
                const dt = new Date(p.updatedAt);
                const dStr = `${dt.getFullYear()}.${String(dt.getMonth()+1).padStart(2,'0')}.${String(dt.getDate()).padStart(2,'0')} ${dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
                excelData.push([
                    p.displayNumber || idx + 1, dStr, p.driverPhone, p.address || '', '대기(이동중)'
                ]);
            });
            const ws = XLSX.utils.aoa_to_sheet(excelData);
            ws['!cols'] = [{wch:10}, {wch:20}, {wch:15}, {wch:45}, {wch:12}];
            XLSX.utils.book_append_sheet(wb, ws, "대기동선");
        }
    }

    if (isCanceled) {
        const targetCanceled = state.allCompletions.filter(c => {
            if (!c.completedAt) return false;
            const matchesDev = visibleDeviceIds.includes(c.deviceId) || (c.phone && visiblePhones.includes(c.phone));
            const inRange = c.completedAt >= startTs && c.completedAt <= endTs;
            const isCancelTag = c.tag && (c.tag.includes('취소') || c.tag.includes('반품') || c.tag.includes('거부'));
            return matchesDev && inRange && isCancelTag;
        }).sort((a, b) => a.completedAt - b.completedAt);

        if (targetCanceled.length > 0) {
            hasData = true;
            const excelData = [["순번", "취소 일시", "기사 연락처", "배송지 주소", "고객 번호", "취소 사유(태그)", "사진 링크"]];
            
            targetCanceled.forEach((c, idx) => {
                const dt = new Date(c.completedAt);
                const dStr = `${dt.getFullYear()}.${String(dt.getMonth()+1).padStart(2,'0')}.${String(dt.getDate()).padStart(2,'0')} ${dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
                excelData.push([
                    idx + 1, dStr, c.phone || '연락처 없음', c.address || '', c.customerPhone || '미등록', c.tag || '배송취소', c.photoUrl || '사진 없음'
                ]);
            });
            const ws = XLSX.utils.aoa_to_sheet(excelData);
            ws['!cols'] = [{wch:6}, {wch:20}, {wch:15}, {wch:45}, {wch:15}, {wch:20}, {wch:60}];
            XLSX.utils.book_append_sheet(wb, ws, "배송취소");
        }
    }

    if (!hasData) {
        alert(`지정하신 기간 (${startDateStr} ~ ${endDateStr}) 내에 다운로드할 수 있는 데이터가 없습니다.`);
        return;
    }

    const fileNameDate = startDateStr === endDateStr ? startDateStr : `${startDateStr}_to_${endDateStr}`;
    XLSX.writeFile(wb, `배송리포트_통합본_${fileNameDate}.xlsx`);
    closeExcelExportModal();
}

export function runAutoDispatchAlgorithm() { 
    alert("AI 자동 배차 로직은 다음 단계에서 적용될 예정입니다."); 
}

export function switchInvoiceTab() {}