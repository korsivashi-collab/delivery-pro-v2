// js/admin-dispatch-forms.js

import { state } from "./admin-state.js";
import {
    templateBuilderState,
    renderEditableDocument,
    fillTemplateWithOrderData
} from "./admin-dispatch-template.js";

// ==========================================
// 저장된 주문서 양식(서식) 관리 모듈
// ==========================================

export function loadSavedForms() {
    const listEl = document.getElementById('saved-forms-list');
    if (!listEl) return;
    const savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    
    // 🌟 저장된 양식이 없을 때 에디터 및 템플릿 상태 잔상 완전 소거
    if (savedForms.length === 0) { 
        listEl.innerHTML = `<div class="text-center text-gray-400 py-6 text-[10px] font-bold">저장된 서류 양식이 없습니다.<br>우측에서 PDF를 업로드하여 양식을 생성하세요.</div>`; 
        const placeholder = document.getElementById('preview-placeholder');
        const editorWrapper = document.getElementById('doc-editor-wrapper');
        if (placeholder) placeholder.classList.remove('hidden');
        if (editorWrapper) editorWrapper.innerHTML = '';
        templateBuilderState.currentDocHtml = '';
        templateBuilderState.activeTemplateTitle = '';
        return; 
    }
    
    let html = '';
    savedForms.forEach((form, idx) => {
        const isSelected = (state.currentSelectedFormIndex === idx);
        const defaultBadge = form.isDefault 
            ? `<span class="bg-amber-400 text-slate-950 text-[9px] font-black px-1.5 py-0.5 rounded ml-1.5 shadow-2xs">기본양식</span>` 
            : '';

        html += `
        <div class="border ${isSelected ? 'border-indigo-600 bg-indigo-50/70 ring-1 ring-indigo-400' : 'border-gray-200 bg-white hover:border-indigo-300'} rounded-xl p-2.5 shadow-xs transition flex items-center justify-between group">
            <div class="flex items-center gap-3 overflow-hidden flex-1 pl-1">
                <input type="checkbox" onchange="window.toggleSelectForm(${idx})" ${isSelected ? 'checked' : ''} class="w-4 h-4 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500 cursor-pointer shrink-0">
                <div class="min-w-0 cursor-pointer flex-1" onclick="window.previewSavedForm(${idx})">
                    <p class="text-[11px] font-black ${isSelected ? 'text-indigo-800' : 'text-gray-800'} truncate leading-tight hover:text-indigo-600 transition flex items-center">
                        ${form.title}${defaultBadge}
                    </p>
                    <p class="text-[9px] text-gray-400 truncate mt-0.5">${form.name || '상호 미기재'}</p>
                </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                <button type="button" onclick="window.setAsDefaultForm(${idx})" class="text-[10px] font-bold text-gray-400 hover:text-amber-500 px-1.5 py-1 transition" title="이 폼을 기본 서식으로 설정">
                    <i class="fa-solid fa-star ${form.isDefault ? 'text-amber-400' : ''}"></i>
                </button>
                <button type="button" onclick="window.deleteSavedForm(${idx})" class="text-gray-300 hover:text-red-500 px-1.5 py-1 transition"><i class="fa-solid fa-trash-can text-[10px]"></i></button>
            </div>
        </div>`;
    });
    listEl.innerHTML = html;

    if (state.currentSelectedFormIndex === null) {
        const defaultIdx = savedForms.findIndex(f => f.isDefault);
        if (defaultIdx >= 0 && defaultIdx < savedForms.length) {
            applySavedForm(defaultIdx);
        }
    }
}

export function setAsDefaultForm(idx) {
    const savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    if (!savedForms[idx]) return;

    savedForms.forEach((f, i) => { f.isDefault = (i === idx); });
    localStorage.setItem('deliveryPro_savedForms', JSON.stringify(savedForms));
    alert(`[${savedForms[idx].title}] 양식이 기본 주문서 양식으로 설정되었습니다.`);
    loadSavedForms();
}

export function toggleSelectForm(idx) {
    if (state.currentSelectedFormIndex === idx) { 
        state.currentSelectedFormIndex = null; 
        cancelProviderFormEdit(); 
    } else { 
        applySavedForm(idx); 
    }
}

export function previewSavedForm(idx) { 
    applySavedForm(idx); 
}

export function applySavedForm(idx) {
    const savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    const form = savedForms[idx];  
    if (!form) return;
    state.currentSelectedFormIndex = idx;

    if (form.templateHtml) {
        templateBuilderState.activeTemplateTitle = form.title || '주문서 양식';
        templateBuilderState.currentDocHtml = form.templateHtml;

        const curIdx = state.currentPreviewInvoiceIndex || 0;
        // 🌟 주문 데이터가 실제로 1건 이상 존재할 때만 데이터 치환 렌더링, 없을 때는 순수 템플릿 서식만 렌더링하여 이전 잔상 차단
        const hasOrders = state.printReadyList && state.printReadyList.length > 0;
        const curOrder = hasOrders ? state.printReadyList[curIdx] : null;

        if (curOrder && typeof fillTemplateWithOrderData === 'function') {
            renderEditableDocument(fillTemplateWithOrderData(form.templateHtml, curOrder, curIdx));
        } else {
            renderEditableDocument(form.templateHtml);
        }
    }

    loadSavedForms(); 
}

export function saveProviderForm() {
    if (window.saveCurrentDocumentTemplate) {
        window.saveCurrentDocumentTemplate();
    }
}

export function deleteSavedForm(idx) {
    const savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    if (!confirm(`[${savedForms[idx].title}] 폼을 삭제하시겠습니까?`)) return;
    
    savedForms.splice(idx, 1);
    localStorage.setItem('deliveryPro_savedForms', JSON.stringify(savedForms));
    
    if (state.currentSelectedFormIndex === idx) cancelProviderFormEdit();
    loadSavedForms();
}

export function cancelProviderFormEdit() {
    state.currentSelectedFormIndex = null;

    const placeholder = document.getElementById('preview-placeholder');
    const editorWrapper = document.getElementById('doc-editor-wrapper');
    if (placeholder) placeholder.classList.remove('hidden');
    if (editorWrapper) editorWrapper.innerHTML = '';

    // 🌟 양식 선택 해제 시 현재 템플릿 메모리도 초기화
    templateBuilderState.currentDocHtml = '';
    templateBuilderState.activeTemplateTitle = '';

    loadSavedForms(); 
}

export function updateLivePreview() {}
export function syncPreviewData() {}

// ==========================================
// Window 전역 객체 바인딩 (HTML 인라인 이벤트용)
// ==========================================
window.loadSavedForms = loadSavedForms;
window.setAsDefaultForm = setAsDefaultForm;
window.toggleSelectForm = toggleSelectForm;
window.previewSavedForm = previewSavedForm;
window.applySavedForm = applySavedForm;
window.saveProviderForm = saveProviderForm;
window.deleteSavedForm = deleteSavedForm;
window.cancelProviderFormEdit = cancelProviderFormEdit;
window.updateLivePreview = updateLivePreview;
window.syncPreviewData = syncPreviewData;