// js/admin-app.js

import { db } from "./admin-api.js";
import { doc, getDoc, onSnapshot, collection, query, orderBy, limit, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { initKakaoMap, focusMapPosition } from "./admin-map.js";
import { state, todayStr, getLocalDateString } from "./admin-state.js";
import { renderPaginationControls } from "./admin-ui.js";

// ==========================================
// [마스터 기능 모듈 가져오기]
// ==========================================
import {
    switchMasterTab, changeMasterTabPagination, renderMasterTables,
    generateNewLicense, openEditLicenseModal, closeEditModal,
    renderModalConnectedDrivers, linkDriverFromModal, unlinkDriverFromModal,
    saveLicenseEdit, deleteLicense, deleteLicenseFromModal,
    renderBlockedDevicesTable, addBlockedDevice, unblockDevice,
    openBlockedDeviceModal, closeBlockedDeviceModal, renderModalBlockedDevices, addBlockedDeviceFromModal
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
    openMasterNoticeHistoryModal, closeMasterNoticeHistoryModal, renderMasterNoticeHistoryList
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
    openLinkDriverModal, closeLinkDriverModal, confirmLinkDriver
} from "./admin-dispatch-core.js";

import {
    saveCompanyBaseAddress, clearCompanyBaseAddress, updateCompanyBaseUI,
    renderDispatchDriverList, toggleDispatchDriver, toggleAllDispatchDrivers, adjustDriverWeight,
    selectDispatchDriver, renderDispatchDriverDetail, changeOrderDriver,
    runAutoDispatchAlgorithm, revertAutoDispatch, initDispatchResizer,
    sendRoutesToDrivers, printSelectedDriverItemList, sortDetailByAddress
} from "./admin-dispatch-auto.js";

import {
    processSinglePdfFile, batchGeocodePdfList
} from "./admin-dispatch-pdf.js";

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
    executeBatchPrint, setAsDefaultForm,
    cancelProviderFormEdit, saveProviderForm, deleteSavedForm,
    updateLivePreview, previewSavedForm, toggleSelectForm, applySavedForm,
    filterInvoicePrintList, toggleAllInvoiceSelection, toggleSingleInvoiceItem,
    handleHeaderCheckAll, renderInvoiceOrderList, initTemplatePdfDropZone,
    populateSenderFilterDropdown, filterBySender,
    openPickingDriverModal, closePickingDriverModal,
    toggleAllPickingDrivers, togglePickingDriver, executePickingListPrint,
    sortPrintList, initInvoiceResizer
} from "./admin-dispatch-print.js";

// 🌟 서식 빌더 모듈
import {
    parsePdfToEditableDocument, renderEditableDocument,
    saveCurrentDocumentTemplate
} from "./admin-dispatch-template.js";

// 🌟 신규 행정구역(구/동) 권역 설정 모듈 임포트
import {
    renderLocationSidebar, jumpToDriverDelivery, focusDriverLocationOnMap,
    showFallbackLocation, closeCurrentLocationOverlay, drawAllDriversOnMap,
    fitMapToAllDrivers, openDriverTerritoryModal, closeDriverTerritoryModal,
    onTerritorySidoChange, onTerritorySigunguChange, toggleDongZone,
    toggleEntireSigungu, removeTerritoryZone, clearTerritoryBasket,
    searchTerritoryAddress, saveDriverTerritory,
    openAllTerritoriesMap, closeAllTerritoriesMap
} from "./admin-dispatch-territory.js";

import {
    openExcelExportModal, closeExcelExportModal, executeExcelExport
} from "./admin-dispatch-export.js";


// ==========================================
// 1. 초기화 및 페이지 라우팅 제어 (Lifecycle)
// ==========================================
window.onload = () => {
    const path = window.location.pathname;
    const isMasterPage = path.includes('admin-master.html');
    const isDispatchPage = path.includes('admin-dispatch.html');
    const isLoginPage = !isMasterPage && !isDispatchPage;

    // 날짜 기본값 설정
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

    // 모듈 초기화 (해당 요소가 있는 페이지에서만 실행)
    if (document.getElementById('pro-invoice-modal') && typeof loadSavedForms === 'function') loadSavedForms();
    if (document.getElementById('excel-drop-zone') && typeof initExcelDropZone === 'function') initExcelDropZone(); 
    if (document.getElementById('template-pdf-dropzone') && typeof initTemplatePdfDropZone === 'function') initTemplatePdfDropZone();

    // 모니터링 전용 URL 파라미터 (?monitor=KEY) 감지
    const urlParams = new URLSearchParams(window.location.search);
    const monitorKey = urlParams.get('monitor');
    if (monitorKey) {
        sessionStorage.setItem('deliveryProRole', 'DISPATCH');
        sessionStorage.setItem('deliveryProDispatchKey', monitorKey);
        sessionStorage.setItem('deliveryProSessionToken', 'MONITOR-' + Date.now()); 
        
        if (!isDispatchPage) {
            window.location.href = 'admin-dispatch.html';
            return;
        }
    }

    const savedRole = sessionStorage.getItem('deliveryProRole');
    const savedName = sessionStorage.getItem('deliveryProAdminName') || '마스터';

    // 권한 및 페이지 검증 (접근 제어)
    if (isMasterPage) {
        if (savedRole !== 'MASTER') {
            window.location.href = 'admin.html';
            return;
        }
        showMasterPanel(savedName);
    } else if (isDispatchPage) {
        if (savedRole !== 'DISPATCH') {
            window.location.href = 'admin.html';
            return;
        }
        showDispatchPanel();
    } else if (isLoginPage) {
        if (savedRole === 'MASTER') {
            window.location.href = 'admin-master.html';
        } else if (savedRole === 'DISPATCH') {
            window.location.href = 'admin-dispatch.html';
        }
    }
};

// ==========================================
// 2. 통합 로그인 및 로그아웃
// ==========================================
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
            window.location.href = 'admin-master.html';
            return;
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
            window.location.href = 'admin-dispatch.html';
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
    window.location.href = 'admin.html';
};

window.showMasterPanel = function(name = '마스터') {
    state.currentUserRole = 'MASTER';
    const badge = document.getElementById('master-name-badge');
    if (badge) badge.innerText = name;
    
    window.initMasterDataSync();
    if (typeof switchMasterTab === 'function') switchMasterTab('regular');
};

window.showDispatchPanel = function() {
    state.currentUserRole = 'DISPATCH';

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
    
    if (typeof initKakaoMap === 'function') initKakaoMap();
    window.initMasterDataSync();
    if (typeof setDispatchMode === 'function') setDispatchMode('DELIVERY');
};

// ==========================================
// 3. 실시간 데이터 동기화 (Firestore Snapshots)
// ==========================================
window.initMasterDataSync = function() {
    const isMaster = (sessionStorage.getItem('deliveryProRole') === 'MASTER');

    // 1. 라이선스 실시간 동기화
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
        
        if (!isMaster && typeof renderSidebar === 'function') renderSidebar();
        
        const curKey = document.getElementById('edit-orig-key')?.value;
        if (curKey) {
            const target = state.allLicenses.find(l => l.key === curKey);
            if (target && target.type === 'dispatch' && typeof renderModalConnectedDrivers === 'function') {
                renderModalConnectedDrivers(target.key);
            }
        }
        if (document.getElementById('auto-dispatch-modal') && !document.getElementById('auto-dispatch-modal').classList.contains('hidden')) {
            if (typeof renderDispatchDriverList === 'function') renderDispatchDriverList();
            if (typeof renderDispatchDriverDetail === 'function') renderDispatchDriverDetail();
        }
    });

    // 2. 접속 제한(블랙리스트) 기기 실시간 동기화
    onSnapshot(collection(db, "blocked_devices"), (snapshot) => {
        state.allBlockedDevices = [];
        snapshot.forEach(docSnap => { state.allBlockedDevices.push({ id: docSnap.id, ...docSnap.data() }); });
        const countBlockedEl = document.getElementById('count-blocked');
        if (countBlockedEl) countBlockedEl.innerText = state.allBlockedDevices.length;
        if (typeof renderBlockedDevicesTable === 'function') renderBlockedDevicesTable();
        if (typeof renderModalBlockedDevices === 'function') renderModalBlockedDevices();
    });

    // 3. 메모 실시간 동기화
    onSnapshot(collection(db, "memos"), (snapshot) => {
        state.allMemos = [];
        snapshot.forEach(docSnap => { state.allMemos.push({ id: docSnap.id, ...docSnap.data() }); });
        const countMemosEl = document.getElementById('count-memos');
        if (countMemosEl) countMemosEl.innerText = state.allMemos.length;
        if (typeof renderMemosTable === 'function') renderMemosTable(state.allMemos);
        if (typeof renderAccountHistoryView === 'function') renderAccountHistoryView();
    });

    // 4. 경로 실시간 동기화
    onSnapshot(collection(db, "routes"), (snapshot) => {
        state.activeRoutes = {};
        snapshot.forEach(docSnap => { state.activeRoutes[docSnap.id] = docSnap.data(); });
        if (!isMaster && typeof renderSidebar === 'function') renderSidebar();
        if (!isMaster && state.selectedDeviceId && state.dispatchNavState === 'DELIVERY' && typeof drawDriverOnMap === 'function') {
            drawDriverOnMap(state.selectedDeviceId);
        }
        if (typeof populateDriverSelect === 'function') populateDriverSelect();
        if (typeof renderAccountHistoryView === 'function') renderAccountHistoryView();
    });

    // 5. 배송 완료 실시간 동기화
    onSnapshot(query(collection(db, "completions"), orderBy("completedAt", "asc")), (snapshot) => {
        state.allCompletions = [];
        snapshot.forEach(docSnap => { state.allCompletions.push({ id: docSnap.id, ...docSnap.data() }); });
        if (!isMaster && typeof renderSidebar === 'function') renderSidebar();
        if (!isMaster && state.selectedDeviceId && state.dispatchNavState === 'DELIVERY' && typeof drawDriverOnMap === 'function') {
            drawDriverOnMap(state.selectedDeviceId);
        }
        if (typeof renderAccountHistoryView === 'function') renderAccountHistoryView();
        if (document.getElementById('photo-gallery-modal') && !document.getElementById('photo-gallery-modal').classList.contains('hidden')) {
            renderPhotoGalleryTable();
        }
    });

    // 6. 메시지 실시간 동기화 (최신 50건으로 제한하여 읽기 비용 및 부하 90% 이상 절감)
    onSnapshot(query(collection(db, "dispatch_messages"), orderBy("createdAt", "desc"), limit(50)), (snapshot) => {
        state.allDispatchMessages = [];
        snapshot.forEach(docSnap => { state.allDispatchMessages.push({ id: docSnap.id, ...docSnap.data() }); });
        if (typeof renderMessageFeed === 'function') renderMessageFeed(); 
        if (typeof checkDispatchInboxNotifications === 'function') checkDispatchInboxNotifications(); 
        if (typeof renderMasterNoticeHistoryList === 'function') renderMasterNoticeHistoryList();
    });

    // 7. 템플릿 실시간 동기화
    onSnapshot(collection(db, "dispatch_templates"), (snapshot) => {
        state.allDispatchTemplates = [];
        snapshot.forEach(docSnap => { state.allDispatchTemplates.push({ id: docSnap.id, ...docSnap.data() }); });
        if (typeof renderCustomTemplates === 'function') renderCustomTemplates();
    });
};

// ==========================================
// 4. 마스터 전용 배송 사진 데이터 갤러리 로직
// ==========================================
let photoSortField = 'time';
let photoSortAsc = false;
let photoCurrentPage = 1;
const PAGE_SIZE_PHOTOS = 15;

export function openPhotoGalleryModal() {
    const modal = document.getElementById('photo-gallery-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    renderPhotoGalleryTable();
}

export function closePhotoGalleryModal() {
    const modal = document.getElementById('photo-gallery-modal');
    if (modal) modal.classList.add('hidden');
}

export function clearPhotoDateFilter() {
    const dateEl = document.getElementById('photo-filter-date');
    if (dateEl) dateEl.value = '';
    filterPhotoGallery();
}

export function filterPhotoGallery() {
    photoCurrentPage = 1;
    renderPhotoGalleryTable();
}

export function sortPhotos(field) {
    if (photoSortField === field) {
        photoSortAsc = !photoSortAsc;
    } else {
        photoSortField = field;
        photoSortAsc = false;
    }
    renderPhotoGalleryTable();
}

export function renderPhotoGalleryTable() {
    const tbody = document.getElementById('photo-list-tbody');
    const badge = document.getElementById('photo-total-count-badge');
    const pagEl = document.getElementById('pagination-photos');
    if (!tbody) return;

    const arrowAuthor = document.getElementById('sort-photo-arrow-author');
    const arrowTime = document.getElementById('sort-photo-arrow-time');
    if (arrowAuthor) arrowAuthor.innerText = (photoSortField === 'author') ? (photoSortAsc ? '▲' : '▼') : '↕';
    if (arrowTime) arrowTime.innerText = (photoSortField === 'time') ? (photoSortAsc ? '▲' : '▼') : '↕';

    const searchDriver = (document.getElementById('photo-filter-driver-search')?.value || '').trim().toLowerCase();
    const filterDate = document.getElementById('photo-filter-date')?.value || '';

    let photoCompletions = state.allCompletions.filter(c => c.photoUrl);

    if (searchDriver) {
        photoCompletions = photoCompletions.filter(c => 
            (c.phone && c.phone.includes(searchDriver)) || 
            (c.deviceId && c.deviceId.toLowerCase().includes(searchDriver))
        );
    }

    if (filterDate) {
        const dotDate = filterDate.replace(/-/g, '.');
        photoCompletions = photoCompletions.filter(c => {
            return (c.timeString && c.timeString.startsWith(dotDate)) || 
                   (c.completedAt && getLocalDateString(new Date(c.completedAt)) === filterDate);
        });
    }

    if (badge) badge.innerText = `총 ${photoCompletions.length}건`;

    if (photoCompletions.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-12 text-center text-gray-400 font-bold">등록된 배송 완료 사진이 없습니다.</td></tr>`;
        if (pagEl) pagEl.innerHTML = '';
        return;
    }

    photoCompletions.sort((a, b) => {
        if (photoSortField === 'author') {
            const valA = a.phone || a.deviceId || '';
            const valB = b.phone || b.deviceId || '';
            return photoSortAsc ? valA.localeCompare(valB) : valB.localeCompare(a);
        } else {
            const timeA = a.completedAt || 0;
            const timeB = b.completedAt || 0;
            return photoSortAsc ? (timeA - timeB) : (timeB - timeA);
        }
    });

    const total = photoCompletions.length;
    const totalPages = Math.ceil(total / PAGE_SIZE_PHOTOS) || 1;
    if (photoCurrentPage > totalPages) photoCurrentPage = totalPages;
    if (photoCurrentPage < 1) photoCurrentPage = 1;

    const start = (photoCurrentPage - 1) * PAGE_SIZE_PHOTOS;
    const paged = photoCompletions.slice(start, start + PAGE_SIZE_PHOTOS);

    tbody.innerHTML = paged.map((c, idx) => {
        const safeUrl = (c.photoUrl || '').replace(/"/g, '&quot;');
        const safeAddr = (c.address || '-').replace(/"/g, '&quot;').replace(/'/g, "\\'");
        const safePhone = (c.phone || '기사').replace(/"/g, '&quot;').replace(/'/g, "\\'");
        const safeTime = (c.timeString || '-').replace(/"/g, '&quot;').replace(/'/g, "\\'");
        const safeTag = (c.tag || '전달완료').replace(/"/g, '&quot;').replace(/'/g, "\\'");

        return `
        <tr class="hover:bg-gray-50/80 transition">
            <td class="py-3 px-3 font-bold text-gray-400 text-center">${start + idx + 1}</td>
            <td class="py-3 px-3 font-black text-gray-800 text-center">${c.phone || '<span class="text-gray-400 font-normal">연락처 없음</span>'}</td>
            <td class="py-3 px-3 text-gray-500 font-medium text-center font-mono text-[11px]">${c.timeString || '-'}</td>
            <td class="py-3 px-3 font-bold text-gray-900 truncate max-w-[280px]" title="${c.address || ''}">${c.address || '-'}</td>
            <td class="py-3 px-3 text-center"><span class="px-2 py-0.5 rounded text-[10px] font-black bg-emerald-100 text-emerald-800">${c.tag || '전달완료'}</span></td>
            <td class="py-3 px-3 text-center whitespace-nowrap">
                <button onclick="window.openPhotoPreviewModal('${safeUrl}', '${safeAddr}', '${safePhone}', '${safeTime}', '${safeTag}')" class="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-lg text-[11px] shadow-sm transition active:scale-95 flex items-center gap-1 mx-auto">
                    <i class="fa-solid fa-image"></i> 사진보기
                </button>
            </td>
            <td class="py-3 px-3 text-center whitespace-nowrap">
                <button onclick="window.deletePhotoCompletion('${c.id}')" class="px-2 py-1 bg-red-50 hover:bg-red-100 text-red-600 font-bold rounded-lg text-[11px] transition shadow-2xs active:scale-95">삭제</button>
            </td>
        </tr>`;
    }).join('');

    if (pagEl) {
        pagEl.innerHTML = renderPaginationControls('photos', photoCurrentPage, total, PAGE_SIZE_PHOTOS, 'window.changePhotoPage');
    }
}

export function changePhotoPage(tabKey, targetPage) {
    photoCurrentPage = targetPage;
    renderPhotoGalleryTable();
}

export function openPhotoPreviewModal(imgUrl, addr, phone, time, tag) {
    const modal = document.getElementById('photo-preview-modal');
    if (!modal) return;
    document.getElementById('photo-preview-img').src = imgUrl;
    document.getElementById('photo-preview-addr').innerText = addr || '주소 정보 없음';
    document.getElementById('photo-preview-sub').innerText = `${phone} | ${time}`;
    document.getElementById('photo-preview-tag').innerText = tag || '전달완료';
    document.getElementById('photo-preview-link').href = imgUrl;
    modal.classList.remove('hidden');
}

export function closePhotoPreviewModal() {
    const modal = document.getElementById('photo-preview-modal');
    if (modal) modal.classList.add('hidden');
}

export async function deletePhotoCompletion(id) {
    if (!confirm("이 배송 완료 기록(사진 포함)을 영구 삭제하시겠습니까?")) return;
    try {
        await deleteDoc(doc(db, "completions", id));
        alert("사진 데이터가 삭제되었습니다.");
        renderPhotoGalleryTable();
    } catch(e) {
        alert("삭제 오류: " + e.message);
    }
}

// ==========================================
// 5. HTML 인라인 이벤트를 위한 전역 Window 객체 바인딩
// ==========================================
window.formatNumber = formatNumber;

// [마스터 - Licenses & Blocked Devices]
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

// [마스터 - Photo Gallery]
window.openPhotoGalleryModal = openPhotoGalleryModal;
window.closePhotoGalleryModal = closePhotoGalleryModal;
window.clearPhotoDateFilter = clearPhotoDateFilter;
window.filterPhotoGallery = filterPhotoGallery;
window.sortPhotos = sortPhotos;
window.renderPhotoGalleryTable = renderPhotoGalleryTable;
window.changePhotoPage = changePhotoPage;
window.openPhotoPreviewModal = openPhotoPreviewModal;
window.closePhotoPreviewModal = closePhotoPreviewModal;
window.deletePhotoCompletion = deletePhotoCompletion;

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
window.focusMapPosition = focusMapPosition;

// [관제 자동할당 및 기사 배포 모듈 (Auto Dispatch)]
window.saveCompanyBaseAddress = saveCompanyBaseAddress;
window.clearCompanyBaseAddress = clearCompanyBaseAddress;
window.updateCompanyBaseUI = updateCompanyBaseUI;
window.renderDispatchDriverList = renderDispatchDriverList;
window.selectDispatchDriver = selectDispatchDriver;
window.sortDetailByAddress = sortDetailByAddress;
window.renderDispatchDriverDetail = renderDispatchDriverDetail;
window.changeOrderDriver = changeOrderDriver;
window.runAutoDispatchAlgorithm = runAutoDispatchAlgorithm;
window.revertAutoDispatch = revertAutoDispatch;
window.initDispatchResizer = initDispatchResizer;
window.toggleAllDispatchDrivers = toggleAllDispatchDrivers;
window.sendRoutesToDrivers = sendRoutesToDrivers;
window.printSelectedDriverItemList = printSelectedDriverItemList;
window.toggleDispatchDriver = toggleDispatchDriver;
window.adjustDriverWeight = adjustDriverWeight;

// [관제 PDF 파싱 모듈]
window.processSinglePdfFile = processSinglePdfFile;
window.batchGeocodePdfList = batchGeocodePdfList;

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

// [관제 신규 권역/지도(Territory) 전역 바인딩]
window.renderLocationSidebar = renderLocationSidebar;
window.jumpToDriverDelivery = jumpToDriverDelivery;
window.focusDriverLocationOnMap = focusDriverLocationOnMap;
window.showFallbackLocation = showFallbackLocation;
window.closeCurrentLocationOverlay = closeCurrentLocationOverlay;
window.drawAllDriversOnMap = drawAllDriversOnMap;
window.fitMapToAllDrivers = fitMapToAllDrivers;
window.openDriverTerritoryModal = openDriverTerritoryModal;
window.closeDriverTerritoryModal = closeDriverTerritoryModal;
window.onTerritorySidoChange = onTerritorySidoChange;
window.onTerritorySigunguChange = onTerritorySigunguChange;
window.toggleDongZone = toggleDongZone;
window.toggleEntireSigungu = toggleEntireSigungu;
window.removeTerritoryZone = removeTerritoryZone;
window.clearTerritoryBasket = clearTerritoryBasket;
window.searchTerritoryAddress = searchTerritoryAddress;
window.saveDriverTerritory = saveDriverTerritory;
window.openAllTerritoriesMap = openAllTerritoriesMap;
window.closeAllTerritoriesMap = closeAllTerritoriesMap;

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
window.filterInvoicePrintList = filterInvoicePrintList;
window.handleHeaderCheckAll = handleHeaderCheckAll;
window.toggleAllInvoiceSelection = toggleAllInvoiceSelection;
window.toggleSingleInvoiceItem = toggleSingleInvoiceItem;
window.renderInvoiceOrderList = renderInvoiceOrderList;
window.previewInvoiceRow = previewInvoiceRow;
window.syncPreviewData = syncPreviewData;
window.loadSavedForms = loadSavedForms;
window.executeBatchPrint = executeBatchPrint;
window.initTemplatePdfDropZone = initTemplatePdfDropZone;
window.setAsDefaultForm = setAsDefaultForm;
window.cancelProviderFormEdit = cancelProviderFormEdit;
window.saveProviderForm = saveProviderForm;
window.deleteSavedForm = deleteSavedForm;
window.updateLivePreview = updateLivePreview;
window.previewSavedForm = previewSavedForm;
window.toggleSelectForm = toggleSelectForm;
window.applySavedForm = applySavedForm;
window.filterBySender = filterBySender;
window.openPickingDriverModal = openPickingDriverModal;
window.closePickingDriverModal = closePickingDriverModal;
window.toggleAllPickingDrivers = toggleAllPickingDrivers;
window.togglePickingDriver = togglePickingDriver;
window.executePickingListPrint = executePickingListPrint;
window.printAggregatedItemList = openPickingDriverModal;
window.sortPrintList = sortPrintList;
window.initInvoiceResizer = initInvoiceResizer;

// [관제 신규 서식 빌더/에디터(Template)]
window.parsePdfToEditableDocument = parsePdfToEditableDocument;
window.renderEditableDocument = renderEditableDocument;
window.saveCurrentDocumentTemplate = saveCurrentDocumentTemplate;

// [관제 데이터 추출(Export)]
window.openExcelExportModal = openExcelExportModal;
window.closeExcelExportModal = closeExcelExportModal;
window.executeExcelExport = executeExcelExport;