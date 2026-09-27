// js/delivery.js

// =================================================================
// [배송 동선 PRO] 배송 완료(태그/사진) 및 취소 전담 모듈
// =================================================================

import { saveCompletionToFirestore, firebaseUploadDeliveryPhoto, saveRouteToFirestore } from './api.js';
import { archiveCompletedDelivery } from './support.js';
import { showLoading, hideLoading } from './utils.js';
import { state } from './state.js';
import { getOrCreateDeviceId, updatePhotoCompButtonState } from './auth.js';
import { getDeviceRealGPS } from './gps.js';

let pendingCompletionId = null;
let selectedCompTag = "";

// ==========================================
// 1. 배송 완료 모달 열기
// ==========================================
export function completeDestination(id) {
    pendingCompletionId = id;
    selectedCompTag = "";
    
    document.querySelectorAll('.comp-tag-btn').forEach(b => {
        b.classList.remove('bg-emerald-100', 'border-emerald-400', 'text-emerald-800');
        b.classList.add('bg-gray-50', 'border-gray-200', 'text-gray-700');
    });
    
    const etcContainer = document.getElementById('comp-etc-input-container');
    const etcInput = document.getElementById('comp-etc-input');
    
    if (etcContainer) etcContainer.classList.add('hidden');
    if (etcInput) etcInput.value = "";
    
    updatePhotoCompButtonState(!!localStorage.getItem('deliveryProDispatchKey'));
    document.getElementById('completion-modal')?.classList.remove('hidden');
}

// ==========================================
// 2. 완료 태그 선택
// ==========================================
export function selectCompletionTag(btn, tag) {
    document.querySelectorAll('.comp-tag-btn').forEach(b => {
        b.classList.remove('bg-emerald-100', 'border-emerald-400', 'text-emerald-800');
        b.classList.add('bg-gray-50', 'border-gray-200', 'text-gray-700');
    });
    
    btn.classList.remove('bg-gray-50', 'border-gray-200', 'text-gray-700');
    btn.classList.add('bg-emerald-100', 'border-emerald-400', 'text-emerald-800');
    
    selectedCompTag = tag;
    
    const etcContainer = document.getElementById('comp-etc-input-container');
    const etcInput = document.getElementById('comp-etc-input');
    
    if (tag === '기타') {
        if (etcContainer) etcContainer.classList.remove('hidden');
        setTimeout(() => { if (etcInput) etcInput.focus(); }, 100);
    } else { 
        if (etcContainer) etcContainer.classList.add('hidden'); 
    }
}

// ==========================================
// 3. 완료 모달 닫기
// ==========================================
export function closeCompletionModal() {
    document.getElementById('completion-modal')?.classList.add('hidden');
    pendingCompletionId = null;
}

// ==========================================
// 4. 사진 촬영/선택 창 호출
// ==========================================
export function triggerPhotoCompletion() {
    document.getElementById('completion-photo-input')?.click();
}

// ==========================================
// 5. 배송 완료 최종 확정 처리 (사전 수신 GPS 파라미터 지원)
// ==========================================
export async function confirmCompletion(photoUrl = null, precomputedGps = null) {
    if (typeof photoUrl !== 'string') photoUrl = null;
    
    if (!photoUrl && !selectedCompTag) { 
        alert("배송 완료 태그를 선택해 주세요."); 
        return; 
    }
    
    let finalTag = selectedCompTag;
    
    if (selectedCompTag === '기타') {
        const etcText = (document.getElementById('comp-etc-input')?.value || '').trim();
        if (!etcText && !photoUrl) { 
            alert("기타 사유를 상세하게 입력해 주세요."); 
            return; 
        }
        finalTag = etcText ? `기타: ${etcText}` : "사진 완료";
    } else if (!finalTag && photoUrl) {
        finalTag = "사진 완료";
    }

    const destinations = state.getDestinations();
    const item = destinations.find(d => d.id === pendingCompletionId);
    if (!item) { 
        closeCompletionModal(); 
        return; 
    }

    document.getElementById('completion-modal')?.classList.add('hidden');

    // 사전 측정된 GPS가 없을 때만 단독 GPS 측정 진행
    let realGps = precomputedGps;
    if (!realGps) {
        const loadingMsg = photoUrl 
            ? "사진 등록 및 현장 GPS 완료 처리 중..." 
            : "현장 실제 GPS 수신 및 완료 처리 중...";
        showLoading(loadingMsg);
        realGps = await getDeviceRealGPS();
    } else {
        showLoading("완료 정보 저장 중...");
    }
    
    let actualLat = item.lat;
    let actualLng = item.lng;
    let isRealGpsCaptured = false;

    if (realGps && realGps.lat && realGps.lng) {
        actualLat = realGps.lat;
        actualLng = realGps.lng;
        isRealGpsCaptured = true;
    }

    const deviceId = getOrCreateDeviceId();
    const phone = localStorage.getItem('deliveryProUserPhone') || "";
    
    const completionDocId = await saveCompletionToFirestore(deviceId, phone, item, finalTag, actualLat, actualLng, isRealGpsCaptured, photoUrl);
    archiveCompletedDelivery(item, finalTag, completionDocId, photoUrl);

    // 1. 로컬 상태에서 완료된 배송지 제거 및 순번 재정렬
    state.removeDestination(pendingCompletionId);
    state.updateDisplayNumbers();
    if (typeof window.renderList === 'function') window.renderList();
    
    // 2. 🌟 관제 센터 서버(routes/{deviceId})의 남은 배송 목록 즉시 동기화
    saveRouteToFirestore(deviceId, phone, state.getDestinations());

    hideLoading();
    closeCompletionModal();
}

// ==========================================
// 6. 배송지 취소 처리 (0초 즉시 삭제 및 관제 실시간 동기화)
// ==========================================
export function cancelDestination(id) {
    if (!confirm("이 배송지를 취소하시겠습니까?\n취소된 내역은 '지난배송' 목록에 기록됩니다.")) return;
    
    const destinations = state.getDestinations();
    const item = destinations.find(d => d.id === id);
    if (!item) return;

    // 1. 화면 및 리스트에서 즉시 제거
    state.removeDestination(id);
    state.updateDisplayNumbers();
    if (typeof window.renderList === 'function') window.renderList();

    const deviceId = getOrCreateDeviceId();
    const phone = localStorage.getItem('deliveryProUserPhone') || "";

    // 2. 🌟 관제 센터 서버(routes/{deviceId})의 남은 배송 목록 즉시 동기화
    saveRouteToFirestore(deviceId, phone, state.getDestinations());

    // 3. 백그라운드 비동기 처리
    (async () => {
        try {
            const lastGps = state.getLastKnownGps();
            let actualLat = item.lat;
            let actualLng = item.lng;
            let isRealGpsCaptured = false;

            if (lastGps && lastGps.lat && lastGps.lng) {
                actualLat = lastGps.lat;
                actualLng = lastGps.lng;
                isRealGpsCaptured = true;
            }

            const cancelTag = "배송 취소";

            // 로컬 '지난배송' 목록에 즉시 등록
            archiveCompletedDelivery(item, cancelTag, null, null);

            // Firestore 관제 서버에 취소 내역 비동기 전송
            const completionDocId = await saveCompletionToFirestore(deviceId, phone, item, cancelTag, actualLat, actualLng, isRealGpsCaptured, null);

            if (completionDocId) {
                let history = JSON.parse(localStorage.getItem('deliveryPro_history') || '[]');
                if (history.length > 0 && history[0].id === item.id) {
                    history[0].completionDocId = completionDocId;
                    localStorage.setItem('deliveryPro_history', JSON.stringify(history));
                }
            }
        } catch (e) {
            console.error("취소 백그라운드 동기화 오류:", e);
        }
    })();
}

// ==========================================
// 7. 배송 완료 카메라 input 리스너 초기화 (병렬 고속 처리 탑재)
// ==========================================
export function initPhotoCompletion() {
    const photoInput = document.getElementById('completion-photo-input');
    if (!photoInput) return;

    photoInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        document.getElementById('completion-modal')?.classList.add('hidden');

        showLoading("사진 전송 및 현장 GPS 확인 중...");
        try {
            const deviceId = getOrCreateDeviceId();

            // 🌟 [병렬 고속 파이프라인]: 사진 업로드와 GPS 좌표 수신을 동시에 가동
            const [photoUrl, realGps] = await Promise.all([
                firebaseUploadDeliveryPhoto(file, deviceId),
                getDeviceRealGPS()
            ]);

            // 이미 확보된 GPS 값을 전달하여 재대기 없이 즉시 완료 확정
            await confirmCompletion(photoUrl, realGps);
        } catch (err) {
            hideLoading();
            alert("사진 완료 처리 중 오류가 발생했습니다: " + err.message);
        } finally {
            e.target.value = '';
        }
    });
}