// js/delivery.js

// =================================================================
// [배송 동선 PRO] 배송 완료(태그/사진) 및 취소 전담 모듈
// =================================================================

import { saveCompletionToFirestore, getCompletionOwnershipContext, firebaseUploadDeliveryPhoto, saveRouteToFirestore } from './api.js';
import { archiveCompletedDelivery } from './support.js';
import { state } from './state.js';
import { getOrCreateDeviceId, updatePhotoCompButtonState } from './auth.js';

let pendingCompletionId = null;
let selectedCompTag = "";

function localCompletionContext() {
    try {
        return { deviceId: getOrCreateDeviceId(), phone: localStorage.getItem('deliveryProUserPhone') || '',
            completionOwnership: getCompletionOwnershipContext() };
    } catch (error) { state.reportStorageFailure(error); return null; }
}

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
    
    try { updatePhotoCompButtonState(!!localStorage.getItem('deliveryProDispatchKey')); }
    catch (error) { state.reportStorageFailure(error); return; }
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
// 5. 일반 태그 배송 완료 확정 처리 (🌟 체감 0초 백그라운드 처리)
// ==========================================
export function confirmCompletion(photoUrl = null) {
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

    // 🌟 [핵심 수정]: 모달을 닫기 전에 삭제할 대상 ID를 변수에 먼저 안전하게 백업합니다.
    const targetId = pendingCompletionId;
    const destinations = state.getDestinations();
    const item = destinations.find(d => d.id === targetId);
    if (!item) { 
        closeCompletionModal(); 
        return; 
    }


    // 🌟 [1단계: 로딩 없는 즉각 화면 처리 및 순간 GPS 캡처]
    const lastGps = state.getLastKnownGps();
    let actualLat = item.lat;
    let actualLng = item.lng;
    let isRealGpsCaptured = false;

    // 버튼을 누른 찰나에 확보되어 있는 백그라운드 GPS를 즉시 사용
    if (lastGps && lastGps.lat && lastGps.lng) {
        actualLat = lastGps.lat;
        actualLng = lastGps.lng;
        isRealGpsCaptured = true;
    }

    const context = localCompletionContext();
    if (!context) return;
    const { deviceId, phone, completionOwnership } = context;

    // 지난배송 이력 즉시 등록 및 리스트 제거
    let historyEntry;
    if (!state.runLocalTransaction(() => {
        historyEntry = archiveCompletedDelivery(item, finalTag, null, photoUrl, { ...completionOwnership, phone, deviceId });
        state.removeDestination(targetId);
        state.updateDisplayNumbers();
    })) return;
    closeCompletionModal();
    if (typeof window.renderList === 'function') window.renderList();
    
    // 잔여 배송 목록 관제 서버 즉시 동기화
    saveRouteToFirestore(deviceId, phone, state.getDestinations());

    // 햅틱 피드백으로 완료 체감
    if (navigator.vibrate) navigator.vibrate(40);

    // 🌟 [2단계: 백그라운드 DB 전송 (화면 간섭 없음)]
    (async () => {
        try {
            const completionDocId = await saveCompletionToFirestore(
                deviceId, phone, item, finalTag, actualLat, actualLng, isRealGpsCaptured, photoUrl, completionOwnership
            );
            
            // 로컬 이력에 서버 등록 문서 ID 동기화
            if (completionDocId) {
                let history = JSON.parse(state.readLocalData('deliveryPro_history') || '[]');
                const hIdx = history.findIndex(h => h.id === historyEntry.id && h.timestamp === historyEntry.timestamp && h.routeOwnerId === historyEntry.routeOwnerId);
                if (hIdx > -1) {
                    history[hIdx].completionDocId = completionDocId;
                    state.writeLocalHistory(history);
                }
            }
        } catch (e) {
            console.error("수동 완료 백그라운드 동기화 오류:", e);
        }
    })();
}

// ==========================================
// 6. 배송지 취소 처리 (0초 즉시 삭제 및 관제 실시간 동기화)
// ==========================================
export function cancelDestination(id) {
    if (!confirm("이 배송지를 취소하시겠습니까?\n취소된 내역은 '지난배송' 목록에 기록됩니다.")) return;
    
    const destinations = state.getDestinations();
    const item = destinations.find(d => d.id === id);
    if (!item) return;

    const context = localCompletionContext();
    if (!context) return;
    const { deviceId, phone, completionOwnership } = context;
    const cancelTag = '배송 취소';
    let historyEntry;
    if (!state.runLocalTransaction(() => {
        historyEntry = archiveCompletedDelivery(item, cancelTag, null, null, { ...completionOwnership, phone, deviceId });
        state.removeDestination(id);
        state.updateDisplayNumbers();
    })) return;
    if (typeof window.renderList === 'function') window.renderList();

    // 2. 관제 센터 서버(routes/{deviceId})의 남은 배송 목록 즉시 동기화
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


            // Firestore 관제 서버에 취소 내역 비동기 전송
            const completionDocId = await saveCompletionToFirestore(
                deviceId, phone, item, cancelTag, actualLat, actualLng, isRealGpsCaptured, null, completionOwnership
            );

            if (completionDocId) {
                let history = JSON.parse(state.readLocalData('deliveryPro_history') || '[]');
                const hIdx = history.findIndex(h => h.id === historyEntry.id && h.timestamp === historyEntry.timestamp && h.routeOwnerId === historyEntry.routeOwnerId);
                if (hIdx > -1) {
                    history[hIdx].completionDocId = completionDocId;
                    state.writeLocalHistory(history);
                }
            }
        } catch (e) {
            console.error("취소 백그라운드 동기화 오류:", e);
        }
    })();
}

// ==========================================
// 7. 배송 완료 카메라 input 리스너 (🌟 체감 0초 백그라운드 완료 탑재)
// ==========================================
export function initPhotoCompletion() {
    const photoInput = document.getElementById('completion-photo-input');
    if (!photoInput) return;

    photoInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const targetId = pendingCompletionId;
        const destinations = state.getDestinations();
        const item = destinations.find(d => d.id === targetId);

        if (!item) {
            closeCompletionModal();
            e.target.value = '';
            return;
        }


        // 🌟 [1단계: 체감 0초 즉각 완료] 대기 없이 화면에서 즉시 배송지 삭제 및 순간 GPS 확보
        const finalTag = selectedCompTag && selectedCompTag !== '기타' ? selectedCompTag : "사진 완료";
        const context = localCompletionContext();
        if (!context) { e.target.value = ''; return; }
        const { deviceId, phone, completionOwnership } = context;

        const lastGps = state.getLastKnownGps();
        let actualLat = item.lat;
        let actualLng = item.lng;
        let isRealGpsCaptured = false;

        // 사진을 찍기 시작하거나 완료 버튼을 누른 시점의 백그라운드 GPS 즉시 사용
        if (lastGps && lastGps.lat && lastGps.lng) {
            actualLat = lastGps.lat;
            actualLng = lastGps.lng;
            isRealGpsCaptured = true;
        }

        // 지난배송 목록에 즉시 등록 (사진 URL은 백그라운드 업로드 완료 후 업데이트)
        let historyEntry;
        if (!state.runLocalTransaction(() => {
            historyEntry = archiveCompletedDelivery(item, finalTag, null, null, { ...completionOwnership, phone, deviceId });
            state.removeDestination(targetId);
            state.updateDisplayNumbers();
        })) { e.target.value = ''; return; }
        closeCompletionModal();
        if (typeof window.renderList === 'function') window.renderList();

        // 관제 서버 잔여 배송 목록 즉시 동기화
        saveRouteToFirestore(deviceId, phone, state.getDestinations());

        // 기사 완료 진동 피드백
        if (navigator.vibrate) navigator.vibrate(40);

        // 🌟 [2단계: 백그라운드 비동기 처리] 사진 압축 및 업로드를 화면 간섭 없이 조용히 실행
        (async () => {
            try {
                // 사진 전송 대기
                const photoUrl = await firebaseUploadDeliveryPhoto(file, deviceId);

                // 관제 서버에 완료 내역 최종 보관
                const completionDocId = await saveCompletionToFirestore(
                    deviceId, phone, item, finalTag, actualLat, actualLng, isRealGpsCaptured, photoUrl, completionOwnership
                );

                // 로컬 지난배송 이력에 서버 등록 번호 및 사진 링크 갱신
                let history = JSON.parse(state.readLocalData('deliveryPro_history') || '[]');
                const hIdx = history.findIndex(h => h.id === historyEntry.id && h.timestamp === historyEntry.timestamp && h.routeOwnerId === historyEntry.routeOwnerId);
                if (hIdx > -1) {
                    if (completionDocId) history[hIdx].completionDocId = completionDocId;
                    if (photoUrl) {
                        history[hIdx].photoUrl = photoUrl;
                        history[hIdx].hasPhoto = true;
                    }
                    state.writeLocalHistory(history);
                }
            } catch (err) {
                console.error("사진 백그라운드 완료 처리 중 오류:", err);
            }
        })();

        e.target.value = '';
    });
}
