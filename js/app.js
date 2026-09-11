// js/app.js
import { calculateOptimizedRoute } from './optimizer.js';
import { 
    firebaseVerifyLicense, watchLicenseStatus, startGpsRequestLister, 
    startDispatchMessageListener, firebaseStartTrial, getMemosFromFirestore, 
    getBatchMemosFromFirestore, saveMemoToFirestore, likeMemoInFirestore, 
    reportMemoInFirestore, saveRouteToFirestore, saveCompletionToFirestore, 
    deleteCompletionFromFirestore, firebaseClearDeviceData, firebaseUploadDeliveryPhoto 
} from './api.js';
import { toBase64_SafeCompress, extractPhoneLogic, extractAddressLogic } from './utils.js';

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
let currentActiveAlertMsgId = null;
let lastKnownGps = null;
let gpsWatchId = null;

// 디바이스 고유 ID 생성
export function getOrCreateDeviceId() {
    let deviceId = localStorage.getItem('deliveryProDeviceId');
    if (!deviceId) {
        deviceId = 'DEV-' + Math.random().toString(36).substring(2, 10) + '-' + Date.now().toString(36);
        localStorage.setItem('deliveryProDeviceId', deviceId);
    }
    return deviceId;
}

// GPS 와처 시작
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

// 실시간 GPS 가져오기
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

// 앱 초기화 및 이벤트 바인딩
export async function initApp() {
    localStorage.removeItem('deliveryPro_start_location'); 
    loadActiveData();
    cleanOldHistory();
    initSwipeButton();
    startGpsWatcher();
    checkUnreadNotices();
    
    const savedKey = localStorage.getItem('deliveryProKey');
    const savedPhone = localStorage.getItem('deliveryProUserPhone');
    const bootScreen = document.getElementById('boot-screen');

    if (savedKey) document.getElementById('license-input').value = savedKey;
    if (savedPhone) document.getElementById('auth-phone-input').value = savedPhone;

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
                document.getElementById('auth-message').innerText = res.msg;
                document.getElementById('auth-screen').classList.remove('hidden');
            }
        } catch (e) {
            document.getElementById('auth-message').innerText = "보안 통신 오류가 발생했습니다. 네트워크를 확인해 주세요.";
            document.getElementById('auth-screen').classList.remove('hidden');
        }
    } else {
        document.getElementById('auth-screen').classList.remove('hidden');
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
        window.location.reload();
    }, (docData) => {
        const linkedKey = docData.dispatchKey || '';
        localStorage.setItem('deliveryProDispatchKey', linkedKey);
        updatePhotoCompButtonState(!!linkedKey);
    });
}

function unlockApp() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
    document.getElementById('main-app').classList.add('flex');
    updateExpireBadge(); 
    startGpsWatcher();
}

function updateExpireBadge(serverDate) {
    const badge = document.getElementById('license-expire-badge');
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

// 팝업 및 알림함 관리
export function showDispatchAlertPopup(content, timeStr, msgId, senderTitle, senderType) {
    currentActiveAlertMsgId = msgId;
    const isMaster = (senderType === 'MASTER' || senderTitle === '운영사 알림');
    const title = senderTitle || (isMaster ? '운영사 알림' : '회사 알림');

    const modalBox = document.getElementById('dispatch-alert-box');
    const iconBox = document.getElementById('dispatch-alert-icon-box');
    const badge = document.getElementById('dispatch-alert-badge');

    if (isMaster) {
        if (modalBox) modalBox.className = "bg-white w-full max-w-sm rounded-3xl p-6 shadow-2xl relative border-2 border-amber-500 text-center";
        if (iconBox) iconBox.className = "w-14 h-14 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center text-2xl mx-auto mb-3 shadow-inner animate-bounce";
        if (badge) { badge.className = "bg-amber-500 text-white text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-wider"; badge.innerText = title; }
    } else {
        if (modalBox) modalBox.className = "bg-white w-full max-w-sm rounded-3xl p-6 shadow-2xl relative border-2 border-blue-500 text-center";
        if (iconBox) iconBox.className = "w-14 h-14 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center text-2xl mx-auto mb-3 shadow-inner animate-bounce";
        if (badge) { badge.className = "bg-blue-600 text-white text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-wider"; badge.innerText = title; }
    }

    document.getElementById('dispatch-alert-content').innerText = content;
    document.getElementById('dispatch-alert-time').innerText = `${timeStr || '방금'} 수신`;
    document.getElementById('dispatch-alert-modal').classList.remove('hidden');

    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    playBeepSound();
    checkUnreadNotices();
}

function playBeepSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = 880; gain.gain.value = 0.3;
        osc.start();
        setTimeout(() => { osc.stop(); }, 250);
    } catch(e) {}
}

function saveMessageToLocalHistory(msgId, content, dateStr, timeStr, senderTitle, senderType) {
    let notices = JSON.parse(localStorage.getItem('deliveryPro_notices') || '[]');
    const isMaster = (senderType === 'MASTER' || senderTitle === '운영사 알림');
    const finalTitle = senderTitle || (isMaster ? '운영사 알림' : '회사 알림');

    if (!notices.some(n => n.msgId === msgId)) {
        notices.unshift({
            msgId: msgId, content: content,
            dateStr: dateStr || new Date().toISOString().split('T')[0],
            timeStr: timeStr || '00:00',
            senderTitle: finalTitle,
            senderType: senderType || (isMaster ? 'MASTER' : 'DISPATCH'),
            timestamp: Date.now()
        });
        if (notices.length > 50) notices = notices.slice(0, 50);
        localStorage.setItem('deliveryPro_notices', JSON.stringify(notices));
        checkUnreadNotices();
    }
}

function checkUnreadNotices() {
    const dot = document.getElementById('notice-unread-dot');
    if (!dot) return;
    const notices = JSON.parse(localStorage.getItem('deliveryPro_notices') || '[]');
    const unread = notices.some(n => !localStorage.getItem(`acked_msg_${n.msgId}`));
    if (unread) dot.classList.remove('hidden');
    else dot.classList.add('hidden');
}

// 🌟 메인 최적화 실행 함수
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
    if (savedList) { try { destinations = JSON.parse(savedList); } catch (e) { destinations = []; } }
    
    const savedEnd = localStorage.getItem('deliveryPro_end_location');
    if (savedEnd) { try { endLocation = JSON.parse(savedEnd); } catch(e){} }
    renderList();
}

// 🌟 누락되었던 리스트 렌더링 및 UI 연동 함수 추가
function initSortable() {
    const el = document.getElementById('destination-list');
    if (sortableInstance) sortableInstance.destroy();
    
    if (window.Sortable) {
        sortableInstance = new Sortable(el, {
            handle: '.drag-handle', animation: 250, easing: "cubic-bezier(0.25, 1, 0.5, 1)", delay: 200, delayOnTouchOnly: true, forceFallback: true, fallbackClass: "sortable-drag", fallbackOnBody: true, swapThreshold: 0.4, invertSwap: true, scroll: true, scrollSensitivity: 80, scrollSpeed: 20, fallbackTolerance: 5, filter: '.no-drag', ghostClass: 'sortable-ghost',
            onEnd: function (evt) {
                const liElements = el.querySelectorAll('li[data-id]');
                const newOrderIds = Array.from(liElements).map(li => parseInt(li.getAttribute('data-id')));
                const newDestinations = [];
                newOrderIds.forEach(id => { const found = destinations.find(d => d.id === id); if(found) newDestinations.push(found); });
                destinations = newDestinations; 
                updateDisplayNumbers(); 
            }
        });
    }
}

async function preloadBatchMemos() {
    if (destinations.length === 0) return;
    const addresses = destinations.map(d => d.address);
    try { 
        batchMemosCache = await getBatchMemosFromFirestore(addresses); 
    } catch (e) { 
        batchMemosCache = {}; 
    }
}

function renderMemoPreview(dest) {
    const previewEl = document.getElementById(`memo-preview-${dest.id}`); 
    const tagsEl = document.getElementById(`memo-tags-${dest.id}`);
    if (!previewEl || !tagsEl) return;
    const memos = batchMemosCache[dest.address] || []; 
    const memoText = memos.length > 0 ? memos[0].memo : null;

    if (memoText) {
        const tagRegex = /\[(.*?)\]/g; let tags = []; let match;
        while ((match = tagRegex.exec(memoText)) !== null) {
            let text = match[1]; text = text.replace('주차장 높이 ', '높이:'); text = text.replace('무료 회차 시간 ', '회차:'); tags.push(text);
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

export async function renderList() {
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

    await preloadBatchMemos();
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

            li.innerHTML = `
                <div class="flex items-center gap-1.5 pb-1">
                    <div class="drag-handle cursor-grab active:cursor-grabbing p-1.5 -ml-1 text-gray-400 shrink-0"><i class="fa-solid fa-bars text-[16px]"></i></div>
                    ${numberBadge}
                    <p class="font-bold text-gray-900 text-[13px] truncate flex-1 ml-0.5">${dest.address}</p>
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
            renderMemoPreview(dest);
        });
    }
    initSortable();
}

// 로그아웃 함수
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

    localStorage.removeItem('deliveryProKey');
    localStorage.removeItem('deliveryProUserPhone');
    localStorage.removeItem('deliveryProExpireDate');
    localStorage.removeItem('deliveryProDispatchKey');
    
    window.location.reload();
}

window.logout = logout;
window.renderList = renderList;

// 화면 렌더링 및 UI 바인딩 함수들은 브라우저 전역(window)으로 등록하여 HTML과 연결
window.appActions = {
    initApp, optimizeRouteAction, getDeviceRealGPS, renderList
};