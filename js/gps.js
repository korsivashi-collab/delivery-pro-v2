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
let isGpsWatcherActive = false; // 기사님의 GPS 활성화 설정 상태 보존

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
export async function reportGpsToFirestore(lat, lng, force = false) {
    if (!lat || !lng) return;

    const now = Date.now();
    // 45초 이내 중복 전송 방지 (관제 강제 요청인 force=true 제외)
    if (!force && now - lastReportTime < 45000) return;
    lastReportTime = now;

    const deviceId = getOrCreateDeviceId ? getOrCreateDeviceId() : localStorage.getItem('deliveryProDeviceId');
    if (!deviceId) return;

    const phone = localStorage.getItem('deliveryProUserPhone') || '';
    const db = getDbInstance();
    if (!db) return;

    try {
        await setDoc(doc(db, "gps_reports", deviceId), {
            deviceId: deviceId,
            phone: phone,
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            updatedAt: now
        }, { merge: true });
    } catch (e) {
        console.error("관제 위치 보고 오류:", e);
    }
}

// ==========================================
// 0-1. 관제 센터의 위치 확인 신호(gps_requests) 실시간 감지
// ==========================================
function listenToGpsRequests() {
    const deviceId = getOrCreateDeviceId ? getOrCreateDeviceId() : localStorage.getItem('deliveryProDeviceId');
    const licKey = localStorage.getItem('deliveryProKey');
    const db = getDbInstance();

    if (!db) {
        setTimeout(listenToGpsRequests, 1000);
        return;
    }

    const handleRequest = async (snap) => {
        if (!snap.exists()) return;
        const reqData = snap.data();
        
        // 최근 20초 이내 유효 요청에 대해서만 1회 강제 위치 보고
        if (reqData.requestedAt && Date.now() - reqData.requestedAt < 20000) {
            const pos = await getDeviceRealGPS();
            if (pos && pos.lat && pos.lng) {
                await reportGpsToFirestore(pos.lat, pos.lng, true);
            }
        }
    };

    if (deviceId && !unsubRequestDevice) {
        try { unsubRequestDevice = onSnapshot(doc(db, "gps_requests", deviceId), handleRequest); } catch (e) {}
    }

    if (licKey && licKey !== deviceId && !unsubRequestKey) {
        try { unsubRequestKey = onSnapshot(doc(db, "gps_requests", licKey), handleRequest); } catch (e) {}
    }
}

// ==========================================
// 1. 하드웨어 GPS 센서 실구동 / 정지 내부 헬퍼 (배터리 누수 차단)
// ==========================================
function _startHardwareWatcher() {
    listenToGpsRequests();

    if (!navigator.geolocation || state.getGpsWatchId() !== null) return;

    const watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;

            state.setLastKnownGps({ lat, lng, timestamp: Date.now() });

            if (Date.now() - lastReportTime >= 45000) {
                reportGpsToFirestore(lat, lng, false);
            }
        },
        (err) => {},
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 }
    );
    
    state.setGpsWatchId(watchId);
}

function _stopHardwareWatcher() {
    const watchId = state.getGpsWatchId();
    if (watchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchId);
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
                _startHardwareWatcher();
            }
        }
    });
}

// ==========================================
// 3. 백그라운드 GPS 위치 추적 시작 (외부 호출용)
// ==========================================
export function startGpsWatcher() {
    isGpsWatcherActive = true;
    _startHardwareWatcher();
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
        const lastGps = state.getLastKnownGps();
        
        // 1분 이내의 최신 좌표가 있으면 재사용
        if (lastGps && (Date.now() - lastGps.timestamp < 60000)) {
            return resolve({ lat: lastGps.lat, lng: lastGps.lng, isReal: true });
        }
        
        if (!navigator.geolocation) {
            return resolve(lastGps ? { ...lastGps, isReal: true } : null);
        }
        
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                state.setLastKnownGps({ lat, lng, timestamp: Date.now() });
                resolve({ lat, lng, isReal: true });
            },
            (err) => {
                const fallbackGps = state.getLastKnownGps();
                resolve(fallbackGps ? { lat: fallbackGps.lat, lng: fallbackGps.lng, isReal: true } : null);
            },
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 }
        );
    });
}

// ==========================================
// 6. 헤더의 [현위치] 버튼 클릭 시 종료 지점으로 설정
// ==========================================
export async function setEndLocationGPS() {
    showLoading("현위치 파악 중...");
    const lastGps = state.getLastKnownGps();
    
    if (lastGps) {
        const addr = await coordToAddress(lastGps.lng, lastGps.lat);
        state.setEndLocation({ lat: lastGps.lat, lng: lastGps.lng, address: addr || "현재 위치 (GPS)" });
        if (!state.saveActiveData()) { hideLoading(); return; }
        if (typeof window.renderList === 'function') window.renderList();
        hideLoading();
        return;
    }

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            async (position) => {
                let lat = position.coords.latitude;
                let lng = position.coords.longitude;
                state.setLastKnownGps({ lat, lng, timestamp: Date.now() });
                
                const addr = await coordToAddress(lng, lat);
                state.setEndLocation({ lat, lng, address: addr || "현재 위치 (GPS)" });
                if (!state.saveActiveData()) { hideLoading(); return; }
                if (typeof window.renderList === 'function') window.renderList();
                hideLoading();
            },
            (error) => { 
                hideLoading(); 
                alert("위치 정보를 가져올 수 없습니다."); 
            },
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 }
        );
    } else { 
        hideLoading(); 
        alert("GPS를 지원하지 않는 기기입니다."); 
    }
}
