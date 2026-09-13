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

// 엑셀 및 출력, 배차 상태 변수
let excelSortAsc = true; 
let parsedExcelList = []; 
let printReadyList = []; 
let selectedDispatchDriverId = null; 

// 모듈 스코프 충돌 방지용
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

function getLocalDateString(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const todayStr = getLocalDateString();

// === 1. 초기화 및 로그인/로그아웃 ===
window.onload = () => {
    const todayInput = document.getElementById('dispatch-date-picker');
    if (todayInput) todayInput.value = todayStr;
    
    const assignDateInput = document.getElementById('dispatch-assign-date');
    if (assignDateInput) {
        assignDateInput.value = todayStr;
        assignDateInput.onchange = () => { window.loadExcelFromFirebase(); };
    }

    const defaultExpire = new Date();
    defaultExpire.setDate(defaultExpire.getDate() + 30);
    const expEl = document.getElementById('new-key-expire');
    if (expEl) expEl.value = getLocalDateString(defaultExpire);

    window.loadSavedForms();
    initExcelDropZone(); 

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
    if(window.switchMasterTab) window.switchMasterTab('regular');
}

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
    if(typeof initKakaoMap === 'function') initKakaoMap();
    initRealtimeSync();
    if(window.setDispatchMode) window.setDispatchMode('DELIVERY');
}

function initMasterDataSync() {
    onSnapshot(collection(db, "licenses"), (snapshot) => {
        allLicenses = [];
        snapshot.forEach(docSnap => { allLicenses.push({ id: docSnap.id, ...docSnap.data() }); });
        renderMasterTables();
        if(window.populateDriverSelect) window.populateDriverSelect();
        if(window.renderAccountHistoryView) window.renderAccountHistoryView();
        
        if(document.getElementById('auto-dispatch-modal') && !document.getElementById('auto-dispatch-modal').classList.contains('hidden')) {
            window.renderDispatchDriverList();
            window.renderDispatchDriverDetail();
        }
    });

    onSnapshot(collection(db, "memos"), (snapshot) => {
        allMemos = [];
        snapshot.forEach(docSnap => { allMemos.push({ id: docSnap.id, ...docSnap.data() }); });
        if(window.renderAccountHistoryView) window.renderAccountHistoryView();
    });

    onSnapshot(collection(db, "routes"), (snapshot) => {
        activeRoutes = {};
        snapshot.forEach(docSnap => { activeRoutes[docSnap.id] = docSnap.data(); });
        if(window.renderAccountHistoryView) window.renderAccountHistoryView();
    });

    onSnapshot(query(collection(db, "completions"), orderBy("completedAt", "asc")), (snapshot) => {
        allCompletions = [];
        snapshot.forEach(docSnap => { allCompletions.push({ id: docSnap.id, ...docSnap.data() }); });
        if(window.renderAccountHistoryView) window.renderAccountHistoryView();
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
    if (tab === 'history' && window.renderAccountHistoryView) window.renderAccountHistoryView();
};

window.changeMasterTabPagination = function(tabKey, targetPage) {
    window.masterPages[tabKey] = targetPage;
    if (tabKey === 'memos' && window.renderMemosTable) window.renderMemosTable(allMemos);
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

// =====================================================================
// 🌟 [PRO 전용] 배송 자동할당 및 명세서 모달 통제 로직
// =====================================================================

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
        if (featureName === 'AUTO_DISPATCH') {
            document.getElementById('auto-dispatch-modal').classList.remove('hidden');
            window.renderDispatchDriverList();
            window.loadExcelFromFirebase();
            initExcelDropZone(); 
            
            const savedBase = localStorage.getItem('deliveryProCompanyBase');
            if (savedBase) updateCompanyBaseUI(JSON.parse(savedBase));

        } else if (featureName === 'INVOICE') {
            if (printReadyList.length === 0) {
                alert("출력 대기 중인 데이터가 없습니다.\n\n[배송 자동할당] 화면에서 엑셀을 업로드 한 후\n'명세서 출력으로 내보내기'를 실행해 주세요.");
                return;
            }
            document.getElementById('pro-invoice-modal').classList.remove('hidden');
            document.getElementById('print-ready-count').innerText = printReadyList.length;
            window.loadSavedForms(); 
            window.previewInvoiceRow(0); 
            window.syncPreviewData(); 
        }
    } else {
        document.getElementById('premium-upgrade-modal').classList.remove('hidden');
    }
};

window.closePremiumModal = function() { document.getElementById('premium-upgrade-modal').classList.add('hidden'); };
window.closeProInvoiceModal = function() { document.getElementById('pro-invoice-modal').classList.add('hidden'); };
window.closeAutoDispatchModal = function() { document.getElementById('auto-dispatch-modal').classList.add('hidden'); };

window.selectFormTemplate = function(type) {
    document.getElementById('form-template-modal').classList.add('hidden');
    const accordion = document.getElementById('form-setup-accordion');
    if (accordion && accordion.classList.contains('hidden')) {
        accordion.classList.remove('hidden');
        accordion.classList.add('flex');
    }
    setTimeout(() => {
        const titleInput = document.getElementById('input-form-title');
        if (titleInput) titleInput.focus();
    }, 300);
};

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

let previewDebounceTimer = null;
window.updateLivePreview = function() {
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(() => {
        window.syncPreviewData();
    }, 150);
};

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
                <div class="min-w-0 cursor-pointer flex-1" onclick="previewSavedForm(${idx})" title="명세서 폼 적용">
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

// =====================================================================
// 🌟 AI 배송 할당 모달 전용 로직 (강력한 기사 무조건 로드 필터)
// =====================================================================

// 🌟 [수정] 필터링 없이 연결된 기사 및 모든 등록 기사를 유연하게 불러오도록 개선
function getFilteredVisibleDrivers() {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const isMaster = (currentUserRole === 'MASTER');
    
    // dispatch 타입이 아닌 일반/체험 기사 라이선스 전체 필터링
    let visibleLicenses = allLicenses.filter(l => l.type !== 'dispatch' && !l.isDispatch);
    
    if (!isMaster && dispatchKey) {
        const cleanTargetKey = dispatchKey.toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '');
        const matched = visibleLicenses.filter(l => {
            const lKey = (l.dispatchKey || '').toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '');
            return lKey === cleanTargetKey || l.dispatchKey === dispatchKey;
        });
        // 만약 관제키 매칭된 기사가 단 한 명도 없다면, 테스트 편의를 위해 등록된 전체 기사를 반환하여 누락 방지
        if (matched.length > 0) return matched;
    }
    return visibleLicenses;
}

window.saveCompanyBaseAddress = async function() {
    const input = document.getElementById('company-base-address');
    const addr = input.value.trim();
    if (!addr) { alert("본사 거점 주소를 입력해주세요."); input.focus(); return; }
    
    const btn = document.getElementById('btn-save-company-base');
    btn.disabled = true; btn.innerText = "확인중...";

    const coords = await getCoordsFromAddress(addr);
    btn.disabled = false; btn.innerText = "저장";

    if (!coords) {
        alert("입력하신 주소의 위치(좌표)를 찾을 수 없습니다.\n정확한 도로명 또는 지번 주소를 입력해주세요.");
        return;
    }

    const baseData = { address: addr, lat: coords.lat, lng: coords.lng };
    localStorage.setItem('deliveryProCompanyBase', JSON.stringify(baseData));
    updateCompanyBaseUI(baseData);
};

window.clearCompanyBaseAddress = function() {
    localStorage.removeItem('deliveryProCompanyBase');
    document.getElementById('company-base-address').value = '';
    updateCompanyBaseUI(null);
};

function updateCompanyBaseUI(baseData) {
    const textEl = document.getElementById('saved-base-address-text');
    const clearBtn = document.getElementById('btn-clear-company-base');

    if (baseData) {
        textEl.innerText = baseData.address;
        textEl.classList.add('text-indigo-600');
        textEl.classList.remove('text-gray-500');
        clearBtn.classList.remove('hidden');
    } else {
        textEl.innerText = "저장된 거점이 없습니다.";
        textEl.classList.add('text-gray-500');
        textEl.classList.remove('text-indigo-600');
        clearBtn.classList.add('hidden');
    }
}

window.renderDispatchDriverList = function() {
    const listEl = document.getElementById('dispatch-driver-list');
    const countEl = document.getElementById('dispatch-driver-count');
    if (!listEl || !countEl) return;
    
    const drivers = getFilteredVisibleDrivers();
    countEl.innerText = `${drivers.length}명`;
    
    if (drivers.length === 0) {
        listEl.innerHTML = `<div class="text-center text-gray-400 py-10 text-[10px] font-bold">등록된 운행 기사가 없습니다.</div>`;
        return;
    }
    
    let html = '';
    drivers.forEach((d, idx) => {
        const devId = d.deviceId || d.key;
        const phoneDisplay = d.phone || d.key;
        const t1 = d.territory1 || '';
        const t2 = d.territory2 || '';
        
        let territoryBadge = '';
        if (t1) {
            territoryBadge = `<button type="button" onclick="openDriverTerritoryModal('${devId}', '${phoneDisplay}', '${t1}', '${t2}')" class="bg-indigo-100 hover:bg-indigo-200 text-indigo-800 border border-indigo-200 text-[10px] px-2 py-0.5 rounded font-black transition whitespace-nowrap overflow-hidden text-ellipsis max-w-[80px]" title="${t1} ${t2}">${t1}</button>`;
        } else {
            territoryBadge = `<button type="button" onclick="openDriverTerritoryModal('${devId}', '${phoneDisplay}', '', '')" class="bg-gray-100 hover:bg-gray-200 text-gray-600 border border-gray-200 text-[10px] px-2 py-0.5 rounded font-bold transition whitespace-nowrap">권역 미설정</button>`;
        }

        const isSelected = selectedDispatchDriverId === devId;
        
        html += `
        <div onclick="selectDispatchDriver('${devId}')" class="cursor-pointer bg-white border ${isSelected ? 'border-blue-500 ring-1 ring-blue-300 bg-blue-50/40' : 'border-gray-200 hover:border-blue-300'} p-2.5 rounded-xl flex items-center justify-between shadow-xs transition">
            <span class="font-black text-xs ${isSelected ? 'text-blue-700' : 'text-gray-800'} flex items-center gap-2 min-w-0">
                <span class="w-5 h-5 bg-slate-100 rounded-full flex items-center justify-center text-[10px] font-bold text-gray-500 shrink-0">${idx + 1}</span>
                <i class="fa-solid fa-truck ${isSelected ? 'text-blue-600' : 'text-gray-400'} shrink-0"></i> 
                <span class="truncate">${phoneDisplay}</span>
            </span>
            <div class="shrink-0 ml-2">
                ${territoryBadge}
            </div>
        </div>
        `;
    });
    listEl.innerHTML = html;
};

window.selectDispatchDriver = function(devId) {
    selectedDispatchDriverId = devId;
    window.renderDispatchDriverList(); 
    window.renderDispatchDriverDetail(); 
};

window.openDriverTerritoryModal = function(devId, phone, t1, t2) {
    event.stopPropagation(); 
    document.getElementById('territory-target-devid').value = devId;
    document.getElementById('territory-target-phone').innerText = phone;
    document.getElementById('input-territory-1').value = t1 !== 'undefined' ? t1 : '';
    document.getElementById('input-territory-2').value = t2 !== 'undefined' ? t2 : '';
    document.getElementById('driver-territory-modal').classList.remove('hidden');
};

window.closeDriverTerritoryModal = function() {
    document.getElementById('driver-territory-modal').classList.add('hidden');
};

window.saveDriverTerritory = async function() {
    const devId = document.getElementById('territory-target-devid').value;
    const t1 = document.getElementById('input-territory-1').value.trim();
    const t2 = document.getElementById('input-territory-2').value.trim();

    if (!t1) { alert("1차 핵심 권역을 입력해주세요."); return; }

    const targetLic = allLicenses.find(l => l.deviceId === devId || l.key === devId);
    if (!targetLic) return;

    try {
        await updateDoc(doc(db, "licenses", targetLic.key), {
            territory1: t1,
            territory2: t2
        });
        alert("기사 권역이 성공적으로 저장되었습니다.");
        window.closeDriverTerritoryModal();
    } catch(e) {
        alert("저장 오류: " + e.message);
    }
};

window.renderDispatchDriverDetail = function() {
    const header = document.getElementById('detail-driver-header');
    const table = document.getElementById('detail-driver-table');
    const tbody = document.getElementById('detail-driver-tbody');
    const badge = document.getElementById('detail-driver-count-badge');
    
    if (!selectedDispatchDriverId) {
        header.classList.remove('hidden');
        table.classList.add('hidden');
        badge.classList.add('hidden');
        return;
    }

    const targetLic = allLicenses.find(l => l.deviceId === selectedDispatchDriverId || l.key === selectedDispatchDriverId);
    const driverName = targetLic ? (targetLic.phone || targetLic.key) : selectedDispatchDriverId;

    const assignedItems = parsedExcelList.filter(item => item.assignedDriver === driverName);

    header.classList.add('hidden');
    table.classList.remove('hidden');
    badge.classList.remove('hidden');
    badge.innerText = `총 ${assignedItems.length}건`;

    if (assignedItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="2" class="text-center py-16 text-gray-400 font-bold text-[11px]"><i class="fa-solid fa-box-open text-3xl text-gray-300 mb-2 block"></i>배정된 배송 건이 없습니다.</td></tr>`;
        return;
    }

    let html = '';
    assignedItems.forEach((item, idx) => {
        html += `
        <tr class="hover:bg-blue-50/50 transition">
            <td class="text-center font-bold text-gray-500">${item.displayNumber || idx + 1}</td>
            <td class="font-bold text-gray-800 whitespace-normal break-keep">${item.address || '-'}</td>
        </tr>`;
    });
    tbody.innerHTML = html;
};

// ---------------------------------------------------------------------

window.loadExcelFromFirebase = async function() {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    if (!dispatchKey) return;
    
    const datePicker = document.getElementById('dispatch-assign-date');
    const dateVal = datePicker ? datePicker.value : getLocalDateString();
    const docId = `${dateVal}_${dispatchKey}`;
    
    try {
        const snap = await getDoc(doc(db, "dispatch_orders", docId));
        if (snap.exists() && snap.data().orders) {
            parsedExcelList = snap.data().orders;
        } else {
            parsedExcelList = []; 
        }
        renderExcelTable();
    } catch (error) {
        console.error("Firebase 엑셀 로드 오류:", error);
    }
};

window.autoSaveExcelToFirebase = async function() {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    if (!dispatchKey) return; 

    const datePicker = document.getElementById('dispatch-assign-date');
    const dateVal = datePicker ? datePicker.value : getLocalDateString(); 
    const docId = `${dateVal}_${dispatchKey}`; 
    
    try {
        await setDoc(doc(db, "dispatch_orders", docId), {
            date: dateVal,
            dispatchKey: dispatchKey,
            orders: parsedExcelList || [],
            updatedAt: Date.now()
        }, { merge: true });
    } catch (error) {
        console.error("Firebase 주문 리스트 자동 저장 오류:", error);
    }
};

function formatNumber(num) {
    if (!num || isNaN(num)) return num || '';
    return Number(num).toLocaleString('ko-KR');
}

function processExcelData(jsonData) {
    const newItems = [];
    jsonData.forEach((row) => {
        const mappedRow = {
            id: Date.now() + Math.random(), 
            assignedDriver: null,
            senderName: '', orderNo: '', bizNo: '', address: '', storeName: '',
            phone: '', itemName: '', unit: '', qty: '', price: '', total: '', memo: '',
            lat: null, lng: null 
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
            newItems.push(mappedRow);
        }
    });

    parsedExcelList.push(...newItems);
    return newItems;
}

function getCoordsFromAddress(address) {
    return new Promise((resolve) => {
        if (!address || !window.kakao || !window.kakao.maps || !window.kakao.maps.services) {
            resolve(null);
            return;
        }
        const geocoder = new kakao.maps.services.Geocoder();
        geocoder.addressSearch(address.trim(), (result, status) => {
            if (status === kakao.maps.services.Status.OK && result[0]) {
                resolve({ lat: parseFloat(result[0].y), lng: parseFloat(result[0].x) });
            } else {
                resolve(null);
            }
        });
    });
}

async function batchGeocodeExcelList(items) {
    const dropZone = document.getElementById('excel-drop-zone');
    const originalDropHtml = dropZone ? dropZone.innerHTML : '';

    let successCount = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (dropZone) {
            dropZone.innerHTML = `
                <div class="flex items-center gap-3 text-indigo-600 font-black text-sm">
                    <i class="fa-solid fa-circle-notch fa-spin text-xl"></i>
                    <span>배송지 좌표 분석 중... (${i + 1} / ${items.length})</span>
                </div>`;
        }

        if (item.address && (!item.lat || !item.lng)) {
            const coords = await getCoordsFromAddress(item.address);
            if (coords) {
                item.lat = coords.lat;
                item.lng = coords.lng;
                successCount++;
            }
            await new Promise(r => setTimeout(r, 50));
        }
    }

    if (dropZone) dropZone.innerHTML = originalDropHtml;
    console.log(`좌표 변환 완료: 총 ${items.length}건 중 ${successCount}건 변환 성공`);
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

window.toggleRowCheckbox = function(e, idx) {
    if (e && e.target.tagName === 'INPUT') return; 
    const cb = document.querySelector(`.row-checkbox[data-idx="${idx}"]`);
    if(cb) cb.checked = !cb.checked;
};

function renderExcelTable() {
    const tbody = document.getElementById('invoice-excel-tbody');
    if (!tbody) return;

    if (parsedExcelList.length === 0) {
        tbody.innerHTML = `<tr id="empty-excel-row"><td colspan="5" class="text-center py-20"><i class="fa-solid fa-file-excel text-3xl text-gray-300 mb-2 block"></i><span class="text-gray-400 font-bold text-[11px]">업로드된 데이터가 없습니다.</span></td></tr>`;
        const chkAll = document.getElementById('chk-excel-all');
        if (chkAll) chkAll.checked = false;
        window.renderDispatchDriverDetail();
        return;
    }

    let html = '';
    parsedExcelList.forEach((item, idx) => {
        const assignedBadge = item.assignedDriver ? 
            `<span class="bg-blue-100 text-blue-800 text-[10px] px-2 py-0.5 rounded font-black border border-blue-200">${item.assignedDriver}</span>` : 
            `<span class="bg-gray-100 text-gray-400 text-[10px] px-2 py-0.5 rounded font-bold border border-gray-200">미배정</span>`;

        const coordIcon = (item.lat && item.lng) ? 
            `<i class="fa-solid fa-map-pin text-emerald-500 mr-1" title="위치 확인됨"></i>` : 
            `<i class="fa-solid fa-triangle-exclamation text-amber-400 mr-1" title="좌표 미확인 주소"></i>`;

        html += `
        <tr class="hover:bg-blue-50/50 cursor-pointer transition" onclick="toggleRowCheckbox(event, ${idx})">
            <td class="text-center"><input type="checkbox" class="cursor-pointer row-checkbox" data-idx="${idx}"></td>
            <td class="text-center font-bold text-gray-500">${idx + 1}</td>
            <td class="text-center">${assignedBadge}</td>
            <td class="font-bold text-gray-800 truncate max-w-[300px]" title="${item.address}">${coordIcon}${item.address || '-'}</td>
            <td class="text-center" onclick="event.stopPropagation()">
                <button onclick="deleteExcelRow(${idx})" class="text-red-400 hover:text-red-600 bg-red-50 hover:bg-red-100 rounded px-2 py-1 transition shadow-sm active:scale-95" title="삭제"><i class="fa-solid fa-trash-can text-[10px]"></i></button>
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

    window.renderDispatchDriverDetail(); 
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
    if(!confirm("업로드된 모든 주문 리스트를 비우시겠습니까?(되돌릴 수 없습니다)")) return;
    parsedExcelList = [];
    renderExcelTable();
    await window.autoSaveExcelToFirebase();
};

function initExcelDropZone() {
    const dropZone = document.getElementById('excel-drop-zone');
    if (!dropZone || dropZone.dataset.bound === 'true') return;

    let fileInput = document.getElementById('global-excel-file-input');
    if (!fileInput) {
        fileInput = document.createElement('input');
        fileInput.id = 'global-excel-file-input';
        fileInput.type = 'file';
        fileInput.accept = '.xlsx, .xls, .csv';
        fileInput.multiple = true; 
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);
        fileInput.addEventListener('change', handleExcelUpload);
    }

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
    dropZone.dataset.bound = 'true';

    const btnRunAi = document.getElementById('btn-run-auto-dispatch');
    if(btnRunAi && !btnRunAi.dataset.bound) {
        btnRunAi.addEventListener('click', () => {
            alert("AI 자동 배차 알고리즘은 다음 단계(최종)에서 적용됩니다.\n현재는 엑셀 업로드 좌표 변환 및 기사 권역/본사 설정 테스트를 진행해 주세요.");
        });
        btnRunAi.dataset.bound = 'true';
    }
}

async function handleExcelUpload(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newlyAddedList = [];

    for (let i = 0; i < files.length; i++) {
        const parsed = await processSingleExcelFile(files[i]);
        newlyAddedList.push(...parsed);
    }

    if (newlyAddedList.length > 0) {
        renderExcelTable(); 
        await batchGeocodeExcelList(newlyAddedList);
        renderExcelTable(); 
        await window.autoSaveExcelToFirebase(); 
        alert(`[업로드 및 위치 분석 완료]\n${files.length}개 파일에서 ${newlyAddedList.length}건의 주문 데이터가 추가 및 분석되었습니다.`);
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
                const added = processExcelData(json);
                resolve(added);
            } catch(err) {
                console.error("파일 파싱 실패:", err);
                resolve([]); 
            }
        };
        reader.readAsArrayBuffer(file);
    });
}

window.exportToInvoiceModal = function() {
    const checkboxes = document.querySelectorAll('.row-checkbox:checked');
    if (checkboxes.length === 0) {
        alert("명세서로 출력할 주문건을 리스트 체크박스에서 1개 이상 선택해주세요.");
        return;
    }

    printReadyList = [];
    checkboxes.forEach(cb => {
        const idx = parseInt(cb.getAttribute('data-idx'));
        if (parsedExcelList[idx]) printReadyList.push(parsedExcelList[idx]);
    });

    window.closeAutoDispatchModal();
    document.getElementById('pro-invoice-modal').classList.remove('hidden');
    
    document.getElementById('print-ready-count').innerText = printReadyList.length;
    window.loadSavedForms();
    window.previewInvoiceRow(0);
    window.syncPreviewData();
};

window.previewInvoiceRow = function(idx) {
    if (!printReadyList || !printReadyList[idx]) return;
    const item = printReadyList[idx];

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

    window.syncPreviewData(); 
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
    if (printReadyList.length === 0) {
        alert("출력할 주문건이 없습니다. 배송 자동할당 창에서 내보내기를 먼저 진행해주세요.");
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
    printReadyList.forEach(item => {
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
        if (window.renderSidebar) window.renderSidebar();
        
        // 🌟 관제 메인 화면과 자동할당 모달창 양쪽 모두 기사 리스트 렌더링 강제 실행
        if (window.renderDispatchDriverList) window.renderDispatchDriverList();
        if (window.renderDispatchDriverDetail) window.renderDispatchDriverDetail();
    });

    onSnapshot(collection(db, "routes"), (snapshot) => {
        activeRoutes = {};
        snapshot.forEach(docSnap => { activeRoutes[docSnap.id] = docSnap.data(); });
        if (window.renderSidebar) window.renderSidebar();
    });

    onSnapshot(query(collection(db, "completions"), orderBy("completedAt", "asc")), (snapshot) => {
        allCompletions = [];
        snapshot.forEach(docSnap => { allCompletions.push({ id: docSnap.id, ...docSnap.data() }); });
        if (window.renderSidebar) window.renderSidebar();
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