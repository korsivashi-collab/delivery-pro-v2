// js/delivery.js

// =================================================================
// [배송 동선 PRO] 배송 완료(태그/사진) 및 취소 전담 모듈
// =================================================================

import { getCompletionOwnershipContext } from './api.js';
import { createCompletionTask, stageCompletionTask, wakeCompletionQueue } from './completion-queue.js';
import { completionPhotos } from './completion-photos.js';
import { archiveCompletedDelivery } from './support.js';
import { state } from './state.js';
import { getOrCreateDeviceId, updatePhotoCompButtonState } from './auth.js';
import { storageDiagnostic } from './storage-diagnostics.js';

let pendingCompletionId = null;
let selectedCompTag = "";

function localCompletionContext() {
    try {
        return { deviceId: getOrCreateDeviceId(), phone: localStorage.getItem('deliveryProUserPhone') || '',
            completionOwnership: getCompletionOwnershipContext() };
    } catch (error) { state.reportStorageFailure(error, { operation: 'localCompletionContext', stage: 'read-before' }); return null; }
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
    catch (error) { state.reportStorageFailure(error, { operation: 'completeDestination', stage: 'read-before' }); return; }
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
function finishLocally(item, tag, context, photoId = null, photoUrl = null) {
    let job;
    if (!state.runLocalTransaction(() => {
        job = createCompletionTask(item, tag, context, photoId, photoUrl);
        const historyEntry = archiveCompletedDelivery(item, tag, null, photoUrl,
            { ...context.completionOwnership, phone: context.phone, deviceId: context.deviceId });
        stageCompletionTask(job, historyEntry);
        state.removeDestination(item.id);
        state.updateDisplayNumbers();
    })) return false;
    // Local completion is committed. A UI error must not undo it or discard its durable photo.
    try {
        if (pendingCompletionId === item.id) closeCompletionModal();
        if (typeof window.renderList === 'function') window.renderList();
        if (navigator.vibrate) navigator.vibrate(40);
    } catch (error) { console.error('완료 화면 갱신 오류:', error); }
    // Schedule compression/network work after the synchronous completed-UI update.
    try { wakeCompletionQueue(); } catch (error) { console.error('전송대기 재개 오류:', error); }
    return true;
}

export function confirmCompletion(photoUrl = null) {
    if (typeof photoUrl !== 'string') photoUrl = null;
    if (!photoUrl && !selectedCompTag) { alert('배송 완료 태그를 선택해 주세요.'); return; }
    let finalTag = selectedCompTag;
    if (selectedCompTag === '기타') {
        const text = (document.getElementById('comp-etc-input')?.value || '').trim();
        if (!text && !photoUrl) { alert('기타 사유를 상세하게 입력해 주세요.'); return; }
        finalTag = text ? '기타: ' + text : '사진 완료';
    } else if (!finalTag && photoUrl) finalTag = '사진 완료';
    const item = state.getDestinations().find(d => d.id === pendingCompletionId);
    if (!item) { closeCompletionModal(); return; }
    if (photoStagingIds.has(item.id)) return;
    const context = localCompletionContext();
    if (context) finishLocally(item, finalTag, context, null, photoUrl);
}

export function cancelDestination(id) {
    if (!confirm("이 배송지를 취소하시겠습니까?\n취소된 내역은 '지난배송' 목록에 기록됩니다.")) return;
    const item = state.getDestinations().find(d => d.id === id);
    if (!item || photoStagingIds.has(id)) return;
    const context = localCompletionContext();
    if (context) finishLocally(item, '배송 취소', context);
}

const photoStagingIds = new Set();
let photoCompletionInitialized = false;
export function initPhotoCompletion() {
    const photoInput = document.getElementById('completion-photo-input');
    if (!photoInput || photoCompletionInitialized) return;
    photoCompletionInitialized = true;
    photoInput.addEventListener('change', async e => {
        const file = e.target.files[0];
        const item = state.getDestinations().find(d => d.id === pendingCompletionId);
        if (!file || !item || photoStagingIds.has(item.id)) { e.target.value = ''; return; }
        const context = localCompletionContext();
        if (!context) { e.target.value = ''; return; }
        const tag = selectedCompTag && selectedCompTag !== '기타' ? selectedCompTag : '사진 완료';
        photoStagingIds.add(item.id);
        let photoId;
        let committed = false;
        try {
            photoId = crypto.randomUUID();
            // Only local durable Blob storage precedes completion. Never wait for compression/upload.
            await completionPhotos.put(photoId, file);
            const currentItem = state.getDestinations().find(destination => destination.id === item.id);
            if (state.getRouteOwnerId() !== context.completionOwnership.routeOwnerId || !currentItem) return;
            committed = finishLocally(currentItem, tag, context, photoId);
        } catch (error) { state.reportStorageFailure(error, { operation: 'photoCompletion', stage: 'logic', photoBytes: file.size }); }
        finally {
            photoStagingIds.delete(item.id);
            e.target.value = '';
            if (photoId && !committed) completionPhotos.remove(photoId).catch(error => console.error('사진 정리 실패:', storageDiagnostic(error, { operation: 'photoCompletionCleanup', storage: 'indexedDB' })));
        }
    });
}
