// js/delivery.js

// =================================================================
// [배송 동선 PRO] 배송 완료(태그/사진) 및 취소 전담 모듈
// =================================================================

import { saveCompletionToFirestore, firebaseUploadDeliveryPhoto } from './api.js';
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
// 5. 배송 완료 최종 확정 처리
// ==========================================
export async function confirmCompletion(photoUrl = null) {
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

    const loadingMsg = photoUrl 
        ? "사진 등록 및 현장 GPS 완료 처리 중..." 
        : "현장 실제 GPS 수신 및 완료 처리 중...";
    showLoading(loadingMsg);
    
    const realGps = await getDeviceRealGPS();
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

    state.removeDestination(pendingCompletionId);
    state.updateDisplayNumbers();
    if (typeof window.renderList === 'function') window.renderList();
    
    hideLoading();
    closeCompletionModal();
}

// ==========================================
// 6. 배송지 취소 처리
// ==========================================
export async function cancelDestination(id) {
    if (!confirm("이 배송지를 취소하시겠습니까?\n취소된 내역은 '지난배송' 목록에 기록됩니다.")) return;
    
    const destinations = state.getDestinations();
    const item = destinations.find(d => d.id === id);
    if (!item) return;

    showLoading("취소 내역 기록 중...");
    try {
        const realGps = await getDeviceRealGPS();
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
        const cancelTag = "배송 취소";

        const completionDocId = await saveCompletionToFirestore(deviceId, phone, item, cancelTag, actualLat, actualLng, isRealGpsCaptured, null);
        archiveCompletedDelivery(item, cancelTag, completionDocId, null);

        state.removeDestination(id);
        state.updateDisplayNumbers();
        if (typeof window.renderList === 'function') window.renderList();
    } catch (e) {
        alert("취소 처리 중 오류가 발생했습니다.");
    } finally {
        hideLoading();
    }
}

// ==========================================
// 7. 배송 완료 카메라 input 리스너 초기화
// ==========================================
export function initPhotoCompletion() {
    const photoInput = document.getElementById('completion-photo-input');
    if (!photoInput) return;

    photoInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        document.getElementById('completion-modal')?.classList.add('hidden');

        showLoading("사진 압축 및 서버 전송 중...");
        try {
            const deviceId = getOrCreateDeviceId();
            const photoUrl = await firebaseUploadDeliveryPhoto(file, deviceId);
            await confirmCompletion(photoUrl);
        } catch (err) {
            hideLoading();
            alert("사진 전송 중 오류가 발생했습니다: " + err.message);
        } finally {
            e.target.value = '';
        }
    });
}