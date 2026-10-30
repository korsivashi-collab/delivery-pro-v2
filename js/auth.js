import { state } from './state.js';
// js/auth.js

// =================================================================
// [배송 동선 PRO] 라이선스 인증, 보안 감시 및 기기 관리 전담 모듈
// =================================================================

import { 
    firebaseVerifyLicense, 
    firebaseLoginTestLicense,
    watchLicenseStatus, 
    startDispatchMessageListener, 
    firebaseStartTrial,
    isSalesTrialEntry, 
    firebaseClearDeviceData,
    syncMyParkingMemosFromServer,
    listenToActiveRoutes,
    firebaseSendSmsVerification,
    firebaseConfirmSmsCode,
    refreshDriverBilling,
    releaseInactiveDriverConnection,
    syncScanUsage
} from './api.js';
import { 
    saveMessageToLocalHistory, 
    showDispatchAlertPopup,
    checkUnreadNotices
} from './support.js';
import { startGpsWatcher, stopGpsWatcher } from './gps.js';

let serviceVersion = 0;
let licenseExpiryTimer = null;
let deferredServices = null;
let licenseWatcherUnsub = null;
let dispatchMsgWatcherUnsub = null;  
let activeRoutesWatcherUnsub = null;

let smsConfirmationResult = null;
let smsTimerInterval = null;
let isSmsVerified = false;
let verifiedPhoneNumber = '';
let smsRequestedPhoneNumber = '';
let smsExpiresAt = 0;
let smsSessionVersion = 0;
let smsSendInProgress = false;
let smsVerifyInProgress = false;

function phoneIdentity(phone) {
    const value = String(phone || '').trim();
    const digits = value.replace(/[^0-9]/g, '');
    return value.startsWith('+82') ? '0' + digits.slice(2).replace(/^0/, '') : digits;
}

function showSmsMessage(message, success = false) {
    const element = document.getElementById('auth-message');
    if (!element) return;
    element.innerText = message;
    element.classList.remove('text-rose-500', 'text-emerald-600');
    element.classList.add(success ? 'text-emerald-600' : 'text-rose-500');
}

function stopSmsCountdown() {
    if (smsTimerInterval !== null) clearInterval(smsTimerInterval);
    smsTimerInterval = null;
}

function resetSmsSession() {
    smsSessionVersion++;
    stopSmsCountdown();
    smsConfirmationResult = null;
    isSmsVerified = false;
    verifiedPhoneNumber = '';
    smsRequestedPhoneNumber = '';
    smsExpiresAt = 0;
    smsSendInProgress = false;
    smsVerifyInProgress = false;
    document.getElementById('auth-sms-group')?.classList.add('hidden');
    const codeInput = document.getElementById('sms-code-input');
    if (codeInput) codeInput.value = '';
    const timer = document.getElementById('auth-sms-timer');
    if (timer) timer.innerText = '03:00';
    const sendButton = document.getElementById('btn-send-sms');
    if (sendButton) { sendButton.disabled = false; sendButton.innerText = '인증요청'; }
    const verifyButton = document.getElementById('verify-btn');
    if (verifyButton) { verifyButton.disabled = false; verifyButton.innerHTML = '인증하고 시작하기'; }
    showSmsMessage('');
}

function startSmsCountdown(seconds = 180) {
    stopSmsCountdown();
    smsExpiresAt = Date.now() + seconds * 1000;
    const update = () => {
        // 화면이 백그라운드에 있어도 실제 경과 시간으로 만료를 판단합니다.
        const remaining = Math.max(0, Math.ceil((smsExpiresAt - Date.now()) / 1000));
        const timer = document.getElementById('auth-sms-timer');
        if (remaining === 0) {
            stopSmsCountdown();
            smsConfirmationResult = null;
            isSmsVerified = false;
            verifiedPhoneNumber = '';
            smsRequestedPhoneNumber = '';
            smsExpiresAt = 0;
            if (timer) timer.innerText = '만료';
            showSmsMessage('인증번호 유효시간이 만료되었습니다. 재전송을 눌러주세요.');
            return;
        }
        if (timer) timer.innerText = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    };
    smsTimerInterval = setInterval(update, 1000);
    update();
}

export async function sendPhoneAuthCode() {
    if (smsSendInProgress || smsVerifyInProgress) return;
    smsSendInProgress = true;
    let version = smsSessionVersion;
    const button = document.getElementById('btn-send-sms');
    try {
        const deviceId = getOrCreateDeviceId();
        if (version !== smsSessionVersion) return;
        const rawPhone = (document.getElementById('auth-phone-input')?.value || '').trim();
        if (!rawPhone || rawPhone.replace(/[^0-9]/g, '').length < 9) {
            showSmsMessage('휴대폰 번호를 정확하게 입력해 주세요. (숫자 9자리 이상)');
            document.getElementById('auth-phone-input')?.focus();
            return;
        }
        // 재발송 시 이전 코드·인증 결과를 즉시 폐기합니다.
        resetSmsSession();
        version = smsSessionVersion;
        smsSendInProgress = true;
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>발송 중...';
        }
        const result = await firebaseSendSmsVerification(rawPhone, 'recaptcha-container');
        if (version !== smsSessionVersion) return;
        if (phoneIdentity(rawPhone) !== phoneIdentity(document.getElementById('auth-phone-input')?.value)) {
            resetSmsSession();
            showSmsMessage('휴대폰 번호가 변경되었습니다. 인증번호를 다시 요청해 주세요.');
            return;
        }
        smsConfirmationResult = result;
        smsRequestedPhoneNumber = rawPhone;
        document.getElementById('auth-sms-group')?.classList.remove('hidden');
        startSmsCountdown(180);
        document.getElementById('sms-code-input')?.focus();
        if (result.autoVerified) document.getElementById('auth-sms-group')?.classList.add('hidden');
        showSmsMessage(result.autoVerified ? '휴대폰 자동 인증이 완료되었습니다. 인증하고 시작하기를 눌러 주세요.' : '인증번호가 발송되었습니다.', true);
    } catch (error) {
        if (version !== smsSessionVersion) return;
        resetSmsSession();
        version = smsSessionVersion;
        const messages = {
            'auth/too-many-requests': '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
            'auth/quota-exceeded': 'SMS 발송 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.',
            'auth/network-request-failed': '네트워크 연결을 확인한 뒤 다시 시도해 주세요.',
            'auth/captcha-check-failed': '보안 확인에 실패했습니다. 인증번호를 다시 요청해 주세요.',
            'auth/invalid-app-credential': '앱 보안 인증에 실패했습니다. 앱 등록 정보와 인증 설정 확인이 필요합니다.',
            'auth/unauthorized-domain': '허용되지 않은 인증 주소입니다. 앱 인증 설정 확인이 필요합니다.'
        };
        showSmsMessage(messages[error?.code] || error?.message || '인증번호 발송에 실패했습니다. 다시 시도해 주세요.');
    } finally {
        if (version === smsSessionVersion) {
            smsSendInProgress = false;
            if (button) { button.disabled = false; button.innerText = smsConfirmationResult ? '재전송' : '인증요청'; }
        }
    }
}

let onRemoteRoutesReceivedCallback = null;
let onRemoteRoutesClearedCallback = null;
let cachedRemoteRoutes = null;

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
    serviceVersion++;
    clearTimeout(licenseExpiryTimer);
    clearTimeout(deferredServices);
    resetSmsSession();
    resetTrialSmsSession();
    resetGpsPreferenceSession();
    for (const unsubscribe of [licenseWatcherUnsub, dispatchMsgWatcherUnsub, activeRoutesWatcherUnsub]) {
        try { if (typeof unsubscribe === 'function') unsubscribe(); } catch (_) {}
    }
    licenseWatcherUnsub = null;
    dispatchMsgWatcherUnsub = null;
    activeRoutesWatcherUnsub = null;
    cachedRemoteRoutes = null;
    document.getElementById('dispatch-alert-modal')?.classList.add('hidden');
    document.getElementById('memo-modal')?.classList.add('hidden');
    document.getElementById('notice-history-modal')?.classList.add('hidden');
    state.deactivateRouteOwner();
    localStorage.removeItem('deliveryProKey');
    localStorage.removeItem('deliveryProUserPhone');
    localStorage.removeItem('deliveryProExpireDate');
    localStorage.removeItem('deliveryProDispatchKey');
    localStorage.removeItem('deliveryProBillingManaged');
    localStorage.removeItem('deliveryProDriverSession');
    localStorage.removeItem('deliveryProExpiresAt');
    localStorage.removeItem('deliveryPro_my_parking_memos');
}

// ==========================================
// 3. UI 갱신 (유효기간 뱃지 & 관제 연결 버튼 상태)
// ==========================================
let expireBadgeTimer=null;
export function updateExpireBadge(serverDate) {
    const badge = document.getElementById('license-expire-badge');
    if (!badge) return;
    const expireDate = serverDate || localStorage.getItem('deliveryProExpireDate') || '';
    if (serverDate) localStorage.setItem('deliveryProExpireDate', serverDate);
    const match=/^(\d{4})[.-](\d{2})[.-](\d{2})$/.exec(expireDate);
    const today=new Date(Date.now()+9*3600000);
    const days=match?Math.round((Date.UTC(+match[1],+match[2]-1,+match[3])-Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()))/86400000):null;
    const urgent=days!==null && days<=7;
    badge.innerText=days===null?'사용기한: 확인 중':`${urgent?'구독연장 · ':''}사용기한: ${expireDate}`;
    badge.title=expireDate?`사용기한: ${expireDate} · 눌러서 이용기간 연장 / 구독 관리`:'이용기간 연장 / 구독 관리';
    badge.style.fontWeight='800';
    badge.style.color=urgent?'#b91c1c':'';
    badge.style.backgroundColor=urgent?'#fff1f2':'';
    badge.style.borderColor=urgent?'#fda4af':'';
    badge.classList.remove('hidden');
    if(expireBadgeTimer)clearTimeout(expireBadgeTimer);
    expireBadgeTimer=setTimeout(()=>updateExpireBadge(),60000);
}

export function updatePhotoCompButtonState() {
    const btn = document.getElementById('btn-photo-comp');
    const subtext = document.getElementById('photo-comp-subtext');
    if (!btn || !subtext) return;

    btn.className = "bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-2 rounded-xl shadow-md text-xs active:scale-95 transition flex flex-col items-center justify-center cursor-pointer";
    subtext.className = "text-[9px] font-bold text-blue-100 mt-0.5 tracking-tighter";
    subtext.innerText = "사진 촬영·선택 후 전송";
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
}

// ==========================================
// 5. 라이선스 상태 감시 (서버 계정의 현재 접속 감시)
// ==========================================
export function startLicenseRealtimeWatcher(key) {
    if (licenseWatcherUnsub) licenseWatcherUnsub();
    licenseWatcherUnsub = watchLicenseStatus(key, (status, msg) => {
        if(['SUSPENDED','EXPIRED'].includes(status))releaseInactiveDriverConnection(key).catch(error=>console.warn(error.message));
        if(status!=='EXPIRED')alert(`⚠️ [라이선스 알림]\n${msg}`);
        clearAuthStorage();
        const mainApp = document.getElementById('main-app');
        const authScreen = document.getElementById('auth-screen');
        if (mainApp) { mainApp.classList.add('hidden'); mainApp.classList.remove('flex'); }
        if (authScreen) authScreen.classList.remove('hidden');
        if(status==='EXPIRED')showLicenseRenewal(key);
        else window.location.reload();
    }, (docData) => {
        const linkedKey = docData.dispatchKey || '';
        localStorage.setItem('deliveryProDispatchKey', linkedKey);
        updatePhotoCompButtonState();
        if (docData.expireDate) updateExpireBadge(docData.expireDate);
        scheduleLicenseExpiry(docData);
    });
}

// ==========================================
// 6. 인증 성공 시 백그라운드 서비스 일괄 가동
// ==========================================
function scheduleLicenseExpiry(data) {
    clearTimeout(licenseExpiryTimer);
    const exact = typeof data.expiresAt?.toMillis === 'function' ? data.expiresAt.toMillis() : Number(data.expiresAt);
    const date = /^(\d{4})[.-](\d{2})[.-](\d{2})$/.exec(data.expireDate || '');
    const expiry = exact > 0 ? exact : date ? Date.UTC(+date[1],+date[2]-1,+date[3]+1)-9*3600000 : 0;
    if (!expiry) return;
    const check = () => {
        if (Date.now() < expiry) { licenseExpiryTimer = setTimeout(check, Math.min(expiry-Date.now(),2147483647)); return; }
        const expiredKey=localStorage.getItem('deliveryProKey');
        if(expiredKey)releaseInactiveDriverConnection(expiredKey).catch(error=>console.warn(error.message));
        clearAuthStorage();
        document.getElementById('main-app')?.classList.add('hidden');
        document.getElementById('auth-screen')?.classList.remove('hidden');
        showLicenseRenewal(expiredKey);
    };
    licenseExpiryTimer = setTimeout(check, Math.max(0,Math.min(expiry-Date.now(),2147483647)));
}

function showLicenseRenewal(key,msg='이용기간이 만료되었습니다.') {
    const input=document.getElementById('license-input');if(input)input.value=key || '';
    showSmsMessage(msg);
    if(!key)return;
    const previousFocus=document.activeElement;
    const old=document.getElementById('license-renewal-dialog');if(old){old.close();old.remove();}
    const dialog=document.createElement('dialog');dialog.id='license-renewal-dialog';
    dialog.setAttribute('aria-labelledby','license-renewal-title');
    dialog.setAttribute('aria-describedby','license-renewal-description');
    dialog.innerHTML=`<style>
    #license-renewal-dialog{box-sizing:border-box;width:calc(100% - 32px);max-width:384px;max-height:calc(100dvh - 32px);overflow:auto;margin:auto;padding:24px;border:1px solid #f1f5f9;border-top:4px solid #10b981;border-radius:24px;background:#fff;color:#0f172a;font-family:inherit;box-shadow:0 25px 50px -12px #0004}
    #license-renewal-dialog::backdrop{background:#0009;backdrop-filter:blur(4px)}
    #license-renewal-dialog *{box-sizing:border-box}
    #license-renewal-dialog h3{display:flex;align-items:center;gap:8px;margin:0 0 12px;font-size:20px;line-height:1.4;font-weight:900}
    #license-renewal-dialog p{margin:0;font-size:13px;line-height:1.75;color:#64748b;font-weight:600;word-break:keep-all}
    #license-renewal-dialog .renewal-warning{color:#dc2626;font-size:15px;font-weight:800;margin-bottom:8px}
    #license-renewal-dialog .renewal-key{margin-top:16px;padding:12px 14px;border-radius:12px;background:#f8fafc;font-size:12px;color:#64748b}
    #license-renewal-dialog .renewal-key strong{display:block;color:#334155;font-family:monospace;font-size:15px;margin-top:4px;overflow-wrap:anywhere}
    #license-renewal-dialog .renewal-actions{display:flex;gap:10px;margin-top:20px}
    #license-renewal-dialog button{border:0;border-radius:12px;min-height:52px;padding:14px 10px;font-family:inherit;font-size:14px;line-height:1.4;font-weight:700;cursor:pointer}
    #license-renewal-dialog button:focus-visible{outline:3px solid #0f172a;outline-offset:3px}
    #license-renewal-dialog button:disabled{opacity:.6;cursor:wait}
    </style>
    <h3 id="license-renewal-title"><span aria-hidden="true" style="color:#dc2626">!</span> 이용기간 만료 안내</h3>
    <p class="renewal-warning">이용권의 사용기간이 만료되었습니다.</p>
    <p id="license-renewal-description">계속 이용하시려면 아래 버튼을 눌러<br>기존 이용권의 사용기간을 연장해 주세요.</p>
    <div class="renewal-key">연장할 라이선스 키<strong id="license-renewal-key"></strong></div>
    <div class="renewal-actions"><button type="button" data-renewal-cancel style="flex:1;background:#f1f5f9;color:#334155">취소</button><button type="button" data-renewal-buy autofocus style="flex:1.5;background:#059669;color:white;box-shadow:0 4px 6px #0002">이용권 연장 구매</button></div>`;
    dialog.querySelector('#license-renewal-key').textContent=key;
    const openPurchase=async()=>{
        const button=dialog.querySelector('[data-renewal-buy]');button.disabled=true;
        try{
            const {openLicenseRenewal}=await import('./subscriptions.js');
            dialog.close();await openLicenseRenewal(key);
        }catch(error){showSmsMessage(error?.message || '구매창을 열지 못했습니다. 다시 시도해 주세요.');}
        finally{button.disabled=false;}
    };
    dialog.querySelector('[data-renewal-buy]').onclick=openPurchase;
    dialog.querySelector('[data-renewal-cancel]').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{dialog.remove();if(!document.querySelector('dialog[open]'))previousFocus?.focus();},{once:true});
    // Keep a full-size entry available after dismissing the centered notice.
    const message=document.getElementById('auth-message');
    if(message){
        const button=document.createElement('button');button.type='button';button.textContent='이용권 연장 구매';
        button.style.cssText='display:block;width:100%;min-height:52px;margin-top:12px;padding:14px;border:0;border-radius:12px;background:#059669;color:white;font-size:15px;font-weight:800;cursor:pointer';
        button.onclick=()=>showLicenseRenewal(key,msg);message.appendChild(button);
    }
    document.body.appendChild(dialog);dialog.showModal();
}

function applyVerifiedLogin(result) {
    localStorage.setItem('deliveryProKey', result.actualKey);
    localStorage.setItem('deliveryProUserPhone', result.phone);
    localStorage.setItem('deliveryProDispatchKey', result.dispatchKey || '');
    localStorage.setItem('deliveryProExpireDate', result.expireDate || '');
    localStorage.setItem('deliveryProExpiresAt', String(result.expiresAt || ''));
    localStorage.setItem('deliveryProBillingManaged', String(result.billingManaged === true));
    localStorage.setItem('deliveryProDriverSession', result.driverSessionId);
    startActiveServices(getOrCreateDeviceId(), result.phone, result.actualKey, result.expireDate, result.dispatchKey, result.routeOwnerId);
    scheduleLicenseExpiry(result);
}

export function startActiveServices(deviceId, phone, key, expireDate, dispatchKey, routeOwnerId) {
    const version = ++serviceVersion;
    clearTimeout(deferredServices);
    for (const unsubscribe of [licenseWatcherUnsub, dispatchMsgWatcherUnsub, activeRoutesWatcherUnsub]) {
        try { unsubscribe?.(); } catch (_) {}
    }
    state.activateRouteOwner(routeOwnerId);
    restoreGpsPreference(key);
    cachedRemoteRoutes = null;
    if (typeof window.renderList === 'function') window.renderList();
    unlockApp();
    if (typeof checkUnreadNotices === 'function') checkUnreadNotices();
    document.getElementById('boot-screen')?.classList.add('hidden');
    updateExpireBadge(expireDate);
    startLicenseRealtimeWatcher(key);
    // Yield a paint before starting independent data subscriptions and billing work.
    deferredServices = setTimeout(() => {
        if (version !== serviceVersion) return;
        syncScanUsage(true).catch(error => console.warn(error.message));
        applyGpsPreference();
        // [기여도 동기화] 마스터 센터에 집계된 전화번호 기반 작성 메모 전체 동기화 실행
        if (typeof syncMyParkingMemosFromServer === 'function') {
            Promise.resolve(syncMyParkingMemosFromServer(phone, deviceId, key)).catch(error => console.warn('공용 메모 동기화 실패:',error.message));
        }

        // 관제/운영사 메시지 실시간 감시 (라이선스 키 기준)
        if (dispatchMsgWatcherUnsub) dispatchMsgWatcherUnsub();
        dispatchMsgWatcherUnsub = startDispatchMessageListener(deviceId, phone, key, (msg) => {
            try { saveMessageToLocalHistory(msg.msgId, msg.content, msg.dateStr, msg.timeStr, msg.senderTitle, msg.senderType); }
            catch (error) { console.warn('메시지 보관 실패:', error); }
            const alreadyAcked = localStorage.getItem(`acked_msg_${msg.msgId}`);
            if (!alreadyAcked) {
                showDispatchAlertPopup(msg.content, msg.timeStr || '', msg.msgId, msg.senderTitle, msg.senderType);
            }
        });

        // GPS 요청 구독과 보고는 gps.js의 단일 경로에서 관리합니다.

        // 관제 센터 실시간 자동할당 동선 감시 (계정 내부 번호 기준)
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


        if (localStorage.getItem('deliveryProBillingManaged') === 'true') {
            refreshDriverBilling(key, deviceId).then(result => {
                if (version !== serviceVersion) return;
                if (!result.valid) {
                    clearAuthStorage();
                    document.getElementById('main-app')?.classList.add('hidden');
                    document.getElementById('auth-screen')?.classList.remove('hidden');
                    showSmsMessage(result.msg || '이용권 상태를 확인해 주세요.');
                }
            }).catch(error => console.warn('이용권 백그라운드 확인 실패:', error.message));
        }
    }, 0);
    updatePhotoCompButtonState();
}

// ==========================================
// 7. 자동 로그인 (부팅 시 기존 저장된 키 검증)
// ==========================================
let savedAuthAttempt = null;
export async function checkSavedAuth() {
    getOrCreateDeviceId();
    // Share only an in-flight check for this exact local session; never cache approval.
    const identity = JSON.stringify(['deliveryProKey', 'deliveryProUserPhone', 'deliveryProDeviceId', 'deliveryProDriverSession'].map(k => localStorage.getItem(k)));
    if (savedAuthAttempt?.identity === identity && savedAuthAttempt.version === serviceVersion) return savedAuthAttempt.promise;
    const attempt = {identity, version:serviceVersion};
    const perf = globalThis.performance, started = perf?.now();
    attempt.promise = restoreSavedAuth();
    savedAuthAttempt = attempt;
    try { return await attempt.promise; }
    finally {
        if (savedAuthAttempt === attempt) savedAuthAttempt = null;
        try { if (perf?.measure && started !== undefined) perf.measure('deliverypro-license', { start: started, end: perf.now() }); } catch {}
    }
}
async function restoreSavedAuth() {
    const version = serviceVersion;
    const deviceId = getOrCreateDeviceId();
    const savedKey = localStorage.getItem('deliveryProKey');
    const savedPhone = localStorage.getItem('deliveryProUserPhone');
    const inputKey = document.getElementById('license-input'), inputPhone = document.getElementById('auth-phone-input');
    if (inputKey && savedKey) inputKey.value = savedKey;
    if (inputPhone && savedPhone) inputPhone.value = savedPhone;
    if (savedKey) {
        const result = await firebaseVerifyLicense(savedKey, savedPhone, deviceId, {resume:true});
        if (version !== serviceVersion) return;
        if (result.valid) { applyVerifiedLogin(result); return; }
        if (!result.isOffline) clearAuthStorage();
        if(result.renewable)showLicenseRenewal(result.actualKey,result.msg);
        else showSmsMessage(result.msg);
    }
    document.getElementById('main-app')?.classList.add('hidden');
    document.getElementById('auth-screen')?.classList.remove('hidden');
    document.getElementById('boot-screen')?.classList.add('hidden');
}

// ==========================================
// 8. 수동 라이선스 키 인증 (로그인 버튼 클릭)
// ==========================================
export async function verifyLicense() {
    if (smsSendInProgress || smsVerifyInProgress) return;
    let smsVersion = smsSessionVersion;
    const keyInput = (document.getElementById('license-input')?.value || '').trim().toUpperCase();
    const rawPhone = (document.getElementById('auth-phone-input')?.value || '').trim();
    const msgEl = document.getElementById('auth-message');
    const btn = document.getElementById('verify-btn');
    const deviceId = getOrCreateDeviceId(); 
    showSmsMessage('');

    if (smsVersion !== smsSessionVersion || smsVerifyInProgress) return;
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

    if (isSmsVerified && phoneIdentity(rawPhone) !== phoneIdentity(verifiedPhoneNumber)) {
        resetSmsSession();
        smsVersion = smsSessionVersion;
    }
    showSmsMessage('');
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

    smsVerifyInProgress = true;
    try {
        if (!isSmsVerified) {
            const testResult = await firebaseLoginTestLicense(keyInput, formattedPhone, deviceId);
            if (smsVersion !== smsSessionVersion ||
                keyInput !== (document.getElementById('license-input')?.value || '').trim().toUpperCase() ||
                phoneIdentity(rawPhone) !== phoneIdentity(document.getElementById('auth-phone-input')?.value)) return;
            if (testResult?.valid) {
                resetSmsSession();
                smsVersion = smsSessionVersion;
                applyVerifiedLogin(testResult);
                return;
            }
        }
        if (!isSmsVerified) {
            if (smsRequestedPhoneNumber && phoneIdentity(rawPhone) !== phoneIdentity(smsRequestedPhoneNumber)) {
                resetSmsSession();
                showSmsMessage('인증번호를 요청한 휴대폰 번호와 다릅니다. 인증번호를 다시 요청해 주세요.');
                return;
            }
            if (!smsConfirmationResult) {
                showSmsMessage('휴대폰 번호 [인증요청]을 먼저 진행해 주세요.');
                return;
            }
            const code = (document.getElementById('sms-code-input')?.value || '').trim();
            if (!smsConfirmationResult?.autoVerified && !/^[0-9]{6}$/.test(code)) {
                showSmsMessage('SMS 인증번호 6자리를 입력해 주세요.');
                document.getElementById('sms-code-input')?.focus();
                return;
            }
            const confirmation = smsConfirmationResult;
            if (!confirmation || Date.now() >= smsExpiresAt) {
                stopSmsCountdown();
                smsConfirmationResult = null;
                const timer = document.getElementById('auth-sms-timer');
                if (timer) timer.innerText = '만료';
                showSmsMessage('인증번호 유효시간이 만료되었습니다. 재전송을 눌러주세요.');
                return;
            }
            let user;
            try {
                user = await firebaseConfirmSmsCode(confirmation, code);
            } catch (error) {
                if (smsVersion === smsSessionVersion) showSmsMessage(error?.message || 'SMS 인증에 실패했습니다. 다시 시도해 주세요.');
                return;
            }
            if (smsVersion !== smsSessionVersion) return;
            if (confirmation !== smsConfirmationResult || Date.now() >= smsExpiresAt) {
                stopSmsCountdown();
                smsConfirmationResult = null;
                const timer = document.getElementById('auth-sms-timer');
                if (timer) timer.innerText = '만료';
                showSmsMessage('인증번호 유효시간이 만료되었습니다. 재전송을 눌러주세요.');
                return;
            }
            if (phoneIdentity(rawPhone) !== phoneIdentity(document.getElementById('auth-phone-input')?.value) ||
                !user?.phoneNumber || phoneIdentity(user.phoneNumber) !== phoneIdentity(rawPhone)) {
                resetSmsSession();
                showSmsMessage('인증된 휴대폰 번호가 입력 번호와 다릅니다. 인증번호를 다시 요청해 주세요.');
                return;
            }
            isSmsVerified = true;
            verifiedPhoneNumber = rawPhone;
            stopSmsCountdown();
            const timer = document.getElementById('auth-sms-timer');
            if (timer) timer.innerText = '인증 완료';
        }
        // Reuse only the server result obtained during this click; never cache it across attempts.
        const res = await firebaseVerifyLicense(keyInput, formattedPhone, deviceId);
        if (smsVersion !== smsSessionVersion) return;
        if (phoneIdentity(rawPhone) !== phoneIdentity(document.getElementById('auth-phone-input')?.value)) {
            resetSmsSession();
            showSmsMessage('휴대폰 번호가 변경되었습니다. 인증번호를 다시 요청해 주세요.');
            return;
        }
        
        if (keyInput !== (document.getElementById('license-input')?.value || '').trim().toUpperCase()) {
            showSmsMessage('라이선스 키가 변경되었습니다. 다시 확인해 주세요.');
            return;
        }
        if (res && res.valid) {
            applyVerifiedLogin(res);
        } else if(res?.renewable) {
            showLicenseRenewal(res.actualKey,res.msg);
        } else {
            if (msgEl) msgEl.innerText = res?.isOffline
                ? '휴대폰 확인은 완료되었지만 이용권 서버에 연결하지 못했습니다. 잠시 후 [인증하고 시작하기]를 다시 눌러 주세요.'
                : (res && res.msg) ? res.msg : "인증에 실패했습니다. 키와 번호를 확인해 주세요.";
        }
    } catch (e) {
        if (msgEl) msgEl.innerText = e?.message || "통신 오류가 발생했습니다. 네트워크 상태를 확인 후 다시 시도해 주세요.";
    } finally {
        if (smsVersion === smsSessionVersion) {
            smsVerifyInProgress = false;
            if (btn) {
                btn.innerHTML = '인증하고 시작하기';
                btn.disabled = false;
            }
        }
    }
}

// ==========================================
// 9. 7일 무료 체험 모달 제어 및 신청
// ==========================================
let trialSmsConfirmationResult = null;
let trialSmsTimerInterval = null;
let isTrialSmsVerified = false;
let verifiedTrialPhoneNumber = '';
let trialRequestedPhoneNumber = '';
let trialSmsExpiresAt = 0;
let trialSmsVersion = 0;
let trialSmsSendInProgress = false;
let trialSubmitInProgress = false;

function showTrialSmsMessage(message, success = false) {
    const element = document.getElementById('trial-error-msg');
    if (!element) return;
    element.innerText = message;
    element.classList.remove('hidden', 'text-rose-500', 'text-emerald-600');
    element.classList.add(success ? 'text-emerald-600' : 'text-rose-500');
}

function stopTrialSmsCountdown() {
    if (trialSmsTimerInterval !== null) clearInterval(trialSmsTimerInterval);
    trialSmsTimerInterval = null;
}

function resetTrialSmsSession() {
    trialSmsVersion++;
    stopTrialSmsCountdown();
    trialSmsConfirmationResult = null;
    isTrialSmsVerified = false;
    verifiedTrialPhoneNumber = '';
    trialRequestedPhoneNumber = '';
    trialSmsExpiresAt = 0;
    trialSmsSendInProgress = false;
    trialSubmitInProgress = false;
    document.getElementById('trial-sms-group')?.classList.add('hidden');
    const code = document.getElementById('trial-sms-code-input');
    if (code) code.value = '';
    const timer = document.getElementById('trial-sms-timer');
    if (timer) timer.innerText = '03:00';
    const send = document.getElementById('btn-trial-send-sms');
    if (send) { send.disabled = false; send.innerText = '인증요청'; }
    const submit = document.getElementById('trial-submit-btn');
    if (submit) { submit.disabled = false; submit.innerHTML = '무료로 시작하기'; }
    document.getElementById('trial-error-msg')?.classList.add('hidden');
}

function trialPhoneValue() {
    const raw = (document.getElementById('trial-phone-input')?.value || '').trim();
    const digits = phoneIdentity(raw);
    if (!/^(?:\+82)?[0-9\s()-]+$/.test(raw) || !/^010[0-9]{8}$/.test(digits)) {
        throw new Error('휴대폰 번호를 정확하게 입력해 주세요. (예: 010-1234-5678)');
    }
    return digits.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3');
}

function startTrialSmsCountdown(seconds = 180) {
    stopTrialSmsCountdown();
    trialSmsExpiresAt = Date.now() + seconds * 1000;
    const update = () => {
        const remaining = Math.max(0, Math.ceil((trialSmsExpiresAt - Date.now()) / 1000));
        const timer = document.getElementById('trial-sms-timer');
        if (!remaining) {
            stopTrialSmsCountdown();
            trialSmsConfirmationResult = null;
            if (timer) timer.innerText = '만료';
            showTrialSmsMessage('인증번호 유효시간이 만료되었습니다. 재전송을 눌러주세요.');
            return;
        }
        if (timer) timer.innerText = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    };
    trialSmsTimerInterval = setInterval(update, 1000);
    update();
}

export async function sendTrialSmsCode() {
    if (trialSmsSendInProgress || trialSubmitInProgress || smsSendInProgress || smsVerifyInProgress) return;
    trialSmsSendInProgress = true;
    let version = trialSmsVersion;
    const button = document.getElementById('btn-trial-send-sms');
    try {
        if (version !== trialSmsVersion) return;
        const phone = trialPhoneValue();
        resetTrialSmsSession();
        version = trialSmsVersion;
        trialSmsSendInProgress = true;
        if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>발송 중...'; }
        // 로그인 카드의 invisible reCAPTCHA 인스턴스를 공유합니다.
        const result = await firebaseSendSmsVerification(phone, 'recaptcha-container', {purpose:'trial',deviceId:getOrCreateDeviceId(),
            trialOffer:typeof isSalesTrialEntry === 'function' && isSalesTrialEntry() ? 'sales-month' : 'standard'});
        if (version !== trialSmsVersion) return;
        if (phoneIdentity(phone) !== phoneIdentity(document.getElementById('trial-phone-input')?.value)) {
            resetTrialSmsSession(); showTrialSmsMessage('휴대폰 번호가 변경되었습니다. 인증번호를 다시 요청해 주세요.'); return;
        }
        trialSmsConfirmationResult = result;
        trialRequestedPhoneNumber = phone;
        document.getElementById('trial-sms-group')?.classList.remove('hidden');
        startTrialSmsCountdown();
        document.getElementById('trial-sms-code-input')?.focus();
        if (result.autoVerified) document.getElementById('trial-sms-group')?.classList.add('hidden');
        showTrialSmsMessage(result.autoVerified ? '휴대폰 자동 인증이 완료되었습니다. 무료 체험 시작을 눌러 주세요.' : '인증번호가 발송되었습니다.', true);
    } catch (error) {
        if (version !== trialSmsVersion) return;
        resetTrialSmsSession(); version = trialSmsVersion;
        showTrialSmsMessage(error?.message || '인증번호 발송에 실패했습니다. 다시 시도해 주세요.');
    } finally {
        if (version === trialSmsVersion) {
            trialSmsSendInProgress = false;
            if (button) { button.disabled = false; button.innerText = trialSmsConfirmationResult ? '재전송' : '인증요청'; }
        }
    }
}

export function openTrialModal() {
    const days = typeof isSalesTrialEntry === 'function' && isSalesTrialEntry() ? 30 : 7;
    const title = document.getElementById('trial-title');
    const entry = document.getElementById('trial-entry-label');
    if (title) title.textContent = days === 30 ? '30일 무료 체험' : '7일 무료 체험 시작';
    if (entry) entry.textContent = days === 30 ? '30일 무료로 시작하기' : '처음이신가요? 7일 무료 체험';
    resetTrialSmsSession();
    const input = document.getElementById('trial-phone-input');
    const msg = document.getElementById('trial-error-msg');
    const modal = document.getElementById('trial-modal');
    if (input) input.value = "";
    if (msg) msg.classList.add('hidden');
    if (modal) modal.classList.remove('hidden');
    setTimeout(() => { if (input) input.focus(); }, 100);
}

export function closeTrialModal() { 
    resetTrialSmsSession();
    document.getElementById('trial-modal')?.classList.add('hidden'); 
}

export async function startFreeTrial() {
    if (trialSubmitInProgress || trialSmsSendInProgress) return;
    const version = trialSmsVersion;
    trialSubmitInProgress = true;
    const msgEl = document.getElementById('trial-error-msg');
    const btn = document.getElementById('trial-submit-btn');
    const deviceId = getOrCreateDeviceId();

    try {
        if (version !== trialSmsVersion) return;
        const formattedPhone = trialPhoneValue();
        if (!isTrialSmsVerified && !trialSmsConfirmationResult) {
            showTrialSmsMessage('전화번호 [인증요청]을 진행해 주세요.'); return;
        }
        if (phoneIdentity(formattedPhone) !== phoneIdentity(isTrialSmsVerified ? verifiedTrialPhoneNumber : trialRequestedPhoneNumber)) {
            resetTrialSmsSession(); showTrialSmsMessage('휴대폰 번호가 변경되었습니다. 인증번호를 다시 요청해 주세요.'); return;
        }
        if (msgEl) msgEl.classList.add('hidden');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 처리 중...'; }
        if (!isTrialSmsVerified) {
            const code = (document.getElementById('trial-sms-code-input')?.value || '').trim();
            if (!trialSmsConfirmationResult?.autoVerified && !/^[0-9]{6}$/.test(code)) { showTrialSmsMessage('SMS 인증번호 6자리를 입력해 주세요.'); return; }
            const confirmation = trialSmsConfirmationResult;
            if (Date.now() >= trialSmsExpiresAt) { showTrialSmsMessage('인증번호가 만료되었습니다. 재전송을 눌러주세요.'); return; }
            const user = await firebaseConfirmSmsCode(confirmation, code);
            if (version !== trialSmsVersion) return;
            if (confirmation !== trialSmsConfirmationResult || Date.now() >= trialSmsExpiresAt) {
                showTrialSmsMessage('인증번호가 만료되었습니다. 재전송을 눌러주세요.'); return;
            }
            if (phoneIdentity(user?.phoneNumber) !== phoneIdentity(formattedPhone) ||
                phoneIdentity(document.getElementById('trial-phone-input')?.value) !== phoneIdentity(formattedPhone)) {
                resetTrialSmsSession(); showTrialSmsMessage('인증된 휴대폰 번호가 다릅니다. 다시 인증해 주세요.'); return;
            }
            isTrialSmsVerified = true;
            verifiedTrialPhoneNumber = formattedPhone;
            stopTrialSmsCountdown();
        }
        const res = await firebaseStartTrial(formattedPhone, deviceId);
        if (version !== trialSmsVersion) return;
        if (phoneIdentity(document.getElementById('trial-phone-input')?.value) !== phoneIdentity(formattedPhone)) {
            resetTrialSmsSession(); showTrialSmsMessage('휴대폰 번호가 변경되었습니다. 다시 인증해 주세요.'); return;
        }
        if (res.valid) {
            localStorage.setItem('deliveryProKey', res.trialKey);
            localStorage.setItem('deliveryProUserPhone', formattedPhone);
            localStorage.setItem('deliveryProExpireDate', res.expireDate);
            localStorage.setItem('deliveryProDispatchKey', res.dispatchKey || '');
            alert(`${res.trialDays || (typeof isSalesTrialEntry === 'function' && isSalesTrialEntry() ? 30 : 7)}일 무료 체험이 시작되었습니다.\n안전 운전 하십시오!`);
            closeTrialModal();
            
            const login = await firebaseVerifyLicense(res.trialKey, formattedPhone, deviceId);
            if (!login.valid) throw new Error(login.msg);
            applyVerifiedLogin(login);
        } else {
            if (msgEl) {
                msgEl.innerText = res.msg;
                msgEl.classList.remove('hidden');
            }
        }
    } catch (e) {
        if (version === trialSmsVersion) showTrialSmsMessage("오류 발생: " + e.message);
    } finally {
        if (version === trialSmsVersion) {
            trialSubmitInProgress = false;
            if (btn) { btn.innerHTML = '무료로 시작하기'; btn.disabled = false; }
        }
    }
}

// ==========================================
// 10. 로그아웃 (기기 연동 해제 및 초기화)
// ==========================================
export async function logout() {
    if (!confirm("로그아웃 하시겠습니까?\n로그아웃 시 기기 정보가 초기화되어 다른 기기에서 로그인할 수 있습니다.")) return;
    resetGpsPreferenceSession();
    
    const currentKey = localStorage.getItem('deliveryProKey');
    if (currentKey && typeof firebaseClearDeviceData === 'function') {
        try {
            await firebaseClearDeviceData(currentKey);
        } catch (e) {
            alert('접속 해제를 완료하지 못했습니다. 인터넷 연결을 확인한 뒤 로그아웃을 다시 눌러 주세요.');
            return;
        }
    }
    clearAuthStorage();
    localStorage.removeItem('deliveryProDeviceId');
    window.location.reload();
}

window.isLicenseExpiredLocally = isLicenseExpiredLocally;
window.sendPhoneAuthCode = sendPhoneAuthCode;
window.sendTrialSmsCode = sendTrialSmsCode;


export async function activatePurchasedLicense(result) {
    if (!result?.valid || !result.billingManaged || !result.actualKey || !result.routeOwnerId) throw new Error('구독 이용권 확인이 필요합니다.');
    const login = await firebaseVerifyLicense(result.actualKey, null, getOrCreateDeviceId());
    if (!login.valid) throw new Error(login.msg);
    applyVerifiedLogin(login);
}
