// js/admin-dispatch-print.js

import { state } from "./admin-state.js";
import {
    previewPdfOrder, printPdfOrders,
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
        listEl.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">출력할 주문 데이터가 없습니다.<br><span class="text-[10px] text-gray-400 font-normal">저장된 양식을 선택하거나 주문서 통합 요청하기로 문의해 주세요.</span></div>`;
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
        const addressDisplay = item.fullAddress || item.address || '-';

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

    previewPdfOrder(item).catch(e=>alert(e.message));

    renderInvoiceOrderList();
}

// ==========================================
// 저장된 양식 인쇄
// ==========================================
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

    return printPdfOrders(selectedOrders);
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
window.filterBySender = filterBySender;
window.sortPrintList = sortPrintList;
window.initInvoiceResizer = initInvoiceResizer;