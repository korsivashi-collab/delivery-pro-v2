// js/admin-dispatch-excel.js

import { db } from "./admin-api.js";
import { state, todayStr } from "./admin-state.js";
import { processSinglePdfFile } from "./admin-dispatch-pdf.js";
import { doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// ==========================================
// 1. Firebase 엑셀/주문 데이터 연동
// ==========================================
export async function loadExcelFromFirebase() {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey'); 
    if (!dispatchKey) return;
    const dateVal = document.getElementById('dispatch-assign-date')?.value || todayStr;
    try {
        const snap = await getDoc(doc(db, "dispatch_orders", `${dateVal}_${dispatchKey}`));
        state.parsedExcelList = (snap.exists() && snap.data().orders) ? snap.data().orders : []; 
        renderExcelTable();
    } catch (error) {
        console.error("엑셀 데이터 로드 실패:", error);
    }
}

export async function autoSaveExcelToFirebase() {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey'); 
    if (!dispatchKey) return; 
    const dateVal = document.getElementById('dispatch-assign-date')?.value || todayStr; 
    try {
        await setDoc(doc(db, "dispatch_orders", `${dateVal}_${dispatchKey}`), { 
            date: dateVal, 
            dispatchKey: dispatchKey, 
            orders: state.parsedExcelList || [], 
            updatedAt: Date.now() 
        }, { merge: true });
    } catch (error) {
        console.error("엑셀 데이터 자동 저장 실패:", error);
    }
}

// ==========================================
// 2. 엑셀/주문 테이블 화면 렌더링
// ==========================================
export function renderExcelTable() {
    const tbody = document.getElementById('invoice-excel-tbody'); 
    if (!tbody) return;
    if (state.parsedExcelList.length === 0) {
        tbody.innerHTML = `<tr id="empty-excel-row"><td colspan="5" class="text-center py-20"><i class="fa-solid fa-file-excel text-3xl text-gray-300 mb-2 block"></i><span class="text-gray-400 font-bold text-[11px]">업로드된 데이터가 없습니다.</span></td></tr>`;
        const chkAll = document.getElementById('chk-excel-all'); 
        if (chkAll) chkAll.checked = false;
        
        if (window.renderDispatchDriverDetail) window.renderDispatchDriverDetail(); 
        return;
    }

    let html = '';
    state.parsedExcelList.forEach((item, idx) => {
        const assignedBadge = item.assignedDriver 
            ? `<span class="bg-blue-100 text-blue-800 text-[10px] px-2 py-0.5 rounded font-black border border-blue-200">${item.assignedDriver}</span>` 
            : `<span class="bg-gray-100 text-gray-400 text-[10px] px-2 py-0.5 rounded font-bold border border-gray-200">미배정</span>`;
        const coordIcon = (item.lat && item.lng) 
            ? `<i class="fa-solid fa-map-pin text-emerald-500 mr-1" title="위치 확인됨"></i>` 
            : `<i class="fa-solid fa-triangle-exclamation text-amber-400 mr-1" title="좌표 미확인 주소"></i>`;

        html += `
        <tr class="hover:bg-blue-50/50 cursor-pointer transition" onclick="window.toggleRowCheckbox(event, ${idx})">
            <td class="text-center"><input type="checkbox" class="cursor-pointer row-checkbox" data-idx="${idx}"></td>
            <td class="text-center font-bold text-gray-500">${idx + 1}</td>
            <td class="text-center">${assignedBadge}</td>
            <td class="font-bold text-gray-800 truncate max-w-[300px]" title="${item.address}">${coordIcon}${item.address || '-'}</td>
            <td class="text-center" onclick="event.stopPropagation()">
                <button onclick="window.deleteExcelRow(${idx})" class="text-red-400 hover:text-red-600 bg-red-50 hover:bg-red-100 rounded px-2 py-1 transition shadow-sm active:scale-95"><i class="fa-solid fa-trash-can text-[10px]"></i></button>
            </td>
        </tr>`;
    });
    tbody.innerHTML = html;
    
    const chkAll = document.getElementById('chk-excel-all');
    if (chkAll) { 
        chkAll.checked = false; 
        chkAll.onchange = (e) => { 
            const isChecked = e.target.checked; 
            document.querySelectorAll('.row-checkbox').forEach(cb => { cb.checked = isChecked; }); 
        }; 
    }
    if (window.renderDispatchDriverDetail) window.renderDispatchDriverDetail(); 
}

// ==========================================
// 3. 엑셀 데이터 파싱 및 통합 드롭존 (엑셀 & PDF 지원)
// ==========================================
export function processExcelData(jsonData) {
    const newItems = [];
    jsonData.forEach((row) => {
        const mappedRow = { 
            id: Date.now() + Math.random(), 
            assignedDriver: null, 
            senderName: '', 
            orderNo: '', 
            bizNo: '', 
            address: '', 
            storeName: '', 
            phone: '', 
            itemName: '', 
            unit: '', 
            qty: '', 
            price: '', 
            total: '', 
            memo: '', 
            lat: null, 
            lng: null,
            items: [] 
        };
        for (let key in row) {
            const val = row[key]; 
            const k = key.replace(/\s+/g, ''); 
            if (/보내는분|발송자|주문자|고객명/.test(k)) mappedRow.senderName = val;
            else if (/주문번호|오더번호|주문코드/.test(k)) mappedRow.orderNo = val;
            else if (/사업자/.test(k)) mappedRow.bizNo = val;
            else if (/상호|간판|배송지명|받는분|수령인|수신자/.test(k)) mappedRow.storeName = val;
            else if (/주소|배송지(?!(명|간판))/.test(k)) mappedRow.address = val;
            else if (/연락처|전화|핸드폰|휴대폰|폰/.test(k)) mappedRow.phone = val;
            else if (/상품|품목|제품|내역/.test(k)) mappedRow.itemName = val;
            else if (/규격|단위|포장/.test(k)) mappedRow.unit = val;
            else if (/수량|개수|갯수/.test(k)) mappedRow.qty = val;
            else if (/총액|합계|총금액|결제금액/.test(k)) mappedRow.total = val; 
            else if (/단가|가격|금액/.test(k)) mappedRow.price = val; 
            else if (/메모|요청|사항|배송메모/.test(k)) mappedRow.memo = val;
        }

        if (mappedRow.itemName) {
            mappedRow.items.push({
                name: mappedRow.itemName,
                qty: parseInt(mappedRow.qty, 10) || 1,
                unit: mappedRow.unit || '개'
            });
        }

        if (mappedRow.senderName || mappedRow.address || mappedRow.itemName || mappedRow.storeName) {
            newItems.push(mappedRow);
        }
    });

    state.parsedExcelList.push(...newItems); 
    return newItems;
}

export function initExcelDropZone() {
    const dropZone = document.getElementById('excel-drop-zone');
    if (!dropZone || dropZone.dataset.bound === 'true') return;

    let fileInput = document.getElementById('global-excel-file-input');
    if (!fileInput) {
        fileInput = document.createElement('input'); 
        fileInput.id = 'global-excel-file-input'; 
        fileInput.type = 'file'; 
        // 🌟 엑셀(.xlsx, .xls, .csv)과 PDF(.pdf) 모두 수용
        fileInput.accept = '.xlsx, .xls, .csv, .pdf'; 
        fileInput.multiple = true; 
        fileInput.style.display = 'none'; 
        document.body.appendChild(fileInput);
        fileInput.addEventListener('change', window.handleExcelUpload);
    }

    dropZone.addEventListener('dragover', (e) => { 
        e.preventDefault(); 
        dropZone.classList.add('bg-indigo-100', 'border-indigo-500'); 
    });
    dropZone.addEventListener('dragleave', (e) => { 
        e.preventDefault(); 
        dropZone.classList.remove('bg-indigo-100', 'border-indigo-500'); 
    });
    dropZone.addEventListener('drop', (e) => { 
        e.preventDefault(); 
        dropZone.classList.remove('bg-indigo-100', 'border-indigo-500'); 
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) { 
            fileInput.files = e.dataTransfer.files; 
            window.handleExcelUpload({ target: fileInput }); 
        } 
    });
    dropZone.addEventListener('click', () => { fileInput.click(); }); 
    dropZone.dataset.bound = 'true';
}

export async function handleExcelUpload(e) {
    const files = e.target.files; 
    if (!files || files.length === 0) return;

    const newlyAddedList = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';

        if (isPdf) {
            // 🌟 대용량 PDF 분석 실행
            const parsedPdfOrders = await processSinglePdfFile(file);
            if (parsedPdfOrders && parsedPdfOrders.length > 0) {
                state.parsedExcelList.push(...parsedPdfOrders);
                newlyAddedList.push(...parsedPdfOrders);
            }
        } else {
            // 기존 엑셀 파일 파싱 실행
            const parsedExcelOrders = await processSingleExcelFile(file);
            newlyAddedList.push(...parsedExcelOrders);
        }
    }

    if (newlyAddedList.length > 0) {
        renderExcelTable(); 
        await batchGeocodeExcelList(newlyAddedList); 
        renderExcelTable(); 
        await autoSaveExcelToFirebase(); 
        alert(`[업로드 완료]\n총 ${files.length}개 파일에서 ${newlyAddedList.length}건의 주문 데이터가 좌표 변환과 함께 등록되었습니다.`);
    } else { 
        alert(`업로드 완료.\n하지만 올바른 양식의 주문 데이터를 찾을 수 없어 추가된 항목이 없습니다.`); 
    }
    e.target.value = ''; 
}

export function processSingleExcelFile(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = function(evt) {
            try {
                const data = new Uint8Array(evt.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const json = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                resolve(processExcelData(json));
            } catch(err) { 
                resolve([]); 
            }
        };
        reader.readAsArrayBuffer(file);
    });
}

// ==========================================
// 4. 주소 -> 좌표 (위/경도) 변환
// ==========================================
function getCoordsFromAddress(address) {
    return new Promise((resolve) => {
        if (!address || !window.kakao || !window.kakao.maps || !window.kakao.maps.services) { 
            resolve(null); 
            return; 
        }
        const geocoder = new kakao.maps.services.Geocoder();
        geocoder.addressSearch(address.trim(), (result, status) => {
            if (status === kakao.maps.services.Status.OK && result[0]) {
                let fullAddress = result[0].address_name;
                if (result[0].road_address && result[0].road_address.address_name) {
                    fullAddress = result[0].road_address.address_name;
                }
                resolve({ lat: parseFloat(result[0].y), lng: parseFloat(result[0].x), fullAddress: fullAddress });
            } else { 
                resolve(null); 
            }
        });
    });
}

async function batchGeocodeExcelList(items) {
    const dropZone = document.getElementById('excel-drop-zone');
    const originalDropHtml = dropZone ? dropZone.innerHTML : '';
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (dropZone) {
            dropZone.innerHTML = `
                <div class="flex items-center gap-3 text-indigo-600 font-black text-sm">
                    <i class="fa-solid fa-circle-notch fa-spin text-xl"></i>
                    <span>배송지 좌표 분석 중... (${i + 1} / ${items.length})</span>
                </div>`;
        }
        if (item.address && (!item.lat || !item.lng)) {
            const coords = await getCoordsFromAddress(item.address);
            if (coords) { 
                item.lat = coords.lat; 
                item.lng = coords.lng; 
            }
            await new Promise(r => setTimeout(r, 45));
        }
    }
    if (dropZone) dropZone.innerHTML = originalDropHtml;
}

// ==========================================
// 5. 테이블 데이터 삭제/초기화 기능
// ==========================================
export function toggleRowCheckbox(e, idx) {
    if (e && e.target.tagName === 'INPUT') return; 
    const cb = document.querySelector(`.row-checkbox[data-idx="${idx}"]`); 
    if(cb) cb.checked = !cb.checked;
}

export async function deleteExcelRow(idx) {
    if(!confirm("해당 주문건을 리스트에서 삭제하시겠습니까?")) return;
    state.parsedExcelList.splice(idx, 1); 
    renderExcelTable(); 
    await autoSaveExcelToFirebase();
}

export async function deleteSelectedExcelRows() {
    const checkboxes = document.querySelectorAll('.row-checkbox:checked');
    if(checkboxes.length === 0) { 
        alert("삭제할 주문건을 좌측 체크박스에서 1개 이상 선택해주세요."); 
        return; 
    }
    if(!confirm(`선택하신 ${checkboxes.length}개의 주문건을 삭제하시겠습니까?`)) return;
    const indicesToRemove = Array.from(checkboxes).map(cb => parseInt(cb.getAttribute('data-idx')));
    state.parsedExcelList = state.parsedExcelList.filter((_, idx) => !indicesToRemove.includes(idx));
    renderExcelTable(); 
    await autoSaveExcelToFirebase(); 
}

export async function clearAllExcelRows() {
    if(state.parsedExcelList.length === 0) return;
    if(!confirm("업로드된 모든 주문 리스트를 비우시겠습니까?")) return;
    state.parsedExcelList = []; 
    renderExcelTable(); 
    await autoSaveExcelToFirebase();
}

// ==========================================
// 6. 전역 Window 객체 바인딩
// ==========================================
window.loadExcelFromFirebase = loadExcelFromFirebase;
window.autoSaveExcelToFirebase = autoSaveExcelToFirebase;
window.renderExcelTable = renderExcelTable;
window.processExcelData = processExcelData;
window.initExcelDropZone = initExcelDropZone;
window.handleExcelUpload = handleExcelUpload;
window.processSingleExcelFile = processSingleExcelFile;
window.toggleRowCheckbox = toggleRowCheckbox;
window.deleteExcelRow = deleteExcelRow;
window.deleteSelectedExcelRows = deleteSelectedExcelRows;
window.clearAllExcelRows = clearAllExcelRows;