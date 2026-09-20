// js/admin-master-history.js

import { db } from "./admin-api.js";
import { PAGE_SIZE_MASTER, renderPaginationControls } from "./admin-ui.js";
import { state, getLocalDateString, todayStr } from "./admin-state.js";
import { doc, getDoc, updateDoc, deleteDoc, addDoc, collection } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { deleteLicense } from "./admin-master-licenses.js";

// ==========================================
// 1. 계정 / 내역 조회 및 운영사 알림 발송 모듈
// ==========================================

export function setHistorySort(field) {
    if (state.historySortField === field) state.historySortAsc = !state.historySortAsc;
    else { state.historySortField = field; state.historySortAsc = true; }
    renderAccountHistoryView();
}

export function setHistoryAccountTypeFilter(type) {
    state.historyAccountTypeFilter = type;
    state.historyCurrentPage = 1;
    ['ALL', 'regular', 'trial', 'dispatch'].forEach(t => {
        const btn = document.getElementById(`htype-btn-${t}`);
        if (btn) {
            btn.className = (t === type)
                ? "px-3 py-1 rounded-lg text-xs font-black bg-blue-600 text-white shadow-xs transition"
                : "px-3 py-1 rounded-lg text-xs font-black text-gray-500 hover:bg-gray-100 transition";
        }
    });
    renderAccountHistoryView();
}

export function populateDriverSelect() {
    const selectEl = document.getElementById('history-driver-select');
    if (!selectEl) return;
    const prevVal = selectEl.value;
    let html = `<option value="ALL">전체 계정 확인 (목록 보기)</option>`;
    state.allLicenses.forEach(l => {
        const typeTag = l.type === 'dispatch' ? '[관제]' : (l.type === 'trial' ? '[체험]' : '[일반]');
        html += `<option value="${l.key}">${typeTag} ${l.phone || '번호미등록'} [${l.key}]</option>`;
    });
    selectEl.innerHTML = html;
    if (prevVal && selectEl.querySelector(`option[value="${prevVal}"]`)) selectEl.value = prevVal;
}

export function filterDriverDropdown(query) {
    state.historyCurrentPage = 1;
    const q = query.trim().toLowerCase();
    const selectEl = document.getElementById('history-driver-select');
    if (!selectEl) return;
    if (!q) { populateDriverSelect(); return; }
    let html = `<option value="ALL">전체 계정 확인 (목록 보기)</option>`;
    state.allLicenses.filter(l => (l.phone && l.phone.includes(q)) || l.key.toLowerCase().includes(q)).forEach(l => {
        const typeTag = l.type === 'dispatch' ? '[관제]' : (l.type === 'trial' ? '[체험]' : '[일반]');
        html += `<option value="${l.key}">${typeTag} ${l.phone || '번호미등록'} [${l.key}]</option>`;
    });
    selectEl.innerHTML = html;
    renderAccountHistoryView();
}

export function onDriverSelectChange(val) {
    if (val === 'ALL') backToAllAccountsView();
    else selectAccountDirectly(val);
}

export function selectAccountDirectly(key) {
    if (state.historyNoticeMode) {
        toggleHistoryItemSelection(key, !state.historySelectedAccountKeys.has(key));
        return;
    }
    document.getElementById('history-driver-select').value = key;
    renderAccountHistoryView();
}

export function backToAllAccountsView() {
    state.currentSelectedAccountKey = '';
    state.historyCurrentPage = 1;
    const sel = document.getElementById('history-driver-select');
    if (sel) sel.value = 'ALL';
    const searchInput = document.getElementById('history-driver-search');
    if (searchInput) searchInput.value = '';
    populateDriverSelect();
    renderAccountHistoryView();
}

export function changeHistoryPage(page) {
    state.historyCurrentPage = page;
    renderAccountHistoryView();
}

export function toggleHistoryNoticeMode(forceState) {
    if (forceState !== undefined) state.historyNoticeMode = forceState;
    else state.historyNoticeMode = !state.historyNoticeMode;

    const btn = document.getElementById('btn-toggle-history-notice');
    const bar = document.getElementById('history-notice-send-bar');

    if (state.historyNoticeMode) {
        if (btn) btn.className = "px-3.5 py-1.5 rounded-xl text-xs font-black bg-amber-500 text-white shadow-md transition active:scale-95 flex items-center gap-1.5";
        if (bar) { bar.classList.remove('hidden'); bar.classList.add('flex'); }
    } else {
        if (btn) btn.className = "px-3.5 py-1.5 rounded-xl text-xs font-black bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-300 shadow-2xs transition active:scale-95 flex items-center gap-1.5";
        if (bar) { bar.classList.add('hidden'); bar.classList.remove('flex'); }
        state.historySelectedAccountKeys.clear();
    }
    updateHistorySelectedCount();
    renderAccountHistoryView();
}

export function toggleHistoryItemSelection(key, isChecked) {
    if (isChecked) state.historySelectedAccountKeys.add(key);
    else state.historySelectedAccountKeys.delete(key);
    updateHistorySelectedCount();
    renderAccountHistoryView();
}

export function toggleHistorySelectAll(isChecked) {
    let filteredList = state.allLicenses;
    if (state.historyAccountTypeFilter !== 'ALL') filteredList = state.allLicenses.filter(l => l.type === state.historyAccountTypeFilter);
    if (isChecked) filteredList.forEach(l => state.historySelectedAccountKeys.add(l.key));
    else state.historySelectedAccountKeys.clear();
    updateHistorySelectedCount();
    renderAccountHistoryView();
}

export function updateHistorySelectedCount() {
    const countEl = document.getElementById('history-selected-count');
    if (countEl) countEl.innerText = state.historySelectedAccountKeys.size;
}

export async function sendHistoryNoticeToSelected() {
    if (state.historySelectedAccountKeys.size === 0) { alert("알림을 보낼 대상 계정을 최소 1개 이상 선택해 주세요."); return; }
    const inputEl = document.getElementById('history-notice-input');
    const content = inputEl ? inputEl.value.trim() : '';
    if (!content) { alert("알림 내용을 입력해 주세요."); if (inputEl) inputEl.focus(); return; }

    const btn = document.getElementById('btn-send-history-notice');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 발송 중...'; }

    const targetDeviceIds = [];
    const targetPhones = [];
    state.historySelectedAccountKeys.forEach(key => {
        const lic = state.allLicenses.find(l => l.key === key);
        targetDeviceIds.push(key);
        if (lic) {
            if (lic.deviceId) targetDeviceIds.push(lic.deviceId);
            if (lic.phone) targetPhones.push(lic.phone);
        }
    });

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dateStr = getLocalDateString(now);

    try {
        await addDoc(collection(db, "dispatch_messages"), {
            senderKey: "MASTER", senderType: "MASTER", senderTitle: "운영사 알림",
            targetDeviceIds: Array.from(new Set(targetDeviceIds)),
            targetPhones: Array.from(new Set(targetPhones)),
            content: content, createdAt: now.getTime(), dateStr: dateStr, timeStr: timeStr, acknowledged: []
        });
        alert(`총 ${state.historySelectedAccountKeys.size}개 계정에 [운영사 알림]이 성공적으로 전송되었습니다.`);
        if (inputEl) inputEl.value = '';
        toggleHistoryNoticeMode(false);
    } catch (e) {
        alert("알림 발송 오류: " + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> 알림 전송'; }
    }
}

export function setHistoryMasterSubTab(tab) {
    state.historyMasterSubTab = tab;
    renderAccountHistoryView();
}

export async function deleteAccountFromHistory() {
    if (!state.currentSelectedAccountKey) return;
    const key = state.currentSelectedAccountKey;
    if (!confirm(`정말 [${key}] 계정을 완전히 영구 삭제하시겠습니까?`)) return;
    await deleteLicense(key);
    backToAllAccountsView();
}

export function renderAccountHistoryView() {
    const selectEl = document.getElementById('history-driver-select');
    const selectedKey = selectEl ? selectEl.value : 'ALL';
    const listEl = document.getElementById('account-history-main-content');
    const profileCardEl = document.getElementById('account-profile-card');
    const topFilterBarEl = document.getElementById('history-top-filter-bar');
    const backBarEl = document.getElementById('account-back-bar');
    if (!listEl) return;

    const hAll = document.getElementById('htype-count-all');
    const hReg = document.getElementById('htype-count-reg');
    const hTr = document.getElementById('htype-count-trial');
    const hDisp = document.getElementById('htype-count-dispatch');
    if (hAll) hAll.innerText = state.allLicenses.length;
    if (hReg) hReg.innerText = state.allLicenses.filter(l => l.type === 'regular' || (!l.type && !l.isTrial)).length;
    if (hTr) hTr.innerText = state.allLicenses.filter(l => l.type === 'trial' || l.isTrial).length;
    if (hDisp) hDisp.innerText = state.allLicenses.filter(l => l.type === 'dispatch').length;

    if (selectedKey === 'ALL') {
        state.currentSelectedAccountKey = '';
        if (profileCardEl) { profileCardEl.classList.add('hidden'); profileCardEl.classList.remove('flex'); }
        if (backBarEl) { backBarEl.classList.remove('hidden'); backBarEl.classList.add('flex'); }
        if (topFilterBarEl) topFilterBarEl.classList.remove('hidden');

        let filteredList = state.allLicenses;
        if (state.historyAccountTypeFilter !== 'ALL') {
            filteredList = state.allLicenses.filter(l => l.type === state.historyAccountTypeFilter);
        }

        if (filteredList.length === 0) {
            listEl.innerHTML = `<div class="text-center text-gray-400 py-24 text-xs font-bold">해당 조건의 계정이 없습니다.</div>`;
            return;
        }

        const processedItems = filteredList.map((lic, idx) => {
            const devId = lic.deviceId || '';
            const phone = lic.phone || '';
            const driverComps = state.allCompletions.filter(c => (devId && c.deviceId === devId) || (phone && c.phone === phone));
            const totalCompCount = driverComps.length;
            const activeDatesSet = new Set();
            driverComps.forEach(c => {
                let d = '';
                if (c.timeString && c.timeString.includes(' ')) d = c.timeString.split(' ')[0].replace(/\./g, '-');
                else if (c.completedAt) d = getLocalDateString(new Date(c.completedAt));
                if (d) activeDatesSet.add(d);
            });
            if (state.activeRoutes[devId] && state.activeRoutes[devId].destinations && state.activeRoutes[devId].destinations.length > 0) activeDatesSet.add(todayStr);
            const routeRegCount = (lic.type === 'dispatch') ? 0 : activeDatesSet.size;
            const memoCount = state.allMemos.filter(m => devId && m.deviceId === devId).length;

            return {
                originalIndex: idx + 1, type: lic.type || 'regular', key: lic.key, phone: phone, deviceId: devId,
                routeCount: routeRegCount, compCount: totalCompCount, memoCount: memoCount, expireDate: lic.expireDate || '', status: lic.status || 'active'
            };
        });

        processedItems.sort((a, b) => {
            let vA = a[state.historySortField];
            let vB = b[state.historySortField];
            if (typeof vA === 'string') return state.historySortAsc ? vA.localeCompare(vB) : vB.localeCompare(a);
            else return state.historySortAsc ? (vA - vB) : (vB - vA);
        });

        const totalItems = processedItems.length;
        const totalPages = Math.ceil(totalItems / PAGE_SIZE_MASTER) || 1;
        if (state.historyCurrentPage > totalPages) state.historyCurrentPage = totalPages;
        if (state.historyCurrentPage < 1) state.historyCurrentPage = 1;

        const startIndex = (state.historyCurrentPage - 1) * PAGE_SIZE_MASTER;
        const endIndex = Math.min(startIndex + PAGE_SIZE_MASTER, totalItems);
        const pagedItems = processedItems.slice(startIndex, endIndex);

        const getArrow = (f) => (state.historySortField === f ? (state.historySortAsc ? ' ▲' : ' ▼') : ' ↕');
        const isAllSelected = filteredList.length > 0 && filteredList.every(l => state.historySelectedAccountKeys.has(l.key));

        let checkHeaderTh = state.historyNoticeMode 
            ? `<th class="py-3.5 px-3 text-center w-10 bg-amber-50/90 border-r border-amber-200">
                <input type="checkbox" onchange="window.toggleHistorySelectAll(this.checked)" ${isAllSelected ? 'checked' : ''} class="w-4 h-4 text-amber-600 rounded border-gray-300 focus:ring-amber-500 cursor-pointer" title="전체 선택">
               </th>` 
            : '';

        let tableHtml = `
        <div class="border border-gray-200 rounded-2xl bg-white shadow-xs overflow-hidden flex flex-col">
            <div class="overflow-x-auto custom-scrollbar">
                <table class="w-full text-left border-collapse text-xs whitespace-nowrap min-w-[1150px]">
                    <thead>
                        <tr class="border-b border-gray-200 text-gray-600 font-black bg-gray-50/80">
                            ${checkHeaderTh}
                            <th onclick="window.setHistorySort('originalIndex')" class="sortable-th py-3.5 px-3 text-center">순번${getArrow('originalIndex')}</th>
                            <th onclick="window.setHistorySort('type')" class="sortable-th py-3.5 px-3 min-w-[120px]">계정 유형${getArrow('type')}</th>
                            <th onclick="window.setHistorySort('key')" class="sortable-th py-3.5 px-3">라이선스 키${getArrow('key')}</th>
                            <th onclick="window.setHistorySort('phone')" class="sortable-th py-3.5 px-3">전화번호${getArrow('phone')}</th>
                            <th onclick="window.setHistorySort('deviceId')" class="sortable-th py-3.5 px-3">기기 고유번호 (deviceId)${getArrow('deviceId')}</th>
                            <th onclick="window.setHistorySort('routeCount')" class="sortable-th py-3.5 px-3 text-center">배송 리스트 등록 건수${getArrow('routeCount')}</th>
                            <th onclick="window.setHistorySort('compCount')" class="sortable-th py-3.5 px-3 text-center">총 완료 건수${getArrow('compCount')}</th>
                            <th onclick="window.setHistorySort('memoCount')" class="sortable-th py-3.5 px-3 text-center">작성 메모${getArrow('memoCount')}</th>
                            <th onclick="window.setHistorySort('expireDate')" class="sortable-th py-3.5 px-3">만료일${getArrow('expireDate')}</th>
                            <th class="py-3.5 px-4 text-center">관리 / 삭제</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100 font-medium text-gray-700">
        `;

        pagedItems.forEach(item => {
            let typeBadge = `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black whitespace-nowrap bg-blue-50 text-blue-700 border border-blue-200 shadow-xs"><i class="fa-solid fa-user text-[10px]"></i> 일반 계정</span>`;
            if (item.type === 'trial') typeBadge = `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black whitespace-nowrap bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-xs"><i class="fa-solid fa-clock text-[10px]"></i> 7일 체험</span>`;
            else if (item.type === 'dispatch') typeBadge = `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black whitespace-nowrap bg-purple-50 text-purple-700 border border-purple-200 shadow-xs"><i class="fa-solid fa-building-user text-[10px]"></i> 관제 계정</span>`;

            const isChecked = state.historySelectedAccountKeys.has(item.key);
            let checkRowTd = state.historyNoticeMode
                ? `<td class="py-3.5 px-3 text-center bg-amber-50/30 border-r border-amber-100" onclick="event.stopPropagation()">
                    <input type="checkbox" onchange="window.toggleHistoryItemSelection('${item.key}', this.checked)" ${isChecked ? 'checked' : ''} class="w-4 h-4 text-amber-600 rounded border-gray-300 focus:ring-amber-500 cursor-pointer">
                   </td>`
                : '';

            tableHtml += `
            <tr onclick="window.selectAccountDirectly('${item.key}')" class="hover:bg-blue-50/60 cursor-pointer transition ${isChecked ? 'bg-amber-50/50' : ''}">
                ${checkRowTd}
                <td class="py-3.5 px-3 font-bold text-gray-400 text-center">${item.originalIndex}</td>
                <td class="py-3.5 px-3">${typeBadge}</td>
                <td class="py-3.5 px-3 font-mono font-black text-blue-600 select-all">${item.key}</td>
                <td class="py-3.5 px-3 font-black text-gray-900">${item.phone ? `<i class="fa-solid fa-phone text-blue-500 mr-1 text-[10px]"></i>${item.phone}` : '<span class="text-gray-400 text-[11px] font-normal">미등록</span>'}</td>
                <td class="py-3.5 px-3 font-mono text-gray-600 text-[11px]">${item.deviceId || '<span class="text-amber-500 font-bold">미등록</span>'}</td>
                <td class="py-3.5 px-3 text-center font-black ${item.type === 'dispatch' ? 'text-gray-400' : 'text-blue-600 bg-blue-50/30'}">${item.type === 'dispatch' ? '-' : item.routeCount + '일(건)'}</td>
                <td class="py-3.5 px-3 text-center font-black ${item.compCount > 0 ? 'text-emerald-600 bg-emerald-50/30' : 'text-gray-400'}">${item.compCount}건</td>
                <td class="py-3.5 px-3 text-center font-bold text-yellow-600">${item.memoCount}건</td>
                <td class="py-3.5 px-3 font-bold text-gray-500">${item.expireDate || '-'}</td>
                <td class="py-3.5 px-4 text-center whitespace-nowrap space-x-1.5">
                    <button onclick="event.stopPropagation(); window.selectAccountDirectly('${item.key}')" class="px-3 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 font-black rounded-lg text-[11px] transition shadow-2xs active:scale-95">내역 조회</button>
                    <button onclick="event.stopPropagation(); window.deleteLicense('${item.key}')" class="px-3 py-1 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 font-bold rounded-lg text-[11px] transition shadow-2xs active:scale-95">삭제</button>
                </td>
            </tr>`;
        });

        tableHtml += `</tbody></table></div>`;

        let pageBtnsHtml = '';
        for (let p = 1; p <= totalPages; p++) {
            if (p === 1 || p === totalPages || (p >= state.historyCurrentPage - 2 && p <= state.historyCurrentPage + 2)) {
                if (p === state.historyCurrentPage) {
                    pageBtnsHtml += `<button class="w-8 h-8 rounded-xl text-xs font-black bg-blue-600 text-white shadow-xs">${p}</button>`;
                } else {
                    pageBtnsHtml += `<button onclick="window.changeHistoryPage(${p})" class="w-8 h-8 rounded-xl text-xs font-bold text-gray-700 bg-white hover:bg-gray-100 border border-gray-200 transition active:scale-95">${p}</button>`;
                }
            } else if (p === state.historyCurrentPage - 3 || p === state.historyCurrentPage + 3) {
                pageBtnsHtml += `<span class="px-1 text-gray-400 text-xs font-bold">...</span>`;
            }
        }

        tableHtml += `
            <div class="flex flex-wrap items-center justify-between px-5 py-3 border-t border-gray-200 bg-gray-50/80 gap-2">
                <span class="text-xs text-gray-500 font-bold">총 <b class="text-blue-600 font-black">${totalItems}</b>개 계정 중 <b class="text-gray-900">${totalItems > 0 ? startIndex + 1 : 0} - ${endIndex}</b>번째 표시</span>
                <div class="flex items-center gap-1.5">
                    <button onclick="window.changeHistoryPage(${state.historyCurrentPage - 1})" ${state.historyCurrentPage === 1 ? 'disabled class="px-3 py-1.5 rounded-xl text-xs font-bold text-gray-300 bg-gray-100 cursor-not-allowed"' : 'class="px-3 py-1.5 rounded-xl text-xs font-bold text-gray-600 bg-white hover:bg-gray-100 border border-gray-200 shadow-2xs transition active:scale-95"'}>이전</button>
                    ${pageBtnsHtml}
                    <button onclick="window.changeHistoryPage(${state.historyCurrentPage + 1})" ${state.historyCurrentPage === totalPages ? 'disabled class="px-3 py-1.5 rounded-xl text-xs font-bold text-gray-300 bg-gray-100 cursor-not-allowed"' : 'class="px-3 py-1.5 rounded-xl text-xs font-bold text-gray-600 bg-white hover:bg-gray-100 border border-gray-200 shadow-2xs transition active:scale-95"'}>다음</button>
                </div>
            </div>
        </div>`;
        listEl.innerHTML = tableHtml;
        return;
    }

    const targetLic = state.allLicenses.find(l => l.key === selectedKey);
    if (!targetLic) { listEl.innerHTML = `<div class="text-center text-gray-400 py-28 text-xs font-bold">계정 정보를 찾을 수 없습니다.</div>`; return; }

    state.currentSelectedAccountKey = targetLic.key;
    if (topFilterBarEl) topFilterBarEl.classList.add('hidden');

    const targetPhone = targetLic.phone || '';
    const targetDeviceId = targetLic.deviceId || '';

    const labelEl = document.getElementById('top-selected-account-label');
    if (labelEl) labelEl.innerText = `${targetPhone || '연락처 미등록'} [${targetLic.key}]`;
    if (backBarEl) { backBarEl.classList.remove('hidden'); backBarEl.classList.add('flex'); }

    const phoneEl = document.getElementById('acc-phone');
    if (phoneEl) phoneEl.innerText = targetPhone || '연락처 미등록';
    const keyEl = document.getElementById('acc-key');
    if (keyEl) keyEl.innerText = targetLic.key;
    const deviceEl = document.getElementById('acc-device');
    if (deviceEl) deviceEl.innerText = targetDeviceId || '기기 미등록 (대기)';
    const expireEl = document.getElementById('acc-expire');
    if (expireEl) expireEl.innerText = `만료일: ${targetLic.expireDate || '-'}`;
    const statusBadge = document.getElementById('acc-status-badge');
    if (statusBadge) {
        statusBadge.innerText = targetLic.status === 'active' ? '정상' : '정지';
        statusBadge.className = targetLic.status === 'active' ? 'bg-emerald-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full' : 'bg-red-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full';
    }
    const typeBadge = document.getElementById('acc-type-badge');
    if (typeBadge) typeBadge.innerText = targetLic.type === 'dispatch' ? '관제 계정' : (targetLic.type === 'trial' ? '7일 무료 체험' : '일반 계정');

    if (profileCardEl) { profileCardEl.classList.remove('hidden'); profileCardEl.classList.add('flex'); }

    const driverRoute = (targetDeviceId && state.activeRoutes[targetDeviceId]) ? state.activeRoutes[targetDeviceId] : null;
    const rawDests = driverRoute ? driverRoute.destinations || [] : [];
    const driverDone = state.allCompletions.filter(c => (c.deviceId === targetDeviceId || (targetPhone && c.phone === targetPhone)));

    const doneMap = {}; driverDone.forEach(c => { doneMap[c.address] = c; });
    const remainingDests = rawDests.filter(d => !doneMap[d.address]);

    const pendingCount = remainingDests.length;
    const doneCount = driverDone.length;
    const totalCount = pendingCount + doneCount;
    const rate = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
    const driverMemos = state.allMemos.filter(m => targetDeviceId && m.deviceId === targetDeviceId);

    let html = `
    <div class="bg-blue-50 border border-blue-200 rounded-2xl p-3.5 shadow-inner mb-3 text-xs">
        <div class="flex justify-between items-center mb-1.5 text-blue-950 font-black">
            <span class="flex items-center gap-1.5"><i class="fa-solid fa-chart-pie text-blue-600"></i> 배송 진척도 요약</span>
            <span>완료 ${doneCount} / 전체 ${totalCount} 건 (${rate}%)</span>
        </div>
        <div class="w-full bg-white rounded-full h-2 overflow-hidden mb-2">
            <div class="bg-blue-600 h-2 rounded-full transition-all duration-500" style="width: ${rate}%"></div>
        </div>
        <div class="flex justify-between items-center text-[11px] font-bold text-blue-800 pt-1.5 border-t border-blue-200/50">
            <span>미배송 대기: <b class="text-blue-600 font-black">${pendingCount}</b>곳</span>
            <span>등록 공유 메모: <b class="text-yellow-600 font-black">${driverMemos.length}</b>건</span>
        </div>
    </div>

    <div class="flex gap-1.5 mb-4 bg-gray-100 p-1.5 rounded-2xl text-xs font-black">
        <button onclick="window.setHistoryMasterSubTab('ALL')" class="flex-1 py-2.5 rounded-xl transition ${state.historyMasterSubTab === 'ALL' ? 'bg-white text-blue-600 shadow-sm border border-gray-200' : 'text-gray-500 hover:text-gray-800'}">배송 리스트 (${totalCount})</button>
        <button onclick="window.setHistoryMasterSubTab('DONE')" class="flex-1 py-2.5 rounded-xl transition ${state.historyMasterSubTab === 'DONE' ? 'bg-white text-emerald-600 shadow-sm border border-gray-200' : 'text-gray-500 hover:text-gray-800'}">배송 완료 (${doneCount})</button>
        <button onclick="window.setHistoryMasterSubTab('PENDING')" class="flex-1 py-2.5 rounded-xl transition ${state.historyMasterSubTab === 'PENDING' ? 'bg-white text-blue-600 shadow-sm border border-gray-200' : 'text-gray-500 hover:text-gray-800'}">미배송 (${pendingCount})</button>
        <button onclick="window.setHistoryMasterSubTab('MEMOS')" class="flex-1 py-2.5 rounded-xl transition ${state.historyMasterSubTab === 'MEMOS' ? 'bg-white text-yellow-600 shadow-sm border border-gray-200' : 'text-gray-500 hover:text-gray-800'}">등록한 메모 (${driverMemos.length})</button>
    </div>
    <div class="space-y-3">`;

    if (state.historyMasterSubTab === 'ALL') {
        if (rawDests.length === 0) {
            html += `<div class="text-center text-gray-400 py-20 text-xs font-bold">등록된 배송 동선이 없습니다.</div>`;
        } else {
            html += `
            <div class="border border-blue-200 rounded-2xl overflow-hidden bg-white shadow-xs">
                <div onclick="document.getElementById('route-accordion-body').classList.toggle('hidden')" class="bg-blue-50 hover:bg-blue-100/70 p-3.5 flex justify-between items-center cursor-pointer transition select-none">
                    <span class="font-black text-xs text-blue-950 flex items-center gap-2"><i class="fa-solid fa-route text-blue-600"></i> 배송 동선 목록 (총 ${rawDests.length}개 목적지)</span>
                    <div class="flex items-center gap-2"><span class="text-[11px] text-blue-700 font-bold">클릭하여 펼치기/접기</span><i class="fa-solid fa-chevron-down text-blue-600 text-xs"></i></div>
                </div>
                <div id="route-accordion-body" class="hidden p-3 bg-slate-50 border-t border-blue-100 space-y-1.5">
            `;
            rawDests.forEach((dest, idx) => {
                const isDone = !!doneMap[dest.address];
                html += `
                <div class="p-3 ${isDone ? 'bg-emerald-50/50 border-emerald-200' : 'bg-white border-gray-200'} border rounded-xl flex items-center justify-between text-xs shadow-xs">
                    <div class="flex items-center gap-2.5 min-w-0 flex-1">
                        <span class="w-5 h-5 ${isDone ? 'bg-emerald-600' : 'bg-blue-600'} text-white rounded-full flex items-center justify-center font-black text-[10px] shrink-0">${dest.displayNumber || idx + 1}</span>
                        <span class="font-bold text-gray-900 truncate leading-snug">${dest.address}</span>
                    </div>
                    <span class="text-[10px] font-black px-2 py-0.5 rounded ${isDone ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-50 text-blue-700 border border-blue-200'} shrink-0 ml-2">${isDone ? '✓ 완료' : '대기'}</span>
                </div>`;
            });
            html += `</div></div>`;
        }
    } else if (state.historyMasterSubTab === 'DONE') {
        if (driverDone.length === 0) {
            html += `<div class="text-center text-gray-400 py-20 text-xs font-bold">배송 완료 내역이 없습니다.</div>`;
        } else {
            const completionsByDate = {};
            driverDone.forEach(c => {
                let dStr = '기타 일자';
                if (c.timeString && c.timeString.includes(' ')) dStr = c.timeString.split(' ')[0].replace(/\./g, '-');
                else if (c.completedAt) dStr = getLocalDateString(new Date(c.completedAt));
                if (!completionsByDate[dStr]) completionsByDate[dStr] = [];
                completionsByDate[dStr].push(c);
            });
            const sortedCompDates = Object.keys(completionsByDate).sort().reverse();
            sortedCompDates.forEach((dKey, idx) => {
                const dayList = completionsByDate[dKey];
                const folderId = `done-acc-${idx}`;
                html += `
                <div class="border border-emerald-200 rounded-2xl overflow-hidden bg-white shadow-xs mb-2.5">
                    <div onclick="document.getElementById('${folderId}').classList.toggle('hidden')" class="bg-emerald-50 hover:bg-emerald-100/70 p-3.5 flex justify-between items-center cursor-pointer transition select-none">
                        <span class="font-black text-xs text-emerald-950 flex items-center gap-2"><i class="fa-regular fa-calendar-check text-emerald-600"></i> ${dKey} 배송 완료 이력<span class="bg-emerald-200/80 text-emerald-900 text-[10px] font-black px-2 py-0.5 rounded-full">${dayList.length}건 완료</span></span>
                        <div class="flex items-center gap-2"><span class="text-[11px] text-emerald-700 font-bold">클릭하여 펼치기/접기</span><i class="fa-solid fa-chevron-down text-emerald-600 text-xs"></i></div>
                    </div>
                    <div id="${folderId}" class="hidden p-3 bg-slate-50 border-t border-emerald-100 space-y-1.5">
                        ${dayList.map((c, cIdx) => {
                            let timeOnly = c.timeString ? c.timeString.split(' ')[1] : '';
                            let photoBadge = c.photoUrl ? `<a href="${c.photoUrl}" target="_blank" class="bg-blue-600 text-white text-[9px] font-black px-2 py-1 rounded shadow-sm hover:bg-blue-700 flex items-center gap-1"><i class="fa-solid fa-camera"></i> 사진보기</a>` : '';
                            return `
                            <div class="p-3 bg-white border border-emerald-200 rounded-xl flex items-center justify-between text-xs shadow-xs">
                                <div class="flex items-center gap-2.5 min-w-0 flex-1"><span class="w-5 h-5 bg-emerald-600 text-white rounded-full flex items-center justify-center font-black text-[10px] shrink-0">${cIdx + 1}</span><span class="font-bold text-gray-900 truncate leading-snug">${c.address}</span></div>
                                <div class="flex items-center gap-2 shrink-0 ml-2">${photoBadge}<span class="bg-emerald-600 text-white text-[10px] font-black px-2.5 py-1 rounded-lg shadow-sm whitespace-nowrap">✓ ${timeOnly} [${c.tag || '전달완료'}]</span></div>
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
            });
        }
    } else if (state.historyMasterSubTab === 'PENDING') {
        if (remainingDests.length === 0) {
            html += `<div class="text-center text-gray-400 py-20 text-xs font-bold">미배송된 목적지가 없습니다 (전원 완료).</div>`;
        } else {
            html += `
            <div class="border border-gray-200 rounded-2xl overflow-hidden bg-white shadow-xs">
                <div onclick="document.getElementById('pending-accordion-body').classList.toggle('hidden')" class="bg-gray-100 hover:bg-gray-200 p-3.5 flex justify-between items-center cursor-pointer transition select-none">
                    <span class="font-black text-xs text-gray-800 flex items-center gap-2"><i class="fa-solid fa-clock text-blue-600"></i> 미배송 대기 목적지 (총 ${remainingDests.length}곳)</span>
                    <div class="flex items-center gap-2"><span class="text-[11px] text-gray-500 font-bold">클릭하여 펼치기/접기</span><i class="fa-solid fa-chevron-down text-gray-400 text-xs"></i></div>
                </div>
                <div id="pending-accordion-body" class="hidden p-3 bg-slate-50 border-t border-gray-200 space-y-1.5">
            `;
            remainingDests.forEach((dest, idx) => {
                html += `
                <div class="p-3 bg-white border border-gray-200 rounded-xl flex items-center justify-between text-xs shadow-xs">
                    <div class="flex items-center gap-2.5 min-w-0 flex-1"><span class="w-5 h-5 bg-blue-600 text-white rounded-full flex items-center justify-center font-black text-[10px] shrink-0">${dest.displayNumber || idx + 1}</span><span class="font-bold text-gray-900 truncate leading-snug">${dest.address}</span></div>
                    <span class="bg-blue-50 text-blue-700 text-[10px] font-black px-2 py-0.5 rounded border border-blue-200 shrink-0 ml-2">배송 대기중</span>
                </div>`;
            });
            html += `</div></div>`;
        }
    } else if (state.historyMasterSubTab === 'MEMOS') {
        if (driverMemos.length === 0) {
            html += `<div class="text-center text-gray-400 py-20 text-xs font-bold">이 기사가 현장에서 등록한 주차/건물 메모가 없습니다.</div>`;
        } else {
            const memosByDate = {};
            driverMemos.forEach(m => {
                let dStr = '최근 등록';
                if (m.time && m.time.includes(' ')) dStr = m.time.split(' ')[0].replace(/\./g, '-');
                if (!memosByDate[dStr]) memosByDate[dStr] = [];
                memosByDate[dStr].push(m);
            });
            const sortedMemoDates = Object.keys(memosByDate).sort().reverse();
            sortedMemoDates.forEach((dKey, idx) => {
                const mList = memosByDate[dKey];
                const mFolderId = `memo-acc-${idx}`;
                html += `
                <div class="border border-yellow-200 rounded-2xl overflow-hidden bg-white shadow-xs mb-2.5">
                    <div onclick="document.getElementById('${mFolderId}').classList.toggle('hidden')" class="bg-yellow-50 hover:bg-yellow-100/70 p-3.5 flex justify-between items-center cursor-pointer transition select-none">
                        <span class="font-black text-xs text-yellow-950 flex items-center gap-2"><i class="fa-regular fa-calendar-days text-yellow-600"></i> ${dKey} 등록 메모<span class="bg-yellow-200 text-yellow-900 text-[10px] font-black px-2 py-0.5 rounded-full">${mList.length}건 등록</span></span>
                        <div class="flex items-center gap-2"><span class="text-[11px] text-yellow-700 font-bold">어느 주소에 어떤 내용인지 펼치기/접기</span><i class="fa-solid fa-chevron-down text-yellow-600 text-xs"></i></div>
                    </div>
                    <div id="${mFolderId}" class="hidden p-3 bg-slate-50 border-t border-yellow-100 space-y-2">
                        ${mList.map(m => `
                        <div class="p-3 bg-white border border-gray-200 rounded-xl flex flex-col gap-1.5 shadow-xs">
                            <div class="flex justify-between items-center text-xs"><span class="font-black text-gray-900 flex items-center gap-1.5"><i class="fa-solid fa-location-dot text-red-500 text-[11px]"></i> ${m.address}</span><span class="text-[10px] font-mono text-gray-400">${m.time || ''}</span></div>
                            <p class="bg-yellow-50/50 p-2.5 rounded-lg border border-yellow-100 text-xs font-bold text-gray-800 whitespace-pre-line leading-relaxed">${m.memo}</p>
                        </div>`).join('')}
                    </div>
                </div>`;
            });
        }
    }
    html += `</div>`;
    listEl.innerHTML = html;
}

export function openMasterNoticeHistoryModal() {
    renderMasterNoticeHistoryList();
    document.getElementById('master-notice-history-modal').classList.remove('hidden');
}

export function closeMasterNoticeHistoryModal() { 
    document.getElementById('master-notice-history-modal').classList.add('hidden'); 
}

export function renderMasterNoticeHistoryList() {
    const container = document.getElementById('master-notice-history-container');
    if (!container) return;
    const masterSentList = state.allDispatchMessages.filter(m => m.senderKey === 'MASTER' || m.senderType === 'MASTER');

    if (masterSentList.length === 0) {
        container.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">발송된 운영사 알림 이력이 없습니다.</div>`; return;
    }
    let html = '';
    masterSentList.forEach(m => {
        const targetPreview = m.targetPhones && m.targetPhones.length > 0 ? (m.targetPhones.length === 1 ? m.targetPhones[0] : `${m.targetPhones[0]} 외 ${m.targetPhones.length - 1}명`) : '전체 지정 계정';
        html += `
        <div class="bg-white border border-gray-200 rounded-2xl p-4 shadow-2xs flex flex-col gap-2 hover:border-amber-400 transition">
            <div class="flex justify-between items-center text-xs">
                <div class="flex items-center gap-2">
                    <span class="bg-amber-500 text-white font-black text-[10px] px-2 py-0.5 rounded-md">운영사 알림</span>
                    <span class="font-bold text-gray-800 text-xs"><i class="fa-solid fa-users text-amber-500 mr-1 text-[10px]"></i>수신: ${targetPreview}</span>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-[11px] font-mono text-gray-400">${m.dateStr || ''} ${m.timeStr || ''}</span>
                    <button type="button" onclick="window.deleteDispatchMessage('${m.id}')" class="text-red-500 hover:text-red-700 p-1 text-xs transition active:scale-95" title="이 발송 알림 삭제"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>
            <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-gray-800 whitespace-pre-line leading-relaxed">${m.content}</div>
        </div>`;
    });
    container.innerHTML = html;
}

// ==========================================
// 🌟 2. 마스터 전용 사진 데이터 관리 모듈 (경량 텍스트 테이블 리스트 & 실시간 기사 검색)
// ==========================================

let photoSortField = 'time'; // 'time' (완료 일시) 또는 'author' (작성자 기사)
let photoSortAsc = false;    // 기본 내림차순(최신 완료순)
let photoCurrentPage = 1;

// 🌟 사진 등록 기사 식별 함수
function getPhotoAuthorDisplay(item) {
    if (item.phone) return item.phone;
    if (item.deviceId && state.allLicenses && state.allLicenses.length > 0) {
        const matched = state.allLicenses.find(l => l.deviceId === item.deviceId || l.key === item.deviceId);
        if (matched) return matched.phone || matched.key || item.deviceId;
        return item.deviceId;
    }
    return '기사 미등록';
}

export function openPhotoGalleryModal() {
    const searchInput = document.getElementById('photo-filter-driver-search');
    if (searchInput) searchInput.value = '';
    const dateInput = document.getElementById('photo-filter-date');
    if (dateInput) dateInput.value = '';
    photoSortField = 'time';
    photoSortAsc = false;
    photoCurrentPage = 1;
    renderPhotoListTable();
    document.getElementById('photo-gallery-modal')?.classList.remove('hidden');
}

export function closePhotoGalleryModal() {
    document.getElementById('photo-gallery-modal')?.classList.add('hidden');
}

export function filterPhotoGallery() {
    photoCurrentPage = 1;
    renderPhotoListTable();
}

export function clearPhotoDateFilter() {
    const dateInput = document.getElementById('photo-filter-date');
    if (dateInput) dateInput.value = '';
    filterPhotoGallery();
}

// 🌟 테이블 헤더 클릭 시 작성자/완료일시 정렬 로직
export function sortPhotos(field) {
    if (photoSortField === field) {
        photoSortAsc = !photoSortAsc;
    } else {
        photoSortField = field;
        photoSortAsc = (field === 'author');
    }
    photoCurrentPage = 1;
    renderPhotoListTable();
}

export function changePhotoPage(tabKey, targetPage) {
    photoCurrentPage = targetPage;
    renderPhotoListTable();
}

// 🌟 리소스 최적화: 텍스트 테이블 리스트 렌더링 함수
export function renderPhotoListTable() {
    const tbody = document.getElementById('photo-list-tbody');
    const countBadgeEl = document.getElementById('photo-total-count-badge');
    const pagEl = document.getElementById('pagination-photos');
    if (!tbody) return;

    // 1. 헤더 화살표 상태 갱신
    const arrowAuthor = document.getElementById('sort-photo-arrow-author');
    const arrowTime = document.getElementById('sort-photo-arrow-time');

    if (arrowAuthor) {
        arrowAuthor.innerText = (photoSortField === 'author') ? (photoSortAsc ? '▲' : '▼') : '↕';
        arrowAuthor.parentElement.className = (photoSortField === 'author') 
            ? "sortable-th py-3 px-3 text-center text-blue-700 font-black hover:bg-gray-100 transition" 
            : "sortable-th py-3 px-3 text-center text-gray-600 font-black hover:bg-gray-100 transition";
    }

    if (arrowTime) {
        arrowTime.innerText = (photoSortField === 'time') ? (photoSortAsc ? '▲' : '▼') : '↕';
        arrowTime.parentElement.className = (photoSortField === 'time') 
            ? "sortable-th py-3 px-3 text-center text-blue-700 font-black hover:bg-gray-100 transition" 
            : "sortable-th py-3 px-3 text-center text-gray-600 font-black hover:bg-gray-100 transition";
    }

    // 사진 링크가 있는 완료 건만 추출
    let photos = state.allCompletions.filter(c => c.photoUrl && c.photoUrl.trim() !== '' && c.photoUrl !== '사진 없음');

    // 2. 🌟 대규모 기사 환경 지원: 실시간 기사 검색어 필터링 (전화번호, 라이선스 키, 기기ID 매칭)
    const driverSearchQuery = (document.getElementById('photo-filter-driver-search')?.value || '').trim().toLowerCase();
    if (driverSearchQuery) {
        const cleanDigits = driverSearchQuery.replace(/[^0-9]/g, '');
        photos = photos.filter(c => {
            const author = getPhotoAuthorDisplay(c).toLowerCase();
            const cPhone = (c.phone || '').replace(/[^0-9]/g, '');
            const cDevId = (c.deviceId || '').toLowerCase();
            
            const matchesAuthor = author.includes(driverSearchQuery);
            const matchesPhone = cleanDigits && cPhone.includes(cleanDigits);
            const matchesDev = cDevId.includes(driverSearchQuery);
            
            return matchesAuthor || matchesPhone || matchesDev;
        });
    }

    // 3. 날짜 필터링
    const selectedDate = document.getElementById('photo-filter-date')?.value || '';
    if (selectedDate) {
        photos = photos.filter(c => {
            let dStr = '';
            if (c.timeString && c.timeString.includes(' ')) {
                dStr = c.timeString.split(' ')[0].replace(/\./g, '-');
            } else if (c.completedAt) {
                dStr = getLocalDateString(new Date(c.completedAt));
            }
            return dStr === selectedDate;
        });
    }

    // 4. 정렬 (작성자 가나다순 또는 완료 일시순)
    photos.sort((a, b) => {
        if (photoSortField === 'author') {
            const authorA = getPhotoAuthorDisplay(a);
            const authorB = getPhotoAuthorDisplay(b);
            return photoSortAsc ? authorA.localeCompare(authorB) : authorB.localeCompare(authorA);
        } else {
            const tA = a.completedAt || 0;
            const tB = b.completedAt || 0;
            return photoSortAsc ? (tA - tB) : (tB - tA);
        }
    });

    const total = photos.length;
    if (countBadgeEl) countBadgeEl.innerText = `총 ${total}건`;

    if (total === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-16 text-center text-gray-400 font-bold text-xs"><i class="fa-solid fa-camera text-2xl text-gray-300 mb-2 block"></i>조건에 일치하는 배송 완료 사진 내역이 없습니다.</td></tr>`;
        if (pagEl) pagEl.innerHTML = '';
        return;
    }

    // 5. 페이지네이션 처리
    const totalPages = Math.ceil(total / PAGE_SIZE_MASTER) || 1;
    if (photoCurrentPage > totalPages) photoCurrentPage = totalPages;
    if (photoCurrentPage < 1) photoCurrentPage = 1;

    const start = (photoCurrentPage - 1) * PAGE_SIZE_MASTER;
    const pagedPhotos = photos.slice(start, start + PAGE_SIZE_MASTER);

    tbody.innerHTML = pagedPhotos.map((p, idx) => {
        const authorDisplay = getPhotoAuthorDisplay(p);
        let dateTimeStr = p.timeString || '';
        if (!dateTimeStr && p.completedAt) {
            const dt = new Date(p.completedAt);
            dateTimeStr = `${getLocalDateString(dt)} ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        }

        return `
        <tr class="hover:bg-gray-50 transition">
            <td class="py-3 px-3 font-bold text-gray-400 text-center">${start + idx + 1}</td>
            <td class="py-3 px-3 text-center whitespace-nowrap">
                <span class="font-black text-gray-800 text-xs flex items-center justify-center gap-1">
                    <i class="fa-solid fa-truck text-blue-500 text-[10px]"></i>${authorDisplay}
                </span>
            </td>
            <td class="py-3 px-3 text-gray-500 font-medium whitespace-nowrap text-center">${dateTimeStr}</td>
            <td class="py-3 px-3 font-bold text-gray-800 max-w-[320px] truncate" title="${p.address || ''}">${p.address || '-'}</td>
            <td class="py-3 px-3 text-center whitespace-nowrap">
                <span class="bg-emerald-100 text-emerald-800 text-[10px] font-black px-2 py-0.5 rounded shadow-2xs">${p.tag || '전달완료'}</span>
            </td>
            <td class="py-3 px-3 text-center whitespace-nowrap">
                <button onclick="window.previewPhotoModal('${p.id}')" class="px-2.5 py-1 bg-blue-50 hover:bg-blue-100 text-blue-600 font-black rounded-lg text-[11px] shadow-sm transition active:scale-95 flex items-center gap-1 mx-auto">
                    <i class="fa-solid fa-camera"></i> 사진 확인
                </button>
            </td>
            <td class="py-3 px-3 text-center whitespace-nowrap">
                <button onclick="window.deletePhotoItem('${p.id}')" class="px-2.5 py-1 bg-red-50 text-red-600 font-bold rounded-lg text-[11px] shadow-sm active:scale-95 hover:bg-red-100 transition">삭제</button>
            </td>
        </tr>
        `;
    }).join('');

    if (pagEl) {
        pagEl.innerHTML = renderPaginationControls('photos', photoCurrentPage, total, PAGE_SIZE_MASTER, 'window.changePhotoPage');
    }
}

// 🌟 사진 확인 버튼 클릭 시 단일 이미지 로딩
export function previewPhotoModal(completionId) {
    const item = state.allCompletions.find(c => c.id === completionId);
    if (!item) return;

    let dateTimeStr = item.timeString || '';
    if (!dateTimeStr && item.completedAt) {
        const dt = new Date(item.completedAt);
        dateTimeStr = `${getLocalDateString(dt)} ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    const addrEl = document.getElementById('photo-preview-addr');
    const subEl = document.getElementById('photo-preview-sub');
    const imgEl = document.getElementById('photo-preview-img');
    const tagEl = document.getElementById('photo-preview-tag');
    const linkEl = document.getElementById('photo-preview-link');

    if (addrEl) addrEl.innerText = item.address || '주소 정보 없음';
    if (subEl) subEl.innerText = `${getPhotoAuthorDisplay(item)} | ${dateTimeStr}`;
    if (imgEl) imgEl.src = item.photoUrl || '';
    if (tagEl) tagEl.innerText = item.tag || '전달완료';
    if (linkEl) linkEl.href = item.photoUrl || '#';

    document.getElementById('photo-preview-modal')?.classList.remove('hidden');
}

export function closePhotoPreviewModal() {
    document.getElementById('photo-preview-modal')?.classList.add('hidden');
    const imgEl = document.getElementById('photo-preview-img');
    if (imgEl) imgEl.src = '';
}

export async function deletePhotoItem(completionId) {
    if (!confirm("정말 이 배송 완료 사진 및 완료 기록을 영구 삭제하시겠습니까?")) return;
    try {
        await deleteDoc(doc(db, "completions", completionId));
        alert("성공적으로 삭제되었습니다.");
        renderPhotoListTable();
    } catch (e) {
        alert("삭제 중 오류가 발생했습니다: " + e.message);
    }
}