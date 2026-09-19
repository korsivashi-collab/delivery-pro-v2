// js/gps.js

// =================================================================
// [배송 동선 PRO] 기기 GPS 위치 센서 및 현위치 추적 전담 모듈
// =================================================================

import { coordToAddress } from './kakao.js';
import { showLoading, hideLoading } from './utils.js';
import { state } from './state.js';

// ==========================================
// 1. 백그라운드 GPS 위치 추적 시작
// ==========================================
export function startGpsWatcher() {
    if (!navigator.geolocation || state.getGpsWatchId() !== null) return;
    
    const watchId = navigator.geolocation.watchPosition(
        (pos) => {
            state.setLastKnownGps({ 
                lat: pos.coords.latitude, 
                lng: pos.coords.longitude, 
                timestamp: Date.now() 
            });
        },
        (err) => {},
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 30000 }
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
}

// ==========================================
// 3. 실제 현장 GPS 좌표 획득 (완료 및 관제 요청용)
// ==========================================
export function getDeviceRealGPS() {
    return new Promise((resolve) => {
        const lastGps = state.getLastKnownGps();
        
        // 2분 이내에 수신된 좌표가 있으면 즉시 재사용
        if (lastGps && (Date.now() - lastGps.timestamp < 120000)) {
            return resolve({ lat: lastGps.lat, lng: lastGps.lng, isReal: true });
        }
        
        if (!navigator.geolocation) {
            return resolve(lastGps ? { ...lastGps, isReal: true } : null);
        }
        
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const newGps = { 
                    lat: pos.coords.latitude, 
                    lng: pos.coords.longitude, 
                    timestamp: Date.now() 
                };
                state.setLastKnownGps(newGps);
                resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, isReal: true });
            },
            (err) => {
                const fallbackGps = state.getLastKnownGps();
                if (fallbackGps) resolve({ lat: fallbackGps.lat, lng: fallbackGps.lng, isReal: true });
                else resolve(null);
            },
            { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 }
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
            { enableHighAccuracy: false, timeout: 5000, maximumAge: 30000 }
        );
    } else { 
        hideLoading(); 
        alert("GPS를 지원하지 않는 기기입니다."); 
    }
}