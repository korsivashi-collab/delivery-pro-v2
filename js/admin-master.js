// js/admin-master.js
import { db, generateSecureKey } from "./admin-api.js";
import { PAGE_SIZE_MASTER, renderPaginationControls } from "./admin-ui.js";
import { state, getLocalDateString, todayStr } from "./admin-state.js";
import { doc, setDoc, getDoc, updateDoc, deleteDoc, addDoc, collection } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// ==========================================
// 1. 마스터 탭 및 테이블 렌더링
// ==========================================
export function switchMasterTab(tab) {
    ['regular', 'trial', 'dispatch', 'memos', 'history'].forEach(t => {
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
    if (tab === 'history') renderAccountHistoryView();
}

export function changeMasterTabPagination(tabKey, targetPage) {
    state.masterPages[tabKey] = targetPage;
    if (tabKey === 'memos') renderMemosTable(state.allMemos);
    else renderMasterTables();
}

export function renderMasterTables() {
    const regulars = state.allLicenses.filter(l => l.type === 'regular' || (!l.type && !l.isTrial && !(l.key || '').startsWith('TRIAL-')));
    const trials = state.allLicenses.filter(l => l.type === 'trial' || l.isTrial || (l.key || '').startsWith('TRIAL-'));
    const dispatches = state.allLicenses.filter(l => l.type === 'dispatch');

    const cr = document.getElementById('count-regular');
    const ct = document.getElementById('count-trial');
    const cd = document.getElementById('count-dispatch');
    if (cr) cr.innerText = regulars.length;
    if (ct) ct.innerText = trials.length;
    if (cd) cd.innerText = dispatches.length;

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
}

function renderPagedTableTab(tabKey, list, tbodyId, paginationId, rowRenderer) {
    const tbody = document.getElementById(tbodyId);
    const pagEl = document.getElementById(paginationId);
    if (!tbody) return;

    // 🌟 [UI 개선] 누락되었던 테이블 헤더(thead)를 동적으로 주입하여 레이아웃 교정
    const table = tbody.parentElement;
    if (!table.querySelector('thead')) {
        const thead = document.createElement('thead');
        if (tabKey === 'regular' || tabKey === 'trial') {
            thead.innerHTML = `
                <tr class="border-b border-gray-200 text-gray-600 font-black bg-gray-50/80">
                    <th class="py-3 px-3 w-12 text-center">순번</th>
                    <th class="py-3 px-3">라이선스 키</th>
                    <th class="py-3 px-3">전화번호</th>
                    <th class="py-3 px-3">기기 고유번호</th>
                    <th class="py-3 px-3">만료일</th>
                    <th class="py-3 px-3">상태</th>
                    <th class="py-3 px-3 text-center">관리</th>
                </tr>`;
        } else if (tabKey === 'dispatch') {
            thead.innerHTML = `
                <tr class="border-b border-gray-200 text-gray-600 font-black bg-gray-50/80">
                    <th class="py-3 px-3 w-12 text-center">순번</th>
                    <th class="py-3 px-3">관제 라이선스 키</th>
                    <th class="py-3 px-3">사무실 전화번호</th>
                    <th class="py-3 px-3">기기 고유번호</th>
                    <th class="py-3 px-3">연결된 기사</th>
                    <th class="py-3 px-3">만료일</th>
                    <th class="py-3 px-3">상태</th>
                    <th class="py-3 px-3 text-center">관리</th>
                </tr>`;
        }
        table.insertBefore(thead, tbody);
    }

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="py-12 text-center text-gray-400 font-bold">등록된 내역이 없습니다.</td></tr>`;
        if (pagEl) pagEl.innerHTML = '';
        return;
    }

    const total = list.length;
    const totalPages = Math.ceil(total / PAGE_SIZE_MASTER) || 1;
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
// 2. 라이선스(계정) 관리 로직
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
        if (state.currentSelectedAccountKey === key) backToAllAccountsView();
    } catch (e) { alert("삭제 오류: " + e.message); }
}

export async function deleteLicenseFromModal() {
    const origKey = document.getElementById('edit-orig-key').value;
    if (!origKey) return;
    closeEditModal();
    await deleteLicense(origKey);
}

// ==========================================
// 3. 메모 테이블 관리 및 정렬
// ==========================================

// 🌟 현재 메모 정렬 상태 관리 변수
let currentMemoSort = 'latest'; 

// 🌟 정렬 기준 변경 함수
export function sortMemos(sortType) {
    currentMemoSort = sortType;
    state.masterPages['memos'] = 1; // 정렬 변경 시 첫 페이지로 이동
    renderMemosTable(state.allMemos);
}

export function renderMemosTable(memos) {
    const tbody = document.getElementById('table-body-memos');
    const pagEl = document.getElementById('pagination-memos');
    if (!tbody) return;

    // 🌟 [UI 개선] 누락되었던 테이블 헤더(thead)를 동적으로 주입
    const table = tbody.parentElement;
    if (!table.querySelector('thead')) {
        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr class="border-b border-gray-200 text-gray-600 font-black bg-gray-50/80">
                <th class="py-3 px-3 w-12 text-center">순번</th>
                <th class="py-3 px-3">배송지 주소</th>
                <th class="py-3 px-3">등록된 주차/건물 메모</th>
                <th class="py-3 px-3 text-center">작성 일시</th>
                <th class="py-3 px-3 text-center">추천수(좋아요)</th>
                <th class="py-3 px-3 text-center">관리</th>
            </tr>`;
        table.insertBefore(thead, tbody);
    }

    if (!memos || memos.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-12 text-center text-gray-400 font-bold">등록된 주차 메모가 없습니다.</td></tr>`;
        if (pagEl) pagEl.innerHTML = '';
        return;
    }

    // 🌟 렌더링 전 정렬 로직 적용
    let sortedMemos = [...memos];
    if (currentMemoSort === 'likes') {
        // 추천수(좋아요) 내림차순 정렬
        sortedMemos.sort((a, b) => (b.likes || 0) - (a.likes || 0));
    } else {
        // 최신 등록순 (createdAt 기준, 없으면 updatedAt 기준 역순)
        sortedMemos.sort((a, b) => {
            const timeA = a.createdAt || a.updatedAt || 0;
            const timeB = b.createdAt || b.updatedAt || 0;
            return timeB - timeA;
        });
    }

    const total = sortedMemos.length;
    const totalPages = Math.ceil(total / PAGE_SIZE_MASTER) || 1;
    let curPage = state.masterPages['memos'] || 1;
    if (curPage > totalPages) curPage = totalPages;
    if (curPage < 1) curPage = 1;
    state.masterPages['memos'] = curPage;

    const start = (curPage - 1) * PAGE_SIZE_MASTER;
    const pagedMemos = sortedMemos.slice(start, start + PAGE_SIZE_MASTER);

    tbody.innerHTML = pagedMemos.map((m, idx) => `
        <tr class="hover:bg-gray-50 transition">
            <td class="py-3 px-3 font-bold text-gray-400 text-center">${start + idx + 1}</td>
            <td class="py-3 px-3 font-black text-gray-900 max-w-[220px] truncate" title="${m.address}">${m.address}</td>
            <td class="py-3 px-3 font-bold text-gray-700 max-w-[340px] truncate" title="${m.memo}">${m.memo}</td>
            <td class="py-3 px-3 text-gray-400 font-medium whitespace-nowrap text-center">${m.time || '-'}</td>
            <td class="py-3 px-3 text-center font-bold text-blue-600">${m.likes || 0}</td>
            <td class="py-3 px-3 text-center whitespace-nowrap"><button onclick="window.deleteParkingMemo('${m.id}')" class="px-2.5 py-1 bg-red-50 text-red-600 font-bold rounded-lg text-[11px] shadow-sm active:scale-95">삭제</button></td>
        </tr>
    `).join('');
    if (pagEl) pagEl.innerHTML = renderPaginationControls('memos', curPage, total, PAGE_SIZE_MASTER, 'window.changeMasterTabPagination');
}

export async function deleteParkingMemo(id) {
    if (!confirm("이 주차 메모를 삭제하시겠습니까?")) return;
    try { await deleteDoc(doc(db, "memos", id)); } catch (e) { alert("삭제 오류: " + e.message); }
}

// ==========================================
// 4. 히스토리 / 내역 조회
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

// 엄청나게 긴 계정 뷰 HTML 렌더링 함수
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
            if (typeof vA === 'string') return state.historySortAsc ? vA.localeCompare(vB) : vB.localeCompare(vA);
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
                            <th onclick="window.setHistorySort('originalIndex')" class="sortable-th py-3.5 px-3">순번${getArrow('originalIndex')}</th>
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
                <td class="py-3.5 px-3 font-bold text-gray-400">${item.originalIndex}</td>
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
    if (!targetLic) { listEl.innerHTML = `<div class="text-center text-gray-400 py-28 text-xs font-bold">계정 정보를 찾을 수 정를 수 없습니다.</div>`; return; }

    state.currentSelectedAccountKey = targetLic.key;
    if (topFilterBarEl) topFilterBarEl.classList.add('hidden');

    const targetPhone = targetLic.phone || '';
    const targetDeviceId = targetLic.deviceId || '';

    document.getElementById('top-selected-account-label').innerText = `${targetPhone || '연락처 미등록'} [${targetLic.key}]`;
    if (backBarEl) { backBarEl.classList.remove('hidden'); backBarEl.classList.add('flex'); }

    document.getElementById('acc-phone').innerText = targetPhone || '연락처 미등록';
    document.getElementById('acc-key').innerText = targetLic.key;
    document.getElementById('acc-device').innerText = targetDeviceId || '기기 미등록 (대기)';
    document.getElementById('acc-expire').innerText = `만료일: ${targetLic.expireDate || '-'}`;
    document.getElementById('acc-status-badge').innerText = targetLic.status === 'active' ? '정상' : '정지';
    document.getElementById('acc-status-badge').className = targetLic.status === 'active' ? 'bg-emerald-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full' : 'bg-red-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full';
    document.getElementById('acc-type-badge').innerText = targetLic.type === 'dispatch' ? '관제 계정' : (targetLic.type === 'trial' ? '7일 무료 체험' : '일반 계정');

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

// ==========================================
// 5. 마스터 발송 이력 관리
// ==========================================
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

// 모듈 함수들을 전역 window 객체에 맵핑 (다른 파일 수정 없이 즉시 작동)
window.sortMemos = sortMemos;