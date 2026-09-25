// js/admin-dispatch-print.js

import { state, getLocalDateString } from "./admin-state.js";
import { formatNumber } from "./admin-dispatch-core.js";

let invoiceSearchKeyword = '';

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
    const searchInput = document.getElementById('invoice-search-input');
    if (searchInput) searchInput.value = '';

    initTemplatePdfDropZone();
    loadSavedForms(); 
    renderInvoiceOrderList();
    previewInvoiceRow(0); 
    syncPreviewData();
}

// ==========================================
// 2. 좌측 인쇄 대상 리스트 렌더링 및 선택 제어 (발송자 정보 보존)
// ==========================================
function getFilteredPrintOrders() {
    if (!state.printReadyList) return [];
    if (!invoiceSearchKeyword) return state.printReadyList;

    return state.printReadyList.filter(item => {
        const sName = (item.senderName || '').toLowerCase();
        const store = (item.storeName || '').toLowerCase();
        const addr = (item.address || item.fullAddress || '').toLowerCase();
        const phone = (item.phone || '').toLowerCase();
        const orderNo = (item.orderNo || '').toLowerCase();
        return sName.includes(invoiceSearchKeyword) || 
               store.includes(invoiceSearchKeyword) || 
               addr.includes(invoiceSearchKeyword) || 
               phone.includes(invoiceSearchKeyword) ||
               orderNo.includes(invoiceSearchKeyword);
    });
}

export function filterInvoicePrintList(query) {
    invoiceSearchKeyword = (query || '').trim().toLowerCase();
    renderInvoiceOrderList();
}

export function updateInvoiceCountBadge() {
    const badge = document.getElementById('invoice-target-count-badge');
    if (!badge || !state.printReadyList) return;
    const total = state.printReadyList.length;
    const selected = state.printReadyList.filter(it => it._selected !== false).length;
    badge.innerText = `선택 ${selected} / ${total}건`;

    const chkAll = document.getElementById('chk-invoice-all');
    if (chkAll) {
        chkAll.checked = (total > 0 && selected === total);
    }
}

export function toggleAllInvoiceSelection(isChecked) {
    const filtered = getFilteredPrintOrders();
    filtered.forEach(it => {
        it._selected = isChecked;
    });
    renderInvoiceOrderList();
    updateInvoiceCountBadge();
}

export function toggleSingleInvoiceItem(targetId, isChecked) {
    const item = state.printReadyList.find(it => String(it.id) === String(targetId));
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
    updateInvoiceCountBadge();

    if (!filtered || filtered.length === 0) {
        listEl.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">조건에 일치하는 주문이 없습니다.</div>`;
        return;
    }

    let html = '';
    filtered.forEach((item) => {
        const originalIdx = state.printReadyList.indexOf(item);
        const isCurrent = (state.currentPreviewInvoiceIndex === originalIdx);
        const isChecked = (item._selected !== false);

        const senderBadge = item.senderName 
            ? `<span class="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-black px-1.5 py-0.5 rounded shrink-0" title="발송자: ${item.senderName}"><i class="fa-solid fa-paper-plane text-[9px] mr-0.5"></i>${item.senderName}</span>` 
            : `<span class="bg-gray-100 text-gray-500 text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0">발송자 미등록</span>`;

        const storeBadge = item.storeName 
            ? `<span class="bg-blue-50 text-blue-800 border border-blue-200 text-[10px] font-black px-1.5 py-0.5 rounded truncate max-w-[130px]" title="수령처: ${item.storeName}">${item.storeName}</span>` 
            : '';

        const itemCountBadge = (item.items && item.items.length > 1) 
            ? `<span class="text-[9px] font-black text-indigo-700 bg-indigo-50 border border-indigo-200 px-1 py-0.5 rounded shrink-0">외 ${item.items.length - 1}건</span>` 
            : '';

        html += `
        <div onclick="window.previewInvoiceRow(${originalIdx})" class="p-2.5 rounded-xl border ${isCurrent ? 'bg-indigo-50/70 border-indigo-500 ring-2 ring-indigo-300' : 'bg-white border-gray-200 hover:border-indigo-300'} transition cursor-pointer shadow-2xs flex items-start gap-2 select-none">
            <div class="pt-0.5" onclick="event.stopPropagation()">
                <input type="checkbox" onchange="window.toggleSingleInvoiceItem('${item.id}', this.checked)" ${isChecked ? 'checked' : ''} class="w-4 h-4 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500 cursor-pointer">
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5 flex-wrap mb-1">
                    <span class="text-[10px] font-mono font-black text-gray-400">#${originalIdx + 1}</span>
                    ${senderBadge}
                    ${storeBadge}
                    ${itemCountBadge}
                </div>
                <p class="text-xs font-bold text-gray-900 truncate leading-snug" title="${item.address || ''}">
                    ${item.address || '주소 정보 없음'}
                </p>
                <div class="flex justify-between items-center text-[10px] text-gray-400 font-medium mt-1">
                    <span>${item.phone ? `<i class="fa-solid fa-phone text-[9px] mr-1 text-blue-500"></i>${item.phone}` : '연락처 없음'}</span>
                    <span class="font-mono">${item.orderNo || ''}</span>
                </div>
            </div>
        </div>`;
    });

    listEl.innerHTML = html;
}

// ==========================================
// 3. 주문서 1건 미리보기 화면 동기화
// ==========================================
export function previewInvoiceRow(idx) {
    if (!state.printReadyList || !state.printReadyList[idx]) return;
    state.currentPreviewInvoiceIndex = idx;
    const item = state.printReadyList[idx];

    const labelEl = document.getElementById('preview-target-order-label');
    if (labelEl) {
        const sName = item.senderName ? `[발송: ${item.senderName}] ` : '';
        labelEl.innerText = `#${idx + 1} ${sName}${item.storeName || item.address || ''}`;
    }

    document.querySelectorAll('.prev-cust-regno').forEach(el => el.innerText = item.bizNo || '');
    document.querySelectorAll('.prev-cust-name').forEach(el => el.innerText = item.senderName || item.storeName || ''); 
    document.querySelectorAll('.prev-cust-store').forEach(el => el.innerText = item.storeName || item.senderName || '');
    document.querySelectorAll('.prev-cust-tel').forEach(el => el.innerText = item.phone || '');
    
    const displayAddr = item.fullAddress || item.address || '';
    document.querySelectorAll('.prev-cust-addr').forEach(el => {
        el.innerText = displayAddr;
        el.title = displayAddr;
    });

    // 복수 상품 5줄 테이블 전개
    const tbodyEls = document.querySelectorAll('.invoice-table tbody');
    tbodyEls.forEach(tbody => {
        if (!tbody.querySelector('th')) {
            const rows = tbody.querySelectorAll('tr.empty-row');
            
            rows.forEach((tr, rIdx) => {
                const tds = tr.querySelectorAll('td');
                if (tds.length >= 6) {
                    tds[0].innerText = rIdx + 1;
                    tds[1].innerText = '';
                    tds[2].innerText = '';
                    tds[3].innerText = '';
                    tds[4].innerText = '';
                    tds[5].innerText = '';
                }
            });

            if (item.items && item.items.length > 0) {
                item.items.forEach((it, i) => {
                    if (i < 4) {
                        const tds = rows[i].querySelectorAll('td');
                        tds[1].innerText = it.name || '';
                        tds[2].innerText = it.unit || '개';
                        tds[3].innerText = formatNumber(it.qty) || '1';
                        tds[4].innerText = formatNumber(it.price) || '';
                        tds[5].innerText = formatNumber(it.total) || '';
                    } else if (i === 4) {
                        const tds = rows[4].querySelectorAll('td');
                        if (item.items.length === 5) {
                            tds[1].innerText = it.name || '';
                            tds[2].innerText = it.unit || '개';
                            tds[3].innerText = formatNumber(it.qty) || '1';
                            tds[4].innerText = formatNumber(it.price) || '';
                            tds[5].innerText = formatNumber(it.total) || '';
                        } else {
                            let remainQty = 0;
                            let remainTotal = 0;
                            for (let j = 4; j < item.items.length; j++) {
                                remainQty += parseInt(item.items[j].qty, 10) || 1;
                                remainTotal += parseInt(String(item.items[j].total).replace(/[^0-9]/g, ''), 10) || 0;
                            }
                            tds[1].innerText = `${it.name} 외 ${item.items.length - 5}건`;
                            tds[2].innerText = '묶음';
                            tds[3].innerText = formatNumber(remainQty);
                            tds[4].innerText = '';
                            tds[5].innerText = formatNumber(remainTotal);
                        }
                    }
                });
            } else {
                const tds = rows[0].querySelectorAll('td');
                tds[1].innerText = item.itemName || '';
                tds[2].innerText = item.unit || '개';
                tds[3].innerText = formatNumber(item.qty) || '1';
                tds[4].innerText = formatNumber(item.price) || '';
                tds[5].innerText = formatNumber(item.total) || '';
            }
        }
    });
    
    let payMethod = ''; 
    if (item.memo && item.memo.includes('네이버페이')) payMethod = '네이버페이'; 
    else if (item.memo && item.memo.includes('카드')) payMethod = '카드결제';
    
    document.querySelectorAll('.prev-pay-method').forEach(el => el.innerText = payMethod);
    document.querySelectorAll('.prev-total-qty').forEach(el => el.innerText = (item.qty ? `${formatNumber(item.qty)}개` : ''));
    document.querySelectorAll('.prev-cust-memo').forEach(el => el.innerText = item.memo || '');
    document.querySelectorAll('.prev-shipping-fee').forEach(el => el.innerText = '0원');
    document.querySelectorAll('.prev-item-total-amt').forEach(el => el.innerText = (item.total ? `${formatNumber(item.total)}원` : ''));
    document.querySelectorAll('.prev-total-order-amt').forEach(el => el.innerText = (item.total ? `${formatNumber(item.total)}원` : ''));
    document.querySelectorAll('span.font-normal.inline-block').forEach(span => { 
        if (span.classList.contains('w-32')) span.innerText = item.orderNo || ''; 
    });

    renderInvoiceOrderList();
    syncPreviewData(); 
}

// ==========================================
// 4. 인쇄용 주문서 HTML 생성 및 선택 일괄 인쇄 (A4 2등분)
// ==========================================
function generateInvoiceHTML(item, providerInfo) {
    const originalTemplate = document.getElementById('print-area'); 
    if (!originalTemplate) return '';
    const template = originalTemplate.cloneNode(true); 
    template.id = ''; 

    const invTitle = providerInfo.formTitle || '주문서';
    const paperBg = providerInfo.paperBg || '#ffeb5c';

    template.querySelectorAll('.invoice-title').forEach(el => {
        const subTag = el.querySelector('span');
        const subText = subTag ? subTag.innerText : '';
        el.innerHTML = `${invTitle}<span style="font-size: 13px; font-weight: normal; text-decoration: none;">${subText}</span>`;
    });

    template.querySelectorAll('.invoice-half').forEach(el => {
        el.style.backgroundColor = paperBg;
    });

    template.querySelectorAll('.prev-prov-regno').forEach(el => el.innerText = providerInfo.regno);
    template.querySelectorAll('.prev-prov-name').forEach(el => el.innerText = providerInfo.name);
    template.querySelectorAll('.prev-prov-addr').forEach(el => el.innerText = providerInfo.addr);
    template.querySelectorAll('.prev-prov-tel').forEach(el => el.innerText = providerInfo.tel);
    template.querySelectorAll('.prev-prov-add-tel').forEach(el => el.innerText = providerInfo.addTel);

    template.querySelectorAll('.prev-cust-regno').forEach(el => el.innerText = item.bizNo || '');
    template.querySelectorAll('.prev-cust-name').forEach(el => el.innerText = item.senderName || item.storeName || '');
    template.querySelectorAll('.prev-cust-store').forEach(el => el.innerText = item.storeName || item.senderName || '');
    template.querySelectorAll('.prev-cust-tel').forEach(el => el.innerText = item.phone || '');
    
    const printAddr = item.fullAddress || item.address || '';
    template.querySelectorAll('.prev-cust-addr').forEach(el => {
        el.innerText = printAddr;
    });

    const tbodyEls = template.querySelectorAll('.invoice-table tbody');
    tbodyEls.forEach(tbody => {
        if (!tbody.querySelector('th')) {
            const rows = tbody.querySelectorAll('tr.empty-row');
            
            rows.forEach((tr, rIdx) => {
                const tds = tr.querySelectorAll('td');
                if (tds.length >= 6) {
                    tds[0].innerText = rIdx + 1;
                    tds[1].innerText = '';
                    tds[2].innerText = '';
                    tds[3].innerText = '';
                    tds[4].innerText = '';
                    tds[5].innerText = '';
                }
            });

            if (item.items && item.items.length > 0) {
                item.items.forEach((it, i) => {
                    if (i < 4) {
                        const tds = rows[i].querySelectorAll('td');
                        tds[1].innerText = it.name || '';
                        tds[2].innerText = it.unit || '개';
                        tds[3].innerText = formatNumber(it.qty) || '1';
                        tds[4].innerText = formatNumber(it.price) || '';
                        tds[5].innerText = formatNumber(it.total) || '';
                    } else if (i === 4) {
                        const tds = rows[4].querySelectorAll('td');
                        if (item.items.length === 5) {
                            tds[1].innerText = it.name || '';
                            tds[2].innerText = it.unit || '개';
                            tds[3].innerText = formatNumber(it.qty) || '1';
                            tds[4].innerText = formatNumber(it.price) || '';
                            tds[5].innerText = formatNumber(it.total) || '';
                        } else {
                            let remainQty = 0;
                            let remainTotal = 0;
                            for (let j = 4; j < item.items.length; j++) {
                                remainQty += parseInt(item.items[j].qty, 10) || 1;
                                remainTotal += parseInt(String(item.items[j].total).replace(/[^0-9]/g, ''), 10) || 0;
                            }
                            tds[1].innerText = `${it.name} 외 ${item.items.length - 5}건`;
                            tds[2].innerText = '묶음';
                            tds[3].innerText = formatNumber(remainQty);
                            tds[4].innerText = '';
                            tds[5].innerText = formatNumber(remainTotal);
                        }
                    }
                });
            } else {
                const tds = rows[0].querySelectorAll('td');
                tds[1].innerText = item.itemName || '';
                tds[2].innerText = item.unit || '개';
                tds[3].innerText = formatNumber(item.qty) || '1';
                tds[4].innerText = formatNumber(item.price) || '';
                tds[5].innerText = formatNumber(item.total) || '';
            }
        }
    });

    let payMethod = ''; 
    if (item.memo && item.memo.includes('네이버페이')) payMethod = '네이버페이'; 
    else if (item.memo && item.memo.includes('카드')) payMethod = '카드결제';
    
    template.querySelectorAll('.prev-pay-method').forEach(el => el.innerText = payMethod);
    template.querySelectorAll('.prev-total-qty').forEach(el => el.innerText = (item.qty ? `${formatNumber(item.qty)}개` : ''));
    template.querySelectorAll('.prev-cust-memo').forEach(el => el.innerText = item.memo || '');
    template.querySelectorAll('.prev-shipping-fee').forEach(el => el.innerText = '0원');
    template.querySelectorAll('.prev-item-total-amt').forEach(el => el.innerText = (item.total ? `${formatNumber(item.total)}원` : ''));
    template.querySelectorAll('.prev-total-order-amt').forEach(el => el.innerText = (item.total ? `${formatNumber(item.total)}원` : ''));

    template.querySelectorAll('.invoice-table').forEach(table => {
        table.querySelectorAll('tr').forEach(tr => {
            const text = tr.innerText;
            if ((text.includes('주 소') || text.includes('배 송 요 청 사 항')) && !tr.classList.contains('double-height')) {
                tr.classList.add('double-height');
                tr.querySelectorAll('td').forEach(td => { 
                    if (!td.classList.contains('invoice-label') && !td.classList.contains('inv-text-right')) td.classList.add('multi-line-text'); 
                });
            }
        });
    });

    const dateStr = getLocalDateString();
    const dateSpan1 = template.querySelector('#prev-date-1'); 
    if (dateSpan1) { dateSpan1.id = ''; dateSpan1.innerText = dateStr; }
    const dateSpan2 = template.querySelector('#prev-date-2'); 
    if (dateSpan2) { dateSpan2.id = ''; dateSpan2.innerText = dateStr; }

    template.querySelectorAll('span.font-normal.inline-block').forEach(span => { 
        if (span.classList.contains('w-32')) span.innerText = item.orderNo || ''; 
    });

    return template.outerHTML;
}

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

    const btn1 = document.getElementById('btn-batch-print');
    const btn2 = document.getElementById('btn-batch-print-top');
    [btn1, btn2].forEach(btn => {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 문서 생성 중...';
        }
    });

    const providerInfo = {
        title: document.getElementById('input-form-title')?.value || '', 
        regno: document.getElementById('input-prov-regno')?.value || '',
        name: document.getElementById('input-prov-name')?.value || '', 
        addr: document.getElementById('input-prov-addr')?.value || '',
        tel: document.getElementById('input-prov-tel')?.value || '', 
        addTel: document.getElementById('input-prov-add-tel')?.value || '',
        formTitle: '주문서',
        paperBg: '#ffeb5c'
    };

    const savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    if (state.currentSelectedFormIndex !== null && savedForms[state.currentSelectedFormIndex]) {
        const activeForm = savedForms[state.currentSelectedFormIndex];
        if (activeForm.formTitle) providerInfo.formTitle = activeForm.formTitle;
        if (activeForm.paperBg) providerInfo.paperBg = activeForm.paperBg;
    }

    let printContents = ''; 
    selectedOrders.forEach(item => { 
        printContents += generateInvoiceHTML(item, providerInfo); 
    });

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;z-index:-1;'; 
    document.body.appendChild(iframe);
    
    const doc = iframe.contentWindow.document; 
    doc.open();
    doc.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>배송 경로 PRO - 주문서 출력</title><style>
        * { box-sizing: border-box; } @media print { @page { size: A4 portrait; margin: 0; } body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: white; } .invoice-container { box-shadow: none !important; border: none !important; margin: 0 !important; page-break-after: always; width: 210mm; height: 297mm; } .invoice-half { height: 148mm; page-break-inside: avoid; } }
        body { background: white; margin: 0; padding: 0; font-family: 'Malgun Gothic', sans-serif; } .invoice-container { width: 210mm; height: 297mm; margin: 0 auto; display: flex; flex-direction: column; } .invoice-half { height: 148mm; padding: 5mm 8mm; display: flex; flex-direction: column; -webkit-print-color-adjust: exact; print-color-adjust: exact; } .invoice-cut-line { border-top: 1px dashed #6b7280; width: 100%; margin: 0; } .invoice-title { text-align: center; font-size: 21px; font-weight: 900; letter-spacing: 6px; text-decoration: underline; margin-bottom: 5px; } .invoice-table { width: 100%; border-collapse: collapse; border: 2px solid #000; font-size: 10px; margin-bottom: 4px; table-layout: fixed; } .invoice-table th, .invoice-table td { border: 1px solid #000; padding: 2px 5px; height: 27px; vertical-align: middle; overflow: hidden; word-break: break-all; } .double-height { height: 54px !important; } .double-height td { height: 54px !important; } .multi-line-text { white-space: normal !important; line-height: 1.3; } .invoice-table th { font-weight: bold; text-align: center; } .invoice-label { font-weight: bold; text-align: center; white-space: nowrap; } .writing-mode-vertical { writing-mode: vertical-rl; text-orientation: upright; text-align: center; letter-spacing: 3px; } .text-fit-auto { font-size: 9.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .inv-text-center { text-align: center; } .inv-text-left { text-align: left; padding-left: 6px !important; } .inv-text-right { text-align: right; padding-right: 6px !important; } .inv-font-bold { font-weight: bold; }
    </style></head><body>${printContents}</body></html>`);
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
// 5. 창고 상차 및 검수용 전체 상품 합산 피킹 리스트
// ==========================================
export function printAggregatedItemList() {
    const selectedOrders = (state.printReadyList && state.printReadyList.length > 0)
        ? state.printReadyList.filter(item => item._selected !== false)
        : state.parsedExcelList;

    if (!selectedOrders || selectedOrders.length === 0) {
        alert("집계할 배송 주문 데이터가 없습니다.");
        return;
    }

    const aggregationMap = {};

    selectedOrders.forEach(order => {
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
    const totalItemTypes = aggregatedList.length;
    const totalItemQtySum = aggregatedList.reduce((sum, item) => sum + item.totalQty, 0);
    const dateStr = getLocalDateString();

    let tableRowsHtml = '';
    aggregatedList.forEach((item, idx) => {
        tableRowsHtml += `
        <tr>
            <td style="text-align: center; font-weight: bold; padding: 6px 4px;">${idx + 1}</td>
            <td style="text-align: left; font-weight: bold; padding: 6px 8px; font-size: 11px;">${item.name}</td>
            <td style="text-align: center; padding: 6px 4px;">${item.unit}</td>
            <td style="text-align: right; font-weight: 900; padding: 6px 8px; font-size: 12px; color: #1e3a8a;">${formatNumber(item.totalQty)}</td>
            <td style="text-align: center; font-weight: bold; color: #64748b; padding: 6px 4px;">${item.orderCount}곳</td>
            <td style="text-align: center; padding: 6px 4px;"><span style="display: inline-block; width: 18px; height: 18px; border: 1.5px solid #000; border-radius: 3px;"></span></td>
        </tr>`;
    });

    const pickingHtml = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>배송 동선 PRO - 창고 상차 피킹 리스트</title><style>
        * { box-sizing: border-box; }
        @media print {
            @page { size: A4 portrait; margin: 10mm; }
            body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: white; }
            .print-page { box-shadow: none !important; border: none !important; width: 100% !important; height: auto !important; }
        }
        body { font-family: 'Malgun Gothic', 'Dotum', sans-serif; background: white; margin: 0; padding: 0; color: #1e293b; }
        .print-page { width: 190mm; margin: 0 auto; padding: 5mm; }
        .header-title { text-align: center; font-size: 22px; font-weight: 900; letter-spacing: 2px; margin-bottom: 4px; border-bottom: 3px double #000; padding-bottom: 6px; }
        .meta-info { display: flex; justify-content: space-between; font-size: 11px; font-weight: bold; margin-bottom: 10px; color: #334155; }
        .summary-box { background-color: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 8px 12px; display: flex; justify-content: space-around; font-size: 11px; font-weight: 900; margin-bottom: 12px; }
        .summary-box span b { color: #2563eb; font-size: 13px; margin-left: 4px; }
        table { width: 100%; border-collapse: collapse; border: 2px solid #000; font-size: 10.5px; }
        th { background-color: #f1f5f9; border: 1px solid #000; padding: 6px 4px; font-weight: 900; text-align: center; }
        td { border: 1px solid #000; }
        .footer-sign { display: flex; justify-content: flex-end; gap: 30px; margin-top: 18px; font-size: 11px; font-weight: bold; }
        .sign-box { border-bottom: 1px solid #000; width: 90px; display: inline-block; text-align: center; }
    </style></head><body>
    <div class="print-page">
        <div class="header-title">창고 상차 및 검수용 전체 상품 합산 피킹 리스트</div>
        <div class="meta-info">
            <span>출력일자: ${dateStr}</span>
            <span>배송 경로 PRO 통합물류시스템</span>
        </div>
        <div class="summary-box">
            <span>총 배송처: <b>${selectedOrders.length}</b>곳</span>
            <span>총 품목 종류: <b>${totalItemTypes}</b>종</span>
            <span>전체 물품 총수량: <b>${formatNumber(totalItemQtySum)}</b>개</span>
        </div>
        <table>
            <colgroup>
                <col style="width: 7%;">
                <col style="width: 48%;">
                <col style="width: 12%;">
                <col style="width: 13%;">
                <col style="width: 10%;">
                <col style="width: 10%;">
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
                ${tableRowsHtml}
            </tbody>
        </table>
        <div class="footer-sign">
            <span>상차 담당자: <span class="sign-box">(서명)</span></span>
            <span>출고 검수자: <span class="sign-box">(서명)</span></span>
        </div>
    </div>
    </body></html>`;

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
            setTimeout(() => { document.body.removeChild(iframe); }, 1000);
        }, 600);
    };
}

// ==========================================
// 6. 기본 양식제작용 PDF 드롭존 초기화 및 1페이지 자동인식
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
            if (file) await handleTemplatePdfFile(file);
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
            await handleTemplatePdfFile(file);
        } else if (file) {
            alert("양식 제작용 파일은 PDF 파일만 지원합니다.");
        }
    });

    dropzone.dataset.bound = 'true';
}

export async function handleTemplatePdfFile(file) {
    if (!window.pdfjsLib) {
        alert("PDF 처리 라이브러리가 로드되지 않았습니다. 새로고침 후 다시 시도해주세요.");
        return;
    }

    try {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
        const pdf = await loadingTask.promise;

        if (pdf.numPages < 1) {
            alert("PDF 파일에서 유효한 페이지를 찾을 수 없습니다.");
            return;
        }

        // 🌟 수많은 페이지 중 대표로 첫 페이지만 정밀 추출
        const page1 = await pdf.getPage(1);
        const textContent = await page1.getTextContent();
        const rawStrings = textContent.items.map(it => it.str.trim()).filter(Boolean);
        const pageText = rawStrings.join(' ');

        let detectedTitle = file.name.replace(/\.[^/.]+$/, '').trim();
        let detectedRegno = '';
        let detectedName = '';
        let detectedAddr = '';
        let detectedTel = '';
        let detectedAddTel = '';

        // 사업자등록번호 감지
        const bizMatch = pageText.match(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/);
        if (bizMatch) detectedRegno = bizMatch[0].replace(/\s+/g, '-');

        // 전화번호 감지
        const telMatch = pageText.match(/(?:0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4})/g);
        if (telMatch && telMatch.length > 0) {
            detectedTel = telMatch[0];
            if (telMatch.length > 1) detectedAddTel = telMatch[1];
        }

        // 주소 패턴 감지
        const addrMatch = pageText.match(/(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\n\r]*?(?:로|길|동|읍|면|가)\s*[\d\-]+/);
        if (addrMatch) {
            detectedAddr = addrMatch[0].trim();
        }

        // 상호명 감지
        const storeMatch = pageText.match(/(?:상호|법인명|상호명|공급자)\s*[:|]?\s*([가-힣A-Za-z0-9\(\)\s]{2,20})/);
        if (storeMatch) {
            detectedName = storeMatch[1].trim();
        }

        // 입력 폼에 바인딩
        const titleInput = document.getElementById('input-form-title');
        const regnoInput = document.getElementById('input-prov-regno');
        const nameInput = document.getElementById('input-prov-name');
        const addrInput = document.getElementById('input-prov-addr');
        const telInput = document.getElementById('input-prov-tel');
        const addTelInput = document.getElementById('input-prov-add-tel');

        if (titleInput) titleInput.value = detectedTitle || '새 공급자 양식';
        if (regnoInput) regnoInput.value = detectedRegno;
        if (nameInput) nameInput.value = detectedName;
        if (addrInput) addrInput.value = detectedAddr;
        if (telInput) telInput.value = detectedTel;
        if (addTelInput) addTelInput.value = detectedAddTel;

        // 공급자 정보 확인/수정 아코디언 펼치기
        const accordion = document.getElementById('form-setup-accordion');
        if (accordion && accordion.classList.contains('hidden')) {
            accordion.classList.remove('hidden');
            accordion.classList.add('flex');
        }

        syncPreviewData();
        alert(`[PDF 양식 인식 완료]\n\n업로드된 PDF의 1페이지에서 공급자 양식 정보를 추출했습니다.\n우측 공급자 정보 확인/수정란에서 내용을 검토 후 [폼 저장]을 눌러 기본 양식으로 등록해 주세요.`);
    } catch (e) {
        console.error("PDF 양식 파싱 오류:", e);
        alert("PDF 파일 양식 분석 중 오류가 발생했습니다: " + e.message);
    }
}

// ==========================================
// 7. 입력 폼 동기화 및 템플릿(공급자 정보) 관리
// ==========================================
export function syncPreviewData() {
    const regno = document.getElementById('input-prov-regno')?.value || '';
    const name = document.getElementById('input-prov-name')?.value || '';
    const addr = document.getElementById('input-prov-addr')?.value || '';
    const tel = document.getElementById('input-prov-tel')?.value || '';
    const addTel = document.getElementById('input-prov-add-tel')?.value || '';
    const dateStr = getLocalDateString();
    
    if (document.getElementById('prev-date-1')) document.getElementById('prev-date-1').innerText = dateStr;
    if (document.getElementById('prev-date-2')) document.getElementById('prev-date-2').innerText = dateStr;
    document.querySelectorAll('.prev-prov-regno').forEach(el => el.innerText = regno);
    document.querySelectorAll('.prev-prov-name').forEach(el => el.innerText = name);
    document.querySelectorAll('.prev-prov-addr').forEach(el => el.innerText = addr);
    document.querySelectorAll('.prev-prov-tel').forEach(el => el.innerText = tel);
    document.querySelectorAll('.prev-prov-add-tel').forEach(el => el.innerText = addTel);
}

export function updateLivePreview() {
    clearTimeout(state.previewDebounceTimer);
    state.previewDebounceTimer = setTimeout(() => { syncPreviewData(); }, 150);
}

export function loadSavedForms() {
    const listEl = document.getElementById('saved-forms-list');
    if (!listEl) return;
    const savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    
    if (savedForms.length === 0) { 
        listEl.innerHTML = `<div class="text-center text-gray-400 py-6 text-[10px] font-bold">저장된 폼이 없습니다.<br>PDF를 업로드하거나 폼을 작성하고 저장하세요.</div>`; 
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
        if (defaultIdx >= 0) applySavedForm(defaultIdx);
    }
}

export function setAsDefaultForm(idx) {
    const savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    if (!savedForms[idx]) return;

    savedForms.forEach((f, i) => { f.isDefault = (i === idx); });
    localStorage.setItem('deliveryPro_savedForms', JSON.stringify(savedForms));
    alert(`[${savedForms[idx].title}] 서식이 기본 주문서 양식으로 설정되었습니다.`);
    loadSavedForms();
}

export function toggleSelectForm(idx) {
    if (state.currentSelectedFormIndex === idx) { 
        state.currentSelectedFormIndex = null; 
        cancelProviderFormEdit(); 
        loadSavedForms(); 
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

    const titleInput = document.getElementById('input-form-title');
    const regnoInput = document.getElementById('input-prov-regno');
    const nameInput = document.getElementById('input-prov-name');
    const addrInput = document.getElementById('input-prov-addr');
    const telInput = document.getElementById('input-prov-tel');
    const addTelInput = document.getElementById('input-prov-add-tel');

    if (titleInput) titleInput.value = form.title || '';
    if (regnoInput) regnoInput.value = form.regno || '';
    if (nameInput) nameInput.value = form.name || '';
    if (addrInput) addrInput.value = form.addr || '';
    if (telInput) telInput.value = form.tel || '';
    if (addTelInput) addTelInput.value = form.addTel || '';

    loadSavedForms(); 
    syncPreviewData();
}

export function saveProviderForm() {
    const titleInput = document.getElementById('input-form-title');
    const title = titleInput ? titleInput.value.trim() : '';
    if (!title) { alert("저장할 폼의 '제목'을 입력해주세요."); return; }
    
    const newForm = {
        title, 
        regno: document.getElementById('input-prov-regno')?.value.trim() || '',
        name: document.getElementById('input-prov-name')?.value.trim() || '',
        addr: document.getElementById('input-prov-addr')?.value.trim() || '',
        tel: document.getElementById('input-prov-tel')?.value.trim() || '',
        addTel: document.getElementById('input-prov-add-tel')?.value.trim() || '',
        formTitle: '주문서',
        paperBg: '#ffeb5c',
        isDefault: false,
        savedAt: Date.now()
    };
    
    const savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    const existingIdx = savedForms.findIndex(f => f.title === title);
    
    if (existingIdx >= 0) {
        if (confirm(`'${title}'(으)로 이미 저장된 폼이 있습니다. 덮어쓰시겠습니까?`)) {
            newForm.isDefault = savedForms[existingIdx].isDefault;
            savedForms[existingIdx] = newForm;
        } else {
            return;
        }
    } else { 
        if (savedForms.length === 0) newForm.isDefault = true;
        savedForms.push(newForm); 
    }
    
    localStorage.setItem('deliveryPro_savedForms', JSON.stringify(savedForms));
    alert(`[${title}] 폼이 성공적으로 저장되었습니다.`);
    loadSavedForms();
}

export function deleteSavedForm(idx) {
    const savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    if (!confirm(`[${savedForms[idx].title}] 폼을 삭제하시겠습니까?`)) return;
    
    savedForms.splice(idx, 1);
    localStorage.setItem('deliveryPro_savedForms', JSON.stringify(savedForms));
    
    if (state.currentSelectedFormIndex === idx) state.currentSelectedFormIndex = null;
    loadSavedForms();
}

export function cancelProviderFormEdit() {
    state.currentSelectedFormIndex = null;
    ['input-form-title', 'input-prov-regno', 'input-prov-name', 'input-prov-addr', 'input-prov-tel', 'input-prov-add-tel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    
    const accordion = document.getElementById('form-setup-accordion');
    if (accordion) { 
        accordion.classList.add('hidden'); 
        accordion.classList.remove('flex'); 
    }
    
    loadSavedForms(); 
    syncPreviewData();
}

// ==========================================
// 8. 전역 Window 객체 바인딩
// ==========================================
window.exportToInvoiceModal = exportToInvoiceModal;
window.filterInvoicePrintList = filterInvoicePrintList;
window.toggleAllInvoiceSelection = toggleAllInvoiceSelection;
window.toggleSingleInvoiceItem = toggleSingleInvoiceItem;
window.renderInvoiceOrderList = renderInvoiceOrderList;
window.previewInvoiceRow = previewInvoiceRow;
window.syncPreviewData = syncPreviewData;
window.loadSavedForms = loadSavedForms;
window.executeBatchPrint = executeBatchPrint;
window.printAggregatedItemList = printAggregatedItemList;
window.initTemplatePdfDropZone = initTemplatePdfDropZone;
window.handleTemplatePdfFile = handleTemplatePdfFile;
window.setAsDefaultForm = setAsDefaultForm;
window.cancelProviderFormEdit = cancelProviderFormEdit;
window.saveProviderForm = saveProviderForm;
window.deleteSavedForm = deleteSavedForm;
window.updateLivePreview = updateLivePreview;
window.previewSavedForm = previewSavedForm;
window.toggleSelectForm = toggleSelectForm;
window.applySavedForm = applySavedForm;