// js/admin-dispatch-excel.js

import { db } from "./admin-api.js";
import { state, todayStr } from "./admin-state.js";
import { processSinglePdfFile } from "./admin-dispatch-pdf.js";
import { doc, setDoc, getDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// ==========================================
// 0. 전화번호 복원 및 표준화 헬퍼 (010-XXXX-XXXX)
// ==========================================
export function formatPhoneNumber(val) {
    if (!val) return '';
    const s = String(val).split('.')[0].trim();
    let digits = s.replace(/[^0-9]/g, '');
    if (!digits) return '';

    // 엑셀에서 앞자리 0이 탈락한 10으로 시작하는 번호 복구 (예: 1021219317 -> 01021219317)
    if (digits.length === 10 && digits.startsWith('10')) digits = '0' + digits;
    else if (digits.length === 9 && digits.startsWith('11')) digits = '0' + digits;
    else if (digits.length === 9 && digits.startsWith('16')) digits = '0' + digits;
    else if (digits.length === 9 && digits.startsWith('17')) digits = '0' + digits;
    else if (digits.length === 9 && digits.startsWith('18')) digits = '0' + digits;
    else if (digits.length === 9 && digits.startsWith('19')) digits = '0' + digits;

    if (digits.length === 11 && digits.startsWith('01')) {
        return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    } else if (digits.length === 10) {
        if (digits.startsWith('02')) {
            return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
        } else {
            return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
        }
    } else if (digits.length === 9 && digits.startsWith('02')) {
        return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
    } else if (digits.length === 8) {
        return `${digits.slice(0, 4)}-${digits.slice(4)}`;
    }
    return digits;
}

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

        const itemCountBadge = (item.items && item.items.length > 1)
            ? `<span class="bg-indigo-50 text-indigo-700 text-[9px] font-black px-1.5 py-0.5 rounded border border-indigo-200 ml-1">외 ${item.items.length - 1}품목</span>`
            : '';

        html += `
        <tr class="hover:bg-blue-50/50 cursor-pointer transition" onclick="window.toggleRowCheckbox(event, ${idx})">
            <td class="text-center"><input type="checkbox" class="cursor-pointer row-checkbox" data-idx="${idx}"></td>
            <td class="text-center font-bold text-gray-500">${idx + 1}</td>
            <td class="text-center">${assignedBadge}</td>
            <td class="font-bold text-gray-800 truncate max-w-[300px]" title="${item.address}">
                ${coordIcon}${item.storeName ? `[${item.storeName}] ` : ''}${item.address || '-'}${itemCountBadge}
            </td>
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
// 🌟 3. 범용 스마트 헤더 자동 매핑 및 주문/배송지별 품목 그룹화 파서
// ==========================================
export function processExcelData(jsonData) {
    if (!jsonData || jsonData.length === 0) return [];

    const orderMap = {};

    jsonData.forEach((row, rowIdx) => {
        const keys = Object.keys(row);

        // 1. 전화번호 추출 (우선순위: 배송지/수령인 연락처 > 구매자/주문자 연락처 > 일반 연락처)
        // * '쿠폰', '포인트', '금액' 등 '폰' 단어 오매칭 철저 배제
        let phoneVal = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (/배송지연락처|수령인연락처|수신자연락처|받는분연락처|수취인연락처|배송지전화|수령인전화|수취인전화/i.test(ck)) {
                if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                    phoneVal = String(row[k]).trim();
                    break;
                }
            }
        }
        if (!phoneVal) {
            for (const k of keys) {
                const ck = k.replace(/\s+/g, '');
                if (/구매자연락처|주문자연락처|고객연락처|주문자전화|구매자전화/i.test(ck)) {
                    if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                        phoneVal = String(row[k]).trim();
                        break;
                    }
                }
            }
        }
        if (!phoneVal) {
            for (const k of keys) {
                const ck = k.replace(/\s+/g, '');
                if (!/쿠폰|금액|할인|포인트|비용|번호$/i.test(ck)) {
                    if (/연락처|휴대폰|핸드폰|전화번호|전화|mobile|tel|phone/i.test(ck)) {
                        if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                            phoneVal = String(row[k]).trim();
                            break;
                        }
                    }
                }
            }
        }
        const phone = formatPhoneNumber(phoneVal);

        // 2. 배송지 주소 추출 ('배송지연락처', '출고지', '우편번호' 등 제외)
        let address = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (!/연락처|전화|명$|코드|번호|쿠폰|금액|출고지/i.test(ck)) {
                if (/배송지주소|기본주소|배송지(?!(명|간판|연락처|전화|코드))|주소|수령지|배달주소|도로명주소/i.test(ck)) {
                    if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                        address = String(row[k]).trim();
                        break;
                    }
                }
            }
        }
        // 주소 앞단의 우편번호 [08289] 형태 제거
        address = address.replace(/^\[\d+\]\s*/, '').trim();

        // 3. 상호 / 수령처명 추출
        let storeName = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (/배송지명|간판명|간판|수령처|상호명|상호|받는분|수령인|수신자|가게명|매장명/i.test(ck)) {
                if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                    storeName = String(row[k]).trim();
                    break;
                }
            }
        }

        // 4. 발송자 / 구매자명 추출
        let senderName = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (/구매자명|주문자명|보내는분|발송자|발주자|주문자|구매자/i.test(ck)) {
                if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                    senderName = String(row[k]).trim();
                    break;
                }
            }
        }

        // 5. 주문번호 / 관리번호 추출 ('상품주문번호'보다 '주문번호' 우선 매칭)
        let orderNo = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (!/상품/i.test(ck) && /주문번호|오더번호|주문코드|발주번호|관리번호/i.test(ck)) {
                if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                    orderNo = String(row[k]).trim();
                    break;
                }
            }
        }
        if (!orderNo) {
            for (const k of keys) {
                const ck = k.replace(/\s+/g, '');
                if (/주문번호|오더번호|주문코드/i.test(ck)) {
                    if (row[k] && String(row[k]).trim() !== '') {
                        orderNo = String(row[k]).trim();
                        break;
                    }
                }
            }
        }

        // 6. 사업자등록번호
        let bizNo = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (/사업자번호|사업자등록번호|사업자코드/i.test(ck)) {
                if (row[k]) { bizNo = String(row[k]).trim(); break; }
            }
        }

        // 7. 배송 메모 / 출입문 비밀번호
        let memo = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (/배송위치|출입정보|배송요청|요청사항|배송메모|비고|메모|전달사항/i.test(ck)) {
                if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                    memo = String(row[k]).trim();
                    break;
                }
            }
        }

        // 8. 품목명 ('가격', '금액' 컬럼 제외)
        let itemName = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (!/쿠폰|코드|번호|금액|가격|비용/i.test(ck)) {
                if (/상품명|품목명|품명|제품명|내역/i.test(ck)) {
                    if (row[k] && String(row[k]).trim() !== '') {
                        itemName = String(row[k]).trim();
                        break;
                    }
                }
            }
        }

        // 9. 규격 / 단위
        let unit = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (/규격|단위|용량|포장단위/i.test(ck)) {
                if (row[k]) { unit = String(row[k]).trim(); break; }
            }
        }

        // 10. 수량
        let qty = 1;
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (/수량|개수|주문수량|박스수/i.test(ck)) {
                if (row[k]) {
                    const parsedQty = parseInt(String(row[k]).replace(/[^0-9]/g, ''), 10);
                    if (!isNaN(parsedQty) && parsedQty > 0) qty = parsedQty;
                    break;
                }
            }
        }

        // 11. 단가 및 총 결제금액
        let price = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (!/총|합계|결제|쿠폰|할인/i.test(ck) && /상품가격|단가|판매가|공급가/i.test(ck)) {
                if (row[k]) { price = String(row[k]).trim(); break; }
            }
        }

        let total = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (/총주문금액|총결제금액|결제금액|합계금액|총액|합계/i.test(ck)) {
                if (row[k]) { total = String(row[k]).trim(); break; }
            }
        }

        // 유효 배송지 행이 아니면 건너뜀
        if (!address && !storeName && !itemName) return;

        // 🌟 고유 주문키: 주문번호 기준, 없을 경우 주소+상호 기준 그룹화
        const orderKey = orderNo || `${address}___${storeName}`;
        const itemObj = { 
            name: itemName || '상품명 미지정', 
            qty: qty, 
            unit: unit || '개' 
        };

        if (orderMap[orderKey]) {
            // 동일 주문/배송지: 품목 목록에 추가 및 총 수량 누적
            orderMap[orderKey].items.push(itemObj);
            orderMap[orderKey].qty += qty;
            // 누락된 정보 보강
            if (!orderMap[orderKey].phone && phone) orderMap[orderKey].phone = phone;
            if (!orderMap[orderKey].memo && memo) orderMap[orderKey].memo = memo;
        } else {
            // 신규 주문/배송지 생성
            orderMap[orderKey] = {
                id: Date.now() + Math.random(),
                assignedDriver: null,
                senderName: senderName,
                orderNo: orderNo || `ORD-${rowIdx + 1}`,
                bizNo: bizNo,
                address: address,
                storeName: storeName || senderName || '배송처',
                phone: phone,
                itemName: itemName,
                unit: unit || '개',
                qty: qty,
                price: price,
                total: total,
                memo: memo,
                lat: null,
                lng: null,
                items: [itemObj]
            };
        }
    });

    // 대표 품목명 및 수량 표기 갱신
    const groupedList = Object.values(orderMap);
    groupedList.forEach(order => {
        if (order.items.length > 1) {
            order.itemName = `${order.items[0].name} 외 ${order.items.length - 1}건 (총 ${order.qty}개)`;
        } else if (order.items.length === 1) {
            order.itemName = `${order.items[0].name} (${order.items[0].qty}${order.items[0].unit})`;
        }
    });

    state.parsedExcelList.push(...groupedList);
    return groupedList;
}

// ==========================================
// 4. 통합 드롭존 초기화 및 파일 업로드 처리
// ==========================================
export function initExcelDropZone() {
    const dropZone = document.getElementById('excel-drop-zone');
    if (!dropZone || dropZone.dataset.bound === 'true') return;

    let fileInput = document.getElementById('global-excel-file-input');
    if (!fileInput) {
        fileInput = document.createElement('input'); 
        fileInput.id = 'global-excel-file-input'; 
        fileInput.type = 'file'; 
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
            const parsedPdfOrders = await processSinglePdfFile(file);
            if (parsedPdfOrders && parsedPdfOrders.length > 0) {
                state.parsedExcelList.push(...parsedPdfOrders);
                newlyAddedList.push(...parsedPdfOrders);
            }
        } else {
            const parsedExcelOrders = await processSingleExcelFile(file);
            newlyAddedList.push(...parsedExcelOrders);
        }
    }

    if (newlyAddedList.length > 0) {
        renderExcelTable(); 
        await batchGeocodeExcelList(newlyAddedList); 
        renderExcelTable(); 
        await autoSaveExcelToFirebase(); 
        alert(`[업로드 완료]\n총 ${files.length}개 파일에서 ${newlyAddedList.length}곳의 배송지(다품목 취합 완료)가 좌표 분석과 함께 성공적으로 등록되었습니다.`);
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
                // 🌟 raw: false 적용으로 엑셀 앞자리 0 탈락 및 지수 변환 방지
                const json = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "", raw: false });
                resolve(processExcelData(json));
            } catch(err) { 
                resolve([]); 
            }
        };
        reader.readAsArrayBuffer(file);
    });
}

// ==========================================
// 5. 주소 -> 좌표 (위/경도) 변환
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
// 6. 테이블 데이터 삭제/초기화 기능 (기사 동선 삭제 포함)
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
    if(!confirm("업로드된 모든 주문 리스트와 기사 앱으로 전송된 배송 동선을 모두 완전히 초기화하시겠습니까?")) return;
    
    // 1. 관제 화면의 엑셀 리스트 비우기
    state.parsedExcelList = []; 
    renderExcelTable(); 
    await autoSaveExcelToFirebase();

    // 2. Firebase 'routes' 컬렉션에서 기사들에게 전송된 동선 삭제
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey') || 'MASTER';
    const isMaster = (sessionStorage.getItem('deliveryProRole') === 'MASTER');
    
    let visibleLicenses = state.allLicenses.filter(l => l.type !== 'dispatch');
    if (!isMaster && dispatchKey) {
        visibleLicenses = visibleLicenses.filter(l => l.dispatchKey === dispatchKey);
    }

    let clearCount = 0;
    for (const lic of visibleLicenses) {
        const devId = lic.deviceId || lic.key;
        if (state.activeRoutes && state.activeRoutes[devId]) {
            try {
                await deleteDoc(doc(db, "routes", devId));
                clearCount++;
            } catch (e) {
                console.error(`동선 삭제 실패 (${devId}):`, e);
            }
        }
    }
    
    alert(`전체 초기화가 완료되었습니다.\n(기사 스마트폰 동선 삭제 완료: ${clearCount}명)`);
}

// ==========================================
// 7. 전역 Window 객체 바인딩
// ==========================================
window.formatPhoneNumber = formatPhoneNumber;
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