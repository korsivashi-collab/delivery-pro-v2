// js/api.js
// =================================================================
// [배송 경로 PRO] 백엔드 Firebase Firestore / Storage 통신 전담 모듈
// =================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getFirestore, collection, addDoc, getDoc, getDocs, onSnapshot, query, where, updateDoc, doc, increment, setDoc, deleteDoc, orderBy } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
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

// 이미지 클라이언트 압축 함수
async function compressImageToBlob(file, maxDimension = 1280, quality = 0.75) {
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

// 0. 기기 고유번호(deviceId) 접속 제한(블랙리스트) 검증 (에러 방지용 필수 함수)
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

// 1. 배송 완료 사진 업로드
export async function firebaseUploadDeliveryPhoto(file, deviceId) {
    const blob = await compressImageToBlob(file, 1280, 0.75);
    const safeDeviceId = (deviceId || 'dev').replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = `delivery_photos/${Date.now()}_${safeDeviceId}.jpg`;
    const storageRef = ref(storage, filePath);
    const snapshot = await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });
    return await getDownloadURL(snapshot.ref);
}

// 2. 라이선스 검증
export async function firebaseVerifyLicense(key, phone, deviceId) {
    const cleanDigits = (phone || "").replace(/[^0-9]/g, '');
    if (!cleanDigits || cleanDigits.length < 9) {
        return { valid: false, msg: "휴대폰 번호를 정확하게 입력해야 로그인이 완료됩니다." };
    }

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
        return { valid: false, msg: "사용이 일시 정지된 계정입니다.\n관리자에게 문의하세요." };
    }

    if (data.expireDate) {
        const parts = data.expireDate.split('.');
        const expire = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59);
        if (new Date() > expire) {
            return { valid: false, msg: `라이선스 유효기간(${data.expireDate})이 만료되었습니다.` };
        }
    }

    if (!data.deviceId) {
        await updateDoc(docRef, { deviceId: deviceId, phone: phone });
    } else if (data.deviceId !== deviceId) {
        return { valid: false, msg: "다른 기기에 등록된 라이선스 키입니다.\n관리자에게 기기 초기화를 요청하세요." };
    } else {
        await updateDoc(docRef, { phone: phone });
    }

    return { 
        valid: true, 
        expireDate: data.expireDate, 
        phone: phone, 
        actualKey: docSnap.id,
        dispatchKey: data.dispatchKey || "",
        allowTms: data.allowTms !== false
    };
}

// 3. 라이선스 실시간 상태 감시
export function watchLicenseStatus(key, callback, onUpdateCallback) {
    const docRef = doc(db, "licenses", key);
    return onSnapshot(docRef, (docSnap) => {
        if (!docSnap.exists()) {
            callback('DELETED', '관리자에 의해 라이선스가 삭제되었습니다.');
            return;
        }
        const data = docSnap.data();
        if (data.status === 'suspended') {
            callback('SUSPENDED', '관리자에 의해 라이선스가 일시 정지되었습니다.');
            return;
        }
        if (data.expireDate) {
            const parts = data.expireDate.split('.');
            const expire = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59);
            if (new Date() > expire) {
                callback('EXPIRED', `라이선스 유효기간(${data.expireDate})이 만료되었습니다.`);
                return;
            }
        }
        if (onUpdateCallback) {
            onUpdateCallback(data);
        }
    });
}

// 4. GPS 요청 리스너
export function startGpsRequestLister(myDeviceId, myPhone, myKey, getRealGpsCallback) {
    const q = query(collection(db, "gps_requests"), where("deviceId", "==", myDeviceId));
    return onSnapshot(q, (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === "added" || change.type === "modified") {
                const now = new Date();
                const isWeekday = now.getDay() >= 1 && now.getDay() <= 5;
                const isWorkingTime = now.getHours() >= 9 && now.getHours() < 17;
                if (!isWeekday || !isWorkingTime) return;

                const req = change.doc.data();
                if (req && (Date.now() - req.requestedAt < 30000)) {
                    const gps = await getRealGpsCallback();
                    if (gps && gps.lat && gps.lng) {
                        await setDoc(doc(db, "gps_reports", myDeviceId), {
                            deviceId: myDeviceId,
                            phone: myPhone || "",
                            lat: gps.lat,
                            lng: gps.lng,
                            updatedAt: Date.now()
                        }, { merge: true });
                    }
                }
            }
        });
    });
}

// 🌟 [신규 추가] 관제 센터 실시간 자동할당 동선 수신 리스너 (routes/{deviceId} 구독)
export function listenToActiveRoutes(deviceId, onRoutesReceived, onRoutesCleared) {
    if (!deviceId) return null;
    const routeDocRef = doc(db, "routes", deviceId);
    return onSnapshot(routeDocRef, (docSnap) => {
        if (docSnap.exists()) {
            const data = docSnap.data();
            if (onRoutesReceived) {
                onRoutesReceived(data.destinations || [], data);
            }
        } else {
            // 관제에서 전체 초기화(clearAllExcelRows) 등으로 동선 문서가 삭제된 경우
            if (onRoutesCleared) {
                onRoutesCleared();
            }
        }
    }, (error) => {
        console.error("관제 동선 실시간 수신 오류:", error);
    });
}

// 5. 관제 메시지 리스너
export function startDispatchMessageListener(myDeviceId, myPhone, myKey, onMessageReceived) {
    const cleanPhone = (myPhone || '').replace(/[^0-9]/g, '');
    const cleanKeyOnly = (myKey || '').toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '');
    const q = query(collection(db, "dispatch_messages"), orderBy("createdAt", "desc"));

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
    const cleanDigits = (phone || "").replace(/[^0-9]/g, '');
    if (!cleanDigits || cleanDigits.length < 9) {
        return { valid: false, msg: "휴대폰 번호를 정확하게 입력해 주세요." };
    }

    const q = query(
        collection(db, "licenses"),
        where("deviceId", "==", deviceId),
        where("type", "==", "trial")
    );
    const querySnapshot = await getDocs(q);

    if (!querySnapshot.empty) {
        return { valid: false, msg: "이미 7일 무료 체험을 사용하신 기기입니다.\n정식 라이선스를 이용해 주세요." };
    }

    const now = new Date();
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + 7);
    const expDateStr = `${expDate.getFullYear()}.${String(expDate.getMonth() + 1).padStart(2, '0')}.${String(expDate.getDate()).padStart(2, '0')}`;

    const chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    let p1 = "", p2 = "";
    for (let i = 0; i < 4; i++) {
        p1 += chars.charAt(Math.floor(Math.random() * chars.length));
        p2 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const trialKey = `TRIAL-${p1}-${p2}`;

    await setDoc(doc(db, "licenses", trialKey), {
        key: trialKey,
        type: 'trial',
        phone: phone,
        deviceId: deviceId,
        expireDate: expDateStr,
        status: 'active',
        dispatchKey: '',
        allowTms: true,
        createdAt: now.getTime()
    });

    return { valid: true, trialKey: trialKey, expireDate: expDateStr, dispatchKey: '' };
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
            const licQ = query(collection(db, "licenses"), where("phone", "==", phone));
            const licSnap = await getDocs(licQ);
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
export async function saveRouteToFirestore(deviceId, phone, destinations) {
    try {
        const routeRef = doc(db, "routes", deviceId);
        await setDoc(routeRef, {
            phone: phone || "연락처 미등록",
            updatedAt: new Date().getTime(),
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
        });
    } catch (e) { console.error("동선 전송 오류:", e); }
}

export async function saveCompletionToFirestore(deviceId, driverPhone, item, tagText, actualLat, actualLng, isReal, photoUrl = null) {
    try {
        const now = new Date();
        const timeStr = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
        
        const docRef = await addDoc(collection(db, "completions"), {
            deviceId: deviceId,
            phone: driverPhone || "연락처 미등록",
            customerPhone: item.phone || "",
            address: item.address || "",
            lat: actualLat,
            lng: actualLng,
            isRealGps: !!isReal,
            tag: tagText || "",
            hasPhoto: !!photoUrl,
            photoUrl: photoUrl || "",
            completedAt: now.getTime(),
            timeString: timeStr
        });
        return docRef.id;
    } catch (e) { 
        console.error("완료 내역 저장 오류:", e); 
        return null;
    }
}

export async function deleteCompletionFromFirestore(docId) {
    try {
        if (!docId) return;
        await deleteDoc(doc(db, "completions", docId));
    } catch (e) {
        console.error("완료 데이터 삭제 오류:", e);
    }
}

export async function firebaseClearDeviceData(key) {
    try {
        if (!key) return;
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
        
        if ((await getDoc(docRef)).exists()) {
            await updateDoc(docRef, { deviceId: "", phone: "" });
        }
    } catch(e) {
        console.error("서버 기기 정보 초기화 오류:", e);
    }
}

// 9. TMS(관제) 연결 허용/차단 상태 제어 함수
export async function firebaseSetTmsPermission(key, isAllowed) {
    try {
        if (!key) throw new Error("유효한 라이선스 키 값이 없습니다.");
        
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
        
        if (docSnap.exists()) {
            if (isAllowed) {
                await updateDoc(docRef, { allowTms: true });
            } else {
                await updateDoc(docRef, { allowTms: false, dispatchKey: "" });
            }
        } else {
            throw new Error("서버에서 계정 정보를 찾을 수 없습니다.");
        }
    } catch(e) {
        console.error("TMS 상태 변경 오류:", e);
        throw e;
    }
}

// =================================================================
// 10. 개인 메모 기기변경 임시 금고 (12시간 자동 파기 및 암호화 보관)
// =================================================================

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