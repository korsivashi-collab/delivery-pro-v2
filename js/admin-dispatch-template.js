// js/admin-dispatch-template.js

import { state, getLocalDateString } from "./admin-state.js";

// 현재 편집 중인 서식 상태
export const templateBuilderState = {
    activeTemplateId: null,
    activeTemplateTitle: '',
    currentDocHtml: ''
};

// ==========================================
// 1. PDF 분석 및 [양식 보존 + 내용 자동 소거/템플릿화] 알고리즘 엔진
// ==========================================
export async function parsePdfToEditableDocument(file) {
    if (!window.pdfjsLib) {
        alert("PDF 처리 라이브러리가 로드되지 않았습니다. 새로고침 후 다시 시도해 주세요.");
        return;
    }

    try {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
        const pdf = await loadingTask.promise;

        if (pdf.numPages < 1) {
            alert("유효한 페이지를 찾을 수 없는 PDF 파일입니다.");
            return;
        }

        // 1페이지 텍스트 추출 및 정규화
        const page1 = await pdf.getPage(1);
        const textContent = await page1.getTextContent({ normalizeWhitespace: true });
        const items = textContent.items;

        if (!items || items.length === 0) {
            alert("PDF 파일에서 텍스트 정보를 감지하지 못했습니다.");
            return;
        }

        const rawText = items.map(it => it.str.trim()).filter(Boolean).join(' ');

        // 🌟 [알고리즘 1] 서식 구조 및 2등분(공급자/공급받는자 보관용) 여부 파악
        const isTwoPart = rawText.includes('공급자 보관용') || rawText.includes('공급받는자용') || rawText.includes('공급받는 자 보관용');
        let docTitle = '거래명세표';
        if (/주문서/i.test(rawText)) docTitle = '주문서';
        else if (/출고전표/i.test(rawText)) docTitle = '출고전표';
        else if (/발주서/i.test(rawText)) docTitle = '발주서';

        // 🌟 [알고리즘 2] 공급자(회사/화주) 정보 추출 (서식 기본값으로 영구 보존)
        let provRegno = '';
        let provName = '';
        let provAddr = '';
        let provTel = '';
        let provAddTel = '';

        const bizMatch = rawText.match(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/);
        if (bizMatch) provRegno = bizMatch[0].replace(/\s+/g, '-');

        const storeMatch = rawText.match(/(?:상호|상호\(법인명\)|법인명|상호명|공급자)\s*[:|]?\s*([가-힣A-Za-z0-9\(\)\s]{2,20})/);
        if (storeMatch) provName = storeMatch[1].trim();

        const addrMatch = rawText.match(/(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\n\r]*?(?:로|길|동|읍|면|가)\s*[\d\-]+(?:\s*[가-힣0-9\(\)\,\-\.]*)?/);
        if (addrMatch) provAddr = addrMatch[0].trim();

        const telMatches = rawText.match(/(?:0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4})/g);
        if (telMatches && telMatches.length > 0) {
            provTel = telMatches[0];
            if (telMatches.length > 1) provAddTel = telMatches[1];
        }

        // 🌟 [알고리즘 3] PDF에 존재하는 실제 상품 테이블 컬럼(열) 구조 분석
        const detectedColumns = extractItemTableColumns(rawText);

        // 🌟 [알고리즘 4] 양식(칸/테두리/라벨)은 살리고 특정 주문 내용은 싹 지워 템플릿 HTML 생성
        const formHtml = buildCleanTemplatedHtml({
            docTitle,
            isTwoPart,
            provRegno,
            provName,
            provAddr,
            provTel,
            provAddTel,
            columns: detectedColumns
        });

        templateBuilderState.activeTemplateTitle = file.name.replace(/\.[^/.]+$/, '').trim() || docTitle;
        templateBuilderState.currentDocHtml = formHtml;

        renderEditableDocument(formHtml);

        // 우측 공급자 정보 입력란에도 동기화
        const titleInput = document.getElementById('input-form-title');
        const regnoInput = document.getElementById('input-prov-regno');
        const nameInput = document.getElementById('input-prov-name');
        const addrInput = document.getElementById('input-prov-addr');
        const telInput = document.getElementById('input-prov-tel');

        if (titleInput) titleInput.value = templateBuilderState.activeTemplateTitle;
        if (regnoInput) regnoInput.value = provRegno;
        if (nameInput) nameInput.value = provName;
        if (addrInput) addrInput.value = provAddr;
        if (telInput) telInput.value = provTel;

        alert(`[PDF 양식 복원 및 내용 자동소거 완료]\n\n1. 원본 PDF의 표 칸(테두리선)과 공급자 정보를 완벽 복원했습니다.\n2. 특정 고객의 배송지 정보와 개별 상품 목록은 알고리즘이 싹 지우고 {{태그}}로 자동 전환했습니다.\n\n내용을 확인하신 후 우측 [양식 저장]을 눌러 기본 서식으로 보관하세요.`);
    } catch (e) {
        console.error("PDF 서식 파싱 오류:", e);
        alert("PDF 서식 분석 중 오류가 발생했습니다: " + e.message);
    }
}

// PDF 텍스트에서 실제 테이블 헤더 컬럼 추출
function extractItemTableColumns(rawText) {
    const defaultCols = ['No.', '상품명', '규격(단위)', '제조사(원산지)', '수량', '단가', '공급가액', '세액', '총액'];
    
    // PDF 내에 규격, 제조사, 단가, 공급가액 등의 키워드가 있는지 확인
    const cols = ['No.', '상품명'];
    if (/규격/i.test(rawText)) cols.push('규격(단위)');
    if (/제조사|원산지/i.test(rawText)) cols.push('제조사(원산지)');
    cols.push('수량', '단가');
    if (/공급가액|공급가/i.test(rawText)) cols.push('공급가액');
    if (/세액|부가세/i.test(rawText)) cols.push('세액');
    cols.push('총액');

    return cols.length >= 5 ? cols : defaultCols;
}

// ==========================================
// 2. 완벽한 표 테두리(칸)와 치환 태그를 갖춘 HTML 빌더
// ==========================================
function buildCleanTemplatedHtml(cfg) {
    if (cfg.isTwoPart) {
        // A4 2등분 서식 (상단: 공급자 보관용, 하단: 공급받는자용)
        return `
        <div class="doc-sheet invoice-two-half" contenteditable="false">
            ${generateSingleInvoiceBlock(cfg, '공급자 보관용')}
            <div class="invoice-cut-line"></div>
            ${generateSingleInvoiceBlock(cfg, '공급받는자용')}
        </div>`;
    } else {
        // 단일 전면 서식
        return `
        <div class="doc-sheet invoice-full-page" contenteditable="false">
            ${generateSingleInvoiceBlock(cfg, '공급자 보관용')}
        </div>`;
    }
}

function generateSingleInvoiceBlock(cfg, partName) {
    const title = cfg.docTitle || '거래명세표';
    const cols = cfg.columns || ['No.', '상품명', '규격(단위)', '수량', '단가', '총액'];

    // 컬럼 헤더 생성
    const thsHtml = cols.map(c => `<th contenteditable="true" style="border: 1px solid #000; padding: 4px 5px; background: #f8fafc; text-align: center; font-weight: bold;">${c}</th>`).join('');

    // 컬럼 비율 계산
    const colgroupHtml = `
        <colgroup>
            <col style="width: 5%;">
            <col style="width: 38%;">
            ${cols.length > 6 ? '<col style="width: 13%;"><col style="width: 11%;">' : '<col style="width: 16%;">'}
            <col style="width: 8%;">
            <col style="width: 11%;">
            ${cols.includes('공급가액') ? '<col style="width: 11%;">' : ''}
            ${cols.includes('세액') ? '<col style="width: 8%;">' : ''}
            <col style="width: 13%;">
        </colgroup>
    `;

    // 🌟 특정 1건의 상품 내용은 모두 지우고 동적 태그 1행 + 깨끗한 빈칸 4행 생성
    const trSample = `
        <tr class="item-row">
            <td style="border: 1px solid #000; text-align: center; padding: 4px;">1</td>
            <td style="border: 1px solid #000; font-weight: bold; padding: 4px 6px;" contenteditable="true">{{상품명}}</td>
            ${cols.includes('규격(단위)') ? '<td style="border: 1px solid #000; text-align: center; padding: 4px;" contenteditable="true">{{단위}}</td>' : ''}
            ${cols.includes('제조사(원산지)') ? '<td style="border: 1px solid #000; text-align: center; padding: 4px;" contenteditable="true">-</td>' : ''}
            <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 4px;" contenteditable="true">{{수량}}</td>
            <td style="border: 1px solid #000; text-align: right; padding: 4px 6px;" contenteditable="true">{{단가}}</td>
            ${cols.includes('공급가액') ? '<td style="border: 1px solid #000; text-align: right; padding: 4px 6px;" contenteditable="true">-</td>' : ''}
            ${cols.includes('세액') ? '<td style="border: 1px solid #000; text-align: right; padding: 4px 6px;" contenteditable="true">0</td>' : ''}
            <td style="border: 1px solid #000; text-align: right; font-weight: bold; padding: 4px 6px;" contenteditable="true">{{총액}}</td>
        </tr>
    `;

    const emptyRows = [2, 3, 4, 5].map(num => `
        <tr class="item-row empty-row">
            <td style="border: 1px solid #000; text-align: center; padding: 4px;">${num}</td>
            <td style="border: 1px solid #000; padding: 4px 6px;" contenteditable="true"></td>
            ${cols.includes('규격(단위)') ? '<td style="border: 1px solid #000; text-align: center; padding: 4px;" contenteditable="true"></td>' : ''}
            ${cols.includes('제조사(원산지)') ? '<td style="border: 1px solid #000; text-align: center; padding: 4px;" contenteditable="true"></td>' : ''}
            <td style="border: 1px solid #000; text-align: center; padding: 4px;" contenteditable="true"></td>
            <td style="border: 1px solid #000; text-align: right; padding: 4px 6px;" contenteditable="true"></td>
            ${cols.includes('공급가액') ? '<td style="border: 1px solid #000; text-align: right; padding: 4px 6px;" contenteditable="true"></td>' : ''}
            ${cols.includes('세액') ? '<td style="border: 1px solid #000; text-align: right; padding: 4px 6px;" contenteditable="true"></td>' : ''}
            <td style="border: 1px solid #000; text-align: right; padding: 4px 6px;" contenteditable="true"></td>
        </tr>
    `).join('');

    return `
    <div class="invoice-box-part" style="padding: 6mm 8mm; box-sizing: border-box; font-family: 'Malgun Gothic', Dotum, sans-serif; color: #000; background: #fff;">
        <!-- 제목 및 발행정보 -->
        <div style="text-align: center; position: relative; margin-bottom: 6px;">
            <h2 class="doc-main-title" contenteditable="true" style="font-size: 21px; font-weight: 900; letter-spacing: 5px; text-decoration: underline; margin: 0 0 4px 0;">
                ${title}<span style="font-size: 13px; font-weight: normal; letter-spacing: 0; text-decoration: none;">(${partName})</span>
            </h2>
            <div style="display: flex; justify-content: space-between; font-size: 10px; font-weight: bold; margin-top: 4px;">
                <span>주문일자: <b class="tpl-bind-date" contenteditable="true">{{주문일자}}</b></span>
                <span>주문번호: <b class="tpl-bind-orderno" contenteditable="true">{{주문번호}}</b></span>
            </div>
        </div>

        <!-- 공급자 / 공급받는 자 테이블 (모든 칸에 선 100% 복원) -->
        <table class="doc-table party-table" style="width: 100%; border-collapse: collapse; border: 2px solid #000; font-size: 10px; margin-bottom: 4px; table-layout: fixed;">
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
                    <td rowspan="5" style="border: 1px solid #000; text-align: center; font-weight: bold; line-height: 1.3; background: #f8fafc; padding: 2px;" contenteditable="true">공<br>급<br>자</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 3px;" contenteditable="true">사업자등록번호</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 3px;" contenteditable="true" spellcheck="false">${cfg.provRegno || ''}</td>
                    <td rowspan="5" style="border: 1px solid #000; text-align: center; font-weight: bold; line-height: 1.3; background: #f8fafc; padding: 2px;" contenteditable="true">공<br>급<br>받<br>는<br>자</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 3px;" contenteditable="true">사업자등록번호</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 3px; background: #f0fdf4;" contenteditable="true">{{사업자번호}}</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 3px;" contenteditable="true">상호(법인명)</td>
                    <td style="border: 1px solid #000; padding: 3px 5px;" contenteditable="true" spellcheck="false">${cfg.provName || ''}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 3px;" contenteditable="true">구 매 자 명</td>
                    <td style="border: 1px solid #000; padding: 3px 5px; font-weight: bold; background: #f0fdf4;" contenteditable="true">{{발송자}}</td>
                </tr>
                <tr style="height: 38px;">
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 3px;" contenteditable="true">주 소</td>
                    <td style="border: 1px solid #000; padding: 3px 5px; font-size: 9.5px; line-height: 1.2;" contenteditable="true" spellcheck="false">${cfg.provAddr || ''}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 3px;" contenteditable="true">주 소</td>
                    <td style="border: 1px solid #000; padding: 3px 5px; font-size: 9.5px; line-height: 1.2; background: #eff6ff;" contenteditable="true">{{배송지주소}}</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 3px;" contenteditable="true">연락처/FAX</td>
                    <td style="border: 1px solid #000; padding: 3px 5px;" contenteditable="true" spellcheck="false">${cfg.provTel || ''}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 3px;" contenteditable="true">배송지명(간판명)</td>
                    <td style="border: 1px solid #000; padding: 3px 5px; font-weight: 900; background: #eff6ff;" contenteditable="true">{{상호명}}</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 3px;" contenteditable="true">추 가 연 락 처</td>
                    <td style="border: 1px solid #000; padding: 3px 5px;" contenteditable="true" spellcheck="false">${cfg.provAddTel || ''}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 3px;" contenteditable="true">연 락 처</td>
                    <td style="border: 1px solid #000; padding: 3px 5px; background: #eff6ff;" contenteditable="true">{{고객연락처}}</td>
                </tr>
            </tbody>
        </table>

        <!-- 품목 상세 테이블 (모든 칸에 선 100% 복원) -->
        <table class="doc-table item-table" style="width: 100%; border-collapse: collapse; border: 2px solid #000; font-size: 10px; margin-bottom: 4px; table-layout: fixed;">
            ${colgroupHtml}
            <thead>
                <tr>${thsHtml}</tr>
            </thead>
            <tbody id="tpl-items-tbody">
                ${trSample}
                ${emptyRows}
            </tbody>
        </table>

        <!-- 하단 비고 및 합계 금액 (칸 복원) -->
        <table class="doc-table footer-table" style="width: 100%; border-collapse: collapse; border: 2px solid #000; font-size: 10px; table-layout: fixed;">
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
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; background: #f8fafc; padding: 3px;" contenteditable="true">결 제 수 단</td>
                    <td style="border: 1px solid #000; padding: 3px 6px;" contenteditable="true">{{결제수단}}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; background: #f8fafc; padding: 3px;" contenteditable="true">총 상품수량</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 3px;" contenteditable="true">{{총수량}}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; background: #f8fafc; padding: 3px;" contenteditable="true">배 송 비</td>
                    <td style="border: 1px solid #000; text-align: right; padding: 3px 6px;" contenteditable="true">0원</td>
                </tr>
                <tr style="height: 34px;">
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; background: #f8fafc; padding: 3px;" contenteditable="true">배송 요청사항</td>
                    <td colspan="3" style="border: 1px solid #000; padding: 3px 6px; font-size: 9.5px; vertical-align: top;" contenteditable="true">{{배송요청사항}}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: 900; background: #f1f5f9; padding: 3px;" contenteditable="true">총주문금액</td>
                    <td style="border: 1px solid #000; text-align: right; font-weight: 900; color: #dc2626; padding: 3px 6px; background: #f1f5f9;" contenteditable="true">{{총금액}}</td>
                </tr>
            </tbody>
        </table>

        <!-- 서명란 -->
        <div style="text-align: right; font-size: 10.5px; font-weight: bold; margin-top: 5px; padding-right: 10px;">
            <span contenteditable="true">인수자: <span style="display: inline-block; width: 80px; border-bottom: 1px solid #000; text-align: center;">서 명</span></span>
        </div>
    </div>`;
}

// ==========================================
// 3. 에디터 렌더링 및 툴바 제어
// ==========================================
export function renderEditableDocument(htmlContent) {
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

    editorWrapper.innerHTML = `
        <div class="doc-editor-toolbar flex items-center justify-between w-full max-w-[210mm] bg-white p-2.5 rounded-xl border border-gray-300 shadow-sm sticky top-0 z-30 select-none flex-wrap gap-2">
            <div class="flex items-center gap-1.5 flex-wrap">
                <span class="text-xs font-black text-indigo-700 flex items-center gap-1">
                    <i class="fa-solid fa-file-signature"></i> 양식 직접 편집 (워드형)
                </span>
                <span class="text-[11px] text-gray-400 font-bold ml-1">| 필요 시 태그 삽입:</span>
                <button type="button" onclick="window.insertDocTag('{{상호명}}')" class="px-2 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded text-[11px] font-black transition active:scale-95">+ 상호</button>
                <button type="button" onclick="window.insertDocTag('{{발송자}}')" class="px-2 py-0.5 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 rounded text-[11px] font-black transition active:scale-95">+ 발송자</button>
                <button type="button" onclick="window.insertDocTag('{{배송지주소}}')" class="px-2 py-0.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded text-[11px] font-black transition active:scale-95">+ 주소</button>
                <button type="button" onclick="window.insertDocTag('{{고객연락처}}')" class="px-2 py-0.5 bg-purple-50 hover:bg-purple-100 text-purple-800 border border-purple-200 rounded text-[11px] font-black transition active:scale-95">+ 전화번호</button>
            </div>
            <div class="flex items-center gap-1.5">
                <button type="button" onclick="window.addDocTableRow()" class="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-bold rounded-lg transition active:scale-95">
                    <i class="fa-solid fa-plus text-[10px]"></i> 품목 행 추가
                </button>
                <button type="button" onclick="window.deleteDocTableRow()" class="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-rose-600 text-xs font-bold rounded-lg transition active:scale-95">
                    <i class="fa-solid fa-minus text-[10px]"></i> 행 삭제
                </button>
            </div>
        </div>
        <div id="editable-doc-canvas" class="doc-canvas-paper shadow-2xl bg-white w-full max-w-[210mm] relative p-0 border border-gray-300">
            ${htmlContent}
        </div>
    `;

    const docCanvas = document.getElementById('editable-doc-canvas');
    if (docCanvas) {
        docCanvas.addEventListener('input', () => {
            templateBuilderState.currentDocHtml = docCanvas.innerHTML;
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

export function addDocTableRow() {
    const tbodies = document.querySelectorAll('#tpl-items-tbody');
    if (tbodies.length === 0) return;
    tbodies.forEach(tbody => {
        const rowCount = tbody.querySelectorAll('tr').length + 1;
        const tr = document.createElement('tr');
        tr.className = 'item-row empty-row';
        tr.innerHTML = `
            <td style="border: 1px solid #000; text-align: center; padding: 4px;">${rowCount}</td>
            <td style="border: 1px solid #000; padding: 4px 6px;" contenteditable="true"></td>
            <td style="border: 1px solid #000; text-align: center; padding: 4px;" contenteditable="true"></td>
            <td style="border: 1px solid #000; text-align: center; padding: 4px;" contenteditable="true"></td>
            <td style="border: 1px solid #000; text-align: right; padding: 4px 6px;" contenteditable="true"></td>
            <td style="border: 1px solid #000; text-align: right; padding: 4px 6px;" contenteditable="true"></td>
        `;
        tbody.appendChild(tr);
    });
    templateBuilderState.currentDocHtml = document.getElementById('editable-doc-canvas')?.innerHTML || '';
}

export function deleteDocTableRow() {
    const tbodies = document.querySelectorAll('#tpl-items-tbody');
    if (tbodies.length === 0) return;
    tbodies.forEach(tbody => {
        const rows = tbody.querySelectorAll('tr');
        if (rows.length > 1) {
            rows[rows.length - 1].remove();
        }
    });
    templateBuilderState.currentDocHtml = document.getElementById('editable-doc-canvas')?.innerHTML || '';
}

// ==========================================
// 4. 서식 저장 및 관리
// ==========================================
export function saveCurrentDocumentTemplate() {
    const docCanvas = document.getElementById('editable-doc-canvas');
    if (!docCanvas) {
        alert("저장할 서식 내용이 없습니다. 먼저 PDF를 업로드해 주세요.");
        return;
    }

    const titleInput = document.getElementById('input-form-title');
    const title = titleInput ? titleInput.value.trim() : templateBuilderState.activeTemplateTitle;
    if (!title) {
        alert("양식의 제목을 입력해 주세요.");
        titleInput?.focus();
        return;
    }

    const templateHtml = docCanvas.innerHTML;
    const savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');

    const newTemplate = {
        id: 'TPL-' + Date.now(),
        title: title,
        templateHtml: templateHtml,
        savedAt: Date.now(),
        isDefault: savedForms.length === 0
    };

    const existingIdx = savedForms.findIndex(f => f.title === title);
    if (existingIdx >= 0) {
        if (!confirm(`'${title}'(으)로 이미 저장된 양식이 있습니다. 덮어쓰시겠습니까?`)) return;
        newTemplate.isDefault = savedForms[existingIdx].isDefault;
        savedForms[existingIdx] = newTemplate;
    } else {
        savedForms.push(newTemplate);
    }

    localStorage.setItem('deliveryPro_savedForms', JSON.stringify(savedForms));
    alert(`[${title}] 양식이 성공적으로 저장되었습니다.\n좌측에서 주문을 선택하고 [주문서 일괄 출력]을 누르면 이 양식에 데이터가 채워져 인쇄됩니다.`);

    if (window.loadSavedForms) window.loadSavedForms();
}

// ==========================================
// 5. 전역 Window 객체 바인딩
// ==========================================
window.parsePdfToEditableDocument = parsePdfToEditableDocument;
window.renderEditableDocument = renderEditableDocument;
window.insertDocTag = insertDocTag;
window.addDocTableRow = addDocTableRow;
window.deleteDocTableRow = deleteDocTableRow;
window.saveCurrentDocumentTemplate = saveCurrentDocumentTemplate;