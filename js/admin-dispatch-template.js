// js/admin-dispatch-template.js

import { state, getLocalDateString } from "./admin-state.js";
import { formatNumber } from "./admin-dispatch-core.js";
import { auth } from "./admin-api.js";

const escapeTemplateText = value => String(value ?? '').replace(/[&<>"']/g,
    char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// 현재 편집 중인 서식 상태
export const templateBuilderState = {
    activeTemplateId: null,
    activeTemplateTitle: '',
    currentDocHtml: '',
    detectedColumns: ['No.', '상품명', '규격(단위)', '제조사(원산지)', '수량', '단가', '공급가액', '세액', '총액']
};

// 기본 식봄형 서식은 기존 빌더를 사용하며 회사/고객 실데이터를 포함하지 않는다.
export function ensureBuiltInForm() {
    let forms;
    try { forms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]'); }
    catch { throw new Error('저장된 양식을 읽을 수 없습니다. 기존 데이터를 보존합니다.'); }
    if (!Array.isArray(forms)) throw new Error('저장된 양식 데이터 형식을 확인해 주세요.');
    if (!forms.some(f => f.id === 'BUILTIN-SIKBOM-V1')) {
        forms.push({ id: 'BUILTIN-SIKBOM-V1', title: '식봄형 기본 거래명세표', builtIn: true,
            isDefault: forms.length === 0, templateHtml: buildCleanTemplatedHtml({
                docTitle:'거래명세표', isTwoPart:true, provName:'{{공급자}}',
                columns:['No.', '상품명', '규격(단위)', '제조사(원산지)', '수량', '단가', '공급가액', '세액', '총액']
            }) });
        localStorage.setItem('deliveryPro_savedForms',JSON.stringify(forms));
    }
    return forms;
}

// ==========================================
// 0. [핵심] 컬럼 감지 기반 동적 비율 계산 엔진 (오직 상품 테이블 전용)
// ==========================================
export function buildDynamicColgroup(cols) {
    const fixedWidths = {
        'No.': 3.5,
        '규격(단위)': 7.5,
        '제조사(원산지)': 7.0,
        '수량': 5.5,
        '단가': 8.5,
        '공급가액': 9.0,
        '세액': 5.5,
        '총액': 10.5
    };

    let nonProductTotalWidth = 0;
    const columnWidthMap = {};

    cols.forEach(col => {
        if (col === '상품명' || /^(상품|상품명|품목|품목명|품명|제품명)$/i.test(col)) return;

        let w = 8.0;
        if (fixedWidths[col] !== undefined) {
            w = fixedWidths[col];
        } else if (/규격|단위/i.test(col)) {
            w = 7.5;
        } else if (/제조사|원산지/i.test(col)) {
            w = 7.0;
        } else if (/수량/i.test(col)) {
            w = 5.5;
        } else if (/단가/i.test(col)) {
            w = 8.5;
        } else if (/공급가/i.test(col)) {
            w = 9.0;
        } else if (/세액|부가세/i.test(col)) {
            w = 5.5;
        } else if (/총액|합계/i.test(col)) {
            w = 10.5;
        } else if (/No|순번/i.test(col)) {
            w = 3.5;
        }

        columnWidthMap[col] = w;
        nonProductTotalWidth += w;
    });

    // 100%에서 나머지 컬럼을 뺀 잔여폭을 상품명에 전부 할당
    let productWidth = Math.max(25.0, 100.0 - nonProductTotalWidth);
    columnWidthMap['상품명'] = productWidth;

    const totalCalculated = nonProductTotalWidth + productWidth;
    const colsHtml = cols.map(col => {
        const key = (col === '상품명' || /^(상품|상품명|품목|품목명|품명|제품명)$/i.test(col)) ? '상품명' : col;
        const targetW = columnWidthMap[key] !== undefined ? columnWidthMap[key] : (columnWidthMap[col] || 8.0);
        const actualPercent = ((targetW / totalCalculated) * 100).toFixed(1);
        return `<col style="width: ${actualPercent}%;">`;
    }).join('');

    return `<colgroup>${colsHtml}</colgroup>`;
}

// ==========================================
// 1. 기본 명세서 문서 양식
// ==========================================
function buildCleanTemplatedHtml(cfg) {
    if (cfg.isTwoPart) {
        return `
        <div class="doc-sheet invoice-two-half" style="width: 210mm; height: 297mm; max-height: 297mm; display: flex; flex-direction: column; box-sizing: border-box; margin: 0 auto; background: #fff; position: relative;" contenteditable="false">
            ${generateSingleInvoiceBlock(cfg, '공급자 보관용')}
            <div class="invoice-cut-line" style="border-top: 1.5px dashed #4b5563; width: 100%; margin: 0; box-sizing: border-box; flex-shrink: 0; height: 0;"></div>
            ${generateSingleInvoiceBlock(cfg, '공급받는자용')}
        </div>`;
    } else {
        return `
        <div class="doc-sheet invoice-full-page" style="width: 210mm; min-height: 297mm; box-sizing: border-box; margin: 0 auto; background: #fff;" contenteditable="false">
            ${generateSingleInvoiceBlock(cfg, '공급자 보관용')}
        </div>`;
    }
}

function generateSingleInvoiceBlock(cfg, partName) {
    const title = cfg.docTitle || '거래명세표';
    const cols = cfg.columns || ['No.', '상품명', '규격(단위)', '제조사(원산지)', '수량', '단가', '공급가액', '세액', '총액'];

    const thsHtml = cols.map(c => `<th contenteditable="true" style="border: 1px solid #000; padding: 2.5px 3px; background: #f8fafc; text-align: center; font-weight: bold; font-size: 9.5px;">${c}</th>`).join('');

    // 오직 상품 테이블용 colgroup
    const colgroupHtml = buildDynamicColgroup(cols);

    // 샘플 행 동적 생성
    let sampleTds = '';
    cols.forEach(col => {
        if (col === 'No.' || /No|순번/i.test(col)) {
            sampleTds += `<td style="border: 1px solid #000; text-align: center; padding: 2px;">1</td>`;
        } else if (col === '상품명' || /^(상품|상품명|품목|품목명|품명|제품명)$/i.test(col)) {
            sampleTds += `<td style="border: 1px solid #000; font-weight: bold; padding: 2px 4px; word-break: break-all; white-space: normal; line-height: 1.2; text-align: left;" contenteditable="true">{{상품명}}</td>`;
        } else if (/규격|단위/i.test(col)) {
            sampleTds += `<td style="border: 1px solid #000; text-align: center; padding: 2px;" contenteditable="true">{{단위}}</td>`;
        } else if (/제조사|원산지/i.test(col)) {
            sampleTds += `<td style="border: 1px solid #000; text-align: center; padding: 2px;" contenteditable="true">-</td>`;
        } else if (/수량/i.test(col)) {
            sampleTds += `<td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2px;" contenteditable="true">{{수량}}</td>`;
        } else if (/단가/i.test(col)) {
            sampleTds += `<td style="border: 1px solid #000; text-align: right; padding: 2px 4px;" contenteditable="true">{{단가}}</td>`;
        } else if (/공급가/i.test(col)) {
            sampleTds += `<td style="border: 1px solid #000; text-align: right; padding: 2px 4px;" contenteditable="true">{{공급가액}}</td>`;
        } else if (/세액|부가세/i.test(col)) {
            sampleTds += `<td style="border: 1px solid #000; text-align: right; padding: 2px 4px;" contenteditable="true">{{세액}}</td>`;
        } else if (/총액|합계/i.test(col)) {
            sampleTds += `<td style="border: 1px solid #000; text-align: right; font-weight: bold; padding: 2px 4px;" contenteditable="true">{{총액}}</td>`;
        } else {
            sampleTds += `<td style="border: 1px solid #000; text-align: center; padding: 2px;" contenteditable="true">-</td>`;
        }
    });
    const trSample = `<tr class="item-row" style="min-height: 18px;">${sampleTds}</tr>`;

    // 빈 행 동적 생성
    const emptyRows = [2, 3, 4, 5].map(num => {
        let emptyTds = '';
        cols.forEach(col => {
            if (col === 'No.' || /No|순번/i.test(col)) {
                emptyTds += `<td style="border: 1px solid #000; text-align: center; padding: 2px;">${num}</td>`;
            } else {
                emptyTds += `<td style="border: 1px solid #000; padding: 2px 4px;" contenteditable="true"></td>`;
            }
        });
        return `<tr class="item-row empty-row" style="height: 18px;">${emptyTds}</tr>`;
    }).join('');

    return `
    <div class="invoice-box-part" style="width: 100%; height: 148.5mm; max-height: 148.5mm; padding: 4mm 8mm 3mm 8mm; box-sizing: border-box; font-family: 'Malgun Gothic', Dotum, sans-serif; color: #000; background: #fff; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden;">
        <div style="position: relative; margin-bottom: 2px; flex-shrink: 0;">
            <!-- 우측 상단 여백 공간: 담당기사 표기 -->
            <div style="position: absolute; right: 0; top: 0; text-align: right;">
                <span style="font-size: 10.5px; font-weight: 900; color: #000; border: 1.5px solid #000; padding: 1.5px 7px; border-radius: 3px; background: #fafafa; display: inline-block; letter-spacing: -0.2px;">
                    담당기사: <b class="tpl-bind-driver" contenteditable="true" style="color: #000; margin-left: 2px;">{{담당기사}}</b>
                </span>
            </div>

            <!-- 중앙 타이틀 -->
            <div style="text-align: center;">
                <h2 class="doc-main-title" contenteditable="true" style="font-size: 19px; font-weight: 900; letter-spacing: 5px; text-decoration: underline; margin: 0 0 2px 0;">
                    ${title}<span style="font-size: 12px; font-weight: normal; letter-spacing: 0; text-decoration: none;">(${partName})</span>
                </h2>
            </div>

            <!-- 하단 메타 정보 -->
            <div style="display: flex; justify-content: space-between; align-items: flex-end; font-size: 9.5px; font-weight: bold; margin-top: 3px;">
                <span>주문일자: <b class="tpl-bind-date" contenteditable="true">{{주문일자}}</b></span>
                <span>배송번호: <b class="tpl-bind-orderno" contenteditable="true">{{배송번호}}</b></span>
            </div>
        </div>

        <!-- 🌟 공급자/공급받는자 전용 완벽한 6개 열 비율 고정 (절대 침범 금지) -->
        <table class="doc-table party-table" style="width: 100%; border-collapse: collapse; border: 1.5px solid #000; font-size: 9.5px; margin-bottom: 2px; table-layout: fixed; flex-shrink: 0;">
            <colgroup>
                <col style="width: 4%;">
                <col style="width: 16%;">
                <col style="width: 30%;">
                <col style="width: 4%;">
                <col style="width: 16%;">
                <col style="width: 30%;">
            </colgroup>
            <tbody>
                <tr>
                    <td rowspan="5" style="border: 1px solid #000; text-align: center; font-weight: bold; line-height: 1.2; background: #f8fafc; padding: 2px;" contenteditable="true">공<br>급<br>자</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">사업자등록번호</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true" spellcheck="false">${escapeTemplateText(cfg.provRegno || '')}</td>
                    <td rowspan="5" style="border: 1px solid #000; text-align: center; font-weight: bold; line-height: 1.2; background: #f8fafc; padding: 2px;" contenteditable="true">공<br>급<br>받<br>는<br>자</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">사업자등록번호</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px; background: #f0fdf4;" contenteditable="true">{{사업자번호}}</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">상호(법인명)</td>
                    <td style="border: 1px solid #000; padding: 2.5px 4px; font-weight: bold;" contenteditable="true" spellcheck="false">${escapeTemplateText(cfg.provName || '')}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">구 매 자 명</td>
                    <td style="border: 1px solid #000; padding: 2.5px 4px; font-weight: bold; background: #f0fdf4;" contenteditable="true">{{구매자명}}</td>
                </tr>
                <tr style="height: 31px;">
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">주 소</td>
                    <td style="border: 1px solid #000; padding: 2px 4px; font-size: 9px; line-height: 1.15;" contenteditable="true" spellcheck="false">${escapeTemplateText(cfg.provAddr || '')}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">주 소</td>
                    <td style="border: 1px solid #000; padding: 2px 4px; font-size: 9px; line-height: 1.15; background: #eff6ff;" contenteditable="true">{{배송지주소}}</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">연락처/FAX</td>
                    <td style="border: 1px solid #000; padding: 2.5px 4px;" contenteditable="true" spellcheck="false">${escapeTemplateText(cfg.provTel || '')}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">배송지명(간판명)</td>
                    <td style="border: 1px solid #000; padding: 2.5px 4px; font-weight: 900; background: #eff6ff;" contenteditable="true">{{상호명}}</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">추 가 연 락 처</td>
                    <td style="border: 1px solid #000; padding: 2.5px 4px;" contenteditable="true" spellcheck="false">${escapeTemplateText(cfg.provAddTel || '')}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">연 락 처</td>
                    <td style="border: 1px solid #000; padding: 2.5px 4px; background: #eff6ff;" contenteditable="true">{{고객연락처}}</td>
                </tr>
            </tbody>
        </table>

        <!-- 상품 테이블: 오직 이 표에만 동적 colgroup 적용 -->
        <div style="flex: 1; min-height: 0; overflow: hidden; margin-bottom: 2px;">
            <table class="doc-table item-table" style="width: 100%; border-collapse: collapse; border: 1.5px solid #000; font-size: 9.5px; table-layout: fixed;">
                ${colgroupHtml}
                <thead>
                    <tr>${thsHtml}</tr>
                </thead>
                <tbody class="tpl-items-tbody">
                    ${trSample}
                    ${emptyRows}
                </tbody>
            </table>
        </div>

        <!-- 🌟 하단 푸터 전용 완벽한 열 비율 고정 (절대 침범 금지) -->
        <table class="doc-table footer-table" style="width: 100%; border-collapse: collapse; border: 1.5px solid #000; font-size: 9.5px; table-layout: fixed; flex-shrink: 0; margin-bottom: 2px;">
            <colgroup>
                <col style="width: 15%;">
                <col style="width: 35%;">
                <col style="width: 15%;">
                <col style="width: 10%;">
                <col style="width: 12%;">
                <col style="width: 13%;">
            </colgroup>
            <tbody>
                <tr>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; background: #f8fafc; padding: 2px;" contenteditable="true">결 제 수 단</td>
                    <td style="border: 1px solid #000; padding: 2px 4px;" contenteditable="true">{{결제수단}}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; background: #f8fafc; padding: 2px;" contenteditable="true">총 상품수량</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2px;" contenteditable="true">{{총수량}}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; background: #f8fafc; padding: 2px;" contenteditable="true">배 송 비</td>
                    <td style="border: 1px solid #000; text-align: right; padding: 2px 4px;" contenteditable="true">0원</td>
                </tr>
                <tr style="height: 26px;">
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; background: #f8fafc; padding: 2px;" contenteditable="true">배송 요청사항</td>
                    <td colspan="3" style="border: 1px solid #000; padding: 2px 4px; font-size: 9px; vertical-align: top; line-height: 1.15;" contenteditable="true">{{배송요청사항}}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: 900; background: #f1f5f9; padding: 2px;" contenteditable="true">총주문금액</td>
                    <td style="border: 1px solid #000; text-align: right; font-weight: 900; color: #dc2626; padding: 2px 4px; background: #f1f5f9;" contenteditable="true">{{총금액}}</td>
                </tr>
            </tbody>
        </table>

        <div style="text-align: right; font-size: 9.5px; font-weight: bold; padding-right: 5px; flex-shrink: 0;">
            <span contenteditable="true">인수자: <span style="display: inline-block; width: 70px; border-bottom: 1px solid #000; text-align: center;">서 명</span></span>
        </div>
    </div>`;
}

// ==========================================
// 3. 에디터 렌더링 및 [양식 저장] 툴바
// ==========================================
export function renderEditableDocument(htmlContent, filledPreview = false) {
    templateBuilderState.filledPreview = filledPreview;
    const previewContainer = document.getElementById('inv-view-preview');
    const placeholder = document.getElementById('preview-placeholder');

    if (!previewContainer) return;
    if (placeholder) placeholder.classList.add('hidden');

    let editorWrapper = document.getElementById('doc-editor-wrapper');
    if (!editorWrapper) {
        editorWrapper = document.createElement('div');
        editorWrapper.id = 'doc-editor-wrapper';
        editorWrapper.className = 'w-full flex flex-col items-center gap-3';
        previewContainer.appendChild(editorWrapper);
    }

    editorWrapper.setAttribute('aria-busy','false');
    editorWrapper.innerHTML = `
        <div class="doc-editor-toolbar flex items-center justify-between w-full max-w-[210mm] bg-white p-2.5 rounded-xl border border-gray-300 shadow-sm sticky top-0 z-30 select-none flex-wrap gap-2">
            <div class="flex items-center gap-1.5 flex-wrap">
                <span class="text-xs font-black text-indigo-700 flex items-center gap-1">
                    <i class="fa-solid fa-file-signature"></i> 양식 직접 편집 (워드형)
                </span>
                <span class="text-[11px] text-gray-400 font-bold ml-1">| 태그 삽입:</span>
                <button type="button" onclick="window.insertDocTag('{{담당기사}}')" class="px-2 py-0.5 bg-blue-100 hover:bg-blue-200 text-blue-800 border border-blue-300 rounded text-[11px] font-black transition active:scale-95">+ 담당기사</button>
                <button type="button" onclick="window.insertDocTag('{{상호명}}')" class="px-2 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded text-[11px] font-black transition active:scale-95">+ 상호</button>
                <button type="button" onclick="window.insertDocTag('{{구매자명}}')" class="px-2 py-0.5 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 rounded text-[11px] font-black transition active:scale-95">+ 구매자</button>
                <button type="button" onclick="window.insertDocTag('{{공급자}}')" class="px-2 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-800 border border-gray-300 rounded text-[11px] font-black transition active:scale-95">+ 공급자</button>
                <button type="button" onclick="window.insertDocTag('{{배송지주소}}')" class="px-2 py-0.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded text-[11px] font-black transition active:scale-95">+ 주소</button>
                <button type="button" onclick="window.insertDocTag('{{고객연락처}}')" class="px-2 py-0.5 bg-purple-50 hover:bg-purple-100 text-purple-800 border border-purple-200 rounded text-[11px] font-black transition active:scale-95">+ 전화번호</button>
            </div>
            <div class="flex items-center gap-2">
                <button type="button" onclick="window.editOriginalDocumentTemplate()" class="px-3 py-1.5 border rounded-lg text-xs">원본 양식 편집</button>
                <button type="button" onclick="window.saveCurrentDocumentTemplate()" class="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-black rounded-lg shadow-sm transition active:scale-95 flex items-center gap-1.5">
                    <i class="fa-solid fa-floppy-disk"></i> 양식 저장
                </button>
            </div>
        </div>
        <div id="editable-doc-canvas" class="doc-canvas-paper shadow-2xl bg-white w-full max-w-[210mm] relative p-0 border border-gray-300 overflow-hidden">
            ${htmlContent}
        </div>
    `;

    const docCanvas = document.getElementById('editable-doc-canvas');
    if (docCanvas) {
        docCanvas.addEventListener('input', () => {
            if (!templateBuilderState.filledPreview) templateBuilderState.currentDocHtml = docCanvas.innerHTML;
        });
    }
}

export function insertDocTag(tagStr) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) {
        alert("태그를 삽입할 텍스트 위치를 먼저 클릭해 주세요.");
        return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const tagNode = document.createTextNode(tagStr);
    range.insertNode(tagNode);
    range.collapse(false);

    templateBuilderState.currentDocHtml = document.getElementById('editable-doc-canvas')?.innerHTML || '';
}

// ==========================================
// 4. [핵심] 다중 품목 동적 렌더링 엔진 (오직 item-table의 colgroup만 안전 교체)
// ==========================================
export function fillTemplateWithOrderData(baseTemplateHtml, order, idx = 0) {
    if (!baseTemplateHtml) return '';
    if (!order) return baseTemplateHtml;
    let html = baseTemplateHtml;

    // 🌟 안전장치: 구버전 서식의 잔여 nowrap 및 ellipsis 인라인 속성 실시간 완전 소거
    html = html.replace(/white-space:\s*nowrap;?/gi, '')
               .replace(/text-overflow:\s*ellipsis;?/gi, '');

    const today = getLocalDateString();
    const orderNo = /^[A-Za-z0-9]{5}$/.test(order.deliveryNumber || '') ? order.deliveryNumber : '미발급';
    html = html.replace(/주문번호\s*:/g, '배송번호:');
    const bizNo = order.bizNo || '';
    const storeName = order.storeName || order.senderName || '-';
    const senderName = order.senderName || order.storeName || '-';
    const buyerName = order.buyerName || order.storeName || '-'; 
    const address = order.fullAddress || order.address || '-';
    const phone = order.phone || '';
    const memo = order.memo || '';

    // 담당 기사 데이터 추출 (미배정 시 '미배정' 표시)
    const driverName = order.assignedDriver ? String(order.assignedDriver).trim() : '미배정';

    // 결제수단 자동 감지
    let payMethod = '카드결제';
    if (memo.includes('네이버페이')) payMethod = '네이버페이';
    else if (memo.includes('토스')) payMethod = '토스페이 카드';
    else if (memo.includes('무통장') || memo.includes('계좌')) payMethod = '무통장입금';
    else if (memo.includes('현금')) payMethod = '현금결제';

    const totalQty = order.qty ? `${formatNumber(order.qty)}개` : (order.items && order.items.length > 0 ? `${formatNumber(order.items.reduce((s, it) => s + ((Number.isFinite(Number(it.qty)) && it.qty !== '' && it.qty != null ? Number(it.qty) : 1)), 0))}개` : '1개');
    const grandTotal = order.total ? `${formatNumber(order.total)}원` : '';

    // 1. 단일 필드 태그 치환 (담당기사 포함)
    html = html.replace(/\{\{\s*담당기사\s*\}\}/g, () => escapeTemplateText(driverName))
               .replace(/\{\{\s*기사명\s*\}\}/g, () => escapeTemplateText(driverName))
               .replace(/\{\{\s*주문일자\s*\}\}/g, () => escapeTemplateText(today))
               .replace(/\{\{\s*(?:배송번호|주문번호)\s*\}\}/g, () => escapeTemplateText(orderNo))
               .replace(/\{\{\s*사업자번호\s*\}\}/g, () => escapeTemplateText(bizNo))
               .replace(/\{\{\s*상호명\s*\}\}/g, () => escapeTemplateText(storeName))
               .replace(/\{\{\s*구매자명\s*\}\}/g, () => escapeTemplateText(buyerName)) 
               .replace(/\{\{\s*공급자\s*\}\}/g, () => escapeTemplateText(senderName)) 
               .replace(/\{\{\s*발송자\s*\}\}/g, () => escapeTemplateText(senderName)) 
               .replace(/\{\{\s*배송지주소\s*\}\}/g, () => escapeTemplateText(address))
               .replace(/\{\{\s*고객연락처\s*\}\}/g, () => escapeTemplateText(phone))
               .replace(/\{\{\s*결제수단\s*\}\}/g, () => escapeTemplateText(payMethod))
               .replace(/\{\{\s*배송요청사항\s*\}\}/g, () => escapeTemplateText(memo))
               .replace(/\{\{\s*총수량\s*\}\}/g, () => escapeTemplateText(totalQty))
               .replace(/\{\{\s*총금액\s*\}\}/g, () => escapeTemplateText(grandTotal));

    // 2. 현재 서식의 상품 테이블 thead 컬럼 구조 정밀 추출
    let cols = templateBuilderState.detectedColumns || ['No.', '상품명', '규격(단위)', '제조사(원산지)', '수량', '단가', '공급가액', '세액', '총액'];
    const theadMatch = html.match(/<table[^>]*item-table[^>]*>[\s\S]*?<thead>[\s\S]*?<tr>([\s\S]*?)<\/tr>[\s\S]*?<\/thead>/i);
    if (theadMatch) {
        const thMatches = theadMatch[1].match(/<th[^>]*>([\s\S]*?)<\/th>/gi);
        if (thMatches && thMatches.length >= 3) {
            cols = thMatches.map(th => th.replace(/<[^>]+>/g, '').trim());
        }
    }

    // 🌟 대참사 방지 핵심: party-table과 footer-table의 원래 colgroup을 100% 원복 및 완벽 보호
    const partyColgroup = `<colgroup><col style="width: 4%;"><col style="width: 16%;"><col style="width: 30%;"><col style="width: 4%;"><col style="width: 16%;"><col style="width: 30%;"></colgroup>`;
    const footerColgroup = `<colgroup><col style="width: 15%;"><col style="width: 35%;"><col style="width: 15%;"><col style="width: 10%;"><col style="width: 12%;"><col style="width: 13%;"></colgroup>`;

    html = html.replace(/(<table[^>]*party-table[^>]*>)[\s\S]*?<colgroup>[\s\S]*?<\/colgroup>/gi, `$1\n${partyColgroup}`);
    html = html.replace(/(<table[^>]*footer-table[^>]*>)[\s\S]*?<colgroup>[\s\S]*?<\/colgroup>/gi, `$1\n${footerColgroup}`);

    // 🌟 오직 'item-table'의 <colgroup>만 타겟팅하여 안전하게 동적 비율 교체
    const dynamicItemColgroup = buildDynamicColgroup(cols);
    html = html.replace(/(<table[^>]*item-table[^>]*>)[\s\S]*?<colgroup>[\s\S]*?<\/colgroup>/gi, `$1\n${dynamicItemColgroup}`);

    // 3. 다중 품목 데이터 조립
    const items = (order.items && order.items.length > 0) 
        ? order.items 
        : (order.itemName ? [{
            name: order.itemName,
            qty: order.qty || 1,
            unit: order.unit || '개',
            price: order.price || '',
            total: order.total || ''
        }] : []);

    const isDense = items.length > 5;
    const isVeryDense = items.length > 8;
    const isExtreme = items.length > 11;

    const cellPadding = isExtreme ? '1px 2px' : (isVeryDense ? '1.5px 3px' : (isDense ? '2px 3px' : '2.5px 4px'));
    const fontSize = isExtreme ? '8px' : (isVeryDense ? '8.5px' : (isDense ? '9px' : '9.5px'));

    let itemsRowsHtml = '';
    items.forEach((it, i) => {
        const itemQty = (Number.isFinite(Number(it.qty)) && it.qty !== '' && it.qty != null ? Number(it.qty) : 1);
        const itemPrice = parseInt(String(it.price).replace(/[^0-9]/g, ''), 10) || 0;
        const itemTotal = parseInt(String(it.total).replace(/[^0-9]/g, ''), 10) || (itemPrice * itemQty);
        const explicitSupply = it.supplyAmount != null && Number.isFinite(Number(it.supplyAmount));
        const explicitTax = it.taxAmount != null && Number.isFinite(Number(it.taxAmount));
        const exempt = /면세|비과세/.test(String(it.taxType || ''));
        const supplyAmt = explicitSupply ? Number(it.supplyAmount) : exempt ? itemTotal : (Math.round(itemTotal / 1.1) || itemTotal);
        const taxAmt = explicitTax ? Number(it.taxAmount) : exempt ? 0 : ((itemTotal - supplyAmt) || 0);

        let tdsHtml = '';
        cols.forEach(col => {
            if (col === 'No.' || /No|순번/i.test(col)) {
                tdsHtml += `<td style="border: 1px solid #000; text-align: center; padding: ${cellPadding}; vertical-align: middle;">${i + 1}</td>`;
            } else if (col === '상품명' || /^(상품|상품명|품목|품목명|품명|제품명)$/i.test(col)) {
                tdsHtml += `<td style="border: 1px solid #000; font-weight: bold; padding: ${cellPadding}; text-align: left; vertical-align: middle; word-break: break-all; white-space: normal; line-height: 1.18;">${escapeTemplateText(it.name || '-')}</td>`;
            } else if (/규격|단위/i.test(col)) {
                tdsHtml += `<td style="border: 1px solid #000; text-align: center; padding: ${cellPadding}; vertical-align: middle;">${escapeTemplateText(it.unit || '개')}</td>`;
            } else if (/제조사|원산지/i.test(col)) {
                tdsHtml += `<td style="border: 1px solid #000; text-align: center; padding: ${cellPadding}; vertical-align: middle;">${escapeTemplateText(it.origin || it.manufacturer || '-')}</td>`;
            } else if (/수량/i.test(col)) {
                tdsHtml += `<td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: ${cellPadding}; vertical-align: middle;">${formatNumber(itemQty)}</td>`;
            } else if (/단가/i.test(col)) {
                tdsHtml += `<td style="border: 1px solid #000; text-align: right; padding: ${cellPadding}; vertical-align: middle;">${itemPrice ? formatNumber(itemPrice) : '-'}</td>`;
            } else if (/공급가/i.test(col)) {
                tdsHtml += `<td style="border: 1px solid #000; text-align: right; padding: ${cellPadding}; vertical-align: middle;">${supplyAmt ? formatNumber(supplyAmt) : '-'}</td>`;
            } else if (/세액|부가세/i.test(col)) {
                tdsHtml += `<td style="border: 1px solid #000; text-align: right; padding: ${cellPadding}; vertical-align: middle;">${taxAmt ? formatNumber(taxAmt) : '0'}</td>`;
            } else if (/총액|합계/i.test(col)) {
                tdsHtml += `<td style="border: 1px solid #000; text-align: right; font-weight: bold; padding: ${cellPadding}; vertical-align: middle;">${itemTotal ? formatNumber(itemTotal) : '-'}</td>`;
            } else {
                const extraValue = it.extra?.[col] ?? it[col] ?? '-';
                tdsHtml += `<td style="border: 1px solid #000; text-align: center; padding: ${cellPadding}; vertical-align: middle;">${escapeTemplateText(extraValue)}</td>`;
            }
        });

        itemsRowsHtml += `<tr class="item-row" style="font-size: ${fontSize};">${tdsHtml}</tr>`;
    });

    // 5행 미만일 때만 빈 행 동적 채움
    const remainCount = Math.max(0, 5 - items.length);
    for (let r = 0; r < remainCount; r++) {
        const rowNo = items.length + r + 1;
        let emptyTds = '';
        cols.forEach(col => {
            if (col === 'No.' || /No|순번/i.test(col)) {
                emptyTds += `<td style="border: 1px solid #000; text-align: center; padding: 2px;">${rowNo}</td>`;
            } else {
                emptyTds += `<td style="border: 1px solid #000; padding: 2px 4px;" contenteditable="true"></td>`;
            }
        });
        itemsRowsHtml += `<tr class="item-row empty-row" style="height: 18px;">${emptyTds}</tr>`;
    }

    // 모든 tpl-items-tbody 교체
    html = html.replace(/<tbody class="tpl-items-tbody">[\s\S]*?<\/tbody>/g, `<tbody class="tpl-items-tbody">${itemsRowsHtml}</tbody>`);

    return html;
}

// ==========================================
// 5. [양식 저장] 버튼 클릭 시 동작 로직
// ==========================================
export async function saveCurrentDocumentTemplate() {
    if(templateBuilderState.activeTemplateId==='BUILTIN-SIKBOM-V1'){
        try{const forms=ensureBuiltInForm(),form=forms.find(f=>f.id==='BUILTIN-SIKBOM-V1');form.templateHtml=templateBuilderState.currentDocHtml||form.templateHtml;localStorage.setItem('deliveryPro_savedForms',JSON.stringify(forms));alert('식봄 기본양식을 저장했습니다.');}catch(e){alert(e.message);}return;
    }
    if (!templateBuilderState.activeTemplateId) { alert('먼저 저장된 양식을 선택해 주세요.'); return; }
    try { await invoiceRequest({action:'save-document',documentVersion:templateBuilderState.document?.version||2,id:templateBuilderState.activeTemplateId,edits:templateBuilderState.documentEdits||{}});alert('문서 양식을 저장했습니다. 다른 주문에도 같은 양식이 적용됩니다.'); }
    catch(e) { alert(e.message); }

}

// ==========================================
// 6. 전역 Window 객체 바인딩
// ==========================================
window.renderEditableDocument = renderEditableDocument;
window.insertDocTag = insertDocTag;
window.saveCurrentDocumentTemplate = saveCurrentDocumentTemplate;
window.fillTemplateWithOrderData = fillTemplateWithOrderData;
window.buildDynamicColgroup = buildDynamicColgroup;
window.editOriginalDocumentTemplate = () => {
    previewPdfOrder(null).catch(e=>alert(e.message));
};

let invoicePrinting=false,invoicePreviewVersion=0,invoicePdfUrl=null;
const invoiceOwner=()=>sessionStorage.getItem('deliveryProDispatchKey')||'';
export async function invoiceRequest(body){
    if(body.action==='register')throw Error('자동 양식 등록은 종료되었습니다. 주문서 통합 요청하기로 문의해 주세요.');
    const owner=invoiceOwner();
    if(!owner||!auth.currentUser)throw Error('관제 계정으로 로그인해 주세요.');
    const response=await fetch('/api/invoice-template',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await auth.currentUser.getIdToken()},body:JSON.stringify({...body,dispatchKey:owner}),signal:AbortSignal.timeout(58000)});
    const result=await response.json();
    if(owner!==invoiceOwner())throw Error('업체가 변경되었습니다. 다시 열어 주세요.');
    if(!response.ok)throw Error(result.error||'명세서를 처리하지 못했습니다.');return result;
}
export function showInvoiceProgress(message,busy=false){
    const wrapper=document.getElementById('doc-editor-wrapper');
    if(wrapper){
        wrapper.replaceChildren();wrapper.setAttribute('aria-busy',String(busy));
        const text=document.createElement('div');text.className='p-6 bg-white rounded-xl';text.setAttribute('role','status');text.setAttribute('aria-live','polite');
        text.style.cssText='display:flex;align-items:center;gap:12px';
        if(busy){const style=document.createElement('style');style.textContent='@keyframes invoice-work-spin{to{transform:rotate(360deg)}}';wrapper.appendChild(style);const spinner=document.createElement('span');spinner.dataset.invoiceSpinner='true';spinner.setAttribute('aria-hidden','true');spinner.style.cssText='display:inline-block;flex-shrink:0;width:22px;height:22px;border:3px solid #dbeafe;border-top-color:#2563eb;border-radius:50%;animation:invoice-work-spin .8s linear infinite';text.appendChild(spinner);}
        const label=document.createElement('span');label.textContent=message;text.appendChild(label);wrapper.appendChild(text);
    }
    document.getElementById('preview-placeholder')?.classList.add('hidden');
}
export function clearPdfTemplate(){
    invoicePreviewVersion++;templateBuilderState.documentId=null;templateBuilderState.document=null;templateBuilderState.documentEdits={};templateBuilderState.activeTemplateId=null;templateBuilderState.currentDocHtml='';
    if(invoicePdfUrl){URL.revokeObjectURL(invoicePdfUrl);invoicePdfUrl=null;}
    showInvoiceProgress('저장된 양식을 선택해 주세요. 새 양식은 주문서 통합 요청하기로 문의해 주세요.');
}
function pdfBytes(base64){return Uint8Array.from(atob(base64),c=>c.charCodeAt(0));}
export async function previewPdfOrder(order){
    if(invoicePrinting)return;
    const id=templateBuilderState.activeTemplateId;if(!id)return;
    if(id==='BUILTIN-SIKBOM-V1'){
        invoicePreviewVersion++;const form=ensureBuiltInForm().find(f=>f.id===id);const base=templateBuilderState.currentDocHtml||form.templateHtml;templateBuilderState.currentDocHtml=base;renderEditableDocument(order?fillTemplateWithOrderData(base,order):base,!!order);return;
    }
    const version=++invoicePreviewVersion;
    try {
    if(templateBuilderState.documentId!==id){showInvoiceProgress('편집 양식 불러오는 중…',true);const result=await invoiceRequest({action:'document',id});if(version!==invoicePreviewVersion||id!==templateBuilderState.activeTemplateId)return;if(!validCompanyDocument(result.document))throw Error('양식 화면과 서버 버전이 다릅니다. 새로고침 후 다시 열어 주세요.');templateBuilderState.document=result.document;templateBuilderState.documentEdits=result.edits;templateBuilderState.documentId=id;}
    renderCompanyDocument(order);
    } catch(error) {if(version===invoicePreviewVersion&&id===templateBuilderState.activeTemplateId)showInvoiceProgress(error.message);throw error;}
}
export async function printPdfOrders(orders){
    const id=templateBuilderState.activeTemplateId;if(!id){alert('먼저 저장된 양식을 선택해 주세요.');return;}
    if(id==='BUILTIN-SIKBOM-V1'){
        const popup=window.open('about:blank','_blank');if(!popup){alert('인쇄 창을 열 수 없습니다. 팝업을 허용해 주세요.');return;}
        const base=templateBuilderState.currentDocHtml||ensureBuiltInForm().find(f=>f.id===id).templateHtml;
        popup.document.open();popup.document.write('<!doctype html><html lang="ko"><meta charset="utf-8"><title>식봄 주문서 인쇄</title><style>@page{size:A4;margin:0}body{margin:0;font-family:Arial,"Malgun Gothic",sans-serif}.print-order{break-after:page}.print-order:last-child{break-after:auto}*{box-sizing:border-box}</style><body>'+orders.map((o,i)=>'<section class="print-order">'+fillTemplateWithOrderData(base,o,i)+'</section>').join('')+'</body></html>');popup.document.close();await popup.document.fonts?.ready;popup.onafterprint=()=>popup.close();popup.focus();popup.print();return;
    }
    if(!templateBuilderState.document||templateBuilderState.documentId!==id){await previewPdfOrder(null);}
    const popup=window.open('about:blank','_blank');if(!popup){alert('인쇄 창의 팝업을 허용해 주세요.');return;}
    popup.document.write('<!doctype html><html lang="ko"><meta charset="utf-8"><title>주문서 일괄 출력</title><style>@page{size:A4;margin:0}body{margin:0;font-family:"Malgun Gothic",sans-serif}*{box-sizing:border-box}.company-document{break-after:page}.company-document:last-child{break-after:auto}tr{break-inside:avoid}</style><body>'+invoiceBatchHtml(orders)+'</body></html>');popup.document.close();
    await Promise.all([...popup.document.images].map(img=>img.complete?Promise.resolve():new Promise(r=>{img.onload=r;img.onerror=r;})));await popup.document.fonts?.ready;
    try{await Promise.all([...popup.document.querySelectorAll('svg image[href]')].map(n=>{const img=new popup.Image();img.src=n.getAttribute('href');return img.decode();}));}catch{popup.close();alert('원본 고정 양식 이미지를 불러오지 못했습니다. 다시 출력해 주세요.');return;}
    fitCompanyDocument(popup.document);
    if([...popup.document.querySelectorAll('.company-document,.base-document [data-base-items],.base-document [data-source-field]')].some(n=>popup.getComputedStyle(n).visibility!=='hidden'&&(n.scrollWidth>n.clientWidth+2||n.scrollHeight>n.clientHeight+2))){popup.close();alert('입력 내용이 양식의 출력 영역을 넘었습니다. 양식 또는 주문 내용을 확인해 주세요.');return;}popup.onafterprint=()=>popup.close();popup.focus();popup.print();

}

// Editable company document: static text is editable, order fields remain data bindings.
const nonemptyInvoiceValues=o=>Object.fromEntries(Object.entries(o?.invoiceValues||{}).filter(([,v])=>v!==null&&v!==undefined&&v!==''));
const documentFieldNames={driverName:'담당기사',senderName:'공급자',deliveryNumberLabel:'배송번호표제',storeName:'상호명',buyerName:'구매자명',address:'배송지주소',phone:'연락처',bizNo:'사업자번호',date:'주문일자',deliveryNumber:'배송번호',qty:'총수량',total:'총액',memo:'배송요청사항',payMethod:'결제수단',shippingFee:'배송비'};
function documentKoreanAmount(value){
 const n=Number(String(value??'').replace(/,/g,''));if(value==null||value===''||!Number.isSafeInteger(n)||n<0)return '';
 if(n===0)return '영원정';const digits='영일이삼사오육칠팔구',units=['','십','백','천'],groups=['','만','억','조'];let v=n,result='',group=0;
 while(v){let part=v%10000,text='';for(let i=0;part;i++,part=Math.floor(part/10)){const d=part%10;if(d)text=(d===1&&i>0?'':digits[d])+units[i]+text;}if(text)result=text+groups[group]+result;v=Math.floor(v/10000);group++;}return result+'원정';
}
function companyDocumentHtml(order,editing){
 if(templateBuilderState.document?.version===3)return pairedDocumentHtml(order,editing);
 const d=templateBuilderState.document,edits=templateBuilderState.documentEdits||{},o=order?{...order,...nonemptyInvoiceValues(order)}:null,date=String(o?.orderDate||o?.date||getLocalDateString());
 const values=o?{...o,totalWords:documentKoreanAmount(o.total),address:o.fullAddress||o.address||'',buyerName:o.buyerName||o.storeName||'',date,year:date.slice(0,4),yearShort:date.slice(2,4),month:date.slice(5,7),day:date.slice(8,10),driverName:o.assignedDriver||'',senderName:o.senderName||o.supplier||''}:{};
 const names={...documentFieldNames,totalWords:'한글총액',year:'년',yearShort:'년2자리',month:'월',day:'일',supplyAmount:'공급가액',taxAmount:'세액'};
 const fill=(text,data=values,labels=names)=>String(text).replace(/\{\{([^{}]+)\}\}/g,(_,label)=>{const key=Object.keys(labels).find(k=>labels[k]===label);return data[key]??'';});
 const editable=(id,text,data,labels)=>`<span ${editing?'contenteditable="true"':''} data-document-text="${id}" style="display:block;min-height:1em;white-space:pre-wrap;overflow-wrap:anywhere;${editing?'outline:1px dashed #bbc;':''}">${escapeTemplateText(o?fill(edits[id]??text,data,labels):(edits[id]??text))}</span>`;
 const xs=[0,...new Set((d.blocks||[]).flatMap(b=>[Math.round(b.left),Math.round(b.left+b.width)])),Math.ceil(d.width)].sort((a,b)=>a-b).filter((v,i,a)=>!i||v>a[i-1]),ys=[0,...new Set((d.blocks||[]).flatMap(b=>[Math.round(b.top),Math.round(b.bottom)])),Math.ceil(d.height)].sort((a,b)=>a-b).filter((v,i,a)=>!i||v>a[i-1]);
 let html=`<section class="company-document" data-page-height="${d.height}" style="width:${d.width}pt;height:${d.height-1}pt;background:white;box-sizing:border-box;font-family:Arial,'Malgun Gothic',sans-serif;font-size:7.5pt;line-height:1.15;display:grid;grid-template-columns:${xs.slice(1).map((x,i)=>(x-xs[i])+'fr').join(' ')};grid-template-rows:${ys.slice(1).map((y,i)=>d.mode==='original-reproduction'?(y-ys[i])+'pt':'minmax(min-content,'+(y-ys[i])+'fr)').join(' ')};align-items:stretch">`,last=12;
 for(const block of d.blocks||[]){const margin=0,common=`grid-column:${xs.indexOf(Math.round(block.left))+1}/${xs.indexOf(Math.round(block.left+block.width))+1};grid-row:${ys.indexOf(Math.round(block.top))+1}/${ys.indexOf(Math.round(block.bottom))+1};width:100%;min-width:0;`;last=Math.max(last,block.bottom);
 if(block.type==='paragraph'){html+=`<p style="${common}margin:0;text-align:${['left','center','right'].includes(block.align)?block.align:'left'};font-weight:${block.bold?700:400};font-size:${Math.max(6,Math.min(72,Number(block.fontSize)||10))}pt">${editable(block.id,block.text)}</p>`;continue;}
 if(block.type==='table'){html+=`<table style="${common}border-collapse:collapse;table-layout:fixed;font-size:inherit;line-height:inherit"><colgroup>`+block.columns.map(w=>`<col style="width:${w/block.width*100}%">`).join('')+'</colgroup><tbody>';const occupied=[];block.rows.forEach((row,ri)=>{html+=`<tr style="height:${row.height}pt">`;for(let col=0;col<block.columns.length;){if((occupied[col]||0)>ri){col++;continue;}const c=row.cells.find(c=>c.col===col);if(c){for(let j=col;j<col+c.colspan;j++)occupied[j]=ri+c.rowspan;html+=`<td colspan="${c.colspan}" rowspan="${c.rowspan}" style="border:.6pt solid #222;padding:1pt ${block.columns.slice(col,col+c.colspan).reduce((n,w)=>n+w,0)<35?.5:2}pt;vertical-align:middle;font-weight:${c.bold?700:400};text-align:${['left','center','right'].includes(c.align)?c.align:'left'};${Number.isFinite(c.fontSize)?`font-size:${Math.max(6,Math.min(72,c.fontSize))}pt;`:''}">${editable(c.id,c.text)}</td>`;col+=Math.max(1,c.colspan);}else{html+='<td style="border:0;padding:0"></td>';col++;}}html+='</tr>';});html+='</tbody></table>';continue;}

 const labels={year:'년',month:'월',day:'일',no:'순번',name:'상품명',qty:'수량',price:'단가',unit:'규격',origin:'원산지',supplyAmount:'공급가액',taxAmount:'세액',total:'총액',note:'비고'},items=o?(o.items||[]):[{}],width=block.columns.reduce((s,c)=>s+c.width,0);
 html+=`<div data-item-region style="${common}min-height:0;border-left:.6pt solid #222;border-right:.6pt solid #222;box-sizing:border-box"><table style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:inherit;line-height:inherit"><colgroup>`+block.columns.map(c=>`<col style="width:${c.width/width*100}%">`).join('')+'</colgroup><tbody>';
 items.forEach((source,i)=>{const item={year:values.year,month:values.month,day:values.day,...source,...nonemptyInvoiceValues(source),no:i+1};item.unit??=item.spec;item.origin??=item.manufacturer;html+=`<tr style="height:${Math.max(0,Number(block.rowHeights?.[i])||0)}pt">`+block.columns.map(c=>`<td style="border:.6pt solid #222;padding:1pt ${c.width<30?.5:2}pt;vertical-align:middle;font-size:${Math.max(6,Math.min(72,Number(c.fontSize)||7.5))}pt;font-weight:${c.bold?700:400};text-align:${['left','center','right'].includes(c.align)?c.align:'left'}">${editable('cell'+block.index+'_'+c.key,'{{'+(labels[c.key]||c.key)+'}}',item,labels)}</td>`).join('')+'</tr>';});for(let i=items.length;i<(block.rowHeights?.length||0);i++)html+=`<tr data-invoice-empty-row style="height:${Math.max(0,Number(block.rowHeights[i])||0)}pt">`+block.columns.map(()=>'<td style="border:.6pt solid #222;padding:0"></td>').join('')+'</tr>';html+='</tbody></table></div>';
 }
 return html+'</section>';
}

function renderCompanyDocument(order){
 const wrapper=document.getElementById('doc-editor-wrapper');if(!wrapper)return;wrapper.setAttribute('aria-busy','false');wrapper.innerHTML='<div class="p-3 bg-white rounded-xl flex gap-3" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:12px"><button style="white-space:nowrap;flex-shrink:0;padding:8px 12px;border:1px solid #ccd;border-radius:6px" id="company-edit">양식 편집</button><button style="white-space:nowrap;flex-shrink:0;padding:8px 12px;border:1px solid #ccd;border-radius:6px" id="company-preview">주문 미리보기</button><button style="white-space:nowrap;flex-shrink:0;padding:8px 12px;border:1px solid #ccd;border-radius:6px" id="company-save">양식 저장</button><span>점선 안 내용을 클릭하여 입력·수정하세요. 자동 입력 항목은 {{항목명}}으로 저장됩니다.</span></div>'+companyDocumentHtml(order,!order);
 const tags=document.createElement('select');tags.setAttribute('aria-label','자동 입력 항목 삽입');tags.innerHTML='<option value="">+ 자동 입력 항목</option>'+[...new Set([...Object.entries(documentFieldNames).filter(([k])=>k!=='deliveryNumberLabel').map(([,v])=>v),'상품명','수량','단가','규격','원산지','공급가액','세액','순번'])].map(v=>'<option>'+v+'</option>').join('');wrapper.firstElementChild.appendChild(tags);wrapper.querySelectorAll('[data-base-node] p').forEach(p=>p.dataset.documentText=p.parentElement.dataset.baseNode);let target=null;wrapper.querySelectorAll('[data-document-text]').forEach(n=>n.addEventListener('focus',()=>target=n));tags.onchange=()=>{if(!tags.value)return;if(!target||target.contentEditable!=='true'){alert('먼저 양식 편집에서 입력할 칸을 클릭해 주세요.');tags.value='';return;}target.textContent='{{'+(templateBuilderState.document?.version===3?(Object.keys(pairedFieldNames).find(k=>pairedFieldNames[k]===tags.value)||tags.value):tags.value)+'}}';target.dispatchEvent(new Event('input'));tags.value='';};
 wrapper.querySelector('#company-edit').onclick=()=>renderCompanyDocument(null);wrapper.querySelector('#company-preview').onclick=()=>renderCompanyDocument(state.printReadyList?.[state.currentPreviewInvoiceIndex||0]);wrapper.querySelector('#company-save').onclick=saveCurrentDocumentTemplate;
 fitCompanyDocument(wrapper);
 wrapper.querySelectorAll('[data-document-text]').forEach(n=>n.addEventListener('input',()=>{templateBuilderState.documentEdits??={};templateBuilderState.documentEdits[n.dataset.documentText]=n.innerText;fitCompanyDocument(wrapper);}));
}

function fitCompanyDocument(root){
 if(root.querySelector('.base-document'))fitPairedDocuments(root);
 // Remove only surplus blank grid rows when wrapped item text needs their space.
 for(const region of root.querySelectorAll('[data-item-region]')){let blank;while(region.scrollHeight>region.clientHeight+2&&(blank=region.querySelector('tr[data-invoice-empty-row]:last-child')))blank.remove();}
}

// Native paired-order document with independently editable values and fixed appearance.
let nativeMaskSequence=0;
function formatDocumentValue(value,format={}){
 if(value==null||value==='')return '';let text=String(value);if(format.datePattern){const m=text.match(/^(\d{4})-(\d{2})-(\d{2})/);if(m)return format.datePattern.replace('YYYY',m[1]).replace('MM',m[2]).replace('DD',m[3]);}if(format.grouping){const n=Number(text.replace(/,/g,''));if(Number.isFinite(n))text=n.toLocaleString('en-US',{maximumFractionDigits:8});}if(format.prefix&&!text.startsWith(format.prefix))text=format.prefix+text;if(format.suffix&&!text.endsWith(format.suffix))text+=format.suffix;return text;
}
function baseNativeHtml(model,order,imprint=true){
 const maskId='invoice-fixed-'+(++nativeMaskSequence);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),values=order?{...order,totalWords:documentKoreanAmount(order.total),date:order.date||order.orderDate,buyerName:order.buyerName||order.storeName,address:order.fullAddress||order.address}:null,all=[...model.nodes,...model.bodies,...model.frames,...model.assets,...(imprint?model.sourceFixedPass?.fields||[]:[])],axes=dim=>{const a=[0,dim?model.height:model.width,...all.flatMap(n=>[n.rect[dim],n.rect[dim+2]])].sort((a,b)=>a-b),out=[];for(const x of a)if(!out.length||x-out.at(-1)>.05)out.push(x);return out;},xs=axes(0),ys=axes(1),index=(a,x)=>a.reduce((best,v,i)=>Math.abs(v-x)<Math.abs(a[best]-x)?i:best,0)+1,place=r=>'grid-column:'+index(xs,r[0])+'/'+index(xs,r[2])+';grid-row:'+index(ys,r[1])+'/'+index(ys,r[3])+';',edge=(r,side)=>{const horizontal=side==='top'||side==='bottom',pos=r[side==='top'?1:side==='bottom'?3:side==='left'?0:2],lo=r[horizontal?0:1],hi=r[horizontal?2:3],lines=horizontal?model.lines.horizontal:model.lines.vertical;return lines.some(l=>Math.abs(l[horizontal?1:0]-pos)<2&&l[horizontal?0:1]<=lo+2&&l[horizontal?2:3]>=hi-2);},borders=r=>['top','right','bottom','left'].map(side=>'border-'+side+':'+(edge(r,side)?'.5pt solid #333':'0')).join(';'),text=n=>{if(values&&/\{\{/.test(n.text))return n.text.replace(/\{\{([A-Za-z]+)\}\}/g,(_,key)=>formatDocumentValue(values[key],n.bindings.find(b=>b.key===key)?.format));if(!values)return /\{\{/.test(n.text)?n.text:n.bindings.length?'{{'+n.bindings[0].key+'}}':n.text;if(!n.bindings.length)return n.text;const b=n.bindings[0],v=formatDocumentValue(values[b.key],b.format);if(b.source&&n.text.includes(b.source.text))return n.text.replace(b.source.text,v);return v;};
 let html='<style>@page{size:'+model.width/72+'in '+model.height/72+'in;margin:0}.base-document,.base-document *{box-sizing:border-box}.base-document{font-family:Arial,"Malgun Gothic",sans-serif;color:#111}.base-document [contenteditable]{outline:1px dotted #bbc}.base-document td{border:.5pt solid var(--source-rule,#333);padding:1pt;vertical-align:middle;overflow-wrap:anywhere}.base-document p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}@media print{[data-fixed-restored="true"]>p{display:none}}</style><section class="base-document company-document" data-owner="common-base" style="display:grid;width:'+model.width+'pt;height:'+model.height+'pt;grid-template-columns:'+xs.slice(1).map((x,i)=>(x-xs[i])+'pt').join(' ')+';grid-template-rows:'+ys.slice(1).map((y,i)=>(y-ys[i])+'pt').join(' ')+'">';
 for(const f of model.frames)html+='<div data-base-frame="'+f.id+'" style="'+place(f.rect)+(imprint&&!model.fixedRulings?borders(f.rect):'')+';pointer-events:none"></div>';
 for(const n of model.nodes){if(n.source==='common-base-free-text'&&!n.text&&!n.bindings.length)continue;const size=imprint?n.style.fontSize:9,restored=imprint&&model.sourceFixedPass&&model.sourceFixedPass.baseline[n.id]===n.text;html+='<div role="cell" data-base-node="'+n.id+'" data-source-kind="'+n.source+'" data-fixed-restored="'+(restored?'true':'false')+'" style="'+place(n.rect)+(imprint?(n.source==='common-base-free-text'||model.fixedRulings?'':borders(n.rect)):'border:.3pt dotted #ccc')+';min-width:0;display:flex;align-items:center;padding:'+(n.source==='common-base-cell'?'1pt':'0')+';background:'+(imprint?n.style.background:'transparent')+';font-size:'+size+'pt;color:'+(restored?'transparent':n.style.color||'#111')+';font-weight:'+(imprint&&n.style.bold?700:400)+';text-align:'+(imprint?n.style.align:'left')+'"><p '+(!order?'contenteditable="true"':'')+' data-binding="'+esc(n.bindings[0]?.key||'')+'" data-source-lines="'+(n.style.sourceLines||1)+'" style="width:100%;line-height:1.05;padding-left:'+(imprint?Math.max(0,n.style.leftInset-1):0)+'pt;padding-right:'+(imprint?Math.max(0,n.style.rightInset-1):0)+'pt">'+esc(text(n))+'</p></div>';}
 for(const b of model.bodies){const items=values?values.items||[]:[{}];html+='<div data-base-items="'+b.id+'" style="'+place(b.rect)+';min-width:0;min-height:0"><table style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:'+(b.fontSize||8)+'pt;--source-rule:'+(b.borderColor||'#333')+'"><colgroup>'+b.columns.map(c=>'<col style="width:'+((c.right-c.left)/(b.rect[2]-b.rect[0])*100)+'%">').join('')+'</colgroup><tbody>';for(let i=0;i<Math.max(items.length+(b.scalarRows||[]).length,b.rows.length);i++){const scalar=i>=items.length?(b.scalarRows||[])[i-items.length]:null;if(scalar){html+='<tr data-base-scalar-row>'+scalar.cells.map(n=>'<td data-base-scalar-cell="'+n.id+'" '+(!order?'contenteditable="true"':'')+'>'+esc(values?n.text.replace(/\{\{([A-Za-z]+)\}\}/g,(_,key)=>formatDocumentValue(values[key],n.bindings.find(b=>b.key===key)?.format)):n.text)+'</td>').join('')+'</tr>';continue;}const item=items[i],data=item?{month:String(values?.date||'').slice(5,7),day:String(values?.date||'').slice(8,10),...item,date:values?.date||'',deliveryNumber:values?.deliveryNumber||'',no:i+1}:null;html+='<tr '+(!item?'data-base-empty-row':'')+' style="height:'+(b.rows[i]?b.rows[i].bottom-b.rows[i].top:18)+'pt">'+b.columns.map(c=>'<td  data-column="'+c.key+'">'+esc(item?values?formatDocumentValue(data[c.key],c.format):'{{'+c.key+'}}':'')+'</td>').join('')+'</tr>';}html+='</tbody></table></div>';}
 if(!(imprint&&model.sourceFixedPass))for(const a of model.assets)html+='<img data-base-asset="'+a.id+'" alt="원본 고정 그림" src="'+a.src+'" style="'+place(a.rect)+'width:100%;height:100%;object-fit:contain">';if(imprint&&model.sourceFixedPass){const pass=model.sourceFixedPass,changed=model.nodes.filter(n=>pass.baseline[n.id]!==n.text);for(const field of pass.fields){const owner=model.nodes.find(n=>n.id===field.ownerId);if(!owner||changed.includes(owner))continue;const fieldLabel={buyerName:'고객',storeName:'상호',date:'날짜',total:'합계',supplyAmount:'공급가',taxAmount:'세액',shippingFee:'배송비',deliveryNumber:'배송번호',phone:'연락처',address:'주소'}[field.key]||field.key.slice(0,4),value=values?formatDocumentValue(values[field.key],field.format):'{'+fieldLabel+'}';html+='<div data-source-field="'+field.id+'" data-source-height="'+(field.glyphHeight||field.sourceRect[3]-field.sourceRect[1])+'" data-source-text="'+esc(field.sourceText)+'" data-owner-node="'+field.ownerId+'" style="'+place(field.rect)+'min-width:0;min-height:0;display:flex;align-items:center;z-index:3;pointer-events:none;font-size:'+field.fontSize+'pt;font-weight:'+(field.bold?700:400)+';text-align:'+field.align+'"><p data-source-lines="'+(field.sourceLines||1)+'" style="width:100%;line-height:1.05">'+esc(value)+'</p></div>';}html+='<svg xmlns="http://www.w3.org/2000/svg" data-fixed-base-pass="true" data-pixel-width="'+pass.width+'" data-pixel-height="'+pass.height+'" viewBox="0 0 '+pass.width+' '+pass.height+'" style="grid-column:1/-1;grid-row:1/-1;width:100%;height:100%;pointer-events:none;z-index:2"><defs><mask id="'+maskId+'"><rect width="100%" height="100%" fill="white"/>'+changed.map(n=>'<rect x="'+(n.rect[0]+(n.source==='common-base-cell'?.75:0))/model.width*pass.width+'" y="'+(n.rect[1]+(n.source==='common-base-cell'?.75:0))/model.height*pass.height+'" width="'+Math.max(0,n.rect[2]-n.rect[0]-(n.source==='common-base-cell'?1.5:0))/model.width*pass.width+'" height="'+Math.max(0,n.rect[3]-n.rect[1]-(n.source==='common-base-cell'?1.5:0))/model.height*pass.height+'" fill="black"/>').join('')+'</mask></defs><image href="'+pass.src+'" width="'+pass.width+'" height="'+pass.height+'" mask="url(#'+maskId+')"/></svg>';}if(imprint&&model.fixedRulings)html+=model.fixedRulings.svg;return html+'</section>';
}
function syncNativeFixedPass(root){
 const document=root.ownerDocument,svg=root.querySelector('[data-fixed-base-pass]');if(!root||!svg)return;const mask=svg.querySelector('mask'),original=new Map([...root.querySelectorAll('[data-base-node] p')].map(p=>[p,p.textContent])),rootBox=root.getBoundingClientRect(),sx=Number(svg.dataset.pixelWidth)/rootBox.width,sy=Number(svg.dataset.pixelHeight)/rootBox.height;
 const hole=(key,r)=>{let el=mask.querySelector('[data-live-hole="'+key+'"]');if(!el){el=document.createElementNS('http://www.w3.org/2000/svg','rect');el.dataset.liveHole=key;el.setAttribute('fill','black');mask.append(el);}el.setAttribute('x',String((r.x-rootBox.x)*sx-1));el.setAttribute('y',String((r.y-rootBox.y)*sy-1));el.setAttribute('width',String(r.width*sx+2));el.setAttribute('height',String(r.height*sy+2));};
 for(const el of root.querySelectorAll('[data-base-items]'))hole(el.dataset.baseItems,el.getBoundingClientRect());for(const el of root.querySelectorAll('[data-source-field]')){const range=document.createRange();range.selectNodeContents(el.querySelector('p'));for(const [i,r]of [...range.getClientRects()].entries())hole(el.dataset.sourceField+'-'+i,r);}root.addEventListener('pointerdown',event=>{const owner=event.target.closest('[data-base-node]');if(owner?.dataset.fixedRestored==='true')owner.querySelector('p')?.focus();});for(const p of original.keys()){const owner=p.parentElement,id=owner.dataset.baseNode;if(owner.dataset.fixedRestored!=='true')continue;const update=()=>{const editing=document.activeElement===p||p.textContent!==original.get(p);p.style.color=editing?'#111':'transparent';owner.dataset.fixedRestored=editing?'editing':'true';for(const field of root.querySelectorAll('[data-owner-node="'+id+'"]'))field.style.visibility=editing?'hidden':'';const key='edit-'+id,existing=mask.querySelector('[data-live-hole="'+key+'"]');if(editing){const r=owner.getBoundingClientRect(),pad=owner.dataset.sourceKind==='common-base-cell'?2:0;hole(key,{x:r.x+pad,y:r.y+pad,width:Math.max(1,r.width-pad*2),height:Math.max(1,r.height-pad*2)});}else existing?.remove();};p.addEventListener('focus',update);p.addEventListener('input',update);p.addEventListener('blur',update);}
}

const pairedFieldNames={...documentFieldNames,name:'상품명',unit:'규격',origin:'원산지',price:'단가',supplyAmount:'공급가액',taxAmount:'세액',no:'순번',qty:'총수량',totalWords:'한글총액',count:'건수',option:'옵션',note:'비고',note1:'비고1',note2:'비고2'};
function validCompanyDocument(d){return !!d&&!(('background') in d)&&((d.version===2&&Array.isArray(d.blocks))||(d.version===3&&d.pipeline==='paired-native-v1'&&Array.isArray(d.nodes)&&Array.isArray(d.bodies)&&d.ready&&d.sourceFixedPass?.version===1));}
function pairedDocumentHtml(order,editing){
 const model=JSON.parse(JSON.stringify(templateBuilderState.document)),edits=templateBuilderState.documentEdits||{},pass=model.sourceFixedPass;
 const canonical=text=>String(text).replace(/{{([^{}]+)}}/g,(token,label)=>{const key=label==='수량'?'qty':Object.keys(pairedFieldNames).find(k=>pairedFieldNames[k]===label);return key?'{{'+key+'}}':token;}).replace(/({{([A-Za-z]+)}})(?:[ \t]+{{\2}})+/g,'$1');
 const keys=text=>[...text.matchAll(/{{([A-Za-z]+)}}/g)].map(m=>m[1]),fixed=text=>text.replace(/{{[^{}]+}}/g,'').replace(/\s+/g,'');
 for(const n of model.nodes){const before=canonical(n.text),after=canonical(Object.hasOwn(edits,n.id)?edits[n.id]:n.text),baseline=pass&&canonical(pass.baseline[n.id]??'');
  // Editing a data tag does not edit the original labels or their placement.
  if(pass&&baseline===before&&fixed(before)===fixed(after)){const oldKeys=keys(before),newKeys=keys(after),remap=new Map(oldKeys.map((key,i)=>[key,newKeys[i]]));if(oldKeys.length===newKeys.length&&oldKeys.every((key,i)=>remap.get(key)===newKeys[i])&&newKeys.every(Boolean)){for(const f of pass.fields.filter(f=>f.ownerId===n.id))if(remap.has(f.key)){const key=remap.get(f.key);if(key!==f.key)f.format=undefined;f.key=key;}pass.baseline[n.id]=after;}}
  n.text=after;n.bindings=keys(after).map(key=>({...n.bindings.find(b=>b.key===key),key,sourceCell:n.id}));
 }
 // One output owner per physical source slot; repeated copies elsewhere stay distinct.
 if(pass){const area=r=>Math.max(0,r[2]-r[0])*Math.max(0,r[3]-r[1]),overlap=(a,b)=>Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));pass.fields=pass.fields.filter((f,i,all)=>!all.slice(0,i).some(q=>q.key===f.key&&overlap(q.sourceRect,f.sourceRect)>=Math.max(area(q.sourceRect),area(f.sourceRect))*.9));}
 const o=order?{...order,...nonemptyInvoiceValues(order)}:null;
 if(o){o.date=o.orderDate||o.date||getLocalDateString();o.buyerName=o.buyerName||o.storeName;o.phone=o.phone||o.customerPhone||'';o.driverName=o.assignedDriver||o.driverName||'';o.senderName=o.senderName||o.supplier||'';o.items=(o.items||[]).map(x=>({...x}));}
 const html=baseNativeHtml(model,o,true),paper=model.sourceFixedPass?.paperSrc;
 return paper&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(paper)?html.replace('data-owner="common-base" style="','data-owner="common-base" style="background-image:url('+paper+');background-size:100% 100%;'):html;
}
function fitPairedDocuments(scope){
 for(const root of scope.querySelectorAll('.base-document')){
  const doc=root.ownerDocument,win=doc.defaultView;
  for(const field of root.querySelectorAll('[data-source-field]')){const ctx=doc.createElement('canvas').getContext('2d'),style=win.getComputedStyle(field);ctx.font=style.fontWeight+' 100px '+style.fontFamily;const ink=ctx.measureText(field.dataset.sourceText||''),height=ink.actualBoundingBoxAscent+ink.actualBoundingBoxDescent;if(height>0)field.style.fontSize=(Number(field.dataset.sourceHeight)*4/3*100/height)+'px';}
  for(const p of root.querySelectorAll('[data-base-node] p,[data-source-field] p')){const cell=p.parentElement,lines=Number(p.dataset.sourceLines)||1;let size=parseFloat(win.getComputedStyle(cell).fontSize);const floor=Math.min(8,Math.max(3,size*.65));while((p.scrollHeight>cell.clientHeight+1||p.scrollWidth>cell.clientWidth+1||p.scrollHeight>size*1.05*lines+2)&&size>floor){size-=.25;cell.style.fontSize=size+'px';}}
  for(const r of root.querySelectorAll('[data-base-items]')){let b;while(r.scrollHeight>r.clientHeight+2&&(b=r.querySelector('tr[data-base-empty-row]:last-child')))b.remove();}
  if(!root.dataset.fixedInitialized){syncNativeFixedPass(root);root.dataset.fixedInitialized='true';}
 }
}
function invoiceBatchHtml(orders){
 const pass=templateBuilderState.document?.version===3?templateBuilderState.document.sourceFixedPass:null;
 if(!pass)return orders.map(o=>companyDocumentHtml(o,false)).join('');
 const resource='invoice-batch-fixed-'+(++nativeMaskSequence),image='<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute;left:0;top:0;overflow:hidden" aria-hidden="true"><defs><image id="'+resource+'" href="'+pass.src+'" width="'+pass.width+'" height="'+pass.height+'"/></defs></svg>';
 const paper=pass.paperSrc&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(pass.paperSrc)?pass.paperSrc:null;
 return image+(paper?'<style>.base-document{background-image:url('+paper+');background-size:100% 100%}</style>':'')+orders.map(o=>{let html=companyDocumentHtml(o,false).replace('<image href="'+pass.src+'"','<use href="#'+resource+'"');if(paper)html=html.replace('background-image:url('+paper+');background-size:100% 100%;','');return html;}).join('');
}
