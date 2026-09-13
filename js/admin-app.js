// js/admin-app.js
import { db, storage, generateSecureKey } from "./admin-api.js";
import { initKakaoMap, map, focusMapPosition } from "./admin-map.js";
import { playBeepSound, getAddressFromCoords, downloadDispatchExcel as utilDownloadExcel } from "./admin-utils.js";
import { PAGE_SIZE_MASTER, renderPaginationControls } from "./admin-ui.js";
import { collection, doc, setDoc, getDoc, onSnapshot, query, orderBy, updateDoc, deleteDoc, addDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// === 전역 상태 관리 변수 ===
let currentUserRole = null;
let allLicenses = [];
let allMemos = [];
let activeRoutes = {};
let allCompletions = [];
let allDispatchMessages = [];
let allDispatchTemplates = [];

let dispatchNavState = 'DELIVERY';
window.dispatchNavState = dispatchNavState;
let dispatchDetailTab = 'ROUTE';
window.dispatchDetailTab = dispatchDetailTab;
let currentMapPolylineMode = 'all';
let selectedDeviceId = null;

let excelSortAsc = true; 
let parsedExcelList = []; 

// 모듈 스코프 충돌을 막기 위한 admin-app.js 전용 지도 초기화 변수
window.myMapOverlays = [];
window.forceClearMap = function() {
    if (window.myMapOverlays) {
        window.myMapOverlays.forEach(ov => ov.setMap(null));
    }
    window.myMapOverlays = [];
    if (window.mapPlannedPolyline) { window.mapPlannedPolyline.setMap(null); window.mapPlannedPolyline = null; }
    if (window.mapCompletedPolyline) { window.mapCompletedPolyline.setMap(null); window.mapCompletedPolyline = null; }
    if (window.currentLocationOverlay) { window.currentLocationOverlay.setMap(null); window.currentLocationOverlay = null; }
};

window.masterPages = { regular: 1, trial: 1, dispatch: 1, memos: 1 };
window.historySortField = 'originalIndex';
window.historySortAsc = true;
window.historyAccountTypeFilter = 'ALL';
window.currentSelectedAccountKey = '';
window.historyMasterSubTab = 'ALL';
window.historyCurrentPage = 1;

window.historyNoticeMode = false;
window.historySelectedAccountKeys = new Set();
window.selectedMessageDrivers = new Set();
let activeDispatchPopupMsgId = null;

// 한국 시간(로컬) 기준 YYYY-MM-DD 변환 전역 함수
function getLocalDateString(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const todayStr = getLocalDateString();

// === 1. 초기화 및 로그인/로그아웃 ===
window.onload = () => {
    const todayInput = document.getElementById('dispatch-date-picker');
    if (todayInput) todayInput.value = todayStr;

    const defaultExpire = new Date();
    defaultExpire.setDate(defaultExpire.getDate() + 30);
    const expEl = document.getElementById('new-key-expire');
    if (expEl) expEl.value = getLocalDateString(defaultExpire);

    window.loadSavedForms();

    const urlParams = new URLSearchParams(window.location.search);
    const monitorKey = urlParams.get('monitor');
    if (monitorKey) {
        sessionStorage.setItem('deliveryProRole', 'DISPATCH');
        sessionStorage.setItem('deliveryProDispatchKey', monitorKey);
        sessionStorage.setItem('deliveryProSessionToken', 'MONITOR-' + Date.now()); 
        window.history.replaceState({}, document.title, window.location.pathname);
        showDispatchPanel();
        return;
    }

    const savedRole = sessionStorage.getItem('deliveryProRole');
    const savedName = sessionStorage.getItem('deliveryProAdminName');
    if (savedRole === 'MASTER') showMasterPanel(savedName);
    else if (savedRole === 'DISPATCH') showDispatchPanel();
};

window.handleSingleKeyLogin = async function() {
    const keyInput = document.getElementById('single-key-input').value.trim();
    const msgEl = document.getElementById('login-msg');
    const btn = document.getElementById('login-btn');

    if (!keyInput) { msgEl.innerText = "관리자 키를 입력해 주세요."; return; }
    msgEl.innerText = "";
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 인증 확인 중...';

    try {
        let adminSnap = await getDoc(doc(db, "admin", keyInput));
        if (!adminSnap.exists()) adminSnap = await getDoc(doc(db, "admin", keyInput.toUpperCase()));
        if (!adminSnap.exists()) adminSnap = await getDoc(doc(db, "admins", keyInput));
        if (!adminSnap.exists()) adminSnap = await getDoc(doc(db, "admins", keyInput.toUpperCase()));

        if (adminSnap.exists()) {
            const adminData = adminSnap.data();
            sessionStorage.setItem('deliveryProRole', 'MASTER');
            sessionStorage.setItem('deliveryProAdminName', adminData.name || '마스터');
            showMasterPanel(adminData.name || '마스터'); return;
        }

        let licRef = doc(db, "licenses", keyInput);
        let licSnap = await getDoc(licRef);
        if (!licSnap.exists()) {
            licRef = doc(db, "licenses", keyInput.toUpperCase());
            licSnap = await getDoc(licRef);
        }
        if (!licSnap.exists()) {
            licRef = doc(db, "licenses", `CTRL-${keyInput.toUpperCase()}`);
            licSnap = await getDoc(licRef);
        }

        if (licSnap.exists() && licSnap.data().type === 'dispatch') {
            const newSessionToken = 'SES-' + Math.random().toString(36).substring(2, 10);
            await updateDoc(licRef, { currentSessionToken: newSessionToken, deviceId: newSessionToken });
            sessionStorage.setItem('deliveryProRole', 'DISPATCH');
            sessionStorage.setItem('deliveryProDispatchKey', licSnap.id);
            sessionStorage.setItem('deliveryProSessionToken', newSessionToken);
            showDispatchPanel();
            return;
        }
        msgEl.innerText = "등록되지 않았거나 권한이 없는 관리자 키입니다.";
    } catch (e) {
        msgEl.innerText = "로그인 오류: " + e.message;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>대시보드 접속</span>';
    }
};

window.systemLogout = function() {
    sessionStorage.clear();
    window.location.reload();
};

function showMasterPanel(name = '마스터') {
    currentUserRole = 'MASTER';
    const badge = document.getElementById('master-name-badge');
    if (badge) badge.innerText = name;
    
    document.getElementById('login-screen').classList.add('hidden');
    const disp = document.getElementById('dispatch-panel');
    if (disp) { disp.classList.add('hidden'); disp.classList.remove('flex'); }
    const mast = document.getElementById('master-panel');
    if (mast) { mast.classList.remove('hidden'); mast.classList.add('flex'); }
    
    initMasterDataSync();
    window.switchMasterTab('regular');
}

function initMasterDataSync() {
    onSnapshot(collection(db, "licenses"), (snapshot) => {
        allLicenses = [];
        snapshot.forEach(docSnap => { allLicenses.push({ id: docSnap.id, ...docSnap.data() }); });
        renderMasterTables();
        window.populateDriverSelect();
        window.renderAccountHistoryView();
    });

    onSnapshot(collection(db, "memos"), (snapshot) => {
        allMemos = [];
        snapshot.forEach(docSnap => { allMemos.push({ id: docSnap.id, ...docSnap.data() }); });
        window.renderAccountHistoryView();
    });

    onSnapshot(collection(db, "routes"), (snapshot) => {
        activeRoutes = {};
        snapshot.forEach(docSnap => { activeRoutes[docSnap.id] = docSnap.data(); });
        window.renderAccountHistoryView();
    });

    onSnapshot(query(collection(db, "completions"), orderBy("completedAt", "asc")), (snapshot) => {
        allCompletions = [];
        snapshot.forEach(docSnap => { allCompletions.push({ id: docSnap.id, ...docSnap.data() }); });
        window.renderAccountHistoryView();
    });

    onSnapshot(query(collection(db, "dispatch_messages"), orderBy("createdAt", "desc")), (snapshot) => {
        allDispatchMessages = [];
        snapshot.forEach(docSnap => { allDispatchMessages.push({ id: docSnap.id, ...docSnap.data() }); });
    });

    onSnapshot(collection(db, "dispatch_templates"), (snapshot) => {
        allDispatchTemplates = [];
        snapshot.forEach(docSnap => { allDispatchTemplates.push({ id: docSnap.id, ...docSnap.data() }); });
    });
}

window.generateNewLicense = async function() {
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
};

window.switchMasterTab = function(tab) {
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
    if (tab === 'history') window.renderAccountHistoryView();
};

window.changeMasterTabPagination = function(tabKey, targetPage) {
    window.masterPages[tabKey] = targetPage;
    if (tabKey === 'memos') window.renderMemosTable(allMemos);
    else renderMasterTables();
};

function renderMasterTables() {
    const regulars = allLicenses.filter(l => l.type === 'regular' || (!l.type && !l.isTrial && !(l.key || '').startsWith('TRIAL-')));
    const trials = allLicenses.filter(l => l.type === 'trial' || l.isTrial || (l.key || '').startsWith('TRIAL-'));
    const dispatches = allLicenses.filter(l => l.type === 'dispatch');

    const cr = document.getElementById('count-regular');
    const ct = document.getElementById('count-trial');
    const cd = document.getElementById('count-dispatch');
    if (cr) cr.innerText = regulars.length;
    if (ct) ct.innerText = trials.length;
    if (cd) cd.innerText = dispatches.length;

    renderPagedTableTab('regular', regulars, 'table-body-regular', 'pagination-regular', (item, idx) => `
        <tr class="hover:bg-gray-50/80 transition">
            <td class="py-3 px-3 font-bold text-gray-400">${idx}</td>
            <td class="py-3 px-3 font-mono font-black text-blue-600 select-all">${item.key}</td>
            <td class="py-3 px-3 font-black text-gray-900">${item.phone || '<span class="text-gray-400 text-[11px] font-normal">로그인 대기</span>'}</td>
            <td class="py-3 px-3"><span class="font-mono text-[11px] text-gray-700">${item.deviceId || '미등록'}</span></td>
            <td class="py-3 px-3 font-bold">${item.expireDate || '-'}</td>
            <td class="py-3 px-3"><span class="px-2 py-0.5 rounded-full text-[10px] font-black ${item.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}">${item.status === 'active' ? '정상' : '정지'}</span></td>
            <td class="py-3 px-3 text-center space-x-1 whitespace-nowrap">
                <button onclick="openEditLicenseModal('${item.key}')" class="px-2.5 py-1 bg-blue-600 text-white font-black rounded-lg text-[11px]">수정</button>
                <button onclick="deleteLicense('${item.key}')" class="px-2 py-1 bg-red-50 text-red-700 font-bold rounded-lg text-[11px]">삭제</button>
            </td>
        </tr>
    `);

    renderPagedTableTab('trial', trials, 'table-body-trial', 'pagination-trial', (item, idx) => `
        <tr class="hover:bg-gray-50/80 transition">
            <td class="py-3 px-3 font-bold text-gray-400">${idx}</td>
            <td class="py-3 px-3 font-mono font-black text-emerald-600 select-all">${item.key}</td>
            <td class="py-3 px-3 font-black text-gray-900">${item.phone || '-'}</td>
            <td class="py-3 px-3"><span class="font-mono text-[11px] text-gray-700">${item.deviceId || '-'}</span></td>
            <td class="py-3 px-3 font-bold">${item.expireDate || '-'}</td>
            <td class="py-3 px-3"><span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full text-[10px] font-black">7일체험</span></td>
            <td class="py-3 px-3 text-center space-x-1 whitespace-nowrap">
                <button onclick="openEditLicenseModal('${item.key}')" class="px-2.5 py-1 bg-blue-600 text-white font-black rounded-lg text-[11px]">수정</button>
                <button onclick="deleteLicense('${item.key}')" class="px-2 py-1 bg-red-50 text-red-700 font-bold rounded-lg text-[11px]">삭제</button>
            </td>
        </tr>
    `);

    renderPagedTableTab('dispatch', dispatches, 'table-body-dispatch', 'pagination-dispatch', (item, idx) => {
        const connectedDrivers = allLicenses.filter(l => l.dispatchKey === item.key);
        const slotLimitStr = item.maxSlots ? `${item.maxSlots}대 한도` : '무제한';
        const proBadge = item.isPro ? `<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full text-[10px] font-black ml-1 border border-amber-300"><i class="fa-solid fa-crown text-amber-500"></i> PRO</span>` : ``;
        return `
        <tr class="hover:bg-gray-50/80 transition">
            <td class="py-3 px-3 font-bold text-gray-400">${idx}</td>
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
                <button onclick="openEditLicenseModal('${item.key}')" class="px-2.5 py-1 bg-blue-600 text-white font-black rounded-lg text-[11px] hover:bg-blue-700 transition">수정</button>
                <button onclick="deleteLicense('${item.key}')" class="px-2 py-1 bg-red-50 text-red-700 font-bold rounded-lg text-[11px] hover:bg-red-100 transition">삭제</button>
            </td>
        </tr>`;
    });
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
    let curPage = window.masterPages[tabKey] || 1;
    if (curPage > totalPages) curPage = totalPages;
    if (curPage < 1) curPage = 1;
    window.masterPages[tabKey] = curPage;

    const start = (curPage - 1) * PAGE_SIZE_MASTER;
    const pagedList = list.slice(start, start + PAGE_SIZE_MASTER);

    tbody.innerHTML = pagedList.map((item, idx) => rowRenderer(item, start + idx + 1)).join('');
    if (pagEl) {
        pagEl.innerHTML = renderPaginationControls(tabKey, curPage, total, PAGE_SIZE_MASTER, 'changeMasterTabPagination');
    }
}

window.openEditLicenseModal = function(key) {
    const target = allLicenses.find(l => l.key === key);
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

    document.getElementById('edit-license-modal').classList.remove('hidden');
};

window.closeEditModal = function() { 
    document.getElementById('edit-license-modal').classList.add('hidden'); 
};

window.saveLicenseEdit = async function() {
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
    const target = allLicenses.find(l => l.key === origKey);

    const updatePayload = {
        key: newKey, phone: phone, expireDate: expStr, status: status, type: type, deviceId: deviceId,
        dispatchKey: target ? target.dispatchKey || '' : '',
        isPro: target ? target.isPro : false
    };

    try {
        if (newKey !== origKey) {
            await setDoc(doc(db, "licenses", newKey), updatePayload);
            await deleteDoc(doc(db, "licenses", origKey));
        } else {
            await updateDoc(doc(db, "licenses", origKey), updatePayload);
        }
        alert("계정 정보가 성공적으로 수정되었습니다.");
        window.closeEditModal();
    } catch (e) { alert("오류: " + e.message); }
};

window.deleteLicense = async function(key) {
    if (!confirm(`정말 [${key}] 계정을 영구 삭제하시겠습니까?`)) return;
    try {
        await deleteDoc(doc(db, "licenses", key));
        alert(`[${key}] 계정이 삭제되었습니다.`);
    } catch (e) { alert("삭제 오류: " + e.message); }
};

// === 🌟 [PRO 전용] 주문서 통합관리 및 엑셀 파싱 기능 로직 ===

window.handleProFeature = function(featureName) {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const role = sessionStorage.getItem('deliveryProRole');
    let isPro = false;

    if (dispatchKey) {
        const myLic = allLicenses.find(l => l.key === dispatchKey || l.id === dispatchKey);
        if (myLic && myLic.isPro) isPro = true;
    }
    if (role === 'MASTER' && !dispatchKey) isPro = true;

    if (isPro) {
        if (featureName === 'INVOICE') {
            document.getElementById('pro-invoice-modal').classList.remove('hidden');
            
            // 🌟 엑셀 날짜 필터(달력) UI 동적 주입 (없을 경우에만 추가)
            const listActions = document.getElementById('inv-list-actions');
            if (listActions && !document.getElementById('inv-date-picker')) {
                const dateInputHtml = `
                    <div class="flex items-center gap-1.5 mr-2">
                        <label class="text-[11px] font-black text-gray-500 bg-white px-2 py-1.5 rounded-lg border border-gray-200">저장일자</label>
                        <input type="date" id="inv-date-picker" class="px-2 py-1 bg-white border border-indigo-200 text-indigo-900 rounded-lg text-xs font-black shadow-sm outline-none focus:border-indigo-500 cursor-pointer" onchange="loadExcelFromFirebase()">
                    </div>`;
                listActions.insertAdjacentHTML('afterbegin', dateInputHtml);
                document.getElementById('inv-date-picker').value = getLocalDateString(); // 오늘 날짜 기본 세팅
            }

            window.loadSavedForms(); 
            window.loadExcelFromFirebase(); // 🌟 모달 켤때 파이어베이스에서 리스트 불러오기
            window.syncPreviewData(); 
        } else if (featureName === 'AUTO_DISPATCH') {
            alert("👑 PRO 권한 확인됨:\n[AI 자동배차] 화면 레이아웃도 곧 업데이트됩니다.");
        }
    } else {
        document.getElementById('premium-upgrade-modal').classList.remove('hidden');
    }
};

window.closePremiumModal = function() { document.getElementById('premium-upgrade-modal').classList.add('hidden'); };
window.closeProInvoiceModal = function() { document.getElementById('pro-invoice-modal').classList.add('hidden'); };

window.selectFormTemplate = function(type) {
    document.getElementById('form-template-modal').classList.add('hidden');
    const accordion = document.getElementById('form-setup-accordion');
    if (accordion && accordion.classList.contains('hidden')) {
        accordion.classList.remove('hidden');
        accordion.classList.add('flex');
    }
    window.switchInvoiceTab('PREVIEW');
    setTimeout(() => {
        const titleInput = document.getElementById('input-form-title');
        if (titleInput) titleInput.focus();
    }, 300);
};

window.switchInvoiceTab = function(tabName) {
    const btnBack = document.getElementById('inv-btn-back');
    const labelExcel = document.getElementById('inv-tab-excel-label');
    const viewExcel = document.getElementById('inv-view-excel');
    const viewPreview = document.getElementById('inv-view-preview');
    const listActions = document.getElementById('inv-list-actions');

    if (!viewExcel || !viewPreview) return;

    if (tabName === 'EXCEL') {
        viewExcel.classList.remove('hidden');
        viewPreview.classList.add('hidden');
        viewPreview.classList.remove('flex');
        
        if (btnBack) btnBack.classList.add('hidden');
        if (labelExcel) { labelExcel.classList.remove('hidden'); labelExcel.classList.add('flex'); }
        if (listActions) listActions.classList.remove('hidden');
    } else {
        viewPreview.classList.remove('hidden');
        viewPreview.classList.add('flex');
        viewExcel.classList.add('hidden');
        
        if (btnBack) btnBack.classList.remove('hidden');
        if (labelExcel) labelExcel.classList.add('hidden');
        if (listActions) listActions.classList.add('hidden');
        
        window.syncPreviewData(); // 무한루프 방지용 순수 DOM 업데이트만 호출
    }
};

// 🌟 디바운싱 처리가 안된 순수 돔 업데이트 함수 분리 (렉 방지용)
window.syncPreviewData = function() {
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
};

// 🌟 입력 지연(렉) 제거용 디바운싱(Debounce) 타이머 적용
let previewDebounceTimer = null;
window.updateLivePreview = function() {
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(() => {
        window.syncPreviewData();
        
        // 사용자가 인풋창에서 타이핑 중일때만 뷰어를 넘기도록 체크 (중복 호출 루프 방지)
        if (document.activeElement && document.activeElement.id && document.activeElement.id.startsWith('input-prov-')) {
            const viewPreview = document.getElementById('inv-view-preview');
            if (viewPreview && viewPreview.classList.contains('hidden')) {
                window.switchInvoiceTab('PREVIEW');
            }
        }
    }, 150); // 0.15초 대기 후 한 번만 화면 반영
};

// === [수정] 명세서 폼 저장 및 불러오기 ===
let currentSelectedFormIndex = null;

window.loadSavedForms = function() {
    const listEl = document.getElementById('saved-forms-list');
    if (!listEl) return;
    
    let savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    if (savedForms.length === 0) {
        listEl.innerHTML = `<div class="text-center text-gray-400 py-10 text-[10px] font-bold">저장된 폼이 없습니다.<br>아래에서 새 폼을 작성하고 저장하세요.</div>`;
        return;
    }

    let html = '';
    savedForms.forEach((form, idx) => {
        const isSelected = (currentSelectedFormIndex === idx);
        html += `
        <div class="border ${isSelected ? 'border-indigo-600 bg-indigo-50/70 ring-1 ring-indigo-400' : 'border-gray-200 bg-white hover:border-indigo-300'} rounded-xl p-2.5 shadow-xs transition flex items-center justify-between group">
            <div class="flex items-center gap-3 overflow-hidden flex-1 pl-1">
                <input type="checkbox" onchange="toggleSelectForm(${idx})" ${isSelected ? 'checked' : ''} class="w-4 h-4 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500 cursor-pointer shrink-0" title="선택/해제 토글">
                <div class="min-w-0 cursor-pointer flex-1" onclick="previewSavedForm(${idx})" title="명세서 미리보기">
                    <p class="text-[11px] font-black ${isSelected ? 'text-indigo-800' : 'text-gray-800'} truncate leading-tight hover:text-indigo-600 transition">${form.title}</p>
                    <p class="text-[9px] text-gray-400 truncate mt-0.5">${form.name}</p>
                </div>
            </div>
            <button type="button" onclick="deleteSavedForm(${idx})" class="text-gray-300 hover:text-red-500 px-1.5 py-1 transition shrink-0" title="폼 삭제"><i class="fa-solid fa-trash-can text-[10px]"></i></button>
        </div>`;
    });
    listEl.innerHTML = html;
};

window.toggleSelectForm = function(idx) {
    if (currentSelectedFormIndex === idx) {
        currentSelectedFormIndex = null;
        window.cancelProviderFormEdit(); 
        window.loadSavedForms();
    } else {
        window.applySavedForm(idx);
    }
};

window.previewSavedForm = function(idx) {
    window.applySavedForm(idx);
    window.switchInvoiceTab('PREVIEW');
};

window.cancelProviderFormEdit = function() {
    currentSelectedFormIndex = null;
    document.getElementById('input-form-title').value = '';
    document.getElementById('input-prov-regno').value = '';
    document.getElementById('input-prov-name').value = '';
    document.getElementById('input-prov-addr').value = '';
    document.getElementById('input-prov-tel').value = '';
    document.getElementById('input-prov-add-tel').value = '';
    
    const accordion = document.getElementById('form-setup-accordion');
    if (accordion) {
        accordion.classList.add('hidden');
        accordion.classList.remove('flex');
    }
    
    window.loadSavedForms();
    window.syncPreviewData();
};

window.saveProviderForm = function() {
    const title = document.getElementById('input-form-title').value.trim();
    const regno = document.getElementById('input-prov-regno').value.trim();
    const name = document.getElementById('input-prov-name').value.trim();
    const addr = document.getElementById('input-prov-addr').value.trim();
    const tel = document.getElementById('input-prov-tel').value.trim();
    const addTel = document.getElementById('input-prov-add-tel').value.trim();

    if (!title) { alert("저장할 폼의 '제목'을 입력해주세요."); document.getElementById('input-form-title').focus(); return; }

    const newForm = { title, name, regno, addr, tel, addTel, savedAt: Date.now() };
    let savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    
    const existingIdx = savedForms.findIndex(f => f.title === title);
    if(existingIdx >= 0) {
        if(confirm(`'${title}'(으)로 이미 저장된 폼이 있습니다. 덮어쓰시겠습니까?`)) {
            savedForms[existingIdx] = newForm;
        } else return;
    } else {
        savedForms.push(newForm);
    }

    localStorage.setItem('deliveryPro_savedForms', JSON.stringify(savedForms));
    alert(`[${title}] 폼이 성공적으로 저장되었습니다.`);
    window.loadSavedForms();
};

window.applySavedForm = function(idx) {
    let savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    const form = savedForms[idx];
    if (!form) return;

    currentSelectedFormIndex = idx;

    document.getElementById('input-form-title').value = form.title || '';
    document.getElementById('input-prov-regno').value = form.regno || '';
    document.getElementById('input-prov-name').value = form.name || '';
    document.getElementById('input-prov-addr').value = form.addr || '';
    document.getElementById('input-prov-tel').value = form.tel || '';
    document.getElementById('input-prov-add-tel').value = form.addTel || '';

    window.loadSavedForms(); 
    window.syncPreviewData();
};

window.deleteSavedForm = function(idx) {
    let savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    const form = savedForms[idx];
    if(!confirm(`[${form.title}] 폼을 삭제하시겠습니까?`)) return;

    savedForms.splice(idx, 1);
    localStorage.setItem('deliveryPro_savedForms', JSON.stringify(savedForms));
    if (currentSelectedFormIndex === idx) currentSelectedFormIndex = null;
    window.loadSavedForms();
};

// 🌟 [추가] 파이어베이스에서 선택한 날짜의 엑셀 데이터를 불러오는 함수
window.loadExcelFromFirebase = async function() {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    if (!dispatchKey) return;
    
    const datePicker = document.getElementById('inv-date-picker');
    const dateVal = datePicker ? datePicker.value : getLocalDateString();
    const docId = `${dateVal}_${dispatchKey}`;
    
    try {
        const snap = await getDoc(doc(db, "dispatch_orders", docId));
        if (snap.exists() && snap.data().orders) {
            parsedExcelList = snap.data().orders;
        } else {
            parsedExcelList = []; // 해당 날짜에 데이터가 없으면 비움
        }
        renderExcelTable();
    } catch (error) {
        console.error("Firebase 엑셀 로드 오류:", error);
    }
};

// 🌟 엑셀 데이터 자동 저장 (선택된 날짜 기준으로 저장)
window.autoSaveExcelToFirebase = async function() {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    if (!dispatchKey) return; 

    const datePicker = document.getElementById('inv-date-picker');
    const dateVal = datePicker ? datePicker.value : getLocalDateString(); 
    const docId = `${dateVal}_${dispatchKey}`; 
    
    try {
        await setDoc(doc(db, "dispatch_orders", docId), {
            date: dateVal,
            dispatchKey: dispatchKey,
            orders: parsedExcelList || [],
            updatedAt: Date.now()
        }, { merge: true });
        console.log("엑셀 데이터 자동 저장 완료");
    } catch (error) {
        console.error("Firebase 주문 리스트 자동 저장 오류:", error);
    }
};

function formatNumber(num) {
    if (!num || isNaN(num)) return num || '';
    return Number(num).toLocaleString('ko-KR');
}

function processExcelData(jsonData) {
    jsonData.forEach((row) => {
        const mappedRow = {
            id: Date.now() + Math.random(), 
            senderName: '', orderNo: '', bizNo: '', address: '', storeName: '',
            phone: '', itemName: '', unit: '', qty: '', price: '', total: '', memo: ''
        };

        for (let key in row) {
            const val = row[key];
            const k = key.replace(/\s+/g, ''); 
            
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
        
        if (mappedRow.senderName || mappedRow.address || mappedRow.itemName || mappedRow.storeName) {
            parsedExcelList.push(mappedRow);
        }
    });
}

window.sortExcelList = function(field) {
    if (!parsedExcelList || parsedExcelList.length === 0) return;
    
    excelSortAsc = !excelSortAsc; 
    
    parsedExcelList.sort((a, b) => {
        let valA = (a[field] || '').toString().trim();
        let valB = (b[field] || '').toString().trim();
        
        if (valA < valB) return excelSortAsc ? -1 : 1;
        if (valA > valB) return excelSortAsc ? 1 : -1;
        return 0;
    });
    
    renderExcelTable();
};

function renderExcelTable() {
    const tbody = document.getElementById('invoice-excel-tbody');
    if (!tbody) return;

    if (parsedExcelList.length === 0) {
        tbody.innerHTML = `<tr id="empty-excel-row"><td colspan="15" class="text-center py-32"><i class="fa-solid fa-file-excel text-4xl text-gray-300 mb-3 block"></i><span class="text-gray-400 font-bold text-sm">데이터가 없습니다.<br>우측 패널에 엑셀 주문서 파일을 업로드해주세요.</span></td></tr>`;
        
        const chkAll = document.getElementById('chk-excel-all');
        if (chkAll) chkAll.checked = false;
        return;
    }

    let html = '';
    parsedExcelList.forEach((item, idx) => {
        html += `
        <tr class="hover:bg-blue-50/50 cursor-pointer transition" onclick="previewInvoiceRow(${idx})">
            <td class="text-center" onclick="event.stopPropagation()"><input type="checkbox" class="cursor-pointer row-checkbox" data-idx="${idx}"></td>
            <td class="text-center font-bold text-gray-500">${idx + 1}</td>
            <td class="font-bold">${item.senderName || '-'}</td>
            <td class="text-gray-500 font-mono text-[10px]">${item.orderNo || '-'}</td>
            <td class="text-gray-500 font-mono">${item.bizNo || '-'}</td>
            <td class="truncate max-w-[200px]" title="${item.address}">${item.address || '-'}</td>
            <td class="font-black text-gray-900">${item.storeName || '-'}</td>
            <td class="font-bold text-blue-600">${item.phone || '-'}</td>
            <td class="font-bold truncate max-w-[150px]" title="${item.itemName}">${item.itemName || '-'}</td>
            <td class="text-gray-700">${item.unit || '-'}</td>
            <td class="text-right font-black">${formatNumber(item.qty)}</td>
            <td class="text-right text-gray-600">${formatNumber(item.price)}</td>
            <td class="text-right font-black text-red-600">${formatNumber(item.total)}</td>
            <td class="truncate max-w-[150px] text-gray-500 text-[10px]" title="${item.memo}">${item.memo || '-'}</td>
            <td class="text-center" onclick="event.stopPropagation()">
                <button onclick="deleteExcelRow(${idx})" class="text-red-400 hover:text-red-600 bg-red-50 hover:bg-red-100 rounded px-2 py-1 transition shadow-sm active:scale-95" title="삭제"><i class="fa-solid fa-trash-can"></i></button>
            </td>
        </tr>`;
    });
    tbody.innerHTML = html;
    
    const chkAll = document.getElementById('chk-excel-all');
    if (chkAll) {
        chkAll.checked = false;
        chkAll.onchange = (e) => {
            const isChecked = e.target.checked;
            document.querySelectorAll('.row-checkbox').forEach(cb => { cb.checked = isChecked; });
        };
    }

    window.switchInvoiceTab('EXCEL'); 
}

window.deleteExcelRow = async function(idx) {
    if(!confirm("해당 주문건을 리스트에서 삭제하시겠습니까?")) return;
    parsedExcelList.splice(idx, 1);
    renderExcelTable();
    await window.autoSaveExcelToFirebase();
};

window.deleteSelectedExcelRows = async function() {
    const checkboxes = document.querySelectorAll('.row-checkbox:checked');
    if(checkboxes.length === 0) {
        alert("삭제할 주문건을 좌측 체크박스에서 1개 이상 선택해주세요.");
        return;
    }
    if(!confirm(`선택하신 ${checkboxes.length}개의 주문건을 리스트에서 삭제하시겠습니까?`)) return;
    
    const indicesToRemove = Array.from(checkboxes).map(cb => parseInt(cb.getAttribute('data-idx')));
    parsedExcelList = parsedExcelList.filter((_, idx) => !indicesToRemove.includes(idx));
    
    renderExcelTable();
    await window.autoSaveExcelToFirebase(); 
};

window.clearAllExcelRows = async function() {
    if(parsedExcelList.length === 0) return;
    if(!confirm("업로드된 모든 주문 리스트를 비우시겠습니까?\n(되돌릴 수 없습니다)")) return;
    parsedExcelList = [];
    renderExcelTable();
    await window.autoSaveExcelToFirebase();
};

window.previewInvoiceRow = function(idx) {
    if (!parsedExcelList || !parsedExcelList[idx]) return;
    const item = parsedExcelList[idx];

    document.querySelectorAll('.prev-cust-regno').forEach(el => el.innerText = item.bizNo || '');
    document.querySelectorAll('.prev-cust-name').forEach(el => el.innerText = item.senderName || ''); 
    document.querySelectorAll('.prev-cust-store').forEach(el => el.innerText = item.storeName || '');
    document.querySelectorAll('.prev-cust-tel').forEach(el => el.innerText = item.phone || '');
    document.querySelectorAll('.prev-cust-addr').forEach(el => el.innerText = item.address || '');

    document.querySelectorAll('.prev-item-name').forEach(el => el.innerText = item.itemName || '');
    document.querySelectorAll('.prev-item-unit').forEach(el => el.innerText = item.unit || '');
    document.querySelectorAll('.prev-item-qty').forEach(el => el.innerText = formatNumber(item.qty) || '');
    document.querySelectorAll('.prev-item-price').forEach(el => el.innerText = formatNumber(item.price) || '');
    document.querySelectorAll('.prev-item-total').forEach(el => el.innerText = formatNumber(item.total) || '');
    
    let payMethod = '';
    if (item.memo && item.memo.includes('네이버페이')) payMethod = '네이버페이';
    else if (item.memo && item.memo.includes('카드')) payMethod = '카드결제';
    
    document.querySelectorAll('.prev-pay-method').forEach(el => el.innerText = payMethod);
    document.querySelectorAll('.prev-total-qty').forEach(el => el.innerText = (item.qty ? formatNumber(item.qty) + '개' : ''));
    document.querySelectorAll('.prev-cust-memo').forEach(el => el.innerText = item.memo || '');
    document.querySelectorAll('.prev-shipping-fee').forEach(el => el.innerText = '0원');
    document.querySelectorAll('.prev-item-total-amt').forEach(el => el.innerText = (item.total ? formatNumber(item.total) + '원' : ''));
    document.querySelectorAll('.prev-total-order-amt').forEach(el => el.innerText = (item.total ? formatNumber(item.total) + '원' : ''));

    document.querySelectorAll('span.font-normal.inline-block').forEach(span => {
        if (span.classList.contains('w-32')) {
            span.innerText = item.orderNo || '';
        }
    });

    window.syncPreviewData(); // 렌더링 호출을 간소화한 함수로 대체
    window.switchInvoiceTab('PREVIEW');
};

function generateInvoiceHTML(item, providerInfo) {
    const originalTemplate = document.getElementById('print-area');
    if (!originalTemplate) return '';
    const template = originalTemplate.cloneNode(true);
    template.id = ''; 

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
    template.querySelectorAll('.prev-item-qty').forEach(el => el.innerText = formatNumber(item.qty) || '');
    template.querySelectorAll('.prev-item-price').forEach(el => el.innerText = formatNumber(item.price) || '');
    template.querySelectorAll('.prev-item-total').forEach(el => el.innerText = formatNumber(item.total) || '');

    let payMethod = '';
    if (item.memo && item.memo.includes('네이버페이')) payMethod = '네이버페이';
    else if (item.memo && item.memo.includes('카드')) payMethod = '카드결제';

    template.querySelectorAll('.prev-pay-method').forEach(el => el.innerText = payMethod);
    template.querySelectorAll('.prev-total-qty').forEach(el => el.innerText = (item.qty ? formatNumber(item.qty) + '개' : ''));
    template.querySelectorAll('.prev-cust-memo').forEach(el => el.innerText = item.memo || '');
    template.querySelectorAll('.prev-shipping-fee').forEach(el => el.innerText = '0원');
    template.querySelectorAll('.prev-item-total-amt').forEach(el => el.innerText = (item.total ? formatNumber(item.total) + '원' : ''));
    template.querySelectorAll('.prev-total-order-amt').forEach(el => el.innerText = (item.total ? formatNumber(item.total) + '원' : ''));

    template.querySelectorAll('.invoice-table').forEach(table => {
        const rows = table.querySelectorAll('tr');
        rows.forEach(tr => {
            const text = tr.innerText;
            if (text.includes('주 소') && !tr.classList.contains('double-height')) {
                tr.classList.add('double-height');
                tr.querySelectorAll('td').forEach(td => {
                    if (!td.classList.contains('invoice-label')) td.classList.add('multi-line-text');
                });
            }
            if (text.includes('배 송 요 청 사 항') && !tr.classList.contains('double-height')) {
                tr.classList.add('double-height');
                tr.querySelectorAll('td').forEach(td => {
                    if (!td.classList.contains('invoice-label') && !td.classList.contains('inv-text-right')) {
                        td.classList.add('multi-line-text');
                    }
                });
            }
        });
    });

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    const dateSpan1 = template.querySelector('#prev-date-1');
    if (dateSpan1) { dateSpan1.id = ''; dateSpan1.innerText = dateStr; }
    const dateSpan2 = template.querySelector('#prev-date-2');
    if (dateSpan2) { dateSpan2.id = ''; dateSpan2.innerText = dateStr; }

    template.querySelectorAll('span.font-normal.inline-block').forEach(span => {
        if (span.classList.contains('w-32')) span.innerText = item.orderNo || '';
    });

    return template.outerHTML;
}

window.executeBatchPrint = function() {
    const checkboxes = document.querySelectorAll('.row-checkbox:checked');
    if (checkboxes.length === 0) {
        alert("출력할 주문건을 좌측 체크박스에서 1개 이상 선택해주세요.");
        return;
    }

    const btn = document.getElementById('btn-batch-print');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 문서 생성 중...';
    }

    const providerInfo = {
        title: document.getElementById('input-form-title')?.value || '',
        regno: document.getElementById('input-prov-regno')?.value || '',
        name: document.getElementById('input-prov-name')?.value || '',
        addr: document.getElementById('input-prov-addr')?.value || '',
        tel: document.getElementById('input-prov-tel')?.value || '',
        addTel: document.getElementById('input-prov-add-tel')?.value || ''
    };

    let printContents = '';

    checkboxes.forEach(cb => {
        const idx = parseInt(cb.getAttribute('data-idx'));
        const item = parsedExcelList[idx];
        if (!item) return;

        printContents += generateInvoiceHTML(item, providerInfo);
    });

    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.zIndex = '-1';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`
        <!DOCTYPE html>
        <html lang="ko">
        <head>
            <meta charset="UTF-8">
            <title>배송 동선 PRO - 표준 거래명세표 출력</title>
            <style>
                * { box-sizing: border-box; }
                @media print {
                    @page { size: A4 portrait; margin: 0; }
                    body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: white; }
                    .invoice-container { box-shadow: none !important; border: none !important; margin: 0 !important; page-break-after: always; width: 210mm; height: 297mm; }
                    .invoice-half { height: 148mm; page-break-inside: avoid; }
                }
                body { background: white; margin: 0; padding: 0; font-family: 'Malgun Gothic', 'Dotum', sans-serif; }
                
                .invoice-container { background-color: white; width: 210mm; height: 297mm; margin: 0 auto; position: relative; display: flex; flex-direction: column; overflow: hidden; }
                .invoice-half { height: 148mm; background-color: #ffeb5c !important; padding: 5mm 8mm; display: flex; flex-direction: column; overflow: hidden; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                .invoice-cut-line { border-top: 1px dashed #6b7280; width: 100%; margin: 0; }
                
                .invoice-title { text-align: center; font-size: 21px; font-weight: 900; letter-spacing: 6px; text-decoration: underline; margin-bottom: 5px; color: #000; }
                .invoice-table { width: 100%; border-collapse: collapse; border: 2px solid #000; font-size: 10px; margin-bottom: 4px; table-layout: fixed; color: #000; }
                
                .invoice-table th, .invoice-table td { border: 1px solid #000; padding: 2px 5px; height: 27px; vertical-align: middle; overflow: hidden; word-break: break-all; overflow-wrap: break-word; }

                .double-height { height: 54px !important; min-height: 54px !important; }
                .double-height td { height: 54px !important; }

                .multi-line-text { white-space: normal !important; word-break: break-all; line-height: 1.3; }

                .invoice-table th { font-weight: bold; text-align: center; background-color: transparent !important; }
                .invoice-label { background-color: transparent !important; font-weight: bold; text-align: center; white-space: nowrap; letter-spacing: -0.2px; }
                .writing-mode-vertical { writing-mode: vertical-rl; text-orientation: upright; text-align: center; letter-spacing: 3px; padding: 2px !important; line-height: 1.2; }
                .text-fit-auto { font-size: 9.5px; letter-spacing: -0.3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .inv-text-center { text-align: center; }
                .inv-text-left { text-align: left; padding-left: 6px !important; }
                .inv-text-right { text-align: right; padding-right: 6px !important; }
                .inv-font-bold { font-weight: bold; }
                .empty-row td { height: 27px; }
            </style>
        </head>
        <body>
            ${printContents}
        </body>
        </html>
    `);
    doc.close();

    iframe.onload = function() {
        setTimeout(() => {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
            
            setTimeout(() => {
                document.body.removeChild(iframe);
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = `<i class="fa-solid fa-print text-sm"></i> 명세서 일괄 출력`;
                }
            }, 1000);
        }, 800); 
    };
};

setTimeout(() => {
    const dropZone = document.getElementById('excel-drop-zone');
    if (dropZone) {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.xlsx, .xls, .csv';
        fileInput.multiple = true; 
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);

        fileInput.addEventListener('change', handleExcelUpload);

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('bg-indigo-100', 'border-indigo-500');
        });
        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dropZone.classList.remove('bg-indigo-100', 'border-indigo-500');
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('bg-indigo-100', 'border-indigo-500');
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                fileInput.files = e.dataTransfer.files;
                handleExcelUpload({ target: fileInput });
            }
        });
        dropZone.addEventListener('click', () => { fileInput.click(); });
    }
}, 1000);

async function handleExcelUpload(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const previousCount = parsedExcelList.length;

    for (let i = 0; i < files.length; i++) {
        await processSingleExcelFile(files[i]);
    }

    const addedCount = parsedExcelList.length - previousCount;
    if (addedCount > 0) {
        renderExcelTable();
        await window.autoSaveExcelToFirebase(); 
        alert(`[업로드 및 자동 저장 완료]\n${files.length}개의 파일에서 총 ${addedCount}건의 주문 데이터가 추가/저장되었습니다.\n(현재 리스트 총 ${parsedExcelList.length}건)`);
    } else {
        alert(`업로드 완료.\n하지만 올바른 양식의 주문 데이터를 찾을 수 없어 추가된 항목이 없습니다.`);
    }
    e.target.value = ''; 
}

function processSingleExcelFile(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = function(evt) {
            try {
                const data = new Uint8Array(evt.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const json = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
                processExcelData(json);
                resolve();
            } catch(err) {
                console.error("파일 파싱 실패:", err);
                resolve(); 
            }
        };
        reader.readAsArrayBuffer(file);
    });
}

window.showDispatchPopupAlert = function(msg) {
    activeDispatchPopupMsgId = msg.id;
    const contentEl = document.getElementById('dispatch-popup-alert-content');
    const timeEl = document.getElementById('dispatch-popup-alert-time');
    const modal = document.getElementById('dispatch-popup-alert-modal');
    if (!contentEl || !modal) return;
    contentEl.innerText = msg.content || '';
    timeEl.innerText = `${msg.timeStr || '방금'} 수신`;
    modal.classList.remove('hidden');
    playBeepSound();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
};

window.closeDispatchPopupAlertModal = function() {
    if (activeDispatchPopupMsgId) localStorage.setItem(`acked_disp_inbox_${activeDispatchPopupMsgId}`, 'true');
    const modal = document.getElementById('dispatch-popup-alert-modal');
    if (modal) modal.classList.add('hidden');
    activeDispatchPopupMsgId = null;
    window.checkDispatchInboxNotifications();
};

window.checkDispatchInboxNotifications = function() {
    if (currentUserRole !== 'DISPATCH') return;
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const sessionToken = sessionStorage.getItem('deliveryProSessionToken');
    const matchedLic = allLicenses.find(l => l.key === dispatchKey);
    const phone = (matchedLic?.phone || '').replace(/[^0-9]/g, '');

    const normalizeKey = (k) => k ? k.toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '') : '';
    const normalizedDispatchKey = normalizeKey(dispatchKey);

    const myReceivedMasterNotices = allDispatchMessages.filter(msg => {
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
            window.showDispatchPopupAlert(latest);
        }
    }
};

window.openDispatchInboxModal = function() {
    const container = document.getElementById('dispatch-inbox-container');
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const sessionToken = sessionStorage.getItem('deliveryProSessionToken');
    const matchedLic = allLicenses.find(l => l.key === dispatchKey);
    const phone = (matchedLic?.phone || '').replace(/[^0-9]/g, '');

    const normalizeKey = (k) => k ? k.toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '') : '';
    const normalizedDispatchKey = normalizeKey(dispatchKey);

    const myReceivedMasterNotices = allDispatchMessages.filter(msg => {
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
                    <div class="flex items-center gap-2"><span class="text-[11px] font-mono text-gray-400">${m.dateStr || ''} ${m.timeStr || ''}</span><button type="button" onclick="deleteNoticeFromDispatchInbox('${m.id}')" class="text-gray-400 hover:text-red-500 p-1 transition active:scale-95" title="알림 삭제"><i class="fa-solid fa-trash-can text-xs"></i></button></div>
                </div>
                <p class="text-xs font-bold text-gray-800 whitespace-pre-line leading-relaxed mt-1">${m.content}</p>
            </div>`;
        });
        container.innerHTML = html;
    }
    window.checkDispatchInboxNotifications();
    document.getElementById('dispatch-inbox-modal').classList.remove('hidden');
};

window.closeDispatchInboxModal = function() { document.getElementById('dispatch-inbox-modal').classList.add('hidden'); };

window.deleteNoticeFromDispatchInbox = async function(msgId) {
    if (!confirm("이 알림을 삭제하시겠습니까?")) return;
    try {
        localStorage.setItem(`deleted_disp_msg_${msgId}`, 'true');
        window.openDispatchInboxModal();
        window.checkDispatchInboxNotifications();
    } catch(e) { alert("삭제 오류: " + e.message); }
};

window.clearAllDispatchInbox = async function() {
    if (!confirm("알림함의 모든 알림을 삭제하시겠습니까?")) return;
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const sessionToken = sessionStorage.getItem('deliveryProSessionToken');
    const matchedLic = allLicenses.find(l => l.key === dispatchKey);
    const phone = (matchedLic?.phone || '').replace(/[^0-9]/g, '');

    const normalizeKey = (k) => k ? k.toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '') : '';
    const normalizedDispatchKey = normalizeKey(dispatchKey);

    const myNotices = allDispatchMessages.filter(msg => {
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
    window.openDispatchInboxModal();
    window.checkDispatchInboxNotifications();
};

window.openMasterNoticeHistoryModal = function() {
    window.renderMasterNoticeHistoryList();
    document.getElementById('master-notice-history-modal').classList.remove('hidden');
};
window.closeMasterNoticeHistoryModal = function() { document.getElementById('master-notice-history-modal').classList.add('hidden'); };

window.renderMasterNoticeHistoryList = function() {
    const container = document.getElementById('master-notice-history-container');
    if (!container) return;
    const masterSentList = allDispatchMessages.filter(m => m.senderKey === 'MASTER' || m.senderType === 'MASTER');

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
                    <button type="button" onclick="deleteDispatchMessage('${m.id}')" class="text-red-500 hover:text-red-700 p-1 text-xs transition active:scale-95" title="이 발송 알림 삭제"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>
            <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-gray-800 whitespace-pre-line leading-relaxed">${m.content}</div>
        </div>`;
    });
    container.innerHTML = html;
};

function getFilteredVisibleDrivers() {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const isMaster = (currentUserRole === 'MASTER');
    let visibleLicenses = allLicenses.filter(l => l.type !== 'dispatch');
    if (!isMaster && dispatchKey) visibleLicenses = visibleLicenses.filter(l => l.dispatchKey === dispatchKey);
    return visibleLicenses;
}

window.renderSidebar = function() {
    if (dispatchNavState === 'DELIVERY') {
        if (selectedDeviceId) window.renderDriverDetailView(selectedDeviceId);
        else window.renderDriverListView();
    } else if (dispatchNavState === 'MESSAGE') {
        window.renderMessageSidebar();
    } else if (dispatchNavState === 'LOCATION') {
        window.renderLocationSidebar();
    }
};

window.renderDriverListView = function() {
    const headerEl = document.getElementById('sidebar-header');
    const contentEl = document.getElementById('sidebar-content');
    const visibleLicenses = getFilteredVisibleDrivers();

    headerEl.innerHTML = `
        <h2 class="text-xs font-black text-gray-700 uppercase tracking-wider flex items-center gap-1.5"><i class="fa-solid fa-truck text-blue-600"></i> 운행 기사 (<span id="driver-count">${visibleLicenses.length}</span>명)</h2>
        <button onclick="openLinkDriverModal()" id="btn-add-driver" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-black px-3 py-1.5 rounded-xl transition flex items-center gap-1 shadow-sm active:scale-95"><i class="fa-solid fa-user-plus"></i> 기사 등록</button>
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
        
        const routeData = (lic.deviceId && activeRoutes[lic.deviceId]) ? activeRoutes[lic.deviceId] : null;
        let driverRoute = null;
        if (routeData && routeData.updatedAt) {
            const routeDateStr = getLocalDateString(new Date(routeData.updatedAt));
            if (isToday || routeDateStr === selectedDate) {
                driverRoute = routeData;
            }
        }
        const rawDests = driverRoute ? driverRoute.destinations || [] : [];

        const driverDone = allCompletions.filter(c => {
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
        <div onclick="selectDriver('${devId}')" class="cursor-pointer p-3.5 rounded-2xl border bg-white hover:bg-blue-50/50 hover:border-blue-400 border-gray-200 shadow-sm transition relative mb-2">
            <div class="flex justify-between items-center mb-1.5">
                <span class="font-black text-sm text-gray-900 tracking-tight flex items-center gap-1.5"><i class="fa-solid fa-phone text-blue-500 text-xs"></i>${phone}<span class="text-[10px] text-gray-400 font-mono font-normal">[${lic.key}]</span></span>
                <div class="flex items-center gap-1.5"><span class="text-xs font-black px-2 py-0.5 rounded-full ${rate === 100 ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}">${rate}%</span><button onclick="event.stopPropagation(); removeOrUnlinkDriver('${devId}', '${lic.key}')" class="text-[10px] text-gray-400 hover:text-red-600 bg-gray-100 hover:bg-red-50 border border-gray-200 px-2 py-0.5 rounded-md font-bold transition">연결해제</button></div>
            </div>
            <div class="w-full bg-gray-100 rounded-full h-1.5 mb-2.5 overflow-hidden"><div class="bg-blue-600 h-1.5 rounded-full transition-all duration-500" style="width: ${rate}%"></div></div>
            <div class="flex justify-between text-[11px] font-bold text-gray-600"><span>잔여: <b class="text-blue-600 font-black text-xs">${pendingCount}</b>건</span><span>완료: <b class="text-emerald-600 font-black text-xs">${doneCount}</b>건</span></div>
        </div>`;
    });
    contentEl.innerHTML = html;
};

window.setDispatchDetailTab = function(tab) {
    dispatchDetailTab = tab; window.dispatchDetailTab = tab;
    if (selectedDeviceId) window.renderDriverDetailView(selectedDeviceId);
};

window.renderDriverDetailView = function(devId) {
    const headerEl = document.getElementById('sidebar-header');
    const contentEl = document.getElementById('sidebar-content');
    const matchedLic = allLicenses.find(l => l.deviceId === devId || l.key === devId);
    const driver = activeRoutes[devId] || null;
    const phone = driver?.phone || matchedLic?.phone || '기사';

    headerEl.innerHTML = `
        <div class="flex items-center justify-between w-full">
            <button onclick="clearSelectedDriver()" class="text-xs font-black text-blue-600 hover:bg-blue-50 px-2.5 py-1.5 rounded-xl transition flex items-center gap-1 border border-blue-200"><i class="fa-solid fa-arrow-left"></i> 기사 목록</button>
            <span class="text-xs font-black text-gray-900 bg-white border border-gray-200 shadow-sm px-3 py-1.5 rounded-xl truncate"><i class="fa-solid fa-phone text-blue-500 mr-1 text-[11px]"></i>${phone}</span>
        </div>
    `;

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

    const driverDone = allCompletions.filter(c => {
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
        <button onclick="setDispatchDetailTab('ROUTE')" class="flex-1 py-2 rounded-lg transition ${window.dispatchDetailTab === 'ROUTE' ? 'bg-blue-600 text-white shadow-xs' : 'text-gray-600 hover:text-gray-900'}">
            <i class="fa-solid fa-route mr-1"></i> 동선 (${totalCount})
        </button>
        <button onclick="setDispatchDetailTab('PENDING')" class="flex-1 py-2 rounded-lg transition ${window.dispatchDetailTab === 'PENDING' ? 'bg-amber-600 text-white shadow-xs' : 'text-gray-600 hover:text-gray-900'}">
            <i class="fa-solid fa-clock mr-1"></i> 미처리 (${pendingCount})
        </button>
        <button onclick="setDispatchDetailTab('DONE')" class="flex-1 py-2 rounded-lg transition ${window.dispatchDetailTab === 'DONE' ? 'bg-emerald-600 text-white shadow-xs' : 'text-gray-600 hover:text-gray-900'}">
            <i class="fa-solid fa-circle-check mr-1"></i> 완료 (${doneCount})
        </button>
    </div>`;

    if (window.dispatchDetailTab === 'ROUTE') {
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
                <div onclick="focusMapPosition(${d.lat}, ${d.lng})" class="p-2.5 rounded-xl border ${isDone ? 'bg-emerald-50/40 border-emerald-200' : 'bg-white border-gray-200 hover:border-blue-400'} flex items-center justify-between text-xs shadow-xs cursor-pointer transition">
                    <div class="flex items-center gap-2 min-w-0 flex-1">${numberBadge}${addressHtml}</div><div class="flex items-center gap-1.5 shrink-0 ml-2">${photoBtn}${statusBadge}</div>
                </div>`;
            });
            html += `</div>`;
        }
    } else if (window.dispatchDetailTab === 'PENDING') {
        if (remainingDests.length === 0) {
            html += `<div class="text-center text-gray-400 py-16 text-xs font-bold space-y-1"><i class="fa-solid fa-circle-check text-2xl text-emerald-500 mb-1"></i><p>모든 배송이 완료되었습니다!</p></div>`;
        } else {
            html += `<div class="space-y-1.5 pb-4">`;
            remainingDests.forEach((d, idx) => {
                html += `
                <div onclick="focusMapPosition(${d.lat}, ${d.lng})" class="p-2.5 rounded-xl border bg-amber-50/40 border-amber-200 hover:border-amber-400 flex items-center justify-between text-xs shadow-xs cursor-pointer transition">
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
                <div onclick="focusMapPosition(${c.lat}, ${c.lng})" class="p-2.5 bg-white border border-emerald-200 hover:border-emerald-400 rounded-xl flex items-center justify-between text-xs shadow-xs cursor-pointer transition">
                    <div class="flex items-center gap-2 min-w-0 flex-1"><span class="w-5 h-5 bg-emerald-600 text-white rounded-full flex items-center justify-center font-black text-[10px] shrink-0">${idx + 1}</span><span class="font-bold text-gray-800 truncate">${c.address}</span></div>
                    <div class="flex items-center gap-1.5 shrink-0 ml-2">${photoBtn}<span class="bg-emerald-600 text-white text-[10px] font-black px-2 py-0.5 rounded shadow-sm whitespace-nowrap">✓ ${timeOnly} [${c.tag || '완료'}]</span></div>
                </div>`;
            });
            html += `</div>`;
        }
    }
    contentEl.innerHTML = html;
};

window.selectDriver = function(devId) {
    selectedDeviceId = devId; window.renderSidebar();
    if (dispatchNavState === 'DELIVERY') window.drawDriverOnMap(devId);
};

window.clearSelectedDriver = function() { 
    selectedDeviceId = null; 
    window.forceClearMap(); 
    window.renderSidebar(); 
};

window.removeOrUnlinkDriver = async function(devId, key) {
    if (!confirm(`[${key}] 기사와의 관제 연결을 해제하시겠습니까?`)) return;
    try { await updateDoc(doc(db, "licenses", key), { dispatchKey: "" }); alert("연결이 해제되었습니다."); } catch (e) { alert("오류: " + e.message); }
};

window.renderMessageSidebar = function() {
    const headerEl = document.getElementById('sidebar-header');
    const contentEl = document.getElementById('sidebar-content');
    const visibleLicenses = getFilteredVisibleDrivers();

    headerEl.innerHTML = `
        <h2 class="text-xs font-black text-gray-700 uppercase tracking-wider flex items-center gap-1.5"><i class="fa-solid fa-comments text-blue-600"></i> 수신 기사 선택</h2>
        <button onclick="toggleAllMessageSelection()" class="text-[11px] font-black text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md border border-blue-200 hover:bg-blue-100 transition">
            ${window.selectedMessageDrivers.size === visibleLicenses.length && visibleLicenses.length > 0 ? '선택 해제' : '전체 선택'}
        </button>`;

    if (visibleLicenses.length === 0) {
        contentEl.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">등록된 기사가 없습니다.</div>`; return;
    }
    let html = `<div class="space-y-2">`;
    visibleLicenses.forEach(lic => {
        const devId = lic.deviceId || lic.key;
        const phone = lic.phone || '연락처 미등록';
        const isChecked = window.selectedMessageDrivers.has(devId);
        html += `
        <label class="flex items-center justify-between p-3.5 bg-white border ${isChecked ? 'border-blue-500 bg-blue-50/40 ring-1 ring-blue-300' : 'border-gray-200 hover:bg-gray-50'} rounded-2xl cursor-pointer transition shadow-xs">
            <div class="flex items-center gap-3">
                <input type="checkbox" onchange="toggleMessageDriver('${devId}')" ${isChecked ? 'checked' : ''} class="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer">
                <div><span class="font-black text-sm text-gray-900 block leading-tight">${phone}</span><span class="text-[10px] text-gray-400 font-mono">ID: ${lic.key}</span></div>
            </div>
            <span class="text-[10px] font-black px-2 py-0.5 rounded-full ${isChecked ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'}">${isChecked ? '선택됨' : '대기'}</span>
        </label>`;
    });
    html += `</div>`;
    contentEl.innerHTML = html;
    document.getElementById('msg-selected-count').innerText = window.selectedMessageDrivers.size;
};

window.toggleMessageDriver = function(devId) {
    if (window.selectedMessageDrivers.has(devId)) window.selectedMessageDrivers.delete(devId);
    else window.selectedMessageDrivers.add(devId);
    window.renderMessageSidebar();
};

window.toggleAllMessageSelection = function() {
    const visibleLicenses = getFilteredVisibleDrivers();
    if (window.selectedMessageDrivers.size === visibleLicenses.length) window.selectedMessageDrivers.clear();
    else visibleLicenses.forEach(lic => window.selectedMessageDrivers.add(lic.deviceId || lic.key));
    window.renderMessageSidebar();
};

window.updateMessageCharCount = function() {
    const len = document.getElementById('message-input').value.length;
    document.getElementById('message-char-count').innerText = `${len} / 300자`;
};

window.sendDispatchMessage = async function() {
    const textarea = document.getElementById('message-input');
    const text = textarea.value.trim();
    const btn = document.getElementById('btn-send-message');
    if (window.selectedMessageDrivers.size === 0) { alert("좌측 목록에서 회사 알림을 수신할 기사님을 1명 이상 선택해 주세요."); return; }
    if (!text) { alert("전송할 회사 알림 내용을 입력해 주세요."); textarea.focus(); return; }

    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey') || 'MASTER';
    const targets = Array.from(window.selectedMessageDrivers);
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 전송 중...';

    try {
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const dateStr = getLocalDateString(now);

        const targetPhones = [];
        targets.forEach(tId => {
            const lic = allLicenses.find(l => (l.deviceId && l.deviceId === tId) || l.key === tId);
            if (lic && lic.phone) targetPhones.push(lic.phone);
            else targetPhones.push(tId);
        });

        await addDoc(collection(db, "dispatch_messages"), {
            senderKey: dispatchKey, senderType: "DISPATCH", senderTitle: "회사 알림", 
            targetDeviceIds: targets, targetPhones: targetPhones, content: text,
            createdAt: now.getTime(), dateStr: dateStr, timeStr: timeStr, acknowledged: []
        });
        alert(`[회사 알림 발송 완료]\n${targets.length}명의 기사 스마트폰으로 알림이 실시간 전송되었습니다.`);
        textarea.value = ''; window.updateMessageCharCount();
    } catch (e) { alert("알림 전송 오류: " + e.message); } 
    finally { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane text-xs"></i><span>회사 알림 발송</span>'; }
};

window.deleteDispatchMessage = async function(msgId) {
    if (!confirm("이 발송 알림 기록을 삭제하시겠습니까?")) return;
    try { await deleteDoc(doc(db, "dispatch_messages", msgId)); } catch (e) { alert("삭제 오류: " + e.message); }
};

window.renderMessageFeed = function() {
    const feedEl = document.getElementById('dispatch-message-feed');
    if (!feedEl) return;
    const currentDispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const mySentMessages = allDispatchMessages.filter(msg => {
        if (msg.senderKey === 'MASTER' || msg.senderType === 'MASTER') return false;
        if (currentUserRole === 'DISPATCH') return msg.senderKey === currentDispatchKey;
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
                    <button type="button" onclick="deleteDispatchMessage('${msg.id}')" class="text-gray-400 hover:text-red-500 p-1 transition" title="이 기록 삭제"><i class="fa-solid fa-trash-can text-xs"></i></button>
                </div>
            </div>
            <div class="p-3 bg-slate-50 border border-slate-200/80 rounded-xl text-xs font-bold text-gray-800 whitespace-pre-line leading-relaxed">${msg.content}</div>
        </div>`;
    });
    feedEl.innerHTML = html;
};

window.saveCustomTemplate = async function() {
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
};

window.updateMessageCharCount = function() {
    const len = document.getElementById('message-input').value.length;
    document.getElementById('message-char-count').innerText = `${len} / 300자`;
};

window.insertCustomTemplate = function(content) {
    const textarea = document.getElementById('message-input');
    textarea.value = content; textarea.focus(); window.updateMessageCharCount();
};

window.deleteCustomTemplate = async function(id) {
    if (!confirm("이 알림 틀을 삭제하시겠습니까?")) return;
    try { await deleteDoc(doc(db, "dispatch_templates", id)); } catch (e) { alert("삭제 오류: " + e.message); }
};

window.renderCustomTemplates = function() {
    const listEl = document.getElementById('custom-template-list');
    if (!listEl) return;
    if (allDispatchTemplates.length === 0) { listEl.innerHTML = `<div class="text-center text-gray-400 py-12 text-xs font-bold">저장된 알림 틀이 없습니다.</div>`; return; }

    let html = '';
    allDispatchTemplates.forEach(tpl => {
        const escapedContent = (tpl.content || '').replace(/"/g, '&quot;').replace(/'/g, "\\'").replace(/\n/g, '\\n');
        html += `
        <div class="group p-3 bg-white border border-gray-200 rounded-2xl hover:border-blue-400 hover:shadow-xs transition flex flex-col gap-1.5 relative">
            <div class="flex justify-between items-start gap-2">
                <span onclick="insertCustomTemplate('${escapedContent}')" class="font-black text-xs text-gray-900 cursor-pointer hover:text-blue-600 flex items-center gap-1.5 truncate flex-1"><i class="fa-solid fa-file-lines text-blue-500 text-[11px] shrink-0"></i><span class="truncate">${tpl.title || '제목 없음'}</span></span>
                <button onclick="deleteCustomTemplate('${tpl.id}')" class="text-gray-300 hover:text-red-500 p-1 text-xs transition" title="틀 삭제"><i class="fa-solid fa-trash-can text-[11px]"></i></button>
            </div>
            <p onclick="insertCustomTemplate('${escapedContent}')" class="text-[11px] text-gray-600 font-medium line-clamp-2 leading-relaxed cursor-pointer hover:text-gray-800">${tpl.content || ''}</p>
        </div>`;
    });
    listEl.innerHTML = html;
};

window.renderLocationSidebar = function() {
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
        const driver = activeRoutes[devId];
        const driverComps = allCompletions.filter(c => c.deviceId === devId || (c.phone && c.phone === lic.phone)).sort((a,b) => b.completedAt - a.completedAt);
        
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
                <button onclick="focusDriverLocationOnMap('${devId}')" class="py-2 px-3 bg-blue-50 hover:bg-blue-100 text-blue-700 font-black rounded-xl text-xs flex items-center justify-center gap-1.5 transition active:scale-95 border border-blue-200 shadow-xs"><i class="fa-solid fa-crosshairs text-[11px]"></i> 위치 확인</button>
                <button onclick="jumpToDriverDelivery('${devId}')" class="py-2 px-3 bg-slate-900 hover:bg-slate-800 text-white font-black rounded-xl text-xs flex items-center justify-center gap-1.5 transition active:scale-95 shadow-xs"><i class="fa-solid fa-route text-[10px]"></i> 배송 관리</button>
            </div>
        </div>`;
    });
    html += `</div>`;
    contentEl.innerHTML = html;
};

window.jumpToDriverDelivery = function(devId) {
    window.setDispatchMode('DELIVERY');
    window.selectDriver(devId);
};

function isAllowedWorkingHours() {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    return (day >= 1 && day <= 5) && (hour >= 9 && hour < 17);
}

window.focusDriverLocationOnMap = async function(devId) {
    const matchedLic = allLicenses.find(l => l.deviceId === devId || l.key === devId);
    const phoneName = matchedLic?.phone || '기사님';

    if (!isAllowedWorkingHours()) {
        alert("[프라이버시 보호 기능]\n\n기사님의 평일(월~금) 오전 9시 ~ 오후 5시 업무 시간 외에는 실시간 위치를 추적할 수 없습니다.\n\n시스템에 저장된 마지막 확인 위치를 표시합니다.");
        window.showFallbackLocation(devId);
        return;
    }
    if (!map) return;
    window.closeCurrentLocationOverlay();

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
                        <div class="flex justify-between items-center pt-1.5 border-t border-slate-800 text-[11px]"><span class="font-bold text-gray-300"><i class="fa-solid fa-phone text-emerald-400 mr-1"></i>${phoneName}</span><button onclick="closeCurrentLocationOverlay()" class="text-gray-400 hover:text-white px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-bold transition active:scale-95">닫기</button></div>
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
            window.showFallbackLocation(devId);
        }
    }, 7000);
};

window.showFallbackLocation = async function(devId) {
    const matchedLic = allLicenses.find(l => l.deviceId === devId || l.key === devId);
    const driver = activeRoutes[devId];
    let lat = null, lng = null, timeStr = '마지막 수신', knownAddress = null;

    const driverComps = allCompletions.filter(c => c.deviceId === devId || (c.phone && c.phone === matchedLic?.phone)).sort((a,b) => b.completedAt - a.completedAt);
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
            <div class="flex justify-between items-center pt-1.5 border-t border-slate-800 text-[11px]"><span class="font-bold text-gray-300"><i class="fa-solid fa-phone text-sky-400 mr-1"></i>${phone}</span><button onclick="closeCurrentLocationOverlay()" class="text-gray-400 hover:text-white px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-bold transition active:scale-95">닫기</button></div>
            <div class="absolute left-1/2 -bottom-2 -translate-x-1/2 w-0 h-0 border-x-8 border-x-transparent border-t-8 border-t-sky-400"></div>
        </div>`;
    window.currentLocationOverlay = new kakao.maps.CustomOverlay({ position: pos, content: overlayContainer, zIndex: 100 });
    window.currentLocationOverlay.setMap(map); 
    window.myMapOverlays.push(window.currentLocationOverlay);

    const resolvedAddr = await getAddressFromCoords(lat, lng);
    const finalAddr = resolvedAddr || knownAddress || "주소 정보를 변환할 수 없습니다.";
    const addrEl = document.getElementById('loc-overlay-addr');
    if (addrEl) addrEl.innerHTML = `<i class="fa-solid fa-map-pin text-sky-400 mr-1 text-xs"></i>${finalAddr}`;
};

window.closeCurrentLocationOverlay = function() {
    if (window.currentLocationOverlay) { window.currentLocationOverlay.setMap(null); window.currentLocationOverlay = null; }
};

window.drawAllDriversOnMap = function() {
    window.forceClearMap();
    if (!map) return;
    const visibleLicenses = getFilteredVisibleDrivers();
    const bounds = new kakao.maps.LatLngBounds();
    let hasPoints = false;
    visibleLicenses.forEach(lic => {
        const devId = lic.deviceId || lic.key; const driver = activeRoutes[devId];
        let pos = null;
        const driverComps = allCompletions.filter(c => c.deviceId === devId || (c.phone && c.phone === lic.phone)).sort((a,b) => b.completedAt - a.completedAt);
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
};
window.fitMapToAllDrivers = function() { window.drawAllDriversOnMap(); };

window.drawDriverOnMap = function(devId) {
    window.forceClearMap(); 
    const matchedLic = allLicenses.find(l => l.deviceId === devId || l.key === devId);
    const driver = activeRoutes[devId] || null;
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

    const completions = allCompletions.filter(c => {
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

    completions.forEach(comp => {
        if (comp.lat && comp.lng) {
            const pos = new kakao.maps.LatLng(comp.lat, comp.lng);
            bounds.extend(pos); completedPath.push(pos); pointsCount++;
            const content = document.createElement('div');
            content.className = 'custom-overlay completed';
            content.innerHTML = `<i class="fa-solid fa-check mr-1"></i>${comp.tag || '완료'}`;
            const overlay = new kakao.maps.CustomOverlay({ position: pos, content: content, yAnchor: 1.1 });
            overlay.setMap(map); 
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
                    overlay.setMap(map); 
                    window.myMapOverlays.push(overlay);
                }
            }
        });
    }

    if (plannedPath.length > 1 && driverRoute) {
        window.mapPlannedPolyline = new kakao.maps.Polyline({
            path: plannedPath, strokeWeight: 4, strokeColor: '#2563eb', strokeOpacity: 0.7, strokeStyle: 'solid'
        });
        if (currentMapPolylineMode === 'all' || currentMapPolylineMode === 'planned') {
            window.mapPlannedPolyline.setMap(map);
        }
    }

    if (completedPath.length > 1) {
        window.mapCompletedPolyline = new kakao.maps.Polyline({
            path: completedPath, strokeWeight: 5, strokeColor: '#10b981', strokeOpacity: 0.85, strokeStyle: 'solid'
        });
        if (currentMapPolylineMode === 'all' || currentMapPolylineMode === 'completed') {
            window.mapCompletedPolyline.setMap(map);
        }
    }

    if (pointsCount > 0) map.setBounds(bounds);
};

window.setMapPolylineMode = function(mode) {
    currentMapPolylineMode = mode;
    ['all', 'planned', 'completed'].forEach(m => {
        const btn = document.getElementById(`btn-mode-${m}`);
        if (m === mode) btn.className = "px-3 py-1.5 rounded-lg bg-blue-600 text-white transition shadow-sm font-black";
        else btn.className = "px-3 py-1.5 rounded-lg text-gray-700 hover:bg-gray-100 transition font-black flex items-center gap-1";
    });
    if (window.mapPlannedPolyline) window.mapPlannedPolyline.setMap(mode === 'all' || mode === 'planned' ? map : null);
    if (window.mapCompletedPolyline) window.mapCompletedPolyline.setMap(mode === 'all' || mode === 'completed' ? map : null);
};

window.focusMapPosition = function(lat, lng) { focusMapPosition(lat, lng); };
window.changeDispatchDate = function(days) {
    const picker = document.getElementById('dispatch-date-picker');
    if (!picker) return;
    let parts = (picker.value || todayStr).split('-');
    const curDate = new Date(parts[0], parts[1] - 1, parts[2]);
    curDate.setDate(curDate.getDate() + days);
    picker.value = getLocalDateString(curDate);
    window.onDispatchDateChange();
};
window.onDispatchDateChange = function() {
    window.renderSidebar();
    if (selectedDeviceId && dispatchNavState === 'DELIVERY') window.drawDriverOnMap(selectedDeviceId);
};
window.resetDispatchDateToToday = function() {
    const picker = document.getElementById('dispatch-date-picker');
    if (picker) picker.value = todayStr;
    window.onDispatchDateChange();
};
window.clearSearchInput = function() {
    document.getElementById('global-search-input').value = '';
    document.getElementById('search-dropdown').classList.add('hidden');
    document.getElementById('search-clear-btn').classList.add('hidden');
};
window.jumpToDeliveryTarget = function(devId, lat, lng, dateStr) {
    document.getElementById('search-dropdown').classList.add('hidden');
    window.clearSearchInput();
    if (dateStr) document.getElementById('dispatch-date-picker').value = dateStr;
    window.setDispatchMode('DELIVERY', true);
    if (devId) window.selectDriver(devId);
    if (lat && lng) window.focusMapPosition(lat, lng);
};

window.handleGlobalSearch = function(query) {
    const dropdown = document.getElementById('search-dropdown');
    const clearBtn = document.getElementById('search-clear-btn');
    const q = query.trim().toLowerCase();
    if (!q) { dropdown.classList.add('hidden'); clearBtn.classList.add('hidden'); return; }
    clearBtn.classList.remove('hidden');

    const addressGroups = {};
    for (let devId in activeRoutes) {
        const r = activeRoutes[devId];
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
    allCompletions.forEach(c => {
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
            <div onclick="jumpToDeliveryTarget('${latest.devId}', ${latest.lat}, ${latest.lng}, '${latest.dateStr}')" class="p-2.5 rounded-xl border ${latest.type === 'DONE' ? 'bg-emerald-50/40 border-emerald-200' : 'bg-blue-50/40 border-blue-200'} cursor-pointer hover:shadow-xs transition">
                <div class="flex justify-between items-center text-xs">
                    <div class="flex items-center gap-1.5"><span class="text-[10px] font-black px-1.5 py-0.5 rounded ${isToday ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}">${latest.dateStr} ${isToday ? '(오늘)' : ''}</span><span class="font-bold text-gray-800">${latest.phone}</span></div>
                    <span class="font-black text-[11px] ${latest.type === 'DONE' ? 'text-emerald-700' : 'text-blue-700'}">${latest.type === 'DONE' ? `✓ 완료 [${latest.tag}] ${latest.timeStr}` : `➔ ${latest.displayNumber || 1}번 이동 대기`}</span>
                </div>
            </div>
        </div>`;
    });
    dropdown.innerHTML = html; dropdown.classList.ensure ? dropdown.classList.remove('hidden') : dropdown.classList.remove('hidden');
};

window.openLinkDriverModal = function() {
    document.getElementById('link-driver-key-input').value = '';
    document.getElementById('link-driver-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('link-driver-key-input').focus(), 100);
};
window.closeLinkDriverModal = function() { document.getElementById('link-driver-modal').classList.add('hidden'); };

window.confirmLinkDriver = async function() {
    const rawInput = document.getElementById('link-driver-key-input').value.trim().toUpperCase();
    if (!rawInput) { alert("기사 키 또는 전화번호를 입력하세요."); return; }
    const currentKey = sessionStorage.getItem('deliveryProDispatchKey') || 'MASTER';

    try {
        const cleanDigits = rawInput.replace(/[^0-9]/g, '');
        const rawKeyOnly = rawInput.replace(/^(PRO|TRIAL|CTRL)-/i, '');
        let targetLic = allLicenses.find(l => {
            if (l.type === 'dispatch') return false;
            const lKey = (l.key || '').toUpperCase();
            const lPhone = (l.phone || '').replace(/[^0-9]/g, '');
            const lRawKey = lKey.replace(/^(PRO|TRIAL|CTRL)-/i, '');
            return lKey === rawInput || lRawKey === rawKeyOnly || (cleanDigits.length >= 8 && lPhone === cleanDigits);
        });

        if (!targetLic) {
            let directSnap = await getDoc(doc(db, "licenses", rawInput));
            if (!directSnap.exists()) directSnap = await getDoc(doc(db, "licenses", `TRIAL-${rawInput}`));
            if (!directSnap.exists()) directSnap = await getDoc(doc(db, "licenses", `PRO-${rawInput}`));
            if (directSnap.exists()) targetLic = { id: directSnap.id, ...directSnap.data() };
        }

        if (!targetLic) { alert("해당 기사 계정을 찾을 수 없습니다."); return; }
        if (targetLic.dispatchKey && targetLic.dispatchKey !== currentKey && currentKey !== 'MASTER') {
            alert(`이미 다른 관제소([${targetLic.dispatchKey}])에서 관리 중인 기사입니다.\n마스터 관리자를 통해서만 소속 변경이 가능합니다.`); return;
        }
        await updateDoc(doc(db, "licenses", targetLic.key || targetLic.id), { dispatchKey: currentKey });
        alert(`[등록 완료] 기사 [${targetLic.phone || targetLic.key}] 님이 연결되었습니다.`);
        window.closeLinkDriverModal();
    } catch (e) { alert("오류: " + e.message); }
};

window.openExcelExportModal = function() {
    const today = getLocalDateString();
    document.getElementById('export-start-date').value = today;
    document.getElementById('export-end-date').value = today;
    document.getElementById('excel-export-modal').classList.remove('hidden');
};

window.closeExcelExportModal = function() {
    document.getElementById('excel-export-modal').classList.add('hidden');
};

window.executeExcelExport = function() {
    const startDateStr = document.getElementById('export-start-date').value;
    const endDateStr = document.getElementById('export-end-date').value;
    const isCompleted = document.getElementById('chk-export-completed').checked;
    const isPending = document.getElementById('chk-export-pending').checked;
    const isCanceled = document.getElementById('chk-export-canceled').checked;

    if (!startDateStr || !endDateStr) { alert("시작일과 종료일을 모두 선택해주세요."); return; }
    if (startDateStr > endDateStr) { alert("시작일이 종료일보다 클 수 없습니다. 날짜를 다시 확인해주세요."); return; }
    if (!isPending && !isCompleted && !isCanceled) { alert("출력할 데이터를 하나 이상 선택해주세요."); return; }

    const startTs = new Date(`${startDateStr}T00:00:00`).getTime();
    const endTs = new Date(`${endDateStr}T23:59:59`).getTime();

    const visibleLicenses = getFilteredVisibleDrivers();
    const visibleDeviceIds = visibleLicenses.map(l => l.deviceId || l.key);
    const visiblePhones = visibleLicenses.map(l => l.phone).filter(p => p);

    const wb = XLSX.utils.book_new();
    let hasData = false;

    if (isCompleted) {
        const targetCompletions = allCompletions.filter(c => {
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
        for (const devId in activeRoutes) {
            if (!visibleDeviceIds.includes(devId)) continue;
            const driver = activeRoutes[devId];
            if (!driver || !driver.updatedAt) continue;

            if (driver.updatedAt >= startTs && driver.updatedAt <= endTs) {
                const dests = driver.destinations || [];
                dests.forEach(d => {
                    const isDone = allCompletions.some(c => c.deviceId === devId && c.address === d.address && c.completedAt >= startTs && c.completedAt <= endTs);
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
        const targetCanceled = allCompletions.filter(c => {
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
    window.closeExcelExportModal();
};

window.setDispatchMode = function(mode, keepSelected = false) {
    dispatchNavState = mode; window.dispatchNavState = mode;
    if (!keepSelected && mode === 'DELIVERY') selectedDeviceId = null;
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

    window.forceClearMap(); 

    if (mode === 'LOCATION') {
        if (filterControls) filterControls.classList.add('hidden');
        if (fitAllBtn) fitAllBtn.classList.remove('hidden');
        window.drawAllDriversOnMap();
    } else if (mode === 'DELIVERY') {
        if (filterControls) filterControls.classList.remove('hidden');
        if (fitAllBtn) fitAllBtn.classList.add('hidden');
        if (selectedDeviceId) window.drawDriverOnMap(selectedDeviceId);
    }
    window.renderSidebar();
};

function showDispatchPanel() {
    currentUserRole = 'DISPATCH';
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('dispatch-panel').classList.remove('hidden');
    document.getElementById('dispatch-panel').classList.add('flex');

    const currentKey = sessionStorage.getItem('deliveryProDispatchKey');
    const localToken = sessionStorage.getItem('deliveryProSessionToken');
    if (currentKey) {
        if (localToken && localToken.startsWith('MONITOR-')) {
            document.getElementById('dispatch-sub-title').innerHTML = `<span class="bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-black flex items-center gap-1"><i class="fa-solid fa-eye animate-pulse"></i> 마스터 모니터링: [${currentKey}]</span>`;
        } else {
            document.getElementById('dispatch-sub-title').innerText = `관제 센터 [${currentKey}]`;
        }
    }
    initKakaoMap();
    initRealtimeSync();
    window.setDispatchMode('DELIVERY');
}

function initRealtimeSync() {
    onSnapshot(collection(db, "licenses"), (snapshot) => {
        allLicenses = [];
        snapshot.forEach(docSnap => { allLicenses.push({ id: docSnap.id, ...docSnap.data() }); });
        
        if (currentUserRole === 'DISPATCH') {
            const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
            const localToken = sessionStorage.getItem('deliveryProSessionToken');
            if (dispatchKey && localToken) {
                const myLic = allLicenses.find(l => l.id === dispatchKey || l.key === dispatchKey);
                if (myLic && myLic.currentSessionToken && myLic.currentSessionToken !== localToken) {
                    if (!localToken.startsWith('MONITOR-')) {
                        alert("⚠️ [중복 로그인 감지]\n다른 PC 또는 브라우저에서 동일한 관제 계정으로 로그인하여 현재 연결이 종료됩니다.");
                        sessionStorage.clear(); window.location.reload();
                    }
                }
            }
        }
        window.renderSidebar();
    });

    onSnapshot(collection(db, "routes"), (snapshot) => {
        activeRoutes = {};
        snapshot.forEach(docSnap => { activeRoutes[docSnap.id] = docSnap.data(); });
        window.renderSidebar();
        if (selectedDeviceId && dispatchNavState === 'DELIVERY') window.drawDriverOnMap(selectedDeviceId);
    });

    onSnapshot(query(collection(db, "completions"), orderBy("completedAt", "asc")), (snapshot) => {
        allCompletions = [];
        snapshot.forEach(docSnap => { allCompletions.push({ id: docSnap.id, ...docSnap.data() }); });
        window.renderSidebar();
        if (selectedDeviceId && dispatchNavState === 'DELIVERY') window.drawDriverOnMap(selectedDeviceId);
    });

    onSnapshot(query(collection(db, "dispatch_messages"), orderBy("createdAt", "desc")), (snapshot) => {
        allDispatchMessages = [];
        snapshot.forEach(docSnap => { allDispatchMessages.push({ id: docSnap.id, ...docSnap.data() }); });
        window.renderMessageFeed(); window.checkDispatchInboxNotifications(); window.renderMasterNoticeHistoryList();
    });

    onSnapshot(collection(db, "dispatch_templates"), (snapshot) => {
        allDispatchTemplates = [];
        snapshot.forEach(docSnap => { allDispatchTemplates.push({ id: docSnap.id, ...docSnap.data() }); });
        window.renderCustomTemplates();
    });
}