// js/admin-dispatch-excel.js

import { db, auth } from "./admin-api.js";
import { assignDeliveryNumbers } from './delivery-number.js';
import { state, todayStr } from "./admin-state.js";
import { dispatchNavigationAddress, dispatchOrderReady, trackingLookupKeys } from "./address.js";
import { processSinglePdfFile, batchGeocodePdfList } from "./admin-dispatch-pdf.js";
import { doc, setDoc, getDoc, deleteDoc, runTransaction } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// ==========================================
// 0. 로컬 스토리지 기반 주소 캐시(Cache) 관리 엔진
// ==========================================
// ==========================================
// 0-1. 전화번호 복원 및 표준화 헬퍼 (010-XXXX-XXXX)
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
// 0-2. 주소 정밀 절삭 엔진
// ==========================================
export function cleanAddress(rawAddr) {
    return dispatchNavigationAddress(rawAddr);
}

// ==========================================
// 0-3. 출고지 주소/창고 기반 공급자 매핑 헬퍼
// ==========================================
function extractSenderFromWarehouse(warehouseAddr) {
    if (!warehouseAddr || typeof warehouseAddr !== 'string') return '';
    const clean = warehouseAddr.trim();
    if (!clean || clean === '-') return '';

    const corpMatch = clean.match(/(?:\(?주\)?|주식회사|\b회사\b|\b상사\b|\b유통\b|\b물류\b|\b식품\b|\b푸드\b|\b로지스\b)[가-힣A-Za-z0-9\s]+/);
    if (corpMatch) {
        return corpMatch[0].trim();
    }

    const bracketMatch = clean.match(/[\[\(]([가-힣A-Za-z0-9\s]{2,15})[\]\)]/);
    if (bracketMatch && !/^\d+$/.test(bracketMatch[1]) && !/^(출고|배송|주소|기본|도로|지하)/.test(bracketMatch[1])) {
        return bracketMatch[1].trim();
    }

    let addrWithoutZip = clean.replace(/\[\d+\]/g, '').trim();
    const match = addrWithoutZip.match(/(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)?\s*([가-힣]+(?:시|군|구))\s*([가-힣]+(?:동|읍|면|리|가))/);
    if (match) {
        return `[출고지] ${match[1]} ${match[2]}`;
    }

    const parts = addrWithoutZip.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        return `[출고지] ${parts.slice(0, 2).join(' ')}`;
    }
    return `[출고지] ${clean.slice(0, 15)}`;
}

// ==========================================
// 0-4. 업로드 파일명 기반 공급자명 추출 헬퍼
// ==========================================
function extractSenderFromFileName(fileName) {
    if (!fileName || typeof fileName !== 'string') return '';
    let name = fileName.replace(/\.[^/.]+$/, '').trim();

    if (/^(발송관리|주문관리|배송관리|주문목록|배송목록|주문서|발주서|order|delivery|orders)[\d_\-\s]*$/i.test(name)) {
        return '';
    }

    const bracketMatch = name.match(/^[\[\(\{]([가-힣A-Za-z0-9\s]{2,15})[\]\}\)]/);
    if (bracketMatch) return bracketMatch[1].trim();

    const parts = name.split(/[_\-\s]+/);
    for (const part of parts) {
        const p = part.trim();
        if (p.length >= 2 && !/^\d+$/.test(p) && !/^(발송관리|주문관리|배송관리|주문목록|배송목록|주문서|발주서|order|orders)$/i.test(p)) {
            return p;
        }
    }
    return '';
}

// ==========================================
// 1. Firebase 엑셀/주문 데이터 연동 (다중 패널 동시 갱신 및 완전 동기화)
// ==========================================
export async function loadExcelFromFirebase() {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey'); 
    if (!dispatchKey) return;
    const dateVal = document.getElementById('dispatch-assign-date')?.value || todayStr;
    try {
        const snap = await getDoc(doc(db, "dispatch_orders", `${dateVal}_${dispatchKey}`));
        state.parsedExcelList = (snap.exists() && snap.data().orders) ? snap.data().orders : []; 
        renderExcelTable();
        // 🌟 주문 데이터 변경/초기화 시 기사별 상세 내역 및 배정 목록 실시간 갱신
        if (window.renderDispatchDriverDetail) window.renderDispatchDriverDetail();
        if (window.renderDispatchDriverList) window.renderDispatchDriverList();
    } catch (error) {
        console.error("엑셀 데이터 로드 실패:", error);
    }
}

export async function autoSaveExcelToFirebase() {
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey'); 
    if (!dispatchKey) return; 
    const dateVal = document.getElementById('dispatch-assign-date')?.value || todayStr; 
    try {
        const orderRef = doc(db, "dispatch_orders", `${dateVal}_${dispatchKey}`);
        const orders = state.parsedExcelList || [];
        await runTransaction(db, async transaction => {
            const snapshot = await transaction.get(orderRef);
            const previous = snapshot.exists() ? snapshot.data() : {};
            const now = Date.now();
            // 기존 문서는 마지막 저장 시간을 기준으로 보완하고, 이후 저장으로 수명을 연장하지 않습니다.
            const createdAt = Number.isFinite(previous.createdAt) ? previous.createdAt
                : Number.isFinite(previous.updatedAt) ? previous.updatedAt : now;
            transaction.set(orderRef, {
                date: dateVal,
                dispatchKey: dispatchKey,
                orders,
                trackingLookupKeys: trackingLookupKeys(dateVal,orders),
                createdAt,
                expireAt: new Date(createdAt + 14 * 24 * 60 * 60 * 1000),
                updatedAt: now
            }, { merge: true });
        });
    } catch (error) {
        console.error("엑셀 데이터 자동 저장 실패:", error);
        return false;
    }
    return true;
}

// ==========================================
// 2. 엑셀/주문 테이블 화면 렌더링 (잔상 방지 완전 클리어 및 뱃지 연동)
// ==========================================
export function renderExcelTable() {
    const tbody = document.getElementById('invoice-excel-tbody'); 
    const totalCountBadge = document.getElementById('excel-total-count-badge');
    if (!tbody) return;

    const totalOrdersCount = state.parsedExcelList ? state.parsedExcelList.length : 0;
    if (totalCountBadge) {
        totalCountBadge.innerText = `총 ${totalOrdersCount}건`;
    }

    // 🌟 목록이 0개일 때 모든 테이블 잔상 및 기사별 상세 내역을 즉시 백지화
    if (!state.parsedExcelList || state.parsedExcelList.length === 0) {
        tbody.innerHTML = `<tr id="empty-excel-row"><td colspan="5" class="text-center py-20"><i class="fa-solid fa-file-excel text-3xl text-gray-300 mb-2 block"></i><span class="text-gray-400 font-bold text-[11px]">업로드된 데이터가 없습니다.</span></td></tr>`;
        const chkAll = document.getElementById('chk-excel-all'); 
        if (chkAll) chkAll.checked = false;
        
        if (window.renderDispatchDriverDetail) window.renderDispatchDriverDetail(); 
        if (window.renderDispatchDriverList) window.renderDispatchDriverList();
        return;
    }

    const visibleDrivers = window.getFilteredVisibleDrivers ? window.getFilteredVisibleDrivers() : state.allLicenses.filter(l => l.type !== 'dispatch');

    let html = '';
    state.parsedExcelList.forEach((item, idx) => {
        let driverSelectOptions = `<option value="">-- 미배정 --</option>`;
        visibleDrivers.forEach(d => {
            const dName = d.phone || d.key;
            const isSelected = (item.assignedDriver === d.key) ? 'selected' : '';
            driverSelectOptions += `<option value="${d.key}" ${isSelected}>${dName}</option>`;
        });

        const courseBadge = (item.assignedDriver && item.displayNumber)
            ? `<span class="bg-blue-600 text-white text-[10px] font-black px-1.5 py-0.5 rounded font-mono shrink-0 shadow-2xs" title="${item.assignedDriver} 기사의 ${item.displayNumber}번째 배송지">${item.displayNumber}번</span>`
            : '';

        const driverSelectHtml = `
            <div class="flex items-center gap-1.5 w-full">
                <select onchange="window.changeOrderDriver('${item.id}', this.value)" class="flex-1 min-w-0 bg-white border ${item.assignedDriver ? 'border-blue-400 text-blue-700 bg-blue-50/40' : 'border-gray-300 text-gray-500'} hover:border-blue-500 rounded-lg py-1 px-1.5 text-[11px] font-bold outline-none shadow-2xs cursor-pointer truncate">
                    ${driverSelectOptions}
                </select>
                ${courseBadge}
                
            </div>
        `;

        const coordIcon = dispatchOrderReady(item) 
            ? `<i class="fa-solid fa-map-pin text-emerald-500 shrink-0 mt-0.5" title="좌표 확인 완료"></i>` 
            : `<i class="fa-solid fa-triangle-exclamation text-amber-500 shrink-0 mt-0.5" title="좌표 미확인 주소"></i>`;

        const itemCountBadge = (item.items && item.items.length > 1)
            ? `<span class="bg-indigo-50 text-indigo-700 text-[9px] font-black px-1.5 py-0.5 rounded border border-indigo-200 shrink-0">외 ${item.items.length - 1}품목</span>`
            : '';

        const tooltipAddress = item.fullAddress || item.address || '';

        html += `
        <tr class="hover:bg-blue-50/40 cursor-pointer transition border-b border-gray-100" onclick="window.toggleRowCheckbox(event, ${idx})">
            <td class="text-center w-8" onclick="event.stopPropagation()">
                <input type="checkbox" class="cursor-pointer row-checkbox w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500" data-idx="${idx}">
            </td>
            <td class="text-center font-bold text-gray-500 w-10 font-mono">${idx + 1}</td>
            <td class="text-center w-40" onclick="event.stopPropagation()">
                ${driverSelectHtml}
            </td>
            <td class="font-bold text-gray-800 break-keep leading-snug py-2.5 px-2" title="${tooltipAddress}">
                <div class="flex items-start gap-1.5">
                    ${coordIcon}
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-1 flex-wrap mb-0.5">
                            ${item.storeName ? `<span class="bg-gray-100 text-gray-800 text-[10px] px-1.5 py-0.5 rounded font-black border border-gray-200">${item.storeName}</span>` : ''}
                            ${itemCountBadge}<span class="text-[11px] font-bold text-blue-700">배송번호 ${/^[A-Za-z0-9]{5}$/.test(item.deliveryNumber||'')?item.deliveryNumber:'미발급'}</span>
                        </div>
                        <span class="text-xs text-gray-900 block font-bold">${item.fullAddress || item.address || '-'}${!dispatchOrderReady(item) ? '<span class="block text-red-600">주소·좌표 확인 필요</span>' : ''}</span>
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
            document.querySelectorAll('#invoice-excel-tbody .row-checkbox').forEach(cb => { cb.checked = isChecked; }); 
        }; 
    }
}

// ==========================================
// 3. 범용 스마트 헤더 자동 매핑 및 주문 그룹화 파서
// ==========================================
export function processExcelData(jsonData, fileName = '') {
    if (!jsonData || jsonData.length === 0) return [];

    const orderMap = Object.create(null);

    jsonData.forEach((row, rowIdx) => {
        const aliases = {address:'배송지',shippingaddress:'배송지',deliveryaddress:'배송지',recipient:'받는사람',
            customername:'구매자명',storename:'배송지명',shopname:'배송지명',phone:'배송지연락처',telephone:'배송지연락처',
            orderid:'주문번호',orderno:'주문번호',ordernumber:'주문번호',productname:'상품명',itemname:'상품명',
            quantity:'수량',qty:'수량',unit:'단위',unitprice:'단가',amount:'총액',total:'총액',supplier:'공급자',memo:'배송메모'};
        row = Object.fromEntries(Object.entries(row).map(([key,value])=>[aliases[key.replace(/[\s_-]/g,'').toLowerCase()] || key,value]));
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

        // 2. 배송지 주소 원본 추출
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

        // 3. 상호 / 수령처명 정밀 추출
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

        // 4. 구매자명 정밀 추출
        let buyerName = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (!/연락처|전화|코드|ID/i.test(ck)) {
                if (/구매자명|주문자명|발주자|주문자|구매자|고객명/i.test(ck)) {
                    if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                        buyerName = String(row[k]).trim();
                        break;
                    }
                }
            }
        }

        // 5. 공급자 / 화주명 추출
        let senderName = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (!/쿠폰|금액|할인|포인트|비용|코드|단가|사업자/i.test(ck)) {
                if (/공급자|화주|발송회사|발송자|발송처|판매처|판매자|위탁사|위탁처|쇼핑몰|업체명|공급처|제조사/i.test(ck)) {
                    if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                        senderName = String(row[k]).trim();
                        break;
                    }
                }
            }
        }

        if (!senderName) {
            let rawWarehouse = '';
            for (const k of keys) {
                const ck = k.replace(/\s+/g, '');
                if (/출고지|출하지|발송지|창고|출고창고|출고주소|발송주소|보내는분/i.test(ck)) {
                    if (row[k] && String(row[k]).trim() !== '-' && String(row[k]).trim() !== '') {
                        rawWarehouse = String(row[k]).trim();
                        break;
                    }
                }
            }
            if (rawWarehouse) {
                senderName = extractSenderFromWarehouse(rawWarehouse);
            }
        }

        if (!senderName && fileName) {
            senderName = extractSenderFromFileName(fileName);
        }

        if (!senderName) {
            senderName = '정보 없음';
        }

        // 6. 주문번호 추출
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

        // 7. 사업자등록번호
        let bizNo = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (/사업자번호|사업자등록번호|사업자코드/i.test(ck)) {
                if (row[k]) { bizNo = String(row[k]).trim(); break; }
            }
        }

        // 8. 배송 메모
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

        // 9. 품목명
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

        // 10. 규격 / 단위
        let unit = '';
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (/규격|단위|용량|포장단위/i.test(ck)) {
                if (row[k]) { unit = String(row[k]).trim(); break; }
            }
        }

        // 11. 수량
        let qty = 1;
        for (const k of keys) {
            const ck = k.replace(/\s+/g, '');
            if (/수량|개수|주문수량|박스수/i.test(ck)) {
                if (row[k]) {
                    const parsedQty = Number(String(row[k]).replace(/,/g, '').trim());
                    if (!isNaN(parsedQty) && parsedQty > 0) qty = parsedQty;
                    break;
                }
            }
        }

        // 12. 단가 및 결제금액
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

        let numPrice = parseInt(String(price).replace(/[^0-9]/g, ''), 10) || 0;
        let numTotal = parseInt(String(total).replace(/[^0-9]/g, ''), 10) || 0;
        
        if (!numTotal && numPrice && qty) {
            numTotal = numPrice * qty;
        }

        const orderKey = `${senderName}___${orderNo || address}___${address}___${storeName}`;
        const taxKey = keys.find(k => /^(과세구분|과세여부|세금구분)$/.test(k.replace(/\s+/g,'')));
        const taxType = taxKey ? String(row[taxKey] || '').trim() : '';
        const itemObj = { 
            name: itemName || '상품명 미지정',
            // Preserve legacy unit (= first 규격/단위 column) for invoices and exports.
            // Picking uses separate source fields without changing those consumers.
            spec: String(row[keys.find(k => /^(규격|용량|포장규격)$/.test(k.replace(/\s+/g, '')))] ?? '').trim(),
            quantityUnit: String(row[keys.find(k => /^(단위|수량단위|주문단위|포장단위)$/.test(k.replace(/\s+/g, '')))] ?? '').trim(),
            productCode: String(row[keys.find(k => /^(상품코드|품목코드|제품코드|상품no|SKU)$/i.test(k.replace(/\s+/g, '')))] ?? '').trim(),
            brand: String(row[keys.find(k => /^브랜드$/.test(k.replace(/\s+/g, '')))] ?? row[keys.find(k => /^(제조사|제조업체)$/.test(k.replace(/\s+/g, '')))] ?? '').trim(),
            manufacturer: String(row[keys.find(k => /^(제조사|제조업체|제조원)$/.test(k.replace(/\s+/g, '')))] ?? '').trim(),
            grade: String(row[keys.find(k => /^(등급|상품등급|품질등급)$/.test(k.replace(/\s+/g, '')))] ?? '').trim(),
            pickingCategory: String(row[keys.find(k => /^(대분류|품목분류|상품분류)$/.test(k.replace(/\s+/g, '')))] ?? '').trim(),
            taxType,
            extra: Object.fromEntries(keys.filter(k => /^(품목코드|제품코드|제조번호|로트번호|유효기간|사용기한|보관조건)$/.test(k.replace(/\s+/g,''))).map(k => [k.replace(/\s+/g,''), String(row[k] ?? '')])), 
            qty: qty, 
            unit: unit || '개',
            price: numPrice || price, 
            total: numTotal || total  
        };

        if (orderMap[orderKey]) {
            orderMap[orderKey].items.push(itemObj);
            orderMap[orderKey].qty += qty;
            
            let currentGrandTotal = parseInt(String(orderMap[orderKey].total).replace(/[^0-9]/g, ''), 10) || 0;
            orderMap[orderKey].total = String(currentGrandTotal + numTotal);

            if (!orderMap[orderKey].phone && phone) orderMap[orderKey].phone = phone;
            if (!orderMap[orderKey].memo && memo) orderMap[orderKey].memo = memo;
            if (!orderMap[orderKey].fullAddress && fullAddress) orderMap[orderKey].fullAddress = fullAddress;
        } else {
            orderMap[orderKey] = {
                id: Date.now() + Math.random(),
                assignedDriver: null,
                displayNumber: null,
                senderName: senderName,
                buyerName: buyerName || storeName || '고객',
                orderNo: orderNo || `ORD-${rowIdx + 1}`,
                bizNo: bizNo,
                address: address,
                fullAddress: fullAddress, 
                storeName: storeName || '상호 미상', 
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
    if (window.dispatchAddressBusy || window.isDispatchRouteBusy?.()) { alert("동선 전송이나 초기화가 끝난 후 업로드해 주세요."); return; }
    const files = e.target.files; 
    if (!files || files.length === 0) return;

    window.dispatchAddressBusy = true;
    try {
    if (!state.parsedExcelList) state.parsedExcelList = [];
    const newlyAddedList = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';

        if (isPdf) {
            const parsedPdfOrders = await processSinglePdfFile(file);
            if (parsedPdfOrders && parsedPdfOrders.length > 0) {
                parsedPdfOrders.forEach(ord => {
                    if (!ord.fullAddress && ord.address) {
                        ord.fullAddress = ord.address;
                    }
                    if (ord.address) ord.address = cleanAddress(ord.address);
                });
                newlyAddedList.push(...parsedPdfOrders);
            }
        } else {
            const parsedExcelOrders = await processSingleExcelFile(file);
            if (parsedExcelOrders && parsedExcelOrders.length > 0) {
                newlyAddedList.push(...parsedExcelOrders);
            }
        }
    }

    if (newlyAddedList.length > 0) {
        await assignDeliveryNumbers(newlyAddedList,async ids=>{
            const response=await fetch('/api/delivery-number',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await auth.currentUser.getIdToken()},
                body:JSON.stringify({ids,dispatchKey:sessionStorage.getItem('deliveryProDispatchKey')})});
            const result=await response.json();if(!response.ok)throw Error(result.error||'배송번호 발급 실패');return result;
        });
        state.parsedExcelList.push(...newlyAddedList);
        renderExcelTable(); 
        await batchGeocodeExcelList(newlyAddedList); 
        renderExcelTable(); 
        await autoSaveExcelToFirebase(); 
        alert(`[업로드 완료]\n총 ${files.length}개 파일에서 ${newlyAddedList.length}곳의 배송지 데이터가 등록되었습니다.\n(현재 총 누적: ${state.parsedExcelList.length}곳)`);
    } else { 
        alert(`업로드 완료.\n하지만 올바른 양식의 주문 데이터를 찾을 수 없어 추가된 항목이 없습니다.`); 
    }
    e.target.value = '';
    } catch(error) { alert(error.message || '주문 등록에 실패했습니다. 다시 시도해 주세요.'); }
    finally { window.dispatchAddressBusy = false; }
}

export function processSingleExcelFile(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = function(evt) {
            try {
                const data = new Uint8Array(evt.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const orders = [];
                for (const name of workbook.SheetNames) {
                    const sheet = workbook.Sheets[name];
                    const rows = XLSX.utils.sheet_to_json(sheet, {header:1, defval:'', raw:false});
                    const header = rows.slice(0,30).findIndex(row =>
                        row.some(cell => /배송지|주소|수령지|address/i.test(String(cell))) &&
                        row.some(cell => /상품|품명|품목|제품|수량|주문|product|item|quantity|qty|order/i.test(String(cell))));
                    if (header < 0) continue;
                    const json = XLSX.utils.sheet_to_json(sheet, {range:header, defval:'', raw:false});
                    orders.push(...processExcelData(json, file.name));
                }
                if (!orders.length) alert('배송지와 상품/수량 열을 찾지 못했습니다. 원본 헤더를 확인해 주세요.');
                resolve(orders);
            } catch(err) { 
                resolve([]); 
            }
        };
        reader.readAsArrayBuffer(file);
    });
}

// ==========================================
// 5. 주소 -> 정밀 좌표 지오코딩 엔진 (캐시 및 지수 백오프)
// ==========================================
async function batchGeocodeExcelList(items) {
    return batchGeocodePdfList(items);
}

export async function recheckDispatchAddresses() {
    if (window.dispatchAddressBusy || window.isDispatchRouteBusy?.()) { alert('현재 작업이 끝난 후 다시 시도해 주세요.'); return; }
    const items = state.parsedExcelList || [];
    if (!items.length) { alert('확인할 주문이 없습니다.'); return; }
    const before = items.map(o => [o.lat, o.lng]);
    window.dispatchAddressBusy = true;
    const dateInput = document.getElementById('dispatch-assign-date');
    const dateDisabled = dateInput?.disabled;
    if (dateInput) dateInput.disabled = true;
    const button = document.getElementById('btn-recheck-dispatch-addresses');
    if (button) button.disabled = true;
    try {
        await batchGeocodePdfList(items);
        if (items.some((o,i) => o.lat !== before[i][0] || o.lng !== before[i][1])) {
            items.forEach(o => { delete o.assignedDriver; delete o.displayNumber; });
        }
        renderExcelTable();
        window.renderDispatchDriverList?.();
        window.renderDispatchDriverDetail?.();
        await autoSaveExcelToFirebase();
        const failed = items.filter(item => !dispatchOrderReady(item)).length;
        alert(failed ? '주소·좌표 확인이 필요한 주문이 ' + failed + '건 있습니다. 목록의 원문 주소를 확인해 주세요.' : '전체 ' + items.length + '건의 주소·좌표를 확인했습니다. 자동할당을 다시 실행해 주세요.');
    } catch (error) { alert('주소 확인 중 오류: ' + error.message); }
    finally { window.dispatchAddressBusy = false; if (button) button.disabled = false; if (dateInput) dateInput.disabled = dateDisabled; }
}
window.recheckDispatchAddresses = recheckDispatchAddresses;

// ==========================================
// 6. 테이블 데이터 삭제/초기화 기능 (다중 뷰 실시간 동기화 및 메모리 잔상 방지)
// ==========================================
export function toggleRowCheckbox(e, idx) {
    if (e && e.target.tagName === 'INPUT') return; 
    const cb = document.querySelector(`.row-checkbox[data-idx="${idx}"]`); 
    if(cb) cb.checked = !cb.checked;
}

export async function deleteExcelRow(idx) {
    if (window.dispatchAddressBusy) { alert("주소 확인이 끝난 후 삭제해 주세요."); return; }
    if(!confirm("해당 주문건을 리스트에서 삭제하시겠습니까?")) return;
    state.parsedExcelList.splice(idx, 1); 
    renderExcelTable(); 
    if (window.renderDispatchDriverDetail) window.renderDispatchDriverDetail();
    if (window.renderDispatchDriverList) window.renderDispatchDriverList();
    await autoSaveExcelToFirebase();
}

export async function deleteSelectedExcelRows() {
    if (window.dispatchAddressBusy) { alert("주소 확인이 끝난 후 삭제해 주세요."); return; }
    const checkboxes = document.querySelectorAll('#invoice-excel-tbody .row-checkbox:checked');
    if(checkboxes.length === 0) { 
        alert("삭제할 주문건을 좌측 체크박스에서 1개 이상 선택해주세요."); 
        return; 
    }
    if(!confirm(`선택하신 ${checkboxes.length}개의 주문건을 삭제하시겠습니까?`)) return;
    const indicesToRemove = Array.from(checkboxes).map(cb => parseInt(cb.getAttribute('data-idx')));
    state.parsedExcelList = state.parsedExcelList.filter((_, idx) => !indicesToRemove.includes(idx));
    renderExcelTable(); 
    if (window.renderDispatchDriverDetail) window.renderDispatchDriverDetail();
    if (window.renderDispatchDriverList) window.renderDispatchDriverList();
    await autoSaveExcelToFirebase(); 
}

export async function clearAllExcelRows() {
    // 동일한 취소 기록을 남겨 오프라인 기사 단말기의 이전 경로 복원을 방지한다.
    if (typeof window.revertAutoDispatch !== 'function') {
        alert('동선 초기화 기능을 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.');
        return;
    }
    await window.revertAutoDispatch({ clearOrders: true });
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
