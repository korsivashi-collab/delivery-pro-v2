// js/admin-dispatch-template.js

import { state, getLocalDateString } from "./admin-state.js";
import { formatNumber } from "./admin-dispatch-core.js";

// 현재 편집 중인 서식 상태
export const templateBuilderState = {
    activeTemplateId: null,
    activeTemplateTitle: '',
    currentDocHtml: '',
    detectedColumns: ['No.', '상품명', '규격(단위)', '제조사(원산지)', '수량', '단가', '공급가액', '세액', '총액']
};

// ==========================================
// 1. PDF 분석 및 [양식 보존 + 내용 자동 소거/템플릿화] 알고리즘
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

        const page1 = await pdf.getPage(1);
        const textContent = await page1.getTextContent({ normalizeWhitespace: true });
        const items = textContent.items;

        if (!items || items.length === 0) {
            alert("PDF 파일에서 텍스트 정보를 감지하지 못했습니다.");
            return;
        }

        const rawText = items.map(it => it.str.trim()).filter(Boolean).join(' ');

        // 서식 명칭 및 2등분(공급자/공급받는자용) 파악
        const isTwoPart = rawText.includes('공급자 보관용') || rawText.includes('공급받는자용') || rawText.includes('공급받는 자 보관용');
        let docTitle = '거래명세표';
        if (/주문서/i.test(rawText)) docTitle = '주문서';
        else if (/출고전표/i.test(rawText)) docTitle = '출고전표';
        else if (/발주서/i.test(rawText)) docTitle = '발주서';

        let provRegno = '';
        let provName = '';
        let provAddr = '';
        let provTel = '';
        let provAddTel = '';

        const bizMatch = rawText.match(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/);
        if (bizMatch) provRegno = bizMatch[0].replace(/\s+/g, '-');

        // 공급자 상호명(법인명) 정밀 파싱
        const storeMatch = rawText.match(/(?:상호\(법인명\)|상호명|상호|법인명|공급자)[\s:|]*([가-힣A-Za-z0-9\(\)주식회사]+)/);
        if (storeMatch) {
            let val = storeMatch[1].trim();
            val = val.split(/(?:구매자|주문자|보관용|공급받는|주문일자)/)[0].trim();
            provName = val.replace(/^[)|\]}>\s]+/, '').trim();
        }

        const addrMatch = rawText.match(/(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\n\r]*?(?:로|길|동|읍|면|가)\s*[\d\-]+(?:\s*[가-힣0-9\(\)\,\-\.]*)?/);
        if (addrMatch) provAddr = addrMatch[0].trim();

        const telMatches = rawText.match(/(?:0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4})/g);
        if (telMatches && telMatches.length > 0) {
            provTel = telMatches[0];
            if (telMatches.length > 1) provAddTel = telMatches[1];
        }

        // 실제 상품 테이블 컬럼(열) 구조 분석
        const detectedColumns = extractItemTableColumns(rawText);
        templateBuilderState.detectedColumns = detectedColumns;

        // 양식(칸/테두리/라벨)은 유지하고 개별 주문 데이터는 치환 태그로 구성된 HTML 생성
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

        alert(`[PDF 양식 인식 완료]\n\n1. 담당기사가 전표 분류에 최적화된 [우측 상단(주문번호 위)]으로 깔끔하게 이동 배치되었습니다.\n2. 거래명세표 제목이 정중앙에 정돈되어 원래 양식의 완성도를 유지합니다.\n3. 확인 후 상단 [양식 저장]을 눌러 저장해 주세요.`);
    } catch (e) {
        console.error("PDF 서식 파싱 오류:", e);
        alert("PDF 서식 분석 중 오류가 발생했습니다: " + e.message);
    }
}

function extractItemTableColumns(rawText) {
    const cols = ['No.', '상품명'];
    if (/규격/i.test(rawText)) cols.push('규격(단위)');
    if (/제조사|원산지/i.test(rawText)) cols.push('제조사(원산지)');
    cols.push('수량', '단가');
    if (/공급가액|공급가/i.test(rawText)) cols.push('공급가액');
    if (/세액|부가세/i.test(rawText)) cols.push('세액');
    cols.push('총액');
    return cols.length >= 5 ? cols : ['No.', '상품명', '규격(단위)', '제조사(원산지)', '수량', '단가', '공급가액', '세액', '총액'];
}

// ==========================================
// 2. A4 정중앙(148.5mm) 고정 2등분 HTML 빌더 (우측 상단 담당기사 스탬프 배치)
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
    const cols = cfg.columns || ['No.', '상품명', '규격(단위)', '수량', '단가', '총액'];

    const thsHtml = cols.map(c => `<th contenteditable="true" style="border: 1px solid #000; padding: 2.5px 4px; background: #f8fafc; text-align: center; font-weight: bold; font-size: 9.5px;">${c}</th>`).join('');

    const colgroupHtml = `
        <colgroup>
            <col style="width: 5%;">
            <col style="width: 37%;">
            ${cols.includes('규격(단위)') ? '<col style="width: 13%;">' : ''}
            ${cols.includes('제조사(원산지)') ? '<col style="width: 12%;">' : ''}
            <col style="width: 7%;">
            <col style="width: 10%;">
            ${cols.includes('공급가액') ? '<col style="width: 10%;">' : ''}
            ${cols.includes('세액') ? '<col style="width: 6%;">' : ''}
            <col style="width: 12%;">
        </colgroup>
    `;

    const trSample = `
        <tr class="item-row" style="height: 18px;">
            <td style="border: 1px solid #000; text-align: center; padding: 2px;">1</td>
            <td style="border: 1px solid #000; font-weight: bold; padding: 2px 5px;" contenteditable="true">{{상품명}}</td>
            ${cols.includes('규격(단위)') ? '<td style="border: 1px solid #000; text-align: center; padding: 2px;" contenteditable="true">{{단위}}</td>' : ''}
            ${cols.includes('제조사(원산지)') ? '<td style="border: 1px solid #000; text-align: center; padding: 2px;" contenteditable="true">-</td>' : ''}
            <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2px;" contenteditable="true">{{수량}}</td>
            <td style="border: 1px solid #000; text-align: right; padding: 2px 5px;" contenteditable="true">{{단가}}</td>
            ${cols.includes('공급가액') ? '<td style="border: 1px solid #000; text-align: right; padding: 2px 5px;" contenteditable="true">{{공급가액}}</td>' : ''}
            ${cols.includes('세액') ? '<td style="border: 1px solid #000; text-align: right; padding: 2px 5px;" contenteditable="true">{{세액}}</td>' : ''}
            <td style="border: 1px solid #000; text-align: right; font-weight: bold; padding: 2px 5px;" contenteditable="true">{{총액}}</td>
        </tr>
    `;

    const emptyRows = [2, 3, 4, 5].map(num => `
        <tr class="item-row empty-row" style="height: 18px;">
            <td style="border: 1px solid #000; text-align: center; padding: 2px;">${num}</td>
            <td style="border: 1px solid #000; padding: 2px 5px;" contenteditable="true"></td>
            ${cols.includes('규격(단위)') ? '<td style="border: 1px solid #000; text-align: center; padding: 2px;" contenteditable="true"></td>' : ''}
            ${cols.includes('제조사(원산지)') ? '<td style="border: 1px solid #000; text-align: center; padding: 2px;" contenteditable="true"></td>' : ''}
            <td style="border: 1px solid #000; text-align: center; padding: 2px;" contenteditable="true"></td>
            <td style="border: 1px solid #000; text-align: right; padding: 2px 5px;" contenteditable="true"></td>
            ${cols.includes('공급가액') ? '<td style="border: 1px solid #000; text-align: right; padding: 2px 5px;" contenteditable="true"></td>' : ''}
            ${cols.includes('세액') ? '<td style="border: 1px solid #000; text-align: right; padding: 2px 5px;" contenteditable="true"></td>' : ''}
            <td style="border: 1px solid #000; text-align: right; padding: 2px 5px;" contenteditable="true"></td>
        </tr>
    `).join('');

    // 🌟 핵심: 제목은 중앙 정렬을 유지하고, [담당기사]는 주문번호 바로 윗줄(우측 상단 최적 여백)에 깔끔한 전표 스탬프 박스로 배치
    return `
    <div class="invoice-box-part" style="width: 100%; height: 148.5mm; max-height: 148.5mm; padding: 4mm 8mm 3mm 8mm; box-sizing: border-box; font-family: 'Malgun Gothic', Dotum, sans-serif; color: #000; background: #fff; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden;">
        <div style="position: relative; margin-bottom: 2px; flex-shrink: 0;">
            <!-- 우측 상단 여백 공간: 담당기사 표기 (주문번호 바로 위, 전표 분류 최적 위치) -->
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

            <!-- 하단 메타 정보 (주문일자 좌측, 주문번호 우측) -->
            <div style="display: flex; justify-content: space-between; align-items: flex-end; font-size: 9.5px; font-weight: bold; margin-top: 3px;">
                <span>주문일자: <b class="tpl-bind-date" contenteditable="true">{{주문일자}}</b></span>
                <span>주문번호: <b class="tpl-bind-orderno" contenteditable="true">{{주문번호}}</b></span>
            </div>
        </div>

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
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true" spellcheck="false">${cfg.provRegno || ''}</td>
                    <td rowspan="5" style="border: 1px solid #000; text-align: center; font-weight: bold; line-height: 1.2; background: #f8fafc; padding: 2px;" contenteditable="true">공<br>급<br>받<br>는<br>자</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">사업자등록번호</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px; background: #f0fdf4;" contenteditable="true">{{사업자번호}}</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">상호(법인명)</td>
                    <td style="border: 1px solid #000; padding: 2.5px 4px; font-weight: bold;" contenteditable="true" spellcheck="false">${cfg.provName || ''}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">구 매 자 명</td>
                    <td style="border: 1px solid #000; padding: 2.5px 4px; font-weight: bold; background: #f0fdf4;" contenteditable="true">{{구매자명}}</td>
                </tr>
                <tr style="height: 31px;">
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">주 소</td>
                    <td style="border: 1px solid #000; padding: 2px 4px; font-size: 9px; line-height: 1.15;" contenteditable="true" spellcheck="false">${cfg.provAddr || ''}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">주 소</td>
                    <td style="border: 1px solid #000; padding: 2px 4px; font-size: 9px; line-height: 1.15; background: #eff6ff;" contenteditable="true">{{배송지주소}}</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">연락처/FAX</td>
                    <td style="border: 1px solid #000; padding: 2.5px 4px;" contenteditable="true" spellcheck="false">${cfg.provTel || ''}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">배송지명(간판명)</td>
                    <td style="border: 1px solid #000; padding: 2.5px 4px; font-weight: 900; background: #eff6ff;" contenteditable="true">{{상호명}}</td>
                </tr>
                <tr>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">추 가 연 락 처</td>
                    <td style="border: 1px solid #000; padding: 2.5px 4px;" contenteditable="true" spellcheck="false">${cfg.provAddTel || ''}</td>
                    <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: 2.5px;" contenteditable="true">연 락 처</td>
                    <td style="border: 1px solid #000; padding: 2.5px 4px; background: #eff6ff;" contenteditable="true">{{고객연락처}}</td>
                </tr>
            </tbody>
        </table>

        <!-- 상품 테이블: 148.5mm 안에서 적정 영역 유지 -->
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
                <span class="text-[11px] text-gray-400 font-bold ml-1">| 태그 삽입:</span>
                <button type="button" onclick="window.insertDocTag('{{담당기사}}')" class="px-2 py-0.5 bg-blue-100 hover:bg-blue-200 text-blue-800 border border-blue-300 rounded text-[11px] font-black transition active:scale-95">+ 담당기사</button>
                <button type="button" onclick="window.insertDocTag('{{상호명}}')" class="px-2 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded text-[11px] font-black transition active:scale-95">+ 상호</button>
                <button type="button" onclick="window.insertDocTag('{{구매자명}}')" class="px-2 py-0.5 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 rounded text-[11px] font-black transition active:scale-95">+ 구매자</button>
                <button type="button" onclick="window.insertDocTag('{{공급자}}')" class="px-2 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-800 border border-gray-300 rounded text-[11px] font-black transition active:scale-95">+ 공급자</button>
                <button type="button" onclick="window.insertDocTag('{{배송지주소}}')" class="px-2 py-0.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded text-[11px] font-black transition active:scale-95">+ 주소</button>
                <button type="button" onclick="window.insertDocTag('{{고객연락처}}')" class="px-2 py-0.5 bg-purple-50 hover:bg-purple-100 text-purple-800 border border-purple-200 rounded text-[11px] font-black transition active:scale-95">+ 전화번호</button>
            </div>
            <div class="flex items-center gap-2">
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

// ==========================================
// 4. [핵심] 다중 품목 동적 렌더링 엔진 (담당기사 및 주문 데이터 서식 완벽 치환)
// ==========================================
export function fillTemplateWithOrderData(baseTemplateHtml, order, idx = 0) {
    if (!baseTemplateHtml || !order) return '';
    let html = baseTemplateHtml;

    const today = getLocalDateString();
    const orderNo = order.orderNo || `ORD-${idx + 1}`;
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

    const totalQty = order.qty ? `${formatNumber(order.qty)}개` : '1개';
    const grandTotal = order.total ? `${formatNumber(order.total)}원` : '';

    // 1. 단일 필드 태그 치환 (담당기사 포함)
    html = html.replace(/\{\{\s*담당기사\s*\}\}/g, driverName)
               .replace(/\{\{\s*기사명\s*\}\}/g, driverName)
               .replace(/\{\{\s*주문일자\s*\}\}/g, today)
               .replace(/\{\{\s*주문번호\s*\}\}/g, orderNo)
               .replace(/\{\{\s*사업자번호\s*\}\}/g, bizNo)
               .replace(/\{\{\s*상호명\s*\}\}/g, storeName)
               .replace(/\{\{\s*구매자명\s*\}\}/g, buyerName) 
               .replace(/\{\{\s*공급자\s*\}\}/g, senderName) 
               .replace(/\{\{\s*발송자\s*\}\}/g, senderName) 
               .replace(/\{\{\s*배송지주소\s*\}\}/g, address)
               .replace(/\{\{\s*고객연락처\s*\}\}/g, phone)
               .replace(/\{\{\s*결제수단\s*\}\}/g, payMethod)
               .replace(/\{\{\s*배송요청사항\s*\}\}/g, memo)
               .replace(/\{\{\s*총수량\s*\}\}/g, totalQty)
               .replace(/\{\{\s*총금액\s*\}\}/g, grandTotal);

    // 2. 다중 품목 테이블 지능형 동적 생성
    const items = (order.items && order.items.length > 0) ? order.items : [{
        name: order.itemName || '상품명 미지정',
        qty: order.qty || 1,
        unit: order.unit || '개',
        price: order.price || '',
        total: order.total || ''
    }];

    const cols = templateBuilderState.detectedColumns || ['No.', '상품명', '규격(단위)', '제조사(원산지)', '수량', '단가', '공급가액', '세액', '총액'];

    const isDense = items.length > 5;
    const isVeryDense = items.length > 8;
    const isExtreme = items.length > 11;

    const cellPadding = isExtreme ? '1px 2px' : (isVeryDense ? '1.5px 3px' : (isDense ? '2px 3px' : '2.5px 4px'));
    const fontSize = isExtreme ? '8px' : (isVeryDense ? '8.5px' : (isDense ? '9px' : '9.5px'));
    const rowHeight = isExtreme ? '13px' : (isVeryDense ? '15px' : (isDense ? '17px' : '18px'));

    let itemsRowsHtml = '';
    items.forEach((it, i) => {
        const itemQty = parseInt(it.qty, 10) || 1;
        const itemPrice = parseInt(String(it.price).replace(/[^0-9]/g, ''), 10) || 0;
        const itemTotal = parseInt(String(it.total).replace(/[^0-9]/g, ''), 10) || (itemPrice * itemQty);
        const supplyAmt = Math.round(itemTotal / 1.1) || itemTotal;
        const taxAmt = (itemTotal - supplyAmt) || 0;

        itemsRowsHtml += `
        <tr class="item-row" style="font-size: ${fontSize}; height: ${rowHeight};">
            <td style="border: 1px solid #000; text-align: center; padding: ${cellPadding};">${i + 1}</td>
            <td style="border: 1px solid #000; font-weight: bold; padding: ${cellPadding};">
                <div style="max-height: ${rowHeight}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">${it.name || '-'}</div>
            </td>
            ${cols.includes('규격(단위)') ? `<td style="border: 1px solid #000; text-align: center; padding: ${cellPadding};">${it.unit || '개'}</td>` : ''}
            ${cols.includes('제조사(원산지)') ? `<td style="border: 1px solid #000; text-align: center; padding: ${cellPadding};">국내산</td>` : ''}
            <td style="border: 1px solid #000; text-align: center; font-weight: bold; padding: ${cellPadding};">${formatNumber(itemQty)}</td>
            <td style="border: 1px solid #000; text-align: right; padding: ${cellPadding};">${itemPrice ? formatNumber(itemPrice) : '-'}</td>
            ${cols.includes('공급가액') ? `<td style="border: 1px solid #000; text-align: right; padding: ${cellPadding};">${supplyAmt ? formatNumber(supplyAmt) : '-'}</td>` : ''}
            ${cols.includes('세액') ? `<td style="border: 1px solid #000; text-align: right; padding: ${cellPadding};">${taxAmt ? formatNumber(taxAmt) : '0'}</td>` : ''}
            <td style="border: 1px solid #000; text-align: right; font-weight: bold; padding: ${cellPadding};">${itemTotal ? formatNumber(itemTotal) : '-'}</td>
        </tr>`;
    });

    // 5행 미만일 때만 빈 행 채움
    const remainCount = Math.max(0, 5 - items.length);
    for (let r = 0; r < remainCount; r++) {
        const rowNo = items.length + r + 1;
        itemsRowsHtml += `
        <tr class="item-row empty-row" style="height: 18px;">
            <td style="border: 1px solid #000; text-align: center; padding: 2px;">${rowNo}</td>
            <td style="border: 1px solid #000; padding: 2px 5px;"></td>
            ${cols.includes('규격(단위)') ? '<td style="border: 1px solid #000; padding: 2px;"></td>' : ''}
            ${cols.includes('제조사(원산지)') ? '<td style="border: 1px solid #000; padding: 2px;"></td>' : ''}
            <td style="border: 1px solid #000; padding: 2px;"></td>
            <td style="border: 1px solid #000; padding: 2px 5px;"></td>
            ${cols.includes('공급가액') ? '<td style="border: 1px solid #000; padding: 2px 5px;"></td>' : ''}
            ${cols.includes('세액') ? '<td style="border: 1px solid #000; padding: 2px 5px;"></td>' : ''}
            <td style="border: 1px solid #000; padding: 2px 5px;"></td>
        </tr>`;
    }

    // 모든 tpl-items-tbody 교체
    html = html.replace(/<tbody class="tpl-items-tbody">[\s\S]*?<\/tbody>/g, `<tbody class="tpl-items-tbody">${itemsRowsHtml}</tbody>`);

    return html;
}

// ==========================================
// 5. [양식 저장] 버튼 클릭 시 동작 로직 (우측 목록에 즉시 추가)
// ==========================================
export function saveCurrentDocumentTemplate() {
    const docCanvas = document.getElementById('editable-doc-canvas');
    if (!docCanvas) {
        alert("저장할 서식 내용이 없습니다. 먼저 양식 PDF를 업로드해 주세요.");
        return;
    }

    const defaultTitle = templateBuilderState.activeTemplateTitle || '새 주문서 양식';
    const title = prompt("저장할 주문서 서식의 이름을 입력하세요:", defaultTitle);
    if (!title || !title.trim()) return;

    const trimmedTitle = title.trim();
    const templateHtml = docCanvas.innerHTML;
    const savedForms = JSON.parse(localStorage.getItem('deliveryPro_savedForms') || '[]');

    const newTemplate = {
        id: 'TPL-' + Date.now(),
        title: trimmedTitle,
        templateHtml: templateHtml,
        savedAt: Date.now(),
        isDefault: savedForms.length === 0
    };

    const existingIdx = savedForms.findIndex(f => f.title === trimmedTitle);
    if (existingIdx >= 0) {
        if (!confirm(`'${trimmedTitle}'(으)로 이미 저장된 서식이 있습니다. 덮어쓰시겠습니까?`)) return;
        newTemplate.isDefault = savedForms[existingIdx].isDefault;
        savedForms[existingIdx] = newTemplate;
    } else {
        savedForms.push(newTemplate);
    }

    localStorage.setItem('deliveryPro_savedForms', JSON.stringify(savedForms));
    alert(`[${trimmedTitle}] 서식이 성공적으로 저장되었습니다.\n우측 '저장된 주문서 양식 목록'에 등록되었습니다.`);

    if (window.loadSavedForms) window.loadSavedForms();
}

// ==========================================
// 6. 전역 Window 객체 바인딩
// ==========================================
window.parsePdfToEditableDocument = parsePdfToEditableDocument;
window.renderEditableDocument = renderEditableDocument;
window.insertDocTag = insertDocTag;
window.saveCurrentDocumentTemplate = saveCurrentDocumentTemplate;
window.fillTemplateWithOrderData = fillTemplateWithOrderData;