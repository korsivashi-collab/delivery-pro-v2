// js/gps.js

// =================================================================
// [배송 동선 PRO] 기기 GPS 위치 센서 및 현위치 추적 전담 모듈 (초절전 배터리 보호 탑재)
// =================================================================

import { getApp, getApps } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getFirestore, doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getOrCreateDeviceId } from './auth.js';
import { coordToAddress } from './kakao.js';
import { showLoading, hideLoading } from './utils.js';
import { state } from './state.js';

let unsubRequestDevice = null;
let unsubRequestKey = null;
let lastReportTime = 0;
let reportInFlight = null;
let reportRetryAfter = 0;
let reportFailures = 0;
let lastUploadedAt = 0;
let lastUploadedDevice = null;
let requestListenerIdentity = '';
const gpsRequests = new Map();
let isGpsWatcherActive = false; // 기사님의 GPS 활성화 설정 상태 보존
let gpsSession = 0;

function canTrackAutomatically() {
    return isGpsWatcherActive && state.getDestinations().length > 0;
}

// Recheck the list without changing the user's saved GPS preference.
export function refreshGpsTracking() {
    if (!isGpsWatcherActive || document.visibilityState === 'hidden') {
        if (state.getGpsWatchId() !== null || unsubRequestDevice || unsubRequestKey) _stopHardwareWatcher();
    } else if (state.getDestinations().length === 0) {
        if (state.getGpsWatchId() !== null) _stopHardwareWatcher();
        // Explicit dispatch requests remain separate from automatic tracking.
        listenToGpsRequests();
    } else {
        _startHardwareWatcher();
    }
}

// 요청 처리 시간은 수신한 기기의 경과 시간으로 제한한다.
const gpsRequestClock = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

function hasPendingForcedGpsRequest() {
    const now = gpsRequestClock();
    return [...gpsRequests.values()].some(entry => entry.requestId && entry.pending &&
        entry.session === gpsSession && now < entry.expiresAt);
}

function cachePosition(position) {
    const gps = { lat: position.coords.latitude, lng: position.coords.longitude,
        timestamp: position.timestamp, accuracy: position.coords.accuracy };
    return state.setLastKnownGps(gps) ? state.getLastKnownGps() : null;
}

function invalidateGps(error) {
    state.setLastKnownGps(null);
    if (error) console.warn('현재 GPS 위치를 사용할 수 없습니다:', error.code);
}

// 🌟 안전한 Firestore 인스턴스 획득
function getDbInstance() {
    try {
        if (getApps().length > 0) {
            return getFirestore(getApp());
        }
    } catch (e) {
        console.warn("Firestore 인스턴스 획득 대기:", e);
    }
    return null;
}

// ==========================================
// 0. 관제 서버(Firestore)로 GPS 좌표 보고 엔진
// ==========================================
export async function reportGpsToFirestore(lat, lng, force = false, requestedAt = null, request = null) {
    const session = gpsSession;
    if (!force && !canTrackAutomatically()) return false;
    // 수동 요청을 수신한 뒤에는 새 일반 보고가 먼저 전송되지 않도록 한다.
    if (!force && hasPendingForcedGpsRequest()) return false;
    if (reportInFlight) {
        if (!force) return false;
        await reportInFlight;
    }
    if (session !== gpsSession || document.visibilityState === 'hidden' || navigator.onLine === false) return false;
    if (request && gpsRequestClock() >= request.expiresAt) return false;
    let gps = state.getLastKnownGps();
    // 이전 write를 기다리는 동안 캐시가 만료됐다면 강제 요청에 한해 새 위치를 확보한다.
    if (!gps && request) {
        gps = await getDeviceRealGPS();
        if (session !== gpsSession) return false;
    }
    if (!gps) return false;
    // A pending SDK operation can outlive its original fix. Always send the current valid fix.
    lat = gps.lat; lng = gps.lng;
    const now = Date.now();
    if ((!request && now < reportRetryAfter) || (!force && now - lastReportTime < 45000)) return false;
    if (request && gpsRequestClock() >= request.expiresAt) return false;
    // 구버전 관제 요청의 호환 경로. 새 요청의 응답 판정에는 기기 간 시각을 쓰지 않는다.
    if (!request && requestedAt !== null && (now - requestedAt < 0 || now - requestedAt >= 20000)) return false;
    let deviceId, phone, db;
    try {
        deviceId = getOrCreateDeviceId ? getOrCreateDeviceId() : localStorage.getItem('deliveryProDeviceId');
        phone = localStorage.getItem('deliveryProUserPhone') || '';
        db = getDbInstance();
    } catch (error) { console.error('GPS 보고 준비 오류:', error); return false; }
    if (!deviceId || !db) return false;
    // A successful ordinary report made after this request already answers it.
    if (!request && force && requestedAt !== null && lastUploadedDevice === deviceId && lastUploadedAt >= requestedAt) return true;
    // Multiple forced callers may have awaited the same earlier write.
    if (reportInFlight) return reportGpsToFirestore(lat, lng, force, requestedAt, request);
    reportInFlight = Promise.resolve().then(async () => {
        try {
            // SDK에 넘기기 전 예약된 일반 보고도 수동 요청에 우선권을 양보한다.
            if (session !== gpsSession || (!force && !canTrackAutomatically())) return false;
            if (!force && hasPendingForcedGpsRequest()) return false;
            await setDoc(doc(db, 'gps_reports', deviceId), {
                deviceId, phone, lat, lng, updatedAt: now, requestId: request?.requestId || null
            }, { merge: true });
            lastReportTime = Date.now();
            lastUploadedAt = now;
            lastUploadedDevice = deviceId;
            reportFailures = 0;
            reportRetryAfter = 0;
            return true;
        } catch (error) {
            if (!request) {
                reportFailures++;
                reportRetryAfter = Date.now() + Math.min(30000, 5000 * 2 ** Math.min(reportFailures - 1, 3));
            }
            console.error('관제 위치 보고 오류:', error);
            return false;
        } finally { reportInFlight = null; }
    });
    return reportInFlight;
}

// Device and license documents carry the same requestId (or legacy requestedAt).
async function handleGpsRequest(snap, identity, deviceId) {
    if (identity !== requestListenerIdentity || document.visibilityState === 'hidden' || navigator.onLine === false || !snap.exists()) return false;
    const data = snap.data();
    const timestamp = data.requestedAt;
    const age = Date.now() - timestamp;
    const requestId = typeof data.requestId === 'string' && data.requestId.length > 0 && data.requestId.length <= 200 ? data.requestId : null;
    // requestId 요청은 원격 시각을 거절 기준으로 사용하지 않는다.
    // 로컬 수신 후 처리 제한과 ID 중복 제거로 제어한다. 구버전 요청만 기존 판정을 유지한다.
    if (!requestId && (!Number.isFinite(timestamp) || age < 0 || age >= 20000)) return false;
    const key = deviceId + '|' + (requestId ? `id:${requestId}` : timestamp);
    for (const [oldKey, entry] of gpsRequests) {
        if (!entry.pending && gpsRequestClock() - entry.receivedAt >= 120000) gpsRequests.delete(oldKey);
    }
    const previous = gpsRequests.get(key);
    if (previous?.done) return true;
    if (previous?.promise) return previous.promise;
    if (requestId && previous?.attempted) return false;
    if (!requestId && Date.now() < reportRetryAfter) return false;
    const session = gpsSession;
    const request = requestId ? { requestId, expiresAt: gpsRequestClock() + 20000 } : null;
    const entry = { receivedAt: gpsRequestClock(), requestId, session, expiresAt: request?.expiresAt,
        pending: true, done: false, promise: null, attempted: false };
    gpsRequests.set(key, entry);
    entry.promise = Promise.resolve().then(async () => {
        try {
            const gps = await getDeviceRealGPS();
            if (!gps || !state.isFreshGps(gps) || session !== gpsSession || identity !== requestListenerIdentity) return false;
            entry.done = await reportGpsToFirestore(gps.lat, gps.lng, true, timestamp, request);
            return entry.done;
        } catch (error) { console.warn('GPS 요청 처리 실패:', error); return false; }
        finally { entry.pending = false; entry.attempted = true; entry.promise = null; }
    });
    return entry.promise;
}

function listenToGpsRequests() {
    if (!isGpsWatcherActive || document.visibilityState === 'hidden') return;
    const deviceId = getOrCreateDeviceId ? getOrCreateDeviceId() : localStorage.getItem('deliveryProDeviceId');
    const licKey = localStorage.getItem('deliveryProKey');
    const identity = deviceId + '|' + (licKey || '');
    if (identity !== requestListenerIdentity) {
        if (unsubRequestDevice) unsubRequestDevice();
        if (unsubRequestKey) unsubRequestKey();
        unsubRequestDevice = null; unsubRequestKey = null;
        requestListenerIdentity = identity;
    }
    const db = getDbInstance();
    if (!db) { setTimeout(listenToGpsRequests, 1000); return; }
    const handle = snap => handleGpsRequest(snap, identity, deviceId);
    if (deviceId && !unsubRequestDevice) {
        try { unsubRequestDevice = onSnapshot(doc(db, 'gps_requests', deviceId), handle); } catch (error) { console.warn('GPS 요청 구독 실패:', error); }
    }
    if (licKey && licKey !== deviceId && !unsubRequestKey) {
        try { unsubRequestKey = onSnapshot(doc(db, 'gps_requests', licKey), handle); } catch (error) { console.warn('GPS 요청 구독 실패:', error); }
    }
}

// ==========================================
// 1. 하드웨어 GPS 센서 실구동 / 정지 내부 헬퍼 (배터리 누수 차단)
// ==========================================
function _startHardwareWatcher() {
    listenToGpsRequests();

    if (!canTrackAutomatically()) return;

    if (!navigator.geolocation) { invalidateGps(); return; }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (state.getGpsWatchId() !== null) return;
    const session = ++gpsSession;

    try {
        const watchId = navigator.geolocation.watchPosition(
            (pos) => {
                if (session !== gpsSession || !canTrackAutomatically()) return;
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;

                if (!cachePosition(pos)) return;

                if (Date.now() - lastReportTime >= 45000) {
                    reportGpsToFirestore(lat, lng, false);
                }
            },
            (err) => { if (session === gpsSession) invalidateGps(err); },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 }
        );
    
        state.setGpsWatchId(watchId);
    } catch (error) { invalidateGps(error); }
}

function _stopHardwareWatcher() {
    gpsSession++;
    requestListenerIdentity = '';
    invalidateGps();
    const watchId = state.getGpsWatchId();
    if (watchId !== null && navigator.geolocation) {
        try { navigator.geolocation.clearWatch(watchId); }
        catch (error) { console.warn('GPS 감시 정지 오류:', error.code); }
        state.setGpsWatchId(null);
    }

    if (unsubRequestDevice) { unsubRequestDevice(); unsubRequestDevice = null; }
    if (unsubRequestKey) { unsubRequestKey(); unsubRequestKey = null; }
}

// ==========================================
// 2. 화면 On/Off 감지: 화면 꺼지면 하드웨어 칩 즉시 수면 모드
// ==========================================
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            // 화면이 꺼지거나 다른 앱으로 전환 시 GPS 칩셋 전원 차단
            _stopHardwareWatcher();
        } else if (document.visibilityState === 'visible') {
            // 화면이 다시 켜졌을 때 사용자가 GPS를 켜둔 상태였다면 즉시 복구
            if (isGpsWatcherActive) {
                refreshGpsTracking();
            }
        }
    });
}

// ==========================================
// 3. 백그라운드 GPS 위치 추적 시작 (외부 호출용)
// ==========================================
export function startGpsWatcher() {
    isGpsWatcherActive = true;
    refreshGpsTracking();
}

// ==========================================
// 4. GPS 위치 추적 중지 (설정 토글용)
// ==========================================
export function stopGpsWatcher() {
    isGpsWatcherActive = false;
    _stopHardwareWatcher();
}

// ==========================================
// 5. 실제 현장 GPS 좌표 획득 (완료 및 관제 요청용)
// ==========================================
export function getDeviceRealGPS() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            invalidateGps();
            return resolve(null);
        }
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return resolve(null);
        const lastGps = state.getLastKnownGps();
        if (lastGps) return resolve({ ...lastGps, isReal: true });
        const session = gpsSession;
        try {
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    if (session !== gpsSession) { resolve(null); return; }
                    const gps = cachePosition(pos);
                    resolve(gps ? { ...gps, isReal: true } : null);
                },
                (err) => {
                    if (session === gpsSession) invalidateGps(err);
                    resolve(null);
                },
                { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
            );
        } catch (error) { invalidateGps(error); resolve(null); }
    });
}

// ==========================================
// 6. 헤더의 [현위치] 버튼 클릭 시 종료 지점으로 설정
// ==========================================
export async function setEndLocationGPS() {
    showLoading("현위치 파악 중...");
    const owner = state.getRouteOwnerId();
    const session = gpsSession;
    try {
        const gps = await getDeviceRealGPS();
        if (!gps || !state.isFreshGps(gps)) {
            alert("현재 위치를 확인할 수 없습니다. GPS와 위치 권한을 확인한 후 다시 시도해 주세요.");
            return;
        }
        const addr = await coordToAddress(gps.lng, gps.lat);
        // Address lookup may outlive the fix or an external-app/account transition.
        if (session !== gpsSession || owner !== state.getRouteOwnerId() || !state.isFreshGps(gps)) {
            alert("위치 정보가 만료되었습니다. 현위치를 다시 확인해 주세요.");
            return;
        }
        state.setEndLocation({ lat: gps.lat, lng: gps.lng, address: addr || "현재 위치 (GPS)" });
        if (!state.saveActiveData()) return;
        if (typeof window.renderList === 'function') window.renderList();
    } catch (error) {
        console.warn('현위치 종료점 설정 실패:', error);
        alert("현재 위치를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.");
    } finally { hideLoading(); }
}

// The SDK owns retries while a write is pending; reconnect starts no competing write.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', async () => {
        if (!canTrackAutomatically() || document.visibilityState !== 'visible' || reportInFlight) return;
        const gps = await getDeviceRealGPS();
        if (gps && state.isFreshGps(gps)) await reportGpsToFirestore(gps.lat, gps.lng);
    });
}
