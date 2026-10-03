// js/app.js

// =================================================================
// [배송 동선 PRO] 메인 오케스트레이터 및 이벤트 컨트롤러 (네이버 내비 완벽 대응)
// =================================================================

import { calculateOptimizedRoute } from './optimizer.js';
import { saveRouteToFirestore, fetchActiveRouteOnce } from './api.js';
import { showLoading, hideLoading, initResponsiveViewport } from './utils.js';
import { geocodeAddress } from './kakao.js';
import { state, destinationIdArgument, hasValidDeliveryCoordinates } from './state.js';

// 분리된 모듈 임포트 (카카오내비 제거 후 네이버 내비 연동)
import { renderDestinationList } from './ui.js';
import { openTmap, openNaverMap, switchStartSelectViewMode } from './navigation.js';

// 서브 모듈 기능들 가져오기
import { 
    checkSavedAuth, 
    verifyLicense, 
    openTrialModal, 
    closeTrialModal, 
    startFreeTrial, 
    logout, 
    getOrCreateDeviceId,
    setRemoteRoutesHandler
} from './auth.js';

import { 
    startGpsWatcher, 
    stopGpsWatcher, 
    getDeviceRealGPS, 
    setEndLocationGPS 
} from './gps.js';

import { 
    initMemoEvents, 
    preloadBatchMemos, 
    renderMemoPreview, 
    openMemoModal, 
    closeMemoModal, 
    selectHeightTag, 
    selectTimeTag, 
    toggleEtcTag, 
    saveCurrentMemo, 
    likeMemo, 
    reportMemo,
    savePersonalMemo,
    deletePersonalMemo
} from './memo.js';

import * as deliveryModule from './delivery.js';
const { 
    completeDestination, 
    selectCompletionTag, 
    closeCompletionModal, 
    triggerPhotoCompletion, 
    confirmCompletion, 
    cancelDestination, 
    initPhotoCompletion,
    setDeliveryUpdateHandler 
} = deliveryModule;

import { 
    initCameraScan, 
    editDestinationAddress 
} from './scanner.js';

import { 
    cleanOldHistory, 
    checkUnreadNotices, 
    setRestoreDestinationHandler, 
    setGpsToggleHandler 
} from './support.js';

// ==========================================
// 0-1. 전화번호 정제 및 포맷팅 보조 함수
// ==========================================
function sanitizePhoneNumber(rawVal) {
    if (!rawVal) return "";
    let strVal = String(rawVal).trim();
    let digits = strVal.replace(/[^0-9]/g, '');

    if (digits.length < 8 || digits === '0') return "";

    if (digits.length === 11 && digits.startsWith('010')) {
        return digits.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
    }
    if (digits.length === 10) {
        if (digits.startsWith('02')) {
            return digits.replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3');
        } else {
            return digits.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
        }
    }
    return strVal;
}

// ==========================================
// 1. 앱 기동 및 라이프사이클 초기화
// ==========================================
export async function initApp() {
    initResponsiveViewport();

    localStorage.removeItem('deliveryPro_start_location'); 
    state.loadActiveData();
    cleanOldHistory();
    initSwipeButton();
    startGpsWatcher();
    checkUnreadNotices();
    initMemoEvents();
    initCameraScan();
    
    if (typeof initPhotoCompletion === 'function') {
        initPhotoCompletion();
    }

    if (typeof setDeliveryUpdateHandler === 'function') {
        setDeliveryUpdateHandler(() => {
            updateDisplayNumbers();
            const deviceId = getOrCreateDeviceId();
            const phone = localStorage.getItem('deliveryProUserPhone') || "";
            saveRouteToFirestore(deviceId, phone, state.getDestinations());
        });
    }
    
    const applyOwnedRoute = (newDestinations, routeData) => {
        if (!routeData || routeData.routeOwnerId !== state.getRouteOwnerId() ||
            !Array.isArray(newDestinations) || !Number.isFinite(routeData.updatedAt)) return;
        if (routeData.updatedAt < state.getRouteUpdatedAt()) {
            saveRouteToFirestore(getOrCreateDeviceId(), localStorage.getItem('deliveryProUserPhone') || '', state.getDestinations());
            return;
        }
        if (routeData.updatedAt === state.getRouteUpdatedAt()) return;
        state.setDestinations(newDestinations);
        const formattedList = state.getDestinations().map((d, idx) => ({
            ...d,
            displayNumber: d.displayNumber || (idx + 1),
            phone: sanitizePhoneNumber(d.phone || d.customerPhone || d.tel || d.contact || d.hp || '')
        }));
        state.setDestinations(formattedList);
        // 이전 기기/계정의 종료점을 가져오지 않습니다.
        state.setEndLocation(routeData.endLocation || { lat: 0, lng: 0, address: '' });
        const first = formattedList[0];
        state.setStartLocation(first ? { lat: first.lat, lng: first.lng, address: first.address } : null);
        state.updateDisplayNumbers(routeData.updatedAt);
        renderList();
    };
    setRemoteRoutesHandler(applyOwnedRoute);
    let pendingRouteSave = false;
    state.setActiveDataSavedHandler(() => {
        if (pendingRouteSave) return;
        pendingRouteSave = true;
        const ownerId = state.getRouteOwnerId();
        queueMicrotask(() => {
            pendingRouteSave = false;
            if (state.getRouteOwnerId() !== ownerId) return;
            saveRouteToFirestore(getOrCreateDeviceId(), localStorage.getItem('deliveryProUserPhone') || '', state.getDestinations());
        });
    });
    document.addEventListener('visibilitychange', async () => {
        const ownerId = state.getRouteOwnerId();
        if (document.visibilityState !== 'visible' || !ownerId) return;
        const route = await fetchActiveRouteOnce(getOrCreateDeviceId(), localStorage.getItem('deliveryProUserPhone') || '', ownerId);
        if (state.getRouteOwnerId() === ownerId) applyOwnedRoute(route.destinations, route);
    });

    setRestoreDestinationHandler((itemToRestore) => {
        state.addDestination(itemToRestore);
        updateDisplayNumbers();
        const deviceId = getOrCreateDeviceId();
        const phone = localStorage.getItem('deliveryProUserPhone') || "";
        saveRouteToFirestore(deviceId, phone, state.getDestinations());
    });

    setGpsToggleHandler((isChecked) => {
        if (isChecked) {
            startGpsWatcher();
        } else {
            stopGpsWatcher();
        }
    });

    renderList();
    await checkSavedAuth();
}

// ==========================================
// 2. 동선 번호(순번) 재계산 및 렌더링 연결
// ==========================================
export function updateDisplayNumbers() {
    state.updateDisplayNumbers();
    state.saveActiveData();
    renderList();
}

export function renderList() {
    renderDestinationList(preloadBatchMemos, renderMemoPreview);
}

// ==========================================
// 3. 밀어서 최적화(스와이프 버튼) 초기화
// ==========================================
function initSwipeButton() {
    const swipeContainer = document.getElementById('swipe-container');
    const swipeBtn = document.getElementById('swipe-btn');
    if (!swipeContainer || !swipeBtn) return;
    
    let isDragging = false;
    let startX = 0; 
    let btnInitialLeft = 4;
    
    function startDrag(e) {
        isDragging = true;
        startX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
        btnInitialLeft = swipeBtn.offsetLeft || 4;
        swipeBtn.style.transition = 'none';
    }
    
    function moveDrag(e) {
        if (!isDragging) return;
        
        if (e.cancelable && e.type.includes('touch')) {
            e.preventDefault();
        }

        const currentX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
        let moveX = currentX - startX;
        let newLeft = btnInitialLeft + moveX;
        let maxW = swipeContainer.offsetWidth - swipeBtn.offsetWidth - 4;
        
        if (newLeft < 4) newLeft = 4;
        if (newLeft > maxW) newLeft = maxW;
        
        swipeBtn.style.transform = `translateX(${newLeft - btnInitialLeft}px)`;
        
        if (newLeft >= maxW - 4) {
            isDragging = false;
            swipeBtn.style.transform = `translateX(0px)`;
            swipeBtn.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
            if (navigator.vibrate) navigator.vibrate(30);
            openStartSelectionModal();
        }
    }
    
    function endDrag() {
        if (!isDragging) return;
        isDragging = false;
        swipeBtn.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
        swipeBtn.style.transform = `translateX(0px)`;
    }
    
    swipeBtn.addEventListener('mousedown', startDrag);
    swipeBtn.addEventListener('touchstart', startDrag, { passive: true });
    document.addEventListener('mousemove', moveDrag);
    document.addEventListener('touchmove', moveDrag, { passive: false });
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);
}

// ==========================================
// 4. 시작 지점 선택 모달 제어 (리스트/지도 통합 연동)
// ==========================================
export function openStartSelectionModal() {
    const destinations = state.getDestinations();
    if (destinations.length === 0) { 
        alert("스캔되거나 관제에서 전송된 배송지가 최소 1곳 이상 있어야 합니다."); 
        return; 
    }
    const listEl = document.getElementById('start-select-list');
    if (!listEl) return;
    
    switchStartSelectViewMode('list', selectStartDest);

    let html = '';
    destinations.forEach(d => {
        // 상호명 추출 및 주소 정제
        let storeName = d.storeName ? String(d.storeName).trim() : "";
        let cleanAddr = (d.address || "").trim();
        const match = cleanAddr.match(/^\[(.*?)\]\s*(.*)$/);
        if (match) {
            if (!storeName) storeName = match[1].trim();
            cleanAddr = match[2].trim();
        }
        if (storeName && cleanAddr.startsWith(storeName)) {
            cleanAddr = cleanAddr.substring(storeName.length).trim();
        }

        html += `
            <button onclick="window.selectStartDest(${destinationIdArgument(d.id)})" class="w-full text-left bg-white hover:bg-slate-50 border border-slate-200 p-3.5 rounded-2xl shadow-xs transition flex items-center justify-between mb-2 active:bg-slate-100">
                <div class="flex-1 pr-2 min-w-0">
                    ${storeName ? `<span class="text-blue-600 font-extrabold text-[12px] block mb-0.5 leading-none">🏢 ${storeName}</span>` : ''}
                    <span class="font-bold text-slate-900 text-[13.5px] break-keep block leading-snug">${cleanAddr}</span>
                </div>
                <i class="fa-solid fa-chevron-right text-slate-300 text-xs shrink-0 ml-1"></i>
            </button>
        `;
    });
    listEl.innerHTML = html;
    document.getElementById('start-select-modal')?.classList.remove('hidden');
}

export function closeStartModal() { 
    document.getElementById('start-select-modal')?.classList.add('hidden'); 
}

export function selectStartDest(id) {
    closeStartModal();
    const destinations = state.getDestinations();
    const idx = destinations.findIndex(d => d.id === id);
    if (idx > -1) {
        if (!hasValidDeliveryCoordinates(destinations[idx])) {
            alert('주소를 수정하여 위치를 확인한 후 시작점으로 선택해 주세요.');
            return;
        }
        const chosen = destinations.splice(idx, 1)[0];
        destinations.unshift(chosen);
        state.setDestinations(destinations);
        state.setStartLocation({ lat: chosen.lat, lng: chosen.lng, address: chosen.address });
        state.saveActiveData();
        optimizeRouteAction();
    }
}

export function handleStartSelectTab(mode) {
    switchStartSelectViewMode(mode, selectStartDest);
}

// ==========================================
// 5. 동선 최적화 알고리즘 실행
// ==========================================
export function optimizeRouteAction() {
    let destinations = state.getDestinations();
    const startLocation = state.getStartLocation();
    const endLocation = state.getEndLocation();

    if (destinations.length < 2) { 
        alert("출발지를 포함하여 최소 2곳의 배송지가 필요합니다."); 
        return; 
    }
    if (!startLocation || !startLocation.lat) { 
        alert("시작 지점을 먼저 선택해 주십시오."); 
        return; 
    }
    
    showLoading("최적화중...");
    
    setTimeout(() => {
        try {
            const routeDestinations = destinations.filter(hasValidDeliveryCoordinates);
            const pendingDestinations = destinations.filter(d => !hasValidDeliveryCoordinates(d));
            if (!hasValidDeliveryCoordinates(startLocation) || !hasValidDeliveryCoordinates(destinations[0])) {
                throw new Error('시작점의 주소를 수정하여 위치를 확인해 주세요.');
            }
            if (routeDestinations.length < 2) throw new Error('위치가 확인된 배송지가 최소 2곳 필요합니다.');
            destinations = calculateOptimizedRoute(routeDestinations, startLocation,
                hasValidDeliveryCoordinates(endLocation) ? endLocation : null).concat(pendingDestinations);
            state.setDestinations(destinations);
            updateDisplayNumbers();
            hideLoading();
            if (pendingDestinations.length) alert(`위치 확인이 필요한 배송지 ${pendingDestinations.length}건은 최적화에서 제외하고 목록 끝에 유지했습니다. 주소를 수정해 주세요.`);
            
            const deviceId = getOrCreateDeviceId();
            const phone = localStorage.getItem('deliveryProUserPhone') || "";
            saveRouteToFirestore(deviceId, phone, destinations);
            
            setTimeout(() => { 
                const mainContainer = document.querySelector('main'); 
                if (mainContainer) mainContainer.scrollTo({ top: 0, behavior: 'smooth' }); 
            }, 100);
        } catch (error) {
            hideLoading();
            alert(error.message);
        }
    }, 500);
}

// ==========================================
// 6. 버튼식 위치 이동 (위로 / 아래로 순서 변경)
// ==========================================
export function moveDestinationUp(id) {
    const destinations = state.getDestinations();
    const idx = destinations.findIndex(d => d.id === id);
    if (idx <= 0) return; 

    const temp = destinations[idx];
    destinations[idx] = destinations[idx - 1];
    destinations[idx - 1] = temp;

    if (state.getStartLocation() && destinations[0]) {
        state.setStartLocation({
            lat: destinations[0].lat,
            lng: destinations[0].lng,
            address: destinations[0].address
        });
    }

    state.setDestinations(destinations);
    state.saveActiveData();
    updateDisplayNumbers();

    const deviceId = getOrCreateDeviceId();
    const phone = localStorage.getItem('deliveryProUserPhone') || "";
    saveRouteToFirestore(deviceId, phone, destinations);

    if (navigator.vibrate) navigator.vibrate(12);
}

export function moveDestinationDown(id) {
    const destinations = state.getDestinations();
    const idx = destinations.findIndex(d => d.id === id);
    if (idx === -1 || idx >= destinations.length - 1) return; 

    const temp = destinations[idx];
    destinations[idx] = destinations[idx + 1];
    destinations[idx + 1] = temp;

    if (state.getStartLocation() && destinations[0]) {
        state.setStartLocation({
            lat: destinations[0].lat,
            lng: destinations[0].lng,
            address: destinations[0].address
        });
    }

    state.setDestinations(destinations);
    state.saveActiveData();
    updateDisplayNumbers();

    const deviceId = getOrCreateDeviceId();
    const phone = localStorage.getItem('deliveryProUserPhone') || "";
    saveRouteToFirestore(deviceId, phone, destinations);

    if (navigator.vibrate) navigator.vibrate(12);
}

// ==========================================
// 7. 주소 복사 (클립보드 - 상호명 제외) 및 종료지 제어
// ==========================================
export function copyAddressModal() {
    const addrInput = document.getElementById('manual-address-input');
    if (!addrInput) return;
    
    let rawAddress = addrInput.value.trim();
    if (!rawAddress) {
        alert("복사할 주소가 없습니다.");
        return;
    }
    
    let cleanAddress = rawAddress.replace(/^\[.*?\]\s*/, '').trim();
    
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(cleanAddress).then(() => {
            alert("주소가 복사되었습니다:\n" + cleanAddress);
        }).catch(() => fallbackCopyTextToClipboard(cleanAddress));
    } else {
        fallbackCopyTextToClipboard(cleanAddress);
    }
}

function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    document.body.appendChild(textArea);
    textArea.select();
    try {
        document.execCommand('copy');
        alert("주소가 복사되었습니다:\n" + text);
    } catch (err) {
        alert("주소 복사에 실패했습니다.");
    }
    document.body.removeChild(textArea);
}

export function toggleHeaderEndEdit() { 
    document.getElementById('header-end-edit-area')?.classList.toggle('hidden'); 
}

export async function applyHeaderCustomEnd() {
    const addr = (document.getElementById('header-inline-end-input')?.value || '').trim();
    if (!addr) {
        state.setEndLocation({ lat: 0, lng: 0, address: "" });
        state.saveActiveData(); 
        renderList(); 
        toggleHeaderEndEdit(); 
        return;
    }
    showLoading("종료 위치 찾는 중...");
    try {
        const coords = await geocodeAddress(addr);
        if (coords) {
            state.setEndLocation({ 
                lat: coords.lat, 
                lng: coords.lng, 
                address: coords.address_name || addr 
            });
            state.saveActiveData(); 
            renderList(); 
            toggleHeaderEndEdit();
        }
    } catch (error) { 
        alert("종료지 주소를 찾을 수 없습니다."); 
    } finally { 
        hideLoading(); 
    }
}

// ==========================================
// 8. Window 전역 객체 바인딩 (HTML 인라인 이벤트 호환)
// ==========================================
window.logout = logout;
window.renderList = renderList;
window.updateDisplayNumbers = updateDisplayNumbers;
window.verifyLicense = verifyLicense;
window.openTrialModal = openTrialModal;
window.closeTrialModal = closeTrialModal;
window.startFreeTrial = startFreeTrial;
window.setEndLocationGPS = setEndLocationGPS;
window.toggleHeaderEndEdit = toggleHeaderEndEdit;
window.applyHeaderCustomEnd = applyHeaderCustomEnd;
window.openMemoModal = openMemoModal;
window.closeMemoModal = closeMemoModal;
window.saveCurrentMemo = saveCurrentMemo;
window.likeMemo = likeMemo;
window.reportMemo = reportMemo;
window.savePersonalMemo = savePersonalMemo;
window.deletePersonalMemo = deletePersonalMemo;

window.cancelDestination = cancelDestination;
window.completeDestination = completeDestination;
window.selectCompletionTag = selectCompletionTag;
window.closeCompletionModal = closeCompletionModal;
window.triggerPhotoCompletion = triggerPhotoCompletion;
window.confirmCompletion = confirmCompletion;
window.initPhotoCompletion = initPhotoCompletion;

window.editDestinationAddress = editDestinationAddress;
window.openTmap = openTmap;
window.openNaverMap = openNaverMap;
// 구버전 인라인 HTML 호환용 폴백 바인딩
window.openKakaoNaviDirect = openNaverMap;

window.closeStartModal = closeStartModal;
window.selectStartDest = selectStartDest;
window.optimizeRoute = optimizeRouteAction;
window.selectHeightTag = selectHeightTag;
window.selectTimeTag = selectTimeTag;
window.toggleEtcTag = toggleEtcTag;

window.moveDestinationUp = moveDestinationUp;
window.moveDestinationDown = moveDestinationDown;

window.handleStartSelectTab = handleStartSelectTab;
window.copyAddressModal = copyAddressModal;

window.appActions = {
    initApp, 
    optimizeRouteAction, 
    getDeviceRealGPS, 
    renderList,
    updateDisplayNumbers,
    moveDestinationUp,
    moveDestinationDown
};
