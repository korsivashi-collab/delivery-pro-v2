// js/admin-app.js

// ==========================================
// 1. 모듈 가져오기 (Imports)
// ==========================================
import { db } from "./admin-api.js";
import { doc, getDoc, onSnapshot, collection, query, orderBy, updateDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { initKakaoMap, focusMapPosition } from "./admin-map.js";
import { state, todayStr, getLocalDateString } from "./admin-state.js";

// [마스터 기능 모듈]
import {
    switchMasterTab, changeMasterTabPagination, renderMasterTables,
    generateNewLicense, openEditLicenseModal, closeEditModal,
    renderModalConnectedDrivers, linkDriverFromModal, unlinkDriverFromModal,
    saveLicenseEdit, deleteLicense, deleteLicenseFromModal,
    renderMemosTable, deleteParkingMemo, setHistorySort,
    setHistoryAccountTypeFilter, populateDriverSelect, filterDriverDropdown,
    onDriverSelectChange, selectAccountDirectly, backToAllAccountsView,
    changeHistoryPage, toggleHistoryNoticeMode, toggleHistoryItemSelection,
    toggleHistorySelectAll, sendHistoryNoticeToSelected, setHistoryMasterSubTab,
    deleteAccountFromHistory, renderAccountHistoryView, openMasterNoticeHistoryModal,
    closeMasterNoticeHistoryModal, renderMasterNoticeHistoryList
} from "./admin-master.js";

// [관제 기능 모듈]
import {
    forceClearMap, setDispatchMode, renderSidebar, getFilteredVisibleDrivers,
    renderDriverListView, setDispatchDetailTab, renderDriverDetailView,
    selectDriver, clearSelectedDriver, removeOrUnlinkDriver, renderMessageSidebar,
    toggleMessageDriver, toggleAllMessageSelection, updateMessageCharCount,
    sendDispatchMessage, deleteDispatchMessage, renderMessageFeed, saveCustomTemplate,
    insertCustomTemplate, deleteCustomTemplate, renderCustomTemplates,
    showDispatchPopupAlert, closeDispatchPopupAlertModal, checkDispatchInboxNotifications,
    openDispatchInboxModal, closeDispatchInboxModal, deleteNoticeFromDispatchInbox,
    clearAllDispatchInbox, renderLocationSidebar, jumpToDriverDelivery,
    focusDriverLocationOnMap, showFallbackLocation, closeCurrentLocationOverlay,
    drawAllDriversOnMap, fitMapToAllDrivers, drawDriverOnMap, setMapPolylineMode,
    changeDispatchDate, onDispatchDateChange, resetDispatchDateToToday,
    clearSearchInput, jumpToDeliveryTarget, handleGlobalSearch, openLinkDriverModal,
    handleProFeature,
    selectFormTemplate, syncPreviewData, 
    updateLivePreview, loadSavedForms, toggleSelectForm, previewSavedForm, 
    saveProviderForm,  deleteSavedForm, 
    drawOtherDriversTerritories, openDriverTerritoryModal, 
    setTerritoryScale, setTerritoryCenter, saveDriverTerritory, 
    openAllTerritoriesMap, saveCompanyBaseAddress, 
    updateCompanyBaseUI, renderDispatchDriverList, 
    selectDispatchDriver, renderDispatchDriverDetail, loadExcelFromFirebase, 
    formatNumber, processExcelData, getCoordsFromAddress, 
    sortExcelList, toggleRowCheckbox, renderExcelTable, 
    deleteSelectedExcelRows, initExcelDropZone, 
    handleExcelUpload, processSingleExcelFile, exportToInvoiceModal, previewInvoiceRow, 
    generateInvoiceHTML, executeBatchPrint
} from "./admin-dispatch.js";

// ==========================================
// 2. 초기화 및 인증 관리 (App Lifecycle)
// ==========================================
window.onload = () => {
    const todayInput = document.getElementById('dispatch-date-picker');
    if (todayInput) todayInput.value = todayStr;
    
    const assignDateInput = document.getElementById('dispatch-assign-date');
    if (assignDateInput) {
        assignDateInput.value = todayStr;
        assignDateInput.onchange = () => { loadExcelFromFirebase(); };
    }

    const defaultExpire = new Date();
    defaultExpire.setDate(defaultExpire.getDate() + 30);
    const expEl = document.getElementById('new-key-expire');
    if (expEl) expEl.value = getLocalDateString(defaultExpire);

    if (typeof loadSavedForms === 'function') loadSavedForms();
    if (typeof initExcelDropZone === 'function') initExcelDropZone(); 

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

window.showMasterPanel = function(name = '마스터') {
    state.currentUserRole = 'MASTER';
    const badge = document.getElementById('master-name-badge');
    if (badge) badge.innerText = name;
    
    document.getElementById('login-screen').classList.add('hidden');
    const disp = document.getElementById('dispatch-panel');
    if (disp) { disp.classList.add('hidden'); disp.classList.remove('flex'); }
    const mast = document.getElementById('master-panel');
    if (mast) { mast.classList.remove('hidden'); mast.classList.add('flex'); }
    
    window.initMasterDataSync();
    switchMasterTab('regular');
};

window.showDispatchPanel = function() {
    state.currentUserRole = 'DISPATCH';
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
    window.initMasterDataSync();
    setDispatchMode('DELIVERY');
};

// ==========================================
// 3. 실시간 데이터 동기화 (Firestore Listeners)
// ==========================================
window.initMasterDataSync = function() {
    onSnapshot(collection(db, "licenses"), (snapshot) => {
        state.allLicenses = [];
        snapshot.forEach(docSnap => { state.allLicenses.push({ id: docSnap.id, ...docSnap.data() }); });
        
        renderMasterTables();
        populateDriverSelect();
        renderAccountHistoryView();
        renderSidebar();
        
        const curKey = document.getElementById('edit-orig-key')?.value;
        if (curKey) {
            const target = state.allLicenses.find(l => l.key === curKey);
            if (target && target.type === 'dispatch') renderModalConnectedDrivers(target.key);
        }

        if(document.getElementById('auto-dispatch-modal') && !document.getElementById('auto-dispatch-modal').classList.contains('hidden')) {
            renderDispatchDriverList();
            renderDispatchDriverDetail();
        }
    });

    onSnapshot(collection(db, "memos"), (snapshot) => {
        state.allMemos = [];
        snapshot.forEach(docSnap => { state.allMemos.push({ id: docSnap.id, ...docSnap.data() }); });
        const countMemosEl = document.getElementById('count-memos');
        if (countMemosEl) countMemosEl.innerText = state.allMemos.length;
        renderMemosTable(state.allMemos);
        renderAccountHistoryView();
    });

    onSnapshot(collection(db, "routes"), (snapshot) => {
        state.activeRoutes = {};
        snapshot.forEach(docSnap => { state.activeRoutes[docSnap.id] = docSnap.data(); });
        renderSidebar();
        if (state.selectedDeviceId && state.dispatchNavState === 'DELIVERY') drawDriverOnMap(state.selectedDeviceId);
        populateDriverSelect();
        renderAccountHistoryView();
    });

    onSnapshot(query(collection(db, "completions"), orderBy("completedAt", "asc")), (snapshot) => {
        state.allCompletions = [];
        snapshot.forEach(docSnap => { state.allCompletions.push({ id: docSnap.id, ...docSnap.data() }); });
        renderSidebar();
        if (state.selectedDeviceId && state.dispatchNavState === 'DELIVERY') drawDriverOnMap(state.selectedDeviceId);
        renderAccountHistoryView();
    });

    onSnapshot(query(collection(db, "dispatch_messages"), orderBy("createdAt", "desc")), (snapshot) => {
        state.allDispatchMessages = [];
        snapshot.forEach(docSnap => { state.allDispatchMessages.push({ id: docSnap.id, ...docSnap.data() }); });
        renderMessageFeed();
        checkDispatchInboxNotifications();
        renderMasterNoticeHistoryList();
    });

    onSnapshot(collection(db, "dispatch_templates"), (snapshot) => {
        state.allDispatchTemplates = [];
        snapshot.forEach(docSnap => { state.allDispatchTemplates.push({ id: docSnap.id, ...docSnap.data() }); });
        renderCustomTemplates();
    });
};

// ==========================================
// 4. HTML 인라인 이벤트 바인딩 (window 객체 연결)
// ==========================================
// 마스터 대시보드 관련
window.switchMasterTab = switchMasterTab;
window.changeMasterTabPagination = changeMasterTabPagination;
window.generateNewLicense = generateNewLicense;
window.openEditLicenseModal = openEditLicenseModal;
window.closeEditModal = closeEditModal;
window.linkDriverFromModal = linkDriverFromModal;
window.unlinkDriverFromModal = unlinkDriverFromModal;
window.saveLicenseEdit = saveLicenseEdit;
window.deleteLicense = deleteLicense;
window.deleteLicenseFromModal = deleteLicenseFromModal;
window.deleteParkingMemo = deleteParkingMemo;
window.setHistorySort = setHistorySort;
window.setHistoryAccountTypeFilter = setHistoryAccountTypeFilter;
window.filterDriverDropdown = filterDriverDropdown;
window.onDriverSelectChange = onDriverSelectChange;
window.selectAccountDirectly = selectAccountDirectly;
window.backToAllAccountsView = backToAllAccountsView;
window.changeHistoryPage = changeHistoryPage;
window.toggleHistoryNoticeMode = toggleHistoryNoticeMode;
window.toggleHistoryItemSelection = toggleHistoryItemSelection;
window.toggleHistorySelectAll = toggleHistorySelectAll;
window.sendHistoryNoticeToSelected = sendHistoryNoticeToSelected;
window.setHistoryMasterSubTab = setHistoryMasterSubTab;
window.deleteAccountFromHistory = deleteAccountFromHistory;
window.openMasterNoticeHistoryModal = openMasterNoticeHistoryModal;
window.closeMasterNoticeHistoryModal = closeMasterNoticeHistoryModal;

// 관제(Dispatch) 및 PRO 기능 관련
window.setDispatchMode = setDispatchMode;
window.setDispatchDetailTab = setDispatchDetailTab;
window.selectDriver = selectDriver;
window.clearSelectedDriver = clearSelectedDriver;
window.removeOrUnlinkDriver = removeOrUnlinkDriver;
window.toggleMessageDriver = toggleMessageDriver;
window.toggleAllMessageSelection = toggleAllMessageSelection;
window.sendDispatchMessage = sendDispatchMessage;
window.deleteDispatchMessage = deleteDispatchMessage;
window.saveCustomTemplate = saveCustomTemplate;
window.insertCustomTemplate = insertCustomTemplate;
window.deleteCustomTemplate = deleteCustomTemplate;
window.closeDispatchPopupAlertModal = closeDispatchPopupAlertModal;
window.openDispatchInboxModal = openDispatchInboxModal;
window.closeDispatchInboxModal = closeDispatchInboxModal;
window.deleteNoticeFromDispatchInbox = deleteNoticeFromDispatchInbox;
window.clearAllDispatchInbox = clearAllDispatchInbox;
window.jumpToDriverDelivery = jumpToDriverDelivery;
window.focusDriverLocationOnMap = focusDriverLocationOnMap;
window.closeCurrentLocationOverlay = closeCurrentLocationOverlay;
window.fitMapToAllDrivers = fitMapToAllDrivers;
window.setMapPolylineMode = setMapPolylineMode;
window.changeDispatchDate = changeDispatchDate;
window.onDispatchDateChange = onDispatchDateChange;
window.resetDispatchDateToToday = resetDispatchDateToToday;
window.clearSearchInput = clearSearchInput;
window.jumpToDeliveryTarget = jumpToDeliveryTarget;
window.handleGlobalSearch = handleGlobalSearch;
window.openLinkDriverModal = openLinkDriverModal;
window.closeLinkDriverModal = closeLinkDriverModal;
window.confirmLinkDriver = confirmLinkDriver;
window.handleProFeature = handleProFeature;
window.closePremiumModal = closePremiumModal;
window.closeProInvoiceModal = closeProInvoiceModal;
window.closeAutoDispatchModal = closeAutoDispatchModal;
window.selectFormTemplate = selectFormTemplate;
window.updateLivePreview = updateLivePreview;
window.cancelProviderFormEdit = cancelProviderFormEdit;
window.saveProviderForm = saveProviderForm;
window.toggleSelectForm = toggleSelectForm;
window.previewSavedForm = previewSavedForm;
window.deleteSavedForm = deleteSavedForm;
window.openDriverTerritoryModal = openDriverTerritoryModal;
window.closeDriverTerritoryModal = closeDriverTerritoryModal;
window.setTerritoryScale = setTerritoryScale;
window.saveDriverTerritory = saveDriverTerritory;
window.openAllTerritoriesMap = openAllTerritoriesMap;
window.closeAllTerritoriesMap = closeAllTerritoriesMap;
window.saveCompanyBaseAddress = saveCompanyBaseAddress;
window.clearCompanyBaseAddress = clearCompanyBaseAddress;
window.selectDispatchDriver = selectDispatchDriver;
window.deleteExcelRow = deleteExcelRow;
window.deleteSelectedExcelRows = deleteSelectedExcelRows;
window.clearAllExcelRows = clearAllExcelRows;
window.exportToInvoiceModal = exportToInvoiceModal;
window.toggleRowCheckbox = toggleRowCheckbox;
window.executeBatchPrint = executeBatchPrint;
window.focusMapPosition = focusMapPosition; // Map 유틸리티