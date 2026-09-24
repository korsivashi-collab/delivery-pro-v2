// js/app.js

// =================================================================
// [배송 동선 PRO] 메인 오케스트레이터 및 이벤트 컨트롤러
// =================================================================

import { calculateOptimizedRoute } from './optimizer.js';
import { saveRouteToFirestore } from './api.js';
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
    
    // 🌟 관제 센터 실시간 자동할당 동선 수신 핸들러 등록
    setRemoteRoutesHandler((newDestinations, routeData) => {
        if (!newDestinations || !Array.isArray(newDestinations)) return;

        // 관제에서 전송된 배송지 데이터 정규화 (주문번호 orderNo는 백그라운드 데이터로 보존)
        const formattedList = newDestinations.map((d, idx) => ({
            id: d.id || (Date.now() + idx),
            displayNumber: d.displayNumber || (idx + 1),
            address: d.address || "",
            lat: d.lat || 0,
            lng: d.lng || 0,
            phone: d.phone || "",
            storeName: d.storeName || "",
            orderNo: d.orderNo || "", // 실시간 추적용 주문번호 데이터 보존
            memo: d.memo || "",
            items: d.items || []
        }));

        state.setDestinations(formattedList);
        state.updateDisplayNumbers();
        state.saveActiveData();
        renderList();

        // 관리자로부터 신규 배송지 할당 시 진동 알림
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
    }, () => {
        // 관제 센터에서 전체 초기화(삭제)가 진행된 경우
        state.setDestinations([]);
        state.saveActiveData();
        renderList();
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
    let btnLeft = 4;
    
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
        let maxW = swipeContainer.offsetWidth - swipeBtn.offsetWidth - 4;
        
        if (newLeft < 4) newLeft = 4;
        if (newLeft > maxW) newLeft = maxW;
        
        swipeBtn.style.transform = `translateX(${newLeft - 4}px)`;
        
        if (newLeft >= maxW - 2) {
            isDragging = false;
            swipeBtn.style.transform = `translateX(0px)`;
            swipeBtn.style.transition = 'transform 0.3s ease';
            openStartSelectionModal();
        }
    }
    
    function endDrag() {
        if (!isDragging) return;
        isDragging = false;
        swipeBtn.style.transition = 'transform 0.3s ease';
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
        alert("스캔된 배송지가 최소 1곳 이상 있어야 합니다."); 
        return; 
    }
    const listEl = document.getElementById('start-select-list');
    if (!listEl) return;
    
    let html = '';
    destinations.forEach(d => {
        html += `
            <button onclick="selectStartDest(${d.id})" class="w-full text-left bg-white hover:bg-gray-50 border border-gray-200 p-4 rounded-xl shadow-sm transition flex items-center justify-between mb-2 active:bg-gray-100">
                <span class="font-bold text-gray-800 text-[13px] truncate flex-1 pr-2"><i class="fa-solid fa-location-dot text-gray-400 mr-2"></i>${d.address}</span>
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
// 7. 배송 목록 메인 렌더링
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
                <li class="text-center text-gray-400 py-12 border-2 border-dashed border-gray-200 rounded-xl my-2 bg-gray-50/50">
                    <i class="fa-solid fa-receipt text-5xl mb-3 text-gray-300"></i>
                    <p class="font-medium text-xs">주소지를 스캔하거나 관제에서 전송되면 동선이 생성됩니다.</p>
                </li>`;
        }
        return;
    }

    if (listEl) {
        listEl.innerHTML = ''; 
        destinations.forEach((dest, index) => {
            const li = document.createElement('li'); 
            li.setAttribute('data-id', dest.id); 
            // 실시간 추적 고도화용: 주문번호를 화면에 텍스트로 노출하지 않고 엘리먼트 속성에 보관
            if (dest.orderNo) {
                li.setAttribute('data-orderno', dest.orderNo);
            }
            li.className = "bg-white p-2.5 rounded-xl shadow-sm border border-gray-200 flex flex-col gap-1.5";
            
            let numberBadge = index === 0 && (startLocation && startLocation.lat) ? 
                `<div class="bg-indigo-600 text-white font-black w-5 h-5 rounded-full flex items-center justify-center text-[10px] shadow-sm shrink-0 ring-2 ring-indigo-200"><i class="fa-solid fa-flag text-[9px]"></i></div>` : 
                `<div class="bg-blue-600 text-white font-black w-5 h-5 rounded-full flex items-center justify-center text-[10px] shadow-sm shrink-0">${dest.displayNumber}</div>`;
            
            let customerPhoneStr = dest.phone || ""; 
            let dynamicTextSize = "text-[13px]"; 
            if (customerPhoneStr.length >= 13) dynamicTextSize = "text-[10px]"; 
            else if (customerPhoneStr.length >= 11) dynamicTextSize = "text-[11px]"; 
            else if (customerPhoneStr.length >= 9) dynamicTextSize = "text-[12px]";

            // 기존 방식: [상호명] 강조 또는 dest.storeName 강조 후 주소 표시 (배송요청/품목 제외)
            let displayAddressHTML = dest.address;
            let match = dest.address.match(/^\[(.*?)\]\s*(.*)$/);
            if (match) {
                displayAddressHTML = `
                    <span class="text-blue-600 block text-[11px] mb-0.5 leading-none">🏢 ${match[1]}</span>
                    <span class="block truncate leading-tight">${match[2]}</span>
                `;
            } else if (dest.storeName) {
                displayAddressHTML = `
                    <span class="text-blue-600 block text-[11px] mb-0.5 leading-none">🏢 ${dest.storeName}</span>
                    <span class="block truncate leading-tight">${dest.address}</span>
                `;
            } else {
                displayAddressHTML = `<span class="block truncate">${dest.address}</span>`;
            }

            const isFirst = index === 0;
            const isLast = index === destinations.length - 1;

            li.innerHTML = `
                <div class="flex items-center gap-1.5 pb-1">
                    <!-- 위/아래 수직 배치 및 간격 확보 -->
                    <div class="flex flex-col items-center justify-center gap-1.5 shrink-0 -ml-1 mr-0.5">
                        <button onclick="moveDestinationUp(${dest.id})" ${isFirst ? 'disabled' : ''} class="w-6 h-[18px] flex items-center justify-center rounded bg-gray-50 hover:bg-gray-100 active:bg-gray-200 border border-gray-200 text-gray-600 disabled:opacity-15 disabled:pointer-events-none transition shadow-2xs" title="위로 이동">
                            <i class="fa-solid fa-chevron-up text-[10px]"></i>
                        </button>
                        <button onclick="moveDestinationDown(${dest.id})" ${isLast ? 'disabled' : ''} class="w-6 h-[18px] flex items-center justify-center rounded bg-gray-50 hover:bg-gray-100 active:bg-gray-200 border border-gray-200 text-gray-600 disabled:opacity-15 disabled:pointer-events-none transition shadow-2xs" title="아래로 이동">
                            <i class="fa-solid fa-chevron-down text-[10px]"></i>
                        </button>
                    </div>
                    ${numberBadge}
                    <div class="font-bold text-gray-900 text-[13px] flex-1 ml-0.5 min-w-0 flex flex-col justify-center">
                        ${displayAddressHTML}
                    </div>
                    <button onclick="editDestinationAddress(${dest.id})" class="text-gray-400 hover:text-blue-500 p-1.5 -mr-1 shrink-0"><i class="fa-solid fa-pen text-[13px]"></i></button>
                </div>
                
                <div id="memo-tags-${dest.id}" class="hidden flex flex-wrap gap-1 mb-1 mt-1"></div>
                <div id="memo-preview-${dest.id}" class="hidden bg-gray-50 rounded p-1.5 text-[11px] text-gray-800 border border-gray-100 truncate shadow-sm mb-1 mt-1"></div>
                <!-- 공용 메모 아랫단에 개인 메모 표시 슬롯 -->
                <div id="personal-memo-preview-${dest.id}" class="hidden bg-emerald-50 rounded p-1.5 text-[11px] text-emerald-950 border border-emerald-200 truncate shadow-sm mb-1.5 mt-0.5"></div>
                
                <div class="flex flex-col gap-1.5 mt-1 pt-2 border-t border-gray-100">
                    <div class="flex gap-1.5 h-[40px]">
                        ${customerPhoneStr ? `<a href="tel:${customerPhoneStr}" class="flex-none w-[115px] bg-green-50 text-green-700 border border-green-200 rounded-lg shadow-sm flex items-center justify-center active:bg-green-100 transition px-1.5 phone-number-box"><i class="fa-solid fa-phone mr-1 text-[11px] shrink-0"></i><span class="${dynamicTextSize} font-black tracking-tighter whitespace-nowrap">${customerPhoneStr}</span></a>` : `<div class="flex-none w-[115px] bg-gray-50 text-gray-400 border border-gray-100 rounded-lg shadow-sm flex items-center justify-center px-1.5"><i class="fa-solid fa-phone-slash mr-1 text-[11px]"></i><span class="text-[11px] font-bold whitespace-nowrap">번호 없음</span></div>`}
                        <a href="sms:${customerPhoneStr}" class="flex-1 bg-sky-50 text-sky-600 border border-sky-200 rounded-lg shadow-sm flex items-center justify-center gap-1 active:bg-sky-100 transition ${!customerPhoneStr ? 'opacity-30 pointer-events-none' : ''}"><i class="fa-solid fa-comment-sms text-[14px]"></i><span class="text-[12px] font-black">문자</span></a>
                        <button onclick="openMemoModal(${dest.id})" class="flex-1 bg-yellow-50 text-yellow-600 border border-yellow-200 rounded-lg shadow-sm flex items-center justify-center gap-1 active:bg-yellow-100 transition"><i class="fa-solid fa-pen-to-square text-[14px]"></i><span class="text-[12px] font-black">메모</span></button>
                        <button onclick="completeDestination(${dest.id})" class="flex-1 bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-lg shadow-sm flex items-center justify-center gap-1 active:bg-emerald-100 transition"><i class="fa-solid fa-check text-[15px]"></i><span class="text-[12px] font-black">완료</span></button>
                    </div>
                    <div class="flex gap-1.5 h-[36px]">
                        <div class="flex-1 bg-gray-50 border border-gray-200 p-1 rounded-lg flex items-center gap-1.5">
                            <span class="text-[11px] font-black text-gray-500 w-10 text-center leading-tight">길찾기</span>
                            <div class="w-px h-5 bg-gray-300"></div>
                            <div class="flex-1 grid grid-cols-2 gap-1.5 h-full">
                                <button onclick="openTmap(${dest.lat}, ${dest.lng}, '${dest.address}')" class="bg-black text-white text-[11px] font-bold rounded-md active:opacity-80 flex items-center justify-center gap-1 shadow-sm h-full"><i class="fa-solid fa-map-location-dot text-[10px]"></i> 티맵</button>
                                <button onclick="openKakaoNaviDirect(${dest.lat}, ${dest.lng}, '${dest.address}')" class="bg-[#FEE500] text-black text-[11px] font-bold rounded-md border border-yellow-400 active:bg-yellow-400 flex items-center justify-center gap-1 shadow-sm h-full"><i class="fa-solid fa-location-arrow text-[10px]"></i> 카카오</button>
                            </div>
                        </div>
                        <button onclick="cancelDestination(${dest.id})" class="w-[50px] shrink-0 bg-red-50 text-red-500 border border-red-200 rounded-lg shadow-sm flex items-center justify-center active:bg-red-100 transition"><i class="fa-solid fa-trash-can text-[15px]"></i></button>
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