// js/admin-dispatch-template.js

import { state, getLocalDateString } from "./admin-state.js";

// 현재 편집 중인 서식 상태
export const templateBuilderState = {
    activeTemplateId: null,
    activeTemplateTitle: '',
    currentDocHtml: '',
    pdfViewportRatio: 1.414 // A4 표준 비율 (297 / 210)
};

// ==========================================
// 1. PDF 원본 좌표계를 분석하여 1:1 웹 문서 서식으로 정밀 복원
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

        // 1페이지 원본 크기 및 텍스트 벡터 추출
        const page1 = await pdf.getPage(1);
        const viewport = page1.getViewport({ scale: 1.0 });
        const pdfWidth = viewport.width;
        const pdfHeight = viewport.height;
        templateBuilderState.pdfViewportRatio = (pdfHeight / pdfWidth) || 1.414;

        const textContent = await page1.getTextContent({ normalizeWhitespace: true });
        const items = textContent.items;

        if (!items || items.length === 0) {
            alert("PDF 파일에서 텍스트 레이아웃을 감지하지 못했습니다. (텍스트가 포함된 원본 PDF를 업로드해 주세요)");
            return;
        }

        // PDF 좌표계 (좌하단 기준 0,0) -> 웹 문서 좌표계 (상단 기준 %, pt)로 1:1 변환
        let textBlocksHtml = '';
        items.forEach((item, idx) => {
            const str = (item.str || '').trim();
            if (!str) return;

            const transform = item.transform; // [scaleX, skewY, skewX, scaleY, tx, ty]
            const x = transform[4];
            const y = transform[5];

            // 폰트 크기 계산 (기본 10pt 보정)
            const fontSize = Math.max(9, Math.round(Math.sqrt(transform[0] * transform[0] + transform[1] * transform[1]))) || 10;
            
            // 상단 기준 백분율 좌표 변환
            const leftPercent = ((x / pdfWidth) * 100).toFixed(2);
            const topPercent = (((pdfHeight - y - fontSize) / pdfHeight) * 100).toFixed(2);

            textBlocksHtml += `
            <div class="pdf-text-item" 
                 contenteditable="true" 
                 spellcheck="false" 
                 style="position: absolute; left: ${leftPercent}%; top: ${topPercent}%; font-size: ${fontSize}px;" 
                 data-idx="${idx}"
                 title="클릭하여 내용을 수정하거나 불필요한 글자를 지우세요">
                ${escapeHtml(str)}
            </div>`;
        });

        const docTitle = file.name.replace(/\.[^/.]+$/, '').trim() || '신규 주문서 양식';
        templateBuilderState.activeTemplateTitle = docTitle;

        // 원본 PDF 레이아웃이 보존된 웹 서류 문서 컨테이너 생성
        const reconstructedHtml = `
        <div class="doc-sheet pdf-layout-paper" contenteditable="false" style="position: relative; width: 100%; aspect-ratio: ${pdfWidth} / ${pdfHeight}; min-height: 270mm; background: #ffffff;">
            ${textBlocksHtml}
        </div>`;

        templateBuilderState.currentDocHtml = reconstructedHtml;
        renderEditableDocument(reconstructedHtml);

        const titleInput = document.getElementById('input-form-title');
        if (titleInput) titleInput.value = docTitle;

        alert(`[PDF 서류 원본 양식 복원 완료]\n\n업로드하신 PDF의 실제 글자 배치와 서식 구조를 화면에 1:1로 복원했습니다.\n\n화면의 글자를 워드처럼 직접 클릭하여 불필요한 주문내역, 일자, 상호를 지운 뒤 우측의 [양식 저장]을 눌러 기본 서식으로 보관하세요.`);
    } catch (e) {
        console.error("PDF 서식 변환 오류:", e);
        alert("PDF 서식 변환 중 오류가 발생했습니다: " + e.message);
    }
}

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;');
}

// ==========================================
// 2. 워드형 서식 에디터 렌더링 및 편집 툴바
// ==========================================
export function renderEditableDocument(htmlContent) {
    const previewContainer = document.getElementById('inv-view-preview');
    const placeholder = document.getElementById('preview-placeholder');
    const printArea = document.getElementById('print-area');

    if (!previewContainer) return;

    if (placeholder) placeholder.classList.add('hidden');
    if (printArea) printArea.classList.add('hidden');

    let editorWrapper = document.getElementById('doc-editor-wrapper');
    if (!editorWrapper) {
        editorWrapper = document.createElement('div');
        editorWrapper.id = 'doc-editor-wrapper';
        editorWrapper.className = 'w-full flex flex-col items-center gap-3';
        previewContainer.appendChild(editorWrapper);
    }

    // 워드형 편집 툴바: 불필요한 글자를 지우고 자동 치환 태그({{상호명}} 등)를 원클릭 삽입
    editorWrapper.innerHTML = `
        <div class="doc-editor-toolbar flex items-center justify-between w-full max-w-[210mm] bg-white p-2.5 rounded-xl border border-gray-300 shadow-sm sticky top-0 z-30 select-none flex-wrap gap-2">
            <div class="flex items-center gap-1.5 flex-wrap">
                <span class="text-xs font-black text-indigo-700 flex items-center gap-1">
                    <i class="fa-solid fa-pen-nib"></i> 원본 서식 직접 편집 모드
                </span>
                <span class="text-[11px] text-gray-400 font-bold">| 글자를 지우고 아래 태그를 넣으세요:</span>
                <button type="button" onclick="window.insertDocTag('{{상호명}}')" class="px-2 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded text-[11px] font-black transition active:scale-95">+ 상호명</button>
                <button type="button" onclick="window.insertDocTag('{{발송자}}')" class="px-2 py-0.5 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 rounded text-[11px] font-black transition active:scale-95">+ 발송자</button>
                <button type="button" onclick="window.insertDocTag('{{배송지주소}}')" class="px-2 py-0.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded text-[11px] font-black transition active:scale-95">+ 주소</button>
                <button type="button" onclick="window.insertDocTag('{{고객연락처}}')" class="px-2 py-0.5 bg-purple-50 hover:bg-purple-100 text-purple-800 border border-purple-200 rounded text-[11px] font-black transition active:scale-95">+ 전화번호</button>
            </div>
            <div class="flex items-center gap-1.5">
                <button type="button" onclick="window.clearActiveSelection()" class="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold rounded-lg transition active:scale-95">
                    <i class="fa-solid fa-eraser text-[10px]"></i> 선택 삭제
                </button>
            </div>
        </div>
        <div id="editable-doc-canvas" class="doc-canvas-paper shadow-2xl bg-white w-full max-w-[210mm] relative p-6 border border-gray-200">
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

// 태그 원클릭 삽입
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

// 선택된 텍스트 블록 완전 삭제
export function clearActiveSelection() {
    const activeEl = document.activeElement;
    if (activeEl && activeEl.classList.contains('pdf-text-item')) {
        activeEl.remove();
        templateBuilderState.currentDocHtml = document.getElementById('editable-doc-canvas')?.innerHTML || '';
    } else {
        const selection = window.getSelection();
        if (selection && selection.rangeCount) {
            selection.deleteFromDocument();
            templateBuilderState.currentDocHtml = document.getElementById('editable-doc-canvas')?.innerHTML || '';
        } else {
            alert("지우고자 하는 글자 블록을 먼저 클릭해 주세요.");
        }
    }
}

// 호환성용 기본 백지 생성기
export function generateDefaultEditableTemplate() {
    return `<div class="doc-sheet a4-portrait" contenteditable="false" style="padding: 20mm; text-align: center; color: #9ca3af; font-weight: bold; font-size: 13px;">우측에서 양식 PDF를 업로드하면 서식이 이곳에 1:1로 복원됩니다.</div>`;
}

// 호환성용 행 제어
export function addDocTableRow() {}
export function deleteDocTableRow() {}

// ==========================================
// 3. 사용자가 편집 완료한 맞춤 양식 저장
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
    alert(`[${title}] 양식이 성공적으로 저장되었습니다.\n좌측에서 주문을 선택하고 [주문서 일괄 출력]을 실행하면 이 양식에 데이터가 채워져 인쇄됩니다.`);

    if (window.loadSavedForms) window.loadSavedForms();
}

// ==========================================
// 4. 전역 Window 객체 바인딩
// ==========================================
window.parsePdfToEditableDocument = parsePdfToEditableDocument;
window.renderEditableDocument = renderEditableDocument;
window.insertDocTag = insertDocTag;
window.clearActiveSelection = clearActiveSelection;
window.saveCurrentDocumentTemplate = saveCurrentDocumentTemplate;
window.addDocTableRow = addDocTableRow;
window.deleteDocTableRow = deleteDocTableRow;