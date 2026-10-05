import { state } from './state.js';
// js/auth.js

// =================================================================
// [배송 동선 PRO] 라이선스 인증, 보안 감시 및 기기 관리 전담 모듈
// =================================================================

import { 
    firebaseVerifyLicense, 
    watchLicenseStatus, 
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
import { startGpsWatcher, stopGpsWatcher } from './gps.js';
import { AUTH_FAILURE_MESSAGE, loginWithSecret, restoreFirebaseSession, signOutFirebaseSession,
    getVerifiedAuthSession, onVerifiedSessionInvalidated } from './admin-api.js';

let licenseWatcherUnsub = null;
let dispatchMsgWatcherUnsub = null;  
let activeRoutesWatcherUnsub = null;

let onRemoteRoutesReceivedCallback = null;
let onRemoteRoutesClearedCallback = null;
let cachedRemoteRoutes = null;
let savedAuthCheck = null;
let driverLoginInProgress = false;
let driverAuthObserver = null;
let activeDriverUid = null;
let trialAttempt = 0;

function lockDriverScreen() {
    const main = document.getElementById('main-app');
    if (main) { main.classList.add('hidden'); main.classList.remove('flex'); }
    document.getElementById('auth-screen')?.classList.remove('hidden');
}
function prepareDriverAuth() {
    const input = document.getElementById('license-input');
    // The existing input is reused; base64url secrets must not appear uppercased.
    if (input) { input.classList.remove('uppercase'); input.autocapitalize = 'none'; input.spellcheck = false; }
    if (!driverAuthObserver) driverAuthObserver = onVerifiedSessionInvalidated(() => {
        if (activeDriverUid) { clearAuthStorage(); lockDriverScreen(); }
    });
}
async function activateVerifiedDriver(identity, phone = null, expectedType = null) {
    if (!identity || identity.role !== 'driver' || getVerifiedAuthSession('driver') !== identity) throw new Error(AUTH_FAILURE_MESSAGE);
    const deviceId = getOrCreateDeviceId();
    if (await checkIfDeviceBlocked(deviceId)) throw new Error(AUTH_FAILURE_MESSAGE);
    const key = identity.accountRef.slice('licenses/'.length);
    const result = await firebaseVerifyLicense(key, phone, deviceId, expectedType);
    if (!result?.valid || getVerifiedAuthSession('driver') !== identity) throw new Error(AUTH_FAILURE_MESSAGE);
    localStorage.setItem('deliveryProKey', result.actualKey);
    localStorage.setItem('deliveryProUserPhone', result.phone);
    localStorage.setItem('deliveryProDispatchKey', result.dispatchKey || '');
    if (result.expireDate) localStorage.setItem('deliveryProExpireDate', result.expireDate);
    activeDriverUid = identity.uid;
    startActiveServices(deviceId, result.phone, result.actualKey, result.expireDate, result.dispatchKey, result.routeOwnerId);
}

// 인증 성공 시 전달된 정식 라이선스 키로만 설정 범위를 선택한다.
let gpsPreferenceStorageKey = null;
let gpsPreferenceEnabled = false;

function syncGpsPreferenceToggle() {
    const toggle = document.getElementById('gps-toggle');
    if (!toggle) return;
    toggle.checked = gpsPreferenceEnabled;
    toggle.disabled = !gpsPreferenceStorageKey;
}

function resetGpsPreferenceSession() {
    stopGpsWatcher();
    gpsPreferenceStorageKey = null;
    gpsPreferenceEnabled = false;
    syncGpsPreferenceToggle();
}

function restoreGpsPreference(verifiedKey) {
    resetGpsPreferenceSession();
    if (typeof verifiedKey !== 'string' || !verifiedKey) return;
    gpsPreferenceStorageKey = `deliveryPro_gps_enabled:${encodeURIComponent(verifiedKey)}`;
    try {
        const saved = localStorage.getItem(gpsPreferenceStorageKey);
        // 저장값이 없는 계정만 기존 기본값 ON을 적용한다.
        gpsPreferenceEnabled = saved === null || saved === 'true';
    } catch (error) {
        console.warn('GPS 설정 복구 실패:', error);
        alert('GPS 설정을 읽을 수 없어 위치 확인을 중단했습니다. 저장소 상태를 확인한 후 다시 설정해 주세요.');
    }
    syncGpsPreferenceToggle();
}

function applyGpsPreference() {
    syncGpsPreferenceToggle();
    if (gpsPreferenceStorageKey && gpsPreferenceEnabled) startGpsWatcher();
    else stopGpsWatcher();
}

export function setGpsPreference(enabled) {
    if (!gpsPreferenceStorageKey || typeof enabled !== 'boolean') {
        syncGpsPreferenceToggle();
        return false;
    }
    try {
        localStorage.setItem(gpsPreferenceStorageKey, String(enabled));
    } catch (error) {
        console.warn('GPS 설정 저장 실패:', error);
        syncGpsPreferenceToggle();
        alert('GPS 설정을 저장하지 못했습니다. 기존 설정을 유지합니다. 저장소 상태를 확인한 후 다시 시도해 주세요.');
        return false;
    }
    gpsPreferenceEnabled = enabled;
    applyGpsPreference();
    return true;
}

// ==========================================
// 0. 관제 자동할당 동선 수신 핸들러 등록 (app.js 연동용)
// ==========================================
export function setRemoteRoutesHandler(onReceived, onCleared) {
    onRemoteRoutesReceivedCallback = onReceived;
    onRemoteRoutesClearedCallback = onCleared;

    // 리스너가 이미 데이터를 먼저 받아놓은 경우 등록 즉시 지연 없이 전달
    if (cachedRemoteRoutes && typeof onRemoteRoutesReceivedCallback === 'function') {
        onRemoteRoutesReceivedCallback(cachedRemoteRoutes.destinations, cachedRemoteRoutes.data);
    }
}

// ==========================================
// 0-1. 로컬스토리지 기반 날짜 대조 만료 검사 (서버 호출 0회)
// ==========================================
export function isLicenseExpiredLocally() {
    const expireDateStr = localStorage.getItem('deliveryProExpireDate');
    if (!expireDateStr) return false;
    try {
        const parts = expireDateStr.split('.');
        if (parts.length === 3) {
            const expireDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 23, 59, 59);
            return new Date() > expireDate;
        }
    } catch (e) {
        console.warn("로컬 날짜 파싱 오류:", e);
    }
    return false;
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
    trialAttempt++;
    activeDriverUid = null;
    resetGpsPreferenceSession();
    for (const unsubscribe of [licenseWatcherUnsub, dispatchMsgWatcherUnsub, activeRoutesWatcherUnsub]) {
        try { if (typeof unsubscribe === 'function') unsubscribe(); } catch (_) {}
    }
    licenseWatcherUnsub = null;
    dispatchMsgWatcherUnsub = null;
    activeRoutesWatcherUnsub = null;
    cachedRemoteRoutes = null;
    state.deactivateRouteOwner();
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
    applyGpsPreference();
}

// ==========================================
// 5. 라이선스 상태 감시 (단발성 getDoc 최적화 감시 연동)
// ==========================================
export function startLicenseRealtimeWatcher(key) {
    if (licenseWatcherUnsub) licenseWatcherUnsub();
    licenseWatcherUnsub = watchLicenseStatus(key, async (status, msg) => {
        alert(`⚠️ [라이선스 알림]\n${msg}`);
        clearAuthStorage();
        const mainApp = document.getElementById('main-app');
        const authScreen = document.getElementById('auth-screen');
        if (mainApp) { mainApp.classList.add('hidden'); mainApp.classList.remove('flex'); }
        if (authScreen) authScreen.classList.remove('hidden');
        try { await signOutFirebaseSession(); window.location.reload(); }
        catch { lockDriverScreen(); }
    }, (docData) => {
        const linkedKey = docData.dispatchKey || '';
        localStorage.setItem('deliveryProDispatchKey', linkedKey);
        updatePhotoCompButtonState(!!linkedKey);
    });
}

// ==========================================
// 6. 인증 성공 시 백그라운드 서비스 일괄 가동
// ==========================================
export function startActiveServices(deviceId, phone, key, expireDate, dispatchKey, routeOwnerId) {
    state.activateRouteOwner(routeOwnerId);
    restoreGpsPreference(key);
    cachedRemoteRoutes = null;
    if (typeof window.renderList === 'function') window.renderList();
    unlockApp();
    updateExpireBadge(expireDate);
    startLicenseRealtimeWatcher(key);

    // [기여도 동기화] 마스터 센터에 집계된 전화번호 기반 작성 메모 전체 동기화 실행
    if (typeof syncMyParkingMemosFromServer === 'function') {
        syncMyParkingMemosFromServer(phone, deviceId, key);
    }

    // 관제/운영사 메시지 실시간 감시 (최신 5건 한정 구독)
    if (dispatchMsgWatcherUnsub) dispatchMsgWatcherUnsub();
    dispatchMsgWatcherUnsub = startDispatchMessageListener(deviceId, phone, key, (msg) => {
        saveMessageToLocalHistory(msg.msgId, msg.content, msg.dateStr, msg.timeStr, msg.senderTitle, msg.senderType);
        const alreadyAcked = localStorage.getItem(`acked_msg_${msg.msgId}`);
        if (!alreadyAcked) {
            showDispatchAlertPopup(msg.content, msg.timeStr || '', msg.msgId, msg.senderTitle, msg.senderType);
        }
    });

    // GPS 요청 구독과 보고는 gps.js의 단일 경로에서 관리합니다.

    // 관제 센터 실시간 자동할당 동선 감시 (기기ID 및 휴대폰 번호 다중 감시)
    if (activeRoutesWatcherUnsub) activeRoutesWatcherUnsub();
    activeRoutesWatcherUnsub = listenToActiveRoutes(
        deviceId, 
        phone,
        (destinations, data) => {
            cachedRemoteRoutes = { destinations, data };
            if (typeof onRemoteRoutesReceivedCallback === 'function') {
                onRemoteRoutesReceivedCallback(destinations, data);
            }
        }, 
        () => {
            cachedRemoteRoutes = null;
            if (typeof onRemoteRoutesClearedCallback === 'function') {
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
    prepareDriverAuth();
    if (driverLoginInProgress) return;
    if (savedAuthCheck) return savedAuthCheck;
    savedAuthCheck = (async () => {
        try {
            const identity = await restoreFirebaseSession();
            if (!identity) { clearAuthStorage(); lockDriverScreen(); return; }
            if (identity.role !== 'driver') throw new Error(AUTH_FAILURE_MESSAGE);
            if (activeDriverUid === identity.uid && state.getRouteOwnerId()) return;
            await activateVerifiedDriver(identity);
        } catch {
            clearAuthStorage();
            lockDriverScreen();
            const message = document.getElementById('auth-message');
            if (message) message.innerText = AUTH_FAILURE_MESSAGE;
        } finally {
            document.getElementById('boot-screen')?.classList.add('hidden');
        }
    })();
    try { await savedAuthCheck; } finally { savedAuthCheck = null; }
}

// ==========================================
// 8. 수동 라이선스 키 인증 (로그인 버튼 클릭)
// ==========================================
export async function verifyLicense() {
    if (driverLoginInProgress || savedAuthCheck) return;
    prepareDriverAuth();
    const input = document.getElementById('license-input');
    const keyInput = (input?.value || '').trim();
    const rawPhone = (document.getElementById('auth-phone-input')?.value || '').trim();
    const msgEl = document.getElementById('auth-message');
    const btn = document.getElementById('verify-btn');
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

    driverLoginInProgress = true;
    if (input) input.value = '';
    try {
        const identity = await loginWithSecret(keyInput, 'driver');
        await activateVerifiedDriver(identity, formattedPhone);
    } catch {
        clearAuthStorage();
        lockDriverScreen();
        try { await signOutFirebaseSession(); } catch {}
        if (msgEl) msgEl.innerText = AUTH_FAILURE_MESSAGE;
    } finally {
        driverLoginInProgress = false;
        if (input) input.value = '';
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
    if (driverLoginInProgress || savedAuthCheck || activeDriverUid) return;
    prepareDriverAuth();
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

    driverLoginInProgress = true;
    let registration;
    const attempt = ++trialAttempt;
    try {
        registration = await firebaseStartTrial(phoneInput, deviceId);
        if (attempt !== trialAttempt) throw new Error(AUTH_FAILURE_MESSAGE);
        let identity;
        try { identity = await loginWithSecret(registration.secret, 'driver'); }
        finally { registration.secret = null; }
        if (!identity || identity.role !== 'driver' || identity.accountRef !== registration.accountRef ||
            identity.credentialVersion !== 1) throw new Error(AUTH_FAILURE_MESSAGE);
        await activateVerifiedDriver(identity, phoneInput, 'trial');
        alert("7일 무료 체험이 시작되었습니다.\n안전 운전 하십시오!");
        closeTrialModal();
    } catch {
        clearAuthStorage();
        lockDriverScreen();
        try { await signOutFirebaseSession(); } catch {}
        if (msgEl) {
            msgEl.innerText = "체험 시작을 확인하지 못했습니다. 자동 재신청하지 않습니다. 관리자에게 문의해 주세요.";
            msgEl.classList.remove('hidden');
        }
    } finally {
        if (registration) registration.secret = null;
        registration = null;
        driverLoginInProgress = false;
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
    resetGpsPreferenceSession();
    
    const currentKey = getVerifiedAuthSession('driver')?.accountRef.slice('licenses/'.length);
    if (currentKey && typeof firebaseClearDeviceData === 'function') {
        try {
            await firebaseClearDeviceData(currentKey);
        } catch (e) {
            console.warn("기기 연결 해제를 완료하지 못했습니다.");
        }
    }
    
    clearAuthStorage();
    lockDriverScreen();
    try { await signOutFirebaseSession(); window.location.reload(); }
    catch { alert(AUTH_FAILURE_MESSAGE); }
}

window.isLicenseExpiredLocally = isLicenseExpiredLocally;
