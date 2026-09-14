// js/admin-app.js
import { db, storage, generateSecureKey } from "./admin-api.js";
import { initKakaoMap, map, focusMapPosition } from "./admin-map.js";
import { playBeepSound, getAddressFromCoords, downloadDispatchExcel as utilDownloadExcel } from "./admin-utils.js";
import { PAGE_SIZE_MASTER, renderPaginationControls } from "./admin-ui.js";
import { collection, doc, setDoc, getDoc, onSnapshot, query, orderBy, updateDoc, deleteDoc, addDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// [마스터 기능 모듈 가져오기]
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

// [관제 기능 모듈 가져오기 (추출 및 자동배차 포함)]
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
    clearSearchInput, jumpToDeliveryTarget, handleGlobalSearch, 
    openLinkDriverModal, closeLinkDriverModal, confirmLinkDriver,
    handleProFeature, closeAutoDispatchModal, closeProInvoiceModal, closePremiumModal,
    renderDispatchDriverList, selectDispatchDriver, renderDispatchDriverDetail,
    loadExcelFromFirebase, autoSaveExcelToFirebase, renderExcelTable, processExcelData,
    initExcelDropZone, handleExcelUpload, processSingleExcelFile, exportToInvoiceModal,
    toggleRowCheckbox, deleteExcelRow, deleteSelectedExcelRows, clearAllExcelRows,
    previewInvoiceRow, syncPreviewData, loadSavedForms, saveCompanyBaseAddress,
    clearCompanyBaseAddress, updateCompanyBaseUI, openDriverTerritoryModal,
    closeDriverTerritoryModal, setTerritoryScale, setTerritoryCenter, saveDriverTerritory,
    openAllTerritoriesMap, closeAllTerritoriesMap, executeBatchPrint, selectFormTemplate,
    cancelProviderFormEdit, saveProviderForm, deleteSavedForm,
    openExcelExportModal, closeExcelExportModal, executeExcelExport, runAutoDispatchAlgorithm // 👈 복구된 모듈들
} from "./admin-dispatch.js";

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

window.myMapOverlays = [];
window.forceClearMap = forceClearMap;

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

    const defaultExpire = new Date();
    defaultExpire.setDate(defaultExpire.getDate() + 30);
    const expEl = document.getElementById('new-key-expire');
    if (expEl) expEl.value = getLocalDateString(defaultExpire);

    window.loadSavedForms();

    setTimeout(() => {
        const printBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('일괄 출력'));
        if (printBtn) printBtn.onclick = window.executeBatchPrint;
        
        // 🌟 자동 할당 버튼에 실제 알고리즘 함수 바인딩
        const btnRunAi = document.getElementById('btn-run-auto-dispatch');
        if (btnRunAi) btnRunAi.onclick = window.runAutoDispatchAlgorithm;
    }, 1000);

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

window.systemLogout = function() { sessionStorage.clear(); window.location.reload(); };

function showMasterPanel(name = '마스터') {
    currentUserRole = 'MASTER';
    const badge = document.getElementById('master-name-badge');
    if (badge) badge.innerText = name;
    
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('dispatch-panel')?.classList.add('hidden');
    const mast = document.getElementById('master-panel');
    if (mast) { mast.classList.remove('hidden'); mast.classList.add('flex'); }
    
    initMasterDataSync();
    window.switchMasterTab('regular');
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
    initKakaoMap();
    initRealtimeSync();
    window.setDispatchMode('DELIVERY');
}

function initMasterDataSync() {
    onSnapshot(collection(db, "licenses"), (snapshot) => {
        allLicenses = [];
        snapshot.forEach(docSnap => { allLicenses.push({ id: docSnap.id, ...docSnap.data() }); });
        window.renderMasterTables();
        window.populateDriverSelect();
        window.renderAccountHistoryView();
        const curKey = document.getElementById('edit-orig-key')?.value;
        if (curKey) {
            const target = allLicenses.find(l => l.key === curKey);
            if (target && target.type === 'dispatch') window.renderModalConnectedDrivers(target.key);
        }
    });

    onSnapshot(collection(db, "memos"), (snapshot) => {
        allMemos = [];
        snapshot.forEach(docSnap => { allMemos.push({ id: docSnap.id, ...docSnap.data() }); });
        const countMemosEl = document.getElementById('count-memos');
        if (countMemosEl) countMemosEl.innerText = allMemos.length;
        window.renderMemosTable(allMemos);
        window.renderAccountHistoryView();
    });

    onSnapshot(collection(db, "routes"), (snapshot) => {
        activeRoutes = {};
        snapshot.forEach(docSnap => { activeRoutes[docSnap.id] = docSnap.data(); });
        window.renderSidebar();
        if (selectedDeviceId && dispatchNavState === 'DELIVERY') window.drawDriverOnMap(selectedDeviceId);
        window.populateDriverSelect();
        window.renderAccountHistoryView();
    });

    onSnapshot(query(collection(db, "completions"), orderBy("completedAt", "asc")), (snapshot) => {
        allCompletions = [];
        snapshot.forEach(docSnap => { allCompletions.push({ id: docSnap.id, ...docSnap.data() }); });
        window.renderSidebar();
        if (selectedDeviceId && dispatchNavState === 'DELIVERY') window.drawDriverOnMap(selectedDeviceId);
        window.renderAccountHistoryView();
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

// ==========================================
// 함수 바인딩 (window 객체 연결)
// ==========================================
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
window.renderMemosTable = renderMemosTable;
window.deleteParkingMemo = deleteParkingMemo;
window.setHistorySort = setHistorySort;
window.setHistoryAccountTypeFilter = setHistoryAccountTypeFilter;
window.populateDriverSelect = populateDriverSelect;
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
window.renderMasterTables = renderMasterTables;
window.renderAccountHistoryView = renderAccountHistoryView;

window.setDispatchMode = setDispatchMode;
window.renderSidebar = renderSidebar;
window.getFilteredVisibleDrivers = getFilteredVisibleDrivers;
window.renderDriverListView = renderDriverListView;
window.setDispatchDetailTab = setDispatchDetailTab;
window.renderDriverDetailView = renderDriverDetailView;
window.selectDriver = selectDriver;
window.clearSelectedDriver = clearSelectedDriver;
window.removeOrUnlinkDriver = removeOrUnlinkDriver;
window.renderMessageSidebar = renderMessageSidebar;
window.toggleMessageDriver = toggleMessageDriver;
window.toggleAllMessageSelection = toggleAllMessageSelection;
window.updateMessageCharCount = updateMessageCharCount;
window.sendDispatchMessage = sendDispatchMessage;
window.deleteDispatchMessage = deleteDispatchMessage;
window.renderMessageFeed = renderMessageFeed;
window.saveCustomTemplate = saveCustomTemplate;
window.insertCustomTemplate = insertCustomTemplate;
window.deleteCustomTemplate = deleteCustomTemplate;
window.renderCustomTemplates = renderCustomTemplates;
window.showDispatchPopupAlert = showDispatchPopupAlert;
window.closeDispatchPopupAlertModal = closeDispatchPopupAlertModal;
window.checkDispatchInboxNotifications = checkDispatchInboxNotifications;
window.openDispatchInboxModal = openDispatchInboxModal;
window.closeDispatchInboxModal = closeDispatchInboxModal;
window.deleteNoticeFromDispatchInbox = deleteNoticeFromDispatchInbox;
window.clearAllDispatchInbox = clearAllDispatchInbox;
window.renderLocationSidebar = renderLocationSidebar;
window.jumpToDriverDelivery = jumpToDriverDelivery;
window.focusDriverLocationOnMap = focusDriverLocationOnMap;
window.showFallbackLocation = showFallbackLocation;
window.closeCurrentLocationOverlay = closeCurrentLocationOverlay;
window.drawAllDriversOnMap = drawAllDriversOnMap;
window.fitMapToAllDrivers = fitMapToAllDrivers;
window.drawDriverOnMap = drawDriverOnMap;
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
window.closeAutoDispatchModal = closeAutoDispatchModal;
window.closeProInvoiceModal = closeProInvoiceModal;
window.closePremiumModal = closePremiumModal;
window.renderDispatchDriverList = renderDispatchDriverList;
window.selectDispatchDriver = selectDispatchDriver;
window.renderDispatchDriverDetail = renderDispatchDriverDetail;
window.loadExcelFromFirebase = loadExcelFromFirebase;
window.autoSaveExcelToFirebase = autoSaveExcelToFirebase;
window.renderExcelTable = renderExcelTable;
window.processExcelData = processExcelData;
window.initExcelDropZone = initExcelDropZone;
window.handleExcelUpload = handleExcelUpload;
window.processSingleExcelFile = processSingleExcelFile;
window.exportToInvoiceModal = exportToInvoiceModal;
window.toggleRowCheckbox = toggleRowCheckbox;
window.deleteExcelRow = deleteExcelRow;
window.deleteSelectedExcelRows = deleteSelectedExcelRows;
window.clearAllExcelRows = clearAllExcelRows;
window.previewInvoiceRow = previewInvoiceRow;
window.syncPreviewData = syncPreviewData;
window.loadSavedForms = loadSavedForms;
window.saveCompanyBaseAddress = saveCompanyBaseAddress;
window.clearCompanyBaseAddress = clearCompanyBaseAddress;
window.updateCompanyBaseUI = updateCompanyBaseUI;
window.openDriverTerritoryModal = openDriverTerritoryModal;
window.closeDriverTerritoryModal = closeDriverTerritoryModal;
window.setTerritoryScale = setTerritoryScale;
window.setTerritoryCenter = setTerritoryCenter;
window.saveDriverTerritory = saveDriverTerritory;
window.openAllTerritoriesMap = openAllTerritoriesMap;
window.closeAllTerritoriesMap = closeAllTerritoriesMap;
window.executeBatchPrint = executeBatchPrint;
window.selectFormTemplate = selectFormTemplate;
window.cancelProviderFormEdit = cancelProviderFormEdit;
window.saveProviderForm = saveProviderForm;
window.deleteSavedForm = deleteSavedForm;
window.openExcelExportModal = openExcelExportModal;
window.closeExcelExportModal = closeExcelExportModal;
window.executeExcelExport = executeExcelExport;
window.runAutoDispatchAlgorithm = runAutoDispatchAlgorithm;