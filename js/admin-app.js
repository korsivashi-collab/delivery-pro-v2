// js/admin-app.js

import { db } from "./admin-api.js";
import { doc, getDoc, onSnapshot, collection, query, orderBy, updateDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { initKakaoMap, focusMapPosition } from "./admin-map.js";
import { state, todayStr, getLocalDateString } from "./admin-state.js";

// ==========================================
// [마스터 기능 모듈 3개 가져오기]
// ==========================================
import {
    switchMasterTab, changeMasterTabPagination, renderMasterTables,
    generateNewLicense, openEditLicenseModal, closeEditModal,
    renderModalConnectedDrivers, linkDriverFromModal, unlinkDriverFromModal,
    saveLicenseEdit, deleteLicense, deleteLicenseFromModal
} from "./admin-master-licenses.js";

import {
    renderMemosTable, deleteParkingMemo, sortMemos
} from "./admin-master-memos.js";

import {
    setHistorySort, setHistoryAccountTypeFilter, populateDriverSelect,
    filterDriverDropdown, onDriverSelectChange, selectAccountDirectly,
    backToAllAccountsView, changeHistoryPage, toggleHistoryNoticeMode,
    toggleHistoryItemSelection, toggleHistorySelectAll, sendHistoryNoticeToSelected,
    setHistoryMasterSubTab, deleteAccountFromHistory, renderAccountHistoryView,
    openMasterNoticeHistoryModal, closeMasterNoticeHistoryModal, renderMasterNoticeHistoryList,
    // 🌟 사진 데이터 관리 모듈 함수 추가
    openPhotoGalleryModal, closePhotoGalleryModal, filterPhotoGallery,
    clearPhotoDateFilter, togglePhotoSort, renderPhotoGalleryGrid,
    previewPhotoModal, closePhotoPreviewModal, deletePhotoItem
} from "./admin-master-history.js";

// ==========================================
// [관제/PRO 기능 모듈 가져오기]
// ==========================================
import {
    formatNumber, forceClearMap, getFilteredVisibleDrivers, setDispatchMode, renderSidebar,
    renderDriverListView, setDispatchDetailTab, renderDriverDetailView, selectDriver,
    clearSelectedDriver, removeOrUnlinkDriver, drawDriverOnMap, setMapPolylineMode,
    changeDispatchDate, onDispatchDateChange, resetDispatchDateToToday,
    clearSearchInput, jumpToDeliveryTarget, handleGlobalSearch,
    handleProFeature, closeAutoDispatchModal, closeProInvoiceModal, closePremiumModal,
    openLinkDriverModal, closeLinkDriverModal, confirmLinkDriver,
    renderDispatchDriverList, selectDispatchDriver, renderDispatchDriverDetail,
    runAutoDispatchAlgorithm, toggleDispatchDriver, adjustDriverWeight,
    saveCompanyBaseAddress, clearCompanyBaseAddress, updateCompanyBaseUI
} from "./admin-dispatch-core.js";

import {
    renderMessageSidebar, toggleMessageDriver, toggleAllMessageSelection,
    updateMessageCharCount, sendDispatchMessage, deleteDispatchMessage,
    renderMessageFeed, saveCustomTemplate, insertCustomTemplate, deleteCustomTemplate,
    renderCustomTemplates, showDispatchPopupAlert, closeDispatchPopupAlertModal,
    checkDispatchInboxNotifications, openDispatchInboxModal, closeDispatchInboxModal,
    deleteNoticeFromDispatchInbox, clearAllDispatchInbox
} from "./admin-dispatch-msg.js";

import {
    loadExcelFromFirebase, autoSaveExcelToFirebase, renderExcelTable, processExcelData,
    initExcelDropZone, handleExcelUpload, processSingleExcelFile,
    toggleRowCheckbox, deleteExcelRow, deleteSelectedExcelRows, clearAllExcelRows
} from "./admin-dispatch-excel.js";

import {
    exportToInvoiceModal, previewInvoiceRow, syncPreviewData, loadSavedForms,
    executeBatchPrint, selectFormTemplate, cancelProviderFormEdit, saveProviderForm,
    deleteSavedForm, updateLivePreview, previewSavedForm, toggleSelectForm, applySavedForm,
    switchInvoiceTab
} from "./admin-dispatch-print.js";

import {
    renderLocationSidebar, jumpToDriverDelivery, focusDriverLocationOnMap,
    showFallbackLocation, closeCurrentLocationOverlay, drawAllDriversOnMap,
    fitMapToAllDrivers, openDriverTerritoryModal, closeDriverTerritoryModal,
    setTerritoryScale, setTerritoryCenter, saveDriverTerritory,
    openAllTerritoriesMap, closeAllTerritoriesMap,
    toggleTerritoryPinMode, searchTerritoryAddress, adjustModalTerritorySize
} from "./admin-dispatch-territory.js";

import {
    openExcelExportModal, closeExcelExportModal, executeExcelExport
} from "./admin-dispatch-export.js";


// ==========================================
// 1. 초기화 및 인증 관리 (App Lifecycle)
// ==========================================
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
    
    const loginScreen = document.getElementById('login-screen');
    if (loginScreen) loginScreen.classList.add('hidden');
    
    const disp = document.getElementById('dispatch-panel');
    if (disp) { disp.classList.add('hidden'); disp.classList.remove('flex'); }
    
    const mast = document.getElementById('master-panel');
    if (mast) { mast.classList.remove('hidden'); mast.classList.add('flex'); }
    
    window.initMasterDataSync();
    if (typeof switchMasterTab === 'function') switchMasterTab('regular');
};

window.showDispatchPanel = function() {
    state.currentUserRole = 'DISPATCH';
    
    const loginScreen = document.getElementById('login-screen');
    if (loginScreen) loginScreen.classList.add('hidden');
    
    const dispatchPanel = document.getElementById('dispatch-panel');
    if (dispatchPanel) {
        dispatchPanel.classList.remove('hidden');
        dispatchPanel.classList.add('flex');
    }

    const currentKey = sessionStorage.getItem('deliveryProDispatchKey');
    const localToken = sessionStorage.getItem('deliveryProSessionToken');
    const subtitle = document.getElementById('dispatch-sub-title');
    
    if (currentKey && subtitle) {
        if (localToken && localToken.startsWith('MONITOR-')) {
            subtitle.innerHTML = `<span class="bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-black flex items-center gap-1"><i class="fa-solid fa-eye animate-pulse"></i> 마스터 모니터링: [${currentKey}]</span>`;
        } else {
            subtitle.innerText = `관제 센터 [${currentKey}]`;
        }
    }
    
    if(typeof initKakaoMap === 'function') initKakaoMap();
    window.initMasterDataSync();
    if(typeof setDispatchMode === 'function') setDispatchMode('DELIVERY');
};

// ==========================================
// 2. 실시간 데이터 동기화 (Firestore Snapshots)
// ==========================================
window.initMasterDataSync = function() {
    onSnapshot(collection(db, "licenses"), (snapshot) => {
        state.allLicenses = [];
        snapshot.forEach(docSnap => { state.allLicenses.push({ id: docSnap.id, ...docSnap.data() }); });
        
        const currentRole = sessionStorage.getItem('deliveryProRole');
        const currentKey = sessionStorage.getItem('deliveryProDispatchKey');
        
        if (currentRole === 'DISPATCH' && currentKey) {
            const myAccount = state.allLicenses.find(l => l.key === currentKey || l.id === currentKey);
            if (!myAccount) {
                alert("⚠️ 관리자에 의해 관제 계정이 삭제되었습니다.\n시스템 보안을 위해 즉시 로그아웃됩니다.");
                window.systemLogout();
                return; 
            }
            if (myAccount.status === 'suspended') {
                alert("⚠️ 관리자에 의해 관제 계정 사용이 정지되었습니다.\n시스템 보안을 위해 즉시 로그아웃됩니다.");
                window.systemLogout();
                return;
            }
        }

        if (typeof renderMasterTables === 'function') renderMasterTables();
        if (typeof populateDriverSelect === 'function') populateDriverSelect();
        if (typeof renderAccountHistoryView === 'function') renderAccountHistoryView();
        if (typeof renderSidebar === 'function') renderSidebar();
        
        const curKey = document.getElementById('edit-orig-key')?.value;
        if (curKey) {
            const target = state.allLicenses.find(l => l.key === curKey);
            if (target && target.type === 'dispatch' && typeof renderModalConnectedDrivers === 'function') {
                renderModalConnectedDrivers(target.key);
            }
        }
        if(document.getElementById('auto-dispatch-modal') && !document.getElementById('auto-dispatch-modal').classList.contains('hidden')) {
            if (typeof renderDispatchDriverList === 'function') renderDispatchDriverList();
            if (typeof renderDispatchDriverDetail === 'function') renderDispatchDriverDetail();
        }
    });

    onSnapshot(collection(db, "memos"), (snapshot) => {
        state.allMemos = [];
        snapshot.forEach(docSnap => { state.allMemos.push({ id: docSnap.id, ...docSnap.data() }); });
        const countMemosEl = document.getElementById('count-memos');
        if (countMemosEl) countMemosEl.innerText = state.allMemos.length;
        if (typeof renderMemosTable === 'function') renderMemosTable(state.allMemos);
        if (typeof renderAccountHistoryView === 'function') renderAccountHistoryView();
    });

    onSnapshot(collection(db, "routes"), (snapshot) => {
        state.activeRoutes = {};
        snapshot.forEach(docSnap => { state.activeRoutes[docSnap.id] = docSnap.data(); });
        if (typeof renderSidebar === 'function') renderSidebar();
        if (state.selectedDeviceId && state.dispatchNavState === 'DELIVERY' && typeof drawDriverOnMap === 'function') {
            drawDriverOnMap(state.selectedDeviceId);
        }
        if (typeof populateDriverSelect === 'function') populateDriverSelect();
        if (typeof renderAccountHistoryView === 'function') renderAccountHistoryView();
    });

    onSnapshot(query(collection(db, "completions"), orderBy("completedAt", "asc")), (snapshot) => {
        state.allCompletions = [];
        snapshot.forEach(docSnap => { state.allCompletions.push({ id: docSnap.id, ...docSnap.data() }); });
        if (typeof renderSidebar === 'function') renderSidebar();
        if (state.selectedDeviceId && state.dispatchNavState === 'DELIVERY' && typeof drawDriverOnMap === 'function') {
            drawDriverOnMap(state.selectedDeviceId);
        }
        if (typeof renderAccountHistoryView === 'function') renderAccountHistoryView();

        // 🌟 사진 갤러리 모달이 열려 있을 때 실시간 화면 갱신
        const photoModal = document.getElementById('photo-gallery-modal');
        if (photoModal && !photoModal.classList.contains('hidden') && typeof renderPhotoGalleryGrid === 'function') {
            renderPhotoGalleryGrid();
        }
    });

    onSnapshot(query(collection(db, "dispatch_messages"), orderBy("createdAt", "desc")), (snapshot) => {
        state.allDispatchMessages = [];
        snapshot.forEach(docSnap => { state.allDispatchMessages.push({ id: docSnap.id, ...docSnap.data() }); });
        if (typeof renderMessageFeed === 'function') renderMessageFeed(); 
        if (typeof checkDispatchInboxNotifications === 'function') checkDispatchInboxNotifications(); 
        if (typeof renderMasterNoticeHistoryList === 'function') renderMasterNoticeHistoryList();
    });

    onSnapshot(collection(db, "dispatch_templates"), (snapshot) => {
        state.allDispatchTemplates = [];
        snapshot.forEach(docSnap => { state.allDispatchTemplates.push({ id: docSnap.id, ...docSnap.data() }); });
        if (typeof renderCustomTemplates === 'function') renderCustomTemplates();
    });
};

// ==========================================
// 3. HTML 인라인 이벤트를 위한 window 전역 객체 맵핑
// ==========================================
window.formatNumber = formatNumber;

// [마스터 - Licenses]
window.switchMasterTab = switchMasterTab;
window.changeMasterTabPagination = changeMasterTabPagination;
window.renderMasterTables = renderMasterTables;
window.generateNewLicense = generateNewLicense;
window.openEditLicenseModal = openEditLicenseModal;
window.closeEditModal = closeEditModal;
window.renderModalConnectedDrivers = renderModalConnectedDrivers;
window.linkDriverFromModal = linkDriverFromModal;
window.unlinkDriverFromModal = unlinkDriverFromModal;
window.saveLicenseEdit = saveLicenseEdit;
window.deleteLicense = deleteLicense;
window.deleteLicenseFromModal = deleteLicenseFromModal;

// [마스터 - Memos]
window.renderMemosTable = renderMemosTable;
window.deleteParkingMemo = deleteParkingMemo;
window.sortMemos = sortMemos;

// [마스터 - History]
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
window.renderAccountHistoryView = renderAccountHistoryView;
window.openMasterNoticeHistoryModal = openMasterNoticeHistoryModal;
window.closeMasterNoticeHistoryModal = closeMasterNoticeHistoryModal;
window.renderMasterNoticeHistoryList = renderMasterNoticeHistoryList;

// 🌟 [마스터 - 사진 데이터 관리 모듈]
window.openPhotoGalleryModal = openPhotoGalleryModal;
window.closePhotoGalleryModal = closePhotoGalleryModal;
window.filterPhotoGallery = filterPhotoGallery;
window.clearPhotoDateFilter = clearPhotoDateFilter;
window.togglePhotoSort = togglePhotoSort;
window.renderPhotoGalleryGrid = renderPhotoGalleryGrid;
window.previewPhotoModal = previewPhotoModal;
window.closePhotoPreviewModal = closePhotoPreviewModal;
window.deletePhotoItem = deletePhotoItem;

// [관제 코어]
window.setDispatchMode = setDispatchMode;
window.renderSidebar = renderSidebar;
window.getFilteredVisibleDrivers = getFilteredVisibleDrivers;
window.renderDriverListView = renderDriverListView;
window.setDispatchDetailTab = setDispatchDetailTab;
window.renderDriverDetailView = renderDriverDetailView;
window.selectDriver = selectDriver;
window.clearSelectedDriver = clearSelectedDriver;
window.removeOrUnlinkDriver = removeOrUnlinkDriver;
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
window.runAutoDispatchAlgorithm = runAutoDispatchAlgorithm;
window.focusMapPosition = focusMapPosition;
window.toggleDispatchDriver = toggleDispatchDriver;
window.adjustDriverWeight = adjustDriverWeight;
window.saveCompanyBaseAddress = saveCompanyBaseAddress;
window.clearCompanyBaseAddress = clearCompanyBaseAddress;
window.updateCompanyBaseUI = updateCompanyBaseUI;

// [관제 메시지]
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

// [관제 권역/지도(Territory)]
window.renderLocationSidebar = renderLocationSidebar;
window.jumpToDriverDelivery = jumpToDriverDelivery;
window.focusDriverLocationOnMap = focusDriverLocationOnMap;
window.showFallbackLocation = showFallbackLocation;
window.closeCurrentLocationOverlay = closeCurrentLocationOverlay;
window.drawAllDriversOnMap = drawAllDriversOnMap;
window.fitMapToAllDrivers = fitMapToAllDrivers;
window.openDriverTerritoryModal = openDriverTerritoryModal;
window.closeDriverTerritoryModal = closeDriverTerritoryModal;
window.setTerritoryScale = setTerritoryScale;
window.setTerritoryCenter = setTerritoryCenter;
window.saveDriverTerritory = saveDriverTerritory;
window.openAllTerritoriesMap = openAllTerritoriesMap;
window.closeAllTerritoriesMap = closeAllTerritoriesMap;
window.toggleTerritoryPinMode = toggleTerritoryPinMode;
window.searchTerritoryAddress = searchTerritoryAddress;
window.adjustModalTerritorySize = adjustModalTerritorySize;

// [관제 엑셀(Excel)]
window.loadExcelFromFirebase = loadExcelFromFirebase;
window.autoSaveExcelToFirebase = autoSaveExcelToFirebase;
window.renderExcelTable = renderExcelTable;
window.processExcelData = processExcelData;
window.initExcelDropZone = initExcelDropZone;
window.handleExcelUpload = handleExcelUpload;
window.processSingleExcelFile = processSingleExcelFile;
window.toggleRowCheckbox = toggleRowCheckbox;
window.deleteExcelRow = deleteExcelRow;
window.deleteSelectedExcelRows = deleteSelectedExcelRows;
window.clearAllExcelRows = clearAllExcelRows;

// [관제 인쇄(Print)]
window.exportToInvoiceModal = exportToInvoiceModal;
window.previewInvoiceRow = previewInvoiceRow;
window.syncPreviewData = syncPreviewData;
window.loadSavedForms = loadSavedForms;
window.executeBatchPrint = executeBatchPrint;
window.selectFormTemplate = selectFormTemplate;
window.cancelProviderFormEdit = cancelProviderFormEdit;
window.saveProviderForm = saveProviderForm;
window.deleteSavedForm = deleteSavedForm;
window.updateLivePreview = updateLivePreview;
window.previewSavedForm = previewSavedForm;
window.toggleSelectForm = toggleSelectForm;
window.applySavedForm = applySavedForm;
window.switchInvoiceTab = switchInvoiceTab;

// [관제 데이터 추출(Export)]
window.openExcelExportModal = openExcelExportModal;
window.closeExcelExportModal = closeExcelExportModal;
window.executeExcelExport = executeExcelExport;