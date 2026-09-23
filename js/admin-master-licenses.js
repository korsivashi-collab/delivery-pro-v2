// js/admin-master-licenses.js

import { db, generateSecureKey } from "./admin-api.js";
import { PAGE_SIZE_MASTER, renderPaginationControls } from "./admin-ui.js";
import { state, getLocalDateString } from "./admin-state.js";
import { doc, setDoc, getDoc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// ==========================================
// 1. 마스터 탭 및 계정 테이블 렌더링
// ==========================================
export function switchMasterTab(tab) {
    ['regular', 'trial', 'dispatch', 'memos', 'history', 'blocked'].forEach(t => {
        const btn = document.getElementById(`tab-btn-${t}`);
        const content = document.getElementById(`tab-content-${t}`);
        if (btn && content) {
            if (t === tab) {
                btn.className = "flex-1 min-w-[130px] py-2.5 text-xs font-black rounded-xl transition bg-white text-blue-600 shadow-sm border border-gray-200";
                content.classList.remove('hidden'); content.classList.add('flex');
            } else {
                btn.className = "flex-1 min-w-[130px] py-2.5 text-xs font-black rounded-xl transition text-gray-500 hover:bg-white/60";
                content.classList.add('hidden'); content.classList.remove('flex');
            }
        }
    });
    if (tab === 'history' && window.renderAccountHistoryView) window.renderAccountHistoryView();
    if (tab === 'blocked') renderBlockedDevicesTable();
}

export function changeMasterTabPagination(tabKey, targetPage) {
    if (!state.masterPages) state.masterPages = {};
    state.masterPages[tabKey] = targetPage;
    if (tabKey === 'memos' && window.renderMemosTable) window.renderMemosTable(state.allMemos);
    else if (tabKey === 'blocked') renderBlockedDevicesTable();
    else renderMasterTables();
}

export function renderMasterTables() {
    const regulars = state.allLicenses.filter(l => l.type === 'regular' || (!l.type && !l.isTrial && !(l.key || '').startsWith('TRIAL-')));
    const trials = state.allLicenses.filter(l => l.type === 'trial' || l.isTrial || (l.key || '').startsWith('TRIAL-'));
    const dispatches = state.allLicenses.filter(l => l.type === 'dispatch');
    const blockeds = state.allBlockedDevices || [];

    const cr = document.getElementById('count-regular');
    const ct = document.getElementById('count-trial');
    const cd = document.getElementById('count-dispatch');
    const cb = document.getElementById('count-blocked');
    if (cr) cr.innerText = regulars.length;
    if (ct) ct.innerText = trials.length;
    if (cd) cd.innerText = dispatches.length;
    if (cb) cb.innerText = blockeds.length;

    renderPagedTableTab('regular', regulars, 'table-body-regular', 'pagination-regular', (item, idx) => `
        <tr class="hover:bg-gray-50/80 transition">
            <td class="py-3 px-3 font-bold text-gray-400 text-center">${idx}</td>
            <td class="py-3 px-3 font-mono font-black text-blue-600 select-all">${item.key}</td>
            <td class="py-3 px-3 font-black text-gray-900">${item.phone || '<span class="text-gray-400 text-[11px] font-normal">로그인 대기</span>'}</td>
            <td class="py-3 px-3"><span class="font-mono text-[11px] text-gray-700">${item.deviceId || '미등록'}</span></td>
            <td class="py-3 px-3 font-bold">${item.expireDate || '-'}</td>
            <td class="py-3 px-3"><span class="px-2 py-0.5 rounded-full text-[10px] font-black ${item.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}">${item.status === 'active' ? '정상' : '정지'}</span></td>
            <td class="py-3 px-3 text-center space-x-1 whitespace-nowrap">
                <button onclick="window.openEditLicenseModal('${item.key}')" class="px-2.5 py-1 bg-blue-600 text-white font-black rounded-lg text-[11px]">수정</button>
                <button onclick="window.deleteLicense('${item.key}')" class="px-2 py-1 bg-red-50 text-red-700 font-bold rounded-lg text-[11px]">삭제</button>
            </td>
        </tr>
    `);

    renderPagedTableTab('trial', trials, 'table-body-trial', 'pagination-trial', (item, idx) => `
        <tr class="hover:bg-gray-50/80 transition">
            <td class="py-3 px-3 font-bold text-gray-400 text-center">${idx}</td>
            <td class="py-3 px-3 font-mono font-black text-emerald-600 select-all">${item.key}</td>
            <td class="py-3 px-3 font-black text-gray-900">${item.phone || '-'}</td>
            <td class="py-3 px-3"><span class="font-mono text-[11px] text-gray-700">${item.deviceId || '-'}</span></td>
            <td class="py-3 px-3 font-bold">${item.expireDate || '-'}</td>
            <td class="py-3 px-3"><span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full text-[10px] font-black">7일체험</span></td>
            <td class="py-3 px-3 text-center space-x-1 whitespace-nowrap">
                <button onclick="window.openEditLicenseModal('${item.key}')" class="px-2.5 py-1 bg-blue-600 text-white font-black rounded-lg text-[11px]">수정</button>
                <button onclick="window.deleteLicense('${item.key}')" class="px-2 py-1 bg-red-50 text-red-700 font-bold rounded-lg text-[11px]">삭제</button>
            </td>
        </tr>
    `);

    renderPagedTableTab('dispatch', dispatches, 'table-body-dispatch', 'pagination-dispatch', (item, idx) => {
        const connectedDrivers = state.allLicenses.filter(l => l.dispatchKey === item.key);
        const slotLimitStr = item.maxSlots ? `${item.maxSlots}대 한도` : '무제한';
        const proBadge = item.isPro ? `<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full text-[10px] font-black ml-1 border border-amber-300"><i class="fa-solid fa-crown text-amber-500"></i> PRO</span>` : ``;
        return `
        <tr class="hover:bg-gray-50/80 transition">
            <td class="py-3 px-3 font-bold text-gray-400 text-center">${idx}</td>
            <td class="py-3 px-3 font-mono font-black text-purple-600 select-all">${item.key}</td>
            <td class="py-3 px-3 font-black text-gray-900">${item.phone ? `<i class="fa-solid fa-phone text-blue-500 mr-1 text-[10px]"></i>${item.phone}` : '<span class="text-gray-400 text-[11px]">연락처 미등록</span>'}</td>
            <td class="py-3 px-3"><span class="font-mono text-[11px] text-gray-600">${item.deviceId ? `<i class="fa-solid fa-display text-blue-500 mr-1"></i>${item.deviceId}` : '오프라인'}</span></td>
            <td class="py-3 px-3">
                <span class="inline-flex items-center gap-1 font-black text-purple-700 bg-purple-50 px-2 py-0.5 rounded-lg border border-purple-200">
                    <i class="fa-solid fa-users text-[10px]"></i> ${connectedDrivers.length}명 연결
                </span>
                <span class="text-[10px] text-gray-400 block mt-0.5">(${slotLimitStr})</span>
            </td>
            <td class="py-3 px-3 font-bold">${item.expireDate || '-'}</td>
            <td class="py-3 px-3"><span class="bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full text-[10px] font-black">관제운영</span>${proBadge}</td>
            <td class="py-3 px-3 text-center space-x-1 whitespace-nowrap">
                <button onclick="window.open(window.location.pathname + '?monitor=' + '${item.key}', '_blank')" class="px-2.5 py-1 bg-emerald-600 text-white font-black rounded-lg text-[11px] hover:bg-emerald-700 transition">모니터링</button>
                <button onclick="window.openEditLicenseModal('${item.key}')" class="px-2.5 py-1 bg-blue-600 text-white font-black rounded-lg text-[11px] hover:bg-blue-700 transition">수정</button>
                <button onclick="window.deleteLicense('${item.key}')" class="px-2 py-1 bg-red-50 text-red-700 font-bold rounded-lg text-[11px] hover:bg-red-100 transition">삭제</button>
            </td>
        </tr>`;
    });

    renderBlockedDevicesTable();
}

function renderPagedTableTab(tabKey, list, tbodyId, paginationId, rowRenderer) {
    const tbody = document.getElementById(tbodyId);
    const pagEl = document.getElementById(paginationId);
    if (!tbody) return;

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="py-12 text-center text-gray-400 font-bold">등록된 내역이 없습니다.</td></tr>`;
        if (pagEl) pagEl.innerHTML = '';
        return;
    }

    const total = list.length;
    const totalPages = Math.ceil(total / PAGE_SIZE_MASTER) || 1;
    if (!state.masterPages) state.masterPages = {};
    let curPage = state.masterPages[tabKey] || 1;
    if (curPage > totalPages) curPage = totalPages;
    if (curPage < 1) curPage = 1;
    state.masterPages[tabKey] = curPage;

    const start = (curPage - 1) * PAGE_SIZE_MASTER;
    const pagedList = list.slice(start, start + PAGE_SIZE_MASTER);

    tbody.innerHTML = pagedList.map((item, idx) => rowRenderer(item, start + idx + 1)).join('');
    if (pagEl) {
        pagEl.innerHTML = renderPaginationControls(tabKey, curPage, total, PAGE_SIZE_MASTER, 'window.changeMasterTabPagination');
    }
}

// ==========================================
// 🌟 2. 접속 제한(블랙리스트) 기기 관리 CRUD
// ==========================================
export function renderBlockedDevicesTable() {
    const tbody = document.getElementById('table-body-blocked');
    const pagEl = document.getElementById('pagination-blocked');
    const countBadge = document.getElementById('count-blocked');
    if (!tbody) return;

    const blockeds = state.allBlockedDevices || [];
    if (countBadge) countBadge.innerText = blockeds.length;

    if (blockeds.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-16 text-center text-gray-400 font-bold text-xs">제한 등록된 기기 고유번호가 없습니다.</td></tr>`;
        if (pagEl) pagEl.innerHTML = '';
        return;
    }

    const total = blockeds.length;
    const totalPages = Math.ceil(total / PAGE_SIZE_MASTER) || 1;
    if (!state.masterPages) state.masterPages = {};
    let curPage = state.masterPages['blocked'] || 1;
    if (curPage > totalPages) curPage = totalPages;
    if (curPage < 1) curPage = 1;
    state.masterPages['blocked'] = curPage;

    const start = (curPage - 1) * PAGE_SIZE_MASTER;
    const pagedList = blockeds.slice(start, start + PAGE_SIZE_MASTER);

    tbody.innerHTML = pagedList.map((item, idx) => {
        let dateDisplay = '-';
        if (item.createdAt) {
            const dt = new Date(item.createdAt);
            dateDisplay = `${getLocalDateString(dt)} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
        }
        return `
        <tr class="hover:bg-rose-50/50 transition">
            <td class="py-3.5 px-3 font-bold text-gray-400 text-center">${start + idx + 1}</td>
            <td class="py-3.5 px-3 font-mono font-black text-rose-600 select-all">${item.deviceId}</td>
            <td class="py-3.5 px-3 font-bold text-gray-800">${item.memo || '<span class="text-gray-400 font-normal">사유 미입력</span>'}</td>
            <td class="py-3.5 px-3 text-center text-gray-500 font-mono text-[11px]">${dateDisplay}</td>
            <td class="py-3.5 px-3 text-center">
                <span class="inline-flex items-center gap-1 bg-rose-100 text-rose-800 px-2.5 py-0.5 rounded-full text-[10px] font-black border border-rose-200 shadow-2xs">
                    <i class="fa-solid fa-ban text-[9px]"></i> 물리적 접근 제한
                </span>
            </td>
            <td class="py-3.5 px-3 text-center whitespace-nowrap">
                <button type="button" onclick="window.unblockDevice('${item.deviceId}')" class="px-3 py-1 bg-white hover:bg-rose-50 text-gray-700 hover:text-rose-700 border border-gray-300 hover:border-rose-300 font-bold rounded-lg text-[11px] transition shadow-2xs active:scale-95">
                    제한 해제
                </button>
            </td>
        </tr>`;
    }).join('');

    if (pagEl) {
        pagEl.innerHTML = renderPaginationControls('blocked', curPage, total, PAGE_SIZE_MASTER, 'window.changeMasterTabPagination');
    }
}

export async function addBlockedDevice() {
    const inputEl = document.getElementById('new-blocked-device-id');
    const memoEl = document.getElementById('new-blocked-device-memo');
    const devId = inputEl ? inputEl.value.trim() : '';
    const memo = memoEl ? memoEl.value.trim() : '';

    if (!devId) {
        alert("접속을 차단할 기기 고유번호(deviceId)를 입력해 주세요.");
        if (inputEl) inputEl.focus();
        return;
    }

    try {
        await setDoc(doc(db, "blocked_devices", devId), {
            deviceId: devId,
            memo: memo || '관리자 직접 제한 등록',
            createdAt: Date.now()
        });

        alert(`[접속 제한 등록 완료]\n\n기기 고유번호: ${devId}\n\n해당 기기로 접속 시 차단 안내 대신 '서버 통신 오류' 화면으로 위장 처리됩니다.`);
        if (inputEl) inputEl.value = '';
        if (memoEl) memoEl.value = '';
    } catch (e) {
        alert("기기 접속 제한 등록 오류: " + e.message);
    }
}

export async function unblockDevice(deviceId) {
    if (!deviceId) return;
    if (!confirm(`[${deviceId}] 기기의 접속 제한을 해제하시겠습니까?\n해제 즉시 해당 기기의 정상 접속이 허용됩니다.`)) return;

    try {
        await deleteDoc(doc(db, "blocked_devices", deviceId));
        alert("접속 제한이 성공적으로 해제되었습니다.");
    } catch (e) {
        alert("제한 해제 오류: " + e.message);
    }
}

export async function blockDeviceFromEditModal() {
    const devId = document.getElementById('edit-device-input')?.value.trim();
    const key = document.getElementById('edit-key-input')?.value.trim();

    if (!devId) {
        alert("해당 계정에 등록된 기기 고유번호(deviceId)가 없습니다.\n로그인한 이력이 없는 기기는 차단할 수 없습니다.");
        return;
    }

    if (!confirm(`기기 고유번호 [${devId}]를 접속 제한(블랙리스트) 목록에 등록하시겠습니까?\n\n등록 시 해당 기기는 다음 접속부터 서버 통신 오류 화면으로 표시되어 본인이 차단된 줄 모르게 됩니다.`)) {
        return;
    }

    try {
        await setDoc(doc(db, "blocked_devices", devId), {
            deviceId: devId,
            memo: `계정 [${key || '미확인'}] 수정창에서 등록`,
            createdAt: Date.now()
        });
        alert(`[${devId}] 기기가 접속 제한 목록에 등록되었습니다.`);
    } catch (e) {
        alert("제한 등록 오류: " + e.message);
    }
}

// ==========================================
// 3. 라이선스(계정) 관리 및 모달 CRUD 로직
// ==========================================
export async function generateNewLicense() {
    const type = document.getElementById('new-key-type').value;
    const expireDate = document.getElementById('new-key-expire').value;
    if (!expireDate) { alert("만료일을 선택해 주세요."); return; }
    const newKey = generateSecureKey();
    const typeName = (type === 'dispatch') ? '관제 계정' : '일반 계정';
    try {
        await setDoc(doc(db, "licenses", newKey), {
            key: newKey, type: type, phone: "", 
            expireDate: expireDate.replace(/-/g, '.'),
            deviceId: "", status: "active",
            maxSlots: (type === 'dispatch' ? 20 : 0),
            isPro: false,
            createdAt: Date.now()
        });
        alert(`[${typeName} 발급 완료]\n키: ${newKey}`);
    } catch (e) { alert("오류: " + e.message); }
}

export function openEditLicenseModal(key) {
    const target = state.allLicenses.find(l => l.key === key);
    if (!target) return;
    document.getElementById('edit-orig-key').value = target.key;
    document.getElementById('edit-type').value = target.type || 'regular';
    document.getElementById('edit-key-input').value = target.key;
    document.getElementById('edit-phone-input').value = target.phone || '';
    document.getElementById('edit-device-input').value = target.deviceId || '';
    
    let expFormatted = '';
    if (target.expireDate && target.expireDate.includes('.')) expFormatted = target.expireDate.replace(/\./g, '-');
    else if (target.expireDate) expFormatted = target.expireDate;
    
    document.getElementById('edit-expire-input').value = expFormatted;
    document.getElementById('edit-status-select').value = target.status || 'active';

    const slotsBox = document.getElementById('edit-slots-container');
    const dispatchSec = document.getElementById('edit-dispatch-connected-section');

    if (target.type === 'dispatch') {
        if (slotsBox) slotsBox.classList.remove('hidden');
        document.getElementById('edit-slots-input').value = target.maxSlots || 0;
        if (dispatchSec) { dispatchSec.classList.remove('hidden'); dispatchSec.classList.add('flex'); }
        const addInput = document.getElementById('modal-add-driver-input');
        if (addInput) addInput.value = '';
        renderModalConnectedDrivers(target.key);
    } else {
        if (slotsBox) slotsBox.classList.add('hidden');
        if (dispatchSec) { dispatchSec.classList.add('hidden'); dispatchSec.classList.remove('flex'); }
    }
    document.getElementById('edit-license-modal').classList.remove('hidden');
}

export function closeEditModal() { 
    document.getElementById('edit-license-modal').classList.add('hidden'); 
}

export function renderModalConnectedDrivers(dispatchKey) {
    const listEl = document.getElementById('modal-connected-drivers-list');
    const badgeEl = document.getElementById('modal-connected-count-badge');
    if (!listEl) return;
    const targetDispatch = state.allLicenses.find(l => l.key === dispatchKey);
    const connectedDrivers = state.allLicenses.filter(l => l.dispatchKey === dispatchKey);

    if (badgeEl) {
        const max = targetDispatch && targetDispatch.maxSlots ? targetDispatch.maxSlots : '무제한';
        badgeEl.innerText = `${connectedDrivers.length}명 연결됨 (최대 ${max}대)`;
    }

    if (connectedDrivers.length === 0) {
        listEl.innerHTML = `<div class="text-center text-gray-400 py-6 text-xs font-bold bg-white rounded-xl border border-dashed border-gray-300">연결된 소속 기사가 없습니다. 상단에서 기사를 추가해 주세요.</div>`;
        return;
    }

    let html = '';
    connectedDrivers.forEach(d => {
        html += `
        <div class="flex items-center justify-between p-2.5 bg-white border border-purple-200 rounded-xl text-xs shadow-2xs">
            <div class="flex items-center gap-2 min-w-0 flex-1">
                <i class="fa-solid fa-truck text-purple-600 text-[11px] shrink-0"></i>
                <span class="font-black text-gray-800 truncate">${d.phone || '연락처 미등록'}</span>
                <span class="text-[10px] text-gray-400 font-mono shrink-0">[${d.key}]</span>
            </div>
            <button type="button" onclick="window.unlinkDriverFromModal('${d.key}')" class="text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 px-2 py-1 rounded-lg text-[10px] font-bold transition active:scale-95 shrink-0 ml-2 flex items-center gap-1">
                <i class="fa-solid fa-link-slash text-[9px]"></i> 연결 해제
            </button>
        </div>`;
    });
    listEl.innerHTML = html;
}

export async function linkDriverFromModal() {
    const dispatchKey = document.getElementById('edit-orig-key').value;
    const inputEl = document.getElementById('modal-add-driver-input');
    const rawVal = inputEl ? inputEl.value.trim().toUpperCase() : '';

    if (!rawVal) { alert("연결할 기사의 8자리 키 또는 전화번호를 입력해 주세요."); if (inputEl) inputEl.focus(); return; }

    const dispatchLic = state.allLicenses.find(l => l.key === dispatchKey);
    const connectedDrivers = state.allLicenses.filter(l => l.dispatchKey === dispatchKey);
    if (dispatchLic && dispatchLic.maxSlots > 0 && connectedDrivers.length >= dispatchLic.maxSlots) {
        alert(`관제 허용 슬롯(${dispatchLic.maxSlots}대)을 모두 채웠습니다.\n기사를 더 연결하려면 상단 슬롯 수를 늘려주세요.`); return;
    }

    const cleanDigits = rawVal.replace(/[^0-9]/g, '');
    const rawKeyOnly = rawVal.replace(/^(PRO|TRIAL|CTRL)-/i, '');
    let targetLic = state.allLicenses.find(l => {
        if (l.type === 'dispatch') return false;
        const lKey = (l.key || '').toUpperCase();
        const lPhone = (l.phone || '').replace(/[^0-9]/g, '');
        const lRawKey = lKey.replace(/^(PRO|TRIAL|CTRL)-/i, '');
        return lKey === rawVal || lRawKey === rawKeyOnly || (cleanDigits.length >= 8 && lPhone === cleanDigits);
    });

    if (!targetLic) {
        try {
            let snap = await getDoc(doc(db, "licenses", rawVal));
            if (!snap.exists()) snap = await getDoc(doc(db, "licenses", `TRIAL-${rawVal}`));
            if (!snap.exists()) snap = await getDoc(doc(db, "licenses", `PRO-${rawVal}`));
            if (snap.exists()) targetLic = { id: snap.id, ...snap.data() };
        } catch(e) {}
    }

    if (!targetLic) { alert("해당 기사 계정을 찾을 수 없습니다."); return; }
    if (targetLic.dispatchKey === dispatchKey) { alert("이미 본 관제 계정에 연결되어 있는 기사입니다."); return; }
    if (targetLic.dispatchKey && targetLic.dispatchKey !== dispatchKey) {
        if (!confirm(`해당 기사는 현재 다른 관제소([${targetLic.dispatchKey}])에 소속되어 있습니다.\n본 관제 계정([${dispatchKey}])으로 소속을 이전하시겠습니까?`)) return;
    }

    try {
        await updateDoc(doc(db, "licenses", targetLic.key || targetLic.id), { dispatchKey: dispatchKey });
        alert(`기사 [${targetLic.phone || targetLic.key}] 님이 성공적으로 연결되었습니다.`);
        if (inputEl) inputEl.value = '';
        renderModalConnectedDrivers(dispatchKey);
    } catch(e) { alert("기사 연결 처리 오류: " + e.message); }
}

export async function unlinkDriverFromModal(driverKey) {
    const dispatchKey = document.getElementById('edit-orig-key').value;
    const driver = state.allLicenses.find(l => l.key === driverKey);
    const name = driver?.phone || driverKey;
    if (!confirm(`[${name}] 기사를 관제 연결에서 해제하시겠습니까?`)) return;
    try {
        await updateDoc(doc(db, "licenses", driverKey), { dispatchKey: "" });
        alert(`[${name}] 기사의 관제 연결이 해제되었습니다.`);
        renderModalConnectedDrivers(dispatchKey);
    } catch(e) { alert("연결 해제 오류: " + e.message); }
}

export async function saveLicenseEdit() {
    const origKey = document.getElementById('edit-orig-key').value;
    const newKey = document.getElementById('edit-key-input').value.trim().toUpperCase();
    const phone = document.getElementById('edit-phone-input').value.trim();
    const deviceId = document.getElementById('edit-device-input').value.trim();
    const expireDate = document.getElementById('edit-expire-input').value;
    const status = document.getElementById('edit-status-select').value;
    const type = document.getElementById('edit-type').value;

    if (!newKey) { alert("라이선스 키를 입력해 주세요."); return; }
    if (!expireDate) { alert("만료일을 선택해 주세요."); return; }

    const expStr = expireDate.replace(/-/g, '.');
    const target = state.allLicenses.find(l => l.key === origKey);
    const updatePayload = {
        key: newKey, phone: phone, expireDate: expStr, status: status, type: type, deviceId: deviceId,
        dispatchKey: target ? target.dispatchKey || '' : '',
        maxSlots: type === 'dispatch' ? parseInt(document.getElementById('edit-slots-input')?.value) || 0 : 0
    };

    try {
        if (newKey !== origKey) {
            await setDoc(doc(db, "licenses", newKey), updatePayload);
            await deleteDoc(doc(db, "licenses", origKey));
            if (type === 'dispatch') {
                const linked = state.allLicenses.filter(l => l.dispatchKey === origKey);
                for (const l of linked) await updateDoc(doc(db, "licenses", l.key), { dispatchKey: newKey });
            }
        } else {
            await updateDoc(doc(db, "licenses", origKey), updatePayload);
        }
        alert("계정 정보가 성공적으로 수정되었습니다.");
        closeEditModal();
    } catch (e) { alert("오류: " + e.message); }
}

export async function deleteLicense(key) {
    const target = state.allLicenses.find(l => l.key === key);
    if (!confirm(`정말 [${key}] 계정을 영구 삭제하시겠습니까?`)) return;
    try {
        await deleteDoc(doc(db, "licenses", key));
        if (target && target.deviceId) {
            try { await deleteDoc(doc(db, "routes", target.deviceId)); } catch(e){}
        }
        if (target && target.type === 'dispatch') {
            const linked = state.allLicenses.filter(l => l.dispatchKey === key);
            for (const l of linked) await updateDoc(doc(db, "licenses", l.key), { dispatchKey: "" });
        }
        alert(`[${key}] 계정이 삭제되었습니다.`);
        if (state.currentSelectedAccountKey === key && window.backToAllAccountsView) window.backToAllAccountsView();
    } catch (e) { alert("삭제 오류: " + e.message); }
}

export async function deleteLicenseFromModal() {
    const origKey = document.getElementById('edit-orig-key').value;
    if (!origKey) return;
    closeEditModal();
    await deleteLicense(origKey);
}

// ==========================================
// 4. HTML 인라인 바인딩용 Window 객체 매핑
// ==========================================
window.switchMasterTab = switchMasterTab;
window.changeMasterTabPagination = changeMasterTabPagination;
window.renderMasterTables = renderMasterTables;
window.renderBlockedDevicesTable = renderBlockedDevicesTable;
window.addBlockedDevice = addBlockedDevice;
window.unblockDevice = unblockDevice;
window.blockDeviceFromEditModal = blockDeviceFromEditModal;
window.generateNewLicense = generateNewLicense;
window.openEditLicenseModal = openEditLicenseModal;
window.closeEditModal = closeEditModal;
window.renderModalConnectedDrivers = renderModalConnectedDrivers;
window.linkDriverFromModal = linkDriverFromModal;
window.unlinkDriverFromModal = unlinkDriverFromModal;
window.saveLicenseEdit = saveLicenseEdit;
window.deleteLicense = deleteLicense;
window.deleteLicenseFromModal = deleteLicenseFromModal;