// js/gps.js

// =================================================================
// [배송 동선 PRO] 기기 GPS 위치 센서 및 현위치 추적 전담 모듈
// =================================================================

import { getApp, getApps } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getFirestore, doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getOrCreateDeviceId } from './auth.js';
import { coordToAddress } from './kakao.js';
import { showLoading, hideLoading } from './utils.js';
import { state } from './state.js';

// 관제 실시간 요청 리스너 해제용 핸들러
let unsubRequestDevice = null;
let unsubRequestKey = null;
let lastReportTime = 0;

// 🌟 api.js export 의존성을 제거하고 실행 중인 Firebase 인스턴스를 직접 안전하게 획득
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
    // 40초 이내 중복 전송 방지 (단, 관제 직접 요청인 force=true는 즉시 전송)
    if (!force && now - lastReportTime < 40000) return;
    lastReportTime = now;

    const deviceId = getOrCreateDeviceId ? getOrCreateDeviceId() : localStorage.getItem('deliveryProDeviceId');
    const licKey = localStorage.getItem('deliveryProKey');
    const phone = localStorage.getItem('deliveryProUserPhone') || '';

    const payload = {
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        phone: phone,
        updatedAt: now
    };

    const db = getDbInstance();
    if (!db) return;

    try {
        // 1. 기기 고유 deviceId 문서로 보고
        if (deviceId) {
            await setDoc(doc(db, "gps_reports", deviceId), { ...payload, deviceId }, { merge: true });
        }
        // 2. 라이선스 키가 다를 경우 키 문서로도 동시 보고 (관제 매칭 실패 방지)
        if (licKey && licKey !== deviceId) {
            await setDoc(doc(db, "gps_reports", licKey), { ...payload, deviceId: licKey }, { merge: true });
        }
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
        // Firebase 앱 초기화 타이밍 대기 후 1초 뒤 재시도
        setTimeout(listenToGpsRequests, 1000);
        return;
    }

    const handleRequest = async (snap) => {
        if (!snap.exists()) return;
        const reqData = snap.data();
        
        // 관제 요청이 최근 20초 이내에 발생한 유효한 요청일 때만 즉시 측정 후 보고
        if (reqData.requestedAt && Date.now() - reqData.requestedAt < 20000) {
            const pos = await getDeviceRealGPS();
            if (pos && pos.lat && pos.lng) {
                await reportGpsToFirestore(pos.lat, pos.lng, true);
            }
        }
    };

    // deviceId 채널 구독
    if (deviceId && !unsubRequestDevice) {
        try {
            unsubRequestDevice = onSnapshot(doc(db, "gps_requests", deviceId), handleRequest);
        } catch (e) {}
    }

    // licenseKey 채널 구독
    if (licKey && licKey !== deviceId && !unsubRequestKey) {
        try {
            unsubRequestKey = onSnapshot(doc(db, "gps_requests", licKey), handleRequest);
        } catch (e) {}
    }
}

// ==========================================
// 1. 백그라운드 GPS 위치 추적 시작
// ==========================================
export function startGpsWatcher() {
    // 관제 위치 요청 감시 리스너 가동
    listenToGpsRequests();

    if (!navigator.geolocation || state.getGpsWatchId() !== null) return;
    
    const watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;

            state.setLastKnownGps({ 
                lat: lat, 
                lng: lng, 
                timestamp: Date.now() 
            });

            // 주행 중 관제 센터로 백그라운드 자동 주기적 보고
            reportGpsToFirestore(lat, lng, false);
        },
        (err) => {},
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 10000 }
    );
    
    state.setGpsWatchId(watchId);
}

// ==========================================
// 2. GPS 위치 추적 중지 (설정 토글용)
// ==========================================
export function stopGpsWatcher() {
    const watchId = state.getGpsWatchId();
    if (watchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchId);
        state.setGpsWatchId(null);
    }

    if (unsubRequestDevice) { 
        unsubRequestDevice(); 
        unsubRequestDevice = null; 
    }
    if (unsubRequestKey) { 
        unsubRequestKey(); 
        unsubRequestKey = null; 
    }
}

// ==========================================
// 3. 실제 현장 GPS 좌표 획득 (완료 및 관제 요청용)
// ==========================================
export function getDeviceRealGPS() {
    return new Promise((resolve) => {
        const lastGps = state.getLastKnownGps();
        
        // 1분 이내에 수신된 신선한 좌표가 있으면 즉시 재사용 및 보고
        if (lastGps && (Date.now() - lastGps.timestamp < 60000)) {
            reportGpsToFirestore(lastGps.lat, lastGps.lng, false);
            return resolve({ lat: lastGps.lat, lng: lastGps.lng, isReal: true });
        }
        
        if (!navigator.geolocation) {
            return resolve(lastGps ? { ...lastGps, isReal: true } : null);
        }
        
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                const newGps = { lat, lng, timestamp: Date.now() };
                state.setLastKnownGps(newGps);
                reportGpsToFirestore(lat, lng, false);
                resolve({ lat, lng, isReal: true });
            },
            (err) => {
                const fallbackGps = state.getLastKnownGps();
                if (fallbackGps) {
                    reportGpsToFirestore(fallbackGps.lat, fallbackGps.lng, false);
                    resolve({ lat: fallbackGps.lat, lng: fallbackGps.lng, isReal: true });
                } else {
                    resolve(null);
                }
            },
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 }
        );
    });
}

// ==========================================
// 4. 헤더의 [현위치] 버튼 클릭 시 종료 지점으로 설정
// ==========================================
export async function setEndLocationGPS() {
    showLoading("현위치 파악 중...");
    const lastGps = state.getLastKnownGps();
    
    if (lastGps) {
        const addr = await coordToAddress(lastGps.lng, lastGps.lat);
        state.setEndLocation({ 
            lat: lastGps.lat, 
            lng: lastGps.lng, 
            address: addr || "현재 위치 (GPS)" 
        });
        state.saveActiveData();
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
                reportGpsToFirestore(lat, lng, false);
                
                const addr = await coordToAddress(lng, lat);
                state.setEndLocation({ 
                    lat: lat, 
                    lng: lng, 
                    address: addr || "현재 위치 (GPS)" 
                });
                state.saveActiveData();
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