// js/admin-dispatch-print.js

import { state, getLocalDateString } from "./admin-state.js";
import { formatNumber } from "./admin-dispatch-core.js";
import {
    parsePdfToEditableDocument,
    renderEditableDocument,
    templateBuilderState,
    fillTemplateWithOrderData,
    saveCurrentDocumentTemplate
} from "./admin-dispatch-template.js";

let invoiceSearchKeyword = '';
let currentSenderFilter = 'ALL';

// 🌟 좌측 인쇄 리스트 정렬 상태 변수
let printListSortField = 'originalIdx'; // 'originalIdx', 'senderName', 'storeName', 'address'
let printListSortAsc = true;

// ==========================================
// 1. 주문서 통합관리 모달 열기 & 초기화
// ==========================================
export function exportToInvoiceModal() {
    const checkboxes = document.querySelectorAll('.row-checkbox:checked');
    state.printReadyList = [];

    if (checkboxes.length > 0) {
        checkboxes.forEach(cb => { 
            const idx = parseInt(cb.getAttribute('data-idx'), 10); 
            if (state.parsedExcelList[idx]) {
                const item = { ...state.parsedExcelList[idx], _selected: true };
                state.printReadyList.push(item); 
            }
        });
    } else if (state.parsedExcelList && state.parsedExcelList.length > 0) {
        state.printReadyList = state.parsedExcelList.map(item => ({ ...item, _selected: true }));
    } else {
        alert("주문서로 출력할 주문 데이터가 없습니다. 엑셀이나 PDF를 먼저 업로드해 주세요.");
        return;
    }

    if (window.closeAutoDispatchModal) window.closeAutoDispatchModal(); 
    const invoiceModal = document.getElementById('pro-invoice-modal');
    if (invoiceModal) invoiceModal.classList.remove('hidden');

    state.currentPreviewInvoiceIndex = 0;
    invoiceSearchKeyword = '';
    currentSenderFilter = 'ALL';
    printListSortField = 'originalIdx';
    printListSortAsc = true;

    const searchInput = document.getElementById('invoice-search-input');
    if (searchInput) searchInput.value = '';

    populateSenderFilterDropdown();
    initTemplatePdfDropZone();
    initInvoiceResizer(); // 🌟 목록 패널 폭 조절 리사이저 초기화
    loadSavedForms(); 
    renderInvoiceOrderList();
    previewInvoiceRow(0); 
}

// 🌟 주문서 목록 폭 조절(드래그) 리사이저 엔진
export function initInvoiceResizer() {
    const resizer = document.getElementById('invoice-panel-resizer');
    const listPanel = document.getElementById('invoice-list-panel');
    if (!resizer || !listPanel) return;

    const savedWidth = localStorage.getItem('deliveryPro_invoiceListWidth');
    if (savedWidth) {
        listPanel.style.width = `${savedWidth}px`;
    }

    if (resizer.dataset.bound === 'true') return;

    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    resizer.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startWidth = listPanel.offsetWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const delta = e.clientX - startX;
        let newWidth = startWidth + delta;
        
        if (newWidth < 260) newWidth = 260;
        if (newWidth > 650) newWidth = 650;

        listPanel.style.width = `${newWidth}px`;
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            localStorage.setItem('deliveryPro_invoiceListWidth', listPanel.offsetWidth);
        }
    });

    resizer.dataset.bound = 'true';
}

export function populateSenderFilterDropdown() {
    const selectEl = document.getElementById('invoice-sender-filter');
    if (!selectEl || !state.printReadyList) return;

    const senders = new Set();
    state.printReadyList.forEach(item => {
        const s = (item.senderName || '').trim();
        if (s) senders.add(s);
    });

    let html = `<option value="ALL">전체 공급자 (모아보기 - 총 ${state.printReadyList.length}건)</option>`;
    senders.forEach(sName => {
        const count = state.printReadyList.filter(it => (it.senderName || '').trim() === sName).length;
        html += `<option value="${sName}" ${currentSenderFilter === sName ? 'selected' : ''}>${sName} (${count}건)</option>`;
    });

    selectEl.innerHTML = html;
}

// 공급자 필터 선택 시 해당 공급자 주문만 자동 전체 선택 & 타 공급자 주문 자동 해제
export function filterBySender(senderName) {
    currentSenderFilter = senderName;

    if (state.printReadyList && state.printReadyList.length > 0) {
        state.printReadyList.forEach(item => {
            if (senderName === 'ALL') {
                item._selected = true;
            } else {
                item._selected = ((item.senderName || '').trim() === senderName);
            }
        });
    }

    renderInvoiceOrderList();
    updateInvoiceCountBadge();

    const filtered = getFilteredPrintOrders();
    if (filtered.length > 0) {
        const firstIdx = state.printReadyList.indexOf(filtered[0]);
        if (firstIdx !== -1) {
            previewInvoiceRow(firstIdx);
        }
    }
}

// ==========================================
// 2. 좌측 인쇄 대상 리스트 (스마트 토글 및 헤더 동기화)
// ==========================================
function getFilteredPrintOrders() {
    if (!state.printReadyList) return [];
    let list = state.printReadyList;

    if (currentSenderFilter !== 'ALL') {
        list = list.filter(item => (item.senderName || '').trim() === currentSenderFilter);
    }

    if (invoiceSearchKeyword) {
        list = list.filter(item => {
            const sName = (item.senderName || '').toLowerCase();
            const store = (item.storeName || '').toLowerCase();
            const addr = (item.address || item.fullAddress || '').toLowerCase();
            const phone = (item.phone || '').toLowerCase();
            return sName.includes(invoiceSearchKeyword) || 
                   store.includes(invoiceSearchKeyword) || 
                   addr.includes(invoiceSearchKeyword) || 
                   phone.includes(invoiceSearchKeyword);
        });
    }

    list.sort((a, b) => {
        let valA = '';
        let valB = '';

        if (printListSortField === 'senderName') {
            valA = (a.senderName || '').toLowerCase();
            valB = (b.senderName || '').toLowerCase();
        } else if (printListSortField === 'storeName') {
            valA = (a.storeName || '').toLowerCase();
            valB = (b.storeName || '').toLowerCase();
        } else if (printListSortField === 'address') {
            valA = (a.address || a.fullAddress || '').toLowerCase();
            valB = (b.address || b.fullAddress || '').toLowerCase();
        } else {
            valA = state.printReadyList.indexOf(a);
            valB = state.printReadyList.indexOf(b);
            return printListSortAsc ? (valA - valB) : (valB - valA);
        }

        if (valA < valB) return printListSortAsc ? -1 : 1;
        if (valA > valB) return printListSortAsc ? 1 : -1;
        return 0;
    });

    return list;
}

export function filterInvoicePrintList(query) {
    invoiceSearchKeyword = (query || '').trim().toLowerCase();
    renderInvoiceOrderList();
}

export function sortPrintList(field) {
    if (printListSortField === field) {
        printListSortAsc = !printListSortAsc;
    } else {
        printListSortField = field;
        printListSortAsc = true;
    }
    renderInvoiceOrderList();
}

export function updateInvoiceCountBadge() {
    const badge = document.getElementById('invoice-target-count-badge');
    if (!badge || !state.printReadyList) return;
    const filtered = getFilteredPrintOrders();
    const total = filtered.length;
    const selected = filtered.filter(it => it._selected !== false).length;
    badge.innerText = `선택 ${selected} / ${total}건`;

    const chkAll = document.getElementById('chk-invoice-all-table');
    if (chkAll) {
        chkAll.checked = (total > 0 && selected === total);
        chkAll.indeterminate = (selected > 0 && selected < total);
    }
}

// 🌟 헤더 체크박스 클릭 핸들러 (1건이라도 선택되어 있으면 무조건 전체 해제, 0건이면 전체 선택)
export function handleHeaderCheckAll(e) {
    if (e) e.stopPropagation();
    const filtered = getFilteredPrintOrders();
    const selectedCount = filtered.filter(it => it._selected !== false).length;
    
    const nextState = (selectedCount === 0);
    toggleAllInvoiceSelection(nextState);
}

// 전체 선택 / 전체 해제 공용 제어 함수
export function toggleAllInvoiceSelection(targetState) {
    const filtered = getFilteredPrintOrders();
    const isCheck = (typeof targetState === 'boolean') ? targetState : false;

    filtered.forEach(it => {
        it._selected = isCheck;
    });

    renderInvoiceOrderList();
    updateInvoiceCountBadge();
}

// 개별 항목 선택 토글 (인덱스 fallback 보강)
export function toggleSingleInvoiceItem(targetId, isChecked, idx) {
    let item = state.printReadyList.find(it => String(it.id) === String(targetId));
    if (!item && idx !== undefined && state.printReadyList[idx]) {
        item = state.printReadyList[idx];
    }
    if (item) {
        item._selected = isChecked;
    }
    renderInvoiceOrderList();
    updateInvoiceCountBadge();
}

export function renderInvoiceOrderList() {
    const listEl = document.getElementById('invoice-print-order-list');
    if (!listEl) return;

    const filtered = getFilteredPrintOrders();
    const total = filtered.length;
    const selected = filtered.filter(it => it._selected !== false).length;
    const isAllChecked = (total > 0 && selected === total);

    const getArrow = (field) => {
        if (printListSortField !== field) return ' ↕';
        return printListSortAsc ? ' ▲' : ' ▼';
    };

    if (!filtered || filtered.length === 0) {
        listEl.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">조건에 일치하는 주문이 없습니다.</div>`;
        updateInvoiceCountBadge();
        return;
    }

    let tableHtml = `
    <div class="overflow-x-auto custom-scrollbar">
        <table class="w-full text-left border-collapse text-xs whitespace-nowrap excel-table">
            <thead>
                <tr class="bg-gray-100 text-gray-700 font-black border-b border-gray-200">
                    <th class="py-2.5 px-2 text-center w-8">
                        <input type="checkbox" id="chk-invoice-all-table" ${isAllChecked ? 'checked' : ''} onclick="window.handleHeaderCheckAll(event)" class="cursor-pointer">
                    </th>
                    <th class="py-2.5 px-2 text-center w-10">No.</th>
                    <th class="sortable-th py-2.5 px-3" onclick="window.sortPrintList('senderName')">공급자${getArrow('senderName')}</th>
                    <th class="sortable-th py-2.5 px-3" onclick="window.sortPrintList('storeName')">상호(간판명)${getArrow('storeName')}</th>
                    <th class="sortable-th py-2.5 px-3" onclick="window.sortPrintList('address')">배송지 주소${getArrow('address')}</th>
                </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 bg-white font-medium text-gray-800">
    `;

    filtered.forEach((item) => {
        const originalIdx = state.printReadyList.indexOf(item);
        const isCurrent = (state.currentPreviewInvoiceIndex === originalIdx);
        const isChecked = (item._selected !== false);

        const senderDisplay = item.senderName || '정보 없음';
        const storeDisplay = item.storeName || '-';
        const addressDisplay = item.address || item.fullAddress || '-';

        tableHtml += `
        <tr onclick="window.previewInvoiceRow(${originalIdx})" class="hover:bg-indigo-50/60 cursor-pointer transition ${isCurrent ? 'bg-indigo-50/80 ring-1 ring-indigo-400 font-bold' : ''}">
            <td class="text-center py-2 px-2" onclick="event.stopPropagation()">
                <input type="checkbox" onchange="window.toggleSingleInvoiceItem('${item.id}', this.checked, ${originalIdx})" ${isChecked ? 'checked' : ''} class="w-4 h-4 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500 cursor-pointer row-checkbox" data-idx="${originalIdx}">
            </td>
            <td class="text-center py-2 px-2 font-mono text-gray-400 font-bold">${originalIdx + 1}</td>
            <td class="py-2 px-3 font-black text-amber-900 truncate max-w-[100px]" title="${senderDisplay}">${senderDisplay}</td>
            <td class="py-2 px-3 font-bold text-indigo-900 truncate max-w-[110px]" title="${storeDisplay}">${storeDisplay}</td>
            <td class="py-2 px-3 text-gray-900 truncate max-w-[180px]" title="${addressDisplay}">${addressDisplay}</td>
        </tr>`;
    });

    tableHtml += `</tbody></table></div>`;
    listEl.innerHTML = tableHtml;

    updateInvoiceCountBadge();
}

// ==========================================
// 3. 주문 1건 미리보기 연동 (선택 주문 데이터 실시간 서식 합성)
// ==========================================
export function previewInvoiceRow(idx) {
    if (!state.printReadyList || !state.printReadyList[idx]) return;
    state.currentPreviewInvoiceIndex = idx;
    const item = state.printReadyList[idx];

    const labelEl = document.getElementById('preview-target-order-label');
    if (labelEl) {
        const sName = item.senderName ? `[${item.senderName}] ` : '';
        const driverName = item.assignedDriver ? ` (담당: ${item.assignedDriver})` : ' (기사 미배정)';
        labelEl.innerText = `#${idx + 1} ${sName}${item.storeName || item.address || ''}${driverName}`;
    }

    const docCanvas = document.getElementById('editable-doc-canvas');
    const baseTemplate = templateBuilderState.currentDocHtml;
    if (docCanvas && baseTemplate && typeof fillTemplateWithOrderData === 'function') {
        docCanvas.innerHTML = fillTemplateWithOrderData(baseTemplate, item, idx);
    }

    renderInvoiceOrderList();
}

// ==========================================
// 4. 양식 제작용 PDF 드롭존 초기화
// ==========================================
export function initTemplatePdfDropZone() {
    const dropzone = document.getElementById('template-pdf-dropzone');
    const fileInput = document.getElementById('template-pdf-file-input');
    if (!dropzone || dropzone.dataset.bound === 'true') return;

    dropzone.addEventListener('click', () => {
        if (fileInput) fileInput.click();
    });

    if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (file) await parsePdfToEditableDocument(file);
            e.target.value = '';
        });
    }

    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('bg-red-100', 'border-red-500');
    });
    dropzone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropzone.classList.remove('bg-red-100', 'border-red-500');
    });
    dropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropzone.classList.remove('bg-red-100', 'border-red-500');
        const file = e.dataTransfer.files?.[0];
        if (file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
            await parsePdfToEditableDocument(file);
        } else if (file) {
            alert("양식 제작용 파일은 PDF 파일만 지원합니다.");
        }
    });

    dropzone.dataset.bound = 'true';
}

// ==========================================
// 5. 저장된 양식 목록 관리
// ==========================================
export function loadSavedForms() {
    const listEl = document.getElementById('saved-forms-list');
    if (!listEl) return;
    const savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    
    if (savedForms.length === 0) { 
        listEl.innerHTML = `<div class="text-center text-gray-400 py-6 text-[10px] font-bold">저장된 서류 양식이 없습니다.<br>우측에서 PDF를 업로드하여 양식을 생성하세요.</div>`; 
        const placeholder = document.getElementById('preview-placeholder');
        const editorWrapper = document.getElementById('doc-editor-wrapper');
        if (placeholder) placeholder.classList.remove('hidden');
        if (editorWrapper) editorWrapper.innerHTML = '';
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
        if (defaultIdx >= 0) {
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
        const curOrder = state.printReadyList ? state.printReadyList[curIdx] : null;

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

    loadSavedForms(); 
}

export function updateLivePreview() {}
export function syncPreviewData() {}

// ==========================================
// 🌟 6. 주문서 일괄 출력 (A4 1장 밀림 완전 방지 및 1건 1장 완벽 출력)
// ==========================================
export function executeBatchPrint() {
    if (!state.printReadyList || state.printReadyList.length === 0) { 
        alert("출력할 주문건이 없습니다."); 
        return; 
    }

    const selectedOrders = state.printReadyList.filter(item => item._selected !== false);
    if (selectedOrders.length === 0) {
        alert("출력할 주문이 선택되지 않았습니다. 좌측 리스트에서 1개 이상의 주문을 체크해 주세요.");
        return;
    }

    const baseTemplateHtml = templateBuilderState.currentDocHtml || document.getElementById('editable-doc-canvas')?.innerHTML;

    if (!baseTemplateHtml || !baseTemplateHtml.trim()) {
        alert("등록된 주문서 서식이 없습니다. 먼저 양식용 PDF를 업로드하거나 저장된 양식을 선택해 주세요.");
        return;
    }

    const btn1 = document.getElementById('btn-batch-print');
    const btn2 = document.getElementById('btn-batch-print-top');
    [btn1, btn2].forEach(btn => {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 인쇄 문서 생성 중...';
        }
    });

    let printPagesHtml = '';

    selectedOrders.forEach((item, idx) => {
        let filledPageHtml = fillTemplateWithOrderData(baseTemplateHtml, item, idx);

        filledPageHtml = filledPageHtml.replace(/contenteditable="true"/g, 'contenteditable="false"');

        printPagesHtml += `
        <div class="print-page-wrapper">
            <div class="print-sheet-content">
                ${filledPageHtml}
            </div>
        </div>`;
    });

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;z-index:-1;'; 
    document.body.appendChild(iframe);
    
    const doc = iframe.contentWindow.document; 
    doc.open();
    doc.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>배송 경로 PRO - 주문서 출력</title><style>
        * { box-sizing: border-box; }
        @media print { 
            @page { 
                size: A4 portrait; 
                margin: 0; 
            } 
            html, body { 
                margin: 0 !important; 
                padding: 0 !important; 
                width: 210mm !important; 
                height: 297mm !important; 
                background: white !important; 
                -webkit-print-color-adjust: exact !important; 
                print-color-adjust: exact !important; 
            } 
            .print-page-wrapper { 
                width: 210mm !important; 
                height: 297mm !important; 
                max-height: 297mm !important; 
                margin: 0 !important; 
                padding: 0 !important; 
                page-break-after: always !important; 
                page-break-inside: avoid !important; 
                break-after: page !important; 
                overflow: hidden !important; 
                box-sizing: border-box !important; 
                display: flex !important; 
                flex-direction: column !important; 
                align-items: center !important; 
                justify-content: flex-start !important; 
            }
            .print-page-wrapper:last-child { 
                page-break-after: auto !important; 
                break-after: auto !important; 
            }
        }
        body { 
            margin: 0; 
            padding: 0; 
            font-family: 'Malgun Gothic', 'Dotum', sans-serif; 
            background: white; 
            color: #000; 
        }
        .print-page-wrapper { 
            width: 210mm; 
            height: 297mm; 
            max-height: 297mm; 
            margin: 0 auto; 
            padding: 0; 
            overflow: hidden; 
            box-sizing: border-box; 
            display: flex; 
            flex-direction: column; 
            align-items: center; 
        }
        .print-sheet-content { 
            width: 210mm; 
            height: 297mm; 
            max-height: 297mm; 
            overflow: hidden; 
            box-sizing: border-box; 
            position: relative; 
        }
        .doc-sheet { 
            width: 210mm !important; 
            height: 297mm !important; 
            max-height: 297mm !important; 
            background: #fff; 
            color: #000; 
            box-sizing: border-box; 
        }
        .invoice-box-part { 
            width: 100% !important; 
            height: 148.5mm !important; 
            max-height: 148.5mm !important; 
            box-sizing: border-box !important; 
            overflow: hidden !important; 
        }
        .invoice-cut-line { 
            border-top: 1.5px dashed #4b5563 !important; 
            width: 100% !important; 
            margin: 0 !important; 
            height: 0 !important; 
            box-sizing: border-box !important; 
            flex-shrink: 0 !important; 
        }
    </style></head><body>${printPagesHtml}</body></html>`);
    doc.close();

    iframe.onload = function() {
        setTimeout(() => {
            iframe.contentWindow.focus();  
            iframe.contentWindow.print();
            setTimeout(() => { 
                document.body.removeChild(iframe); 
                [btn1, btn2].forEach(btn => {
                    if (btn) {
                        btn.disabled = false;
                        btn.innerHTML = `<i class="fa-solid fa-print text-sm"></i> 선택 주문서 일괄 출력`;
                    }
                });
            }, 1000);
        }, 800); 
    };
}

// ==========================================
// 🌟 7. 피킹 리스트 (A4 1페이지 실측 기반 동적 2열 전환 엔진)
// ==========================================
export const pickingModalState = {
    selectedDrivers: new Set()
};

export function openPickingDriverModal() {
    pickingModalState.selectedDrivers.clear();

    const driverNames = new Set();
    const visibleDrivers = window.getFilteredVisibleDrivers ? window.getFilteredVisibleDrivers() : [];
    visibleDrivers.forEach(d => {
        if (d.phone || d.key) driverNames.add(d.phone || d.key);
    });
    (state.parsedExcelList || []).forEach(o => {
        if (o.assignedDriver) driverNames.add(o.assignedDriver);
    });

    const uniqueDrivers = Array.from(driverNames);
    uniqueDrivers.forEach(d => {
        const hasOrders = (state.parsedExcelList || []).some(o => o.assignedDriver === d);
        if (hasOrders) pickingModalState.selectedDrivers.add(d);
    });

    const modal = document.getElementById('picking-driver-modal');
    if (modal) modal.classList.remove('hidden');

    renderPickingDriverList(uniqueDrivers);
}

export function closePickingDriverModal() {
    const modal = document.getElementById('picking-driver-modal');
    if (modal) modal.classList.add('hidden');
}

export function toggleAllPickingDrivers(isChecked) {
    const driverNames = new Set();
    (state.parsedExcelList || []).forEach(o => {
        if (o.assignedDriver) driverNames.add(o.assignedDriver);
    });
    const uniqueDrivers = Array.from(driverNames);

    if (isChecked) {
        uniqueDrivers.forEach(d => pickingModalState.selectedDrivers.add(d));
    } else {
        pickingModalState.selectedDrivers.clear();
    }
    renderPickingDriverList(uniqueDrivers);
}

export function togglePickingDriver(driver) {
    if (pickingModalState.selectedDrivers.has(driver)) {
        pickingModalState.selectedDrivers.delete(driver);
    } else {
        pickingModalState.selectedDrivers.add(driver);
    }
    const driverNames = new Set();
    (state.parsedExcelList || []).forEach(o => {
        if (o.assignedDriver) driverNames.add(o.assignedDriver);
    });
    renderPickingDriverList(Array.from(driverNames));
}

export function renderPickingDriverList(uniqueDrivers) {
    const listEl = document.getElementById('picking-driver-list');
    if (!listEl) return;

    if (!uniqueDrivers || uniqueDrivers.length === 0) {
        listEl.innerHTML = `<div class="text-center text-gray-400 py-6 text-xs font-bold">배정된 기사가 없습니다.<br>자동할당을 먼저 진행하세요.</div>`;
        return;
    }

    let html = '';
    uniqueDrivers.forEach(d => {
        const isChecked = pickingModalState.selectedDrivers.has(d);
        const orderCount = (state.parsedExcelList || []).filter(o => o.assignedDriver === d).length;
        html += `
        <label class="flex items-center justify-between p-3 bg-white border ${isChecked ? 'border-blue-500 bg-blue-50/40 ring-1 ring-blue-300' : 'border-gray-200 hover:bg-gray-50'} rounded-xl cursor-pointer transition shadow-xs">
            <div class="flex items-center gap-3">
                <input type="checkbox" onchange="window.togglePickingDriver('${d}')" ${isChecked ? 'checked' : ''} class="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer">
                <div>
                    <span class="font-black text-sm text-gray-900 block leading-tight"><i class="fa-solid fa-truck text-blue-500 mr-1.5 text-xs"></i>${d}</span>
                    <span class="text-[10px] text-gray-400 font-bold">배정 물량: ${orderCount}건</span>
                </div>
            </div>
            <span class="text-[10px] font-black px-2 py-0.5 rounded-full ${isChecked ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'}">${isChecked ? '선택됨' : '제외'}</span>
        </label>`;
    });
    listEl.innerHTML = html;

    const chkAll = document.getElementById('chk-picking-all');
    if (chkAll) {
        chkAll.checked = (pickingModalState.selectedDrivers.size === uniqueDrivers.length && uniqueDrivers.length > 0);
    }
}

// 🌟 피킹 리스트 페이지 내부 HTML 조립 헬퍼 (1열 / 2열 공용)
function buildPickingPageHtml(driverName, driverOrdersCount, aggregatedList, isTwoColumn, dateStr) {
    const totalItemTypes = aggregatedList.length;
    const totalItemQtySum = aggregatedList.reduce((sum, item) => sum + item.totalQty, 0);

    let tableContentHtml = '';

    if (!isTwoColumn) {
        // [1열 형태] 콤팩트 테이블
        let rowsHtml = '';
        aggregatedList.forEach((item, idx) => {
            rowsHtml += `
            <tr>
                <td class="col-center text-bold">${idx + 1}</td>
                <td class="col-left text-bold">${item.name}</td>
                <td class="col-center">${item.unit}</td>
                <td class="col-right text-black-bold">${formatNumber(item.totalQty)}</td>
                <td class="col-center text-muted">${item.orderCount}곳</td>
                <td class="col-center"><span class="check-box"></span></td>
            </tr>`;
        });

        tableContentHtml = `
        <table class="picking-table single-col-table">
            <colgroup>
                <col style="width: 6%;">
                <col style="width: 52%;">
                <col style="width: 11%;">
                <col style="width: 12%;">
                <col style="width: 10%;">
                <col style="width: 9%;">
            </colgroup>
            <thead>
                <tr>
                    <th>No.</th>
                    <th>상 품 명 (품목 규격)</th>
                    <th>단위</th>
                    <th>총 수량</th>
                    <th>배송처</th>
                    <th>상차확인</th>
                </tr>
            </thead>
            <tbody>
                ${rowsHtml}
            </tbody>
        </table>`;
    } else {
        // [2열 형태] 좌/우 균등 분할 테이블 (1장에 완벽 수납)
        const halfPoint = Math.ceil(totalItemTypes / 2);
        const leftList = aggregatedList.slice(0, halfPoint);
        const rightList = aggregatedList.slice(halfPoint);

        const renderSubTableRows = (list, offset) => {
            return list.map((item, i) => `
            <tr>
                <td class="col-center text-bold">${offset + i + 1}</td>
                <td class="col-left text-bold">${item.name}</td>
                <td class="col-center">${item.unit}</td>
                <td class="col-right text-black-bold">${formatNumber(item.totalQty)}</td>
                <td class="col-center text-muted">${item.orderCount}곳</td>
                <td class="col-center"><span class="check-box"></span></td>
            </tr>`).join('');
        };

        tableContentHtml = `
        <div class="two-column-wrapper">
            <div class="col-half">
                <table class="picking-table double-col-table">
                    <colgroup>
                        <col style="width: 8%;">
                        <col style="width: 48%;">
                        <col style="width: 13%;">
                        <col style="width: 13%;">
                        <col style="width: 10%;">
                        <col style="width: 8%;">
                    </colgroup>
                    <thead>
                        <tr>
                            <th>No.</th>
                            <th>상 품 명 (규격)</th>
                            <th>단위</th>
                            <th>수량</th>
                            <th>배송</th>
                            <th>확인</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${renderSubTableRows(leftList, 0)}
                    </tbody>
                </table>
            </div>
            <div class="col-half">
                <table class="picking-table double-col-table">
                    <colgroup>
                        <col style="width: 8%;">
                        <col style="width: 48%;">
                        <col style="width: 13%;">
                        <col style="width: 13%;">
                        <col style="width: 10%;">
                        <col style="width: 8%;">
                    </colgroup>
                    <thead>
                        <tr>
                            <th>No.</th>
                            <th>상 품 명 (규격)</th>
                            <th>단위</th>
                            <th>수량</th>
                            <th>배송</th>
                            <th>확인</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${renderSubTableRows(rightList, halfPoint)}
                    </tbody>
                </table>
            </div>
        </div>`;
    }

    return `
    <div class="print-page ${isTwoColumn ? 'mode-two-col' : 'mode-single-col'}">
        <div class="header-title">창고 상차 피킹 리스트</div>
        <div class="meta-info">
            <span>출력일자: ${dateStr}</span>
            <span class="driver-name-text">담당 기사: <b>${driverName}</b></span>
        </div>
        <div class="summary-box">
            <span>배송처: <b>${driverOrdersCount}</b>곳</span>
            <span>품목 종류: <b>${totalItemTypes}</b>종</span>
            <span>총 수량: <b>${formatNumber(totalItemQtySum)}</b>개</span>
        </div>
        
        <div class="table-container">
            ${tableContentHtml}
        </div>

        <div class="footer-sign">
            <span>상차 기사(${driverName}): <span class="sign-box">(서명)</span></span>
            <span>출고 검수자: <span class="sign-box">(서명)</span></span>
        </div>
    </div>`;
}

// 🌟 피킹 인쇄 전용 CSS 스타일
const pickingPrintStyles = `
    * { box-sizing: border-box; }
    @media print {
        @page { 
            size: A4 portrait; 
            margin: 0; 
        }
        html, body { 
            margin: 0 !important; 
            padding: 0 !important; 
            width: 210mm !important; 
            height: 297mm !important; 
            background: white !important; 
            -webkit-print-color-adjust: exact !important; 
            print-color-adjust: exact !important; 
        }
        .print-page { 
            width: 210mm !important; 
            height: 297mm !important; 
            max-height: 297mm !important; 
            margin: 0 !important; 
            padding: 7mm 8mm 6mm 8mm !important; 
            page-break-after: always !important; 
            page-break-inside: avoid !important; 
            break-after: page !important; 
            overflow: hidden !important; 
            box-sizing: border-box !important; 
            display: flex !important; 
            flex-direction: column !important; 
            justify-content: flex-start !important; 
        }
        .print-page:last-child { 
            page-break-after: auto !important; 
            break-after: auto !important; 
        }
    }
    body { 
        font-family: 'Malgun Gothic', 'Dotum', sans-serif; 
        background: white; 
        margin: 0; 
        padding: 0; 
        color: #1e293b; 
    }
    .print-page { 
        width: 210mm; 
        height: 297mm; 
        max-height: 297mm; 
        margin: 0 auto; 
        padding: 7mm 8mm 6mm 8mm; 
        page-break-after: always; 
        box-sizing: border-box; 
        display: flex; 
        flex-direction: column; 
        justify-content: flex-start; 
        overflow: hidden; 
    }
    .print-page:last-child { 
        page-break-after: auto; 
    }
    .header-title { 
        text-align: center; 
        font-size: 19px; 
        font-weight: 900; 
        letter-spacing: 2px; 
        margin-bottom: 2px; 
        border-bottom: 2.5px double #000; 
        padding-bottom: 3px; 
    }
    .meta-info { 
        display: flex; 
        justify-content: space-between; 
        align-items: flex-end; 
        font-size: 10px; 
        font-weight: bold; 
        margin-bottom: 5px; 
        color: #334155; 
        padding: 0 2px; 
    }
    .driver-name-text { 
        font-size: 12.5px; 
        color: #1e40af; 
    }
    .summary-box { 
        background-color: #f8fafc; 
        border: 1.5px solid #cbd5e1; 
        border-radius: 6px; 
        padding: 4px 10px; 
        display: flex; 
        justify-content: space-around; 
        font-size: 10.5px; 
        font-weight: 900; 
        margin-bottom: 6px; 
        -webkit-print-color-adjust: exact; 
        print-color-adjust: exact; 
    }
    .summary-box span b { 
        color: #2563eb; 
        font-size: 11.5px; 
        margin-left: 3px; 
    }
    .table-container { 
        flex: 1; 
        overflow: hidden; 
        display: flex; 
        flex-direction: column; 
    }
    .picking-table { 
        width: 100%; 
        border-collapse: collapse; 
        border: 1.5px solid #000; 
        font-size: 9.5px; 
        table-layout: fixed; 
    }
    .picking-table th { 
        background-color: #f1f5f9; 
        border: 1px solid #000; 
        padding: 3.5px 3px; 
        font-weight: 900; 
        text-align: center; 
        color: #0f172a; 
        -webkit-print-color-adjust: exact; 
        print-color-adjust: exact; 
    }
    .picking-table td { 
        border: 1px solid #000; 
        padding: 2.8px 4px; 
        vertical-align: middle; 
        line-height: 1.2; 
    }
    .two-column-wrapper { 
        display: flex; 
        gap: 6px; 
        width: 100%; 
        align-items: flex-start; 
    }
    .col-half { 
        flex: 1; 
        min-width: 0; 
    }
    .double-col-table th { 
        padding: 2.5px 2px; 
        font-size: 9px; 
    }
    .double-col-table td { 
        padding: 2px 3px; 
        font-size: 8.5px; 
    }
    .col-center { text-align: center; }
    .col-left { 
        text-align: left; 
        white-space: normal; 
        word-break: break-all; 
    }
    .col-right { text-align: right; }
    .text-bold { font-weight: bold; }
    .text-black-bold { 
        font-weight: 900; 
        color: #1e3a8a; 
    }
    .text-muted { 
        font-weight: bold; 
        color: #64748b; 
    }
    .check-box { 
        display: inline-block; 
        width: 13px; 
        height: 13px; 
        border: 1.2px solid #000; 
        border-radius: 2px; 
    }
    .footer-sign { 
        display: flex; 
        justify-content: flex-end; 
        gap: 25px; 
        margin-top: 6px; 
        padding-top: 4px; 
        border-top: 1px solid #cbd5e1; 
        font-size: 10px; 
        font-weight: bold; 
    }
    .sign-box { 
        border-bottom: 1px solid #000; 
        width: 75px; 
        display: inline-block; 
        text-align: center; 
    }
`;

export function executePickingListPrint() {
    if (pickingModalState.selectedDrivers.size === 0) {
        alert("출력할 기사를 1명 이상 선택해 주세요.");
        return;
    }

    const selectedDriverList = Array.from(pickingModalState.selectedDrivers);
    const dateStr = getLocalDateString();
    let allDriversPagesHtml = '';
    let validPageCount = 0;

    // 🌟 [핵심 개선] 실제 내용물 순수 높이 측정을 위한 가상 컨테이너 생성 (height 고정 해제)
    const measureContainer = document.createElement('div');
    measureContainer.style.cssText = 'position:fixed;left:-9999px;top:0;width:210mm;box-sizing:border-box;visibility:hidden;z-index:-999;';
    
    // 측정 중에는 height: 297mm를 강제로 해제하여 순수 컨텐츠가 차지하는 높이를 실측
    measureContainer.innerHTML = `
        <style>
            ${pickingPrintStyles}
            .print-page { 
                height: auto !important; 
                max-height: none !important; 
                overflow: visible !important; 
            }
        </style>
        <div id="measure-target-inner"></div>
    `;
    document.body.appendChild(measureContainer);
    const measureTarget = measureContainer.querySelector('#measure-target-inner');

    // A4 1페이지 실제 인쇄 안전 높이 (297mm = 약 1,122px 중 상하 여백 및 브라우저 프린터 헤더 마진을 고려한 임계값: 1,020px)
    const A4_PAGE_SAFE_HEIGHT_PX = 1020;

    selectedDriverList.forEach((driverName) => {
        const driverOrders = (state.parsedExcelList || []).filter(item => 
            item.assignedDriver === driverName
        );

        if (driverOrders.length === 0) return;

        const aggregationMap = {};
        driverOrders.forEach(order => {
            if (order.items && order.items.length > 0) {
                order.items.forEach(it => {
                    const name = it.name ? it.name.trim() : '기타 품목';
                    const unit = it.unit ? it.unit.trim() : '개';
                    const qty = parseInt(it.qty, 10) || 1;
                    const key = `${name}___${unit}`;

                    if (!aggregationMap[key]) {
                        aggregationMap[key] = { name, unit, totalQty: 0, orderCount: 0 };
                    }
                    aggregationMap[key].totalQty += qty;
                    aggregationMap[key].orderCount += 1;
                });
            } else {
                const name = order.itemName ? order.itemName.trim() : '상품명 미지정';
                const unit = order.unit ? order.unit.trim() : '개';
                const qty = parseInt(order.qty, 10) || 1;
                const key = `${name}___${unit}`;

                if (!aggregationMap[key]) {
                    aggregationMap[key] = { name, unit, totalQty: 0, orderCount: 0 };
                }
                aggregationMap[key].totalQty += qty;
                aggregationMap[key].orderCount += 1;
            }
        });

        const aggregatedList = Object.values(aggregationMap).sort((a, b) => b.totalQty - a.totalQty);
        validPageCount++;

        // 1단계: 1열 형태로 가상 렌더링 후 순수 내용물 전체 높이를 실측
        const singleColHtml = buildPickingPageHtml(driverName, driverOrders.length, aggregatedList, false, dateStr);
        measureTarget.innerHTML = singleColHtml;

        const pageEl = measureTarget.firstElementChild;
        const actualMeasuredHeight = pageEl ? pageEl.scrollHeight : 0;

        // 2단계: 순수 높이가 A4 1장의 한계(1,020px)를 넘어 실제로 2페이지로 밀리는 경우에만 2열로 분할!
        const isOverflow = actualMeasuredHeight > A4_PAGE_SAFE_HEIGHT_PX;

        if (isOverflow) {
            // 2페이지로 넘어감 -> 2열로 분할하여 1장에 수납
            allDriversPagesHtml += buildPickingPageHtml(driverName, driverOrders.length, aggregatedList, true, dateStr);
        } else {
            // 1페이지 안에 완전히 들어감 -> 보기 좋은 1열 그대로 유지
            allDriversPagesHtml += singleColHtml;
        }
    });

    // 측정용 가상 컨테이너 제거
    document.body.removeChild(measureContainer);

    if (validPageCount === 0) {
        alert("선택된 기사들에게 배정된 배송 상품이 없습니다.");
        return;
    }

    const pickingHtml = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>배송 동선 PRO - 기사별 피킹 리스트</title><style>${pickingPrintStyles}</style></head><body>${allDriversPagesHtml}</body></html>`;

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;z-index:-1;'; 
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow.document; 
    doc.open();
    doc.write(pickingHtml);
    doc.close();

    iframe.onload = function() {
        setTimeout(() => {
            iframe.contentWindow.focus();  
            iframe.contentWindow.print();
            setTimeout(() => { 
                document.body.removeChild(iframe); 
                // 🌟 인쇄창을 닫거나 취소해도 모달이 강제로 꺼지지 않도록 삭제 처리 완료
            }, 1000);
        }, 600);
    };
}

// ==========================================
// 8. 전역 Window 객체 바인딩
// ==========================================
window.exportToInvoiceModal = exportToInvoiceModal;
window.filterInvoicePrintList = filterInvoicePrintList;
window.handleHeaderCheckAll = handleHeaderCheckAll;
window.toggleAllInvoiceSelection = toggleAllInvoiceSelection;
window.toggleSingleInvoiceItem = toggleSingleInvoiceItem;
window.renderInvoiceOrderList = renderInvoiceOrderList;
window.previewInvoiceRow = previewInvoiceRow;
window.syncPreviewData = syncPreviewData;
window.loadSavedForms = loadSavedForms;
window.executeBatchPrint = executeBatchPrint;
window.initTemplatePdfDropZone = initTemplatePdfDropZone;
window.setAsDefaultForm = setAsDefaultForm;
window.cancelProviderFormEdit = cancelProviderFormEdit;
window.saveProviderForm = saveProviderForm;
window.deleteSavedForm = deleteSavedForm;
window.updateLivePreview = updateLivePreview;
window.previewSavedForm = previewSavedForm;
window.toggleSelectForm = toggleSelectForm;
window.applySavedForm = applySavedForm;
window.filterBySender = filterBySender;
window.openPickingDriverModal = openPickingDriverModal;
window.closePickingDriverModal = closePickingDriverModal;
window.toggleAllPickingDrivers = toggleAllPickingDrivers;
window.togglePickingDriver = togglePickingDriver;
window.executePickingListPrint = executePickingListPrint;
window.printAggregatedItemList = openPickingDriverModal;
window.sortPrintList = sortPrintList;
window.initInvoiceResizer = initInvoiceResizer;