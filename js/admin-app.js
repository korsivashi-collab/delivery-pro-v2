// js/admin-app.js

import { db, AUTH_FAILURE_MESSAGE, loginWithSecret, restoreFirebaseSession, signOutFirebaseSession,
    getVerifiedAuthSession, onVerifiedSessionInvalidated, subscribeLegacyRoutes } from "./admin-api.js";
import { doc, getDoc, onSnapshot, collection, query, where, orderBy, limit, updateDoc, deleteDoc, runTransaction } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { initKakaoMap, focusMapPosition } from "./admin-map.js";
import { state, todayStr, getLocalDateString } from "./admin-state.js";
import { renderPaginationControls } from "./admin-ui.js";

// ==========================================
// [마스터 기능 모듈 가져오기]
// ==========================================
import {
    switchMasterTab, changeMasterTabPagination, renderMasterTables, initMasterCredentialControls,
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
// [관제/PRO 코어 모듈 가져오기]
// ==========================================
import {
    formatNumber, forceClearMap, getFilteredVisibleDrivers, setDispatchMode, renderSidebar,
    renderDriverListView, setDispatchDetailTab, renderDriverDetailView, selectDriver,
    clearSelectedDriver, removeOrUnlinkDriver, drawDriverOnMap, setMapPolylineMode,
    changeDispatchDate, onDispatchDateChange, resetDispatchDateToToday,
    handleProFeature, closeAutoDispatchModal, closeProInvoiceModal, closePremiumModal,
    openLinkDriverModal, closeLinkDriverModal, confirmLinkDriver
} from "./admin-dispatch-core.js";

// 🌟 [관제 통합 검색 및 기간 확장 조회 모듈]
import {
    closeSearchSidePanel, clearSearchInput, jumpToDeliveryTarget,
    inspectDriverRoute, viewSearchCompletionPhoto, setSearchRangeMode,
    applyCustomSearchRange, resetSearchToToday, handleGlobalSearch
} from "./admin-dispatch-search.js";

import {
    saveCompanyBaseAddress, clearCompanyBaseAddress, updateCompanyBaseUI,
    renderDispatchDriverList, toggleDispatchDriver, toggleAllDispatchDrivers, adjustDriverWeight,
    selectDispatchDriver, renderDispatchDriverDetail, changeOrderDriver,
    runAutoDispatchAlgorithm, revertAutoDispatch, initDispatchResizer,
    sendRoutesToDrivers, printSelectedDriverItemList
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

// 🌟 [관제 인쇄 메인 모듈 (슬림화 버전)]
import {
    exportToInvoiceModal, previewInvoiceRow, executeBatchPrint,
    filterInvoicePrintList, toggleAllInvoiceSelection, toggleSingleInvoiceItem,
    handleHeaderCheckAll, renderInvoiceOrderList, initTemplatePdfDropZone,
    populateSenderFilterDropdown, filterBySender,
    sortPrintList, initInvoiceResizer
} from "./admin-dispatch-print.js";

// 🌟 [서식/폼 관리 모듈]
import {
    loadSavedForms, setAsDefaultForm, toggleSelectForm,
    previewSavedForm, applySavedForm, saveProviderForm,
    deleteSavedForm, cancelProviderFormEdit, updateLivePreview, syncPreviewData
} from "./admin-dispatch-forms.js";

// 🌟 [창고 피킹 리스트 모듈]
import {
    openPickingDriverModal, closePickingDriverModal,
    toggleAllPickingDrivers, togglePickingDriver, executePickingListPrint
} from "./admin-dispatch-picking.js";

// 서식 빌더 모듈
import {
    parsePdfToEditableDocument, renderEditableDocument,
    saveCurrentDocumentTemplate
} from "./admin-dispatch-template.js";

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
// 1. 초기화 및 페이지 라우팅 제어 (Lifecycle)
// ==========================================
let adminIdentity = null;
let adminBootTask = null;
let adminLoginBusy = false;
let adminLogoutTask = null;
let dataSyncStarted = false;
let dispatchPanelStarted = false;
const adminSubscriptions = [];
let routeSyncCleanup = null;

function clearAdminSessionStorage() {
    for (const key of ['deliveryProRole', 'deliveryProAdminName', 'deliveryProDispatchKey', 'deliveryProSessionToken']) sessionStorage.removeItem(key);
}
function stopAdminDataSync() {
    adminIdentity = null;
    if (routeSyncCleanup) routeSyncCleanup();
    routeSyncCleanup = null;
    state.activeRoutes = {};
    dataSyncStarted = false;
    dispatchPanelStarted = false;
    for (const unsubscribe of adminSubscriptions.splice(0)) unsubscribe();
    state.currentUserRole = null;
    if (typeof forceClearMap === 'function') forceClearMap();
}
function subscribeAdmin(source, callback, onError = null) {
    const identity = adminIdentity;
    adminSubscriptions.push(onSnapshot(source, snapshot => {
        if (identity && adminIdentity === identity && getVerifiedAuthSession() === identity) callback(snapshot);
    }, () => {
        if (onError && identity && adminIdentity === identity && getVerifiedAuthSession() === identity) onError();
    }));
}
onVerifiedSessionInvalidated(() => {
    if (!adminIdentity) return;
    stopAdminDataSync();
    clearAdminSessionStorage();
    window.location.href = 'admin.html';
});

async function connectDispatchSession(identity, newLogin = false) {
    if (identity?.role !== 'dispatch' || getVerifiedAuthSession('dispatch') !== identity) throw new Error(AUTH_FAILURE_MESSAGE);
    const key = identity.accountRef.slice('licenses/'.length);
    const savedToken = sessionStorage.getItem('deliveryProDispatchKey') === key ? sessionStorage.getItem('deliveryProSessionToken') : null;
    const nextToken = 'SES-' + crypto.randomUUID();
    const selectedToken = await runTransaction(db, async transaction => {
        const ref = doc(db, 'licenses', key);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists() || getVerifiedAuthSession('dispatch') !== identity) throw new Error(AUTH_FAILURE_MESSAGE);
        const data = snapshot.data();
        if (data.type !== 'dispatch' || data.status !== 'active') throw new Error(AUTH_FAILURE_MESSAGE);
        const sessions = Array.isArray(data.activeSessions) ? [...data.activeSessions] : (data.currentSessionToken ? [data.currentSessionToken] : []);
        if (!newLogin && savedToken && !savedToken.startsWith('MONITOR-')) {
            if (!sessions.includes(savedToken)) throw new Error(AUTH_FAILURE_MESSAGE);
            return savedToken;
        }
        const configured = Number(data.maxSessions);
        const maxSessions = Number.isSafeInteger(configured) && configured > 0 ? configured : (data.isPro ? 2 : 1);
        while (sessions.length >= maxSessions) sessions.shift();
        sessions.push(nextToken);
        // Preserve the existing FIFO policy without rewriting the product setting.
        transaction.update(ref, { currentSessionToken: nextToken, activeSessions: sessions, lastLoginAt: Date.now() });
        return nextToken;
    });
    if (getVerifiedAuthSession('dispatch') !== identity) throw new Error(AUTH_FAILURE_MESSAGE);
    sessionStorage.setItem('deliveryProRole', 'DISPATCH');
    sessionStorage.setItem('deliveryProDispatchKey', key);
    sessionStorage.setItem('deliveryProSessionToken', selectedToken);
    adminIdentity = identity;
}

function connectMasterSession(identity) {
    if (identity?.role !== 'master' || getVerifiedAuthSession('master') !== identity) throw new Error(AUTH_FAILURE_MESSAGE);
    clearAdminSessionStorage();
    adminIdentity = identity;
    sessionStorage.setItem('deliveryProRole', 'MASTER'); // Display state only.
}

window.onload = () => {
    if (adminBootTask) return adminBootTask;
    adminBootTask = (async () => {
        const path = window.location.pathname;
        const isMasterPage = path.includes('admin-master.html');
        const isDispatchPage = path.includes('admin-dispatch.html');
        const input = document.getElementById('single-key-input');
        if (input) { input.type = 'password'; input.autocomplete = 'current-password'; input.autocapitalize = 'none'; input.spellcheck = false; }
        try {
            const identity = await restoreFirebaseSession();
            // URL parameters and stored MASTER roles confer no authentication.
            if (identity?.role === 'master') {
                connectMasterSession(identity);
                if (!isMasterPage) { window.location.href = 'admin-master.html'; return; }
                window.showMasterPanel();
                return;
            }
            if (!identity || identity.role !== 'dispatch') {
                clearAdminSessionStorage();
                if (isMasterPage || isDispatchPage) window.location.href = 'admin.html';
                else if (identity) {
                    const message = document.getElementById('login-msg');
                    if (message) message.innerText = AUTH_FAILURE_MESSAGE;
                }
                return;
            }
            await connectDispatchSession(identity);
            if (!isDispatchPage) { window.location.href = 'admin-dispatch.html'; return; }
            const todayInput = document.getElementById('dispatch-date-picker');
            if (todayInput) todayInput.value = todayStr;
            const assignDateInput = document.getElementById('dispatch-assign-date');
            if (assignDateInput) { assignDateInput.value = todayStr; assignDateInput.onchange = () => window.loadExcelFromFirebase(); }
            if (document.getElementById('pro-invoice-modal') && typeof loadSavedForms === 'function') loadSavedForms();
            if (document.getElementById('excel-drop-zone') && typeof initExcelDropZone === 'function') initExcelDropZone();
            if (document.getElementById('template-pdf-dropzone') && typeof initTemplatePdfDropZone === 'function') initTemplatePdfDropZone();
            window.showDispatchPanel();
        } catch {
            stopAdminDataSync();
            clearAdminSessionStorage();
            try { await signOutFirebaseSession(); } catch {}
            if (isMasterPage || isDispatchPage) window.location.href = 'admin.html';
            else {
                const message = document.getElementById('login-msg');
                if (message) message.innerText = AUTH_FAILURE_MESSAGE;
            }
        }
    })();
    return adminBootTask;
};

// Existing login input now contains a secret, never a business key.
window.handleSingleKeyLogin = async function() {
    if (adminLoginBusy) return;
    adminLoginBusy = true;
    const input = document.getElementById('single-key-input');
    const secret = (input?.value || '').trim();
    if (input) input.value = '';
    const message = document.getElementById('login-msg');
    const button = document.getElementById('login-btn');
    if (message) message.innerText = '';
    if (button) { button.disabled = true; button.innerHTML = '인증 확인 중...'; }
    try {
        if (adminBootTask) await adminBootTask;
        const identity = await loginWithSecret(secret, ['dispatch', 'master']);
        if (identity.role === 'master') {
            connectMasterSession(identity);
            window.location.href = 'admin-master.html';
        } else {
            await connectDispatchSession(identity, true);
            window.location.href = 'admin-dispatch.html';
        }
    } catch {
        stopAdminDataSync();
        clearAdminSessionStorage();
        try { await signOutFirebaseSession(); } catch {}
        if (message) message.innerText = AUTH_FAILURE_MESSAGE;
    } finally {
        if (input) input.value = '';
        adminLoginBusy = false;
        if (button) { button.disabled = false; button.innerHTML = '<span>대시보드 접속</span>'; }
    }
};

window.systemLogout = function() {
    if (adminLogoutTask) return adminLogoutTask;
    const identity = getVerifiedAuthSession('dispatch');
    const localToken = sessionStorage.getItem('deliveryProSessionToken');
    stopAdminDataSync();
    clearAdminSessionStorage();
    adminLogoutTask = (async () => {
        try {
            if (identity && localToken) await runTransaction(db, async transaction => {
                const ref = doc(db, 'licenses', identity.accountRef.slice('licenses/'.length));
                const snapshot = await transaction.get(ref);
                if (snapshot.exists() && getVerifiedAuthSession('dispatch') === identity) {
                    const data = snapshot.data();
                    const sessions = Array.isArray(data.activeSessions) ? data.activeSessions : (data.currentSessionToken ? [data.currentSessionToken] : []);
                    const filtered = sessions.filter(token => token !== localToken);
                    transaction.update(ref, { activeSessions: filtered,
                        currentSessionToken: data.currentSessionToken === localToken ? (filtered.at(-1) || '') : (data.currentSessionToken || '') });
                }
            });
        } catch { /* Firebase signOut still runs when legacy session cleanup fails. */ }
        try { await signOutFirebaseSession(); window.location.href = 'admin.html'; }
        catch { alert(AUTH_FAILURE_MESSAGE); }
        finally { adminLogoutTask = null; }
    })();
    return adminLogoutTask;
};

window.showMasterPanel = function(name = '마스터') {
    if (!adminIdentity || adminIdentity.role !== 'master' || getVerifiedAuthSession('master') !== adminIdentity) return;
    state.currentUserRole = 'MASTER';
    const badge = document.getElementById('master-name-badge');
    if (badge) badge.innerText = name;
    initMasterCredentialControls();
    
    window.initMasterDataSync();
    if (typeof switchMasterTab === 'function') switchMasterTab('regular');
};

window.showDispatchPanel = function() {
    if (!adminIdentity || getVerifiedAuthSession('dispatch') !== adminIdentity || dispatchPanelStarted) return;
    dispatchPanelStarted = true;
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
    // 🌟 관제 진입 시 당일 저장된 엑셀/주문 데이터가 있으면 자동 로드
    if (typeof loadExcelFromFirebase === 'function') loadExcelFromFirebase();
};

// ==========================================
// 3. 실시간 데이터 동기화 (Firestore Snapshots - 실시간 잔상 소거 연동)
// ==========================================
window.initMasterDataSync = function() {
    if (!adminIdentity || getVerifiedAuthSession() !== adminIdentity || dataSyncStarted) return;
    dataSyncStarted = true;
    const isMaster = adminIdentity.role === 'master';
    const dispatchKey = isMaster ? null : adminIdentity.accountRef.slice('licenses/'.length);
    let reconcileRouteOwners = () => {};

    // 1. 라이선스 실시간 동기화
    const renderLicenseState = () => {
        const currentRole = adminIdentity.role === 'dispatch' ? 'DISPATCH' : 'MASTER';
        const currentKey = adminIdentity.accountRef.slice('licenses/'.length);
        const localToken = sessionStorage.getItem('deliveryProSessionToken');
        
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

            if (localToken && !localToken.startsWith('MONITOR-')) {
                const maxAllowed = parseInt(myAccount.maxSessions) || (myAccount.isPro ? 2 : 1);
                const activeSessions = Array.isArray(myAccount.activeSessions) 
                    ? myAccount.activeSessions 
                    : (myAccount.currentSessionToken ? [myAccount.currentSessionToken] : []);
                
                if (!activeSessions.includes(localToken)) {
                    alert(`⚠️ 다른 PC에서 로그인하여 동시 접속 허용 회선 수(${maxAllowed}대)를 초과했습니다.\n시스템 보안을 위해 현재 창이 자동 로그아웃됩니다.`);
                    window.systemLogout();
                    return;
                }
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
    };
    if (isMaster) {
        subscribeAdmin(collection(db, "licenses"), snapshot => {
            state.allLicenses = [];
            snapshot.forEach(item => state.allLicenses.push({ ...item.data(), id: item.id }));
            renderLicenseState();
        });
    } else {
        // Preserve the shared array, but receive only this verified account and
        // its drivers. Wait for both initial snapshots before checking the UI.
        let ownAccount = null, drivers = [];
        let ownReady = false, driversReady = false;
        state.allLicenses = [];
        const mergeLicenses = () => {
            if (!ownReady || !driversReady) return;
            const accounts = new Map(drivers.map(item => [item.id, item]));
            if (ownAccount) accounts.set(ownAccount.id, ownAccount);
            state.allLicenses = [...accounts.values()];
            renderLicenseState();
            reconcileRouteOwners();
        };
        subscribeAdmin(doc(db, 'licenses', dispatchKey), snapshot => {
            ownAccount = snapshot.exists() ? { ...snapshot.data(), id: snapshot.id } : null;
            ownReady = true;
            mergeLicenses();
        });
        subscribeAdmin(query(collection(db, 'licenses'), where('dispatchKey', '==', dispatchKey)), snapshot => {
            drivers = [];
            snapshot.forEach(item => {
                if (item.data().type !== 'dispatch') drivers.push({ ...item.data(), id: item.id });
            });
            driversReady = true;
            mergeLicenses();
        });
    }

    // 2. 접속 제한(블랙리스트) 기기 실시간 동기화
    if (isMaster) subscribeAdmin(collection(db, "blocked_devices"), (snapshot) => {
        state.allBlockedDevices = [];
        snapshot.forEach(docSnap => { state.allBlockedDevices.push({ id: docSnap.id, ...docSnap.data() }); });
        const countBlockedEl = document.getElementById('count-blocked');
        if (countBlockedEl) countBlockedEl.innerText = state.allBlockedDevices.length;
        if (typeof renderBlockedDevicesTable === 'function') renderBlockedDevicesTable();
        if (typeof renderModalBlockedDevices === 'function') renderModalBlockedDevices();
    });
    else state.allBlockedDevices = [];

    // 3. 메모 실시간 동기화
    subscribeAdmin(collection(db, "memos"), (snapshot) => {
        state.allMemos = [];
        snapshot.forEach(docSnap => { state.allMemos.push({ id: docSnap.id, ...docSnap.data() }); });
        const countMemosEl = document.getElementById('count-memos');
        if (countMemosEl) countMemosEl.innerText = state.allMemos.length;
        if (typeof renderMemosTable === 'function') renderMemosTable(state.allMemos);
        if (typeof renderAccountHistoryView === 'function') renderAccountHistoryView();
    });

    // 🌟 4. 경로(Routes) 실시간 동기화 (기사 앱에서 동선 삭제/초기화 시 지도 및 모달 잔상 즉시 소거)
    const renderRoutesState = () => {
        if (!isMaster && typeof renderSidebar === 'function') renderSidebar();
        
        if (!isMaster && state.selectedDeviceId && state.dispatchNavState === 'DELIVERY' && typeof drawDriverOnMap === 'function') {
            drawDriverOnMap(state.selectedDeviceId);
        } else if (!isMaster && !state.selectedDeviceId && state.dispatchNavState === 'DELIVERY' && typeof forceClearMap === 'function') {
            forceClearMap();
        }

        if (typeof populateDriverSelect === 'function') populateDriverSelect();
        if (typeof renderAccountHistoryView === 'function') renderAccountHistoryView();

        // 🌟 기사 앱에서 동선이 삭제/비워졌을 때 자동할당 모달 UI(기사 목록/상세 테이블) 즉시 동기화
        if (document.getElementById('auto-dispatch-modal') && !document.getElementById('auto-dispatch-modal').classList.contains('hidden')) {
            if (typeof renderDispatchDriverList === 'function') renderDispatchDriverList();
            if (typeof renderDispatchDriverDetail === 'function') renderDispatchDriverDetail();
        }
        const searchInput = document.getElementById('global-search-input');
        if (!isMaster && searchInput?.value && typeof handleGlobalSearch === 'function') handleGlobalSearch(searchInput.value, false);
    };
    if (isMaster) subscribeAdmin(collection(db, 'routes'), snapshot => {
        state.activeRoutes = {};
        snapshot.forEach(item => { state.activeRoutes[item.id] = item.data(); });
        renderRoutesState();
    });
    else {
        const identity = adminIdentity;
        const companyRoutesSource = new Map();
        const legacyOwnerRoutesSource = new Map();
        const companyRouteVersions = new Map();
        let ownerUnsubscribes = [], generation = 0, snapshotVersion = 0, ownerSignature = '';
        let owners = new Set(), licenses = new Map();
        let companyUnsubscribes = [], companyGeneration = 0, companySignature = '';
        const companyChunks = new Map();
        const current = () => adminIdentity === identity && getVerifiedAuthSession() === identity;
        const eligible = entry => {
            const route = entry.data;
            if (route.dispatchKey !== undefined && route.dispatchKey !== dispatchKey) {
                const lic = licenses.get(route.licenseKey);
                if (entry.source !== 'legacy' || typeof route.dispatchKey !== 'string' || !route.dispatchKey.trim() ||
                    !lic || !lic.routeOwnerId || route.routeOwnerId !== lic.routeOwnerId ||
                    [...licenses.values()].filter(item => item.routeOwnerId === route.routeOwnerId).length !== 1) return false;
            }
            const ownerLicenses = [...licenses.values()].filter(lic => lic.routeOwnerId && lic.routeOwnerId === route.routeOwnerId);
            if (route.licenseKey !== undefined) {
                const lic = licenses.get(route.licenseKey);
                return !!lic && (!route.routeOwnerId || route.routeOwnerId === lic.routeOwnerId);
            }
            return ownerLicenses.length > 0;
        };
        const readSource = (snapshot, source = 'company') => {
            const result = new Map(), version = ++snapshotVersion;
            snapshot.forEach(item => { result.set(item.id, { data: item.data(), version, source, requestRevision: snapshot.requestRevision }); });
            return result;
        };
        const publishRoutes = () => {
            if (!current()) return;
            const combined = new Map(companyRoutesSource);
            for (const source of legacyOwnerRoutesSource.values()) for (const [id, entry] of source) {
                if (entry.requestRevision !== undefined && entry.requestRevision < (companyRouteVersions.get(id) || 0)) continue;
                if (!combined.has(id) || combined.get(id).version < entry.version) combined.set(id, entry);
            }
            const allowed = [...combined].filter(([, entry]) => eligible(entry));
            const latest = new Map();
            for (const [id, entry] of allowed) {
                const route = entry.data;
                if (!route.routeOwnerId || !Number.isFinite(route.updatedAt) ||
                    (!Array.isArray(route.destinations) && route.cleared !== true)) continue;
                const previous = latest.get(route.routeOwnerId);
                if (!previous || route.updatedAt > previous[1].data.updatedAt ||
                    (route.updatedAt === previous[1].data.updatedAt && String(id).localeCompare(String(previous[0])) < 0)) latest.set(route.routeOwnerId, [id, entry]);
            }
            state.activeRoutes = Object.fromEntries(allowed.filter(([id, entry]) => {
                const winner = latest.get(entry.data.routeOwnerId);
                const historical = entry.source === 'legacy' && entry.data.dispatchKey !== undefined && entry.data.dispatchKey !== dispatchKey;
                // Historical compatibility never republishes superseded active
                // routes. A latest empty/cleared route suppresses older pending
                // data in direct search/export consumers as well as the detail UI.
                if (historical && (!winner || winner[0] !== id)) return false;
                if (winner && winner[0] !== id && (winner[1].data.cleared === true || winner[1].data.destinations.length === 0) &&
                    (entry.data.cleared !== true && Array.isArray(entry.data.destinations) && entry.data.destinations.length > 0)) return false;
                return true;
            }).map(([id, entry]) => [id, entry.data.cleared === true ? { ...entry.data, destinations: [] } : entry.data]));
            renderRoutesState();
        };
        reconcileRouteOwners = () => {
            if (!current()) return;
            const nextLicenses = new Map(state.allLicenses.filter(lic => lic.type !== 'dispatch' && lic.dispatchKey === dispatchKey)
                .map(lic => [lic.id, lic]));
            const ownerIds = [...new Set([...nextLicenses.values()].map(lic => lic.routeOwnerId)
                .filter(id => typeof id === 'string' && id.trim()))].sort();
            const ownerLicenseKeys = ownerIds.map(owner => [...nextLicenses.values()].filter(lic => lic.routeOwnerId === owner)
                .map(lic => lic.id).sort()[0]);
            const nextOwners = new Set(ownerIds);
            for (const [id, entry] of companyRoutesSource) {
                if ((owners.has(entry.data.routeOwnerId) && !nextOwners.has(entry.data.routeOwnerId)) ||
                    (licenses.has(entry.data.licenseKey) && !nextLicenses.has(entry.data.licenseKey))) companyRoutesSource.delete(id);
            }
            licenses = nextLicenses;
            owners = nextOwners;
            const licenseIds = [...licenses.keys()].sort();
            const nextCompanySignature = JSON.stringify(licenseIds);
            if (nextCompanySignature !== companySignature) {
                companySignature = nextCompanySignature;
                const activeGeneration = ++companyGeneration;
                for (const unsubscribe of companyUnsubscribes) unsubscribe();
                companyUnsubscribes = [];
                companyChunks.clear();
                companyRoutesSource.clear();
                // 인증 principal/account 2개와 대상 license 조회를 고려해 8개씩 제한합니다.
                for (let start = 0; start < licenseIds.length; start += 8) {
                    const chunk = start / 8;
                    const apply = snapshot => {
                        if (!current() || companyGeneration !== activeGeneration) return;
                        const previous = companyChunks.get(chunk) || new Map();
                        const next = snapshot ? readSource(snapshot) : new Map();
                        if (!snapshot) snapshotVersion++;
                        for (const id of new Set([...previous.keys(), ...next.keys()])) companyRouteVersions.set(id, snapshotVersion);
                        companyChunks.set(chunk, next);
                        companyRoutesSource.clear();
                        for (const source of companyChunks.values()) for (const [id, entry] of source) companyRoutesSource.set(id, entry);
                        publishRoutes();
                    };
                    companyUnsubscribes.push(onSnapshot(query(collection(db, 'routes'),
                        where('dispatchKey', '==', dispatchKey), where('licenseKey', 'in', licenseIds.slice(start, start + 8))),
                    apply, () => apply(null)));
                }
            }
            const membership = [...nextLicenses.values()].map(lic => [lic.id, lic.routeOwnerId, lic.securityVersion])
                .sort((a, b) => a[0].localeCompare(b[0]));
            const signature = JSON.stringify([ownerIds, ownerLicenseKeys, membership,
                state.allLicenses.find(lic => lic.id === dispatchKey)?.membershipVersion]);
            if (signature !== ownerSignature) {
                ownerSignature = signature;
                const nextGeneration = ++generation;
                for (const unsubscribe of ownerUnsubscribes) unsubscribe();
                ownerUnsubscribes = [];
                legacyOwnerRoutesSource.clear();
                for (let start = 0; start < ownerIds.length; start += 30) {
                    const chunk = start / 30;
                    ownerUnsubscribes.push(subscribeLegacyRoutes(ownerLicenseKeys.slice(start, start + 30), snapshot => {
                        if (!current() || generation !== nextGeneration) return;
                        legacyOwnerRoutesSource.set(chunk, readSource(snapshot, 'legacy'));
                        publishRoutes();
                    }, () => {
                        if (!current() || generation !== nextGeneration) return;
                        legacyOwnerRoutesSource.delete(chunk);
                        publishRoutes();
                    }, () => snapshotVersion));
                }
            }
            publishRoutes();
        };
        routeSyncCleanup = () => {
            generation++;
            companyGeneration++;
            for (const unsubscribe of companyUnsubscribes) unsubscribe();
            companyUnsubscribes = [];
            companyChunks.clear();
            for (const unsubscribe of ownerUnsubscribes) unsubscribe();
            ownerUnsubscribes = [];
            companyRoutesSource.clear();
            legacyOwnerRoutesSource.clear();
            companyRouteVersions.clear();
        };
        state.activeRoutes = {};
        reconcileRouteOwners();
    }

    // 🌟 5. 배송 완료 실시간 동기화
    subscribeAdmin(query(collection(db, "completions"), orderBy("completedAt", "asc")), (snapshot) => {
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

        // 🌟 완료 건수 변경 시 자동할당 모달 UI 실시간 갱신
        if (document.getElementById('auto-dispatch-modal') && !document.getElementById('auto-dispatch-modal').classList.contains('hidden')) {
            if (typeof renderDispatchDriverList === 'function') renderDispatchDriverList();
            if (typeof renderDispatchDriverDetail === 'function') renderDispatchDriverDetail();
        }
    });

    // 6. 메시지 실시간 동기화
    subscribeAdmin(query(collection(db, "dispatch_messages"), orderBy("createdAt", "desc"), limit(50)), (snapshot) => {
        state.allDispatchMessages = [];
        snapshot.forEach(docSnap => { state.allDispatchMessages.push({ id: docSnap.id, ...docSnap.data() }); });
        if (typeof renderMessageFeed === 'function') renderMessageFeed(); 
        if (typeof checkDispatchInboxNotifications === 'function') checkDispatchInboxNotifications(); 
        if (typeof renderMasterNoticeHistoryList === 'function') renderMasterNoticeHistoryList();
    });

    // 7. 템플릿 실시간 동기화
    const templatesSource = isMaster ? collection(db, 'dispatch_templates') :
        query(collection(db, 'dispatch_templates'), where('dispatchKey', '==', dispatchKey));
    subscribeAdmin(templatesSource, (snapshot) => {
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
// 5. HTML 인라인 이벤트를 위한 전역 Window 객체 바인딩 (forceClearMap 포함 누락 완전 방지)
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
window.forceClearMap = forceClearMap; // 🌟 외부 모듈에서 호출 가능한 전역 바인딩 등록
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
window.openLinkDriverModal = openLinkDriverModal;
window.closeLinkDriverModal = closeLinkDriverModal;
window.confirmLinkDriver = confirmLinkDriver;
window.handleProFeature = handleProFeature;
window.closeAutoDispatchModal = closeAutoDispatchModal;
window.closeProInvoiceModal = closeProInvoiceModal;
window.closePremiumModal = closePremiumModal;
window.focusMapPosition = focusMapPosition;

// 🌟 [관제 통합 검색 (Search)]
window.closeSearchSidePanel = closeSearchSidePanel;
window.clearSearchInput = clearSearchInput;
window.jumpToDeliveryTarget = jumpToDeliveryTarget;
window.inspectDriverRoute = inspectDriverRoute;
window.viewSearchCompletionPhoto = viewSearchCompletionPhoto;
window.setSearchRangeMode = setSearchRangeMode;
window.applyCustomSearchRange = applyCustomSearchRange;
window.resetSearchToToday = resetSearchToToday;
window.handleGlobalSearch = handleGlobalSearch;

// [관제 자동할당 및 기사 배포 모듈 (Auto Dispatch)]
window.saveCompanyBaseAddress = saveCompanyBaseAddress;
window.clearCompanyBaseAddress = clearCompanyBaseAddress;
window.updateCompanyBaseUI = updateCompanyBaseUI;
window.renderDispatchDriverList = renderDispatchDriverList;
window.selectDispatchDriver = selectDispatchDriver;
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

// 🌟 [관제 인쇄(Print) - 슬림화]
window.exportToInvoiceModal = exportToInvoiceModal;
window.filterInvoicePrintList = filterInvoicePrintList;
window.handleHeaderCheckAll = handleHeaderCheckAll;
window.toggleAllInvoiceSelection = toggleAllInvoiceSelection;
window.toggleSingleInvoiceItem = toggleSingleInvoiceItem;
window.renderInvoiceOrderList = renderInvoiceOrderList;
window.previewInvoiceRow = previewInvoiceRow;
window.executeBatchPrint = executeBatchPrint;
window.initTemplatePdfDropZone = initTemplatePdfDropZone;
window.filterBySender = filterBySender;
window.sortPrintList = sortPrintList;
window.initInvoiceResizer = initInvoiceResizer;

// 🌟 [관제 서식 관리(Forms) - 신규 분리]
window.loadSavedForms = loadSavedForms;
window.setAsDefaultForm = setAsDefaultForm;
window.cancelProviderFormEdit = cancelProviderFormEdit;
window.saveProviderForm = saveProviderForm;
window.deleteSavedForm = deleteSavedForm;
window.updateLivePreview = updateLivePreview;
window.previewSavedForm = previewSavedForm;
window.toggleSelectForm = toggleSelectForm;
window.applySavedForm = applySavedForm;
window.syncPreviewData = syncPreviewData;

// 🌟 [관제 창고 피킹 리스트(Picking) - 신규 분리]
window.openPickingDriverModal = openPickingDriverModal;
window.closePickingDriverModal = closePickingDriverModal;
window.toggleAllPickingDrivers = toggleAllPickingDrivers;
window.togglePickingDriver = togglePickingDriver;
window.executePickingListPrint = executePickingListPrint;
window.printAggregatedItemList = openPickingDriverModal;

// [관제 신규 서식 빌더/에디터(Template)]
window.parsePdfToEditableDocument = parsePdfToEditableDocument;
window.renderEditableDocument = renderEditableDocument;
window.saveCurrentDocumentTemplate = saveCurrentDocumentTemplate;

// [관제 데이터 추출(Export)]
window.openExcelExportModal = openExcelExportModal;
window.closeExcelExportModal = closeExcelExportModal;
window.executeExcelExport = executeExcelExport;
