import { normalizeMasterPhone, formatMasterPhoneInput, saveMasterLicenses } from './admin-license-save.js';
// js/admin-master-licenses.js

import { db, generateSecureKey } from "./admin-api.js";
import { PAGE_SIZE_MASTER, renderPaginationControls } from "./admin-ui.js";
import { state, getLocalDateString } from "./admin-state.js";
import { doc, setDoc, getDoc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

let generatingLicense = false;
let savingLicenseEdit = false;
let licensePhoneRepairPromise = null;

export function reconcileMasterLicensePhones() {
    if (!licensePhoneRepairPromise) {
        licensePhoneRepairPromise = (async () => {
            let result;
            do {
                result = await saveMasterLicenses({ action: 'repairPhones' });
                if (result.conflicts?.length || result.skipped?.length) {
                    console.warn('전화번호 자동 보완: 서로 다른 번호·소유권 또는 잘못된 번호는 관리자 수정이 필요합니다.', result);
                }
            } while (result.hasMore);
            return result;
        })().catch(() => {
            console.warn('전화번호 자동 보완 실패: 마스터 재접속 또는 수정 저장으로 재시도해 주세요.');
        });
    }
    return licensePhoneRepairPromise;
}

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
            <td class="py-3 px-3"><span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full text-[10px] font-black">${item.trialDays === 30 ? '영업 30일' : '7일체험'}</span></td>
            <td class="py-3 px-3 text-center space-x-1 whitespace-nowrap">
                <button onclick="window.openEditLicenseModal('${item.key}')" class="px-2.5 py-1 bg-blue-600 text-white font-black rounded-lg text-[11px]">수정</button>
                <button onclick="window.deleteLicense('${item.key}')" class="px-2 py-1 bg-red-50 text-red-700 font-bold rounded-lg text-[11px]">삭제</button>
            </td>
        </tr>
    `);

    renderPagedTableTab('dispatch', dispatches, 'table-body-dispatch', 'pagination-dispatch', (item, idx) => {
        const connectedDrivers = state.allLicenses.filter(l => l.dispatchKey === item.key);
        const slotLimitStr = item.maxSlots ? `${item.maxSlots}대 한도` : '무제한';
        const allowedSessions = item.maxSessions || (item.isPro ? 2 : 1);
        const proBadge = item.isPro ? `<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full text-[10px] font-black ml-1 border border-amber-300"><i class="fa-solid fa-crown text-amber-500"></i> PRO</span>` : ``;
        const sessionBadge = `<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-black px-1.5 py-0.5 rounded ml-1">${allowedSessions}회선</span>`;

        return `
        <tr class="hover:bg-gray-50/80 transition">
            <td class="py-3 px-3 font-bold text-gray-400 text-center">${idx}</td>
            <td class="py-3 px-3 font-mono font-black text-purple-600 select-all">${item.key}</td>
            <td class="py-3 px-3 font-black text-gray-900">${item.phone ? `<i class="fa-solid fa-phone text-blue-500 mr-1 text-[10px]"></i>${item.phone}` : '<span class="text-gray-400 text-[11px]">연락처 미등록</span>'}</td>
            <td class="py-3 px-3">
                <span class="font-mono text-[11px] text-gray-600">${item.deviceId ? `<i class="fa-solid fa-display text-blue-500 mr-1"></i>${item.deviceId}` : '오프라인'}</span>
                <div class="text-[10px] text-indigo-600 font-bold mt-0.5 flex items-center gap-1">
                    <i class="fa-solid fa-network-wired text-[9px]"></i> 동시 접속 허용: <b>${allowedSessions}대</b>
                </div>
            </td>
            <td class="py-3 px-3">
                <span class="inline-flex items-center gap-1 font-black text-purple-700 bg-purple-50 px-2 py-0.5 rounded-lg border border-purple-200">
                    <i class="fa-solid fa-users text-[10px]"></i> ${connectedDrivers.length}명 연결
                </span>
                <span class="text-[10px] text-gray-400 block mt-0.5">(${slotLimitStr})</span>
            </td>
            <td class="py-3 px-3 font-bold">${item.expireDate || '-'}</td>
            <td class="py-3 px-3"><span class="bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full text-[10px] font-black">관제운영</span>${proBadge}${sessionBadge}</td>
            <td class="py-3 px-3 text-center space-x-1 whitespace-nowrap">
                <button onclick="window.open(window.location.pathname + '?monitor=' + '${item.key}', '_blank')" class="px-2.5 py-1 bg-emerald-600 text-white font-black rounded-lg text-[11px] hover:bg-emerald-700 transition">모니터링</button>
                <button onclick="window.openEditLicenseModal('${item.key}')" class="px-2.5 py-1 bg-blue-600 text-white font-black rounded-lg text-[11px] hover:bg-blue-700 transition">수정</button>
                <button onclick="window.deleteLicense('${item.key}')" class="px-2 py-1 bg-red-50 text-red-700 font-bold rounded-lg text-[11px] hover:bg-red-100 transition">삭제</button>
            </td>
        </tr>`;
    });

    renderBlockedDevicesTable();
    renderModalBlockedDevices();
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
// 2. 접속 제한 기기 관리 모달 및 CRUD
// ==========================================

export function openBlockedDeviceModal() {
    const inputId = document.getElementById('modal-blocked-device-id');
    const inputMemo = document.getElementById('modal-blocked-device-memo');
    if (inputId) inputId.value = '';
    if (inputMemo) inputMemo.value = '';
    renderModalBlockedDevices();
    document.getElementById('blocked-devices-modal')?.classList.remove('hidden');
    setTimeout(() => inputId?.focus(), 100);
}

export function closeBlockedDeviceModal() {
    document.getElementById('blocked-devices-modal')?.classList.add('hidden');
}

export function renderModalBlockedDevices() {
    const tbody = document.getElementById('modal-blocked-device-tbody');
    const badge = document.getElementById('modal-blocked-count-badge');
    if (!tbody) return;

    const blockeds = state.allBlockedDevices || [];
    if (badge) badge.innerText = `${blockeds.length}대 제한 중`;

    if (blockeds.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-12 text-center text-gray-400 font-bold text-xs">등록된 제한 기기가 없습니다.</td></tr>`;
        return;
    }

    tbody.innerHTML = blockeds.map((item, idx) => {
        return `
        <tr class="hover:bg-rose-50/50 transition">
            <td class="py-2.5 px-3 font-bold text-gray-400 text-center">${idx + 1}</td>
            <td class="py-2.5 px-3 font-mono font-black text-rose-600 select-all">${item.deviceId}</td>
            <td class="py-2.5 px-3 font-bold text-gray-800">${item.memo || '<span class="text-gray-400 font-normal">-</span>'}</td>
            <td class="py-2.5 px-3 text-center">
                <span class="inline-flex items-center gap-1 bg-rose-100 text-rose-800 px-2 py-0.5 rounded-full text-[10px] font-black border border-rose-200 shadow-2xs">
                    <i class="fa-solid fa-ban text-[9px]"></i> 접속 제한
                </span>
            </td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap">
                <button type="button" onclick="window.unblockDevice('${item.deviceId}')" class="px-2.5 py-1 bg-white hover:bg-rose-50 text-rose-600 hover:text-rose-700 border border-rose-200 font-bold rounded-lg text-[11px] transition shadow-2xs active:scale-95">
                    제한 해제
                </button>
            </td>
        </tr>`;
    }).join('');
}

export async function addBlockedDeviceFromModal() {
    const inputId = document.getElementById('modal-blocked-device-id');
    const inputMemo = document.getElementById('modal-blocked-device-memo');
    const devId = inputId ? inputId.value.trim() : '';
    const memo = inputMemo ? inputMemo.value.trim() : '';

    if (!devId || !/^[\p{L}\p{N}_+ -]{1,160}$/u.test(devId)) {
        alert("차단할 라이선스 키, 전화번호 또는 기기 고유번호를 입력해 주세요.");
        inputId?.focus();
        return;
    }

    try {
        await setDoc(doc(db, "blocked_devices", devId), {
            deviceId: devId,
            memo: memo || '관리자 직접 제한 등록',
            createdAt: Date.now()
        });

        alert(`[접속 제한 등록 완료]\n\n차단 대상: ${devId}\n\n해당 기기로 접속 시 차단 안내 대신 '서버 연결 오류' 화면으로 위장 처리됩니다.`);
        if (inputId) inputId.value = '';
        if (inputMemo) inputMemo.value = '';
        renderModalBlockedDevices();
        renderBlockedDevicesTable();
    } catch (e) {
        alert("기기 접속 제한 등록 오류: " + e.message);
    }
}

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

    if (!devId || !/^[\p{L}\p{N}_+ -]{1,160}$/u.test(devId)) {
        alert("차단할 라이선스 키, 전화번호 또는 기기 고유번호를 입력해 주세요.");
        if (inputEl) inputEl.focus();
        return;
    }

    try {
        await setDoc(doc(db, "blocked_devices", devId), {
            deviceId: devId,
            memo: memo || '관리자 직접 제한 등록',
            createdAt: Date.now()
        });

        alert(`[접속 제한 등록 완료]\n\n차단 대상: ${devId}\n\n해당 기기로 접속 시 차단 안내 대신 '서버 연결 오류' 화면으로 위장 처리됩니다.`);
        if (inputEl) inputEl.value = '';
        if (memoEl) memoEl.value = '';
        renderModalBlockedDevices();
        renderBlockedDevicesTable();
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
        renderModalBlockedDevices();
        renderBlockedDevicesTable();
    } catch (e) {
        alert("제한 해제 오류: " + e.message);
    }
}

// ==========================================
// 3. 라이선스(계정) 관리 및 키워드/대량 생성 CRUD 로직
// ==========================================

function generateCustomLicenseKey(keyword = '') {
    const chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    const cleanKw = keyword.trim().replace(/[^A-Z0-9가-힣]/gi, '').toUpperCase().slice(0, 7);
    let fullChars = cleanKw;
    const needed = Math.max(0, 8 - cleanKw.length);
    for (let i = 0; i < needed; i++) {
        fullChars += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    fullChars = fullChars.slice(0, 8);
    return `${fullChars.slice(0, 4)}-${fullChars.slice(4, 8)}`;
}

function getUniqueLicenseKey(keyword) {
    let key;
    let attempts = 0;
    do {
        key = generateCustomLicenseKey(keyword);
        attempts++;
    } while (state.allLicenses.some(l => l.key === key) && attempts < 100);
    return key;
}

export async function generateNewLicense() {
    if (generatingLicense) return;
    const type = document.getElementById('new-key-type')?.value || 'regular';
    const keyword = document.getElementById('new-key-keyword')?.value?.trim() || '';
    const countInput = document.getElementById('new-key-count');
    const expireDate = document.getElementById('new-key-expire')?.value;
    const btn = document.getElementById('btn-generate-license');
    const phoneInput = document.getElementById('new-key-phone');
    let phone;
    try { phone = normalizeMasterPhone(phoneInput?.value || ''); }
    catch (error) { alert(error.message); phoneInput?.focus(); return; }
    if (phoneInput) { phoneInput.value = phone; phoneInput.setCustomValidity(''); }

    if (!expireDate) { 
        alert("만료일을 선택해 주세요."); 
        return; 
    }

    let count = parseInt(countInput ? countInput.value : '1') || 1;
    if (count < 1) count = 1;
    if (count > 50) {
        alert("한 번에 최대 50개까지만 일괄 생성할 수 있습니다.");
        count = 50;
    }
    if (phone && count > 1) {
        alert('전화번호 사전 등록은 계정 1개씩 발급해 주세요. 일괄 발급은 전화번호를 비워 주세요.');
        return;
    }

    const typeName = (type === 'dispatch') ? '관제 계정' : '일반 계정';
    const expStr = expireDate.replace(/-/g, '.');

    generatingLicense = true;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 생성 중...';
    }

    try {
        const createdKeys = [];
        const entries = [];
        for (let i = 0; i < count; i++) {
            let newKey;
            for (let attempts = 0; attempts < 100; attempts++) {
                newKey = getUniqueLicenseKey(keyword);
                if (!createdKeys.includes(newKey)) break;
            }
            if (createdKeys.includes(newKey)) throw new Error('발급 키가 중복되었습니다. 다시 시도해 주세요.');
            entries.push({
                key: newKey,
                type: type,
                phone,
                expireDate: expStr,
                deviceId: "",
                status: "active",
                maxSlots: (type === 'dispatch' ? 20 : 0),
                maxSessions: (type === 'dispatch' ? 1 : 1),
                isPro: false,
                createdAt: Date.now() + i
            });
            createdKeys.push(newKey);
        }
        const result = await saveMasterLicenses({ action: 'create', entries });

        document.getElementById('create-account-modal')?.classList.add('hidden');
        if (document.getElementById('new-key-keyword')) document.getElementById('new-key-keyword').value = '';
        if (document.getElementById('new-key-count')) document.getElementById('new-key-count').value = '1';
        if (phoneInput) { phoneInput.value = ''; phoneInput.setCustomValidity(''); }

        if (count === 1) {
            alert(`[${typeName} 발급 완료]\n\n라이선스 키: ${createdKeys[0]}`);
        } else {
            alert(`[${typeName} 총 ${count}개 일괄 발급 완료]\n\n발급된 키 목록:\n${createdKeys.join('\n')}`);
        }
        if (result.upgradedTrials.length) alert('기존 무료체험 계정이 정식 계정으로 승급 처리되었습니다. 주차 메모는 동일 전화번호로 이어집니다.');
    } catch (e) {
        alert("계정 발급 오류: " + e.message);
    } finally {
        generatingLicense = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> 계정 발급';
        }
    }
}

// 🌟 회선 수 증감 컨트롤러 함수
export function adjustLicenseSessions(delta) {
    const input = document.getElementById('edit-sessions-input');
    if (!input) return;
    let val = parseInt(input.value) || 1;
    val += delta;
    if (val < 1) val = 1;
    if (val > 50) val = 50;
    input.value = val;
    updateSessionDescUI(val);
}

// 🌟 회선 안내 문구 및 배지 동적 갱신 헬퍼
function updateSessionDescUI(val) {
    const proCheck = document.getElementById('edit-pro-checkbox');
    const desc = document.getElementById('edit-sessions-desc');
    const badge = document.getElementById('edit-sessions-badge');
    const isPro = proCheck ? proCheck.checked : false;

    if (badge) badge.innerText = `${val}대 접속 허용`;
    if (desc) {
        if (isPro) {
            if (val === 2) {
                desc.innerHTML = `<b class="text-amber-700">PRO 기본 2회선 포함</b> (추가 요금 결제 시 수량 증설 가능)`;
            } else if (val > 2) {
                desc.innerHTML = `<b class="text-indigo-700">PRO 회선 증설 (+${val - 2}대 추가)</b> 적용됨`;
            } else {
                desc.innerHTML = `<b class="text-gray-500">1회선 설정됨</b>`;
            }
        } else {
            if (val === 1) {
                desc.innerHTML = `<b class="text-gray-700">기본 요금제 1회선</b> (추가 요금 결제 시 수량 증설 가능)`;
            } else {
                desc.innerHTML = `<b class="text-indigo-700">기본형 회선 증설 (+${val - 1}대 추가)</b> 적용됨`;
            }
        }
    }
}

export function openEditLicenseModal(key) {
    const target = state.allLicenses.find(l => l.key === key);
    if (!target) return;
    document.getElementById('edit-orig-key').value = target.key;
    document.getElementById('edit-type').value = target.type || 'regular';
    document.getElementById('edit-key-input').value = target.key;
    document.getElementById('edit-phone-input').readOnly = false;
    document.getElementById('edit-expire-input').readOnly = false;
    document.getElementById('edit-phone-input').value = target.phone || '';
    document.getElementById('edit-device-input').value = target.deviceId || '';
    
    let expFormatted = '';
    if (target.expireDate && target.expireDate.includes('.')) expFormatted = target.expireDate.replace(/\./g, '-');
    else if (target.expireDate) expFormatted = target.expireDate;
    
    document.getElementById('edit-expire-input').value = expFormatted;
    document.getElementById('edit-status-select').value = target.status || 'active';

    const slotsBox = document.getElementById('edit-slots-container');
    const proBox = document.getElementById('edit-pro-container');
    const dispatchSec = document.getElementById('edit-dispatch-connected-section');

    // 🌟 동시 접속(모니터링) 회선 증설 컨트롤러 동적 생성 (절대 잠기지 않음)
    let sessionsBox = document.getElementById('edit-sessions-container');
    if (!sessionsBox && proBox && proBox.parentNode) {
        sessionsBox = document.createElement('div');
        sessionsBox.id = 'edit-sessions-container';
        sessionsBox.className = 'hidden mt-2 p-3 bg-indigo-50/70 rounded-xl border border-indigo-200 shadow-2xs';
        sessionsBox.innerHTML = `
            <div class="flex items-center justify-between mb-1.5">
                <label class="block text-[11px] font-black text-indigo-900 flex items-center gap-1.5">
                    <i class="fa-solid fa-network-wired text-indigo-600"></i> 동시 접속(모니터링) 허용 회선 수
                </label>
                <span id="edit-sessions-badge" class="text-[10px] font-black px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800">1대 접속</span>
            </div>
            <div class="flex items-center gap-2 mt-1">
                <div class="flex items-center bg-white border border-indigo-300 rounded-lg shadow-2xs overflow-hidden">
                    <button type="button" onclick="window.adjustLicenseSessions(-1)" class="px-2.5 py-1.5 bg-gray-50 hover:bg-indigo-100 text-gray-700 font-black text-xs transition border-r border-indigo-200 active:scale-95" title="회선 감소">-</button>
                    <input type="number" id="edit-sessions-input" min="1" max="50" oninput="window.onSessionsInputChange(this.value)" class="w-14 p-1 text-xs font-black text-center outline-none border-none text-indigo-900 bg-white" value="1">
                    <button type="button" onclick="window.adjustLicenseSessions(1)" class="px-2.5 py-1.5 bg-gray-50 hover:bg-indigo-100 text-gray-700 font-black text-xs transition border-l border-indigo-200 active:scale-95" title="회선 증설">+</button>
                </div>
                <span class="text-xs font-black text-gray-800">대</span>
                <span id="edit-sessions-desc" class="text-[10px] font-bold text-gray-500 ml-1"></span>
            </div>
        `;
        proBox.parentNode.insertBefore(sessionsBox, proBox.nextSibling);
    }

    const proCheck = document.getElementById('edit-pro-checkbox');
    const sessionsInput = document.getElementById('edit-sessions-input');

    if (target.type === 'dispatch') {
        if (slotsBox) slotsBox.classList.remove('hidden');
        if (proBox) proBox.classList.remove('hidden');
        if (sessionsBox) sessionsBox.classList.remove('hidden');
        
        document.getElementById('edit-slots-input').value = target.maxSlots || 0;
        
        // 현재 계정의 저장된 회선 수 로드 (기본값: PRO는 2, 기본형은 1)
        const currentSavedSessions = target.maxSessions || (target.isPro ? 2 : 1);
        if (sessionsInput) {
            sessionsInput.value = currentSavedSessions;
        }

        if (proCheck) {
            proCheck.checked = !!target.isPro;
            proCheck.onchange = (e) => {
                const isChecked = e.target.checked;
                let curVal = parseInt(sessionsInput.value) || 1;
                // PRO 활성화 체크 시 회선이 1대면 PRO 기본 2대로 자동 승격
                if (isChecked && curVal < 2) {
                    sessionsInput.value = 2;
                    curVal = 2;
                }
                updateSessionDescUI(curVal);
            };
        }

        updateSessionDescUI(currentSavedSessions);

        if (dispatchSec) { dispatchSec.classList.remove('hidden'); dispatchSec.classList.add('flex'); }
        const addInput = document.getElementById('modal-add-driver-input');
        if (addInput) addInput.value = '';
        renderModalConnectedDrivers(target.key);
    } else {
        if (slotsBox) slotsBox.classList.add('hidden');
        if (proBox) proBox.classList.add('hidden');
        if (sessionsBox) sessionsBox.classList.add('hidden');
        if (dispatchSec) { dispatchSec.classList.add('hidden'); dispatchSec.classList.remove('flex'); }
    }
    document.getElementById('edit-license-modal').classList.remove('hidden');
    showAccountPayments(key);
}


async function showAccountPayments(key) {
    let box=document.getElementById('account-payment-info');
    if(!box){box=document.createElement('section');box.id='account-payment-info';document.getElementById('edit-status-select').parentElement.after(box);}
    box.style.cssText='grid-column:1 / -1;min-width:0;margin:16px 0;padding:16px;border:1px solid #cbd5e1;border-radius:12px;font-size:13px;line-height:1.8';
    box.textContent='결제 정보를 확인하고 있습니다…';
    try {
        const data=await saveMasterLicenses({action:'paymentInfo',key});
        if(document.getElementById('edit-orig-key').value!==key)return;
        if(!data.managed){box.textContent='결제 연결 정보 없음';return;}
        const phone=document.getElementById('edit-phone-input');
        if(!phone.value && data.phone) phone.value=normalizeMasterPhone(data.phone);
        phone.readOnly=true;document.getElementById('edit-expire-input').readOnly=true;
        box.textContent='결제 정보 · '+data.provider;
        const note=document.createElement('p');
        note.textContent='각 주문은 전액 취소할 수 있습니다. 취소한 주문의 이용기간을 제외해 만료일을 다시 계산합니다. 인증된 휴대폰·만료일은 직접 변경하지 않습니다. 결제 이력은 보존됩니다. 남은 이용기간이 없으면 계정을 삭제할 수 있으며, 계정 정지는 환불이 아닙니다. 표시 상태는 최근 확인 기준입니다.';
        box.append(note);
        for(const p of data.payments){
            const card=document.createElement('div');card.style.cssText='margin-top:12px;padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;overflow-wrap:anywhere';
            const text=document.createElement('p');text.style.whiteSpace='pre-line';
            text.textContent=`${p.test?'[테스트]':'[실결제]'} ${p.months}개월 · ${Number(p.amount).toLocaleString('ko-KR')}원
${p.fullyCancelled?'전액 취소 완료':p.cancelled?'취소/환불 반영':p.status==='completed'?'승인 완료':'미완료'} · ${p.method||'결제수단 미기록'}
${p.approvedAt?new Date(p.approvedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'승인 일시 없음'}
주문번호: ${p.orderId}`;
            card.append(text);
            if(data.canCancel && p.status==='completed' && !p.fullyCancelled){
                const button=document.createElement('button');button.type='button';button.textContent=p.cancelled?'취소 결과 확인':'이 결제 전액 취소';
                button.style.cssText='margin-top:12px;min-height:44px;padding:8px 16px;background:#fff1f2;color:#b91c1c;border:1px solid #fda4af;border-radius:8px;font-weight:700';
                button.onclick=async()=>{
                    if(savingLicenseEdit)return;
                    const reason=prompt('이 주문의 전액 취소 사유를 입력해 주세요. (최대 200자)',p.test?'테스트 결제 취소':'관리자 환불 처리');
                    if(!reason?.trim())return;
                    if(reason.trim().length>200){alert('취소 사유는 200자 이하로 입력해 주세요.');return;}
                    if(!confirm(`[${p.test?'테스트':'실결제'}] ${p.months}개월 / ${Number(p.amount).toLocaleString('ko-KR')}원 전액을 취소할까요?\n주문번호: ${p.orderId}\n이 주문에 해당하는 이용기간도 제외됩니다.`))return;
                    savingLicenseEdit=true;const save=document.getElementById('btn-save-license-edit');if(save)save.disabled=true;
                    button.disabled=true;button.textContent='취소 결과 확인 중…';
                    try{
                        const result=await saveMasterLicenses({action:'cancelPayment',key,orderId:p.orderId,reason:reason.trim()});
                        if(document.getElementById('edit-orig-key').value===key){document.getElementById('edit-expire-input').value=result.expireDate.replaceAll('.','-');document.getElementById('edit-status-select').value=result.status;await showAccountPayments(key);}
                        alert('전액 취소가 완료되었습니다. 남은 이용기간을 다시 계산했습니다.');
                    }catch(e){alert(e.message);button.disabled=false;button.textContent='취소 재시도 / 결과 확인';}
                    finally{savingLicenseEdit=false;if(save)save.disabled=false;}
                };card.append(button);
            }
            box.append(card);
        }
        if(!data.payments.length){const empty=document.createElement('p');empty.textContent='웹 결제 이력 없음 · Google Play 결제는 스토어에서 관리해 주세요.';box.append(empty);}
    }catch(e){if(document.getElementById('edit-orig-key').value===key)box.textContent='결제 정보 조회 실패: '+e.message;}
}

export function onSessionsInputChange(val) {
    const num = parseInt(val) || 1;
    updateSessionDescUI(num);
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
    if (savingLicenseEdit) return;
    const origKey = document.getElementById('edit-orig-key').value;
    const newKey = document.getElementById('edit-key-input').value.trim().toUpperCase();
    const phoneInput = document.getElementById('edit-phone-input');
    let phone;
    try { phone = normalizeMasterPhone(phoneInput.value); }
    catch (error) { alert(error.message); phoneInput.focus(); return; }
    phoneInput.value = phone;
    phoneInput.setCustomValidity('');
    const deviceId = document.getElementById('edit-device-input').value.trim();
    const expireDate = document.getElementById('edit-expire-input').value;
    const status = document.getElementById('edit-status-select').value;
    const type = document.getElementById('edit-type').value;

    if (!newKey) { alert("라이선스 키를 입력해 주세요."); return; }
    if (!expireDate) { alert("만료일을 선택해 주세요."); return; }

    const expStr = expireDate.replace(/-/g, '.');
    const target = state.allLicenses.find(l => l.key === origKey);
    
    const isPro = document.getElementById('edit-pro-checkbox')?.checked || false;

    // 🌟 마스터 관리자가 직접 입력하거나 증설한 회선 수 그대로 반영
    const inputSessions = parseInt(document.getElementById('edit-sessions-input')?.value);
    const maxSessions = type === 'dispatch' ? (inputSessions > 0 ? inputSessions : (isPro ? 2 : 1)) : 1;

    const updatePayload = {
        key: newKey, phone: phone, expireDate: expStr, status: status, type: type, deviceId: deviceId,
        dispatchKey: target ? target.dispatchKey || '' : '',
        maxSlots: type === 'dispatch' ? parseInt(document.getElementById('edit-slots-input')?.value) || 0 : 0,
        maxSessions: maxSessions,
        isPro: type === 'dispatch' ? isPro : false
    };

    const btn = document.getElementById('btn-save-license-edit');
    const originalButton = btn?.innerHTML;
    savingLicenseEdit = true;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i> 저장 중...'; }
    try {
        try {
            await saveMasterLicenses({ action: 'edit', origKey, license: updatePayload });
        } catch (error) {
            if(error.code!=='ORPHAN_PROFILE')throw error;
            if(!confirm(`[${newKey}]는 삭제된 계정의 로그인 프로필이 남아 있습니다.\n남은 프로필을 정리하고 현재 계정의 키로 사용할까요?\n기존 배송 이력은 보존하며 현재 계정으로 합치지 않습니다.`))return;
            await saveMasterLicenses({action:'delete',key:newKey,orphanOnly:true});
            await saveMasterLicenses({action:'edit',origKey,license:updatePayload});
        }
        alert(`계정 정보가 성공적으로 수정되었습니다.\n(동시 접속 허용: ${maxSessions}대)`);
        closeEditModal();
    } catch (e) { alert("오류: " + e.message); }
    finally {
        savingLicenseEdit = false;
        if (btn) { btn.disabled = false; btn.innerHTML = originalButton; }
    }
}

export async function deleteLicense(key) {
    if(savingLicenseEdit)return;
    if (!confirm(`정말 [${key}] 계정을 삭제하시겠습니까?\n로그인 프로필도 함께 삭제합니다. 배송 이력과 결제 이력은 보존합니다. 결제 계정도 이용기간이 끝났거나 전액 취소로 남은 기간이 없으면 삭제할 수 있습니다.`)) return;
    savingLicenseEdit=true;
    try {
        await saveMasterLicenses({action:'delete',key});
        alert(`[${key}] 계정과 로그인 프로필이 삭제되었습니다.`);
        closeEditModal();
        if (state.currentSelectedAccountKey === key && window.backToAllAccountsView) window.backToAllAccountsView();
    } catch (e) { alert('삭제 오류: '+e.message); }
    finally {savingLicenseEdit=false;}
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
window.openBlockedDeviceModal = openBlockedDeviceModal;
window.closeBlockedDeviceModal = closeBlockedDeviceModal;
window.renderModalBlockedDevices = renderModalBlockedDevices;
window.addBlockedDeviceFromModal = addBlockedDeviceFromModal;
window.addBlockedDevice = addBlockedDevice;
window.unblockDevice = unblockDevice;

window.generateNewLicense = generateNewLicense;
window.formatMasterPhoneInput = formatMasterPhoneInput;
window.adjustLicenseSessions = adjustLicenseSessions;
window.onSessionsInputChange = onSessionsInputChange;
window.openEditLicenseModal = openEditLicenseModal;
window.closeEditModal = closeEditModal;
window.renderModalConnectedDrivers = renderModalConnectedDrivers;
window.linkDriverFromModal = linkDriverFromModal;
window.unlinkDriverFromModal = unlinkDriverFromModal;
window.saveLicenseEdit = saveLicenseEdit;
window.deleteLicense = deleteLicense;
window.deleteLicenseFromModal = deleteLicenseFromModal;
