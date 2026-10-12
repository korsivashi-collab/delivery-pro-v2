import { state } from './state.js';
import { isNativeApp, apiFetch } from './native-platform.js';
import { sendNativePhoneVerification } from './native-phone-auth.js';
import { ensureRouteOwner, selectLatestOwnedRoute } from './route-owner.js';
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
    RecaptchaVerifier,
    signInWithPhoneNumber,
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

// Firebase 전화번호 인증: confirmationResult는 호출 측 메모리에 보관합니다.
let appRecaptchaVerifier = null;

function setupRecaptchaVerifier(containerId = 'recaptcha-container') {
    if (!appRecaptchaVerifier) {
        appRecaptchaVerifier = new RecaptchaVerifier(auth, containerId, {
            'size': 'invisible',
            'callback': () => {},
            'expired-callback': () => {
                if (appRecaptchaVerifier) {
                    try { appRecaptchaVerifier.clear(); } catch (_) {}
                    appRecaptchaVerifier = null;
                }
            }
        });
    }
    return appRecaptchaVerifier;
}

export async function firebaseSendSmsVerification(phoneNumber, containerId = 'recaptcha-container') {
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
        if (isNativeApp()) {
            return await sendNativePhoneVerification(formattedPhone, token => signInWithCustomToken(auth, token));
        }
        const verifier = setupRecaptchaVerifier(containerId);
        const confirmationResult = await signInWithPhoneNumber(auth, formattedPhone, verifier);
        return confirmationResult;
    } catch (error) {
        if (appRecaptchaVerifier) {
            try { appRecaptchaVerifier.clear(); } catch (_) {}
            appRecaptchaVerifier = null;
        }
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

// 0. 기기 고유번호(deviceId) 접속 제한(블랙리스트) 검증
export async function checkIfDeviceBlocked(deviceId) {
    if (!deviceId) return false;
    try {
        const docRef = doc(db, "blocked_devices", deviceId);
        const snap = await getDoc(docRef);
        return snap.exists();
    } catch (e) {
        return false;
    }
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

// 신분증이 없는 경우에만 기존 라이선스 조회 경로를 한 번 사용합니다.
const driverProfileProvisioning = new Map();
async function findDriverLicense(key) {
    try {
        const keys = [...new Set([key, `PRO-${key}`, `TRIAL-${key}`])];
        for (const collectionName of ['driver_profiles', 'licenses']) {
            for (const candidate of keys) {
                const snapshot = await getDoc(doc(db, collectionName, candidate));
                if (snapshot.exists()) return { snapshot, isProfile: collectionName === 'driver_profiles' };
            }
        }
        return null;
    } catch (e) {
        const code = String(e.code || '').replace(/^firestore\//, '');
        if (['unavailable', 'deadline-exceeded', 'network-request-failed'].includes(code)) {
            return { valid: false, isOffline: true, msg: "네트워크 연결 상태를 확인해 주세요." };
        }
        throw e;
    }
}

// 2. 라이선스 검증
export async function firebaseVerifyLicense(key, phone, deviceId) {
    const cleanDigits = (phone || "").replace(/[^0-9]/g, '');
    if (!cleanDigits || cleanDigits.length < 9) {
        return { valid: false, msg: "휴대폰 번호를 정확하게 입력해야 로그인이 완료됩니다." };
    }

    const found = await findDriverLicense(key);
    if (found?.isOffline) return found;
    if (!found) {
        return { valid: false, msg: "등록되지 않은 라이선스 키입니다." };
    }
    const { snapshot: docSnap, isProfile } = found;
    const data = docSnap.data();

    if (data.status === 'suspended') {
        return { valid: false, msg: "사용이 일시 정지된 계정입니다.\n관리자에게 문의하세요." };
    }

    if (data.expireDate) {
        const parts = data.expireDate.split('.');
        const expire = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59);
        if (new Date() > expire) {
            return { valid: false, msg: `라이선스 유효기간(${data.expireDate})이 만료되었습니다.` };
        }
    }

    if (data.deviceId && data.deviceId !== deviceId) {
        return { valid: false, msg: "다른 기기에 등록된 라이선스 키입니다. 관리자에게 기기 초기화를 요청하세요." };
    }
    let routeOwnerId;
    try {
        routeOwnerId = isProfile
            ? await runTransaction(db, async transaction => {
                const profileRef = doc(db, 'driver_profiles', docSnap.id);
                const snapshot = await transaction.get(profileRef);
                if (!snapshot.exists()) throw new Error('기사 신분증이 존재하지 않습니다.');
                const profile = snapshot.data();
                if (profile.status === 'suspended') throw new Error('사용이 일시 정지된 계정입니다.');
                if (profile.expireDate) {
                    const parts = profile.expireDate.split('.');
                    if (new Date() > new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59)) {
                        throw new Error('라이선스 유효기간이 만료되었습니다.');
                    }
                }
                if (profile.deviceId && profile.deviceId !== deviceId) {
                    throw new Error('다른 기기에 등록된 라이선스입니다.');
                }
                const ownerId = profile.routeOwnerId;
                if (!ownerId) throw new Error('기사 신분증 소유자 정보가 없습니다.');
                const changes = { phone };
                if (deviceId) changes.deviceId = deviceId;
                transaction.update(profileRef, changes);
                return ownerId;
            })
            : await ensureRouteOwner(db, docSnap.id, deviceId, phone);
    } catch (e) {
        const code = String(e.code || '').replace(/^firestore\//, '');
        if (['unavailable', 'deadline-exceeded', 'network-request-failed'].includes(code)) {
            return { valid: false, isOffline: true, msg: "네트워크 연결 상태를 확인해 주세요." };
        }
        throw e;
    }

    if (!isProfile) {
        // 신분증 발급 실패가 기존 라이선스의 로그인 성공을 막지 않습니다.
        const provisioning = runTransaction(db, async transaction => {
            const profileRef = doc(db, 'driver_profiles', docSnap.id);
            const licenseRef = doc(db, 'licenses', docSnap.id);
            const profileSnapshot = await transaction.get(profileRef);
            if (profileSnapshot.exists()) return;
            const licenseSnapshot = await transaction.get(licenseRef);
            if (!licenseSnapshot.exists()) return;
            const latest = licenseSnapshot.data();
            if (!latest.routeOwnerId) return;
            transaction.set(profileRef, {
                key: docSnap.id,
                status: latest.status || 'active',
                expireDate: latest.expireDate || '',
                deviceId: latest.deviceId || '',
                phone: latest.phone || '',
                routeOwnerId: latest.routeOwnerId,
                allowTms: latest.allowTms !== false
            });
        }).catch(error => console.warn('기사 신분증 자동 발급 오류:', error))
            .finally(() => {
                if (driverProfileProvisioning.get(docSnap.id) === provisioning) {
                    driverProfileProvisioning.delete(docSnap.id);
                }
            });
        driverProfileProvisioning.set(docSnap.id, provisioning);
    }

    return { 
        valid: true, 
        expireDate: data.expireDate, 
        phone: phone, 
        actualKey: docSnap.id,
        routeOwnerId,
        dispatchKey: isProfile ? "" : data.dispatchKey || "",
        allowTms: data.allowTms !== false
    };
}

// 3. 라이선스 상태 감시
export function watchLicenseStatus(key, callback, onUpdateCallback) {
    (async () => {
        try {
            const found = await findDriverLicense(key);
            if (found?.isOffline) {
                console.warn(found.msg);
                return;
            }
            if (!found) {
                if (callback) callback('DELETED', '관리자에 의해 라이선스가 삭제되었습니다.');
                return;
            }

            const data = found.snapshot.data();
            if (data.status === 'suspended') {
                if (callback) callback('SUSPENDED', '관리자에 의해 라이선스가 일시 정지되었습니다.');
                return;
            }

            if (data.expireDate) {
                const parts = data.expireDate.split('.');
                const expire = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59);
                if (new Date() > expire) {
                    if (callback) callback('EXPIRED', `라이선스 유효기간(${data.expireDate})이 만료되었습니다.`);
                    return;
                }
            }

            if (onUpdateCallback) {
                onUpdateCallback(data);
            }
        } catch (e) {
            console.warn("라이선스 검증 통신 오류:", e);
        }
    })();

    return () => {};
}

// 3-1. 주요 액션 1회 라이선스 검증
export async function firebaseCheckLicenseOnce(key, deviceId) {
    if (!key) return { valid: false, msg: "라이선스 키가 올바르지 않습니다." };
    try {
        const found = await findDriverLicense(key);
        if (found?.isOffline) return found;
        if (!found) {
            return { valid: false, msg: "등록되지 않은 라이선스 키입니다." };
        }
        const { snapshot: docSnap, isProfile } = found;
        const data = docSnap.data();

        if (data.status === 'suspended') {
            return { valid: false, msg: "사용이 일시 정지된 계정입니다." };
        }

        if (data.expireDate) {
            const parts = data.expireDate.split('.');
            const expire = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59);
            if (new Date() > expire) {
                return { valid: false, msg: `라이선스 유효기간(${data.expireDate})이 만료되었습니다.` };
            }
        }

        if (deviceId && data.deviceId && data.deviceId !== deviceId) {
            return { valid: false, msg: "다른 기기에 등록된 라이선스 키입니다." };
        }

        // 실제로 찾은 문서 ID를 사용합니다. PRO-/TRIAL- 별칭도 같은 계정의 문서와 대조합니다.
        try {
            const counterpartRef = doc(db, isProfile ? 'licenses' : 'driver_profiles', docSnap.id);
            const counterpart = await getDoc(counterpartRef);
            if (counterpart.exists()) {
                const other = counterpart.data();
                const sameOwner = !data.routeOwnerId || !other.routeOwnerId || data.routeOwnerId === other.routeOwnerId;
                const otherPhone = typeof other.phone === 'string' ? other.phone.trim() : '';
                const ownPhone = typeof data.phone === 'string' ? data.phone.trim() : '';
                const otherExpiry = String(other.expireDate || '').replace(/\D/g, '');
                const today = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}`;
                const otherUsable = !['suspended', 'revoked', 'expired', 'upgraded'].includes(other.status) &&
                    (!otherExpiry || otherExpiry >= today) && (!deviceId || !other.deviceId || other.deviceId === deviceId);
                if (sameOwner && !ownPhone && otherUsable && otherPhone.replace(/\D/g, '').length >= 9) data.phone = otherPhone;

                // 반대편 번호가 비었을 때만 보완하며, 실패해도 유효한 조회 결과는 그대로 반환합니다.
                const donorRef = ownPhone ? docSnap.ref : counterpartRef;
                const receiverRef = ownPhone ? counterpartRef : docSnap.ref;
                const phone = ownPhone || (otherUsable ? otherPhone : '');
                if (sameOwner && phone.replace(/\D/g, '').length >= 9 && (!ownPhone || !otherPhone)) {
                    runTransaction(db, async transaction => {
                        const donor = await transaction.get(donorRef);
                        const receiver = await transaction.get(receiverRef);
                        if (!donor.exists() || !receiver.exists()) return;
                        const latestDonor = donor.data(), latestReceiver = receiver.data();
                        if (String(latestReceiver.phone || '').trim() || latestDonor.phone !== phone) return;
                        if (latestDonor.routeOwnerId && latestReceiver.routeOwnerId && latestDonor.routeOwnerId !== latestReceiver.routeOwnerId) return;
                        transaction.set(receiverRef, { phone }, { merge: true });
                    }).catch(() => console.warn('전화번호 누락 필드 동기화 실패: 다음 조회 시 재시도합니다.'));
                }
            }
        } catch (_) {
            // 추가 조회 실패가 기존 라이선스 검사 결과를 오프라인 성공으로 바꾸지 않습니다.
            console.warn('전화번호 보완 조회 실패: 기존 조회 결과를 사용합니다.');
        }

        return { 
            valid: true, 
            data: data, 
            dispatchKey: isProfile ? "" : data.dispatchKey || "", 
            expireDate: data.expireDate || "",
            allowTms: data.allowTms !== false 
        };
    } catch (e) {
        return { valid: true, isOffline: true };
    }
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

// 5. 관제 메시지 리스너 (최신 5건 한정 구독)
export function startDispatchMessageListener(myDeviceId, myPhone, myKey, onMessageReceived) {
    const cleanPhone = (myPhone || '').replace(/[^0-9]/g, '');
    const cleanKeyOnly = (myKey || '').toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '');
    
    const q = query(
        collection(db, "dispatch_messages"), 
        orderBy("createdAt", "desc"), 
        limit(5)
    );

    return onSnapshot(q, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
                const msg = change.doc.data();
                const msgId = change.doc.id;

                const isDevMatch = msg.targetDeviceIds && msg.targetDeviceIds.includes(myDeviceId);
                const isPhoneMatch = cleanPhone && msg.targetPhones && msg.targetPhones.some(p => p.replace(/[^0-9]/g, '') === cleanPhone);
                const isKeyMatch = myKey && (
                    (msg.targetDeviceIds && (msg.targetDeviceIds.includes(myKey) || msg.targetDeviceIds.includes(cleanKeyOnly))) ||
                    (msg.targetPhones && msg.targetPhones.some(p => p.toUpperCase().includes(cleanKeyOnly)))
                );

                if (isDevMatch || isPhoneMatch || isKeyMatch) {
                    const isMaster = (msg.senderKey === 'MASTER' || msg.senderType === 'MASTER' || msg.senderTitle === '운영사 알림');
                    const senderTitle = msg.senderTitle || (isMaster ? '운영사 알림' : '회사 알림');
                    const senderType = msg.senderType || (isMaster ? 'MASTER' : 'DISPATCH');
                    
                    if (onMessageReceived) {
                        onMessageReceived({ msgId, content: msg.content, dateStr: msg.dateStr, timeStr: msg.timeStr, senderTitle, senderType });
                    }
                }
            }
        });
    });
}

// 6. 7일 무료 체험 시작
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
    if (!deviceSnapshot.empty) return { valid: false, msg: '이미 7일 무료 체험을 사용하신 기기입니다. 정식 라이선스를 이용해 주세요.' };
    const token = await user.getIdToken();
    const response = await apiFetch('/api/start-trial', {
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

export async function saveMemoToFirestore(address, deviceId, memoText, phone = "") {
    const now = new Date();
    const timeStr = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const cleanPhone = (phone || "").replace(/[^0-9]/g, '');

    const q = query(collection(db, "memos"), where("address", "==", address));
    const querySnapshot = await getDocs(q);

    let existingDocs = [];
    querySnapshot.forEach(docSnap => {
        const data = docSnap.data();
        const dataPhone = (data.phone || "").replace(/[^0-9]/g, '');
        if (data.deviceId === deviceId || (cleanPhone && dataPhone && dataPhone === cleanPhone)) {
            existingDocs.push({ id: docSnap.id, ...data });
        }
    });

    if (existingDocs.length > 0) {
        const primaryDocId = existingDocs[0].id;
        await updateDoc(doc(db, "memos", primaryDocId), {
            memo: memoText,
            time: timeStr,
            phone: phone || "",
            deviceId: deviceId,
            updatedAt: now.getTime(),
            reported: false
        });
        
        for (let i = 1; i < existingDocs.length; i++) {
            await deleteDoc(doc(db, "memos", existingDocs[i].id));
        }
    } else {
        await addDoc(collection(db, "memos"), {
            address,
            memo: memoText,
            deviceId,
            phone: phone || "",
            time: timeStr,
            likes: 0,
            reported: false,
            createdAt: now.getTime()
        });
    }
}

export async function syncMyParkingMemosFromServer(phone, deviceId, licenseKey) {
    const cleanPhone = (phone || "").replace(/[^0-9]/g, '');
    const myAddresses = new Set();

    try {
        const localList = JSON.parse(localStorage.getItem('deliveryPro_my_parking_memos') || '[]');
        localList.forEach(addr => { if (addr) myAddresses.add(addr); });
    } catch (e) {}

    try {
        if (deviceId) {
            const qDev = query(collection(db, "memos"), where("deviceId", "==", deviceId));
            const snapDev = await getDocs(qDev);
            snapDev.forEach(docSnap => {
                const d = docSnap.data();
                if (d.address) myAddresses.add(d.address);
            });
        }

        if (phone) {
            const qPhone = query(collection(db, "memos"), where("phone", "==", phone));
            const snapPhone = await getDocs(qPhone);
            snapPhone.forEach(docSnap => {
                const d = docSnap.data();
                if (d.address) myAddresses.add(d.address);
            });
        }

        if (cleanPhone) {
            const profileQ = query(collection(db, "driver_profiles"), where("phone", "==", phone));
            let licSnap = await getDocs(profileQ);
            if (licSnap.empty) {
                const licQ = query(collection(db, "licenses"), where("phone", "==", phone));
                licSnap = await getDocs(licQ);
            }
            const userDevIds = new Set();
            licSnap.forEach(ld => {
                const dId = ld.data().deviceId;
                if (dId) userDevIds.add(dId);
            });

            for (const dId of userDevIds) {
                if (dId !== deviceId) {
                    const qOther = query(collection(db, "memos"), where("deviceId", "==", dId));
                    const snapOther = await getDocs(qOther);
                    snapOther.forEach(docSnap => {
                        const d = docSnap.data();
                        if (d.address) myAddresses.add(d.address);
                    });
                }
            }
        }
    } catch (err) {
        console.error("서버 메모 동기화 오류:", err);
    }

    const finalArray = Array.from(myAddresses);
    localStorage.setItem('deliveryPro_my_parking_memos', JSON.stringify(finalArray));
    return finalArray.length;
}

export async function likeMemoInFirestore(docId) { 
    await updateDoc(doc(db, "memos", docId), { likes: increment(1) }); 
}

export async function reportMemoInFirestore(docId) { 
    await updateDoc(doc(db, "memos", docId), { reported: true }); 
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
    try {
        if (!key) return;
        await Promise.all([key, `PRO-${key}`, `TRIAL-${key}`]
            .map(candidate => driverProfileProvisioning.get(candidate)));
        const found = await findDriverLicense(key);
        if (found?.isOffline) throw Object.assign(new Error(found.msg), found);
        if (!found) return;
        const { snapshot, isProfile } = found;
        const changes = { deviceId: "", phone: "" };
        const batch = writeBatch(db);
        if (isProfile) {
            batch.update(doc(db, "driver_profiles", snapshot.id), changes);
        }
        const licenseRef = doc(db, "licenses", snapshot.id);
        const licenseSnap = isProfile ? await getDoc(licenseRef) : snapshot;
        if (licenseSnap.exists()) batch.update(licenseRef, changes);
        await batch.commit();
    } catch(e) {
        console.error("서버 기기 정보 초기화 오류:", e);
        throw e;
    }
}

// 9. TMS(관제) 연결 허용/차단 상태 제어 함수
export async function firebaseSetTmsPermission(key, isAllowed) {
    try {
        if (!key) throw new Error("유효한 라이선스 키 값이 없습니다.");
        await Promise.all([key, `PRO-${key}`, `TRIAL-${key}`]
            .map(candidate => driverProfileProvisioning.get(candidate)));
        const found = await findDriverLicense(key);
        if (found?.isOffline) throw Object.assign(new Error(found.msg), found);
        if (!found) {
            throw new Error("서버에서 계정 정보를 찾을 수 없습니다.");
        }
        const { snapshot, isProfile } = found;
        const batch = writeBatch(db);
        if (isProfile) {
            batch.update(doc(db, "driver_profiles", snapshot.id), { allowTms: !!isAllowed });
        }
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
    if (!cleanKey) throw new Error("라이선스 식별자가 올바르지 않습니다.");
    const now = Date.now();
    const expireTime = now + (12 * 60 * 60 * 1000);

    const docRef = doc(db, "temp_memo_backups", cleanKey);
    await setDoc(docRef, {
        licenseKey: cleanKey,
        payload: encryptedPayload,
        count: count,
        createdAt: now,
        expireAt: expireTime
    });
}

export async function firebaseGetTempMemoBackup(cleanKey) {
    if (!cleanKey) return null;
    const docRef = doc(db, "temp_memo_backups", cleanKey);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) return null;

    const data = docSnap.data();
    const now = Date.now();

    if (data.expireAt && now > data.expireAt) {
        try { await deleteDoc(docRef); } catch (e) {}
        return { expired: true };
    }

    return {
        expired: false,
        payload: data.payload,
        count: data.count || 0,
        createdAt: data.createdAt,
        expireAt: data.expireAt
    };
}

export async function firebaseDeleteTempMemoBackup(cleanKey) {
    if (!cleanKey) return;
    try {
        const docRef = doc(db, "temp_memo_backups", cleanKey);
        await deleteDoc(docRef);
    } catch (e) {
        console.error("임시 백업 파기 오류:", e);
    }
}
