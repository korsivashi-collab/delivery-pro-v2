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
let dispatchMsgWatcherUnsub = null; // 🌟 추가: 관제 메시지 리스너 해제용 변수
let gpsRequestWatcherUnsub = null;  // 🌟 추가: GPS 요청 리스너 해제용 변수
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

// 🌟 메인 최적화 실행 함수 (optimizer.js 모듈 호출)
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
            // optimizer.js에 있는 엔진 호출
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


// 화면 렌더링 및 UI 바인딩 함수들은 브라우저 전역(window)으로 등록하여 HTML과 연결
window.appActions = {
    initApp, optimizeRouteAction, getDeviceRealGPS
};

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
    
    try {
        if (typeof licenseWatcherUnsub === 'function') { licenseWatcherUnsub(); }
    } catch(e) {}

    try {
        if (typeof dispatchMsgWatcherUnsub === 'function') { dispatchMsgWatcherUnsub(); }
    } catch(e) {}

    try {
        if (typeof gpsRequestWatcherUnsub === 'function') { gpsRequestWatcherUnsub(); }
    } catch(e) {}

    localStorage.removeItem('deliveryProKey');
    localStorage.removeItem('deliveryProUserPhone');
    localStorage.removeItem('deliveryProExpireDate');
    localStorage.removeItem('deliveryProDispatchKey');
    
    window.location.reload();
}

window.logout = logout;