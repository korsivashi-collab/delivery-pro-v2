// =================================================================
// [배송 경로 PRO] 백엔드 Firebase Firestore / Storage 통신 전담 모듈
// =================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { 
    getFirestore, collection, addDoc, getDoc, getDocs, onSnapshot, 
    query, where, updateDoc, doc, increment, setDoc, deleteDoc, orderBy, limit 
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyBZKERmiPis4PCVDSYg0SSRTWV7L3z_5tw",
    authDomain: "delivery-pro-dd272.firebaseapp.com",
    projectId: "delivery-pro-dd272",
    storageBucket: "delivery-pro-dd272.firebasestorage.app",
    messagingSenderId: "329406776647",
    appId: "1:329406776647:web:62b32568328dd1eecab862"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

// 🌟 이미지 클라이언트 초고속 압축 (960px / 0.65)
async function compressImageToBlob(file, maxDimension = 960, quality = 0.65) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                let width = img.width, height = img.height;
                if (width > height) {
                    if (width > maxDimension) { height = Math.round((height * maxDimension) / width); width = maxDimension; }
                } else {
                    if (height > maxDimension) { width = Math.round((width * maxDimension) / height); height = maxDimension; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob); else reject(new Error("압축 실패"));
                }, 'image/jpeg', quality);
            };
            img.onerror = (e) => reject(e);
        };
        reader.onerror = (e) => reject(e);
    });
}

// 0. 기기 접속 제한 검증
export async function checkIfDeviceBlocked(deviceId) {
    if (!deviceId) return false;
    try {
        const docRef = doc(db, "blocked_devices", deviceId);
        const snap = await getDoc(docRef);
        return snap.exists();
    } catch (e) { return false; }
}

// 1. 배송 완료 사진 고속 업로드
export async function firebaseUploadDeliveryPhoto(file, deviceId) {
    const blob = await compressImageToBlob(file, 960, 0.65);
    const safeDeviceId = (deviceId || 'dev').replace(/[^a-zA-Z0-9_-]/g, '');
    const storageRef = ref(storage, `delivery_photos/${Date.now()}_${safeDeviceId}.jpg`);
    const snapshot = await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });
    return await getDownloadURL(snapshot.ref);
}

// 2. 라이선스 검증
export async function firebaseVerifyLicense(key, phone, deviceId) {
    const cleanDigits = (phone || "").replace(/[^0-9]/g, '');
    if (!cleanDigits || cleanDigits.length < 9) return { valid: false, msg: "휴대폰 번호 오류" };

    let docRef = doc(db, "licenses", key);
    let docSnap = await getDoc(docRef);
    if (!docSnap.exists()) { docRef = doc(db, "licenses", `PRO-${key}`); docSnap = await getDoc(docRef); }
    if (!docSnap.exists()) { docRef = doc(db, "licenses", `TRIAL-${key}`); docSnap = await getDoc(docRef); }
    if (!docSnap.exists()) return { valid: false, msg: "미등록 키" };

    const data = docSnap.data();
    if (data.status === 'suspended') return { valid: false, msg: "정지된 계정" };

    if (data.expireDate) {
        const parts = data.expireDate.split('.');
        if (new Date() > new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59)) {
            return { valid: false, msg: "기간 만료" };
        }
    }

    if (!data.deviceId) await updateDoc(docRef, { deviceId: deviceId, phone: phone });
    else if (data.deviceId !== deviceId) return { valid: false, msg: "다른 기기 등록됨" };
    else await updateDoc(docRef, { phone: phone });

    return { valid: true, expireDate: data.expireDate, phone: phone, actualKey: docSnap.id, dispatchKey: data.dispatchKey || "", allowTms: data.allowTms !== false };
}

// 3. 라이선스 상태 실시간 감시
export function watchLicenseStatus(key, callback, onUpdateCallback) {
    (async () => {
        try {
            let docRef = doc(db, "licenses", key);
            let docSnap = await getDoc(docRef);
            if (!docSnap.exists()) { docRef = doc(db, "licenses", `PRO-${key}`); docSnap = await getDoc(docRef); }
            if (!docSnap.exists()) { docRef = doc(db, "licenses", `TRIAL-${key}`); docSnap = await getDoc(docRef); }

            if (!docSnap.exists()) { if(callback) callback('DELETED', '삭제됨'); return; }

            const data = docSnap.data();
            if (data.status === 'suspended') { if(callback) callback('SUSPENDED', '정지됨'); return; }

            if (data.expireDate) {
                const parts = data.expireDate.split('.');
                if (new Date() > new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59)) {
                    if(callback) callback('EXPIRED', '만료됨'); return;
                }
            }
            if (onUpdateCallback) onUpdateCallback(data);
        } catch (e) {}
    })();
    return () => {};
}

// 3-1. 주요 액션 1회 라이선스 검증
export async function firebaseCheckLicenseOnce(key, deviceId) {
    if (!key) return { valid: false, msg: "키 오류" };
    try {
        let docRef = doc(db, "licenses", key);
        let docSnap = await getDoc(docRef);
        if (!docSnap.exists()) { docRef = doc(db, "licenses", `PRO-${key}`); docSnap = await getDoc(docRef); }
        if (!docSnap.exists()) { docRef = doc(db, "licenses", `TRIAL-${key}`); docSnap = await getDoc(docRef); }
        
        if (!docSnap.exists()) return { valid: false, msg: "미등록" };
        const data = docSnap.data();
        if (data.status === 'suspended') return { valid: false, msg: "정지" };
        
        if (data.expireDate) {
            const parts = data.expireDate.split('.');
            if (new Date() > new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59)) return { valid: false, msg: "만료" };
        }
        if (deviceId && data.deviceId && data.deviceId !== deviceId) return { valid: false, msg: "다른기기" };

        return { valid: true, data: data, dispatchKey: data.dispatchKey || "", expireDate: data.expireDate || "", allowTms: data.allowTms !== false };
    } catch (e) {
        return { valid: true, isOffline: true };
    }
}

// 🌟 4. 관제 센터 실시간 자동할당 동선 수신 (경합 방어 탑재)
export function listenToActiveRoutes(deviceId, arg2, arg3, arg4) {
    let phone = ""; let onRoutesReceived = null; let onRoutesCleared = null;
    if (typeof arg2 === 'function') { onRoutesReceived = arg2; onRoutesCleared = arg3; phone = typeof arg4 === 'string' ? arg4 : ""; } 
    else if (typeof arg2 === 'string') { phone = arg2; onRoutesReceived = arg3; onRoutesCleared = arg4; }

    if (!deviceId && !phone) return () => {};

    const unsubs = [];
    let lastHandledTime = 0;
    const initializationTime = Date.now();
    let hadExistingRoute = false;

    const handleRouteData = (data, exists) => {
        const now = Date.now();
        if (!exists || !data || !data.destinations || !Array.isArray(data.destinations) || data.destinations.length === 0) {
            if ((now - initializationTime < 2500) && !hadExistingRoute) return; 
            lastHandledTime = now; hadExistingRoute = false;
            if (typeof onRoutesCleared === 'function') onRoutesCleared();
            return;
        }
        const updateTime = data.updatedAt || now;
        if (updateTime < lastHandledTime && (lastHandledTime - updateTime > 2000)) return; 
        
        lastHandledTime = updateTime; hadExistingRoute = true;
        if (typeof onRoutesReceived === 'function') onRoutesReceived(data.destinations, data);
    };

    if (deviceId) unsubs.push(onSnapshot(doc(db, "routes", deviceId), snap => handleRouteData(snap.data(), snap.exists())));
    if (phone) {
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        if (cleanPhone && cleanPhone !== deviceId) unsubs.push(onSnapshot(doc(db, "routes", cleanPhone), snap => handleRouteData(snap.data(), snap.exists())));
        if (phone !== cleanPhone && phone !== deviceId) unsubs.push(onSnapshot(doc(db, "routes", phone), snap => handleRouteData(snap.data(), snap.exists())));
    }
    return () => unsubs.forEach(unsub => { try { unsub(); } catch (e) {} });
}

export const startAssignedRouteListener = listenToActiveRoutes;

// 4-1. 포그라운드 복귀 시 1회 즉시 동기화 보조 함수 (오프라인 증발 방어)
export async function fetchActiveRouteOnce(deviceId, phone) {
    try {
        const cleanPhone = (phone || "").replace(/[^0-9]/g, '');
        let latestData = null; let latestTime = -1; let foundAnyDoc = false;

        const checkDoc = async (id) => {
            if (!id) return;
            const snap = await getDoc(doc(db, "routes", id));
            if (snap.exists()) {
                foundAnyDoc = true; const d = snap.data();
                if (d && (d.updatedAt || 0) > latestTime) { latestTime = d.updatedAt || 0; latestData = d; }
            }
        };

        await checkDoc(deviceId); await checkDoc(cleanPhone); if (phone !== cleanPhone) await checkDoc(phone);
        if (!foundAnyDoc) return { destinations: ['PRESERVE_LOCAL_ON_NO_DOC'], isNoDoc: true };
        return latestData || { destinations: [] };
    } catch (e) {
        return { destinations: ['PRESERVE_LOCAL_ON_ERROR'], isOffline: true };
    }
}

// 5. 관제 메시지 리스너
export function startDispatchMessageListener(myDeviceId, myPhone, myKey, onMessageReceived) {
    const cleanPhone = (myPhone || '').replace(/[^0-9]/g, '');
    const cleanKeyOnly = (myKey || '').toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '');
    const q = query(collection(db, "dispatch_messages"), orderBy("createdAt", "desc"), limit(5));

    return onSnapshot(q, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
                const msg = change.doc.data();
                const isDevMatch = msg.targetDeviceIds && msg.targetDeviceIds.includes(myDeviceId);
                const isPhoneMatch = cleanPhone && msg.targetPhones && msg.targetPhones.some(p => p.replace(/[^0-9]/g, '') === cleanPhone);
                const isKeyMatch = myKey && ((msg.targetDeviceIds && (msg.targetDeviceIds.includes(myKey) || msg.targetDeviceIds.includes(cleanKeyOnly))) || (msg.targetPhones && msg.targetPhones.some(p => p.toUpperCase().includes(cleanKeyOnly))));

                if (isDevMatch || isPhoneMatch || isKeyMatch) {
                    const isMaster = (msg.senderKey === 'MASTER' || msg.senderType === 'MASTER' || msg.senderTitle === '운영사 알림');
                    if (onMessageReceived) onMessageReceived({ msgId: change.doc.id, content: msg.content, dateStr: msg.dateStr, timeStr: msg.timeStr, senderTitle: msg.senderTitle || (isMaster ? '운영사 알림' : '회사 알림'), senderType: msg.senderType || (isMaster ? 'MASTER' : 'DISPATCH') });
                }
            }
        });
    });
}

// 6. 7일 무료 체험 시작
export async function firebaseStartTrial(phone, deviceId) {
    const cleanDigits = (phone || "").replace(/[^0-9]/g, '');
    if (!cleanDigits || cleanDigits.length < 9) return { valid: false, msg: "번호 오류" };

    const q = query(collection(db, "licenses"), where("deviceId", "==", deviceId), where("type", "==", "trial"));
    if (!(await getDocs(q)).empty) return { valid: false, msg: "이미 1회 체험을 사용함" };

    const expDate = new Date(); expDate.setDate(expDate.getDate() + 7);
    const expDateStr = `${expDate.getFullYear()}.${String(expDate.getMonth() + 1).padStart(2, '0')}.${String(expDate.getDate()).padStart(2, '0')}`;
    
    const chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    let p1 = "", p2 = "";
    for (let i = 0; i < 4; i++) { p1 += chars.charAt(Math.floor(Math.random() * chars.length)); p2 += chars.charAt(Math.floor(Math.random() * chars.length)); }
    const trialKey = `TRIAL-${p1}-${p2}`;

    await setDoc(doc(db, "licenses", trialKey), { key: trialKey, type: 'trial', phone: phone, deviceId: deviceId, expireDate: expDateStr, status: 'active', dispatchKey: '', allowTms: true, createdAt: Date.now() });
    return { valid: true, trialKey: trialKey, expireDate: expDateStr, dispatchKey: '' };
}

// 7. 주차 및 건물 메모 관련
export async function getMemosFromFirestore(address) {
    const q = query(collection(db, "memos"), where("address", "==", address));
    let memos = [];
    (await getDocs(q)).forEach((snap) => { let d = snap.data(); if (!d.reported) memos.push({ id: snap.id, ...d }); });
    return memos.sort((a, b) => (b.likes || 0) - (a.likes || 0));
}

export async function getBatchMemosFromFirestore(addresses) {
    if (!addresses || addresses.length === 0) return {};
    let allMemosMap = {};
    for (let i = 0; i < addresses.length; i += 30) {
        const chunk = addresses.slice(i, i + 30);
        const q = query(collection(db, "memos"), where("address", "in", chunk));
        (await getDocs(q)).forEach((snap) => {
            let d = snap.data();
            if (!d.reported) { if (!allMemosMap[d.address]) allMemosMap[d.address] = []; allMemosMap[d.address].push({ id: snap.id, ...d }); }
        });
    }
    for (let addr in allMemosMap) allMemosMap[addr].sort((a, b) => (b.likes || 0) - (a.likes || 0));
    return allMemosMap;
}

export async function saveMemoToFirestore(address, deviceId, memoText, phone = "") {
    const now = new Date();
    const timeStr = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const cleanPhone = (phone || "").replace(/[^0-9]/g, '');

    const q = query(collection(db, "memos"), where("address", "==", address));
    let existingDocs = [];
    (await getDocs(q)).forEach(snap => {
        const d = snap.data(); const dPhone = (d.phone || "").replace(/[^0-9]/g, '');
        if (d.deviceId === deviceId || (cleanPhone && dPhone && dPhone === cleanPhone)) existingDocs.push({ id: snap.id, ...d });
    });

    if (existingDocs.length > 0) {
        await updateDoc(doc(db, "memos", existingDocs[0].id), { memo: memoText, time: timeStr, phone: phone || "", deviceId: deviceId, updatedAt: now.getTime(), reported: false });
        for (let i = 1; i < existingDocs.length; i++) await deleteDoc(doc(db, "memos", existingDocs[i].id));
    } else {
        await addDoc(collection(db, "memos"), { address, memo: memoText, deviceId, phone: phone || "", time: timeStr, likes: 0, reported: false, createdAt: now.getTime() });
    }
}

export async function syncMyParkingMemosFromServer(phone, deviceId, licenseKey) {
    const cleanPhone = (phone || "").replace(/[^0-9]/g, '');
    const myAddresses = new Set();
    try { JSON.parse(localStorage.getItem('deliveryPro_my_parking_memos') || '[]').forEach(addr => { if (addr) myAddresses.add(addr); }); } catch (e) {}

    try {
        if (deviceId) (await getDocs(query(collection(db, "memos"), where("deviceId", "==", deviceId)))).forEach(snap => { if (snap.data().address) myAddresses.add(snap.data().address); });
        if (phone) (await getDocs(query(collection(db, "memos"), where("phone", "==", phone)))).forEach(snap => { if (snap.data().address) myAddresses.add(snap.data().address); });
        
        if (cleanPhone) {
            const userDevIds = new Set();
            (await getDocs(query(collection(db, "licenses"), where("phone", "==", phone)))).forEach(snap => { if (snap.data().deviceId) userDevIds.add(snap.data().deviceId); });
            for (const dId of userDevIds) {
                if (dId !== deviceId) (await getDocs(query(collection(db, "memos"), where("deviceId", "==", dId)))).forEach(snap => { if (snap.data().address) myAddresses.add(snap.data().address); });
            }
        }
    } catch (err) {}
    const finalArray = Array.from(myAddresses);
    localStorage.setItem('deliveryPro_my_parking_memos', JSON.stringify(finalArray));
    return finalArray.length;
}

export async function likeMemoInFirestore(docId) { await updateDoc(doc(db, "memos", docId), { likes: increment(1) }); }
export async function reportMemoInFirestore(docId) { await updateDoc(doc(db, "memos", docId), { reported: true }); }

// 8. 동기화 및 기록
export async function saveRouteToFirestore(deviceId, phone, destinations) {
    try {
        if (!deviceId) return;
        await setDoc(doc(db, "routes", deviceId), { phone: phone || "연락처 미등록", updatedAt: Date.now(), destinations: destinations.map(d => ({ id: d.id, displayNumber: d.displayNumber || 0, address: d.address || "", lat: d.lat || 0, lng: d.lng || 0, phone: d.phone || "", storeName: d.storeName || "", orderNo: d.orderNo || "", memo: d.memo || "", items: d.items || [] })) });
    } catch (e) {}
}

export async function saveCompletionToFirestore(deviceId, driverPhone, item, tagText, actualLat, actualLng, isReal, photoUrl = null) {
    try {
        const now = new Date();
        const docRef = await addDoc(collection(db, "completions"), {
            deviceId: deviceId, phone: driverPhone || "", customerPhone: item.phone || "", address: item.address || "", orderNo: item.orderNo || "", storeName: item.storeName || "", lat: actualLat, lng: actualLng, isRealGps: !!isReal, tag: tagText || "", hasPhoto: !!photoUrl, photoUrl: photoUrl || "", completedAt: now.getTime(), timeString: `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`
        });
        return docRef.id;
    } catch (e) { return null; }
}

export async function deleteCompletionFromFirestore(docId) { try { if (docId) await deleteDoc(doc(db, "completions", docId)); } catch (e) {} }

export async function firebaseClearDeviceData(key) {
    try {
        if (!key) return;
        let docRef = doc(db, "licenses", key);
        let docSnap = await getDoc(docRef);
        if (!docSnap.exists()) { docRef = doc(db, "licenses", `PRO-${key}`); docSnap = await getDoc(docRef); }
        if (!docSnap.exists()) { docRef = doc(db, "licenses", `TRIAL-${key}`); docSnap = await getDoc(docRef); }
        if ((await getDoc(docRef)).exists()) await updateDoc(docRef, { deviceId: "", phone: "" });
    } catch(e) {}
}

// 9. TMS 연결 제어
export async function firebaseSetTmsPermission(key, isAllowed) {
    try {
        if (!key) throw new Error("키 오류");
        let docRef = doc(db, "licenses", key);
        let docSnap = await getDoc(docRef);
        if (!docSnap.exists()) { docRef = doc(db, "licenses", `PRO-${key}`); docSnap = await getDoc(docRef); }
        if (!docSnap.exists()) { docRef = doc(db, "licenses", `TRIAL-${key}`); docSnap = await getDoc(docRef); }
        
        if (docSnap.exists()) {
            if (isAllowed) await updateDoc(docRef, { allowTms: true });
            else await updateDoc(docRef, { allowTms: false, dispatchKey: "" });
        } else throw new Error("서버 계정 없음");
    } catch(e) { throw e; }
}

// 10. 기기변경 임시 백업
export async function firebaseUploadTempMemoBackup(cleanKey, encryptedPayload, count) {
    if (!cleanKey) throw new Error("식별자 오류");
    const now = Date.now();
    await setDoc(doc(db, "temp_memo_backups", cleanKey), { licenseKey: cleanKey, payload: encryptedPayload, count: count, createdAt: now, expireAt: now + (12 * 60 * 60 * 1000) });
}

export async function firebaseGetTempMemoBackup(cleanKey) {
    if (!cleanKey) return null;
    const docRef = doc(db, "temp_memo_backups", cleanKey);
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) return null;
    const data = docSnap.data();
    if (data.expireAt && Date.now() > data.expireAt) { try { await deleteDoc(docRef); } catch (e) {} return { expired: true }; }
    return { expired: false, payload: data.payload, count: data.count || 0, createdAt: data.createdAt, expireAt: data.expireAt };
}

export async function firebaseDeleteTempMemoBackup(cleanKey) {
    if (!cleanKey) return;
    try { await deleteDoc(doc(db, "temp_memo_backups", cleanKey)); } catch (e) {}
}