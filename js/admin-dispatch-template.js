// js/admin-dispatch-template.js

import { state, getLocalDateString } from "./admin-state.js";

// 현재 편집 중인 서식 상태
export const templateBuilderState = {
    activeTemplateId: null,
    activeTemplateTitle: '기본 주문서 양식',
    currentDocHtml: ''
};

// ==========================================
// 1. PDF 파일을 분석하여 편집 가능한 웹 문서 서식(HTML)으로 변환
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

        // 대표 1페이지의 텍스트와 좌표 추출
        const page1 = await pdf.getPage(1);
        const textContent = await page1.getTextContent();
        
        // 텍스트 블록 정렬 및 공급자/주문 데이터 분석
        const rawItems = textContent.items.map(it => ({
            str: it.str.trim(),
            x: Math.round(it.transform[4]),
            y: Math.round(it.transform[5])
        })).filter(it => it.str.length > 0);

        const pageText = rawItems.map(it => it.str).join(' ');

        // 기본 정보 감지
        const docTitle = file.name.replace(/\.[^/.]+$/, '').trim() || '신규 주문서 양식';
        let detectedRegno = '';
        let detectedName = '';
        let detectedAddr = '';
        let detectedTel = '';

        const bizMatch = pageText.match(/\b\d{3}[-\s]?\d{2}[-\s]?\d{5}\b/);
        if (bizMatch) detectedRegno = bizMatch[0].replace(/\s+/g, '-');

        const telMatch = pageText.match(/(?:0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4})/g);
        if (telMatch && telMatch.length > 0) detectedTel = telMatch[0];

        const addrMatch = pageText.match(/(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\n\r]*?(?:로|길|동|읍|면|가)\s*[\d\-]+/);
        if (addrMatch) detectedAddr = addrMatch[0].trim();

        const storeMatch = pageText.match(/(?:상호|법인명|상호명|공급자)\s*[:|]?\s*([가-힣A-Za-z0-9\(\)\s]{2,20})/);
        if (storeMatch) detectedName = storeMatch[1].trim();

        // 🌟 워드처럼 직접 클릭하여 지우고 수정할 수 있는 구조화된 HTML 서식 템플릿 생성
        const editableDocHtml = generateDefaultEditableTemplate({
            title: docTitle,
            provRegno: detectedRegno,
            provName: detectedName,
            provAddr: detectedAddr,
            provTel: detectedTel
        });

        templateBuilderState.activeTemplateTitle = docTitle;
        templateBuilderState.currentDocHtml = editableDocHtml;

        renderEditableDocument(editableDocHtml);

        // 공급자 입력 필드에도 기본값 동기화
        const titleInput = document.getElementById('input-form-title');
        const regnoInput = document.getElementById('input-prov-regno');
        const nameInput = document.getElementById('input-prov-name');
        const addrInput = document.getElementById('input-prov-addr');
        const telInput = document.getElementById('input-prov-tel');

        if (titleInput) titleInput.value = docTitle;
        if (regnoInput) regnoInput.value = detectedRegno;
        if (nameInput) nameInput.value = detectedName;
        if (addrInput) addrInput.value = detectedAddr;
        if (telInput) telInput.value = detectedTel;

        alert(`[PDF 서류 양식 생성 완료]\n\n업로드된 PDF에서 서식 구조를 읽어와 웹 문서 양식으로 변환했습니다.\n화면의 글자를 워드처럼 직접 클릭하여 불필요한 내용을 지우거나 수정한 뒤 [양식 저장]을 눌러주세요.`);
    } catch (e) {
        console.error("PDF 서식 변환 오류:", e);
        alert("PDF 서식 변환 중 오류가 발생했습니다: " + e.message);
    }
}

// ==========================================
// 2. 편집 가능한 HTML 서식 생성 엔진 (워드형 contenteditable)
// ==========================================
export function generateDefaultEditableTemplate(data = {}) {
    const title = data.title || '주문서';
    const provRegno = data.provRegno || '';
    const provName = data.provName || '';
    const provAddr = data.provAddr || '';
    const provTel = data.provTel || '';

    return `
    <div class="doc-sheet a4-portrait" contenteditable="false">
        <!-- 문서 헤더 -->
        <div class="doc-header">
            <h2 class="doc-main-title" contenteditable="true" spellcheck="false">${title}</h2>
            <div class="doc-meta-row">
                <span class="meta-item">발행일자: <b class="tpl-bind-date" contenteditable="true">${getLocalDateString()}</b></span>
                <span class="meta-item">주문번호: <b class="tpl-bind-orderno" contenteditable="true">ORD-자동부여</b></span>
            </div>
        </div>

        <!-- 공급자 & 공급받는자 정보 테이블 (워드형 직접 수정 가능) -->
        <table class="doc-table party-info-table">
            <colgroup>
                <col style="width: 5%;">
                <col style="width: 15%;">
                <col style="width: 30%;">
                <col style="width: 5%;">
                <col style="width: 15%;">
                <col style="width: 30%;">
            </colgroup>
            <tbody>
                <tr>
                    <th rowspan="4" class="vertical-header" contenteditable="true">공<br>급<br>자</th>
                    <th contenteditable="true">등록번호</th>
                    <td contenteditable="true" spellcheck="false" class="tpl-prov-regno font-bold">${provRegno}</td>
                    <th rowspan="4" class="vertical-header" contenteditable="true">받<br>는<br>분</th>
                    <th contenteditable="true">상호(간판명)</th>
                    <td contenteditable="true" spellcheck="false" class="tpl-bind-store font-black bg-blue-50/50">{{상호명}}</td>
                </tr>
                <tr>
                    <th contenteditable="true">상호(법인명)</th>
                    <td contenteditable="true" spellcheck="false" class="tpl-prov-name">${provName}</td>
                    <th contenteditable="true">발송(화주)</th>
                    <td contenteditable="true" spellcheck="false" class="tpl-bind-sender font-bold bg-amber-50/50">{{발송자}}</td>
                </tr>
                <tr>
                    <th contenteditable="true">사업장 주소</th>
                    <td contenteditable="true" spellcheck="false" class="tpl-prov-addr">${provAddr}</td>
                    <th contenteditable="true">배송 주소</th>
                    <td contenteditable="true" spellcheck="false" class="tpl-bind-addr bg-blue-50/50">{{배송지주소}}</td>
                </tr>
                <tr>
                    <th contenteditable="true">연락처 / TEL</th>
                    <td contenteditable="true" spellcheck="false" class="tpl-prov-tel">${provTel}</td>
                    <th contenteditable="true">전화번호</th>
                    <td contenteditable="true" spellcheck="false" class="tpl-bind-phone bg-blue-50/50">{{고객연락처}}</td>
                </tr>
            </tbody>
        </table>

        <!-- 주문 품목 상세 테이블 -->
        <table class="doc-table item-list-table mt-2">
            <colgroup>
                <col style="width: 7%;">
                <col style="width: 45%;">
                <col style="width: 12%;">
                <col style="width: 12%;">
                <col style="width: 12%;">
                <col style="width: 12%;">
            </colgroup>
            <thead>
                <tr>
                    <th contenteditable="true">No.</th>
                    <th contenteditable="true">품 목 명 (규 격)</th>
                    <th contenteditable="true">단위</th>
                    <th contenteditable="true">수량</th>
                    <th contenteditable="true">단가</th>
                    <th contenteditable="true">금액</th>
                </tr>
            </thead>
            <tbody id="tpl-items-tbody">
                <tr class="item-row">
                    <td class="text-center" contenteditable="true">1</td>
                    <td contenteditable="true" spellcheck="false" class="font-bold">{{상품명}}</td>
                    <td class="text-center" contenteditable="true">개</td>
                    <td class="text-center font-bold" contenteditable="true">{{수량}}</td>
                    <td class="text-right" contenteditable="true">{{단가}}</td>
                    <td class="text-right font-black" contenteditable="true">{{총액}}</td>
                </tr>
                <tr class="item-row empty-row">
                    <td class="text-center" contenteditable="true">2</td>
                    <td contenteditable="true"></td>
                    <td class="text-center" contenteditable="true"></td>
                    <td class="text-center" contenteditable="true"></td>
                    <td class="text-right" contenteditable="true"></td>
                    <td class="text-right" contenteditable="true"></td>
                </tr>
                <tr class="item-row empty-row">
                    <td class="text-center" contenteditable="true">3</td>
                    <td contenteditable="true"></td>
                    <td class="text-center" contenteditable="true"></td>
                    <td class="text-center" contenteditable="true"></td>
                    <td class="text-right" contenteditable="true"></td>
                    <td class="text-right" contenteditable="true"></td>
                </tr>
                <tr class="item-row empty-row">
                    <td class="text-center" contenteditable="true">4</td>
                    <td contenteditable="true"></td>
                    <td class="text-center" contenteditable="true"></td>
                    <td class="text-center" contenteditable="true"></td>
                    <td class="text-right" contenteditable="true"></td>
                    <td class="text-right" contenteditable="true"></td>
                </tr>
            </tbody>
        </table>

        <!-- 하단 비고 및 합계 -->
        <table class="doc-table footer-table mt-2">
            <colgroup>
                <col style="width: 15%;">
                <col style="width: 55%;">
                <col style="width: 15%;">
                <col style="width: 15%;">
            </colgroup>
            <tbody>
                <tr>
                    <th contenteditable="true">배송 메모</th>
                    <td contenteditable="true" spellcheck="false" class="tpl-bind-memo bg-gray-50/50">{{배송요청사항}}</td>
                    <th contenteditable="true">합계 금액</th>
                    <td contenteditable="true" spellcheck="false" class="text-right font-black text-rose-600 tpl-bind-total">{{총금액}}</td>
                </tr>
            </tbody>
        </table>

        <!-- 서명란 -->
        <div class="doc-sign-area mt-4">
            <span contenteditable="true">인수자 확인: ____________________ (서명)</span>
        </div>
    </div>`;
}

// ==========================================
// 3. 서식 화면 렌더링 및 에디터 툴바 제어
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

    // 에디터 상단 툴바 (행 추가, 행 삭제, 서식 초기화)
    editorWrapper.innerHTML = `
        <div class="doc-editor-toolbar flex items-center justify-between w-full max-w-[210mm] bg-white p-2.5 rounded-xl border border-gray-300 shadow-sm sticky top-0 z-20">
            <div class="flex items-center gap-1.5">
                <span class="text-xs font-black text-indigo-700 flex items-center gap-1">
                    <i class="fa-solid fa-pen-nib"></i> 서식 직접 편집 모드
                </span>
                <span class="text-[11px] text-gray-400 font-bold ml-2">| 글자를 직접 클릭하여 불필요한 내용을 지우세요</span>
            </div>
            <div class="flex items-center gap-1.5">
                <button type="button" onclick="window.addDocTableRow()" class="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-bold rounded-lg transition active:scale-95">
                    <i class="fa-solid fa-plus text-[10px]"></i> 품목 행 추가
                </button>
                <button type="button" onclick="window.deleteDocTableRow()" class="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-rose-600 text-xs font-bold rounded-lg transition active:scale-95">
                    <i class="fa-solid fa-minus text-[10px]"></i> 마지막 행 삭제
                </button>
            </div>
        </div>
        <div id="editable-doc-canvas" class="doc-canvas-paper shadow-2xl bg-white">
            ${htmlContent}
        </div>
    `;

    // 에디터 내용 변경 시 실시간 상태 캡처
    const docCanvas = document.getElementById('editable-doc-canvas');
    if (docCanvas) {
        docCanvas.addEventListener('input', () => {
            templateBuilderState.currentDocHtml = docCanvas.innerHTML;
        });
    }
}

export function addDocTableRow() {
    const tbody = document.getElementById('tpl-items-tbody');
    if (!tbody) return;
    const rowCount = tbody.querySelectorAll('tr').length + 1;
    const tr = document.createElement('tr');
    tr.className = 'item-row empty-row';
    tr.innerHTML = `
        <td class="text-center" contenteditable="true">${rowCount}</td>
        <td contenteditable="true"></td>
        <td class="text-center" contenteditable="true"></td>
        <td class="text-center" contenteditable="true"></td>
        <td class="text-right" contenteditable="true"></td>
        <td class="text-right" contenteditable="true"></td>
    `;
    tbody.appendChild(tr);
    templateBuilderState.currentDocHtml = document.getElementById('editable-doc-canvas')?.innerHTML || '';
}

export function deleteDocTableRow() {
    const tbody = document.getElementById('tpl-items-tbody');
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    if (rows.length > 1) {
        rows[rows.length - 1].remove();
        templateBuilderState.currentDocHtml = document.getElementById('editable-doc-canvas')?.innerHTML || '';
    }
}

// ==========================================
// 4. 서식 저장 및 불러오기 엔진
// ==========================================
export function saveCurrentDocumentTemplate() {
    const docCanvas = document.getElementById('editable-doc-canvas');
    if (!docCanvas) {
        alert("저장할 서식 내용이 없습니다. 먼저 PDF를 업로드하거나 양식을 불러와 주세요.");
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
    alert(`[${title}] 양식이 기본 서류 양식으로 성공적으로 저장되었습니다.`);

    if (window.loadSavedForms) window.loadSavedForms();
}

// ==========================================
// 5. 전역 Window 객체 바인딩
// ==========================================
window.parsePdfToEditableDocument = parsePdfToEditableDocument;
window.renderEditableDocument = renderEditableDocument;
window.addDocTableRow = addDocTableRow;
window.deleteDocTableRow = deleteDocTableRow;
window.saveCurrentDocumentTemplate = saveCurrentDocumentTemplate;