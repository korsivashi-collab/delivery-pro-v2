// js/admin-dispatch-print.js

import { state } from "./admin-state.js";
import {
    parsePdfToEditableDocument,
    templateBuilderState,
    fillTemplateWithOrderData
} from "./admin-dispatch-template.js";
import { loadSavedForms } from "./admin-dispatch-forms.js";

let invoiceSearchKeyword = '';
let currentSenderFilter = 'ALL';

// 🌟 좌측 인쇄 리스트 정렬 상태 변수 (기본: 기사명 순)
let printListSortField = 'driver'; // 'driver', 'originalIdx', 'senderName', 'storeName', 'address'
let printListSortAsc = true;

// ==========================================
// 1. 주문서 통합관리 모달 열기 & 초기화 (주문 데이터 없어도 상시 진입 허용 및 잔상 클리어)
// ==========================================
export function exportToInvoiceModal() {
    // 엑셀 테이블(#invoice-excel-tbody) 내부의 체크박스만 엄격히 조회
    const excelCheckboxes = document.querySelectorAll('#invoice-excel-tbody .row-checkbox:checked');
    state.printReadyList = [];

    if (excelCheckboxes.length > 0) {
        // 사용자가 엑셀 테이블에서 특정 배송지를 선택한 경우
        excelCheckboxes.forEach(cb => { 
            const idx = parseInt(cb.getAttribute('data-idx'), 10); 
            if (state.parsedExcelList && state.parsedExcelList[idx]) {
                const item = { ...state.parsedExcelList[idx], _selected: true };
                state.printReadyList.push(item); 
            }
        });
    } else if (state.parsedExcelList && state.parsedExcelList.length > 0) {
        // 체크된 항목이 없을 때 등록된 주문 데이터가 있으면 전체 로드
        state.printReadyList = state.parsedExcelList.map(item => ({ ...item, _selected: true }));
    } else {
        // 주문 데이터가 없어도 차단하지 않고 빈 목록 상태로 모달 오픈 허용
        state.printReadyList = [];
    }

    // 🌟 모달 진입 시 기사명 가나다순으로 기본 정렬
    if (state.printReadyList.length > 0) {
        state.printReadyList.sort((a, b) => {
            const driverA = a.assignedDriver || '미배정';
            const driverB = b.assignedDriver || '미배정';
            return driverA.localeCompare(driverB, 'ko');
        });
    }

    if (window.closeAutoDispatchModal) window.closeAutoDispatchModal(); 
    const invoiceModal = document.getElementById('pro-invoice-modal');
    if (invoiceModal) invoiceModal.classList.remove('hidden');

    state.currentPreviewInvoiceIndex = 0;
    invoiceSearchKeyword = '';
    currentSenderFilter = 'ALL';
    printListSortField = 'driver';
    printListSortAsc = true;

    const searchInput = document.getElementById('invoice-search-input');
    if (searchInput) searchInput.value = '';

    populateSenderFilterDropdown();
    initTemplatePdfDropZone();
    initInvoiceResizer(); // 목록 패널 폭 조절 리사이저 초기화
    loadSavedForms(); 
    renderInvoiceOrderList();
    
    // 🌟 주문이 있을 때만 미리보기를 렌더링하고, 없을 때는 잔상 캔버스를 즉시 백지화
    if (state.printReadyList.length > 0) {
        previewInvoiceRow(0); 
    } else {
        clearInvoicePreviewCanvas();
    }
}

// 🌟 미리보기 캔버스 및 라벨 잔상 완전 제거 헬퍼
function clearInvoicePreviewCanvas() {
    const labelEl = document.getElementById('preview-target-order-label');
    if (labelEl) labelEl.innerText = '출력 대상 주문 없음';
    
    const docCanvas = document.getElementById('editable-doc-canvas');
    if (docCanvas) docCanvas.innerHTML = '';
    
    const placeholder = document.getElementById('preview-placeholder');
    if (placeholder) placeholder.classList.remove('hidden');
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
    if (!selectEl) return;

    if (!state.printReadyList || state.printReadyList.length === 0) {
        selectEl.innerHTML = `<option value="ALL">전체 공급자 (주문 없음)</option>`;
        return;
    }

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
    } else {
        clearInvoicePreviewCanvas();
    }
}

// ==========================================
// 2. 좌측 인쇄 대상 리스트 (스마트 토글 및 헤더 동기화)
// ==========================================
function getFilteredPrintOrders() {
    if (!state.printReadyList) return [];
    let list = [...state.printReadyList];

    if (currentSenderFilter !== 'ALL') {
        list = list.filter(item => (item.senderName || '').trim() === currentSenderFilter);
    }

    if (invoiceSearchKeyword) {
        list = list.filter(item => {
            const sName = (item.senderName || '').toLowerCase();
            const store = (item.storeName || '').toLowerCase();
            const addr = (item.address || item.fullAddress || '').toLowerCase();
            const phone = (item.phone || '').toLowerCase();
            const driver = (item.assignedDriver || '').toLowerCase();
            
            return sName.includes(invoiceSearchKeyword) || 
                   store.includes(invoiceSearchKeyword) || 
                   addr.includes(invoiceSearchKeyword) || 
                   phone.includes(invoiceSearchKeyword) ||
                   driver.includes(invoiceSearchKeyword);
        });
    }

    list.sort((a, b) => {
        let valA = '';
        let valB = '';

        if (printListSortField === 'driver') {
            const driverA = a.assignedDriver || 'zzz';
            const driverB = b.assignedDriver || 'zzz';
            if (driverA !== driverB) {
                return printListSortAsc ? driverA.localeCompare(driverB, 'ko') : driverB.localeCompare(driverA, 'ko');
            }
            
            const idxA = state.printReadyList.indexOf(a);
            const idxB = state.printReadyList.indexOf(b);
            return printListSortAsc ? (idxA - idxB) : (idxB - idxA);
            
        } else if (printListSortField === 'senderName') {
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
    
    const filtered = getFilteredPrintOrders();
    if (filtered.length > 0) {
        const firstIdx = state.printReadyList.indexOf(filtered[0]);
        if (firstIdx !== -1) previewInvoiceRow(firstIdx);
    } else {
        clearInvoicePreviewCanvas();
    }
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
    if (!badge) return;
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

// 헤더 체크박스 클릭 핸들러
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

// 개별 항목 선택 토글
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
        listEl.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">출력할 주문 데이터가 없습니다.<br><span class="text-[10px] text-gray-400 font-normal">우측에서 서식 PDF 업로드 및 양식 편집이 가능합니다.</span></div>`;
        updateInvoiceCountBadge();
        clearInvoicePreviewCanvas();
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
                    <th class="sortable-th py-2.5 px-2 text-center w-16" onclick="window.sortPrintList('driver')" title="담당 기사별 정렬">기사${getArrow('driver')}</th>
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

        const driverBadge = item.assignedDriver
            ? `<span class="bg-blue-100 text-blue-800 text-[10px] font-black px-2 py-0.5 rounded shadow-2xs truncate max-w-[70px] inline-block" title="${item.assignedDriver}">${item.assignedDriver}</span>`
            : `<span class="text-[10px] text-gray-400 font-bold">미배정</span>`;

        tableHtml += `
        <tr onclick="window.previewInvoiceRow(${originalIdx})" class="hover:bg-indigo-50/60 cursor-pointer transition ${isCurrent ? 'bg-indigo-50/80 ring-1 ring-indigo-400 font-bold' : ''}">
            <td class="text-center py-2 px-2" onclick="event.stopPropagation()">
                <input type="checkbox" onchange="window.toggleSingleInvoiceItem('${item.id}', this.checked, ${originalIdx})" ${isChecked ? 'checked' : ''} class="w-4 h-4 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500 cursor-pointer invoice-row-checkbox" data-idx="${originalIdx}">
            </td>
            <td class="text-center py-2 px-1">${driverBadge}</td>
            <td class="py-2 px-3 font-black text-amber-900 truncate max-w-[90px]" title="${senderDisplay}">${senderDisplay}</td>
            <td class="py-2 px-3 font-bold text-indigo-900 truncate max-w-[100px]" title="${storeDisplay}">${storeDisplay}</td>
            <td class="py-2 px-3 text-gray-900 truncate max-w-[160px]" title="${addressDisplay}">${addressDisplay}</td>
        </tr>`;
    });

    tableHtml += `</tbody></table></div>`;
    listEl.innerHTML = tableHtml;

    updateInvoiceCountBadge();
}

// ==========================================
// 3. 주문 1건 미리보기 연동 (상품명 잘림 잔여 스타일 실시간 소거)
// ==========================================
export function previewInvoiceRow(idx) {
    if (!state.printReadyList || !state.printReadyList[idx]) {
        clearInvoicePreviewCanvas();
        return;
    }
    state.currentPreviewInvoiceIndex = idx;
    const item = state.printReadyList[idx];

    const labelEl = document.getElementById('preview-target-order-label');
    if (labelEl) {
        const sName = item.senderName ? `[${item.senderName}] ` : '';
        const driverCourse = item.assignedDriver 
            ? ` (담당: ${item.assignedDriver})` 
            : ' (기사 미배정)';
        labelEl.innerText = `#${idx + 1} ${sName}${item.storeName || item.address || ''}${driverCourse}`;
    }

    const docCanvas = document.getElementById('editable-doc-canvas');
    const placeholder = document.getElementById('preview-placeholder');
    const baseTemplate = templateBuilderState.currentDocHtml;

    if (docCanvas && baseTemplate && typeof fillTemplateWithOrderData === 'function') {
        const previewItem = {
            ...item,
            assignedDriver: item.assignedDriver ? item.assignedDriver : '미배정'
        };
        let filledHtml = fillTemplateWithOrderData(baseTemplate, previewItem, idx);
        
        // 🌟 안전장치: 구버전 서식의 잔여 nowrap 및 ellipsis 인라인 속성 실시간 완전 소거
        filledHtml = filledHtml.replace(/white-space:\s*nowrap;?/gi, '')
                               .replace(/text-overflow:\s*ellipsis;?/gi, '');

        docCanvas.innerHTML = filledHtml;
        if (placeholder) placeholder.classList.add('hidden');
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
// 5. 주문서 일괄 출력 (인쇄 엔진 레벨 상품명 자동 줄바꿈 및 절대 안 잘림 강제 주입)
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

    selectedOrders.sort((a, b) => {
        const driverA = a.assignedDriver || '미배정';
        const driverB = b.assignedDriver || '미배정';
        return driverA.localeCompare(driverB, 'ko');
    });

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
        const printItem = {
            ...item,
            assignedDriver: item.assignedDriver ? item.assignedDriver : '미배정'
        };
        let filledPageHtml = fillTemplateWithOrderData(baseTemplateHtml, printItem, idx);
        
        // 🌟 상품명 잘림 잔여 인라인 속성 완전 소거 및 contenteditable 비활성화
        filledPageHtml = filledPageHtml.replace(/white-space:\s*nowrap;?/gi, '')
                                       .replace(/text-overflow:\s*ellipsis;?/gi, '')
                                       .replace(/contenteditable="true"/g, 'contenteditable="false"');

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

        /* 🌟 인쇄 엔진 핵심: 상품명 컬럼 절대 잘림 방지 (강제 자동 줄바꿈 및 전체 표시) */
        .item-table {
            table-layout: fixed !important;
            width: 100% !important;
        }
        .item-table th, 
        .item-table td {
            word-break: break-all !important;
            white-space: normal !important;
            text-overflow: clip !important;
            line-height: 1.18 !important;
        }
        .item-row td {
            word-break: break-all !important;
            white-space: normal !important;
        }
        .item-row td div {
            white-space: normal !important;
            text-overflow: clip !important;
            overflow: visible !important;
            max-height: none !important;
            line-height: 1.18 !important;
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
// Window 전역 객체 바인딩 (HTML 인라인 이벤트용)
// ==========================================
window.exportToInvoiceModal = exportToInvoiceModal;
window.filterInvoicePrintList = filterInvoicePrintList;
window.handleHeaderCheckAll = handleHeaderCheckAll;
window.toggleAllInvoiceSelection = toggleAllInvoiceSelection;
window.toggleSingleInvoiceItem = toggleSingleInvoiceItem;
window.renderInvoiceOrderList = renderInvoiceOrderList;
window.previewInvoiceRow = previewInvoiceRow;
window.executeBatchPrint = executeBatchPrint;
window.initTemplatePdfDropZone = initTemplatePdfDropZone;
window.filterBySender = filterBySender;
window.sortPrintList = sortPrintList;
window.initInvoiceResizer = initInvoiceResizer;