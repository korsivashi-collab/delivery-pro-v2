// js/app.js

// =================================================================
// [배송 동선 PRO] 메인 오케스트레이터 및 이벤트 컨트롤러
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

import { 
    completeDestination, 
    selectCompletionTag, 
    closeCompletionModal, 
    triggerPhotoCompletion, 
    confirmCompletion, 
    cancelDestination, 
    initPhotoCompletion 
} from './delivery.js';

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

    // 숫자가 8자리 미만이거나 단순 "0"인 경우 번호 없음으로 무효 처리
    if (digits.length < 8 || digits === '0') return "";

    // 11자리 휴대전화 포맷팅 (010-XXXX-XXXX)
    if (digits.length === 11 && digits.startsWith('010')) {
        return digits.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
    }
    // 10자리 번호 포맷팅 (02-XXXX-XXXX 또는 01X-XXX-XXXX)
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

    // 1. [상호] 패턴 확인 및 상호명 분리
    const match = cleanAddr.match(/^\[(.*?)\]\s*(.*)$/);
    if (match) {
        if (!extractedStore) extractedStore = match[1].trim();
        cleanAddr = match[2].trim();
    }

    // 2. 주소 앞부분에 상호명이 중복으로 붙은 경우 주소에서 상호명 제거
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
// 1. 앱 기동 및 라이프사이클 초기화
// ==========================================
export async function initApp() {
    // 안드로이드 / iOS 기기 해상도 및 뷰포트 자동 최적화 즉시 구동
    initResponsiveViewport();

    localStorage.removeItem('deliveryPro_start_location'); 
    state.loadActiveData();
    cleanOldHistory();
    initSwipeButton();
    startGpsWatcher();
    checkUnreadNotices();
    initMemoEvents();
    initCameraScan();
    initPhotoCompletion(); 
    
    // 관제 센터 실시간 자동할당 동선 수신 핸들러 등록
    setRemoteRoutesHandler((newDestinations, routeData) => {
        if (!newDestinations || !Array.isArray(newDestinations)) return;

        // 당일 이미 완료/취소된 이력이 있다면 중복 노출 방지 필터링
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

        // 관제에서 전송된 배송지 데이터 정규화
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
                    orderNo: d.orderNo || "", // 실시간 추적용 주문번호 보존
                    memo: d.memo || "",
                    items: d.items || []
                };
            });

        // 시작 지점이 아직 없다면 첫 번째 목적지를 기본 시작점으로 자동 고려
        if (formattedList.length > 0 && (!state.getStartLocation() || !state.getStartLocation().lat)) {
            state.setStartLocation({
                lat: formattedList[0].lat,
                lng: formattedList[0].lng,
                address: formattedList[0].address
            });
        }

        state.setDestinations(formattedList);
        state.updateDisplayNumbers();
        state.saveActiveData();
        renderList();

        // 관리자로부터 신규 배송지 할당 시 진동 알림
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
    }, () => {
        // 🌟 관제 센터에서 전체 초기화(삭제)가 진행된 경우 즉각 클리어
        state.setDestinations([]);
        state.setStartLocation(null);
        state.saveActiveData();
        renderList();
    });

    // 🌟 앱 화면 복귀(화면 켜짐/포그라운드 전환) 시 관제 최신 상태 자동 대조
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
            const deviceId = getOrCreateDeviceId();
            const phone = localStorage.getItem('deliveryProUserPhone') || "";
            if (deviceId || phone) {
                const latestRoute = await fetchActiveRouteOnce(deviceId, phone);
                if (!latestRoute || !latestRoute.destinations || latestRoute.destinations.length === 0) {
                    const currentDests = state.getDestinations();
                    // 관제에는 비어있는데 기기 화면에만 남아있는 경우 즉시 초기화
                    if (currentDests.length > 0) {
                        state.setDestinations([]);
                        state.setStartLocation(null);
                        state.saveActiveData();
                        renderList();
                    }
                }
            }
        }
    });

    // 지난 배송 복원 콜백 등록
    setRestoreDestinationHandler((itemToRestore) => {
        state.addDestination(itemToRestore);
        updateDisplayNumbers();
    });

    // GPS 토글 스위치 콜백 등록
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
    let btnLeft = 6;
    
    function startDrag(e) {
        isDragging = true;
        startX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
        swipeBtn.style.transition = 'none';
    }
    
    function moveDrag(e) {
        if (!isDragging) return;
        const currentX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
        let moveX = currentX - startX;
        let newLeft = btnLeft + moveX;
        let maxW = swipeContainer.offsetWidth - swipeBtn.offsetWidth - 6;
        
        if (newLeft < 6) newLeft = 6;
        if (newLeft > maxW) newLeft = maxW;
        
        swipeBtn.style.transform = `translateX(${newLeft - 6}px)`;
        
        if (newLeft >= maxW - 2) {
            isDragging = false;
            swipeBtn.style.transform = `translateX(0px)`;
            swipeBtn.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
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

    // 윗 배송지와 순서 맞교환
    const temp = destinations[idx];
    destinations[idx] = destinations[idx - 1];
    destinations[idx - 1] = temp;

    // 시작 지점이 설정된 상태에서 1번 항목이 변경된 경우 시작 좌표 동기화
    if (state.getStartLocation() && destinations[0]) {
        state.setStartLocation({
            lat: destinations[0].lat,
            lng: destinations[0].lng,
            address: destinations[0].address
        });
    }

    state.setDestinations(destinations);
    updateDisplayNumbers();

    if (navigator.vibrate) navigator.vibrate(12);
}

export function moveDestinationDown(id) {
    const destinations = state.getDestinations();
    const idx = destinations.findIndex(d => d.id === id);
    if (idx === -1 || idx >= destinations.length - 1) return; 

    // 아랫 배송지와 순서 맞교환
    const temp = destinations[idx];
    destinations[idx] = destinations[idx + 1];
    destinations[idx + 1] = temp;

    // 시작 지점이 설정된 상태에서 1번 항목이 변경된 경우 시작 좌표 동기화
    if (state.getStartLocation() && destinations[0]) {
        state.setStartLocation({
            lat: destinations[0].lat,
            lng: destinations[0].lng,
            address: destinations[0].address
        });
    }

    state.setDestinations(destinations);
    updateDisplayNumbers();

    if (navigator.vibrate) navigator.vibrate(12);
}

// ==========================================
// 7. 배송 목록 메인 렌더링 (🌟 시인성 및 터치 영역 확대)
// ==========================================
export function renderList() {
    const listEl = document.getElementById('destination-list');
    const headerEndAddr = document.getElementById('header-end-address'); 
    const headerEndInput = document.getElementById('header-inline-end-input');
    const endLocation = state.getEndLocation();
    const destinations = state.getDestinations();
    const startLocation = state.getStartLocation();
    
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
            // 실시간 추적용 주문번호 보존
            if (dest.orderNo) {
                li.setAttribute('data-orderno', dest.orderNo);
            }
            li.className = "bg-white p-3 rounded-2xl shadow-xs border border-gray-200 flex flex-col gap-2";
            
            // 순번 배지 확대 (w-6 h-6)
            let numberBadge = index === 0 && (startLocation && startLocation.lat) ? 
                `<div class="bg-indigo-600 text-white font-black w-6 h-6 rounded-full flex items-center justify-center text-[11px] shadow-sm shrink-0 ring-2 ring-indigo-200"><i class="fa-solid fa-flag text-[10px]"></i></div>` : 
                `<div class="bg-blue-600 text-white font-black w-6 h-6 rounded-full flex items-center justify-center text-[11px] shadow-sm shrink-0">${dest.displayNumber}</div>`;
            
            // 전화번호 정제 및 폰트 크기 계산 (시인성 강화)
            let customerPhoneStr = sanitizePhoneNumber(dest.phone || ""); 
            let dynamicTextSize = "text-[12px]"; 
            if (customerPhoneStr.length >= 13) dynamicTextSize = "text-[10.5px]"; 
            else if (customerPhoneStr.length >= 11) dynamicTextSize = "text-[11px]"; 
            else if (customerPhoneStr.length >= 9) dynamicTextSize = "text-[11.5px]";

            // 주소지 표시 (상호명 및 주소 폰트 확대)
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

            // 내비게이션 앱 목적지 명칭
            let navTargetName = (formatted.storeName || formatted.cleanAddr || dest.address).replace(/['"]/g, '');

            const isFirst = index === 0;
            const isLast = index === destinations.length - 1;

            li.innerHTML = `
                <div class="flex items-center gap-1.5 pb-0.5">
                    <!-- 위/아래 순서 변경 버튼 -->
                    <div class="flex flex-col items-center justify-center gap-1 shrink-0 -ml-0.5 mr-0.5">
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
                    <!-- 수정 버튼 확대 -->
                    <button onclick="editDestinationAddress(${dest.id})" class="text-gray-400 hover:text-blue-500 w-8 h-8 flex items-center justify-center -mr-1 shrink-0 rounded-lg active:bg-gray-100 transition" title="주소 수정"><i class="fa-solid fa-pen text-[14px]"></i></button>
                </div>
                
                <div id="memo-tags-${dest.id}" class="hidden flex flex-wrap gap-1 mb-0.5 mt-0.5"></div>
                <div id="memo-preview-${dest.id}" class="hidden bg-gray-50 rounded-lg p-2 text-[11.5px] text-gray-800 border border-gray-100 truncate shadow-2xs mb-0.5 mt-0.5"></div>
                <!-- 공용 메모 아랫단에 개인 메모 표시 슬롯 -->
                <div id="personal-memo-preview-${dest.id}" class="hidden bg-emerald-50 rounded-lg p-2 text-[11.5px] text-emerald-950 border border-emerald-200 truncate shadow-2xs mb-1 mt-0.5"></div>
                
                <div class="flex flex-col gap-1.5 mt-0.5 pt-2 border-t border-gray-100">
                    <!-- 🌟 버튼 1열: 전화/문자/메모/완료 (높이 42px 및 폰트 확대) -->
                    <div class="flex gap-1.5 h-[42px]">
                        ${customerPhoneStr ? `<a href="tel:${customerPhoneStr}" class="flex-none w-[106px] bg-green-50 text-green-700 border border-green-200 rounded-xl shadow-2xs flex items-center justify-center active:bg-green-100 transition px-1.5 phone-number-box"><i class="fa-solid fa-phone mr-1 text-[11px] shrink-0"></i><span class="${dynamicTextSize} font-black tracking-tight whitespace-nowrap">${customerPhoneStr}</span></a>` : `<div class="flex-none w-[106px] bg-gray-50 text-gray-400 border border-gray-100 rounded-xl shadow-2xs flex items-center justify-center px-1.5"><i class="fa-solid fa-phone-slash mr-1 text-[11px] shrink-0"></i><span class="text-[10.5px] font-bold whitespace-nowrap">번호 없음</span></div>`}
                        <a href="sms:${customerPhoneStr}" class="flex-1 min-w-0 bg-sky-50 text-sky-600 border border-sky-200 rounded-xl shadow-2xs flex items-center justify-center gap-1 active:bg-sky-100 transition flex-nowrap ${!customerPhoneStr ? 'opacity-30 pointer-events-none' : ''}"><i class="fa-solid fa-comment-sms text-[13px] shrink-0"></i><span class="text-[12.5px] font-black whitespace-nowrap tracking-tight">문자</span></a>
                        <button onclick="openMemoModal(${dest.id})" class="flex-1 min-w-0 bg-yellow-50 text-yellow-600 border border-yellow-200 rounded-xl shadow-2xs flex items-center justify-center gap-1 active:bg-yellow-100 transition flex-nowrap"><i class="fa-solid fa-pen-to-square text-[13px] shrink-0"></i><span class="text-[12.5px] font-black whitespace-nowrap tracking-tight">메모</span></button>
                        <button onclick="completeDestination(${dest.id})" class="flex-1 min-w-0 bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-xl shadow-2xs flex items-center justify-center gap-1 active:bg-emerald-100 transition flex-nowrap"><i class="fa-solid fa-check text-[14px] shrink-0"></i><span class="text-[12.5px] font-black whitespace-nowrap tracking-tight">완료</span></button>
                    </div>
                    <!-- 🌟 버튼 2열: 길찾기(티맵/카카오) & 삭제 (높이 38px 및 버튼 확대) -->
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
// 8. 종료 지점 직접 입력 제어
// ==========================================
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
    if (window.Kakao && window.Kakao.isInitialized()) {
        window.Kakao.Navi.start({ name: name, x: lng, y: lat, coordType: 'wgs84' });
    } else {
        alert("카카오 내비 모듈 오류입니다.");
    }
}

// ==========================================
// 10. Window 전역 객체 바인딩 (HTML 인라인 이벤트 호환)
// ==========================================
window.logout = logout;
window.renderList = renderList;
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
window.editDestinationAddress = editDestinationAddress;
window.openTmap = openTmap;
window.openKakaoNaviDirect = openKakaoNaviDirect;
window.closeStartModal = closeStartModal;
window.selectStartDest = selectStartDest;
window.optimizeRoute = optimizeRouteAction;
window.initPhotoCompletion = initPhotoCompletion;
window.selectHeightTag = selectHeightTag;
window.selectTimeTag = selectTimeTag;
window.toggleEtcTag = toggleEtcTag;

// 순서 이동 전역 함수 바인딩
window.moveDestinationUp = moveDestinationUp;
window.moveDestinationDown = moveDestinationDown;

window.appActions = {
    initApp, 
    optimizeRouteAction, 
    getDeviceRealGPS, 
    renderList,
    moveDestinationUp,
    moveDestinationDown
};