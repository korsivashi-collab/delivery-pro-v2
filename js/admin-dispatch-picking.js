// js/admin-dispatch-picking.js

import { state, getLocalDateString } from "./admin-state.js";
import { formatNumber } from "./admin-dispatch-core.js";

// ==========================================
// 🌟 창고 상차 피킹 리스트 모듈 (A4 1페이지 실측 기반 동적 1열/2열 분할 엔진)
// ==========================================

export const pickingModalState = {
    selectedDrivers: new Set()
};

function getPickingDriverKey(identifier) {
    if (!identifier) return '';
    const lic = (state.allLicenses || []).find(l => l.key === identifier || l.deviceId === identifier);
    return lic?.key || lic?.deviceId || identifier;
}

// 기사 식별자(라이선스키, 디바이스ID) 다중 정밀 매칭 헬퍼
function getDriverAssignedOrders(driverIdentifier) {
    if (!driverIdentifier || !state.parsedExcelList || state.parsedExcelList.length === 0) return [];

    const matchedLic = (state.allLicenses || []).find(l => 
        l.key === driverIdentifier || 
        l.deviceId === driverIdentifier
    );

    const validKeys = new Set([driverIdentifier]);
    if (matchedLic) {
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
        if (d.key) driverNames.add(getPickingDriverKey(d.key));
    });
    
    (state.parsedExcelList || []).forEach(o => {
        if (o.assignedDriver) driverNames.add(getPickingDriverKey(o.assignedDriver));
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
        if (d.key) driverNames.add(getPickingDriverKey(d.key));
    });
    (state.parsedExcelList || []).forEach(o => {
        if (o.assignedDriver) driverNames.add(getPickingDriverKey(o.assignedDriver));
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
    driver = getPickingDriverKey(driver);
    if (pickingModalState.selectedDrivers.has(driver)) {
        pickingModalState.selectedDrivers.delete(driver);
    } else {
        pickingModalState.selectedDrivers.add(driver);
    }
    const driverNames = new Set();
    const visibleDrivers = window.getFilteredVisibleDrivers ? window.getFilteredVisibleDrivers() : [];
    visibleDrivers.forEach(d => {
        if (d.key) driverNames.add(getPickingDriverKey(d.key));
    });
    (state.parsedExcelList || []).forEach(o => {
        if (o.assignedDriver) driverNames.add(getPickingDriverKey(o.assignedDriver));
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
        const license = (state.allLicenses || []).find(l => l.key === d || l.deviceId === d);
        const display = escapePickingHtml(license?.phone || d);
        const isChecked = pickingModalState.selectedDrivers.has(d) && orderCount > 0;
        if (orderCount > 0) selectableCount++;

        html += `
        <label class="flex items-center justify-between p-3 bg-white border ${isChecked ? 'border-blue-500 bg-blue-50/40 ring-1 ring-blue-300' : 'border-gray-200 hover:bg-gray-50'} rounded-xl cursor-pointer transition shadow-xs">
            <div class="flex items-center gap-3">
                <input type="checkbox" onchange="window.togglePickingDriver(${escapePickingHtml(JSON.stringify(d))})" ${isChecked ? 'checked' : ''} ${orderCount === 0 ? 'disabled' : ''} class="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer disabled:cursor-not-allowed">
                <div>
                    <span class="font-black text-sm text-gray-900 block leading-tight"><i class="fa-solid fa-truck text-blue-500 mr-1.5 text-xs"></i>${display}</span>
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

const escapePickingHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pickingText = value => String(value ?? '').trim();
const pickingNumber = value => value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : 1;

// Classification controls placement only. It never controls product identity or merges.
function pickingCategory(item) {
    const supplied = pickingText(item.pickingCategory || item.category);
    if (supplied) return supplied;
    const n = item.name;
    // A small food preset; unsupported industries/products remain unclassified.
    if (/치즈|버터|크림|우유|요거트|간장|소스|기름|식용유|대두유|고추장|된장|쌈장|김치|젓갈|오징어젓|낙지젓|피클|쌈무|절임|단무지|장조림|초생강|치포틀레|무말랭이|아티초크|초밥용|설탕|시럽|분말|마요네즈|케첩|만두|돈가스|어묵|떡볶이|가래떡|떡국떡|쌀떡|스파게티|우동면|라면|김밥김|코코넛밀크|콜라|환타/.test(n)) return '가공·기타';
    if (/새우|오징어|쭈꾸미|주꾸미|낙지|꽃게|고등어|명태|황태|진미채|한치|날치알|쥐포|해초/.test(n)) return '수산';
    if (/소부채살|소다짐육|소불고기|우다짐육|우민찌|돈다짐육|돈민찌|돈삼겹|삼겹살|돈목전지|차돌박이|볼라전각|항정살|닭다리살|닭고기|돼지고기|소고기|특란|대란|왕란|계란/.test(n)) return '축산';
    if (/양파|마늘|오이|양배추|콩나물|버섯|느타리|감자|고구마|대파|고추|토마토|루꼴라|라임|밀가루|신동진|혼합.*쌀|햅쌀|쌀\d|온미.*쌀/.test(n)) return '농산·곡물';
    return '미분류';
}

export function getPickingUnitWeight(item) {
    const explicit = item.unitWeightKg;
    if (explicit !== '' && explicit != null && Number.isFinite(Number(explicit)) && Number(explicit) > 0) return Number(explicit);
    // Tray weights cannot be derived from the weight of a single egg.
    if (/특란|대란|왕란|계란/.test(item.name) && (!item.unit || /판|구|입/.test(item.unit))) return null;
    const match = pickingText(item.spec).match(/^(\d+(?:\.\d+)?)\s*(kg|g)(?:\s*[*x×]\s*(\d+))?$/i);
    if (!match) return null; // Count, volume, ranges and ambiguous packages are not guessed.
    const kg = Number(match[1]) * Number(match[3] || 1) / (match[2].toLowerCase() === 'g' ? 1000 : 1);
    return kg > 0 ? kg : null;
}

export function buildPickingData(orders) {
    const numbers = new Map();
    for (const order of orders) {
        const n = Number(order.displayNumber);
        if (Number.isInteger(n) && n > 0) numbers.set(n, (numbers.get(n) || 0) + 1);
    }
    const items = new Map();
    orders.forEach((order, orderIndex) => {
        const raw = order.items?.length ? order.items : [{name: order.itemName || '상품명 미지정', unit: order.unit, qty: order.qty,
            spec: order.spec, quantityUnit: order.quantityUnit, productCode: order.productCode, pickingCategory: order.pickingCategory}];
        raw.forEach(source => {
            const name = pickingText(source.name) || '기타 품목';
            const legacyUnit = pickingText(source.unit);
            const spec = pickingText(source.spec) || (/\d/.test(legacyUnit) ? legacyUnit : '');
            const unit = pickingText(source.quantityUnit) || (spec && legacyUnit === spec ? '' : legacyUnit);
            const supplier = pickingText(source.supplier || order.senderName);
            const productCode = pickingText(source.productCode || source.sku || source.extra?.품목코드 || source.extra?.제품코드);
            const brand = pickingText(source.brand), grade = pickingText(source.grade);
            const extra = Object.entries(source.extra || {}).sort(([a],[b]) => a.localeCompare(b));
            // Exact identity, including supplier/code/spec/brand/grade/lot. No prefix or fuzzy merging.
            const identity = JSON.stringify([supplier, productCode, name, spec, unit, brand, grade, extra]);
            if (!items.has(identity)) {
                const item = {name, spec, unit, supplier, productCode, brand, grade, extra, totalQty:0, orderCount:0,
                    earlyQuantities: {}, orderIndices:new Set(), unitWeightKg:source.unitWeightKg};
                item.category = pickingCategory({...source, name});
                item.unitWeightKg = getPickingUnitWeight(item);
                items.set(identity, item);
            }
            const item = items.get(identity), qty = pickingNumber(source.qty);
            item.totalQty += qty;
            item.orderIndices.add(orderIndex); // Repeated item lines in one order count once.
            const n = Number(order.displayNumber);
            if (Number.isInteger(n) && n >= 1 && n <= 5 && numbers.get(n) === 1) {
                item.earlyQuantities[n] = (item.earlyQuantities[n] || 0) + qty;
            }
        });
    });
    const nameCounts = new Map();
    for (const item of items.values()) nameCounts.set(item.name,(nameCounts.get(item.name)||0)+1);
    const categoryMass = new Map();
    for (const item of items.values()) {
        item.orderCount = item.orderIndices.size;
        delete item.orderIndices;
        item.showIdentity = nameCounts.get(item.name) > 1;
        item.totalWeightKg = item.unitWeightKg == null ? null : item.unitWeightKg * item.totalQty;
        const group = categoryMass.get(item.category) || {known:false,kg:0};
        if (item.totalWeightKg != null) { group.known = true; group.kg += item.totalWeightKg; }
        categoryMass.set(item.category,group);
    }
    const categories = [...categoryMass].sort(([a,x],[b,y]) => Number(y.known)-Number(x.known) || y.kg-x.kg || a.localeCompare(b,'ko'));
    const categoryOrder = new Map(categories.map(([name],i) => [name,i]));
    const list = [...items.values()].sort((a,b) => categoryOrder.get(a.category)-categoryOrder.get(b.category) ||
        Number(a.totalWeightKg == null)-Number(b.totalWeightKg == null) || (b.totalWeightKg ?? 0)-(a.totalWeightKg ?? 0) || a.name.localeCompare(b.name,'ko') || a.spec.localeCompare(b.spec,'ko'));
    const earlyStops = orders.filter(o => Number(o.displayNumber) >= 1 && Number(o.displayNumber) <= 5 && numbers.get(Number(o.displayNumber)) === 1)
        .sort((a,b) => Number(a.displayNumber)-Number(b.displayNumber)).map(o => ({number:Number(o.displayNumber),name:o.storeName || o.buyerName || '상호 미등록'}));
    return {items:list,earlyStops,hasUnconfirmedSequence:orders.some(o => !Number.isInteger(Number(o.displayNumber)) || Number(o.displayNumber)<1 || numbers.get(Number(o.displayNumber))!==1)};
}

export function buildPickingPageHtml(driverPhone, driverOrdersCount, aggregatedList, isTwoColumn, dateStr, options = {}) {
    const renderRows = (list, offset) => {
        let category = null;
        return list.map((item,i) => {
            let group = '';
            const current = item.category || '미분류';
            if (current !== category) {
                const continued = (i === 0 && options.previousCategory === current && offset === 0) || (i === 0 && offset > 0 && aggregatedList[offset-1]?.category === current);
                group = `<tr class="category-row"><th colspan="6">${escapePickingHtml(current)}${continued ? ' (계속)' : ''}</th></tr>`;
                category = current;
            }
            const note = Object.entries(item.earlyQuantities || {}).sort(([a],[b]) => Number(a)-Number(b))
                .map(([n,q]) => `${String.fromCharCode(0x2460 + Number(n)-1)}:${formatNumber(q)}`).join('<br>');
            const distinguishing = [item.brand && !item.name.includes(item.brand) ? item.brand : '',item.grade && !item.name.includes(item.grade) ? item.grade : '',
                item.showIdentity ? item.supplier : '', item.showIdentity ? item.productCode : '',
                ...(item.extra || []).filter(([k])=>!['품목코드','제품코드'].includes(k)).map(([k,v])=>`${k}: ${v}`)].filter(Boolean).join(' · ');
            return `${group}<tr class="product-row ${(offset+i)%2 ? 'stripe' : ''}" data-picking-item="${offset+i}">
                <td class="col-left product-name">${escapePickingHtml(item.name)}${distinguishing ? `<small class="product-identity">${escapePickingHtml(distinguishing)}</small>` : ''}</td>
                <td class="col-center">${escapePickingHtml(item.spec || '-')}</td>
                <td class="col-center">${escapePickingHtml(item.unit || '-')}</td>
                <td class="col-center quantity">${formatNumber(item.totalQty)}</td>
                <td class="col-center"><span class="check-box"></span></td>
                <td class="col-center early-quantities">${note}</td></tr>`;
        }).join('');
    };
    const table = (list,offset) => `<table class="picking-table"><colgroup><col style="width:49%"><col style="width:12%"><col style="width:8%"><col style="width:9%"><col style="width:7%"><col style="width:15%"></colgroup>
        <thead><tr><th>품목명</th><th>규격</th><th>단위</th><th>수량</th><th>확인</th><th>비고</th></tr></thead><tbody>${renderRows(list,offset)}</tbody></table>`;
    const half = options.splitIndex || Math.ceil(aggregatedList.length / 2);
    const tables = isTwoColumn ? `<div class="two-column-wrapper"><div class="col-half">${table(aggregatedList.slice(0,half),0)}</div><div class="col-half">${table(aggregatedList.slice(half),half)}</div></div>` : table(aggregatedList,0);
    const route = (options.earlyStops || []).map(o => `<span><b>${String.fromCharCode(0x2460+o.number-1)}</b> ${escapePickingHtml(o.name)}</span>`).join('');
    return `<section class="print-page ${isTwoColumn ? 'mode-two-col' : 'mode-single-col'}">
        <header class="picking-header"><div class="picking-heading"><h1>${escapePickingHtml(driverPhone)} - ${escapePickingHtml(dateStr)}</h1>
            <div class="picking-meta">배송 ${driverOrdersCount}건 · 품목 ${options.totalItemTypes ?? aggregatedList.length}종${options.pageNumber ? ` · ${options.pageNumber}페이지` : ''}</div></div>
            <div class="picking-route">${route || '<span class="route-warning">배송 순번 미확정</span>'}</div></header>
        <div class="picking-legend">비고 ①:3 = 1번 배송처에서 해당 단위 3개 하차 · 빈칸 = 초반 5곳 물량 없음${options.hasUnconfirmedSequence ? ' · 순번 미확정 주문은 표시 제외' : ''}</div>
        <div class="table-container">${tables}</div>
        <footer class="footer-sign"><span>중량 미확인 품목은 분류 아래 배치</span><span>상차 확인 __________</span><span>검수 확인 __________</span></footer>
    </section>`;
}

export const pickingPrintStyles = `
    @page { size:A4 portrait; margin:0; }
    * { box-sizing:border-box; }
    html,body { margin:0; padding:0; background:white; color:#172335; font-family:'Malgun Gothic',sans-serif; }
    .print-page { width:210mm; height:297mm; padding:7mm 7mm 6mm; margin:0 auto; display:flex; flex-direction:column; break-after:page; page-break-after:always; }
    .print-page:last-child { break-after:auto; page-break-after:auto; }
    .picking-header { display:grid; grid-template-columns:minmax(0, .95fr) minmax(0, 1.15fr); gap:12px; border-bottom:2px solid #172335; padding-bottom:6px; }
    .picking-heading h1 { margin:0 0 4px; font-size:17px; line-height:1.25; overflow-wrap:anywhere; }
    .picking-meta { font-size:10px; color:#4b5563; }
    .picking-route { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:3px 7px; align-content:center; font-size:10px; line-height:1.25; overflow-wrap:anywhere; }
    .picking-route b { font-size:12px; }
    .route-warning { grid-column:1/-1; }
    .picking-legend { font-size:9px; line-height:1.3; margin:5px 0 6px; }
    .table-container { flex:none; min-width:0; }
    .two-column-wrapper { display:flex; gap:10px; align-items:flex-start; }
    .col-half { flex:1; min-width:0; }
    .picking-table { width:100%; border-collapse:collapse; table-layout:fixed; border:1px solid #aab4c0; font-size:10px; }
    .picking-table th { background:#263345; color:white; font-weight:700; font-size:10px; padding:5px 1px; text-align:center; border-right:1px solid #78818d; }
    .picking-table td { border:1px solid #b8c1cc; padding:4px 3px; line-height:1.2; overflow-wrap:anywhere; vertical-align:middle; }
    .picking-table .product-name { font-size:12pt; font-weight:500; line-height:1.22; }
    .product-identity { display:block; font-size:8px; color:#4b5563; line-height:1.25; margin-top:2px; }
    .picking-table .category-row th { background:#dde2e8; color:#172335; padding:4px 5px; text-align:left; font-size:11px; border:1px solid #b8c1cc; }
    .product-row.stripe { background:#f0f2f4; }
    .quantity { font-size:12pt; font-weight:800; }
    .early-quantities { font-size:11px; font-weight:700; }
    .col-left { text-align:left; white-space:normal; word-break:normal; }
    .col-center { text-align:center; }
    .check-box { display:inline-block; width:11px; height:11px; border:1px solid #172335; }
    .footer-sign { margin-top:auto; padding-top:7px; display:flex; justify-content:space-between; gap:8px; font-size:9px; }
    @media print { html,body { width:210mm; } * { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
`;

export function executePickingListPrint() {
    if (!pickingModalState.selectedDrivers.size) { alert('출력할 기사를 1명 이상 선택해 주세요.'); return; }
    const dateStr = document.getElementById('dispatch-assign-date')?.value || document.getElementById('dispatch-date-picker')?.value || getLocalDateString();
    const measure = document.createElement('iframe');
    measure.style.cssText = 'position:fixed;left:-10000px;top:0;width:210mm;height:297mm;visibility:hidden;border:0;';
    document.body.appendChild(measure);
    let allDriversPagesHtml = '',validDrivers=0;
    try {
        const doc = measure.contentDocument;
        doc.open();doc.write(`<html><head><style>${pickingPrintStyles}.print-page{height:auto!important;min-height:0!important}.footer-sign{margin-top:7px!important}</style></head><body></body></html>`);doc.close();
        const fits = html => { doc.body.innerHTML=html; return doc.body.firstElementChild.getBoundingClientRect().height <= 1122; };
        const selected = new Set([...pickingModalState.selectedDrivers].map(getPickingDriverKey).filter(Boolean));
        for (const key of selected) {
            const orders = getDriverAssignedOrders(key);
            if (!orders.length) continue;
            const license = (state.allLicenses || []).find(l => l.key===key || l.deviceId===key);
            const phone = license?.phone || '전화번호 미등록';
            const data = buildPickingData(orders),list=data.items;
            if (!list.length) continue;
            validDrivers++;
            const opts = {...data,totalItemTypes:list.length};
            const single = buildPickingPageHtml(phone,orders.length,list,false,dateStr,opts);
            if (fits(single)) { allDriversPagesHtml += single; continue; }
            let offset=0,pageNumber=1;
            while (offset<list.length) {
                let low=1,high=list.length-offset,fit=0;
                const options = {...opts,pageNumber,previousCategory:list[offset-1]?.category};
                while (low<=high) {
                    const n=Math.floor((low+high)/2);
                    if (fits(buildPickingPageHtml(phone,orders.length,list.slice(offset,offset+n),true,dateStr,options))) { fit=n;low=n+1; }
                    else high=n-1;
                }
                // Never silently clip or omit an abnormally long single product.
                if (!fit) throw new Error('한 품목의 표시 내용이 A4 한 장을 넘습니다. 상품 정보를 확인해 주세요.');
                allDriversPagesHtml+=buildPickingPageHtml(phone,orders.length,list.slice(offset,offset+fit),true,dateStr,options);
                offset+=fit;pageNumber++;
            }
        }
    } catch (error) { alert(`피킹 리스트를 만들지 못했습니다. ${error.message}`);return; }
    finally { measure.remove(); }
    if (!validDrivers) { alert('선택된 기사들에게 배정된 유효한 배송 상품이 없습니다.');return; }
    const iframe=document.createElement('iframe');
    iframe.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0;z-index:-1;';
    let started=false;
    iframe.onload=()=>{
        if (started) return;started=true;
        setTimeout(()=>{
            if (!iframe.isConnected) return;
            iframe.contentWindow.focus();iframe.contentWindow.print();
            setTimeout(()=>{if(iframe.isConnected)iframe.remove();},1000);
        },600);
    };
    document.body.appendChild(iframe);
    const doc=iframe.contentDocument;
    doc.open();doc.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>피킹 리스트 ${escapePickingHtml(dateStr)}</title><style>${pickingPrintStyles}</style></head><body>${allDriversPagesHtml}</body></html>`);doc.close();
}

window.openPickingDriverModal = openPickingDriverModal;
window.closePickingDriverModal = closePickingDriverModal;
window.toggleAllPickingDrivers = toggleAllPickingDrivers;
window.togglePickingDriver = togglePickingDriver;
window.executePickingListPrint = executePickingListPrint;
window.printAggregatedItemList = openPickingDriverModal;
