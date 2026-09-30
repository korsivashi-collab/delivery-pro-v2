// js/app.js

// =================================================================
// [배송 동선 PRO] 메인 오케스트레이터 및 이벤트 컨트롤러 (2중 데이터 유실 방어 탑재)
// =================================================================

import { calculateOptimizedRoute } from './optimizer.js';
import { saveRouteToFirestore, fetchActiveRouteOnce } from './api.js';
import { showLoading, hideLoading, initResponsiveViewport } from './utils.js';
import { geocodeAddress } from './kakao.js';
import { state } from './state.js';

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

// delivery.js 네임스페이스 및 핸들러 안전 임포트 (순환 참조 방어)
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
// 0-2. 상호명 분리 및 주소 원본 보존 헬퍼 (주소 절삭 방지)
// ==========================================
function formatDisplayAddress(rawAddress, storeName = "") {
    let extractedStore = storeName ? String(storeName).trim() : "";
    let cleanAddr = (rawAddress || "").trim();

    const match = cleanAddr.match(/^\[(.*?)\]\s*(.*)$/);
    if (match) {
        if (!extractedStore) extractedStore = match[1].trim();
        cleanAddr = match[2].trim();
    }

    if (extractedStore && cleanAddr.startsWith(extractedStore)) {
        cleanAddr = cleanAddr.substring(extractedStore.length).trim();
    }

    return {
        storeName: extractedStore,
        cleanAddr: cleanAddr,
        fullAddr: cleanAddr
    };
}

// ==========================================
// 0-3. 거리 계산 (위경도 기반 실거리 산출)
// ==========================================
function calculateDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
    const R = 6371; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + 
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDistance(distKm) {
    if (distKm < 1) return Math.round(distKm * 1000) + "m";
    return distKm.toFixed(1) + "km";
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
// 2. 동선 번호(순번) 재계산 및 렌더링
// ==========================================
export function updateDisplayNumbers() {
    state.updateDisplayNumbers();
    state.saveActiveData();
    renderList();
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
// 4. 출발지 선택 모달 제어
// ==========================================
export function openStartSelectionModal() {
    const destinations = state.getDestinations();
    if (destinations.length === 0) { 
        alert("스캔되거나 관제에서 전송된 배송지가 최소 1곳 이상 있어야 합니다."); 
        return; 
    }
    const listEl = document.getElementById('start-select-list');
    if (!listEl) return;
    
    let html = '';
    destinations.forEach(d => {
        const fmt = formatDisplayAddress(d.address, d.storeName);
        const title = fmt.storeName ? `[${fmt.storeName}] ${fmt.cleanAddr}` : fmt.cleanAddr;
        html += `
            <button onclick="selectStartDest(${d.id})" class="w-full text-left bg-white hover:bg-gray-50 border border-gray-200 p-4 rounded-xl shadow-sm transition flex items-center justify-between mb-2 active:bg-gray-100">
                <span class="font-bold text-gray-800 text-[14px] break-keep flex-1 pr-2"><i class="fa-solid fa-location-dot text-gray-400 mr-2"></i>${title}</span>
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
// 7. 배송 목록 메인 렌더링
// ==========================================
export function renderList() {
    const listEl = document.getElementById('destination-list');
    const headerEndAddr = document.getElementById('header-end-address'); 
    const headerEndInput = document.getElementById('header-inline-end-input');
    const endLocation = state.getEndLocation();
    const destinations = state.getDestinations();
    const startLocation = state.getStartLocation();
    const lastGps = state.getLastKnownGps();
    
    // 리스트와 함께 지도도 갱신 필요시 자동 갱신
    if (document.getElementById('map-view-container') && !document.getElementById('map-view-container').classList.contains('hidden')) {
        renderMapView();
    }

    if (headerEndAddr) {
        headerEndAddr.innerText = endLocation.address || '설정 안 함';
        if (!endLocation.address) { 
            headerEndAddr.classList.add('text-red-400'); 
            headerEndAddr.classList.remove('text-red-700'); 
        } else { 
            headerEndAddr.classList.remove('text-red-400'); 
            headerEndAddr.classList.add('text-red-700'); 
        }
    }
    if (headerEndInput) headerEndInput.value = endLocation.address || '';

    if (destinations.length === 0) {
        if (listEl) {
            listEl.innerHTML = `
                <li id="empty-state" class="text-center text-gray-400 py-16 border-2 border-dashed border-gray-200 rounded-2xl my-2 bg-gray-50/50">
                    <i class="fa-solid fa-receipt text-5xl mb-3 text-gray-300"></i>
                    <p class="font-bold text-xs text-gray-500 leading-relaxed">주소지를 스캔하거나 관제에서 전송되면<br>동선이 생성됩니다.</p>
                </li>`;
        }
        return;
    }

    if (listEl) {
        listEl.innerHTML = ''; 
        destinations.forEach((dest, index) => {
            const li = document.createElement('li'); 
            li.setAttribute('data-id', dest.id); 
            if (dest.orderNo) li.setAttribute('data-orderno', dest.orderNo);
            li.className = "bg-white p-3 rounded-2xl shadow-xs border border-gray-200 flex flex-col gap-2";
            
            let numberBadge = index === 0 && (startLocation && startLocation.lat) ? 
                `<div class="bg-indigo-600 text-white font-black w-6 h-6 rounded-full flex items-center justify-center text-[11px] shadow-sm shrink-0 ring-2 ring-indigo-200"><i class="fa-solid fa-flag text-[10px]"></i></div>` : 
                `<div class="bg-blue-600 text-white font-black w-6 h-6 rounded-full flex items-center justify-center text-[11px] shadow-sm shrink-0">${dest.displayNumber}</div>`;
            
            let customerPhoneStr = sanitizePhoneNumber(dest.phone || ""); 
            let dynamicTextSize = "text-[12px]"; 
            if (customerPhoneStr.length >= 13) dynamicTextSize = "text-[10.5px]"; 
            else if (customerPhoneStr.length >= 11) dynamicTextSize = "text-[11px]"; 
            else if (customerPhoneStr.length >= 9) dynamicTextSize = "text-[11.5px]";

            const formatted = formatDisplayAddress(dest.address, dest.storeName);
            let displayAddressHTML = "";
            
            if (formatted.storeName) {
                displayAddressHTML = `
                    <span class="text-blue-600 block text-[12px] mb-0.5 leading-none font-bold">🏢 ${formatted.storeName}</span>
                    <span class="block leading-snug text-gray-900 break-keep font-extrabold text-[14px]">${formatted.cleanAddr}</span>
                `;
            } else {
                displayAddressHTML = `<span class="block leading-snug text-gray-900 break-keep font-extrabold text-[14px]">${formatted.cleanAddr}</span>`;
            }

            // 🌟 [현재 위치와의 거리 계산]
            let distHtml = "";
            if (lastGps && lastGps.lat && lastGps.lng && dest.lat && dest.lng) {
                const dist = calculateDistance(lastGps.lat, lastGps.lng, dest.lat, dest.lng);
                distHtml = `<span class="text-[10px] text-blue-500 font-bold bg-blue-50 px-1.5 py-0.5 rounded shadow-2xs whitespace-nowrap border border-blue-100 flex items-center h-[22px]"><i class="fa-solid fa-location-arrow mr-0.5"></i>${formatDistance(dist)}</span>`;
            }

            let navTargetName = (formatted.storeName || formatted.cleanAddr || dest.address).replace(/['"]/g, '');
            const isFirst = index === 0;
            const isLast = index === destinations.length - 1;

            li.innerHTML = `
                <div class="flex items-start gap-1.5 pb-0.5 mt-0.5">
                    <div class="flex flex-col items-center justify-center gap-1 shrink-0 -ml-0.5 mr-0.5 mt-0.5">
                        <button onclick="moveDestinationUp(${dest.id})" ${isFirst ? 'disabled' : ''} class="w-6 h-[20px] flex items-center justify-center rounded bg-gray-50 hover:bg-gray-100 active:bg-gray-200 border border-gray-200 text-gray-600 disabled:opacity-15 disabled:pointer-events-none transition shadow-2xs" title="위로 이동">
                            <i class="fa-solid fa-chevron-up text-[10px]"></i>
                        </button>
                        <button onclick="moveDestinationDown(${dest.id})" ${isLast ? 'disabled' : ''} class="w-6 h-[20px] flex items-center justify-center rounded bg-gray-50 hover:bg-gray-100 active:bg-gray-200 border border-gray-200 text-gray-600 disabled:opacity-15 disabled:pointer-events-none transition shadow-2xs" title="아래로 이동">
                            <i class="fa-solid fa-chevron-down text-[10px]"></i>
                        </button>
                    </div>
                    ${numberBadge}
                    <div class="font-bold text-gray-900 flex-1 ml-1 min-w-0 flex flex-col justify-center">
                        ${displayAddressHTML}
                    </div>
                    
                    <!-- 🌟 거리 표시 및 주소 수정 버튼 우측 배치 -->
                    <div class="flex items-center gap-1 shrink-0 -mr-1">
                        ${distHtml}
                        <button onclick="editDestinationAddress(${dest.id})" class="text-gray-400 hover:text-blue-500 w-8 h-8 flex items-center justify-center shrink-0 rounded-lg active:bg-gray-100 transition" title="주소 수정"><i class="fa-solid fa-pen text-[14px]"></i></button>
                    </div>
                </div>
                
                <div id="memo-tags-${dest.id}" class="hidden flex flex-wrap gap-1 mb-0.5 mt-0.5"></div>
                <div id="memo-preview-${dest.id}" class="hidden bg-gray-50 rounded-lg p-2 text-[11.5px] text-gray-800 border border-gray-100 truncate shadow-2xs mb-0.5 mt-0.5"></div>
                <div id="personal-memo-preview-${dest.id}" class="hidden bg-emerald-50 rounded-lg p-2 text-[11.5px] text-emerald-950 border border-emerald-200 truncate shadow-2xs mb-1 mt-0.5"></div>
                
                <div class="flex flex-col gap-1.5 mt-0.5 pt-2 border-t border-gray-100">
                    <div class="flex gap-1.5 h-[42px]">
                        ${customerPhoneStr ? `<a href="tel:${customerPhoneStr}" class="flex-none w-[106px] bg-green-50 text-green-700 border border-green-200 rounded-xl shadow-2xs flex items-center justify-center active:bg-green-100 transition px-1.5 phone-number-box"><i class="fa-solid fa-phone mr-1 text-[11px] shrink-0"></i><span class="${dynamicTextSize} font-black tracking-tight whitespace-nowrap">${customerPhoneStr}</span></a>` : `<div class="flex-none w-[106px] bg-gray-50 text-gray-400 border border-gray-100 rounded-xl shadow-2xs flex items-center justify-center px-1.5"><i class="fa-solid fa-phone-slash mr-1 text-[11px] shrink-0"></i><span class="text-[10.5px] font-bold whitespace-nowrap">번호 없음</span></div>`}
                        <a href="sms:${customerPhoneStr}" class="flex-1 min-w-0 bg-sky-50 text-sky-600 border border-sky-200 rounded-xl shadow-2xs flex items-center justify-center gap-1 active:bg-sky-100 transition flex-nowrap ${!customerPhoneStr ? 'opacity-30 pointer-events-none' : ''}"><i class="fa-solid fa-comment-sms text-[13px] shrink-0"></i><span class="text-[12.5px] font-black whitespace-nowrap tracking-tight">문자</span></a>
                        <button onclick="openMemoModal(${dest.id})" class="flex-1 min-w-0 bg-yellow-50 text-yellow-600 border border-yellow-200 rounded-xl shadow-2xs flex items-center justify-center gap-1 active:bg-yellow-100 transition flex-nowrap"><i class="fa-solid fa-pen-to-square text-[13px] shrink-0"></i><span class="text-[12.5px] font-black whitespace-nowrap tracking-tight">메모</span></button>
                        <button onclick="completeDestination(${dest.id})" class="flex-1 min-w-0 bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-xl shadow-2xs flex items-center justify-center gap-1 active:bg-emerald-100 transition flex-nowrap"><i class="fa-solid fa-check text-[14px] shrink-0"></i><span class="text-[12.5px] font-black whitespace-nowrap tracking-tight">완료</span></button>
                    </div>
                    <div class="flex gap-1.5 h-[38px]">
                        <div class="flex-1 min-w-0 bg-gray-50 border border-gray-200 p-1 rounded-xl flex items-center gap-1.5 shadow-2xs">
                            <span class="text-[11.5px] font-black text-gray-500 px-1.5 shrink-0 whitespace-nowrap leading-none tracking-tight">길찾기</span>
                            <div class="w-px h-4 bg-gray-300 shrink-0"></div>
                            <div class="flex-1 grid grid-cols-2 gap-1 h-full">
                                <button onclick="openTmap(${dest.lat}, ${dest.lng}, '${navTargetName}')" class="bg-black text-white text-[11.5px] font-bold rounded-lg active:opacity-80 flex items-center justify-center gap-1 shadow-2xs h-full whitespace-nowrap tracking-tight"><i class="fa-solid fa-map-location-dot text-[11px] shrink-0"></i> 티맵</button>
                                <button onclick="openKakaoNaviDirect(${dest.lat}, ${dest.lng}, '${navTargetName}')" class="bg-[#FEE500] text-black text-[11.5px] font-bold rounded-lg border border-yellow-400 active:bg-yellow-400 flex items-center justify-center gap-1 shadow-2xs h-full whitespace-nowrap tracking-tight"><i class="fa-solid fa-location-arrow text-[11px] shrink-0"></i> 카카오</button>
                            </div>
                        </div>
                        <button onclick="cancelDestination(${dest.id})" class="w-[44px] shrink-0 bg-red-50 text-red-500 border border-red-200 rounded-xl shadow-2xs flex items-center justify-center active:bg-red-100 transition" title="배송 취소"><i class="fa-solid fa-trash-can text-[14px] shrink-0"></i></button>
                    </div>
                </div>`;
            listEl.appendChild(li);
        });
    }
    
    preloadBatchMemos().then(() => {
        destinations.forEach(dest => {
            renderMemoPreview(dest);
        });
    });
}

// ==========================================
// 8. 🌟 주소 복사 (클립보드 - 상호명 제외) 및 입력 제어
// ==========================================
export function copyAddressModal() {
    const addrInput = document.getElementById('manual-address-input');
    if (!addrInput) return;
    
    let rawAddress = addrInput.value.trim();
    if (!rawAddress) {
        alert("복사할 주소가 없습니다.");
        return;
    }
    
    // [상호명] 제거 처리
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
// 9. 외부 내비게이션(티맵 / 카카오내비) 연동
// ==========================================
export function openTmap(lat, lng, name) { 
    window.location.href = `tmap://route?goalname=${encodeURIComponent(name)}&goalx=${lng}&goaly=${lat}`; 
}

export function openKakaoNaviDirect(lat, lng, name) { 
    if (!lat || !lng) {
        alert("목적지 좌표가 유효하지 않습니다.");
        return;
    }

    const cleanName = (name || '목적지')
        .replace(/[^\w\s가-힣0-9.-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || '목적지';

    const targetName = encodeURIComponent(cleanName);
    const kakaoKey = "893c5c6ec8613974d84fa75fd6d0be11"; 

    const naviParams = `name=${targetName}&x=${lng}&y=${lat}&coord_type=wgs84&appkey=${kakaoKey}&apiver=1.0`;
    const isAndroid = /Android/i.test(navigator.userAgent);
    if (isAndroid) {
        window.location.href = `intent://navigate?${naviParams}#Intent;scheme=kakaonavi;package=com.locnall.KimGiSa;end`;
    } else {
        window.location.href = `kakaonavi://navigate?${naviParams}`;
    }
}

// ==========================================
// 10. 🌟 카카오 지도 모드 API 로딩 및 제어 엔진
// ==========================================
let mapInstance = null;
let mapMarkers = [];
let mapPolylines = [];
let isMapSdkLoaded = false;

async function loadKakaoMapSdk() {
    return new Promise((resolve) => {
        if (window.kakao && window.kakao.maps) {
            isMapSdkLoaded = true;
            resolve();
            return;
        }
        const KAKAO_KEY = "893c5c6ec8613974d84fa75fd6d0be11"; 
        const script = document.createElement('script');
        script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_KEY}&autoload=false`;
        script.onload = () => {
            kakao.maps.load(() => {
                isMapSdkLoaded = true;
                resolve();
            });
        };
        script.onerror = () => {
            alert("지도 스크립트를 불러오는데 실패했습니다. 네트워크를 확인해주세요.");
            resolve();
        }
        document.head.appendChild(script);
    });
}

export async function switchViewMode(mode) {
    const listContainer = document.getElementById('destination-list');
    const mapContainer = document.getElementById('map-view-container');
    const tabList = document.getElementById('tab-list-view');
    const tabMap = document.getElementById('tab-map-view');
    
    if (mode === 'map') {
        if (listContainer) listContainer.classList.add('hidden');
        if (mapContainer) {
            mapContainer.classList.remove('hidden');
            mapContainer.classList.add('flex');
        }
        
        if (tabList) tabList.className = "px-4 py-1.5 rounded-lg text-gray-500 hover:text-gray-700 transition";
        if (tabMap) tabMap.className = "px-4 py-1.5 rounded-lg bg-white shadow text-blue-600 transition font-bold";
        
        showLoading("지도 준비 중...");
        await loadKakaoMapSdk();
        hideLoading();
        
        // 브라우저 렌더링 딜레이 후 맵 크기 재계산
        setTimeout(() => {
            if (mapInstance) mapInstance.relayout();
            renderMapView();
        }, 100);
        
    } else {
        if (listContainer) listContainer.classList.remove('hidden');
        if (mapContainer) {
            mapContainer.classList.add('hidden');
            mapContainer.classList.remove('flex');
        }
        
        if (tabList) tabList.className = "px-4 py-1.5 rounded-lg bg-white shadow text-blue-600 transition font-bold";
        if (tabMap) tabMap.className = "px-4 py-1.5 rounded-lg text-gray-500 hover:text-gray-700 transition";
    }
}

export function renderMapView() {
    if (!isMapSdkLoaded || !window.kakao || !window.kakao.maps) return;
    const container = document.getElementById('kakao-map');
    if (!container) return;
    
    const destinations = state.getDestinations();
    const startLoc = state.getStartLocation();
    const endLoc = state.getEndLocation();
    
    if (!mapInstance) {
        let centerLat = destinations.length > 0 ? destinations[0].lat : 37.566826;
        let centerLng = destinations.length > 0 ? destinations[0].lng : 126.9786567;
        
        const lastGps = state.getLastKnownGps();
        if (lastGps && lastGps.lat) { 
            centerLat = lastGps.lat; 
            centerLng = lastGps.lng; 
        }
        
        const options = {
            center: new kakao.maps.LatLng(centerLat, centerLng),
            level: 5
        };
        mapInstance = new kakao.maps.Map(container, options);
    }
    
    // 기존 마커 및 경로 라인 클리어
    mapMarkers.forEach(m => m.setMap(null));
    mapMarkers = [];
    mapPolylines.forEach(p => p.setMap(null));
    mapPolylines = [];
    
    if (destinations.length === 0) return;
    
    const bounds = new kakao.maps.LatLngBounds();
    const linePath = [];
    
    destinations.forEach((dest, index) => {
        const pos = new kakao.maps.LatLng(dest.lat, dest.lng);
        bounds.extend(pos);
        linePath.push(pos);
        
        const isStart = index === 0 && (startLoc && startLoc.lat);
        const displayNum = isStart ? '<i class="fa-solid fa-flag text-xs"></i>' : dest.displayNumber;
        const badgeColor = isStart ? 'bg-indigo-600' : 'bg-blue-600';
        
        const fmt = formatDisplayAddress(dest.address, dest.storeName);
        const shortName = fmt.storeName || (fmt.cleanAddr.length > 8 ? fmt.cleanAddr.substring(0, 8) + '...' : fmt.cleanAddr);
        
        // CSS 기반의 커스텀 오버레이 마커 디자인
        const content = `
            <div class="relative flex flex-col items-center justify-center translate-y-[-100%] pb-1">
                <div class="${badgeColor} text-white font-black w-7 h-7 rounded-full flex items-center justify-center text-[12px] shadow-md ring-2 ring-white z-10">
                    ${displayNum}
                </div>
                <div class="w-1.5 h-1.5 bg-gray-800 rotate-45 -mt-1 shadow-sm z-0"></div>
                <div class="bg-white/95 px-2 py-0.5 rounded shadow text-[10px] font-bold text-gray-800 mt-0.5 whitespace-nowrap border border-gray-200">
                    ${shortName}
                </div>
            </div>
        `;
        
        const customOverlay = new kakao.maps.CustomOverlay({
            position: pos,
            content: content,
            yAnchor: 1
        });
        
        customOverlay.setMap(mapInstance);
        mapMarkers.push(customOverlay);
    });
    
    // 종료 위치 핑 추가
    if (endLoc && endLoc.lat && endLoc.address) {
        const pos = new kakao.maps.LatLng(endLoc.lat, endLoc.lng);
        bounds.extend(pos);
        linePath.push(pos);
        
        const content = `
            <div class="relative flex flex-col items-center justify-center translate-y-[-100%] pb-1">
                <div class="bg-red-600 text-white font-black w-7 h-7 rounded-full flex items-center justify-center text-[11px] shadow-md ring-2 ring-white z-10">
                    도착
                </div>
                <div class="w-1.5 h-1.5 bg-gray-800 rotate-45 -mt-1 shadow-sm z-0"></div>
            </div>
        `;
        const customOverlay = new kakao.maps.CustomOverlay({
            position: pos,
            content: content,
            yAnchor: 1
        });
        customOverlay.setMap(mapInstance);
        mapMarkers.push(customOverlay);
    }
    
    // 동선 연결 점선 드로잉
    if (linePath.length > 1) {
        const polyline = new kakao.maps.Polyline({
            path: linePath,
            strokeWeight: 4,
            strokeColor: '#3b82f6',
            strokeOpacity: 0.8,
            strokeStyle: 'shortdash'
        });
        polyline.setMap(mapInstance);
        mapPolylines.push(polyline);
    }
    
    // 화면에 모든 마커가 보이도록 지도 바운드 및 패딩 자동 조절
    mapInstance.setBounds(bounds, 50, 50, 50, 50);
}

export function moveToCurrentLocationOnMap() {
    if (!mapInstance) return;
    const lastGps = state.getLastKnownGps();
    if (lastGps && lastGps.lat) {
        const locPosition = new kakao.maps.LatLng(lastGps.lat, lastGps.lng);
        mapInstance.panTo(locPosition);
    } else {
        alert('현재 위치 정보를 파악할 수 없습니다. GPS 설정 등을 확인해 주세요.');
    }
}


// ==========================================
// 11. Window 전역 객체 바인딩 (HTML 인라인 이벤트 호환)
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

// 🌟 신규 기능 전역 노출
window.copyAddressModal = copyAddressModal;
window.switchViewMode = switchViewMode;
window.moveToCurrentLocationOnMap = moveToCurrentLocationOnMap;

window.appActions = {
    initApp, 
    optimizeRouteAction, 
    getDeviceRealGPS, 
    renderList,
    updateDisplayNumbers,
    moveDestinationUp,
    moveDestinationDown,
    switchViewMode
};