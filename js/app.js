// js/app.js
import { calculateOptimizedRoute } from './optimizer.js';
import { 
    firebaseVerifyLicense, watchLicenseStatus, startGpsRequestLister, 
    startDispatchMessageListener, firebaseStartTrial, getMemosFromFirestore, 
    getBatchMemosFromFirestore, saveMemoToFirestore, likeMemoInFirestore, 
    reportMemoInFirestore, saveRouteToFirestore, saveCompletionToFirestore, 
    firebaseClearDeviceData, firebaseUploadDeliveryPhoto
} from './api.js';
// 🌟 예비군(Fallback)으로 사용할 기존 상호 추출 로직(extractStoreNameLogic) 정상 포함
import { 
    toBase64_SafeCompress, extractPhoneLogic, extractAddressLogic, extractStoreNameLogic 
} from './utils.js';
import { 
    archiveCompletedDelivery, cleanOldHistory, checkUnreadNotices, 
    saveMessageToLocalHistory, showDispatchAlertPopup, 
    setRestoreDestinationHandler, setGpsToggleHandler 
} from './support.js';
// 🌟 카카오 매칭 모듈 정상 포함
import { 
    geocodeAddress, coordToAddress, getNearbyPOIs, getPOIsByAddress, findStoreNameFromOCR 
} from './kakao.js';

// 전역 상태 변수들
let sortableInstance = null;
let endLocation = { lat: 0, lng: 0, address: "" }; 
let destinations = [];
let idCounter = Date.now();
let startLocation = null;
let batchMemosCache = {}; 

let pendingCompletionId = null;
let selectedCompTag = "";
let currentMemoAddress = "";
let selectedHeightText = "";
let selectedTimeText = "";
let licenseWatcherUnsub = null;
let dispatchMsgWatcherUnsub = null;  
let gpsRequestWatcherUnsub = null;  
let lastKnownGps = null;
let gpsWatchId = null;

// ==========================================
// 상호명을 완벽히 제외한 '순수 주소' 추출 함수
// ==========================================
function getPureAddress(address) {
    if (!address) return "";
    let match = address.match(/^\[(.*?)\]\s*(.*)$/);
    return match ? match[2].trim() : address.trim();
}

export function getOrCreateDeviceId() {
    let deviceId = localStorage.getItem('deliveryProDeviceId');
    if (!deviceId) {
        deviceId = 'DEV-' + Math.random().toString(36).substring(2, 10) + '-' + Date.now().toString(36);
        localStorage.setItem('deliveryProDeviceId', deviceId);
    }
    return deviceId;
}

export function startGpsWatcher() {
    if (!navigator.geolocation || gpsWatchId !== null) return;
    gpsWatchId = navigator.geolocation.watchPosition(
        (pos) => {
            lastKnownGps = { lat: pos.coords.latitude, lng: pos.coords.longitude, timestamp: Date.now() };
        },
        (err) => {},
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 30000 }
    );
}

export function getDeviceRealGPS() {
    return new Promise((resolve) => {
        if (lastKnownGps && (Date.now() - lastKnownGps.timestamp < 120000)) {
            return resolve({ lat: lastKnownGps.lat, lng: lastKnownGps.lng, isReal: true });
        }
        if (!navigator.geolocation) {
            return resolve(lastKnownGps ? { ...lastKnownGps, isReal: true } : null);
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                lastKnownGps = { lat: pos.coords.latitude, lng: pos.coords.longitude, timestamp: Date.now() };
                resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, isReal: true });
            },
            (err) => {
                if (lastKnownGps) resolve({ lat: lastKnownGps.lat, lng: lastKnownGps.lng, isReal: true });
                else resolve(null);
            },
            { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 }
        );
    });
}

export async function initApp() {
    localStorage.removeItem('deliveryPro_start_location'); 
    loadActiveData();
    cleanOldHistory();
    initSwipeButton();
    startGpsWatcher();
    checkUnreadNotices();
    
    // support.js와 통신할 콜백 등록
    setRestoreDestinationHandler((itemToRestore) => {
        destinations.push(itemToRestore);
        updateDisplayNumbers();
    });

    setGpsToggleHandler((isChecked) => {
        if (isChecked) {
            startGpsWatcher();
        } else {
            if (gpsWatchId !== null) {
                navigator.geolocation.clearWatch(gpsWatchId);
                gpsWatchId = null;
            }
        }
    });
    
    const memoInputEl = document.getElementById('memo-input');
    if (memoInputEl) {
        memoInputEl.addEventListener('input', function() {
            const countEl = document.getElementById('memo-char-count');
            if (countEl) countEl.innerText = `${this.value.length} / 30`;
        });
    }
    
    initCameraScan();
    initPhotoCompletion(); 
    
    const savedKey = localStorage.getItem('deliveryProKey');
    const savedPhone = localStorage.getItem('deliveryProUserPhone');
    const bootScreen = document.getElementById('boot-screen');

    if (savedKey) {
        const inputKey = document.getElementById('license-input');
        if (inputKey) inputKey.value = savedKey;
    }
    if (savedPhone) {
        const inputPhone = document.getElementById('auth-phone-input');
        if (inputPhone) inputPhone.value = savedPhone;
    }

    const cleanDigits = (savedPhone || '').replace(/[^0-9]/g, '');

    if (savedKey && cleanDigits.length >= 9) {
        const deviceId = getOrCreateDeviceId();
        try {
            const res = await firebaseVerifyLicense(savedKey, savedPhone, deviceId);
            if (res.valid) {
                localStorage.setItem('deliveryProDispatchKey', res.dispatchKey || '');
                unlockApp();
                updateExpireBadge(res.expireDate);
                startLicenseRealtimeWatcher(res.actualKey || savedKey);

                dispatchMsgWatcherUnsub = startDispatchMessageListener(deviceId, savedPhone, res.actualKey || savedKey, (msg) => {
                    saveMessageToLocalHistory(msg.msgId, msg.content, msg.dateStr, msg.timeStr, msg.senderTitle, msg.senderType);
                    const alreadyAcked = localStorage.getItem(`acked_msg_${msg.msgId}`);
                    if (!alreadyAcked) {
                        showDispatchAlertPopup(msg.content, msg.timeStr || '', msg.msgId, msg.senderTitle, msg.senderType);
                    }
                });

                gpsRequestWatcherUnsub = startGpsRequestLister(deviceId, savedPhone, res.actualKey || savedKey, getDeviceRealGPS);
                updatePhotoCompButtonState(!!res.dispatchKey);
            } else {
                clearAuthStorage();
                const authMsg = document.getElementById('auth-message');
                if (authMsg) authMsg.innerText = res.msg;
                const authScreen = document.getElementById('auth-screen');
                if (authScreen) authScreen.classList.remove('hidden');
            }
        } catch (e) {
            const authMsg = document.getElementById('auth-message');
            if (authMsg) authMsg.innerText = "보안 통신 오류가 발생했습니다. 네트워크를 확인해 주세요.";
            const authScreen = document.getElementById('auth-screen');
            if (authScreen) authScreen.classList.remove('hidden');
        }
    } else {
        const authScreen = document.getElementById('auth-screen');
        if (authScreen) authScreen.classList.remove('hidden');
    }

    if (bootScreen) bootScreen.classList.add('hidden');
}

function clearAuthStorage() {
    localStorage.removeItem('deliveryProKey');
    localStorage.removeItem('deliveryProUserPhone');
    localStorage.removeItem('deliveryProExpireDate');
    localStorage.removeItem('deliveryProDispatchKey');
}

function startLicenseRealtimeWatcher(key) {
    if (licenseWatcherUnsub) licenseWatcherUnsub();
    licenseWatcherUnsub = watchLicenseStatus(key, (status, msg) => {
        alert(`⚠️ [라이선스 알림]\n${msg}`);
        clearAuthStorage();
        const mainApp = document.getElementById('main-app');
        const authScreen = document.getElementById('auth-screen');
        if (mainApp) { mainApp.classList.add('hidden'); mainApp.classList.remove('flex'); }
        if (authScreen) authScreen.classList.remove('hidden');
        window.location.reload();
    }, (docData) => {
        const linkedKey = docData.dispatchKey || '';
        localStorage.setItem('deliveryProDispatchKey', linkedKey);
        updatePhotoCompButtonState(!!linkedKey);
    });
}

function unlockApp() {
    const authScreen = document.getElementById('auth-screen');
    const mainApp = document.getElementById('main-app');
    if (authScreen) authScreen.classList.add('hidden');
    if (mainApp) {
        mainApp.classList.remove('hidden');
        mainApp.classList.add('flex');
    }
    updateExpireBadge(); 
    startGpsWatcher();
}

function updateExpireBadge(serverDate) {
    const badge = document.getElementById('license-expire-badge');
    if (!badge) return;
    const cachedDate = localStorage.getItem('deliveryProExpireDate');
    const expireDate = serverDate || cachedDate || "2026.12.31";
    if (serverDate) localStorage.setItem('deliveryProExpireDate', serverDate);
    badge.innerText = `사용기한: ${expireDate}`;
    badge.classList.remove('hidden');
}

function updatePhotoCompButtonState(isLinked) {
    const btn = document.getElementById('btn-photo-comp');
    const subtext = document.getElementById('photo-comp-subtext');
    if (!btn || !subtext) return;

    if (isLinked) {
        btn.className = "bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-2 rounded-xl shadow-md text-xs active:scale-95 transition flex flex-col items-center justify-center cursor-pointer";
        subtext.className = "text-[9px] font-bold text-blue-100 mt-0.5 tracking-tighter flex items-center gap-1";
        subtext.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> 관제 연결됨';
    } else {
        btn.className = "bg-gray-100 border border-gray-200 text-gray-400 font-bold py-2.5 px-2 rounded-xl text-xs transition flex flex-col items-center justify-center cursor-not-allowed opacity-75";
        subtext.className = "text-[9px] font-normal text-gray-400 mt-0.5 tracking-tighter";
        subtext.innerText = "(계정 연결 시 사용)";
    }
}

export async function verifyLicense() {
    const keyInput = (document.getElementById('license-input')?.value || '').trim().toUpperCase();
    const rawPhone = (document.getElementById('auth-phone-input')?.value || '').trim();
    const msgEl = document.getElementById('auth-message');
    const btn = document.getElementById('verify-btn');
    const deviceId = getOrCreateDeviceId(); 
    
    if (!keyInput) { 
        if (msgEl) msgEl.innerText = "라이선스 키를 입력해 주세요."; 
        document.getElementById('license-input')?.focus();
        return; 
    }
    
    const cleanDigits = rawPhone.replace(/[^0-9]/g, '');
    if (!rawPhone || cleanDigits.length < 9 || cleanDigits.length > 13) {
        if (msgEl) msgEl.innerText = "휴대폰 번호를 반드시 입력해야 로그인이 완료됩니다.\n(예: 010-1234-5678)";
        document.getElementById('auth-phone-input')?.focus();
        return;
    }

    let formattedPhone = rawPhone;
    if (!rawPhone.includes('-')) {
        if (cleanDigits.startsWith('010') && cleanDigits.length === 11) {
            formattedPhone = cleanDigits.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
        } else if (cleanDigits.length === 10) {
            formattedPhone = cleanDigits.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
        }
    }
    
    if (msgEl) msgEl.innerText = "";
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i>인증 확인 중...';
        btn.disabled = true;
    }

    try {
        const res = await firebaseVerifyLicense(keyInput, formattedPhone, deviceId);
        
        if (res && res.valid) {
            const actualKey = res.actualKey || keyInput;
            localStorage.setItem('deliveryProKey', actualKey);
            localStorage.setItem('deliveryProUserPhone', formattedPhone); 
            localStorage.setItem('deliveryProDispatchKey', res.dispatchKey || '');
            if (res.expireDate) localStorage.setItem('deliveryProExpireDate', res.expireDate);
            
            unlockApp();
            updateExpireBadge(res.expireDate);
            startLicenseRealtimeWatcher(actualKey);
            
            dispatchMsgWatcherUnsub = startDispatchMessageListener(deviceId, formattedPhone, actualKey, (msg) => {
                saveMessageToLocalHistory(msg.msgId, msg.content, msg.dateStr, msg.timeStr, msg.senderTitle, msg.senderType);
                const alreadyAcked = localStorage.getItem(`acked_msg_${msg.msgId}`);
                if (!alreadyAcked) {
                    showDispatchAlertPopup(msg.content, msg.timeStr || '', msg.msgId, msg.senderTitle, msg.senderType);
                }
            });

            gpsRequestWatcherUnsub = startGpsRequestLister(deviceId, formattedPhone, actualKey, getDeviceRealGPS);
            updatePhotoCompButtonState(!!res.dispatchKey);
        } else {
            if (msgEl) msgEl.innerText = (res && res.msg) ? res.msg : "인증에 실패했습니다. 키와 번호를 확인해 주세요.";
        }
    } catch (e) {
        if (msgEl) msgEl.innerText = "통신 오류가 발생했습니다. 네트워크 상태를 확인 후 다시 시도해 주세요.";
    } finally {
        if (btn) {
            btn.innerHTML = '인증하고 시작하기';
            btn.disabled = false;
        }
    }
}

export function openTrialModal() {
    const input = document.getElementById('trial-phone-input');
    const msg = document.getElementById('trial-error-msg');
    const modal = document.getElementById('trial-modal');
    if (input) input.value = "";
    if (msg) msg.classList.add('hidden');
    if (modal) modal.classList.remove('hidden');
    setTimeout(() => { if (input) input.focus(); }, 100);
}

export function closeTrialModal() { 
    document.getElementById('trial-modal')?.classList.add('hidden'); 
}

export async function startFreeTrial() {
    const phoneInput = (document.getElementById('trial-phone-input')?.value || '').trim();
    const msgEl = document.getElementById('trial-error-msg');
    const btn = document.getElementById('trial-submit-btn');
    const deviceId = getOrCreateDeviceId();
    
    const cleanDigits = phoneInput.replace(/[^0-9]/g, '');
    if (!phoneInput || cleanDigits.length < 9 || cleanDigits.length > 13) {
        if (msgEl) {
            msgEl.innerText = "휴대폰 번호를 정확하게 입력해 주세요 (숫자 9~13자리).";
            msgEl.classList.remove('hidden');
        }
        return;
    }
    
    if (msgEl) msgEl.classList.add('hidden');
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 처리 중...';
        btn.disabled = true;
    }

    try {
        const res = await firebaseStartTrial(phoneInput, deviceId);
        if (res.valid) {
            localStorage.setItem('deliveryProKey', res.trialKey);
            localStorage.setItem('deliveryProUserPhone', phoneInput);
            localStorage.setItem('deliveryProExpireDate', res.expireDate);
            localStorage.setItem('deliveryProDispatchKey', res.dispatchKey || '');
            alert("7일 무료 체험이 시작되었습니다.\n안전 운전 하십시오!");
            closeTrialModal();
            unlockApp();
            updateExpireBadge(res.expireDate);
            startLicenseRealtimeWatcher(res.trialKey);
            
            dispatchMsgWatcherUnsub = startDispatchMessageListener(deviceId, phoneInput, res.trialKey, (msg) => {
                saveMessageToLocalHistory(msg.msgId, msg.content, msg.dateStr, msg.timeStr, msg.senderTitle, msg.senderType);
                if (!localStorage.getItem(`acked_msg_${msg.msgId}`)) {
                    showDispatchAlertPopup(msg.content, msg.timeStr || '', msg.msgId, msg.senderTitle, msg.senderType);
                }
            });

            gpsRequestWatcherUnsub = startGpsRequestLister(deviceId, phoneInput, res.trialKey, getDeviceRealGPS);
            updatePhotoCompButtonState(false);
        } else {
            if (msgEl) {
                msgEl.innerText = res.msg;
                msgEl.classList.remove('hidden');
            }
        }
    } catch (e) {
        if (msgEl) {
            msgEl.innerText = "오류 발생: " + e.message;
            msgEl.classList.remove('hidden');
        }
    } finally {
        if (btn) {
            btn.innerHTML = '무료로 시작하기';
            btn.disabled = false;
        }
    }
}

function initSwipeButton() {
    const swipeContainer = document.getElementById('swipe-container');
    const swipeBtn = document.getElementById('swipe-btn');
    if (!swipeContainer || !swipeBtn) return;
    
    let isDragging = false;
    let startX = 0; let btnLeft = 4;
    
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
    swipeBtn.addEventListener('touchstart', startDrag, {passive: true});
    document.addEventListener('mousemove', moveDrag);
    document.addEventListener('touchmove', moveDrag, {passive: false});
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);
}

export function openStartSelectionModal() {
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
    const idx = destinations.findIndex(d => d.id === id);
    if (idx > -1) {
        const chosen = destinations.splice(idx, 1)[0];
        destinations.unshift(chosen);
        startLocation = { lat: chosen.lat, lng: chosen.lng, address: chosen.address };
        saveActiveData();
        optimizeRouteAction();
    }
}

export function optimizeRouteAction() {
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

function updateDisplayNumbers() {
    destinations = destinations.filter(d => d != null);
    destinations.forEach((d, i) => d.displayNumber = i + 1);
    saveActiveData();
    renderList();
}

function saveActiveData() {
    localStorage.setItem('deliveryPro_active_destinations', JSON.stringify(destinations));
    localStorage.setItem('deliveryPro_end_location', JSON.stringify(endLocation));
}

function loadActiveData() {
    const savedList = localStorage.getItem('deliveryPro_active_destinations');
    if (savedList) { 
        try { destinations = JSON.parse(savedList); } catch (e) { destinations = []; } 
    }
    
    const savedEnd = localStorage.getItem('deliveryPro_end_location');
    if (savedEnd) { 
        try { endLocation = JSON.parse(savedEnd); } catch(e){} 
    }
    renderList();
}

function initSortable() {
    const el = document.getElementById('destination-list');
    if (!el) return;
    
    if (sortableInstance) sortableInstance.destroy();
    
    if (window.Sortable) {
        sortableInstance = new Sortable(el, {
            handle: '.drag-handle', 
            animation: 250, 
            easing: "cubic-bezier(0.25, 1, 0.5, 1)", 
            delay: 200, 
            delayOnTouchOnly: true, 
            forceFallback: true, 
            fallbackClass: "sortable-drag", 
            fallbackOnBody: true, 
            swapThreshold: 0.4, 
            invertSwap: true, 
            scroll: true, 
            scrollSensitivity: 80, 
            scrollSpeed: 20, 
            fallbackTolerance: 5, 
            filter: '.no-drag', 
            ghostClass: 'sortable-ghost',
            onEnd: function (evt) {
                const liElements = el.querySelectorAll('li[data-id]');
                const newOrderIds = Array.from(liElements).map(li => parseInt(li.getAttribute('data-id')));
                const newDestinations = [];
                newOrderIds.forEach(id => { 
                    const found = destinations.find(d => d.id === id); 
                    if(found) newDestinations.push(found); 
                });
                destinations = newDestinations; 
                updateDisplayNumbers(); 
            }
        });
    }
}

async function preloadBatchMemos() {
    if (destinations.length === 0) return;
    const addresses = destinations.map(d => getPureAddress(d.address));
    const uniqueAddrs = [...new Set(addresses)];
    try { 
        batchMemosCache = await getBatchMemosFromFirestore(uniqueAddrs); 
    } catch (e) { 
        batchMemosCache = {}; 
    }
}

function renderMemoPreview(dest) {
    const previewEl = document.getElementById(`memo-preview-${dest.id}`); 
    const tagsEl = document.getElementById(`memo-tags-${dest.id}`);
    if (!previewEl || !tagsEl) return;
    
    const pureAddr = getPureAddress(dest.address);
    const memos = batchMemosCache[pureAddr] || []; 
    const memoText = memos.length > 0 ? memos[0].memo : null;

    if (memoText) {
        const tagRegex = /\[(.*?)\]/g; 
        let tags = []; 
        let match;
        
        while ((match = tagRegex.exec(memoText)) !== null) {
            let text = match[1]; 
            text = text.replace('주차장 높이 ', '높이:'); 
            text = text.replace('무료 회차 시간 ', '회차:'); 
            tags.push(text);
        }
        
        let rawText = memoText.replace(/\[.*?\]/g, '').trim();
        
        if (tags.length > 0) {
            tagsEl.innerHTML = tags.map(t => `<span class="bg-gray-100 text-gray-600 border border-gray-200 text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0">${t}</span>`).join(''); 
            tagsEl.classList.remove('hidden');
        } else { 
            tagsEl.classList.add('hidden'); 
            tagsEl.innerHTML = ''; 
        }
        
        if (rawText) { 
            previewEl.innerHTML = `<i class="fa-solid fa-circle-info text-blue-500 mr-1"></i><span class="font-bold">주차정보:</span> <span class="text-gray-700">${rawText}</span>`; 
            previewEl.classList.remove('hidden');
        } else { 
            previewEl.classList.add('hidden'); 
        }
    } else { 
        tagsEl.classList.add('hidden'); 
        previewEl.classList.add('hidden'); 
    }
}

export function renderList() {
    const listEl = document.getElementById('destination-list');
    const headerEndAddr = document.getElementById('header-end-address'); 
    const headerEndInput = document.getElementById('header-inline-end-input');
    
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
                <li class="text-center text-gray-400 py-12 no-drag border-2 border-dashed border-gray-200 rounded-xl my-2 bg-gray-50/50">
                    <i class="fa-solid fa-receipt text-5xl mb-3 text-gray-300"></i>
                    <p class="font-medium text-xs">주소지를 스캔하면 동선이 생성됩니다.</p>
                </li>`;
        }
        initSortable(); 
        return;
    }

    if (listEl) {
        listEl.innerHTML = ''; 
        destinations.forEach((dest, index) => {
            const li = document.createElement('li'); 
            li.setAttribute('data-id', dest.id); 
            li.className = "bg-white p-2.5 rounded-xl shadow-sm border border-gray-200 flex flex-col gap-1.5";
            
            let numberBadge = index === 0 && (startLocation && startLocation.lat) ? 
                `<div class="bg-indigo-600 text-white font-black w-5 h-5 rounded-full flex items-center justify-center text-[10px] shadow-sm shrink-0 ring-2 ring-indigo-200"><i class="fa-solid fa-flag text-[9px]"></i></div>` : 
                `<div class="bg-blue-600 text-white font-black w-5 h-5 rounded-full flex items-center justify-center text-[10px] shadow-sm shrink-0">${dest.displayNumber}</div>`;
            
            let customerPhoneStr = dest.phone || ""; 
            let dynamicTextSize = "text-[13px]"; 
            if (customerPhoneStr.length >= 13) dynamicTextSize = "text-[10px]"; 
            else if (customerPhoneStr.length >= 11) dynamicTextSize = "text-[11px]"; 
            else if (customerPhoneStr.length >= 9) dynamicTextSize = "text-[12px]";

            let displayAddressHTML = dest.address;
            let match = dest.address.match(/^\[(.*?)\]\s*(.*)$/);
            if (match) {
                displayAddressHTML = `
                    <span class="text-blue-600 block text-[11px] mb-0.5 leading-none">🏢 ${match[1]}</span>
                    <span class="block truncate leading-tight">${match[2]}</span>
                `;
            } else {
                displayAddressHTML = `<span class="block truncate">${dest.address}</span>`;
            }

            li.innerHTML = `
                <div class="flex items-center gap-1.5 pb-1">
                    <div class="drag-handle cursor-grab active:cursor-grabbing p-1.5 -ml-1 text-gray-400 shrink-0"><i class="fa-solid fa-bars text-[16px]"></i></div>
                    ${numberBadge}
                    <div class="font-bold text-gray-900 text-[13px] flex-1 ml-0.5 min-w-0 flex flex-col justify-center">${displayAddressHTML}</div>
                    <button onclick="editDestinationAddress(${dest.id})" class="text-gray-400 hover:text-blue-500 p-1.5 -mr-1 shrink-0"><i class="fa-solid fa-pen text-[13px]"></i></button>
                </div>
                <div id="memo-tags-${dest.id}" class="hidden flex flex-wrap gap-1 mb-1 mt-1"></div>
                <div id="memo-preview-${dest.id}" class="hidden bg-gray-50 rounded p-1.5 text-[11px] text-gray-800 border border-gray-100 truncate shadow-sm mb-1.5 mt-1"></div>
                
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
    
    initSortable();
    preloadBatchMemos().then(() => {
        destinations.forEach(dest => {
            renderMemoPreview(dest);
        });
    });
}

export async function setEndLocationGPS() {
    showLoading("현위치 파악 중...");
    if (lastKnownGps) {
        const addr = await coordToAddress(lastKnownGps.lng, lastKnownGps.lat);
        endLocation = { lat: lastKnownGps.lat, lng: lastKnownGps.lng, address: addr || "현재 위치 (GPS)" };
        saveActiveData(); renderList(); hideLoading();
        return;
    }

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            async (position) => {
                let lat = position.coords.latitude;
                let lng = position.coords.longitude;
                lastKnownGps = { lat, lng, timestamp: Date.now() };
                const addr = await coordToAddress(lng, lat);
                endLocation = { lat: lat, lng: lng, address: addr || "현재 위치 (GPS)" };
                saveActiveData(); renderList(); hideLoading();
            },
            (error) => { hideLoading(); alert("위치 정보를 가져올 수 없습니다."); },
            { enableHighAccuracy: false, timeout: 5000, maximumAge: 30000 }
        );
    } else { hideLoading(); alert("GPS를 지원하지 않는 기기입니다."); }
}

export function toggleHeaderEndEdit() { 
    document.getElementById('header-end-edit-area')?.classList.toggle('hidden'); 
}

export async function applyHeaderCustomEnd() {
    const addr = (document.getElementById('header-inline-end-input')?.value || '').trim();
    if (!addr) {
        endLocation = { lat: 0, lng: 0, address: "" };
        saveActiveData(); renderList(); toggleHeaderEndEdit(); return;
    }
    showLoading("종료 위치 찾는 중...");
    try {
        const coords = await geocodeAddress(addr);
        if (coords) {
            endLocation = { lat: coords.lat, lng: coords.lng, address: coords.address_name || addr };
            saveActiveData(); renderList(); toggleHeaderEndEdit();
        }
    } catch(error) { alert("종료지 주소를 찾을 수 없습니다."); } finally { hideLoading(); }
}

export function openTmap(lat, lng, name) { 
    window.location.href = `tmap://route?goalname=${encodeURIComponent(name)}&goalx=${lng}&goaly=${lat}`; 
}

export function openKakaoNaviDirect(lat, lng, name) { 
    if (window.Kakao && window.Kakao.isInitialized()) window.Kakao.Navi.start({ name: name, x: lng, y: lat, coordType: 'wgs84' });
    else alert("카카오 내비 모듈 오류입니다.");
}

export function selectHeightTag(btn, val) {
    const isActive = btn.dataset.active === "true";
    document.querySelectorAll('.height-tag-btn').forEach(b => { 
        b.dataset.active = "false"; 
        b.classList.remove('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
        b.classList.add('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
    });
    if (isActive) { 
        selectedHeightText = ""; 
    } else { 
        btn.dataset.active = "true"; 
        btn.classList.remove('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
        btn.classList.add('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
        selectedHeightText = `[주차장 높이 ${val}]`; 
    }
}

export function selectTimeTag(btn, val) {
    const isActive = btn.dataset.active === "true";
    document.querySelectorAll('.time-tag-btn').forEach(b => { 
        b.dataset.active = "false"; 
        b.classList.remove('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
        b.classList.add('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
    });
    if (isActive) { 
        selectedTimeText = ""; 
    } else { 
        btn.dataset.active = "true"; 
        btn.classList.remove('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
        btn.classList.add('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
        selectedTimeText = `[무료 회차 시간 ${val}]`; 
    }
}

export function toggleEtcTag(btn) {
    const isActive = btn.dataset.active === "true";
    if (isActive) { 
        btn.dataset.active = "false"; 
        btn.classList.remove('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
        btn.classList.add('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
    } else { 
        btn.dataset.active = "true"; 
        btn.classList.remove('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
        btn.classList.add('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
    }
}

export async function openMemoModal(id) {
    const item = destinations.find(d => d.id === id); 
    if (!item) return; 
    
    currentMemoAddress = getPureAddress(item.address);
    
    const titleEl = document.getElementById('memo-modal-title');
    if (titleEl) titleEl.innerText = currentMemoAddress; 
    resetMemoForm();
    
    const listContainer = document.getElementById('memo-list-container');
    if (listContainer) {
        listContainer.innerHTML = `<div class="flex justify-center items-center py-6 text-gray-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>목록을 불러오는 중...</div>`;
    }
    document.getElementById('memo-modal')?.classList.remove('hidden');

    try {
        const memos = await getMemosFromFirestore(currentMemoAddress);
        const myDeviceId = getOrCreateDeviceId();
        
        const myMemo = memos.find(m => m.deviceId === myDeviceId);
        if (myMemo) {
            const rawMemo = myMemo.memo || "";
            const heightMatch = rawMemo.match(/\[주차장 높이 (.*?)\]/);
            if (heightMatch) {
                const val = heightMatch[1];
                document.querySelectorAll('.height-tag-btn').forEach(b => {
                    if (b.innerText.trim() === val) selectHeightTag(b, val);
                });
            }

            const timeMatch = rawMemo.match(/\[무료 회차 시간 (.*?)\]/);
            if (timeMatch) {
                const val = timeMatch[1];
                document.querySelectorAll('.time-tag-btn').forEach(b => {
                    if (b.innerText.trim() === val) selectTimeTag(b, val);
                });
            }

            ['도로변 주차', '지하주차장', '지상주차장'].forEach(tag => {
                if (rawMemo.includes(`[${tag}]`)) {
                    document.querySelectorAll('.etc-tag-btn').forEach(b => {
                        if (b.dataset.val === tag && b.dataset.active !== "true") toggleEtcTag(b);
                    });
                }
            });

            const pureText = rawMemo.replace(/\[.*?\]/g, '').trim();
            const memoInput = document.getElementById('memo-input');
            const countEl = document.getElementById('memo-char-count');
            
            if (memoInput) memoInput.value = pureText;
            if (countEl) countEl.innerText = `${pureText.length} / 30`;
        }

        if (memos.length > 0) {
            let html = "";
            memos.forEach((m, idx) => {
                let isMyMemo = (m.deviceId === myDeviceId);
                let crownHtml = (idx === 0) ? `<i class="fa-solid fa-crown text-yellow-400 mr-1 text-sm drop-shadow-sm"></i> ` : '';
                let myBadge = isMyMemo ? `<span class="bg-blue-100 text-blue-700 text-[9px] font-bold px-1.5 py-0.5 rounded ml-1">내가 쓴 정보</span>` : '';
                
                html += `
                <div class="bg-white border ${isMyMemo ? 'border-blue-300 ring-1 ring-blue-200' : 'border-gray-200'} rounded-xl p-3 shadow-sm relative overflow-hidden">
                    ${idx === 0 ? '<div class="absolute top-0 left-0 w-1 h-full bg-yellow-400"></div>' : ''}
                    <div class="text-[12px] text-gray-800 font-bold whitespace-pre-line leading-relaxed mb-2 pl-1">${crownHtml}${m.memo} ${myBadge}</div>
                    <div class="flex justify-between items-center border-t border-gray-100 pt-2 mt-2">
                        <span class="text-[9px] text-gray-400">${m.time}</span>
                        <div class="flex items-center gap-1.5">
                            <button onclick="likeMemo('${m.id}')" class="text-[10px] bg-blue-50 hover:bg-blue-100 text-blue-600 px-2 py-1 rounded-lg font-bold border border-blue-100 active:scale-95 transition"><i class="fa-solid fa-thumbs-up mr-0.5"></i> ${m.likes || 0}</button>
                            <button onclick="reportMemo('${m.id}')" class="text-[10px] text-gray-400 bg-gray-50 hover:bg-red-50 hover:text-red-500 px-2 py-1 rounded-lg border border-gray-100 active:scale-95 transition">🚨 신고</button>
                        </div>
                    </div>
                </div>`;
            });
            if (listContainer) listContainer.innerHTML = html;
        } else { 
            if (listContainer) listContainer.innerHTML = `<div class="bg-white border border-gray-200 rounded-xl p-6 text-center shadow-sm"><p class="text-gray-400 text-xs font-bold">등록된 주차정보가 없습니다.<br>첫 번째 정보를 남겨주세요!</p></div>`; 
        }
    } catch (e) { 
        if (listContainer) listContainer.innerHTML = `<div class="text-red-500 text-center text-xs py-4">데이터를 불러오지 못했습니다.</div>`; 
    }
}

export function closeMemoModal() { 
    document.getElementById('memo-modal')?.classList.add('hidden'); 
}

function resetMemoForm() {
    document.querySelectorAll('.height-tag-btn, .time-tag-btn, .etc-tag-btn').forEach(b => { 
        b.dataset.active = "false"; 
        b.classList.remove('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
        b.classList.add('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
    });
    
    selectedHeightText = ""; 
    selectedTimeText = ""; 
    
    const memoInput = document.getElementById('memo-input');
    const countEl = document.getElementById('memo-char-count');
    
    if (memoInput) memoInput.value = ""; 
    if (countEl) countEl.innerText = "0 / 30";
}

export async function saveCurrentMemo() {
    const rawText = (document.getElementById('memo-input')?.value || '').trim();
    let tags = [];
    
    if (selectedHeightText) tags.push(selectedHeightText); 
    if (selectedTimeText) tags.push(selectedTimeText);
    
    document.querySelectorAll('.etc-tag-btn').forEach(btn => { 
        if (btn.dataset.active === "true") tags.push(`[${btn.dataset.val}]`); 
    });
    
    const tagString = tags.join(" "); 
    let finalMemo = "";
    if (tagString && rawText) {
        finalMemo = tagString + "\n" + rawText; 
    } else {
        finalMemo = (tagString + rawText).trim();
    }

    if (!finalMemo) { 
        alert("항목을 선택하거나 내용을 입력해주세요."); 
        return; 
    }
    
    const sensitiveRegex = /(비번|비밀번호|패스워드|#|\*|\d{4,})/g;
    if (sensitiveRegex.test(rawText)) { 
        alert("⚠️ [보안 경고]\n현관 비밀번호 등은 법적 문제로 공유할 수 없습니다."); 
        return; 
    }

    showLoading("주차정보 등록/수정 중...");
    try {
        await saveMemoToFirestore(currentMemoAddress, getOrCreateDeviceId(), finalMemo);
        hideLoading(); 
        alert("주차 정보가 등록(수정)되었습니다.");
        
        const dest = destinations.find(d => getPureAddress(d.address) === currentMemoAddress); 
        if(dest) { 
            saveActiveData(); 
            renderList(); 
            openMemoModal(dest.id); 
        }
    } catch (e) { 
        hideLoading(); 
        alert("통신 오류가 발생했습니다."); 
    }
}

export async function likeMemo(docId) {
    try {
        await likeMemoInFirestore(docId);
        const dest = destinations.find(d => getPureAddress(d.address) === currentMemoAddress);
        if(dest) { 
            saveActiveData(); 
            renderList(); 
            openMemoModal(dest.id); 
        }
    } catch (e) { 
        alert("통신 오류가 발생했습니다."); 
    }
}

export async function reportMemo(docId) {
    if (!confirm("이 메모에 부적절한 내용이 있습니까?\n신고하시면 즉시 블라인드 처리됩니다.")) return;
    
    showLoading("신고 처리 중...");
    try {
        await reportMemoInFirestore(docId);
        hideLoading(); 
        alert("신고가 접수되어 블라인드 처리되었습니다."); 
        
        const dest = destinations.find(d => getPureAddress(d.address) === currentMemoAddress);
        if(dest) { 
            saveActiveData(); 
            renderList(); 
            openMemoModal(dest.id); 
        }
    } catch (e) { 
        hideLoading(); 
        alert("통신 오류가 발생했습니다."); 
    }
}

export async function cancelDestination(id) {
    if (!confirm("이 배송지를 취소하시겠습니까?\n취소된 내역은 '지난배송' 목록에 기록됩니다.")) return;
    
    const item = destinations.find(d => d.id === id);
    if (!item) return;

    showLoading("취소 내역 기록 중...");
    try {
        const realGps = await getDeviceRealGPS();
        let actualLat = item.lat;
        let actualLng = item.lng;
        let isRealGpsCaptured = false;

        if (realGps && realGps.lat && realGps.lng) {
            actualLat = realGps.lat;
            actualLng = realGps.lng;
            isRealGpsCaptured = true;
        }

        const deviceId = getOrCreateDeviceId();
        const phone = localStorage.getItem('deliveryProUserPhone') || "";
        const cancelTag = "배송 취소";

        const completionDocId = await saveCompletionToFirestore(deviceId, phone, item, cancelTag, actualLat, actualLng, isRealGpsCaptured, null);
        archiveCompletedDelivery(item, cancelTag, completionDocId, null);

        destinations = destinations.filter(d => d.id !== id);
        updateDisplayNumbers();
    } catch (e) {
        alert("취소 처리 중 오류가 발생했습니다.");
    } finally {
        hideLoading();
    }
}

export function completeDestination(id) {
    pendingCompletionId = id;
    selectedCompTag = "";
    
    document.querySelectorAll('.comp-tag-btn').forEach(b => {
        b.classList.remove('bg-emerald-100', 'border-emerald-400', 'text-emerald-800');
        b.classList.add('bg-gray-50', 'border-gray-200', 'text-gray-700');
    });
    
    const etcContainer = document.getElementById('comp-etc-input-container');
    const etcInput = document.getElementById('comp-etc-input');
    
    if (etcContainer) etcContainer.classList.add('hidden');
    if (etcInput) etcInput.value = "";
    
    updatePhotoCompButtonState(!!localStorage.getItem('deliveryProDispatchKey'));
    document.getElementById('completion-modal')?.classList.remove('hidden');
}

export function selectCompletionTag(btn, tag) {
    document.querySelectorAll('.comp-tag-btn').forEach(b => {
        b.classList.remove('bg-emerald-100', 'border-emerald-400', 'text-emerald-800');
        b.classList.add('bg-gray-50', 'border-gray-200', 'text-gray-700');
    });
    
    btn.classList.remove('bg-gray-50', 'border-gray-200', 'text-gray-700');
    btn.classList.add('bg-emerald-100', 'border-emerald-400', 'text-emerald-800');
    
    selectedCompTag = tag;
    
    const etcContainer = document.getElementById('comp-etc-input-container');
    const etcInput = document.getElementById('comp-etc-input');
    
    if (tag === '기타') {
        if (etcContainer) etcContainer.classList.remove('hidden');
        setTimeout(() => { if (etcInput) etcInput.focus(); }, 100);
    } else { 
        if (etcContainer) etcContainer.classList.add('hidden'); 
    }
}

export function closeCompletionModal() {
    document.getElementById('completion-modal')?.classList.add('hidden');
    pendingCompletionId = null;
}

export function triggerPhotoCompletion() {
    document.getElementById('completion-photo-input')?.click();
}

export async function confirmCompletion(photoUrl = null) {
    if (typeof photoUrl !== 'string') photoUrl = null;
    
    if (!photoUrl && !selectedCompTag) { 
        alert("배송 완료 태그를 선택해 주세요."); 
        return; 
    }
    
    let finalTag = selectedCompTag;
    
    if (selectedCompTag === '기타') {
        const etcText = (document.getElementById('comp-etc-input')?.value || '').trim();
        if (!etcText && !photoUrl) { 
            alert("기타 사유를 상세하게 입력해 주세요."); 
            return; 
        }
        finalTag = etcText ? `기타: ${etcText}` : "사진 완료";
    } else if (!finalTag && photoUrl) {
        finalTag = "사진 완료";
    }

    const item = destinations.find(d => d.id === pendingCompletionId);
    if (!item) { 
        closeCompletionModal(); 
        return; 
    }

    document.getElementById('completion-modal')?.classList.add('hidden');

    const loadingMsg = photoUrl 
        ? "사진 등록 및 현장 GPS 완료 처리 중..." 
        : "현장 실제 GPS 수신 및 완료 처리 중...";
    showLoading(loadingMsg);
    
    const realGps = await getDeviceRealGPS();
    let actualLat = item.lat;
    let actualLng = item.lng;
    let isRealGpsCaptured = false;

    if (realGps && realGps.lat && realGps.lng) {
        actualLat = realGps.lat;
        actualLng = realGps.lng;
        isRealGpsCaptured = true;
    }

    const deviceId = getOrCreateDeviceId();
    const phone = localStorage.getItem('deliveryProUserPhone') || "";
    
    const completionDocId = await saveCompletionToFirestore(deviceId, phone, item, finalTag, actualLat, actualLng, isRealGpsCaptured, photoUrl);
    archiveCompletedDelivery(item, finalTag, completionDocId, photoUrl);

    destinations = destinations.filter(d => d.id !== pendingCompletionId);
    updateDisplayNumbers();
    
    hideLoading();
    closeCompletionModal();
}

export async function editDestinationAddress(id) {
    const item = destinations.find(d => d.id === id); 
    if (!item) return;
    
    const result = await promptAddressCustom("", item.address, item.phone || "", true); 
    if (!result) return;
    
    const newAddr = result.address; 
    const newPhone = result.phone;
    let addrChanged = newAddr !== item.address; 
    let phoneChanged = newPhone !== (item.phone || "");
    
    if (!addrChanged && !phoneChanged) return;

    if (addrChanged) {
        showLoading("수정된 주소 확인 중...");
        try {
            const coords = await geocodeAddress(newAddr.trim());
            if (coords) { 
                item.address = coords.address_name || newAddr.trim(); 
                item.lat = coords.lat; 
                item.lng = coords.lng; 
            }
        } catch (e) { 
            alert("수정된 주소를 지도에서 찾을 수 없습니다."); 
            hideLoading(); 
            return; 
        } finally { 
            hideLoading(); 
        }
    }
    item.phone = newPhone; 
    saveActiveData(); 
    renderList();
}

function showLoading(text) { 
    const elText = document.getElementById('loading-text');
    const elOverlay = document.getElementById('loading-overlay');
    if (elText) elText.innerText = text; 
    if (elOverlay) elOverlay.classList.remove('hidden'); 
}

function hideLoading() { 
    const elOverlay = document.getElementById('loading-overlay');
    if (elOverlay) elOverlay.classList.add('hidden'); 
}

export async function logout() {
    if (!confirm("로그아웃 하시겠습니까?\n로그아웃 시 기기 정보가 초기화되어 다른 기기에서 로그인할 수 있습니다.")) return;
    
    const currentKey = localStorage.getItem('deliveryProKey');
    if (currentKey && typeof firebaseClearDeviceData === 'function') {
        try {
            await firebaseClearDeviceData(currentKey);
        } catch (e) {
            console.error("서버 초기화 중 오류 발생:", e);
        }
    }
    
    try { if (typeof licenseWatcherUnsub === 'function') { licenseWatcherUnsub(); } } catch(e) {}
    try { if (typeof dispatchMsgWatcherUnsub === 'function') { dispatchMsgWatcherUnsub(); } } catch(e) {}
    try { if (typeof gpsRequestWatcherUnsub === 'function') { gpsRequestWatcherUnsub(); } } catch(e) {}

    clearAuthStorage();
    window.location.reload();
}

const MAX_MONTHLY_SCANS = 1250; 
const SCAN_COOLDOWN_MS = 1000;

function checkScanLimit() {
    const now = Date.now();
    const currentMonth = new Date().toISOString().slice(0, 7);
    const lastScanTime = localStorage.getItem('deliveryProLastScanTime');
    
    if (lastScanTime && (now - parseInt(lastScanTime) < SCAN_COOLDOWN_MS)) { 
        alert("1초 후 다시 스캔해주세요."); 
        return false; 
    }
    
    let scanData = JSON.parse(localStorage.getItem('deliveryProScanData') || '{"month": "", "count": 0}');
    if (scanData.month !== currentMonth) { 
        scanData = { month: currentMonth, count: 0 }; 
    }
    
    if (scanData.count >= MAX_MONTHLY_SCANS) { 
        alert(`⚠️ 월간 최대 스캔 한도(${MAX_MONTHLY_SCANS}장) 초과.`); 
        return false; 
    }
    
    scanData.count++;
    localStorage.setItem('deliveryProScanData', JSON.stringify(scanData));
    localStorage.setItem('deliveryProLastScanTime', now.toString());
    
    return true;
}

async function performOCR(base64Data) {
    const response = await fetch('/api/ocr', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ imageContent: base64Data }) 
    });
    const data = await response.json();
    
    if (data.error) throw new Error(data.error);
    if (data.responses && data.responses[0].error) throw new Error(data.responses[0].error.message);
    if (data.responses && data.responses[0].fullTextAnnotation) return data.responses[0].fullTextAnnotation.text;
    
    throw new Error("사진에서 글자를 찾을 수 없습니다.");
}

export function promptAddressCustom(snippet, defaultText, defaultPhone = "", isEditMode = false) {
    return new Promise((resolve) => {
        const modal = document.getElementById('address-input-modal');
        const addrInput = document.getElementById('manual-address-input');
        const phoneInput = document.getElementById('manual-phone-input');
        const snippetEl = document.getElementById('ocr-snippet');
        const snippetContainer = document.getElementById('ocr-snippet-container');
        const titleEl = document.getElementById('address-modal-title');
        const descEl = document.getElementById('address-modal-desc');
        const btnConfirm = document.getElementById('address-modal-confirm');
        const btnCancel = document.getElementById('address-modal-cancel');

        if (isEditMode) {
            if(titleEl) titleEl.innerText = "정보 확인 및 수정"; 
            if(descEl) descEl.innerText = "정확한 배송지 정보를 입력해 주세요.";
            if(snippetContainer) snippetContainer.classList.add('hidden');
        } else {
            if(titleEl) titleEl.innerText = "주소 확인"; 
            if(descEl) descEl.innerText = "인식 오류 시 직접 입력해 주세요";
            if(snippetContainer) snippetContainer.classList.remove('hidden'); 
            if(snippetEl) snippetEl.innerText = snippet || "인식된 텍스트가 없습니다.";
        }

        if(addrInput) addrInput.value = defaultText || ""; 
        if(phoneInput) phoneInput.value = defaultPhone || "";
        if(modal) modal.classList.remove('hidden');
        
        setTimeout(() => { if(addrInput) addrInput.focus(); }, 100);

        const onConfirm = () => { 
            cleanup(); 
            resolve({ address: addrInput.value.trim(), phone: phoneInput.value.trim() }); 
        };
        const onCancel = () => { 
            cleanup(); 
            resolve(null); 
        };
        const cleanup = () => { 
            btnConfirm.removeEventListener('click', onConfirm); 
            btnCancel.removeEventListener('click', onCancel); 
            if(modal) modal.classList.add('hidden'); 
        };
        
        btnConfirm.addEventListener('click', onConfirm); 
        btnCancel.addEventListener('click', onCancel);
    });
}

// ==========================================
// 🚀 메인 스캔 로직 (카카오 하이브리드 + Fallback 매칭 적용)
// ==========================================
export function initCameraScan() {
    const cameraInput = document.getElementById('camera-input');
    if (!cameraInput) return;
    
    cameraInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!checkScanLimit()) { e.target.value = ''; return; }

        let addressStr = null; 
        let rawOCRText = ""; 
        let extractedPhone = null;
        
        // 1. OCR 판독
        showLoading("사진 판독 중...");
        try {
            const base64Image = await toBase64_SafeCompress(file);
            const imageContent = base64Image.split(',')[1];
            rawOCRText = await performOCR(imageContent);
            addressStr = extractAddressLogic(rawOCRText);
            extractedPhone = extractPhoneLogic(rawOCRText);
            hideLoading();
        } catch (error) {
            hideLoading();
            const result = await promptAddressCustom("사진 인식 실패", "", "", false);
            if (!result || !result.address) { e.target.value = ''; return; }
            addressStr = result.address; 
            extractedPhone = result.phone;
        }

        if (!addressStr && rawOCRText) {
            let snippet = rawOCRText.replace(/\n/g, ' ').substring(0, 40);
            const result = await promptAddressCustom(snippet + "...", "", extractedPhone, false);
            if (!result || !result.address) { e.target.value = ''; return; }
            addressStr = result.address; 
            extractedPhone = result.phone;
        }

        // 2. 주소 좌표 획득
        let coords = null;
        while (!coords) {
            try {
                showLoading("지도 위치 확인 중...");
                coords = await geocodeAddress(addressStr);
                hideLoading();
            } catch (error) {
                hideLoading();
                const result = await promptAddressCustom("지도에서 주소를 찾을 수 없습니다.", addressStr, extractedPhone, true);
                if (!result || !result.address) { e.target.value = ''; return; }
                addressStr = result.address; 
                extractedPhone = result.phone;
            }
        }

        // 3. 하이브리드 상호명 매칭 (카카오 API 최우선 -> 실패 시 기존 로직 사용)
        let finalStoreName = null;
        if (addressStr && rawOCRText) {
            showLoading("상호명 AI 매칭 중...");
            try {
                // A. 카카오 정답지 확보
                let addressPlaces = await getPOIsByAddress(addressStr);
                let categoryPlaces = (coords && coords.lat && coords.lng) ? await getNearbyPOIs(coords.lat, coords.lng) : [];
                let combinedPlaces = [...new Set([...addressPlaces, ...categoryPlaces])];

                // B. 카카오 기반 1차 매칭 시도
                finalStoreName = findStoreNameFromOCR(rawOCRText, combinedPlaces);

                // C. 카카오 매칭이 실패했다면 기존(Fallback) 로직으로 2차 시도
                if (!finalStoreName) {
                    finalStoreName = extractStoreNameLogic(rawOCRText);
                }
            } catch (error) {
                console.error("상호명 매칭 오류:", error);
                // 에러가 났을 때도 최후의 보루로 기존 로직 실행
                if (!finalStoreName) {
                    finalStoreName = extractStoreNameLogic(rawOCRText);
                }
            }
            hideLoading();
        }

        // 4. 리스트 추가
        if (coords) {
            let resolvedAddress = coords.address_name || addressStr;
            if (finalStoreName && !resolvedAddress.includes(finalStoreName)) {
                resolvedAddress = `[${finalStoreName}] ${resolvedAddress}`;
            }

            let nextNum = destinations.length > 0 ? Math.max(...destinations.map(d => d.displayNumber)) + 1 : 1;
            const newDestId = idCounter++; 
            destinations.push({
                id: newDestId, 
                address: resolvedAddress,
                lat: coords.lat, 
                lng: coords.lng, 
                phone: extractedPhone, 
                displayNumber: nextNum
            });
            
            saveActiveData(); 
            renderList();
            
            setTimeout(() => { 
                const newEl = document.querySelector(`li[data-id="${newDestId}"]`); 
                if (newEl) newEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); 
            }, 150);
        }
        e.target.value = ''; 
    });
}

export function initPhotoCompletion() {
    const photoInput = document.getElementById('completion-photo-input');
    if (!photoInput) return;

    photoInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        document.getElementById('completion-modal')?.classList.add('hidden');

        showLoading("사진 압축 및 서버 전송 중...");
        try {
            const deviceId = getOrCreateDeviceId();
            const photoUrl = await firebaseUploadDeliveryPhoto(file, deviceId);
            await confirmCompletion(photoUrl);
        } catch (err) {
            hideLoading();
            alert("사진 전송 중 오류가 발생했습니다: " + err.message);
        } finally {
            e.target.value = '';
        }
    });
}

// ==========================================
// Window 전역 객체 바인딩 (메인 앱 액션)
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

window.appActions = {
    initApp, 
    optimizeRouteAction, 
    getDeviceRealGPS, 
    renderList
};