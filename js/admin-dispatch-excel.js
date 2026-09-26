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
// 🌟 0-1. PDF 파서와 100% 동일한 주소 정밀 절삭 엔진
// ==========================================
export function cleanAddress(rawAddr) {
    if (!rawAddr || typeof rawAddr !== 'string') return '';
    let str = String(rawAddr).trim().replace(/[\r\n]+/g, ' ');

    // 1. 행정구역(시/도) 시작점 감지 (앞단에 붙은 상호, 호수, 불필요한 메모 제거)
    const regionRegex = /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\n\r]*/i;
    const regionMatch = str.match(regionRegex);
    if (!regionMatch) return str;

    let addr = regionMatch[0];

    // 2. 🌟 핵심: '(' 가 인식되면 '(' 와 뒷부분 전체를 즉시 모두 날림 (pdf.js 규칙 이식)
    const parenIdx = addr.indexOf('(');
    if (parenIdx !== -1) {
        addr = addr.slice(0, parenIdx);
    }

    // 3. 다른 필드 라벨이 나오기 전까지만 절단
    addr = addr.split(/(?:연락처|전화|배송지명|간판명|매장명|상호|구매자|No\.|결제)/)[0];

    // 4. 우편번호 및 잔여 잡음 문자 정리
    addr = addr.replace(/\[\d+\]/g, ' ')
               .replace(/받\s*주소/g, ' ')
               .replace(/\b받\b/g, ' ')
               .replace(/\b주소\b/g, ' ')
               .replace(/\|/g, ' ')
               .replace(/[:]/g, ' ')
               .trim();

    // 5. '(' 가 없는 주소인 경우 도로명/지번 번지수 이후 상세 텍스트(층, 호, 건물명 등) 절삭
    const roadMatch = addr.match(/^(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[\s\S]*?(?:로|길|동|읍|면|리|가)\s*[\d\-]+/);
    if (roadMatch) {
        const rest = addr.slice(roadMatch[0].length).trim();
        if (rest && (rest.includes('층') || rest.includes('호') || rest.includes('타워') || rest.includes('빌딩') || rest.includes('센터') || rest.includes('상가') || rest.length > 10)) {
            addr = roadMatch[0].trim();
        }
    }

    return addr.replace(/\s{2,}/g, ' ').trim();
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

    const visibleDrivers = window.getFilteredVisibleDrivers ? window.getFilteredVisibleDrivers() : state.allLicenses.filter(l => l.type !== 'dispatch');

    let html = '';
    state.parsedExcelList.forEach((item, idx) => {
        let driverSelectOptions = `<option value="">-- 미배정 --</option>`;
        visibleDrivers.forEach(d => {
            const dName = d.phone || d.key;
            const isSelected = (item.assignedDriver === dName) ? 'selected' : '';
            driverSelectOptions += `<option value="${dName}" ${isSelected}>${dName}</option>`;
        });

        const driverSelectHtml = `
            <select onchange="window.changeOrderDriver('${item.id}', this.value)" class="w-full bg-white border ${item.assignedDriver ? 'border-blue-400 text-blue-700 bg-blue-50/40' : 'border-gray-300 text-gray-500'} hover:border-blue-500 rounded-lg py-1 px-1.5 text-[11px] font-bold outline-none shadow-2xs cursor-pointer truncate">
                ${driverSelectOptions}
            </select>
        `;

        const coordIcon = (item.lat && item.lng) 
            ? `<i class="fa-solid fa-map-pin text-emerald-500 shrink-0 mt-0.5" title="좌표 확인 완료"></i>` 
            : `<i class="fa-solid fa-triangle-exclamation text-amber-500 shrink-0 mt-0.5" title="좌표 미확인 주소"></i>`;

        const itemCountBadge = (item.items && item.items.length > 1)
            ? `<span class="bg-indigo-50 text-indigo-700 text-[9px] font-black px-1.5 py-0.5 rounded border border-indigo-200 shrink-0">외 ${item.items.length - 1}품목</span>`
            : '';

        // 🌟 title 속성에 원본 전체 주소(fullAddress)를 바인딩하여 마우스 오버 시 상세 확인 가능
        const tooltipAddress = item.fullAddress || item.address || '';

        html += `
        <tr class="hover:bg-blue-50/40 cursor-pointer transition border-b border-gray-100" onclick="window.toggleRowCheckbox(event, ${idx})">
            <td class="text-center w-8" onclick="event.stopPropagation()">
                <input type="checkbox" class="cursor-pointer row-checkbox w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500" data-idx="${idx}">
            </td>
            <td class="text-center font-bold text-gray-500 w-10">${idx + 1}</td>
            <td class="text-center w-36" onclick="event.stopPropagation()">
                ${driverSelectHtml}
            </td>
            <td class="font-bold text-gray-800 break-keep leading-snug py-2.5 px-2" title="${tooltipAddress}">
                <div class="flex items-start gap-1.5">
                    ${coordIcon}
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-1 flex-wrap mb-0.5">
                            ${item.storeName ? `<span class="bg-gray-100 text-gray-800 text-[10px] px-1.5 py-0.5 rounded font-black border border-gray-200">${item.storeName}</span>` : ''}
                            ${itemCountBadge}
                        </div>
                        <span class="text-xs text-gray-900 block font-bold">${item.address || '-'}</span>
                        ${item.phone ? `<span class="text-[10px] text-gray-400 font-normal block mt-0.5"><i class="fa-solid fa-phone text-[9px] mr-1 text-blue-500"></i>${item.phone}</span>` : ''}
                    </div>
                </div>
            </td>
            <td class="text-center w-12" onclick="event.stopPropagation()">
                <button onclick="window.deleteExcelRow(${idx})" class="text-red-400 hover:text-red-600 bg-red-50 hover:bg-red-100 rounded px-2 py-1 transition shadow-sm active:scale-95" title="삭제"><i class="fa-solid fa-trash-can text-[10px]"></i></button>
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
// 3. 범용 스마트 헤더 자동 매핑 및 주문/배송지별 품목 그룹화 파서
// ==========================================
export function processExcelData(jsonData) {
    if (!jsonData || jsonData.length === 0) return [];

    const orderMap = {};

    jsonData.forEach((row, rowIdx) => {
        const keys = Object.keys(row);

        // 1. 전화번호 추출
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

        // 2. 배송지 주소 원본 추출 및 cleanAddress 적용
        let rawAddress = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (!/연락처|전화|명$|코드|번호|쿠폰|금액|출고지/i.test(ck)) {
                if (/배송지주소|기본주소|배송지(?!(명|간판|연락처|전화|코드))|주소|수령지|배달주소|도로명주소/i.test(ck)) {
                    if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                        rawAddress = String(row[k]).trim();
                        break;
                    }
                }
            }
        }
        
        const address = cleanAddress(rawAddress);
        const fullAddress = rawAddress || address;

        // 3. 🌟 상호 / 수령처명 (받으시는 분) 정밀 추출
        let storeName = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (/배송지명|간판명|간판|수령처|상호명|상호|받는분|수령인|수신자|수취인|가게명|매장명/i.test(ck)) {
                if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                    storeName = String(row[k]).trim();
                    break;
                }
            }
        }

        // 4. 🌟 공급자 / 화주명 (발송회사, 위탁처 등) 정밀 추출 (구매자/주문자 배제)
        let senderName = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            // 구매자명, 주문자명 등 주문자 정보는 화주(공급자)로 인식하지 않도록 철저히 분리
            if (/공급자|화주|발송회사|발송자|발송처|판매처|판매자|위탁사|위탁처|쇼핑몰|업체명|보내는분|보내는사람/i.test(ck)) {
                if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                    senderName = String(row[k]).trim();
                    break;
                }
            }
        }

        // 5. 주문번호 추출
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

        // 7. 배송 메모
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

        // 8. 품목명
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

        // 11. 단가 및 결제금액
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

        if (!address && !storeName && !itemName) return;

        // 단가 및 총액 숫자형 변환 (누적 계산용)
        let numPrice = parseInt(String(price).replace(/[^0-9]/g, ''), 10) || 0;
        let numTotal = parseInt(String(total).replace(/[^0-9]/g, ''), 10) || 0;
        
        // 총액이 없고 단가와 수량이 있으면 자동 계산
        if (!numTotal && numPrice && qty) {
            numTotal = numPrice * qty;
        }

        const orderKey = orderNo || `${address}___${storeName}`;
        const itemObj = { 
            name: itemName || '상품명 미지정', 
            qty: qty, 
            unit: unit || '개',
            price: numPrice || price, 
            total: numTotal || total  
        };

        if (orderMap[orderKey]) {
            orderMap[orderKey].items.push(itemObj);
            orderMap[orderKey].qty += qty;
            
            // 주문 전체 합계 금액 누적 갱신
            let currentGrandTotal = parseInt(String(orderMap[orderKey].total).replace(/[^0-9]/g, ''), 10) || 0;
            orderMap[orderKey].total = String(currentGrandTotal + numTotal);

            if (!orderMap[orderKey].phone && phone) orderMap[orderKey].phone = phone;
            if (!orderMap[orderKey].memo && memo) orderMap[orderKey].memo = memo;
            if (!orderMap[orderKey].fullAddress && fullAddress) orderMap[orderKey].fullAddress = fullAddress;
        } else {
            orderMap[orderKey] = {
                id: Date.now() + Math.random(),
                assignedDriver: null,
                senderName: senderName || '공급자 미상',
                orderNo: orderNo || `ORD-${rowIdx + 1}`,
                bizNo: bizNo,
                address: address, // 정제 주소 (내비/관제용)
                fullAddress: fullAddress, // 명세서 인쇄용 원본 전체 주소
                storeName: storeName || '상호 미상', // 상호명이 우선순위가 높도록 조정
                phone: phone,
                itemName: itemName,
                unit: unit || '개',
                qty: qty,
                price: numPrice || price,
                total: numTotal ? String(numTotal) : total, 
                memo: memo,
                lat: null,
                lng: null,
                items: [itemObj]
            };
        }
    });

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
// 4. 통합 드롭존 초기화 및 업로드 처리
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
                parsedPdfOrders.forEach(ord => {
                    if (!ord.fullAddress && ord.address) {
                        ord.fullAddress = ord.address; // 원본 주소 보존
                    }
                    if (ord.address) ord.address = cleanAddress(ord.address);
                });
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
        alert(`[업로드 완료]\n총 ${files.length}개 파일에서 ${newlyAddedList.length}곳의 배송지 데이터가 등록되었습니다.`);
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
// 5. 주소 -> 정밀 좌표(위/경도) 지오코딩 엔진
// ==========================================
function getCoordsFromAddress(address) {
    return new Promise((resolve) => {
        const targetAddr = cleanAddress(address);
        if (!targetAddr || !window.kakao || !window.kakao.maps || !window.kakao.maps.services) { 
            resolve(null); 
            return; 
        }
        const geocoder = new window.kakao.maps.services.Geocoder();

        // 1차: cleanAddress로 정제된 깔끔한 주소로 검색
        geocoder.addressSearch(targetAddr.trim(), (res1, stat1) => {
            if (stat1 === window.kakao.maps.services.Status.OK && res1[0]) {
                const fullAddr = (res1[0].road_address && res1[0].road_address.address_name) 
                    ? res1[0].road_address.address_name 
                    : res1[0].address_name;
                resolve({ lat: parseFloat(res1[0].y), lng: parseFloat(res1[0].x), fullAddress: fullAddr });
            } else {
                // 2차: 도로명+번지수 기본 패턴만으로 재검색
                const basicMatch = targetAddr.match(/^(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[\s\S]*?(?:로|길|동|읍|면|리)\s*[\d\-]+/);
                if (basicMatch) {
                    geocoder.addressSearch(basicMatch[0], (res2, stat2) => {
                        if (stat2 === window.kakao.maps.services.Status.OK && res2[0]) {
                            resolve({ lat: parseFloat(res2[0].y), lng: parseFloat(res2[0].x), fullAddress: res2[0].address_name });
                        } else {
                            resolve(null);
                        }
                    });
                } else {
                    resolve(null);
                }
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
            if (!item.fullAddress) item.fullAddress = item.address;
            item.address = cleanAddress(item.address);
            const coords = await getCoordsFromAddress(item.address);
            if (coords) { 
                item.lat = coords.lat; 
                item.lng = coords.lng; 
                if (coords.fullAddress) {
                    item.address = coords.fullAddress;
                }
            }
            await new Promise(r => setTimeout(r, 40));
        }
    }
    if (dropZone) dropZone.innerHTML = originalDropHtml;
}

// ==========================================
// 6. 테이블 데이터 삭제/초기화 기능
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
    
    state.parsedExcelList = []; 
    renderExcelTable(); 
    await autoSaveExcelToFirebase();

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
window.cleanAddress = cleanAddress;
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