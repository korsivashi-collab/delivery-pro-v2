// js/admin-dispatch-picking.js

import { state, getLocalDateString } from "./admin-state.js";
import { formatNumber } from "./admin-dispatch-core.js";

// ==========================================
// 🌟 창고 상차 피킹 리스트 모듈 (A4 1페이지 실측 기반 동적 1열/2열 분할 엔진)
// ==========================================

export const pickingModalState = {
    selectedDrivers: new Set()
};

// 기사 식별자(전화번호, 라이선스키, 디바이스ID) 다중 정밀 매칭 헬퍼
function getDriverAssignedOrders(driverIdentifier) {
    if (!driverIdentifier || !state.parsedExcelList || state.parsedExcelList.length === 0) return [];

    const matchedLic = (state.allLicenses || []).find(l => 
        l.phone === driverIdentifier || 
        l.key === driverIdentifier || 
        l.deviceId === driverIdentifier
    );

    const validKeys = new Set([driverIdentifier]);
    if (matchedLic) {
        if (matchedLic.phone) validKeys.add(matchedLic.phone);
        if (matchedLic.key) validKeys.add(matchedLic.key);
        if (matchedLic.deviceId) validKeys.add(matchedLic.deviceId);
    }

    return state.parsedExcelList.filter(o => o.assignedDriver && validKeys.has(o.assignedDriver));
}

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
    
    // 🌟 실제로 배정된 물량이 1건 이상 존재하는 기사만 기본 선택 처리 (잔상 방지)
    uniqueDrivers.forEach(d => {
        const orders = getDriverAssignedOrders(d);
        if (orders.length > 0) {
            pickingModalState.selectedDrivers.add(d);
        }
    });

    const modal = document.getElementById('picking-driver-modal');
    if (modal) modal.classList.remove('hidden');

    renderPickingDriverList(uniqueDrivers);
}

export function closePickingDriverModal() {
    // 🌟 모달 닫을 때 선택 상태를 완전히 초기화하여 잔상 차단
    pickingModalState.selectedDrivers.clear();
    const modal = document.getElementById('picking-driver-modal');
    if (modal) modal.classList.add('hidden');
}

export function toggleAllPickingDrivers(isChecked) {
    const driverNames = new Set();
    const visibleDrivers = window.getFilteredVisibleDrivers ? window.getFilteredVisibleDrivers() : [];
    visibleDrivers.forEach(d => {
        if (d.phone || d.key) driverNames.add(d.phone || d.key);
    });
    (state.parsedExcelList || []).forEach(o => {
        if (o.assignedDriver) driverNames.add(o.assignedDriver);
    });
    const uniqueDrivers = Array.from(driverNames);

    pickingModalState.selectedDrivers.clear();
    if (isChecked) {
        // 배정 물량이 있는 기사만 선택
        uniqueDrivers.forEach(d => {
            if (getDriverAssignedOrders(d).length > 0) {
                pickingModalState.selectedDrivers.add(d);
            }
        });
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
    const visibleDrivers = window.getFilteredVisibleDrivers ? window.getFilteredVisibleDrivers() : [];
    visibleDrivers.forEach(d => {
        if (d.phone || d.key) driverNames.add(d.phone || d.key);
    });
    (state.parsedExcelList || []).forEach(o => {
        if (o.assignedDriver) driverNames.add(o.assignedDriver);
    });
    renderPickingDriverList(Array.from(driverNames));
}

export function renderPickingDriverList(uniqueDrivers) {
    const listEl = document.getElementById('picking-driver-list');
    if (!listEl) return;

    if (!state.parsedExcelList || state.parsedExcelList.length === 0) {
        listEl.innerHTML = `<div class="text-center text-gray-400 py-10 text-xs font-bold"><i class="fa-solid fa-boxes-packing text-3xl text-gray-300 mb-2 block"></i>배정된 배송 주문 데이터가 없습니다.<br>주문 업로드 및 자동할당을 먼저 진행하세요.</div>`;
        const chkAll = document.getElementById('chk-picking-all');
        if (chkAll) chkAll.checked = false;
        return;
    }

    if (!uniqueDrivers || uniqueDrivers.length === 0) {
        listEl.innerHTML = `<div class="text-center text-gray-400 py-6 text-xs font-bold">배정 대상 기사가 없습니다.<br>자동할당을 먼저 진행하세요.</div>`;
        return;
    }

    let html = '';
    let selectableCount = 0;

    uniqueDrivers.forEach(d => {
        const orderCount = getDriverAssignedOrders(d).length;
        const isChecked = pickingModalState.selectedDrivers.has(d) && orderCount > 0;
        if (orderCount > 0) selectableCount++;

        html += `
        <label class="flex items-center justify-between p-3 bg-white border ${isChecked ? 'border-blue-500 bg-blue-50/40 ring-1 ring-blue-300' : 'border-gray-200 hover:bg-gray-50'} rounded-xl cursor-pointer transition shadow-xs">
            <div class="flex items-center gap-3">
                <input type="checkbox" onchange="window.togglePickingDriver('${d}')" ${isChecked ? 'checked' : ''} ${orderCount === 0 ? 'disabled' : ''} class="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer disabled:cursor-not-allowed">
                <div>
                    <span class="font-black text-sm text-gray-900 block leading-tight"><i class="fa-solid fa-truck text-blue-500 mr-1.5 text-xs"></i>${d}</span>
                    <span class="text-[10px] ${orderCount > 0 ? 'text-blue-600 font-bold' : 'text-gray-400 font-normal'}">배정 물량: ${orderCount}건</span>
                </div>
            </div>
            <span class="text-[10px] font-black px-2 py-0.5 rounded-full ${isChecked ? 'bg-blue-600 text-white' : (orderCount > 0 ? 'bg-gray-100 text-gray-500' : 'bg-gray-100 text-gray-300')}">${isChecked ? '선택됨' : (orderCount > 0 ? '제외' : '물량없음')}</span>
        </label>`;
    });
    listEl.innerHTML = html;

    const chkAll = document.getElementById('chk-picking-all');
    if (chkAll) {
        chkAll.checked = (selectableCount > 0 && pickingModalState.selectedDrivers.size === selectableCount);
    }
}

// 피킹 리스트 페이지 내부 HTML 조립 헬퍼
export function buildPickingPageHtml(driverName, driverOrdersCount, aggregatedList, isTwoColumn, dateStr) {
    const totalItemTypes = aggregatedList.length;
    const totalItemQtySum = aggregatedList.reduce((sum, item) => sum + item.totalQty, 0);

    let tableContentHtml = '';

    if (!isTwoColumn) {
        let rowsHtml = '';
        aggregatedList.forEach((item, idx) => {
            rowsHtml += `
            <tr>
                <td class="col-center text-bold">${idx + 1}</td>
                <td class="col-left text-bold">${item.name}</td>
                <td class="col-center">${item.unit}</td>
                <td class="col-right text-black-bold">${formatNumber(item.totalQty)}</td>
                <td class="col-center text-muted">${item.orderCount}곳</td>
                <td class="col-center"><span class="check-box"></span></td>
            </tr>`;
        });

        tableContentHtml = `
        <table class="picking-table single-col-table">
            <colgroup>
                <col style="width: 6%;">
                <col style="width: 52%;">
                <col style="width: 11%;">
                <col style="width: 12%;">
                <col style="width: 10%;">
                <col style="width: 9%;">
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
                ${rowsHtml}
            </tbody>
        </table>`;
    } else {
        const halfPoint = Math.ceil(totalItemTypes / 2);
        const leftList = aggregatedList.slice(0, halfPoint);
        const rightList = aggregatedList.slice(halfPoint);

        const renderSubTableRows = (list, offset) => {
            return list.map((item, i) => `
            <tr>
                <td class="col-center text-bold">${offset + i + 1}</td>
                <td class="col-left text-bold">${item.name}</td>
                <td class="col-center">${item.unit}</td>
                <td class="col-right text-black-bold">${formatNumber(item.totalQty)}</td>
                <td class="col-center text-muted">${item.orderCount}곳</td>
                <td class="col-center"><span class="check-box"></span></td>
            </tr>`).join('');
        };

        tableContentHtml = `
        <div class="two-column-wrapper">
            <div class="col-half">
                <table class="picking-table double-col-table">
                    <colgroup>
                        <col style="width: 8%;">
                        <col style="width: 48%;">
                        <col style="width: 13%;">
                        <col style="width: 13%;">
                        <col style="width: 10%;">
                        <col style="width: 8%;">
                    </colgroup>
                    <thead>
                        <tr>
                            <th>No.</th>
                            <th>상 품 명 (규격)</th>
                            <th>단위</th>
                            <th>수량</th>
                            <th>배송</th>
                            <th>확인</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${renderSubTableRows(leftList, 0)}
                    </tbody>
                </table>
            </div>
            <div class="col-half">
                <table class="picking-table double-col-table">
                    <colgroup>
                        <col style="width: 8%;">
                        <col style="width: 48%;">
                        <col style="width: 13%;">
                        <col style="width: 13%;">
                        <col style="width: 10%;">
                        <col style="width: 8%;">
                    </colgroup>
                    <thead>
                        <tr>
                            <th>No.</th>
                            <th>상 품 명 (규격)</th>
                            <th>단위</th>
                            <th>수량</th>
                            <th>배송</th>
                            <th>확인</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${renderSubTableRows(rightList, halfPoint)}
                    </tbody>
                </table>
            </div>
        </div>`;
    }

    return `
    <div class="print-page ${isTwoColumn ? 'mode-two-col' : 'mode-single-col'}">
        <div class="header-title">창고 상차 피킹 리스트</div>
        <div class="meta-info">
            <span>출력일자: ${dateStr}</span>
            <span class="driver-name-text">담당 기사: <b>${driverName}</b></span>
        </div>
        <div class="summary-box">
            <span>배송처: <b>${driverOrdersCount}</b>곳</span>
            <span>품목 종류: <b>${totalItemTypes}</b>종</span>
            <span>총 수량: <b>${formatNumber(totalItemQtySum)}</b>개</span>
        </div>
        
        <div class="table-container">
            ${tableContentHtml}
        </div>

        <div class="footer-sign">
            <span>상차 기사(${driverName}): <span class="sign-box">(서명)</span></span>
            <span>출고 검수자: <span class="sign-box">(서명)</span></span>
        </div>
    </div>`;
}

// 피킹 인쇄 전용 CSS 스타일
export const pickingPrintStyles = `
    * { box-sizing: border-box; }
    @media print {
        @page { 
            size: A4 portrait; 
            margin: 0; 
        }
        html, body { 
            margin: 0 !important; 
            padding: 0 !important; 
            width: 210mm !important; 
            height: 297mm !important; 
            background: white !important; 
            -webkit-print-color-adjust: exact !important; 
            print-color-adjust: exact !important; 
        }
        .print-page { 
            width: 210mm !important; 
            height: 297mm !important; 
            max-height: 297mm !important; 
            margin: 0 !important; 
            padding: 7mm 8mm 6mm 8mm !important; 
            page-break-after: always !important; 
            page-break-inside: avoid !important; 
            break-after: page !important; 
            overflow: hidden !important; 
            box-sizing: border-box !important; 
            display: flex !important; 
            flex-direction: column !important; 
            justify-content: flex-start !important; 
        }
        .print-page:last-child { 
            page-break-after: auto !important; 
            break-after: auto !important; 
        }
    }
    body { 
        font-family: 'Malgun Gothic', 'Dotum', sans-serif; 
        background: white; 
        margin: 0; 
        padding: 0; 
        color: #1e293b; 
    }
    .print-page { 
        width: 210mm; 
        height: 297mm; 
        max-height: 297mm; 
        margin: 0 auto; 
        padding: 7mm 8mm 6mm 8mm; 
        page-break-after: always; 
        box-sizing: border-box; 
        display: flex; 
        flex-direction: column; 
        justify-content: flex-start; 
        overflow: hidden; 
    }
    .print-page:last-child { 
        page-break-after: auto; 
    }
    .header-title { 
        text-align: center; 
        font-size: 19px; 
        font-weight: 900; 
        letter-spacing: 2px; 
        margin-bottom: 2px; 
        border-bottom: 2.5px double #000; 
        padding-bottom: 3px; 
    }
    .meta-info { 
        display: flex; 
        justify-content: space-between; 
        align-items: flex-end; 
        font-size: 10px; 
        font-weight: bold; 
        margin-bottom: 5px; 
        color: #334155; 
        padding: 0 2px; 
    }
    .driver-name-text { 
        font-size: 12.5px; 
        color: #1e40af; 
    }
    .summary-box { 
        background-color: #f8fafc; 
        border: 1.5px solid #cbd5e1; 
        border-radius: 6px; 
        padding: 4px 10px; 
        display: flex; 
        justify-content: space-around; 
        font-size: 10.5px; 
        font-weight: 900; 
        margin-bottom: 6px; 
        -webkit-print-color-adjust: exact; 
        print-color-adjust: exact; 
    }
    .summary-box span b { 
        color: #2563eb; 
        font-size: 11.5px; 
        margin-left: 3px; 
    }
    .table-container { 
        flex: 1; 
        overflow: hidden; 
        display: flex; 
        flex-direction: column; 
    }
    .picking-table { 
        width: 100%; 
        border-collapse: collapse; 
        border: 1.5px solid #000; 
        font-size: 9.5px; 
        table-layout: fixed; 
    }
    .picking-table th { 
        background-color: #f1f5f9; 
        border: 1px solid #000; 
        padding: 3.5px 3px; 
        font-weight: 900; 
        text-align: center; 
        color: #0f172a; 
        -webkit-print-color-adjust: exact; 
        print-color-adjust: exact; 
    }
    .picking-table td { 
        border: 1px solid #000; 
        padding: 2.8px 4px; 
        vertical-align: middle; 
        line-height: 1.2; 
    }
    .two-column-wrapper { 
        display: flex; 
        gap: 6px; 
        width: 100%; 
        align-items: flex-start; 
    }
    .col-half { 
        flex: 1; 
        min-width: 0; 
    }
    .double-col-table th { 
        padding: 2.5px 2px; 
        font-size: 9px; 
    }
    .double-col-table td { 
        padding: 2px 3px; 
        font-size: 8.5px; 
    }
    .col-center { text-align: center; }
    .col-left { 
        text-align: left; 
        white-space: normal; 
        word-break: break-all; 
    }
    .col-right { text-align: right; }
    .text-bold { font-weight: bold; }
    .text-black-bold { 
        font-weight: 900; 
        color: #1e3a8a; 
    }
    .text-muted { 
        font-weight: bold; 
        color: #64748b; 
    }
    .check-box { 
        display: inline-block; 
        width: 13px; 
        height: 13px; 
        border: 1.2px solid #000; 
        border-radius: 2px; 
    }
    .footer-sign { 
        display: flex; 
        justify-content: flex-end; 
        gap: 25px; 
        margin-top: 6px; 
        padding-top: 4px; 
        border-top: 1px solid #cbd5e1; 
        font-size: 10px; 
        font-weight: bold; 
    }
    .sign-box { 
        border-bottom: 1px solid #000; 
        width: 75px; 
        display: inline-block; 
        text-align: center; 
    }
`;

export function executePickingListPrint() {
    if (pickingModalState.selectedDrivers.size === 0) {
        alert("출력할 기사를 1명 이상 선택해 주세요.");
        return;
    }

    const selectedDriverList = Array.from(pickingModalState.selectedDrivers);
    const dateStr = getLocalDateString();
    let allDriversPagesHtml = '';
    let validPageCount = 0;

    const measureContainer = document.createElement('div');
    measureContainer.style.cssText = 'position:fixed;left:-9999px;top:0;width:210mm;box-sizing:border-box;visibility:hidden;z-index:-999;';
    
    measureContainer.innerHTML = `
        <style>
            ${pickingPrintStyles}
            .print-page { 
                height: auto !important; 
                max-height: none !important; 
                overflow: visible !important; 
            }
        </style>
        <div id="measure-target-inner"></div>
    `;
    document.body.appendChild(measureContainer);
    const measureTarget = measureContainer.querySelector('#measure-target-inner');

    const A4_PAGE_SAFE_HEIGHT_PX = 1020;

    selectedDriverList.forEach((driverName) => {
        const driverOrders = getDriverAssignedOrders(driverName);
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
        validPageCount++;

        const singleColHtml = buildPickingPageHtml(driverName, driverOrders.length, aggregatedList, false, dateStr);
        measureTarget.innerHTML = singleColHtml;

        const pageEl = measureTarget.firstElementChild;
        const actualMeasuredHeight = pageEl ? pageEl.scrollHeight : 0;

        const isOverflow = actualMeasuredHeight > A4_PAGE_SAFE_HEIGHT_PX;

        if (isOverflow) {
            allDriversPagesHtml += buildPickingPageHtml(driverName, driverOrders.length, aggregatedList, true, dateStr);
        } else {
            allDriversPagesHtml += singleColHtml;
        }
    });

    document.body.removeChild(measureContainer);

    if (validPageCount === 0) {
        alert("선택된 기사들에게 배정된 유효한 배송 상품이 없습니다.");
        return;
    }

    const pickingHtml = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>배송 동선 PRO - 기사별 피킹 리스트</title><style>${pickingPrintStyles}</style></head><body>${allDriversPagesHtml}</body></html>`;

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
            }, 1000);
        }, 600);
    };
}

// ==========================================
// Window 전역 객체 바인딩 (HTML 인라인 이벤트용)
// ==========================================
window.openPickingDriverModal = openPickingDriverModal;
window.closePickingDriverModal = closePickingDriverModal;
window.toggleAllPickingDrivers = toggleAllPickingDrivers;
window.togglePickingDriver = togglePickingDriver;
window.executePickingListPrint = executePickingListPrint;
window.printAggregatedItemList = openPickingDriverModal;