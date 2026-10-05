import { state } from './state.js';
import { ensureRouteOwner, selectLatestOwnedRoute } from './route-owner.js';
// js/api.js
// =================================================================
// [배송 경로 PRO] 백엔드 Firebase Firestore / Storage 통신 전담 모듈 (통로 충돌 완벽 방어)
// =================================================================

import { db, storage, getVerifiedAuthSession, requestLicenseMembership } from './admin-api.js';
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
    runTransaction,
    deleteDoc, 
    orderBy, 
    limit 
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";

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
    if (!getVerifiedAuthSession('driver') || typeof deviceId !== 'string' || !deviceId) throw new Error('인증 상태를 확인할 수 없습니다.');
    const result = await requestLicenseMembership({ action: 'checkDevice', deviceId });
    if (typeof result?.blocked !== 'boolean') throw new Error('기기 상태를 확인할 수 없습니다.');
    return result.blocked;
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

// 2. 라이선스 검증
export async function firebaseVerifyLicense(key, phone, deviceId, expectedType = null) {
    // This is business/device binding AFTER server-verified Firebase authentication.
    const identity = getVerifiedAuthSession('driver');
    if (!identity || identity.accountRef !== `licenses/${key}`) return { valid: false };
    let docRef = doc(db, "licenses", key);
    let docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
        return { valid: false, msg: "등록되지 않은 라이선스 키입니다." };
    }

    const data = docSnap.data();
    if (expectedType && (data.type !== expectedType || data.status !== 'active')) return { valid: false };
    phone = data.phone ?? phone ?? '';
    const cleanDigits = String(phone).replace(/[^0-9]/g, '');
    if (cleanDigits.length < 9 || cleanDigits.length > 13) return { valid: false };
    // The server records the current driver's number. It is not an ownership check.

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
    if (getVerifiedAuthSession('driver') !== identity) return { valid: false };
    const routeOwnerId = await ensureRouteOwner(db, docSnap.id, deviceId);
    if (getVerifiedAuthSession('driver') !== identity) return { valid: false };

    return { 
        valid: true, 
        expireDate: data.expireDate, 
        phone: phone, 
        actualKey: docSnap.id,
        routeOwnerId,
        dispatchKey: data.dispatchKey || "",
        allowTms: data.allowTms !== false
    };
}

// 3. 라이선스 상태 감시
export function watchLicenseStatus(key, callback, onUpdateCallback) {
    let cancelled = false;
    (async () => {
        try {
            let docRef = doc(db, "licenses", key);
            let docSnap = await getDoc(docRef);

            if (!docSnap.exists()) {
                docRef = doc(db, "licenses", `PRO-${key}`);
                docSnap = await getDoc(docRef);
            }
            if (!docSnap.exists()) {
                docRef = doc(db, "licenses", `TRIAL-${key}`);
                docSnap = await getDoc(docRef);
            }

            if (cancelled) return;
            if (!docSnap.exists()) {
                if (callback) callback('DELETED', '관리자에 의해 라이선스가 삭제되었습니다.');
                return;
            }

            const data = docSnap.data();
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

    return () => { cancelled = true; };
}

// 3-1. 주요 액션 1회 라이선스 검증
export async function firebaseCheckLicenseOnce(key, deviceId) {
    if (!key) return { valid: false, msg: "라이선스 키가 올바르지 않습니다." };
    try {
        let docRef = doc(db, "licenses", key);
        let docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
            docRef = doc(db, "licenses", `PRO-${key}`);
            docSnap = await getDoc(docRef);
        }
        if (!docSnap.exists()) {
            docRef = doc(db, "licenses", `TRIAL-${key}`);
            docSnap = await getDoc(docRef);
        }

        if (!docSnap.exists()) {
            return { valid: false, msg: "등록되지 않은 라이선스 키입니다." };
        }

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

        return { 
            valid: true, 
            data: data, 
            dispatchKey: data.dispatchKey || "", 
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch('/api/auth', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'startTrial', phone, deviceId }),
            signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error'
        });
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (typeof result.secret !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(result.secret) ||
            typeof result.accountRef !== 'string' || !/^licenses\/TRIAL-[a-f0-9]{32}$/.test(result.accountRef)) throw new Error();
        return result;
    } catch {
        // An uncertain response must never trigger another registration or a legacy write.
        throw new Error('체험 시작을 확인하지 못했습니다. 자동 재신청하지 않습니다. 관리자에게 문의해 주세요.');
    } finally { clearTimeout(timer); }
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
    const identity = getVerifiedAuthSession('driver');
    if (!identity) return 0;
    const myAddresses = new Set();

    try {
        const localList = JSON.parse(localStorage.getItem('deliveryPro_my_parking_memos') || '[]');
        localList.forEach(addr => { if (addr) myAddresses.add(addr); });
    } catch (e) {}

    try {
        // The protected endpoint derives phone/company/owner from the live account.
        // Never widen access using caller-supplied telephone or local login keys.
        const result = await requestLicenseMembership({ action: 'readOwnParkingMemos' });
        if (getVerifiedAuthSession('driver') !== identity) return 0;
        if (!Array.isArray(result?.addresses) || result.addresses.some(a => typeof a !== 'string' || !a || a.length > 4096)) {
            throw new Error('메모 조회 결과를 확인할 수 없습니다.');
        }
        result.addresses.forEach(address => myAddresses.add(address));
    } catch (err) {
        console.error("서버 메모 동기화 오류:", err);
    }

    const finalArray = Array.from(myAddresses);
    if (getVerifiedAuthSession('driver') !== identity) return 0;
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
const routeSavePending = new Map();
const MAX_ROUTE_SAVE_REVISIONS = 64;
export async function saveRouteToFirestore(deviceId, phone, destinations, requireAcknowledgement = false) {
    let revisionKey;
    let revision;
    try {
        const routeOwnerId = state.getRouteOwnerId();
        if (!deviceId || !routeOwnerId || destinations !== state.getDestinations()) return false;
        const identity = getVerifiedAuthSession('driver');
        if (!identity || !/^licenses\/[^/]+$/.test(identity.accountRef)) return false;
        const licenseKey = identity.accountRef.slice('licenses/'.length);
        revisionKey = `${routeOwnerId}|${deviceId}`;
        const updatedAt = state.getRouteUpdatedAt();
        const licenseSnap = await getDoc(doc(db, 'licenses', licenseKey));
        if (getVerifiedAuthSession('driver') !== identity || state.getRouteOwnerId() !== routeOwnerId ||
            destinations !== state.getDestinations() || state.getRouteUpdatedAt() !== updatedAt || !licenseSnap.exists()) return false;
        const license = licenseSnap.data();
        if (license.routeOwnerId !== routeOwnerId || (license.deviceId && license.deviceId !== deviceId) ||
            (license.dispatchKey !== undefined && typeof license.dispatchKey !== 'string')) return false;
        const dispatchKey = license.dispatchKey || '';
        // A company change needs a write even when the route revision is unchanged.
        revision = JSON.stringify([updatedAt, licenseKey, dispatchKey]);
        if (routeSaveRevisions.get(revisionKey) === revision) return true;
        let pending = routeSavePending.get(revisionKey);
        if (pending?.revision === revision) return await pending.promise;
        // Serialize writes to this owner/device. A late old write must not overwrite
        // a newer route; recheck the state after waiting for the previous write.
        while (pending) {
            try { await pending.promise; } catch { /* A failed write does not block retry. */ }
            if (getVerifiedAuthSession('driver') !== identity || state.getRouteOwnerId() !== routeOwnerId ||
                destinations !== state.getDestinations() || state.getRouteUpdatedAt() !== updatedAt) return false;
            if (routeSaveRevisions.get(revisionKey) === revision) return true;
            pending = routeSavePending.get(revisionKey);
            if (pending?.revision === revision) return await pending.promise;
        }
        const routeRef = doc(db, "routes", deviceId);
        const payload = {
            routeOwnerId,
            licenseKey,
            dispatchKey,
            deviceId,
            endLocation: state.getEndLocation(),
            startSelected: state.getStartLocation() !== null,
            startLocation: state.getStartLocation(),
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
        const operation = { revision, promise: null };
        operation.promise = Promise.resolve().then(async () => {
            try {
                await setDoc(routeRef, payload);
                if (!routeSaveRevisions.has(revisionKey) && routeSaveRevisions.size >= MAX_ROUTE_SAVE_REVISIONS) {
                    routeSaveRevisions.delete(routeSaveRevisions.keys().next().value);
                }
                routeSaveRevisions.set(revisionKey, revision);
                return true;
            } finally {
                if (routeSavePending.get(revisionKey) === operation) routeSavePending.delete(revisionKey);
            }
        });
        routeSavePending.set(revisionKey, operation);
        await operation.promise;
        return true;
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
        licenseKey: localStorage.getItem('deliveryProKey') || '',
        dispatchKey: localStorage.getItem('deliveryProDispatchKey') || ''
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
            dispatchKey: ownership.dispatchKey || '',
            destinationId: item.id ?? null,
            deviceId: deviceId,
            phone: driverPhone || "연락처 미등록",
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
            timeString: timeStr
        };
        if (transmission) {
            const completionRef = doc(db, 'completions', transmission.id);
            const operationRef = doc(db, 'completion_operations', transmission.id);
            await runTransaction(db, async transaction => {
                const operation = await transaction.get(operationRef);
                if (operation.exists() && operation.data().action === 'delete') return;
                transaction.set(operationRef, { licenseKey: ownership.licenseKey, routeOwnerId: ownership.routeOwnerId,
                    deviceId, action: 'complete' });
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
            const ownership = getCompletionOwnershipContext();
            const deviceId = localStorage.getItem('deliveryProDeviceId');
            if (!ownership.licenseKey || !deviceId || ownership.routeOwnerId !== routeOwnerId) {
                throw new Error('배송 처리 소유자 정보가 일치하지 않습니다.');
            }
            await runTransaction(db, async transaction => {
                // Durable cancellation wins even when an older completion request arrives late.
                transaction.set(doc(db, 'completion_operations', operationId), {
                    licenseKey: ownership.licenseKey, routeOwnerId, deviceId, action: 'delete' });
                transaction.delete(doc(db, 'completions', docId));
            });
        } else await deleteDoc(doc(db, "completions", docId));
    } catch (e) {
        console.error("완료 데이터 삭제 오류:", e);
        throw e;
    }
}

export async function firebaseClearDeviceData(key) {
    const identity = getVerifiedAuthSession('driver');
    if (!identity || identity.accountRef !== `licenses/${key}`) return;
    const deviceId = localStorage.getItem('deliveryProDeviceId');
    if (!deviceId) return;
    // Server checks the live version/device atomically; an old device cannot
    // clear a replacement device's binding during delayed logout.
    await requestLicenseMembership({ action: 'releaseDevice', deviceId });
}

// 9. TMS(관제) 연결 허용/차단 상태 제어 함수
export async function firebaseSetTmsPermission(key, isAllowed) {
    const identity = getVerifiedAuthSession('driver');
    if (!identity || identity.accountRef !== `licenses/${key}` || typeof isAllowed !== 'boolean') {
        throw new Error('현재 기사 계정을 확인할 수 없습니다.');
    }
    return requestLicenseMembership({ action: 'setTmsPermission', allowed: isAllowed });
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
