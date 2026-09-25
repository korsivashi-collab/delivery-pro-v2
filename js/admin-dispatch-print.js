// js/admin-dispatch-print.js

import { state, getLocalDateString } from "./admin-state.js";
import { formatNumber } from "./admin-dispatch-core.js";

let invoiceSearchKeyword = '';
let currentSenderFilter = 'ALL';
let currentTemplateCanvasData = null;

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

    const searchInput = document.getElementById('invoice-search-input');
    if (searchInput) searchInput.value = '';

    populateSenderFilterDropdown();
    initTemplatePdfDropZone();
    loadSavedForms(); 
    renderInvoiceOrderList();
    previewInvoiceRow(0); 
}

export function populateSenderFilterDropdown() {
    const selectEl = document.getElementById('invoice-sender-filter');
    if (!selectEl || !state.printReadyList) return;

    const senders = new Set();
    state.printReadyList.forEach(item => {
        const s = (item.senderName || '').trim();
        if (s) senders.add(s);
    });

    let html = `<option value="ALL">전체 발송회사 (모아보기 - 총 ${state.printReadyList.length}건)</option>`;
    senders.forEach(sName => {
        const count = state.printReadyList.filter(it => (it.senderName || '').trim() === sName).length;
        html += `<option value="${sName}" ${currentSenderFilter === sName ? 'selected' : ''}>${sName} (${count}건)</option>`;
    });

    selectEl.innerHTML = html;
}

export function filterBySender(senderName) {
    currentSenderFilter = senderName;
    renderInvoiceOrderList();
}

// ==========================================
// 2. 좌측 인쇄 대상 리스트 (발송회사별 분류 및 간소화 표시)
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

    return list;
}

export function filterInvoicePrintList(query) {
    invoiceSearchKeyword = (query || '').trim().toLowerCase();
    renderInvoiceOrderList();
}

export function updateInvoiceCountBadge() {
    const badge = document.getElementById('invoice-target-count-badge');
    if (!badge || !state.printReadyList) return;
    const filtered = getFilteredPrintOrders();
    const total = filtered.length;
    const selected = filtered.filter(it => it._selected !== false).length;
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

        const senderDisplay = item.senderName || '발송회사 미지정';
        const storeDisplay = item.storeName || '받는분 미지정';
        const driverBadge = item.assignedDriver 
            ? `<span class="bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-black px-1.5 py-0.5 rounded shrink-0"><i class="fa-solid fa-truck text-[9px] mr-1"></i>${item.assignedDriver}</span>`
            : `<span class="bg-gray-100 text-gray-400 text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0">기사 미배정</span>`;

        html += `
        <div onclick="window.previewInvoiceRow(${originalIdx})" class="p-3 rounded-2xl border ${isCurrent ? 'bg-indigo-50/80 border-indigo-500 ring-2 ring-indigo-300' : 'bg-white border-gray-200 hover:border-indigo-300'} transition cursor-pointer shadow-xs flex items-start gap-2.5 select-none">
            <div class="pt-1" onclick="event.stopPropagation()">
                <input type="checkbox" onchange="window.toggleSingleInvoiceItem('${item.id}', this.checked)" ${isChecked ? 'checked' : ''} class="w-4 h-4 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500 cursor-pointer">
            </div>
            <div class="flex-1 min-w-0 space-y-1">
                <div class="flex items-center justify-between gap-1 flex-wrap">
                    <span class="text-[10px] font-mono font-black text-gray-400">#${originalIdx + 1}</span>
                    ${driverBadge}
                </div>
                <div class="flex items-center gap-1.5 text-xs truncate">
                    <span class="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-black px-1.5 py-0.5 rounded shrink-0">발송</span>
                    <span class="font-black text-gray-900 truncate" title="${senderDisplay}">${senderDisplay}</span>
                </div>
                <div class="flex items-center gap-1.5 text-xs truncate">
                    <span class="bg-indigo-100 text-indigo-900 border border-indigo-300 text-[10px] font-black px-1.5 py-0.5 rounded shrink-0">받는분</span>
                    <span class="font-bold text-gray-800 truncate" title="${storeDisplay}">${storeDisplay}</span>
                </div>
                <div class="text-[11px] font-medium text-gray-500 truncate pt-0.5 border-t border-gray-100" title="${item.address || ''}">
                    <i class="fa-solid fa-location-dot text-red-500 text-[10px] mr-1"></i>${item.address || '주소 정보 없음'}
                </div>
            </div>
        </div>`;
    });

    listEl.innerHTML = html;
}

// ==========================================
// 3. 주문 1건 미리보기 연동
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

    renderInvoiceOrderList();
}

// ==========================================
// 4. PDF 양식 캔버스 렌더링 및 저장 로직
// ==========================================
async function renderPdfDocumentToCanvas(pdfDoc) {
    const canvas = document.getElementById('pdf-template-canvas');
    const printArea = document.getElementById('print-area');
    const placeholder = document.getElementById('preview-placeholder');
    if (!canvas || !printArea) return;

    try {
        const page = await pdfDoc.getPage(1);
        const viewport = page.getViewport({ scale: 1.5 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext('2d');

        await page.render({ canvasContext: context, viewport }).promise;

        currentTemplateCanvasData = canvas.toDataURL('image/jpeg', 0.85);

        if (placeholder) placeholder.classList.add('hidden');
        printArea.classList.remove('hidden');
    } catch (e) {
        console.error("PDF 캔버스 렌더링 실패:", e);
        alert("PDF 양식을 화면에 렌더링하는 중 오류가 발생했습니다: " + e.message);
    }
}

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
        alert("PDF 라이브러리가 로드되지 않았습니다. 새로고침 후 다시 시도해 주세요.");
        return;
    }

    try {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
        const pdf = await loadingTask.promise;

        await renderPdfDocumentToCanvas(pdf);

        const page1 = await pdf.getPage(1);
        const textContent = await page1.getTextContent();
        const pageText = textContent.items.map(it => it.str.trim()).filter(Boolean).join(' ');

        let detectedTitle = file.name.replace(/\.[^/.]+$/, '').trim();
        let detectedRegno = '';
        let detectedName = '';
        let detectedAddr = '';
        let detectedTel = '';
        let detectedAddTel = '';

        const bizMatch = pageText.match(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/);
        if (bizMatch) detectedRegno = bizMatch[0].replace(/\s+/g, '-');

        const telMatch = pageText.match(/(?:0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4})/g);
        if (telMatch && telMatch.length > 0) {
            detectedTel = telMatch[0];
            if (telMatch.length > 1) detectedAddTel = telMatch[1];
        }

        const addrMatch = pageText.match(/(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\n\r]*?(?:로|길|동|읍|면|가)\s*[\d\-]+/);
        if (addrMatch) detectedAddr = addrMatch[0].trim();

        const storeMatch = pageText.match(/(?:상호|법인명|상호명|공급자)\s*[:|]?\s*([가-힣A-Za-z0-9\(\)\s]{2,20})/);
        if (storeMatch) detectedName = storeMatch[1].trim();

        const titleInput = document.getElementById('input-form-title');
        const regnoInput = document.getElementById('input-prov-regno');
        const nameInput = document.getElementById('input-prov-name');
        const addrInput = document.getElementById('input-prov-addr');
        const telInput = document.getElementById('input-prov-tel');
        const addTelInput = document.getElementById('input-prov-add-tel');

        if (titleInput) titleInput.value = detectedTitle || '새 주문서 양식';
        if (regnoInput) regnoInput.value = detectedRegno;
        if (nameInput) nameInput.value = detectedName;
        if (addrInput) addrInput.value = detectedAddr;
        if (telInput) telInput.value = detectedTel;
        if (addTelInput) addTelInput.value = detectedAddTel;

        const accordion = document.getElementById('form-setup-accordion');
        if (accordion && accordion.classList.contains('hidden')) {
            accordion.classList.remove('hidden');
            accordion.classList.add('flex');
        }

        alert(`[PDF 양식 인식 완료]\n\n업로드된 PDF 파일의 첫 페이지를 주문서 문서 양식으로 중앙에 로드했습니다.\n우측 [폼 저장]을 누르면 이 양식이 저장 목록에 등록됩니다.`);
    } catch (e) {
        console.error("PDF 파싱 오류:", e);
        alert("PDF 파일 양식 분석 중 오류가 발생했습니다: " + e.message);
    }
}

// ==========================================
// 5. 저장된 양식 목록 관리
// ==========================================
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
    } else { 
        applySavedForm(idx); 
    }
}

export function previewSavedForm(idx) { 
    applySavedForm(idx); 
}

export async function applySavedForm(idx) {
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

    if (form.canvasData) {
        currentTemplateCanvasData = form.canvasData;
        const canvas = document.getElementById('pdf-template-canvas');
        const printArea = document.getElementById('print-area');
        const placeholder = document.getElementById('preview-placeholder');
        if (canvas && printArea) {
            const img = new Image();
            img.onload = () => {
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                if (placeholder) placeholder.classList.add('hidden');
                printArea.classList.remove('hidden');
            };
            img.src = form.canvasData;
        }
    }

    loadSavedForms(); 
}

export function saveProviderForm() {
    const titleInput = document.getElementById('input-form-title');
    const title = titleInput ? titleInput.value.trim() : '';
    if (!title) { alert("저장할 폼의 '제목'을 입력해주세요."); return; }
    
    if (!currentTemplateCanvasData) {
        alert("등록된 PDF 문서 양식이 없습니다. 우측에서 먼저 PDF 양식을 업로드해 주세요.");
        return;
    }

    const newForm = {
        title, 
        regno: document.getElementById('input-prov-regno')?.value.trim() || '',
        name: document.getElementById('input-prov-name')?.value.trim() || '',
        addr: document.getElementById('input-prov-addr')?.value.trim() || '',
        tel: document.getElementById('input-prov-tel')?.value.trim() || '',
        addTel: document.getElementById('input-prov-add-tel')?.value.trim() || '',
        canvasData: currentTemplateCanvasData,
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
    alert(`[${title}] 양식 폼이 성공적으로 저장 목록에 기록되었습니다.`);
    loadSavedForms();
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
    currentTemplateCanvasData = null;

    ['input-form-title', 'input-prov-regno', 'input-prov-name', 'input-prov-addr', 'input-prov-tel', 'input-prov-add-tel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    
    const printArea = document.getElementById('print-area');
    const placeholder = document.getElementById('preview-placeholder');
    if (printArea) printArea.classList.add('hidden');
    if (placeholder) placeholder.classList.remove('hidden');

    loadSavedForms(); 
}

export function updateLivePreview() {}
export function syncPreviewData() {}

// ==========================================
// 6. 주문서 일괄 출력 (PDF 양식 기반 + 상단 마킹 바)
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

    if (!currentTemplateCanvasData) {
        alert("등록된 주문서 문서 양식이 없습니다.\n우측에서 PDF 양식을 업로드하거나 저장된 양식을 먼저 선택해 주세요.");
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
        const driverName = item.assignedDriver ? item.assignedDriver : '미배정';
        printPagesHtml += `
        <div class="print-page-wrapper">
            <div class="driver-marking-bar">
                <span>[배송순번 #${idx + 1}]</span>
                <span><b>담당기사:</b> ${driverName}</span>
                <span><b>받는분:</b> ${item.storeName || '-'}</span>
                <span><b>주소:</b> ${item.address || ''}</span>
            </div>
            <img src="${currentTemplateCanvasData}" class="pdf-template-img" alt="주문서 양식">
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
            @page { size: A4 portrait; margin: 0; } 
            body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: white; } 
            .print-page-wrapper { page-break-after: always; width: 210mm; height: 297mm; padding: 10mm; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; }
            .print-page-wrapper:last-child { page-break-after: auto; }
        }
        body { margin: 0; padding: 0; font-family: 'Malgun Gothic', sans-serif; background: white; }
        .print-page-wrapper { width: 210mm; height: 297mm; margin: 0 auto; padding: 10mm; display: flex; flex-direction: column; align-items: center; }
        .driver-marking-bar { width: 100%; display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 900; background: #f8fafc; border: 1.5px solid #000; padding: 6px 12px; margin-bottom: 8px; border-radius: 4px; }
        .pdf-template-img { width: 100%; max-height: 260mm; object-fit: contain; }
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
// 7. 피킹 리스트 (선택된 기사별 각각 분리 출력)
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

export function executePickingListPrint() {
    if (pickingModalState.selectedDrivers.size === 0) {
        alert("출력할 기사를 1명 이상 선택해 주세요.");
        return;
    }

    const selectedDriverList = Array.from(pickingModalState.selectedDrivers);
    const dateStr = getLocalDateString();
    let allDriversPagesHtml = '';
    let validPageCount = 0;

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
        const totalItemTypes = aggregatedList.length;
        const totalItemQtySum = aggregatedList.reduce((sum, item) => sum + item.totalQty, 0);

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

        validPageCount++;
        allDriversPagesHtml += `
        <div class="print-page">
            <div class="header-title">창고 상차 피킹 리스트</div>
            <div class="meta-info">
                <span>출력일자: ${dateStr}</span>
                <span style="font-size: 14px; color: #1e40af;">담당 기사: <b>${driverName}</b></span>
            </div>
            <div class="summary-box">
                <span>배송처: <b>${driverOrders.length}</b>곳</span>
                <span>품목 종류: <b>${totalItemTypes}</b>종</span>
                <span>총 수량: <b>${formatNumber(totalItemQtySum)}</b>개</span>
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
                <span>상차 기사(${driverName}): <span class="sign-box">(서명)</span></span>
                <span>출고 검수자: <span class="sign-box">(서명)</span></span>
            </div>
        </div>`;
    });

    if (validPageCount === 0) {
        alert("선택된 기사들에게 배정된 배송 상품이 없습니다.");
        return;
    }

    const pickingHtml = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>배송 동선 PRO - 기사별 피킹 리스트</title><style>
        * { box-sizing: border-box; }
        @media print {
            @page { size: A4 portrait; margin: 10mm; }
            body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: white; }
            .print-page { 
                box-shadow: none !important; 
                border: none !important; 
                width: 100% !important; 
                height: auto !important; 
                page-break-after: always; 
                padding: 0;
                margin: 0 0 20mm 0;
            }
            .print-page:last-child {
                page-break-after: auto;
            }
        }
        body { font-family: 'Malgun Gothic', 'Dotum', sans-serif; background: white; margin: 0; padding: 0; color: #1e293b; }
        .print-page { width: 190mm; margin: 0 auto; padding: 5mm; page-break-after: always; }
        .print-page:last-child { page-break-after: auto; }
        .header-title { text-align: center; font-size: 22px; font-weight: 900; letter-spacing: 2px; margin-bottom: 4px; border-bottom: 3px double #000; padding-bottom: 6px; }
        .meta-info { display: flex; justify-content: space-between; align-items: flex-end; font-size: 11px; font-weight: bold; margin-bottom: 10px; color: #334155; }
        .summary-box { background-color: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 8px 12px; display: flex; justify-content: space-around; font-size: 11px; font-weight: 900; margin-bottom: 12px; }
        .summary-box span b { color: #2563eb; font-size: 13px; margin-left: 4px; }
        table { width: 100%; border-collapse: collapse; border: 2px solid #000; font-size: 10.5px; }
        th { background-color: #f1f5f9; border: 1px solid #000; padding: 6px 4px; font-weight: 900; text-align: center; }
        td { border: 1px solid #000; }
        .footer-sign { display: flex; justify-content: flex-end; gap: 30px; margin-top: 18px; font-size: 11px; font-weight: bold; }
        .sign-box { border-bottom: 1px solid #000; width: 90px; display: inline-block; text-align: center; }
    </style></head><body>${allDriversPagesHtml}</body></html>`;

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
                closePickingDriverModal();
            }, 1000);
        }, 600);
    };
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
window.filterBySender = filterBySender;
window.openPickingDriverModal = openPickingDriverModal;
window.closePickingDriverModal = closePickingDriverModal;
window.toggleAllPickingDrivers = toggleAllPickingDrivers;
window.togglePickingDriver = togglePickingDriver;
window.executePickingListPrint = executePickingListPrint;
window.printAggregatedItemList = openPickingDriverModal;