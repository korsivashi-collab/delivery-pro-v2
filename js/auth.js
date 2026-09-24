// js/auth.js

// =================================================================
// [배송 동선 PRO] 라이선스 인증, 보안 감시 및 기기 관리 전담 모듈
// =================================================================

import { 
    firebaseVerifyLicense, 
    watchLicenseStatus, 
    startGpsRequestLister, 
    startDispatchMessageListener, 
    firebaseStartTrial, 
    firebaseClearDeviceData,
    checkIfDeviceBlocked,
    syncMyParkingMemosFromServer,
    listenToActiveRoutes
} from './api.js';
import { 
    saveMessageToLocalHistory, 
    showDispatchAlertPopup 
} from './support.js';
import { getDeviceRealGPS, startGpsWatcher } from './gps.js';

let licenseWatcherUnsub = null;
let dispatchMsgWatcherUnsub = null;  
let gpsRequestWatcherUnsub = null;  
let activeRoutesWatcherUnsub = null; // 관제 실시간 동선 수신 리스너 구독 해제용 변수

let onRemoteRoutesReceivedCallback = null;
let onRemoteRoutesClearedCallback = null;

// ==========================================
// 0. 관제 자동할당 동선 수신 핸들러 등록 (app.js 연동용)
// ==========================================
export function setRemoteRoutesHandler(onReceived, onCleared) {
    onRemoteRoutesReceivedCallback = onReceived;
    onRemoteRoutesClearedCallback = onCleared;
}

// ==========================================
// 1. 기기 고유 식별자(Device ID) 발급 및 조회
// ==========================================
export function getOrCreateDeviceId() {
    let deviceId = localStorage.getItem('deliveryProDeviceId');
    if (!deviceId) {
        deviceId = 'DEV-' + Math.random().toString(36).substring(2, 10) + '-' + Date.now().toString(36);
        localStorage.setItem('deliveryProDeviceId', deviceId);
    }
    return deviceId;
}

// ==========================================
// 2. 인증 정보 로컬 스토리지 초기화
// ==========================================
export function clearAuthStorage() {
    localStorage.removeItem('deliveryProKey');
    localStorage.removeItem('deliveryProUserPhone');
    localStorage.removeItem('deliveryProExpireDate');
    localStorage.removeItem('deliveryProDispatchKey');
}

// ==========================================
// 3. UI 갱신 (유효기간 뱃지 & 관제 연결 버튼 상태)
// ==========================================
export function updateExpireBadge(serverDate) {
    const badge = document.getElementById('license-expire-badge');
    if (!badge) return;
    const cachedDate = localStorage.getItem('deliveryProExpireDate');
    const expireDate = serverDate || cachedDate || "2026.12.31";
    if (serverDate) localStorage.setItem('deliveryProExpireDate', serverDate);
    badge.innerText = `사용기한: ${expireDate}`;
    badge.classList.remove('hidden');
}

export function updatePhotoCompButtonState(isLinked) {
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

// ==========================================
// 4. 앱 화면 잠금 해제 (메인 화면 진입)
// ==========================================
export function unlockApp() {
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

// ==========================================
// 5. 라이선스 실시간 상태 감시 (정지/만료 감지)
// ==========================================
export function startLicenseRealtimeWatcher(key) {
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

// ==========================================
// 6. 인증 성공 시 백그라운드 서비스 일괄 가동
// ==========================================
export function startActiveServices(deviceId, phone, key, expireDate, dispatchKey) {
    unlockApp();
    updateExpireBadge(expireDate);
    startLicenseRealtimeWatcher(key);

    // [기여도 동기화] 마스터 센터에 집계된 전화번호 기반 작성 메모 전체 동기화 실행
    if (typeof syncMyParkingMemosFromServer === 'function') {
        syncMyParkingMemosFromServer(phone, deviceId, key);
    }

    // 관제/운영사 메시지 실시간 감시
    if (dispatchMsgWatcherUnsub) dispatchMsgWatcherUnsub();
    dispatchMsgWatcherUnsub = startDispatchMessageListener(deviceId, phone, key, (msg) => {
        saveMessageToLocalHistory(msg.msgId, msg.content, msg.dateStr, msg.timeStr, msg.senderTitle, msg.senderType);
        const alreadyAcked = localStorage.getItem(`acked_msg_${msg.msgId}`);
        if (!alreadyAcked) {
            showDispatchAlertPopup(msg.content, msg.timeStr || '', msg.msgId, msg.senderTitle, msg.senderType);
        }
    });

    // 관제 GPS 위치 요청 감시
    if (gpsRequestWatcherUnsub) gpsRequestWatcherUnsub();
    gpsRequestWatcherUnsub = startGpsRequestLister(deviceId, phone, key, getDeviceRealGPS);

    // 🌟 관제 센터 실시간 자동할당 동선 감시 (routes/{deviceId} 구독)
    if (activeRoutesWatcherUnsub) activeRoutesWatcherUnsub();
    activeRoutesWatcherUnsub = listenToActiveRoutes(
        deviceId, 
        (destinations, data) => {
            if (onRemoteRoutesReceivedCallback) {
                onRemoteRoutesReceivedCallback(destinations, data);
            }
        }, 
        () => {
            if (onRemoteRoutesClearedCallback) {
                onRemoteRoutesClearedCallback();
            }
        }
    );

    updatePhotoCompButtonState(!!dispatchKey);
}

// ==========================================
// 7. 자동 로그인 (부팅 시 기존 저장된 키 검증)
// ==========================================
export async function checkSavedAuth() {
    const deviceId = getOrCreateDeviceId();

    // [보안 검문] 기기 고유번호(deviceId) 접속 제한 검사
    try {
        const isBlocked = await checkIfDeviceBlocked(deviceId);
        if (isBlocked) {
            window.location.replace('error.html');
            return;
        }
    } catch (err) {}

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
        try {
            const res = await firebaseVerifyLicense(savedKey, savedPhone, deviceId);
            if (res.valid) {
                localStorage.setItem('deliveryProDispatchKey', res.dispatchKey || '');
                startActiveServices(deviceId, savedPhone, res.actualKey || savedKey, res.expireDate, res.dispatchKey);
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

// ==========================================
// 8. 수동 라이선스 키 인증 (로그인 버튼 클릭)
// ==========================================
export async function verifyLicense() {
    const keyInput = (document.getElementById('license-input')?.value || '').trim().toUpperCase();
    const rawPhone = (document.getElementById('auth-phone-input')?.value || '').trim();
    const msgEl = document.getElementById('auth-message');
    const btn = document.getElementById('verify-btn');
    const deviceId = getOrCreateDeviceId(); 

    // [보안 검문] 기기 고유번호(deviceId) 접속 제한 검사
    try {
        const isBlocked = await checkIfDeviceBlocked(deviceId);
        if (isBlocked) {
            window.location.replace('error.html');
            return;
        }
    } catch (err) {}
    
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
            
            startActiveServices(deviceId, formattedPhone, actualKey, res.expireDate, res.dispatchKey);
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

// ==========================================
// 9. 7일 무료 체험 모달 제어 및 신청
// ==========================================
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

    // [보안 검문] 기기 고유번호(deviceId) 접속 제한 검사
    try {
        const isBlocked = await checkIfDeviceBlocked(deviceId);
        if (isBlocked) {
            window.location.replace('error.html');
            return;
        }
    } catch (err) {}
    
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
            
            startActiveServices(deviceId, phoneInput, res.trialKey, res.expireDate, res.dispatchKey);
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

// ==========================================
// 10. 로그아웃 (기기 연동 해제 및 초기화)
// ==========================================
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
    try { if (typeof activeRoutesWatcherUnsub === 'function') { activeRoutesWatcherUnsub(); } } catch(e) {}

    clearAuthStorage();
    window.location.reload();
}