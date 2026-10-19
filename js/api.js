import { state } from './state.js';
import { isNativeApp, apiFetch } from './native-platform.js';
import { sendNativePhoneVerification } from './native-phone-auth.js';
import { selectLatestOwnedRoute } from './route-owner.js';
// js/api.js
// =================================================================
// [배송 경로 PRO] 백엔드 Firebase Firestore / Storage 통신 전담 모듈 (통로 충돌 완벽 방어)
// =================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { 
    getFirestore, 
    collection, 
    addDoc, 
    getDoc, 
    getDocs, 
    onSnapshot, 
    query, 
    where, 
    updateDoc, 
    doc, 
    increment, 
    setDoc, 
    writeBatch,
    runTransaction,
    deleteDoc, 
    orderBy, 
    limit 
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";

import {
    getAuth,
    signInWithCustomToken
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyBZKERmiPis4PCVDSYg0SSRTWV7L3z_5tw",
    authDomain: "delivery-pro-dd272.firebaseapp.com",
    projectId: "delivery-pro-dd272",
    storageBucket: "delivery-pro-dd272.firebasestorage.app",
    messagingSenderId: "329406776647",
    appId: "1:329406776647:web:62b32568328dd1eecab862"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = 'ko';
const db = getFirestore(app);
const storage = getStorage(app);

// 기사 웹·앱 SMS는 SENS로 검증하고 기존 Firebase 계정 세션을 연결합니다.
export async function firebaseSendSmsVerification(phoneNumber, containerId = 'recaptcha-container', options = {}) {
    try {
        const input = String(phoneNumber ?? '').trim();
        if (!/^\+?[0-9\s()-]+$/.test(input)) {
            const error = new Error('올바른 전화번호를 입력해 주세요.');
            error.code = 'auth/invalid-phone-number';
            throw error;
        }
        let formattedPhone = input.replace(/[\s()-]/g, '');
        // 국내 번호의 맨 앞 0을 국가번호 +82로 교체합니다.
        if (formattedPhone.startsWith('+82')) {
            formattedPhone = '+82' + formattedPhone.slice(3).replace(/^0/, '');
        } else if (/^0[0-9]{8,10}$/.test(formattedPhone)) {
            formattedPhone = '+82' + formattedPhone.slice(1);
        }
        if (!/^\+[1-9][0-9]{7,14}$/.test(formattedPhone)) {
            const error = new Error('전화번호를 010-1234-5678 또는 국제 전화번호 형식으로 입력해 주세요.');
            error.code = 'auth/invalid-phone-number';
            throw error;
        }
        return await sendNativePhoneVerification(formattedPhone, token => signInWithCustomToken(auth, token), options);
    } catch (error) {
        throw error;
    }
}

export async function firebaseConfirmSmsCode(confirmationResult, code) {
    if (!confirmationResult || typeof confirmationResult.confirm !== 'function') {
        const error = new Error('먼저 SMS 인증번호를 요청해 주세요.');
        error.code = 'auth/missing-verification-id';
        throw error;
    }
    // 문자열로 검증하여 0으로 시작하는 인증번호도 보존합니다.
    const verificationCode = String(code ?? '').trim();
    if (!confirmationResult.autoVerified && !/^[0-9]{6}$/.test(verificationCode)) {
        const error = new Error('SMS 인증번호 6자리를 입력해 주세요.');
        error.code = 'auth/invalid-verification-code';
        throw error;
    }
    try {
        const credential = await confirmationResult.confirm(verificationCode);
        return credential.user;
    } catch (cause) {
        const messages = {
            'auth/invalid-verification-code': '인증번호가 일치하지 않습니다. 다시 확인해 주세요.',
            'auth/code-expired': '인증번호가 만료되었습니다. 인증번호를 다시 요청해 주세요.',
            'auth/session-expired': '인증 시간이 만료되었습니다. 인증번호를 다시 요청해 주세요.',
            'auth/too-many-requests': '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
            'auth/network-request-failed': '네트워크 연결을 확인한 뒤 다시 시도해 주세요.',
            'auth/native-session-failed': cause?.message || '앱 로그인 서버 연결에 실패했습니다. 다시 시도해 주세요.'
        };
        const error = new Error(messages[cause?.code] || 'SMS 인증에 실패했습니다. 다시 시도해 주세요.', { cause });
        error.code = cause?.code || 'auth/verification-failed';
        throw error;
    }
}

// 이미지 클라이언트 초고속 압축 함수 (배송 증빙 최적화: 960px / 0.65 품질)
async function compressImageToBlob(file, maxDimension = 960, quality = 0.65) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                let width = img.width;
                let height = img.height;
                if (width > height) {
                    if (width > maxDimension) {
                        height = Math.round((height * maxDimension) / width);
                        width = maxDimension;
                    }
                } else {
                    if (height > maxDimension) {
                        width = Math.round((width * maxDimension) / height);
                        height = maxDimension;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error("사진 압축에 실패했습니다."));
                }, 'image/jpeg', quality);
            };
            img.onerror = (e) => reject(e);
        };
        reader.onerror = (e) => reject(e);
    });
}

// 1. 배송 완료 사진 고속 업로드 (경량화 규격 적용)
export async function firebaseUploadDeliveryPhoto(file, deviceId, operationId = null) {
    const blob = await compressImageToBlob(file, 960, 0.65);
    const safeDeviceId = (deviceId || 'dev').replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = operationId ? `delivery_photos/${operationId}.jpg` : `delivery_photos/${Date.now()}_${safeDeviceId}.jpg`;
    const storageRef = ref(storage, filePath);
    const snapshot = await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });
    return await getDownloadURL(snapshot.ref);
}

// Non-login settings helpers use the canonical account; login never calls this path.
async function findDriverLicense(key) {
    for (const candidate of [...new Set([key, `PRO-${key}`, `TRIAL-${key}`])]) {
        const snapshot = await getDoc(doc(db,'licenses',candidate));
        if (snapshot.exists()) return {snapshot,isProfile:false};
    }
    return null;
}

// 2. 라이선스 검증
export async function firebaseLoginTestLicense(key, phone, deviceId) {
    const response = await apiFetch('/api/native-sms', {method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'login-test-driver', key, phone, deviceId})});
    const result = await response.json();
    if (!response.ok) {
        if (result.code === 'SMS_REQUIRED') return null;
        throw new Error(result.error || '테스트 접속을 확인할 수 없습니다.');
    }
    if (!result.valid || !result.token) throw new Error('테스트 접속 결과가 올바르지 않습니다.');
    await signInWithCustomToken(auth, result.token);
    return result;
}

export async function firebaseVerifyLicense(key, phone, deviceId, options = {}) {
    try {
        await auth.authStateReady();
        const user = auth.currentUser;
        const claims = user ? (await user.getIdTokenResult()).claims : {};
        const testPhone = claims.testDriverSession === true ? claims.testPhone : user?.phoneNumber;
        if (!user || phone && phoneIdentityDigits(testPhone) !== phoneIdentityDigits(phone)) {
            return {valid:false, requiresSms:true, msg:'휴대폰 인증을 진행해 주세요.'};
        }
        const response = await apiFetch('/api/native-sms', {method:'POST',
            headers:{'Content-Type':'application/json', Authorization:'Bearer ' + await user.getIdToken()},
            body:JSON.stringify({action:options.resume ? 'resume-driver' : 'login-driver', key, phone, deviceId})});
        const result = await response.json();
        if (!response.ok) return {valid:false, isOffline:response.status >= 500 || response.status === 429, requiresSms:response.status === 401, msg:result.error || '로그인을 확인할 수 없습니다.'};
        if (result.token) await signInWithCustomToken(auth, result.token);
        return result;
    } catch (error) {
        return {valid:false, isOffline:true, msg:'서버 연결을 확인할 수 없습니다. 네트워크를 확인한 후 다시 시도해 주세요.'};
    }
}
function phoneIdentityDigits(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return String(value || '').startsWith('+82') ? '0' + digits.slice(2) : digits;
}

// Subscribe directly to the canonical license; no preliminary lookup or profile fallback.
export function watchLicenseStatus(key, callback, onUpdateCallback) {
    const expectedDevice = localStorage.getItem('deliveryProDeviceId');
    const expectedSession = localStorage.getItem('deliveryProDriverSession');
    let stopped=false;
    const unsubscribe=onSnapshot(doc(db, 'licenses', key), {includeMetadataChanges:true}, snapshot => {
        if (stopped) return;
        if (snapshot.metadata?.hasPendingWrites || snapshot.metadata?.fromCache) return;
        if (!snapshot.exists()) { callback?.('DELETED','라이선스가 삭제되거나 변경되었습니다.'); return; }
        const data = snapshot.data();
        if (data.deviceId !== expectedDevice || expectedSession && data.driverSessionId !== expectedSession) {
            callback?.('DEVICE_CHANGED','다른 기기에서 로그인하여 이 기기의 접속이 해제되었습니다.'); return;
        }
        if (['suspended','revoked','expired','upgraded'].includes(data.status)) {
            callback?.('SUSPENDED','사용이 제한된 계정입니다.'); return;
        }
        const today = new Date(Date.now()+9*3600000).toISOString().slice(0,10).replace(/-/g,'');
        const expiry = String(data.expireDate || '').replace(/\D/g,'');
        const expiresAt = typeof data.expiresAt?.toMillis === 'function' ? data.expiresAt.toMillis() : Number(data.expiresAt);
        if (expiry && expiry < today || expiresAt > 0 && expiresAt <= Date.now()) {
            callback?.('EXPIRED','이용기간이 만료되었습니다.'); return;
        }
        onUpdateCallback?.(data);
    }, error => console.warn('라이선스 상태 연결 오류:',error));
    return () => { stopped=true; unsubscribe(); };
}

// Actions reuse the authenticated session, never an offline-success fallback.
export async function firebaseCheckLicenseOnce(key, deviceId) {
    const result = await firebaseVerifyLicense(key, localStorage.getItem('deliveryProUserPhone'), deviceId, {resume:true});
    return {...result, data:result.valid ? result : undefined};
}

export async function refreshDriverBilling(key, deviceId) {
    return billingRequest('driver-sync', {licenseKey:key, deviceId});
}

// 🌟 4-1. 관제 센터 실시간 자동할당 동선 다중 수신 리스너 (통로 독립 격리 방어)
export function listenToActiveRoutes(deviceId, phone, onRoutesReceived, onRoutesCleared, ownerId = state.getRouteOwnerId()) {
    if (!ownerId) return () => {};
    const ownedRoutes = query(collection(db, 'routes'), where('routeOwnerId', '==', ownerId));
    let hasSeenOwnedRoute = false;
    return onSnapshot(ownedRoutes, snapshot => {
        if (state.getRouteOwnerId() !== ownerId) return;
        const routes = [];
        snapshot.forEach(item => routes.push({ ...item.data(), routeDocumentId: item.id }));
        const latest = selectLatestOwnedRoute(routes, ownerId);
        if (typeof onRoutesReceived === 'function') {
            const missing = hasSeenOwnedRoute
                ? { routeOwnerId: ownerId, updatedAt: Math.max(Date.now(), state.getRouteUpdatedAt() + 1), destinations: [], cleared: true }
                : { routeOwnerId: ownerId, updatedAt: 0, destinations: [], isNoDoc: true };
            onRoutesReceived(latest ? latest.destinations : [], latest || missing);
        }
        hasSeenOwnedRoute = !!latest;
    }, error => console.warn('소유자 경로 동기화 오류:', error));
}

export const startAssignedRouteListener = listenToActiveRoutes;

export async function fetchActiveRouteOnce(deviceId, phone, ownerId = state.getRouteOwnerId()) {
    if (!ownerId) return { destinations: [], isNoDoc: true };
    try {
        const snapshot = await getDocs(query(collection(db, 'routes'), where('routeOwnerId', '==', ownerId)));
        const routes = [];
        snapshot.forEach(item => routes.push({ ...item.data(), routeDocumentId: item.id }));
        return selectLatestOwnedRoute(routes, ownerId) || { routeOwnerId: ownerId, updatedAt: 0, destinations: [], isNoDoc: true };
    } catch (error) {
        console.warn('소유자 경로 조회 오류:', error);
        return { destinations: [], isOffline: true };
    }
}

// 5. 관제 메시지: 라이선스 연결과 대상별 실시간 구독
export function startDispatchMessageListener(myDeviceId, myPhone, myKey, onMessageReceived) {
    const digits = String(myPhone || '').replace(/\D/g, '');
    const cleanPhone = String(myPhone || '').startsWith('+82') ? '0' + digits.slice(2) : digits;
    const cleanKeyOnly = (myKey || '').toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '');
    const seen = new Set(), pending = new Map(), subscriptions = [], messageQueries = [];
    let stopped = false, linkedKey = null;
    const drain = () => {
        if (stopped) return;
        pending.forEach((msg, id) => {
            if (seen.has(id) || msg.senderType === 'DRIVER') return;
            const master = msg.senderKey === 'MASTER' || msg.senderType === 'MASTER';
            if (!master && (!linkedKey || msg.senderKey !== linkedKey)) return;
            if (Array.isArray(msg.targetLicenseKeys) && !msg.targetLicenseKeys.includes(myKey)) return;
            try {
            onMessageReceived?.({ msgId: id, content: msg.content, dateStr: msg.dateStr, timeStr: msg.timeStr,
                senderTitle: msg.senderTitle || (master ? '운영사 알림' : '회사 알림'),
                senderType: msg.senderType || (master ? 'MASTER' : 'DISPATCH') });
            seen.add(id);
            } catch (error) { console.warn('메시지 화면 처리 실패:', error); }
        });
    };
    // 프로필/로컬 캐시에는 회사 키가 없을 수 있어 실제 라이선스 연결을 구독합니다.
    if (myKey) subscriptions.push(onSnapshot(doc(db, 'licenses', myKey), snapshot => {
        if (stopped) return;
        linkedKey = snapshot.exists() ? snapshot.data().dispatchKey || '' : '';
        drain();
    }, error => console.warn('회사 메시지 연결 확인 실패:', error)));
    const receive = snapshot => {
        if (stopped) return;
        snapshot.docChanges().forEach(change => {
            if (change.type === 'removed') pending.delete(change.doc.id);
            else pending.set(change.doc.id, change.doc.data());
        });
        drain();
    };
    const subscribe = (field, value) => {
        const q = query(collection(db, 'dispatch_messages'), where(field, 'array-contains', value));
        messageQueries.push(q);
        subscriptions.push(onSnapshot(q, receive, error => console.warn('메시지 수신 연결 실패:', error)));
    };
    if (myKey) subscribe('targetLicenseKeys', myKey);

    let refreshing = null;
    const refresh = () => {
        if (stopped) return Promise.resolve();
        if (refreshing) return refreshing;
        refreshing = (async () => {
            const license = await getDoc(doc(db, 'licenses', myKey));
            if (stopped) return;
            linkedKey = license.exists() ? license.data().dispatchKey || '' : '';
            for (const q of messageQueries) {
                const snapshot = await getDocs(q);
                if (stopped) return;
                snapshot.forEach(d => pending.set(d.id, d.data()));
            }
            drain();
        })().finally(() => { refreshing = null; });
        return refreshing;
    };
    currentMessageRefresh = refresh;
    const resume = () => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh().catch(error => console.warn('메시지 재조회 실패:', error));
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resume);
    if (typeof window !== 'undefined') window.addEventListener?.('online', resume);
    const timer = typeof setInterval === 'function' ? setInterval(resume, 60000) : null;
    if (typeof getDoc === 'function' && typeof getDocs === 'function') resume();
    return () => {
        stopped = true; subscriptions.forEach(stop => stop()); pending.clear();
        if (currentMessageRefresh === refresh) currentMessageRefresh = null;
        if (timer !== null) clearInterval(timer);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resume);
        if (typeof window !== 'undefined') window.removeEventListener?.('online', resume);
    };
}

let currentMessageRefresh = null;
export async function refreshDispatchMessages() {
    if (!currentMessageRefresh) throw new Error('메시지 수신 연결이 시작되지 않았습니다. 페이지를 새로고침해 주세요.');
    return currentMessageRefresh();
}

let sendingOfficeMessage = false;
export async function sendOfficeMessage() {
    if (sendingOfficeMessage) return;
    const input = document.getElementById('office-message-input');
    const content = input?.value.trim();
    if (!content || content.length > 300) { alert('메시지를 1~300자로 입력해 주세요.'); return; }
    const key = localStorage.getItem('deliveryProKey');
    if (!key || !state.getRouteOwnerId()) { alert('기사 계정으로 로그인해 주세요.'); return; }
    sendingOfficeMessage = true;
    const button = document.getElementById('btn-send-office-message');
    if (button) button.disabled = true;
    try {
        const snapshot = await getDoc(doc(db, 'licenses', key));
        const license = snapshot.exists() ? snapshot.data() : null;
        if (!license?.dispatchKey || license.routeOwnerId !== state.getRouteOwnerId()) {
            throw new Error('연결된 사무실과 기사 계정을 확인할 수 없습니다.');
        }
        const now = new Date();
        const dateStr = [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-');
        await addDoc(collection(db, 'dispatch_messages'), {
            senderType: 'DRIVER', senderKey: key, senderPhone: license.phone || '',
            senderTitle: '기사 메시지', targetDispatchKey: license.dispatchKey,
            targetDeviceIds: [license.dispatchKey], targetPhones: [], content,
            createdAt: now.getTime(), dateStr,
            timeStr: now.toLocaleTimeString('ko-KR', {hour12:false, hour:'2-digit',minute:'2-digit'}), acknowledged: []
        });
        input.value = '';
        alert('사무실로 메시지를 전송했습니다.');
    } catch (error) { alert('사무실 전송 실패: ' + error.message); }
    finally { sendingOfficeMessage = false; if (button) button.disabled = false; }
}


// 6. 7일 무료 체험 시작
export function isSalesTrialEntry() {
    return String(globalThis.location?.pathname || '').replace(/\/+$/, '') === '/trial-month';
}

export async function firebaseStartTrial(phone, deviceId) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    const national = String(phone || '').trim().startsWith('+82') ? '0' + digits.slice(2).replace(/^0/, '') : digits;
    if (!/^010[0-9]{8}$/.test(national)) return { valid: false, msg: '휴대폰 번호를 정확하게 입력해 주세요. (예: 010-1234-5678)' };
    const formattedPhone = national.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3');
    const user = auth.currentUser;
    const verifiedDigits = String(user?.phoneNumber || '').replace(/\D/g, '');
    if (!user || verifiedDigits !== '82' + national.slice(1)) {
        return { valid: false, msg: '전화번호 [인증요청]을 진행해 주세요.' };
    }
    const variants = [formattedPhone, national, '+82' + national.slice(1), '+82 10-' + national.slice(3, 7) + '-' + national.slice(7)];
    // 화면 안내용 사전 조회. 최종 중복 판정과 발급은 서버에서 같은 트랜잭션으로 수행합니다.
    const snapshots = await Promise.all(['licenses', 'driver_profiles'].map(name =>
        getDocs(query(collection(db, name), where('phone', 'in', variants)))));
    if (snapshots.some(snapshot => !snapshot.empty)) {
        return { valid: false, msg: '이미 가입 또는 무료 체험 이력이 있는 휴대폰 번호입니다. 정식 라이선스를 이용해 주세요.' };
    }
    const deviceSnapshot = await getDocs(query(collection(db, 'licenses'), where('deviceId', '==', deviceId), where('type', '==', 'trial')));
    if (!deviceSnapshot.empty) return { valid: false, msg: '이미 무료 체험을 사용하신 기기입니다. 정식 라이선스를 이용해 주세요.' };
    const token = await user.getIdToken();
    const response = await apiFetch(isSalesTrialEntry() ? '/api/start-trial-month' : '/api/start-trial', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ phone: formattedPhone, deviceId })
    });
    const result = await response.json();
    if (!response.ok && result.valid !== false) throw new Error('무료 체험 발급에 실패했습니다.');
    return result;
}

// 7. 주차 및 건물 메모 (공용 메모) 관련 함수들
export async function getMemosFromFirestore(address) {
    const q = query(collection(db, "memos"), where("address", "==", address));
    const querySnapshot = await getDocs(q);
    let memos = [];
    querySnapshot.forEach((docSnap) => {
        let data = docSnap.data();
        if (!data.reported) memos.push({ id: docSnap.id, ...data });
    });
    memos.sort((a, b) => (b.likes || 0) - (a.likes || 0));
    return memos;
}

export async function getBatchMemosFromFirestore(addresses) {
    if (!addresses || addresses.length === 0) return {};
    let allMemosMap = {};
    const chunks = [];
    for (let i = 0; i < addresses.length; i += 30) {
        chunks.push(addresses.slice(i, i + 30));
    }
    for (let chunk of chunks) {
        const q = query(collection(db, "memos"), where("address", "in", chunk));
        const querySnapshot = await getDocs(q);
        querySnapshot.forEach((docSnap) => {
            let data = docSnap.data();
            if (!data.reported) {
                if (!allMemosMap[data.address]) allMemosMap[data.address] = [];
                allMemosMap[data.address].push({ id: docSnap.id, ...data });
            }
        });
    }
    for (let addr in allMemosMap) {
        allMemosMap[addr].sort((a, b) => (b.likes || 0) - (a.likes || 0));
    }
    return allMemosMap;
}

async function memoRequest(action,input={},expectedPhone=null) {
    await auth.authStateReady();
    const user=auth.currentUser;
    if(!user)throw new Error('휴대폰 인증 후 메모를 이용해 주세요.');
    if(expectedPhone && phoneIdentityDigits(user.phoneNumber)!==phoneIdentityDigits(expectedPhone))throw new Error('인증된 전화번호가 변경되었습니다. 다시 시도해 주세요.');
    const response=await apiFetch('/api/memos',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await user.getIdToken()},body:JSON.stringify({...input,action})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'메모 처리에 실패했습니다.');
    return result;
}
export async function saveMemoToFirestore(address, deviceId, memoText, phone = "") {
    // The server derives the author and phone from the verified token, never these legacy arguments.
    return memoRequest('save',{address,memo:memoText});
}

export async function syncMyParkingMemosFromServer(phone, deviceId, licenseKey) {
    const result=await memoRequest('mine');
    if (phoneIdentityDigits(auth.currentUser?.phoneNumber) !== phoneIdentityDigits(result.phone)) throw new Error('인증된 사용자가 변경되었습니다. 다시 확인해 주세요.');
    const addresses=result.addresses||[];
    localStorage.setItem('deliveryPro_my_parking_memos',JSON.stringify(addresses));
    return addresses.length;
}

export async function likeMemoInFirestore(docId) { 
    await memoRequest('like',{id:docId}); 
}

export async function reportMemoInFirestore(docId) { 
    await memoRequest('report',{id:docId}); 
}

export async function deleteMemoInFirestore(docId) {
    return memoRequest('delete',{id:docId});
}

// 8. 배송 경로 및 완료 내역 동기화
const routeSaveRevisions = new Map();
const routeSaveTasks = new Map();
const MAX_ROUTE_SAVE_REVISIONS = 64;
export async function saveRouteToFirestore(deviceId, phone, destinations, requireAcknowledgement = false) {
    let revisionKey;
    let revision;
    try {
        const routeOwnerId = state.getRouteOwnerId();
        if (!deviceId || !routeOwnerId || destinations !== state.getDestinations()) return false;
        revisionKey = `${routeOwnerId}|${deviceId}`;
        revision = state.getRouteUpdatedAt();
        if (!requireAcknowledgement && routeSaveRevisions.get(revisionKey) === revision) return;
        if (!routeSaveRevisions.has(revisionKey) && routeSaveRevisions.size >= MAX_ROUTE_SAVE_REVISIONS) {
            routeSaveRevisions.delete(routeSaveRevisions.keys().next().value);
        }
        routeSaveRevisions.set(revisionKey, revision);
        const routeRef = doc(db, "routes", deviceId);
        const payload = {
            routeOwnerId,
            resetId: state.getRouteResetId(),
            deviceId,
            endLocation: state.getEndLocation(),
            startSelected: state.getStartLocation() !== null,
            startLocation: state.getStartLocation(),
            routePlan: state.getRoutePlan(),
            phone: phone || "연락처 미등록",
            updatedAt: state.getRouteUpdatedAt() || Date.now(),
            destinations: destinations.map(d => ({
                id: d.id,
                displayNumber: d.displayNumber || 0,
                address: d.address || "",
                lat: d.lat || 0,
                lng: d.lng || 0,
                phone: d.phone || "",
                storeName: d.storeName || "",
                orderNo: d.orderNo || "",
                memo: d.memo || "",
                items: d.items || []
            }))
        };
        // Serialize this device's writes so a slow older request cannot finish last.
        const previous = routeSaveTasks.get(revisionKey) || Promise.resolve();
        const task = previous.catch(() => {}).then(async () => {
            if (state.getRouteOwnerId() !== routeOwnerId || state.getRouteUpdatedAt() !== revision) return false;
            return runTransaction(db, async transaction => {
                const snapshot = await transaction.get(routeRef);
                const remote = snapshot.exists() ? snapshot.data() : null;
                if (remote?.routeOwnerId === routeOwnerId && remote.resetId && remote.resetId !== payload.resetId) return false;
                // A newer dispatch/reset must survive an older delayed device write.
                if (remote?.routeOwnerId === routeOwnerId && Number.isFinite(remote.updatedAt) &&
                    remote.updatedAt > payload.updatedAt) return false;
                transaction.set(routeRef, payload);
                return true;
            });
        });
        routeSaveTasks.set(revisionKey, task);
        try { return await task; }
        finally { if (routeSaveTasks.get(revisionKey) === task) routeSaveTasks.delete(revisionKey); }
    } catch (e) {
        if (routeSaveRevisions.get(revisionKey) === revision) routeSaveRevisions.delete(revisionKey);
        console.error("동선 전송 오류:", e);
        if (requireAcknowledgement) throw e;
        return false;
    }
}

// 사진 업로드 대기 중 계정이 바뀌어도 처리 시작 시점의 소유권을 유지합니다.
export function getCompletionOwnershipContext() {
    return Object.freeze({
        routeOwnerId: state.getRouteOwnerId(),
        licenseKey: localStorage.getItem('deliveryProKey') || ''
    });
}

export async function saveCompletionToFirestore(deviceId, driverPhone, item, tagText, actualLat, actualLng, isReal, photoUrl = null, ownership = getCompletionOwnershipContext(), transmission = null) {
    try {
        if (!ownership.routeOwnerId || !ownership.licenseKey) throw new Error('배송 처리 소유자 정보가 없습니다.');
        const now = new Date(transmission ? transmission.completedAt : Date.now());
        const timeStr = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
        
        const data = {
            routeOwnerId: ownership.routeOwnerId,
            licenseKey: ownership.licenseKey,
            destinationId: item.id ?? null,
            deviceId: deviceId,
            phone: driverPhone || "",
            customerPhone: item.phone || "",
            address: item.address || "",
            orderNo: item.orderNo || "",
            storeName: item.storeName || "",
            lat: actualLat,
            lng: actualLng,
            isRealGps: !!isReal,
            tag: tagText || "",
            hasPhoto: !!photoUrl,
            photoUrl: photoUrl || "",
            completedAt: now.getTime(),
            // Date는 SDK에서 Firestore Timestamp로 저장됩니다. 큐 재시도에도 만료일 고정.
            expireAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
            timeString: timeStr
        };
        if (transmission) {
            const completionRef = doc(db, 'completions', transmission.id);
            const operationRef = doc(db, 'completion_operations', transmission.id);
            await runTransaction(db, async transaction => {
                const operation = await transaction.get(operationRef);
                if (operation.exists() && operation.data().action === 'delete') return;
                transaction.set(operationRef, { routeOwnerId: ownership.routeOwnerId, action: 'complete' });
                transaction.set(completionRef, data);
            });
            return transmission.id;
        }
        const docRef = await addDoc(collection(db, 'completions'), data);
        return docRef.id;
    } catch (e) { 
        console.error("완료 내역 저장 오류:", e); 
        if (transmission) throw e;
        return null;
    }
}

export async function deleteCompletionFromFirestore(docId, operationId = null, routeOwnerId = null) {
    try {
        if (!docId) return;
        if (operationId) {
            await runTransaction(db, async transaction => {
                // Durable cancellation wins even when an older completion request arrives late.
                transaction.set(doc(db, 'completion_operations', operationId), { routeOwnerId, action: 'delete' });
                transaction.delete(doc(db, 'completions', docId));
            });
        } else await deleteDoc(doc(db, "completions", docId));
    } catch (e) {
        console.error("완료 데이터 삭제 오류:", e);
        throw e;
    }
}

export async function firebaseClearDeviceData(key) {
    await auth.authStateReady();
    const user=auth.currentUser;
    if (!key || !user) return;
    const response=await apiFetch('/api/native-sms',{method:'POST',
        headers:{'Content-Type':'application/json',Authorization:'Bearer '+await user.getIdToken()},
        body:JSON.stringify({action:'release-driver',key,deviceId:localStorage.getItem('deliveryProDeviceId')})});
    if (!response.ok) throw new Error('서버 접속 해제를 확인하지 못했습니다.');
}

// 9. TMS(관제) 연결 허용/차단 상태 제어 함수
export async function firebaseSetTmsPermission(key, isAllowed) {
    try {
        if (!key) throw new Error("유효한 라이선스 키 값이 없습니다.");
        const found = await findDriverLicense(key);
        if (found?.isOffline) throw Object.assign(new Error(found.msg), found);
        if (!found) {
            throw new Error("서버에서 계정 정보를 찾을 수 없습니다.");
        }
        const { snapshot, isProfile } = found;
        const batch = writeBatch(db);
        batch.update(doc(db, 'driver_profiles', snapshot.id), {allowTms:!!isAllowed});
        const licenseRef = doc(db, "licenses", snapshot.id);
        const licenseSnap = isProfile ? await getDoc(licenseRef) : snapshot;
        if (licenseSnap.exists()) {
            batch.update(licenseRef, isAllowed
                ? { allowTms: true }
                : { allowTms: false, dispatchKey: "" });
        }
        await batch.commit();
    } catch(e) {
        console.error("TMS 상태 변경 오류:", e);
        throw e;
    }
}

// 10. 개인 메모 기기변경 임시 금고 (12시간 자동 파기 및 암호화 보관)
export async function firebaseUploadTempMemoBackup(cleanKey, encryptedPayload, count) {
    return memoRequest('backup-save',{payload:encryptedPayload,count},cleanKey);
}
export async function firebaseGetTempMemoBackup(cleanKey) {
    return (await memoRequest('backup-read',{},cleanKey)).backup;
}
export async function firebaseDeleteTempMemoBackup(cleanKey) {
    return memoRequest('backup-delete',{},cleanKey);
}

// Billing identity is the SMS-verified Firebase user, never a caller-supplied phone or key.
export async function getBillingIdentity() {
    await auth.authStateReady();
    const user = auth.currentUser;
    return user ? { uid: user.uid, phone: user.phoneNumber } : null;
}
export async function billingRequest(action, input = {}, expectedUid = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (action !== 'config') {
        await auth.authStateReady();
        const user = auth.currentUser;
        if (!user || expectedUid && user.uid !== expectedUid) throw new Error('휴대폰 인증을 다시 진행해 주세요.');
        headers.Authorization = 'Bearer ' + await user.getIdToken();
    }
    const response = await apiFetch('/api/billing', { method: 'POST', headers, body: JSON.stringify({ ...input, action }) });
    let result; try { result = await response.json(); } catch (_) { result = {}; }
    if (!response.ok) throw new Error(result.error || '구독 확인에 실패했습니다. 잠시 후 다시 확인해 주세요.');
    return result;
}

