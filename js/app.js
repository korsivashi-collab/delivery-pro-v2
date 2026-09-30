// js/app.js

// =================================================================
// [배송 동선 PRO] 메인 오케스트레이터 및 이벤트 컨트롤러 (모듈화 완료 버전)
// =================================================================

import { calculateOptimizedRoute } from './optimizer.js';
import { saveRouteToFirestore, fetchActiveRouteOnce } from './api.js';
import { showLoading, hideLoading, initResponsiveViewport } from './utils.js';
import { geocodeAddress } from './kakao.js';
import { state } from './state.js';

// 분리된 모듈 임포트
import { renderDestinationList } from './ui.js';
import { openTmap, openKakaoNaviDirect, switchStartSelectViewMode } from './navigation.js';

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
    
    setRemoteRoutesHandler((newDestinations, routeData) => {
        if (!newDestinations || !Array.isArray(newDestinations)) return;

        const history = JSON.parse(localStorage.getItem('deliveryPro_history') || '[]');
        const todayStart = new Date().setHours(0, 0, 0, 0);
        const completedIdsOrAddrs = new Set();
        history.forEach(h => {
            if (h.timestamp >= todayStart) {
                if (h.id) completedIdsOrAddrs.add(String(h.id));
                if (h.orderNo) completedIdsOrAddrs.add(String(h.orderNo));
                if (h.address) completedIdsOrAddrs.add(h.address.trim());
            }
        });

        const formattedList = newDestinations
            .filter(d => {
                if (d.id && completedIdsOrAddrs.has(String(d.id))) return false;
                if (d.orderNo && completedIdsOrAddrs.has(String(d.orderNo))) return false;
                return true;
            })
            .map((d, idx) => {
                const rawPhone = d.phone || d.customerPhone || d.tel || d.contact || d.hp || "";
                const validPhone = sanitizePhoneNumber(rawPhone);

                return {
                    id: d.id || (Date.now() + idx),
                    displayNumber: d.displayNumber || (idx + 1),
                    address: d.address || "",
                    lat: typeof d.lat === 'number' ? d.lat : (parseFloat(d.lat) || 0),
                    lng: typeof d.lng === 'number' ? d.lng : (parseFloat(d.lng) || 0),
                    phone: validPhone,
                    storeName: d.storeName || "",
                    orderNo: d.orderNo || "",
                    memo: d.memo || "",
                    items: d.items || []
                };
            });

        if (formattedList.length > 0 && (!state.getStartLocation() || !state.getStartLocation().lat)) {
            state.setStartLocation({
                lat: formattedList[0].lat,
                lng: formattedList[0].lng,
                address: formattedList[0].address
            });
        }

        if (formattedList.length > 0) {
            sessionStorage.setItem('deliveryPro_has_dispatch_route', 'true');
            state.setDestinations(formattedList);
            state.updateDisplayNumbers();
            state.saveActiveData();
            renderList();

            if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
        }
    }, () => {
        const hadDispatchRoute = sessionStorage.getItem('deliveryPro_has_dispatch_route') === 'true';
        if (hadDispatchRoute) {
            sessionStorage.removeItem('deliveryPro_has_dispatch_route');
            state.setDestinations([]);
            state.setStartLocation(null);
            state.saveActiveData();
            renderList();
        }
    });

    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
            const deviceId = getOrCreateDeviceId();
            const phone = localStorage.getItem('deliveryProUserPhone') || "";
            if ((deviceId || phone) && typeof fetchActiveRouteOnce === 'function') {
                try {
                    const latestRoute = await fetchActiveRouteOnce(deviceId, phone);
                    if (latestRoute && Array.isArray(latestRoute.destinations) && latestRoute.destinations.length > 0) {
                        const firstItem = latestRoute.destinations[0];
                        if (typeof firstItem === 'object' && firstItem !== null && firstItem.address) {
                            sessionStorage.setItem('deliveryPro_has_dispatch_route', 'true');
                            state.setDestinations(latestRoute.destinations);
                            state.updateDisplayNumbers();
                            state.saveActiveData();
                            renderList();
                        }
                    }
                } catch (err) {
                    console.warn("포그라운드 복귀 동선 동기화 확인 대기:", err);
                }
            }
        }
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
        const fmt = d.address;
        html += `
            <button onclick="window.selectStartDest(${d.id})" class="w-full text-left bg-white hover:bg-gray-50 border border-gray-200 p-4 rounded-xl shadow-sm transition flex items-center justify-between mb-2 active:bg-gray-100">
                <span class="font-bold text-gray-800 text-[14px] break-keep flex-1 pr-2"><i class="fa-solid fa-location-dot text-gray-400 mr-2"></i>${fmt}</span>
                <i class="fa-solid fa-check text-gray-300"></i>
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
            destinations = calculateOptimizedRoute(destinations, startLocation, endLocation);
            state.setDestinations(destinations);
            updateDisplayNumbers();
            hideLoading();
            
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
window.openKakaoNaviDirect = openKakaoNaviDirect;
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