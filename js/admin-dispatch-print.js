// js/admin-dispatch-print.js

import { state, getLocalDateString } from "./admin-state.js";
// formatNumber 함수는 아직 admin-dispatch.js(추후 admin-dispatch-core.js)에 있으므로 해당 위치에서 가져옵니다.
import { formatNumber } from "./admin-dispatch-core.js";

// ==========================================
// 1. 주문서 통합관리 출력 모달 열기 & 데이터 세팅
// ==========================================
export function exportToInvoiceModal() {
    const checkboxes = document.querySelectorAll('.row-checkbox:checked');
    if (checkboxes.length === 0) { 
        alert("주문서로 출력할 주문건을 리스트 체크박스에서 1개 이상 선택해주세요."); 
        return; 
    }
    
    state.printReadyList = [];
    checkboxes.forEach(cb => { 
        const idx = parseInt(cb.getAttribute('data-idx')); 
        if (state.parsedExcelList[idx]) state.printReadyList.push(state.parsedExcelList[idx]); 
    });

    if (window.closeAutoDispatchModal) window.closeAutoDispatchModal(); 
    document.getElementById('pro-invoice-modal')?.classList.remove('hidden');
    document.getElementById('print-ready-count').innerText = state.printReadyList.length;
    
    loadSavedForms(); 
    previewInvoiceRow(0); 
    syncPreviewData();
}

// ==========================================
// 2. 주문서 1건 미리보기 화면 동기화
// ==========================================
export function previewInvoiceRow(idx) {
    if (!state.printReadyList || !state.printReadyList[idx]) return;
    const item = state.printReadyList[idx];

    document.querySelectorAll('.prev-cust-regno').forEach(el => el.innerText = item.bizNo || '');
    document.querySelectorAll('.prev-cust-name').forEach(el => el.innerText = item.senderName || ''); 
    document.querySelectorAll('.prev-cust-store').forEach(el => el.innerText = item.storeName || '');
    document.querySelectorAll('.prev-cust-tel').forEach(el => el.innerText = item.phone || '');
    document.querySelectorAll('.prev-cust-addr').forEach(el => el.innerText = item.address || '');

    document.querySelectorAll('.prev-item-name').forEach(el => el.innerText = item.itemName || '');
    document.querySelectorAll('.prev-item-unit').forEach(el => el.innerText = item.unit || '');
    document.querySelectorAll('.prev-item-qty').forEach(el => el.innerText = formatNumber(item.qty) || '');
    document.querySelectorAll('.prev-item-price').forEach(el => el.innerText = formatNumber(item.price) || '');
    document.querySelectorAll('.prev-item-total').forEach(el => el.innerText = formatNumber(item.total) || '');
    
    let payMethod = ''; 
    if (item.memo && item.memo.includes('네이버페이')) payMethod = '네이버페이'; 
    else if (item.memo && item.memo.includes('카드')) payMethod = '카드결제';
    
    document.querySelectorAll('.prev-pay-method').forEach(el => el.innerText = payMethod);
    document.querySelectorAll('.prev-total-qty').forEach(el => el.innerText = (item.qty ? formatNumber(item.qty) + '개' : ''));
    document.querySelectorAll('.prev-cust-memo').forEach(el => el.innerText = item.memo || '');
    document.querySelectorAll('.prev-shipping-fee').forEach(el => el.innerText = '0원');
    document.querySelectorAll('.prev-item-total-amt').forEach(el => el.innerText = (item.total ? formatNumber(item.total) + '원' : ''));
    document.querySelectorAll('.prev-total-order-amt').forEach(el => el.innerText = (item.total ? formatNumber(item.total) + '원' : ''));
    document.querySelectorAll('span.font-normal.inline-block').forEach(span => { 
        if (span.classList.contains('w-32')) span.innerText = item.orderNo || ''; 
    });

    syncPreviewData(); 
}

// ==========================================
// 3. 인쇄용 HTML 생성 및 일괄 인쇄 (Iframe)
// ==========================================
function generateInvoiceHTML(item, providerInfo) {
    const originalTemplate = document.getElementById('print-area'); if (!originalTemplate) return '';
    const template = originalTemplate.cloneNode(true); template.id = ''; 

    template.querySelectorAll('.prev-prov-regno').forEach(el => el.innerText = providerInfo.regno);
    template.querySelectorAll('.prev-prov-name').forEach(el => el.innerText = providerInfo.name);
    template.querySelectorAll('.prev-prov-addr').forEach(el => el.innerText = providerInfo.addr);
    template.querySelectorAll('.prev-prov-tel').forEach(el => el.innerText = providerInfo.tel);
    template.querySelectorAll('.prev-prov-add-tel').forEach(el => el.innerText = providerInfo.addTel);

    template.querySelectorAll('.prev-cust-regno').forEach(el => el.innerText = item.bizNo || '');
    template.querySelectorAll('.prev-cust-name').forEach(el => el.innerText = item.senderName || '');
    template.querySelectorAll('.prev-cust-store').forEach(el => el.innerText = item.storeName || '');
    template.querySelectorAll('.prev-cust-tel').forEach(el => el.innerText = item.phone || '');
    template.querySelectorAll('.prev-cust-addr').forEach(el => el.innerText = item.address || '');

    template.querySelectorAll('.prev-item-name').forEach(el => el.innerText = item.itemName || '');
    template.querySelectorAll('.prev-item-unit').forEach(el => el.innerText = item.unit || '');
    template.querySelectorAll('.prev-item-qty').forEach(el => el.innerText = formatNumber(item.qty) || '');
    template.querySelectorAll('.prev-item-price').forEach(el => el.innerText = formatNumber(item.price) || '');
    template.querySelectorAll('.prev-item-total').forEach(el => el.innerText = formatNumber(item.total) || '');

    let payMethod = ''; 
    if (item.memo && item.memo.includes('네이버페이')) payMethod = '네이버페이'; 
    else if (item.memo && item.memo.includes('카드')) payMethod = '카드결제';
    
    template.querySelectorAll('.prev-pay-method').forEach(el => el.innerText = payMethod);
    template.querySelectorAll('.prev-total-qty').forEach(el => el.innerText = (item.qty ? formatNumber(item.qty) + '개' : ''));
    template.querySelectorAll('.prev-cust-memo').forEach(el => el.innerText = item.memo || '');
    template.querySelectorAll('.prev-shipping-fee').forEach(el => el.innerText = '0원');
    template.querySelectorAll('.prev-item-total-amt').forEach(el => el.innerText = (item.total ? formatNumber(item.total) + '원' : ''));
    template.querySelectorAll('.prev-total-order-amt').forEach(el => el.innerText = (item.total ? formatNumber(item.total) + '원' : ''));

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
    const dateSpan1 = template.querySelector('#prev-date-1'); if (dateSpan1) { dateSpan1.id = ''; dateSpan1.innerText = dateStr; }
    const dateSpan2 = template.querySelector('#prev-date-2'); if (dateSpan2) { dateSpan2.id = ''; dateSpan2.innerText = dateStr; }
    template.querySelectorAll('span.font-normal.inline-block').forEach(span => { 
        if (span.classList.contains('w-32')) span.innerText = item.orderNo || ''; 
    });

    return template.outerHTML;
}

export function executeBatchPrint() {
    if (state.printReadyList.length === 0) { alert("출력할 주문건이 없습니다."); return; }
    const btn = document.getElementById('btn-batch-print');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 문서 생성 중...'; }

    const providerInfo = {
        title: document.getElementById('input-form-title')?.value || '', 
        regno: document.getElementById('input-prov-regno')?.value || '',
        name: document.getElementById('input-prov-name')?.value || '', 
        addr: document.getElementById('input-prov-addr')?.value || '',
        tel: document.getElementById('input-prov-tel')?.value || '', 
        addTel: document.getElementById('input-prov-add-tel')?.value || ''
    };

    let printContents = ''; 
    state.printReadyList.forEach(item => { printContents += generateInvoiceHTML(item, providerInfo); });

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;z-index:-1;'; 
    document.body.appendChild(iframe);
    
    const doc = iframe.contentWindow.document; doc.open();
    doc.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>배송 경로 PRO - 주문서 출력</title><style>
        * { box-sizing: border-box; } @media print { @page { size: A4 portrait; margin: 0; } body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: white; } .invoice-container { box-shadow: none !important; border: none !important; margin: 0 !important; page-break-after: always; width: 210mm; height: 297mm; } .invoice-half { height: 148mm; page-break-inside: avoid; } }
        body { background: white; margin: 0; padding: 0; font-family: 'Malgun Gothic', sans-serif; } .invoice-container { width: 210mm; height: 297mm; margin: 0 auto; display: flex; flex-direction: column; } .invoice-half { height: 148mm; background-color: #ffeb5c !important; padding: 5mm 8mm; display: flex; flex-direction: column; -webkit-print-color-adjust: exact; print-color-adjust: exact; } .invoice-cut-line { border-top: 1px dashed #6b7280; width: 100%; margin: 0; } .invoice-title { text-align: center; font-size: 21px; font-weight: 900; letter-spacing: 6px; text-decoration: underline; margin-bottom: 5px; } .invoice-table { width: 100%; border-collapse: collapse; border: 2px solid #000; font-size: 10px; margin-bottom: 4px; table-layout: fixed; } .invoice-table th, .invoice-table td { border: 1px solid #000; padding: 2px 5px; height: 27px; vertical-align: middle; overflow: hidden; word-break: break-all; } .double-height { height: 54px !important; } .double-height td { height: 54px !important; } .multi-line-text { white-space: normal !important; line-height: 1.3; } .invoice-table th { font-weight: bold; text-align: center; } .invoice-label { font-weight: bold; text-align: center; white-space: nowrap; } .writing-mode-vertical { writing-mode: vertical-rl; text-orientation: upright; text-align: center; letter-spacing: 3px; } .text-fit-auto { font-size: 9.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .inv-text-center { text-align: center; } .inv-text-left { text-align: left; padding-left: 6px !important; } .inv-text-right { text-align: right; padding-right: 6px !important; } .inv-font-bold { font-weight: bold; }
    </style></head><body>${printContents}</body></html>`);
    doc.close();

    iframe.onload = function() {
        setTimeout(() => {
            iframe.contentWindow.focus(); iframe.contentWindow.print();
            setTimeout(() => { 
                document.body.removeChild(iframe); 
                if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-print text-sm"></i> 주문서 일괄 출력`; } 
            }, 1000);
        }, 800); 
    };
}

// ==========================================
// 4. 입력 폼 동기화 및 템플릿(공급자 정보) 관리
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
    let savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    if (savedForms.length === 0) { 
        listEl.innerHTML = `<div class="text-center text-gray-400 py-10 text-[10px] font-bold">저장된 폼이 없습니다.<br>아래에서 새 폼을 작성하고 저장하세요.</div>`; 
        return; 
    }
    
    let html = '';
    savedForms.forEach((form, idx) => {
        const isSelected = (state.currentSelectedFormIndex === idx);
        html += `
        <div class="border ${isSelected ? 'border-indigo-600 bg-indigo-50/70 ring-1 ring-indigo-400' : 'border-gray-200 bg-white hover:border-indigo-300'} rounded-xl p-2.5 shadow-xs transition flex items-center justify-between group">
            <div class="flex items-center gap-3 overflow-hidden flex-1 pl-1">
                <input type="checkbox" onchange="window.toggleSelectForm(${idx})" ${isSelected ? 'checked' : ''} class="w-4 h-4 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500 cursor-pointer shrink-0">
                <div class="min-w-0 cursor-pointer flex-1" onclick="window.previewSavedForm(${idx})">
                    <p class="text-[11px] font-black ${isSelected ? 'text-indigo-800' : 'text-gray-800'} truncate leading-tight hover:text-indigo-600 transition">${form.title}</p>
                    <p class="text-[9px] text-gray-400 truncate mt-0.5">${form.name}</p>
                </div>
            </div>
            <button type="button" onclick="window.deleteSavedForm(${idx})" class="text-gray-300 hover:text-red-500 px-1.5 py-1 transition shrink-0"><i class="fa-solid fa-trash-can text-[10px]"></i></button>
        </div>`;
    });
    listEl.innerHTML = html;
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
    let savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    const form = savedForms[idx]; if (!form) return;
    state.currentSelectedFormIndex = idx;

    document.getElementById('input-form-title').value = form.title || '';
    document.getElementById('input-prov-regno').value = form.regno || '';
    document.getElementById('input-prov-name').value = form.name || '';
    document.getElementById('input-prov-addr').value = form.addr || '';
    document.getElementById('input-prov-tel').value = form.tel || '';
    document.getElementById('input-prov-add-tel').value = form.addTel || '';

    loadSavedForms(); 
    syncPreviewData();
}

export function selectFormTemplate(type) {
    document.getElementById('form-template-modal')?.classList.add('hidden');
    const accordion = document.getElementById('form-setup-accordion');
    if (accordion && accordion.classList.contains('hidden')) { 
        accordion.classList.remove('hidden'); 
        accordion.classList.add('flex'); 
    }
    setTimeout(() => { document.getElementById('input-form-title')?.focus(); }, 300);
}

export function saveProviderForm() {
    const title = document.getElementById('input-form-title')?.value.trim();
    if (!title) { alert("저장할 폼의 '제목'을 입력해주세요."); return; }
    
    const newForm = {
        title, 
        regno: document.getElementById('input-prov-regno')?.value.trim(),
        name: document.getElementById('input-prov-name')?.value.trim(),
        addr: document.getElementById('input-prov-addr')?.value.trim(),
        tel: document.getElementById('input-prov-tel')?.value.trim(),
        addTel: document.getElementById('input-prov-add-tel')?.value.trim(),
        savedAt: Date.now()
    };
    
    let savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    const existingIdx = savedForms.findIndex(f => f.title === title);
    
    if(existingIdx >= 0) {
        if(confirm(`'${title}'(으)로 이미 저장된 폼이 있습니다. 덮어쓰시겠습니까?`)) {
            savedForms[existingIdx] = newForm;
        } else return;
    } else { 
        savedForms.push(newForm); 
    }
    
    localStorage.setItem('deliveryPro_savedForms', JSON.stringify(savedForms));
    alert(`[${title}] 폼이 성공적으로 저장되었습니다.`);
    loadSavedForms();
}

export function deleteSavedForm(idx) {
    let savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');
    if(!confirm(`[${savedForms[idx].title}] 폼을 삭제하시겠습니까?`)) return;
    
    savedForms.splice(idx, 1);
    localStorage.setItem('deliveryPro_savedForms', JSON.stringify(savedForms));
    
    if (state.currentSelectedFormIndex === idx) state.currentSelectedFormIndex = null;
    loadSavedForms();
}

export function cancelProviderFormEdit() {
    state.currentSelectedFormIndex = null;
    ['input-form-title', 'input-prov-regno', 'input-prov-name', 'input-prov-addr', 'input-prov-tel', 'input-prov-add-tel'].forEach(id => {
        if(document.getElementById(id)) document.getElementById(id).value = '';
    });
    
    const accordion = document.getElementById('form-setup-accordion');
    if (accordion) { accordion.classList.add('hidden'); accordion.classList.remove('flex'); }
    
    loadSavedForms(); 
    syncPreviewData();
}

export function switchInvoiceTab() {}