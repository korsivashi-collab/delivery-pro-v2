// js/admin-master-licenses.js

import { db, getVerifiedAuthSession, requestAuthCredential, getOwnMasterStatus, changeOwnMasterSecret, requestLicenseMembership, onVerifiedSessionInvalidated } from "./admin-api.js";
import { PAGE_SIZE_MASTER, renderPaginationControls } from "./admin-ui.js";
import { state, getLocalDateString } from "./admin-state.js";
import { doc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// Credential controls are separate from license edits: no key/history/product writes.
let credentialBusy = false;
let credentialUiGeneration = 0;
let closeSecretDisplay = null;
let masterCredentialButton = null;
let masterPasswordButton = null;
let masterPasswordChangeUncertain = false;
let licenseCredentialControls = null;
const credentialFailure = '발급 완료를 확인하지 못했습니다. 기존 로그인 정보가 변경되었을 수 있으므로 자동으로 재시도하지 마세요. 계정 상태를 확인한 뒤 재발급해 주세요.';

function loginKeyText(target) { return target.loginKey ?? target.key ?? target.id; }
function escapeLoginKey(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function credentialButton(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'px-3 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold';
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
}

function displaySecretOnce(result, selfRotation) {
    const dialog = document.createElement('dialog');
    dialog.className = 'rounded-2xl p-6 shadow-2xl w-full max-w-lg';
    dialog.setAttribute('aria-label', '새 로그인 정보 1회 표시');
    const explanation = document.createElement('p');
    explanation.textContent = '새 로그인 정보는 이 창에서 한 번만 표시됩니다. 안전한 곳에 보관하세요. 닫은 뒤에는 다시 조회할 수 없습니다.' +
        (selfRotation ? ' 닫으면 로그아웃됩니다. 새 정보로 다시 로그인하세요.' : '');
    const value = document.createElement('input');
    value.type = 'text'; value.readOnly = true; value.autocomplete = 'off'; value.spellcheck = false;
    value.setAttribute('aria-label', '새 로그인 secret');
    value.className = 'w-full border rounded-lg p-3 my-4 font-mono';
    value.value = result.secret;
    result.secret = '';
    let closed = false;
    const cleanup = (signOutSelf = true) => {
        if (closed) return;
        closed = true;
        value.value = '';
        dialog.remove();
        closeSecretDisplay = null;
        if (selfRotation && signOutSelf) void window.systemLogout();
    };
    closeSecretDisplay = cleanup;
    dialog.addEventListener('cancel', event => { event.preventDefault(); cleanup(); });
    dialog.addEventListener('close', cleanup);
    dialog.append(explanation, value, credentialButton('보관 완료 · 닫기', cleanup));
    document.body.append(dialog);
    dialog.showModal();
    value.focus(); value.select();
}

async function issueCredential(action, role, accountRef) {
    const identity = getVerifiedAuthSession('master');
    if (!identity || credentialBusy || closeSecretDisplay || masterPasswordChangeUncertain) return;
    const selfRotation = action === 'rotate' && accountRef === identity.accountRef;
    const message = action === 'rotate' ? '기존 로그인 정보와 세션을 철회하고 재발급합니다.' : '새 로그인 정보를 최초 발급합니다.';
    if (!confirm(`${accountRef}\n${message}${selfRotation ? '\n본인 계정입니다. 새 정보를 반드시 보관하세요. 처리 중 오류가 발생하면 다른 마스터 또는 별도 승인된 관리자 복구가 필요할 수 있습니다.' : ''}`)) return;
    credentialBusy = true;
    const generation = credentialUiGeneration;
    let result;
    try {
        result = await requestAuthCredential(action === 'issue' ? { action, role, accountRef } : { action, accountRef });
        if (generation !== credentialUiGeneration) throw new Error('CREDENTIAL_VIEW_CLOSED');
        displaySecretOnce(result, selfRotation);
    } catch { closeSecretDisplay?.(false); alert(credentialFailure); }
    finally { if (result) result.secret = ''; credentialBusy = false; }
}

async function openMasterStatus() {
    const identity = getVerifiedAuthSession('master');
    if (!identity || credentialBusy || closeSecretDisplay) return;
    credentialBusy = true;
    const generation = credentialUiGeneration;
    try {
        const status = await getOwnMasterStatus();
        if (generation !== credentialUiGeneration || getVerifiedAuthSession('master') !== identity) return;
        const dialog = document.createElement('dialog');
        dialog.className = 'rounded-2xl p-6 shadow-2xl w-full max-w-lg';
        dialog.setAttribute('aria-label', '마스터 로그인 정보');
        const title = document.createElement('p'); title.textContent = '현재 마스터 로그인 상태 (비밀번호는 표시하지 않습니다.)';
        dialog.append(title);
        for (const [label, value] of [
            ['계정 연결 경로', status.accountRef], ['권한', status.role],
            ['계정 사용', status.enabled ? '사용 가능' : '사용 중지'],
            ['로그인 준비', status.credentialReady ? '준비됨' : '준비되지 않음'],
            ['인증 버전', status.credentialVersion],
            ['인증 연결', status.authenticationLinked ? '정상' : '비정상']]) {
            const row = document.createElement('p'); row.textContent = `${label}: ${value}`; dialog.append(row);
        }
        const cleanup = () => { dialog.remove(); closeSecretDisplay = null; };
        closeSecretDisplay = cleanup;
        dialog.addEventListener('cancel', event => { event.preventDefault(); cleanup(); });
        dialog.addEventListener('close', cleanup);
        dialog.append(credentialButton('닫기', cleanup)); document.body.append(dialog); dialog.showModal();
    } catch {
        if (generation === credentialUiGeneration && getVerifiedAuthSession('master') === identity) alert('마스터 로그인 상태를 조회하지 못했습니다. 잠시 후 다시 확인해 주세요.');
    } finally { credentialBusy = false; }
}

function openMasterPasswordChange() {
    const identity = getVerifiedAuthSession('master');
    if (!identity || credentialBusy || closeSecretDisplay || masterPasswordChangeUncertain) return;
    const generation = credentialUiGeneration;
    const dialog = document.createElement('dialog');
    dialog.className = 'rounded-2xl p-6 shadow-2xl w-full max-w-lg';
    dialog.setAttribute('aria-label', 'Master 로그인 비밀번호 변경');
    const inputs = ['현재 비밀번호', '새 비밀번호', '새 비밀번호 확인'].map((label, index) => {
        const input = document.createElement('input');
        input.type = 'password'; input.placeholder = label; input.setAttribute('aria-label', label);
        input.autocomplete = index === 0 ? 'current-password' : 'new-password';
        input.minLength = 8; input.maxLength = 64;
        input.className = 'w-full border rounded-lg p-3 my-2';
        input.spellcheck = false;
        return input;
    });
    const message = document.createElement('p');
    message.textContent = '비밀번호는 8~64자입니다. 앞뒤 공백과 제어문자는 사용할 수 없습니다.';
    let closed = false;
    const clear = () => { for (const input of inputs) input.value = ''; };
    const cleanup = () => {
        if (closed) return;
        closed = true; clear(); dialog.remove(); closeSecretDisplay = null;
    };
    const submit = credentialButton('변경', async () => {
        if (closed || credentialBusy || masterPasswordChangeUncertain || generation !== credentialUiGeneration || getVerifiedAuthSession('master') !== identity) return;
        const validNew = inputs[1].value.length >= 8 && inputs[1].value.length <= 64 &&
            inputs[1].value.trim() === inputs[1].value && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(inputs[1].value);
        if (!validNew || inputs[1].value !== inputs[2].value || !inputs[0].value) {
            clear(); message.textContent = '현재 비밀번호, 새 비밀번호 형식 및 확인값을 확인해 주세요.'; return;
        }
        credentialBusy = true; submit.disabled = true; masterPasswordChangeUncertain = true;
        try {
            await changeOwnMasterSecret(inputs[0].value, inputs[1].value);
            clear();
            if (closed || generation !== credentialUiGeneration) return;
            cleanup();
            await window.systemLogout();
            alert('비밀번호가 변경되었습니다. 새 비밀번호로 다시 로그인하세요.');
        } catch (error) {
            clear();
            if (generation !== credentialUiGeneration) return;
            if (error.changeOutcome === 'notChanged') {
                masterPasswordChangeUncertain = false; submit.disabled = false;
                const failures = { AUTH_FAILED: '현재 비밀번호 또는 로그인 권한을 확인해 주세요.',
                    INVALID_SECRET: '비밀번호는 8~64자이며 앞뒤 공백과 제어문자는 사용할 수 없습니다.',
                    SECRET_UNCHANGED: '현재 비밀번호와 다른 새 비밀번호를 입력해 주세요.',
                    CREDENTIAL_CONFLICT: '사용할 수 없는 비밀번호입니다. 다른 비밀번호를 입력해 주세요.',
                    CREDENTIAL_BUSY: '계정의 이전 변경 상태를 먼저 확인해 주세요.' };
                if (!closed) message.textContent = failures[error.code] || '비밀번호는 변경되지 않았습니다. 로그인 상태와 입력값을 확인한 뒤 다시 시도해 주세요.';
            } else if (!closed) message.textContent =
                '변경 결과를 확인하지 못했습니다. 비밀번호가 변경되었을 수 있으므로 다시 변경하지 말고 로그인 상태를 확인해 주세요.';
        } finally { clear(); credentialBusy = false; }
    });
    closeSecretDisplay = cleanup;
    dialog.addEventListener('cancel', event => { event.preventDefault(); cleanup(); });
    dialog.addEventListener('close', cleanup);
    dialog.append(message, ...inputs, submit, credentialButton('닫기', cleanup));
    document.body.append(dialog); dialog.showModal(); inputs[0].focus();
}

export function initMasterCredentialControls() {
    if (!getVerifiedAuthSession('master') || masterCredentialButton) return;
    const anchor = document.getElementById('master-name-badge');
    if (!anchor?.parentNode) return;
    masterCredentialButton = credentialButton('마스터 로그인 정보', openMasterStatus);
    anchor.parentNode.append(masterCredentialButton);
    masterPasswordButton = credentialButton('Master 로그인 비밀번호 변경', openMasterPasswordChange);
    anchor.parentNode.append(masterPasswordButton);
}

function mountLicenseCredentialControls(target) {
    licenseCredentialControls?.remove();
    licenseCredentialControls = null;
    // Free-trial Auth provisioning remains a separate, explicitly deferred stage.
    if (!getVerifiedAuthSession('master') || target.type !== 'dispatch' || target.isTrial || String(target.key).startsWith('TRIAL-')) return;
    const id = target.id;
    const card = document.getElementById('edit-modal-card');
    if (!card || typeof id !== 'string' || !id || id.includes('/')) return;
    const role = target.type === 'dispatch' ? 'dispatch' : 'driver';
    const group = document.createElement('div');
    group.className = 'mt-3 pt-3 border-t flex flex-wrap items-center gap-2 shrink-0';
    const label = document.createElement('span'); label.textContent = '로그인 정보'; label.className = 'text-xs font-bold';
    group.append(label, credentialButton('최초 발급', () => issueCredential('issue', role, 'licenses/' + id)),
        credentialButton('재발급', () => issueCredential('rotate', role, 'licenses/' + id)));
    card.append(group);
    licenseCredentialControls = group;
}

onVerifiedSessionInvalidated(() => {
    credentialUiGeneration++;
    closeSecretDisplay?.(false);
    masterCredentialButton?.remove(); masterCredentialButton = null;
    masterPasswordButton?.remove(); masterPasswordButton = null;
    masterPasswordChangeUncertain = false;
    licenseCredentialControls?.remove(); licenseCredentialControls = null;
    document.getElementById('license-key-change-control')?.remove();
});
window.addEventListener('pagehide', () => { credentialUiGeneration++; closeSecretDisplay?.(false); });

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
            <td class="py-3 px-3 font-mono font-black text-blue-600 select-all">${escapeLoginKey(loginKeyText(item))}</td>
            <td class="py-3 px-3 font-black text-gray-900">${item.phone || '<span class="text-gray-400 text-[11px] font-normal">로그인 대기</span>'}</td>
            <td class="py-3 px-3"><span class="font-mono text-[11px] text-gray-700">${item.deviceId || '미등록'}</span></td>
            <td class="py-3 px-3 font-bold">${item.expireDate || '-'}</td>
            <td class="py-3 px-3"><span class="px-2 py-0.5 rounded-full text-[10px] font-black ${item.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}">${item.status === 'active' ? '정상' : '정지'}</span></td>
            <td class="py-3 px-3 text-center space-x-1 whitespace-nowrap">
                <button onclick="window.openEditLicenseModal('${item.key}')" class="px-2.5 py-1 bg-blue-600 text-white font-black rounded-lg text-[11px]">수정</button>
                <button onclick="window.deleteLicense('${item.key}')" class="px-2 py-1 bg-red-50 text-red-700 font-bold rounded-lg text-[11px]">사용 중지</button>
            </td>
        </tr>
    `);

    renderPagedTableTab('trial', trials, 'table-body-trial', 'pagination-trial', (item, idx) => `
        <tr class="hover:bg-gray-50/80 transition">
            <td class="py-3 px-3 font-bold text-gray-400 text-center">${idx}</td>
            <td class="py-3 px-3 font-mono font-black text-emerald-600 select-all">${escapeLoginKey(loginKeyText(item))}</td>
            <td class="py-3 px-3 font-black text-gray-900">${item.phone || '-'}</td>
            <td class="py-3 px-3"><span class="font-mono text-[11px] text-gray-700">${item.deviceId || '-'}</span></td>
            <td class="py-3 px-3 font-bold">${item.expireDate || '-'}</td>
            <td class="py-3 px-3"><span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full text-[10px] font-black">7일체험</span></td>
            <td class="py-3 px-3 text-center space-x-1 whitespace-nowrap">
                <button onclick="window.openEditLicenseModal('${item.key}')" class="px-2.5 py-1 bg-blue-600 text-white font-black rounded-lg text-[11px]">수정</button>
                <button onclick="window.deleteLicense('${item.key}')" class="px-2 py-1 bg-red-50 text-red-700 font-bold rounded-lg text-[11px]">사용 중지</button>
            </td>
        </tr>
    `);

    renderPagedTableTab('dispatch', dispatches, 'table-body-dispatch', 'pagination-dispatch', (item, idx) => {
        const connectedDrivers = state.allLicenses.filter(l => l.dispatchKey === item.key);
        const slotLimitStr = !Number.isSafeInteger(item.maxSlots) || item.maxSlots < 0 ? '슬롯 설정 확인 필요' :
            item.maxSlots === 0 ? '무제한' : `${item.maxSlots}대 한도`;
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
                <button onclick="window.deleteLicense('${item.key}')" class="px-2 py-1 bg-red-50 text-red-700 font-bold rounded-lg text-[11px] hover:bg-red-100 transition">사용 중지</button>
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

    if (!devId) {
        alert("접속을 차단할 기기 고유번호(deviceId)를 입력해 주세요.");
        inputId?.focus();
        return;
    }

    try {
        await setDoc(doc(db, "blocked_devices", devId), {
            deviceId: devId,
            memo: memo || '관리자 직접 제한 등록',
            createdAt: Date.now()
        });

        alert(`[접속 제한 등록 완료]\n\n기기 고유번호: ${devId}\n\n해당 기기로 접속 시 차단 안내 대신 '서버 연결 오류' 화면으로 위장 처리됩니다.`);
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

        alert(`[접속 제한 등록 완료]\n\n기기 고유번호: ${devId}\n\n해당 기기로 접속 시 차단 안내 대신 '서버 연결 오류' 화면으로 위장 처리됩니다.`);
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

export async function generateNewLicense() {
    const type = document.getElementById('new-key-type')?.value || 'regular';
    const keyword = document.getElementById('new-key-keyword')?.value?.trim() || '';
    const countInput = document.getElementById('new-key-count');
    const expireDate = document.getElementById('new-key-expire')?.value;
    const btn = document.getElementById('btn-generate-license');

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

    const typeName = (type === 'dispatch') ? '관제 계정' : '일반 계정';
    const expStr = expireDate.replace(/-/g, '.');
    const phones = type === 'regular' ? (document.getElementById('new-key-phones')?.value || '').trim().split(/\r?\n/).map(p => p.trim()) : null;
    if (phones && (phones.length !== count || phones.some(p => p.length > 32 || !/^[0-9+() -]+$/.test(p) || !/^\d{9,13}$/.test(p.replace(/\D/g, ''))))) {
        alert('생성 수량에 맞춰 등록 전화번호를 한 줄에 하나씩 입력해 주세요.'); return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 생성 중...';
    }

    try {
        const result = await requestLicenseMembership({ action: 'createLicense', type, keyword, count, expireDate: expStr, ...(phones ? { phones } : {}) });
        const createdKeys = result.licenseKeys;
        if (!Array.isArray(createdKeys) || createdKeys.length !== count || createdKeys.some(key => typeof key !== 'string')) {
            throw new Error('생성을 확인할 수 없습니다. 자동 재시도하지 마세요.');
        }
        document.getElementById('create-account-modal')?.classList.add('hidden');
        if (document.getElementById('new-key-keyword')) document.getElementById('new-key-keyword').value = '';
        if (document.getElementById('new-key-count')) document.getElementById('new-key-count').value = '1';
        if (phones && document.getElementById('new-key-phones')) document.getElementById('new-key-phones').value = '';
        const loginGuide = type === 'regular' ? '라이선스 키와 등록 전화번호로 바로 로그인할 수 있습니다.' : '로그인 secret은 별도로 최초 발급해야 합니다.';

        if (count === 1) {
            alert(`[${typeName} 생성 완료]\n\n라이선스 키: ${createdKeys[0]}\n${loginGuide}`);
        } else {
            alert(`[${typeName} 총 ${count}개 생성 완료]\n\n생성된 키 목록:\n${createdKeys.join('\n')}\n${loginGuide}`);
        }
    } catch {
        alert('계정 생성을 확인하지 못했습니다. 생성되었을 수 있으므로 재시도 전에 현재 목록을 확인해 주세요.');
    } finally {
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

function mountLicenseManagementControls(target) {
    document.getElementById('license-management-controls')?.remove();
    if (Object.hasOwn(target, 'securityVersion')) return;
    const modal = document.getElementById('edit-license-modal');
    const host = document.getElementById('edit-key-input')?.parentNode;
    if (!modal || !host) return;
    const group = document.createElement('div'); group.id = 'license-management-controls';
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'mt-2 px-3 py-2 text-xs rounded-lg bg-indigo-600 text-white';
    button.textContent = '이 라이선스만 관리형으로 편입';
    button.addEventListener('click', async () => {
        const identity = getVerifiedAuthSession('master');
        const licenseKey = target.id || target.key;
        if (!identity || !confirm('선택한 라이선스 1개만 편입합니다. 기존 키와 운행 데이터는 보존됩니다. 진행하시겠습니까?')) return;
        button.disabled = true;
        try {
            await requestLicenseMembership({ action: 'adoptLicense', licenseKey });
            if (getVerifiedAuthSession('master') === identity) { alert('관리형 편입을 확인했습니다. 인증이 없다면 별도로 최초 발급해 주세요.'); group.remove(); }
        } catch { alert('편입을 확인할 수 없습니다. 소유권과 인증 연결을 점검해 주세요. 자동 보정하지 않습니다.'); }
        finally { button.disabled = false; }
    });
    if (target.type === 'dispatch') group.append(button);
    if (target.routeOwnerId === undefined || target.routeOwnerId === '') {
        const repair = document.createElement('button'); repair.type = 'button';
        repair.className = button.className; repair.textContent = '이 계정의 동선 소유자만 보완';
        repair.addEventListener('click', async () => {
            const identity = getVerifiedAuthSession('master');
            if (!identity) return;
            const owner = window.prompt('확인된 기존 동선 소유자 ID를 입력하세요. 기존 동선 소유자가 없음을 직접 확인한 경우에만 NEW를 입력하세요. 전화번호만으로 복원하지 않습니다.')?.trim();
            if (!owner || !confirm('선택한 기존 계정 1개의 소유자만 보완합니다. 동선·이력·메모·키는 변경하지 않습니다. 기존 소유자 확인을 완료했습니까?')) return;
            repair.disabled = true;
            try {
                await requestLicenseMembership({ action: 'repairRouteOwner', licenseKey: target.id || target.key,
                    ...(owner === 'NEW' ? { confirmNewOwner: true } : { routeOwnerId: owner }) });
                if (getVerifiedAuthSession('master') === identity) { alert('소유자 보완을 확인했습니다. 계정 화면을 다시 열어 주세요.'); group.remove(); }
            } catch { alert('보완을 확인할 수 없습니다. 기존 소유자 또는 연결 충돌을 점검해 주세요. 자동 재실행하지 않습니다.'); }
            finally { repair.disabled = false; }
        });
        group.append(repair);
    }
    host.append(group);
}

function mountLicenseKeyControl(target) {
    document.getElementById('license-key-change-control')?.remove();
    if (target.type === 'dispatch' || !getVerifiedAuthSession('master')) return;
    const host = document.getElementById('edit-key-input')?.parentNode;
    if (!host) return;
    const group = document.createElement('div'); group.id = 'license-key-change-control';
    const button = credentialButton('로그인 키 변경', async () => {
        const identity = getVerifiedAuthSession('master'), generation = credentialUiGeneration;
        if (!identity || credentialBusy) return;
        const expectedKey = loginKeyText(target), licenseKey = target.id || target.key;
        const newKey = window.prompt('새 로그인 라이선스 키를 입력하세요. (1~128자)', expectedKey)?.trim();
        if (!newKey) return;
        if (newKey.length > 128 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(newKey)) { alert('키는 1~128자이며 제어문자를 사용할 수 없습니다.'); return; }
        if (newKey === expectedKey) { alert('현재 키와 다른 키를 입력해 주세요.'); return; }
        if (!confirm(`로그인 키를 변경하시겠습니까?\n${expectedKey}\n→ ${newKey}\n기존 로그인 세션은 종료됩니다.`)) return;
        credentialBusy = true; button.disabled = true;
        try {
            const result = await requestLicenseMembership({ action: 'changeLicenseKey', licenseKey, expectedKey, newKey });
            if (getVerifiedAuthSession('master') !== identity || generation !== credentialUiGeneration) return;
            if (result.changed !== true || result.accountRef !== `licenses/${licenseKey}` || result.loginKey !== newKey ||
                !Number.isSafeInteger(result.credentialVersion) || result.credentialVersion < 2) throw new Error('CHANGE_UNCONFIRMED');
            target.loginKey = newKey;
            document.getElementById('edit-key-input').value = newKey;
            alert('로그인 키가 변경되었습니다. 새 키와 등록 전화번호로 로그인하세요.');
        } catch {
            if (getVerifiedAuthSession('master') === identity && generation === credentialUiGeneration) alert('키 변경을 확인하지 못했습니다. 중복 키 또는 계정 상태를 확인하고, 결과가 불명확하면 현재 목록을 먼저 확인해 주세요.');
        } finally { credentialBusy = false; button.disabled = false; }
    });
    group.append(button); host.append(group);
}

export function openEditLicenseModal(key) {
    const target = state.allLicenses.find(l => l.key === key);
    if (!target) return;
    document.getElementById('edit-orig-key').value = target.id || target.key;
    document.getElementById('edit-type').value = target.type || 'regular';
    document.getElementById('edit-key-input').value = loginKeyText(target);
    document.getElementById('edit-key-input').readOnly = true;
    document.getElementById('edit-type').disabled = true;
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
        
        document.getElementById('edit-slots-input').value = target.maxSlots ?? '';
        
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
    mountLicenseCredentialControls(target);
    mountLicenseManagementControls(target);
    mountLicenseKeyControl(target);
    document.getElementById('edit-license-modal').classList.remove('hidden');
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
        const slots = targetDispatch?.maxSlots;
        const max = !Number.isSafeInteger(slots) || slots < 0 ? '설정 확인 필요' : slots === 0 ? '무제한' : slots;
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
    const licenseKey = inputEl ? inputEl.value.trim() : '';
    if (!licenseKey) { alert('정확한 기사 라이선스 키를 입력해 주세요.'); return; }
    try {
        const target = await requestLicenseMembership({ action: 'lookup', licenseKey });
        if (target.linked && !confirm('기존 연결이 있는 기사입니다. 선택한 회사로 연결하시겠습니까?')) return;
        await requestLicenseMembership({ action: 'link', licenseKey: target.licenseKey, dispatchKey });
        alert('기사 연결이 처리되었습니다.');
        if (inputEl) inputEl.value = '';
        renderModalConnectedDrivers(dispatchKey);
    } catch { alert('기사 연결을 확인할 수 없습니다. 계정, TMS 설정과 회사 슬롯을 확인해 주세요.'); }
}

export async function unlinkDriverFromModal(driverKey) {
    const dispatchKey = document.getElementById('edit-orig-key').value;
    const driver = state.allLicenses.find(l => l.key === driverKey);
    const name = driver?.phone || driverKey;
    if (!confirm(`[${name}] 기사를 관제 연결에서 해제하시겠습니까?`)) return;
    try {
        await requestLicenseMembership({ action: 'unlink', licenseKey: driverKey });
        alert(`[${name}] 기사의 관제 연결이 해제되었습니다.`);
        renderModalConnectedDrivers(dispatchKey);
    } catch(e) { alert("연결 해제 오류: " + e.message); }
}

export async function saveLicenseEdit() {
    const origKey = document.getElementById('edit-orig-key').value;
    const newKey = document.getElementById('edit-key-input').value.trim();
    const phone = document.getElementById('edit-phone-input').value.trim();
    const deviceId = document.getElementById('edit-device-input').value.trim();
    const expireDate = document.getElementById('edit-expire-input').value;
    const status = document.getElementById('edit-status-select').value;
    const type = document.getElementById('edit-type').value;
    const original = (state.allLicenses || []).find(l => (l.id || l.key) === origKey);
    if (!newKey || newKey !== (original?.loginKey ?? original?.key ?? origKey)) { alert('로그인 키는 로그인 키 변경 버튼으로 변경해 주세요.'); return; }
    if (!expireDate) { alert('만료일을 선택해 주세요.'); return; }
    const changes = { phone, deviceId, expireDate: expireDate.replace(/-/g, '.'), status, type };
    if (type === 'dispatch') {
        const text = document.getElementById('edit-slots-input')?.value?.trim();
        const slots = Number(text);
        if (!text || !Number.isSafeInteger(slots) || slots < 0) { alert('슬롯은 0 이상의 정수로 입력해 주세요.'); return; }
        const sessions = Number(document.getElementById('edit-sessions-input')?.value);
        if (!Number.isSafeInteger(sessions) || sessions < 1 || sessions > 50) { alert('동시 접속 수를 확인해 주세요.'); return; }
        Object.assign(changes, { maxSlots: slots, maxSessions: sessions, isPro: !!document.getElementById('edit-pro-checkbox')?.checked });
    }
    try {
        await requestLicenseMembership({ action: 'updateLicense', licenseKey: origKey, changes });
        alert('계정 정보가 수정되었습니다.'); closeEditModal();
    } catch { alert('계정 수정을 확인할 수 없습니다. 현재 상태를 확인해 주세요.'); }
}

export async function deleteLicense(key) {
    if (!confirm(`[${key}] 계정을 사용 중지하시겠습니까? 라이선스와 운행 데이터, 소속 관계는 보존됩니다.`)) return;
    try {
        await requestLicenseMembership({ action: 'suspendLicense', licenseKey: key });
        alert('계정이 사용 중지되었습니다. 기존 데이터는 보존됩니다.');
        if (state.currentSelectedAccountKey === key && window.backToAllAccountsView) window.backToAllAccountsView();
    } catch { alert('사용 중지를 확인할 수 없습니다. 현재 계정 상태를 확인해 주세요.'); }
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
