// js/admin-dispatch-search.js

import { state, getLocalDateString, todayStr } from "./admin-state.js";
import { setDispatchMode, selectDriver } from "./admin-dispatch-core.js";
import { focusMapPosition } from "./admin-map.js";

let currentSearchQuery = '';
let currentSearchRangeMode = 'today'; 
let currentSearchCustomStart = '';
let currentSearchCustomEnd = '';

function ensureSearchSidePanel() {
    let sidePanel = document.getElementById('search-result-side-panel');
    if (!sidePanel) {
        const mapSec = document.getElementById('map-section');
        if (mapSec) {
            sidePanel = document.createElement('div');
            sidePanel.id = 'search-result-side-panel';
            sidePanel.className = 'absolute top-0 right-0 h-full w-1/2 max-w-[500px] min-w-[340px] bg-white shadow-2xl z-[400] transform translate-x-full transition-transform duration-300 flex flex-col border-l border-gray-200';
            sidePanel.innerHTML = `
                <div class="px-5 py-3.5 border-b border-gray-200 bg-gray-50 flex justify-between items-center flex-none">
                    <div>
                        <h3 class="font-black text-gray-900 text-sm flex items-center gap-2">
                            <i class="fa-solid fa-magnifying-glass text-blue-600"></i> 통합 검색 결과
                        </h3>
                        <p class="text-[11px] text-gray-500 font-bold mt-0.5">배송지 및 배정 기사 현황</p>
                    </div>
                    <button onclick="window.closeSearchSidePanel()" class="text-gray-400 hover:text-gray-700 bg-white border border-gray-200 rounded-lg p-1.5 shadow-sm transition active:scale-95">
                        <i class="fa-solid fa-xmark text-lg px-1"></i>
                    </button>
                </div>
                <div id="search-range-toolbar" class="px-4 py-2.5 bg-white border-b border-gray-200 flex-none"></div>
                <div id="search-result-content" class="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50 custom-scrollbar"></div>
            `;
            mapSec.appendChild(sidePanel);
        }
    }
    return sidePanel;
}

export function closeSearchSidePanel() {
    const sidePanel = document.getElementById('search-result-side-panel');
    if (sidePanel) sidePanel.classList.add('translate-x-full');
    clearSearchInput();
}

export function clearSearchInput() {
    const input = document.getElementById('global-search-input');
    if (input) input.value = '';
    const sidePanel = document.getElementById('search-result-side-panel');
    if (sidePanel) sidePanel.classList.add('translate-x-full');
    const clearBtn = document.getElementById('search-clear-btn');
    if (clearBtn) clearBtn.classList.add('hidden');
    currentSearchQuery = '';
    currentSearchRangeMode = 'today';
}

export function jumpToDeliveryTarget(devId, lat, lng, dateStr) {
    const sidePanel = document.getElementById('search-result-side-panel');
    if (sidePanel) sidePanel.classList.add('translate-x-full');
    clearSearchInput();
    if (dateStr) {
        const picker = document.getElementById('dispatch-date-picker');
        if (picker) picker.value = dateStr;
    }
    setDispatchMode('DELIVERY', true);
    if (devId) selectDriver(devId);
    if (lat && lng && focusMapPosition) focusMapPosition(lat, lng);
}

export function inspectDriverRoute(devId, dateStr) {
    if (!devId || devId === '미배정') {
        alert("배정된 기사 정보가 없는 주문건입니다.");
        return;
    }

    const matched = state.allLicenses.find(l => 
        l.deviceId === devId || 
        l.key === devId || 
        (l.phone && l.phone === devId) ||
        (l.phone && devId.includes(l.phone))
    );
    const targetDevId = matched ? (matched.deviceId || matched.key) : devId;

    setDispatchMode('DELIVERY', true);

    if (dateStr) {
        const picker = document.getElementById('dispatch-date-picker');
        if (picker) picker.value = dateStr;
    }

    selectDriver(targetDevId);

    const sidePanel = document.getElementById('search-result-side-panel');
    if (sidePanel) sidePanel.classList.add('translate-x-full');
}

export function viewSearchCompletionPhoto(imgUrl, addr, phone, time) {
    let modal = document.getElementById('dispatch-search-photo-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'dispatch-search-photo-modal';
        modal.className = 'fixed inset-0 bg-black/80 z-[800] flex items-center justify-center p-4 backdrop-blur-sm';
        modal.onclick = () => modal.classList.add('hidden');
        modal.innerHTML = `
            <div class="bg-white rounded-3xl overflow-hidden shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col" onclick="event.stopPropagation()">
                <div class="p-4 border-b border-gray-200 flex justify-between items-center bg-gray-50">
                    <div class="min-w-0 pr-2">
                        <h4 id="disp-photo-addr" class="font-black text-sm text-gray-900 truncate leading-snug"></h4>
                        <p id="disp-photo-sub" class="text-[11px] text-gray-500 font-bold mt-0.5"></p>
                    </div>
                    <button onclick="document.getElementById('dispatch-search-photo-modal').classList.add('hidden')" class="w-8 h-8 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-700 flex items-center justify-center transition">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="flex-1 overflow-auto bg-black flex items-center justify-center p-2 min-h-[300px]">
                    <img id="disp-photo-img" src="" alt="배송 완료 사진" class="max-h-[65vh] max-w-full object-contain rounded-lg">
                </div>
                <div class="p-3 bg-white border-t border-gray-100 flex justify-between items-center text-xs">
                    <span class="bg-emerald-100 text-emerald-800 px-2.5 py-1 rounded-full font-black">배송 완료 사진</span>
                    <a id="disp-photo-link" href="#" target="_blank" class="bg-blue-600 hover:bg-blue-700 text-white font-black px-3.5 py-1.5 rounded-xl transition flex items-center gap-1.5 shadow-sm">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> 원본 새창 보기
                    </a>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    document.getElementById('disp-photo-addr').innerText = addr || '주소 정보 없음';
    document.getElementById('disp-photo-sub').innerText = `${phone || '기사'} | ${time || ''}`;
    document.getElementById('disp-photo-img').src = imgUrl;
    document.getElementById('disp-photo-link').href = imgUrl;
    modal.classList.remove('hidden');
}

function isTargetDateInRange(dStr, mode, customStart, customEnd) {
    if (!dStr) return false;
    if (mode === 'today') return dStr === todayStr;

    const now = new Date();
    const targetDate = new Date(dStr);
    if (isNaN(targetDate.getTime())) return false;

    if (mode === '7days') {
        const past = new Date();
        past.setDate(now.getDate() - 7);
        past.setHours(0, 0, 0, 0);
        return targetDate >= past;
    } else if (mode === '30days') {
        const past = new Date();
        past.setDate(now.getDate() - 30);
        past.setHours(0, 0, 0, 0);
        return targetDate >= past;
    } else if (mode === 'custom') {
        if (!customStart || !customEnd) return true;
        return dStr >= customStart && dStr <= customEnd;
    }
    return true;
}

export function setSearchRangeMode(mode) {
    currentSearchRangeMode = mode;
    handleGlobalSearch(currentSearchQuery, false);
}

export function applyCustomSearchRange() {
    const sInput = document.getElementById('search-custom-start');
    const eInput = document.getElementById('search-custom-end');
    if (!sInput?.value || !eInput?.value) {
        alert("시작일과 종료일을 모두 선택해 주세요.");
        return;
    }
    if (sInput.value > eInput.value) {
        alert("시작일이 종료일보다 클 수 없습니다.");
        return;
    }
    currentSearchCustomStart = sInput.value;
    currentSearchCustomEnd = eInput.value;
    currentSearchRangeMode = 'custom';
    handleGlobalSearch(currentSearchQuery, false);
}

export function resetSearchToToday() {
    currentSearchRangeMode = 'today';
    currentSearchCustomStart = '';
    currentSearchCustomEnd = '';
    handleGlobalSearch(currentSearchQuery, false);
}

export function handleGlobalSearch(query, isNewSearch = true) {
    const sidePanel = ensureSearchSidePanel();
    const contentEl = document.getElementById('search-result-content');
    const toolbarEl = document.getElementById('search-range-toolbar');
    const clearBtn = document.getElementById('search-clear-btn');
    
    if (isNewSearch) {
        currentSearchQuery = (query || '').trim();
        currentSearchRangeMode = 'today';
    }

    const q = currentSearchQuery.toLowerCase();
    const qDigits = q.replace(/[^0-9]/g, ''); // 🌟 번호 숫자만 추출하여 하이픈 무시 검색 지원

    if (!q) { 
        if (sidePanel) sidePanel.classList.add('translate-x-full'); 
        if (clearBtn) clearBtn.classList.add('hidden'); 
        return; 
    }
    if (clearBtn) clearBtn.classList.remove('hidden');

    if (toolbarEl) {
        let rangeLabel = '';
        if (currentSearchRangeMode === 'today') rangeLabel = `<span class="bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-black text-[11px]">오늘 (${todayStr})</span>`;
        else if (currentSearchRangeMode === '7days') rangeLabel = `<span class="bg-purple-100 text-purple-800 px-2 py-0.5 rounded font-black text-[11px]">최근 1주일</span>`;
        else if (currentSearchRangeMode === '30days') rangeLabel = `<span class="bg-purple-100 text-purple-800 px-2 py-0.5 rounded font-black text-[11px]">최근 1달</span>`;
        else rangeLabel = `<span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-black text-[11px]">${currentSearchCustomStart} ~ ${currentSearchCustomEnd}</span>`;

        toolbarEl.innerHTML = `
            <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between text-xs">
                    <span class="font-bold text-gray-600 flex items-center gap-1.5">
                        <i class="fa-regular fa-calendar-check text-blue-600"></i> 조회 범위: ${rangeLabel}
                    </span>
                    ${currentSearchRangeMode !== 'today' ? `
                    <button onclick="window.resetSearchToToday()" class="text-[11px] font-black text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-0.5 rounded border border-blue-200 transition">
                        <i class="fa-solid fa-rotate-left mr-0.5"></i> 오늘만 보기
                    </button>` : ''}
                </div>
                <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="text-[10px] text-gray-400 font-bold shrink-0">과거 내역:</span>
                    <button onclick="window.setSearchRangeMode('7days')" class="px-2.5 py-1 rounded-lg text-[11px] font-bold transition shadow-2xs ${currentSearchRangeMode === '7days' ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}">최근 1주일</button>
                    <button onclick="window.setSearchRangeMode('30days')" class="px-2.5 py-1 rounded-lg text-[11px] font-bold transition shadow-2xs ${currentSearchRangeMode === '30days' ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}">최근 1달</button>
                    <button onclick="document.getElementById('custom-range-box').classList.toggle('hidden')" class="px-2.5 py-1 rounded-lg text-[11px] font-bold transition shadow-2xs ${currentSearchRangeMode === 'custom' ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}">기간 설정</button>
                </div>
                <div id="custom-range-box" class="${currentSearchRangeMode === 'custom' ? 'flex' : 'hidden'} items-center gap-1.5 bg-gray-50 p-2 rounded-xl border border-gray-200 mt-1">
                    <input type="date" id="search-custom-start" value="${currentSearchCustomStart || todayStr}" class="bg-white border border-gray-300 rounded px-1.5 py-1 text-[11px] font-bold outline-none cursor-pointer flex-1">
                    <span class="text-xs text-gray-400 font-bold">~</span>
                    <input type="date" id="search-custom-end" value="${currentSearchCustomEnd || todayStr}" class="bg-white border border-gray-300 rounded px-1.5 py-1 text-[11px] font-bold outline-none cursor-pointer flex-1">
                    <button onclick="window.applyCustomSearchRange()" class="bg-slate-800 hover:bg-slate-900 text-white text-[11px] font-black px-2.5 py-1 rounded transition shadow-2xs">조회</button>
                </div>
            </div>
        `;
    }

    const addressGroups = {};

    // 1. 활성 동선(routes) 데이터 매칭 (고객/기사 번호 분리 처리)
    for (let devId in state.activeRoutes) {
        const r = state.activeRoutes[devId];
        const dests = r.destinations || [];
        const driverPhone = r.phone || '기사';
        const driverDigits = driverPhone.replace(/[^0-9]/g, '');

        dests.forEach(d => {
            const customerPhone = d.phone || '';
            const customerDigits = customerPhone.replace(/[^0-9]/g, '');
            
            const matchesAddr = d.address && d.address.toLowerCase().includes(q);
            const matchesFull = d.fullAddress && d.fullAddress.toLowerCase().includes(q);
            const matchesStore = d.storeName && d.storeName.toLowerCase().includes(q);
            
            // 🌟 하이픈 무시 전화번호 매칭 강화
            let matchesPhone = driverPhone.includes(q) || customerPhone.includes(q);
            if (!matchesPhone && qDigits.length >= 4) {
                if (driverDigits.includes(qDigits) || customerDigits.includes(qDigits)) {
                    matchesPhone = true;
                }
            }
            
            if (matchesAddr || matchesFull || matchesStore || matchesPhone) {
                if (isTargetDateInRange(todayStr, currentSearchRangeMode, currentSearchCustomStart, currentSearchCustomEnd)) {
                    const addrKey = (d.address || d.fullAddress || '').trim();
                    if (!addressGroups[addrKey]) addressGroups[addrKey] = [];
                    addressGroups[addrKey].push({
                        type: 'PENDING', 
                        address: d.address || d.fullAddress, 
                        storeName: d.storeName || '',
                        dateStr: todayStr, 
                        timeStr: '이동/대기 중',
                        driverPhone: driverPhone, 
                        customerPhone: customerPhone, // 🌟 고객 번호 누락 복구
                        devId: devId, 
                        lat: d.lat, 
                        lng: d.lng, 
                        displayNumber: d.displayNumber, 
                        timestamp: Date.now()
                    });
                }
            }
        });
    }

    // 2. 배송 완료 기록(completions) 매칭
    state.allCompletions.forEach(c => {
        const driverPhone = c.phone || '기사';
        const driverDigits = driverPhone.replace(/[^0-9]/g, '');
        const customerPhone = c.customerPhone || '';
        const customerDigits = customerPhone.replace(/[^0-9]/g, '');

        const matchesAddr = c.address && c.address.toLowerCase().includes(q);
        
        let matchesPhone = driverPhone.includes(q) || customerPhone.includes(q);
        if (!matchesPhone && qDigits.length >= 4) {
            if (driverDigits.includes(qDigits) || customerDigits.includes(qDigits)) {
                matchesPhone = true;
            }
        }

        if (matchesAddr || matchesPhone) {
            let dStr = '';
            let tStr = '';
            if (c.timeString && c.timeString.includes(' ')) { 
                dStr = c.timeString.split(' ')[0].replace(/\./g, '-'); 
                tStr = c.timeString.split(' ')[1]; 
            } else if (c.completedAt) { 
                dStr = getLocalDateString(new Date(c.completedAt)); 
                const dt = new Date(c.completedAt); 
                tStr = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`; 
            }

            if (isTargetDateInRange(dStr, currentSearchRangeMode, currentSearchCustomStart, currentSearchCustomEnd)) {
                const addrKey = (c.address || '').trim();
                if (!addressGroups[addrKey]) addressGroups[addrKey] = [];
                addressGroups[addrKey].push({
                    type: 'DONE', 
                    address: c.address, 
                    dateStr: dStr, 
                    timeStr: tStr, 
                    tag: c.tag || '전달완료',
                    driverPhone: driverPhone, 
                    customerPhone: customerPhone, // 🌟 고객 번호 복구
                    devId: c.deviceId, 
                    lat: c.lat, 
                    lng: c.lng, 
                    photoUrl: c.photoUrl || '',
                    timestamp: c.completedAt || 0
                });
            }
        }
    });

    // 3. 업로드된 관제 엑셀 주문 리스트 매칭
    if (state.parsedExcelList && state.parsedExcelList.length > 0) {
        state.parsedExcelList.forEach(o => {
            const driverPhone = o.assignedDriver || '미배정';
            const driverDigits = driverPhone.replace(/[^0-9]/g, '');
            const customerPhone = o.phone || '';
            const customerDigits = customerPhone.replace(/[^0-9]/g, '');

            const matchesAddr = o.address && o.address.toLowerCase().includes(q);
            const matchesFull = o.fullAddress && o.fullAddress.toLowerCase().includes(q);
            const matchesStore = o.storeName && o.storeName.toLowerCase().includes(q);
            
            let matchesPhone = driverPhone.toLowerCase().includes(q) || customerPhone.includes(q);
            if (!matchesPhone && qDigits.length >= 4) {
                if (driverDigits.includes(qDigits) || customerDigits.includes(qDigits)) {
                    matchesPhone = true;
                }
            }
            
            if (matchesAddr || matchesFull || matchesStore || matchesPhone) {
                if (isTargetDateInRange(todayStr, currentSearchRangeMode, currentSearchCustomStart, currentSearchCustomEnd)) {
                    const addrKey = (o.address || o.fullAddress || '').trim();
                    if (!addressGroups[addrKey]) addressGroups[addrKey] = [];
                    addressGroups[addrKey].push({
                        type: 'EXCEL',
                        address: o.address || o.fullAddress,
                        storeName: o.storeName || '',
                        dateStr: todayStr,
                        timeStr: driverPhone !== '미배정' ? `담당: ${driverPhone}` : '미배정',
                        driverPhone: driverPhone,
                        customerPhone: customerPhone, // 🌟 고객 번호 복구
                        devId: o.assignedDriver,
                        lat: o.lat,
                        lng: o.lng,
                        timestamp: 1
                    });
                }
            }
        });
    }

    const uniqueAddresses = Object.keys(addressGroups);
    if (!contentEl) return;

    if (uniqueAddresses.length === 0) {
        contentEl.innerHTML = `
            <div class="py-16 flex flex-col items-center justify-center space-y-2">
                <i class="fa-solid fa-magnifying-glass text-gray-300 text-3xl mb-1"></i>
                <p class="text-sm text-gray-600 font-bold">지정된 기간 내 검색 결과가 없습니다.</p>
                <p class="text-[11px] text-gray-400">아래 버튼을 눌러 지난 내역을 다시 검색해 보세요.</p>
            </div>`;
    } else {
        let html = '';
        uniqueAddresses.slice(0, 40).forEach((addr) => {
            const items = addressGroups[addr]; 
            items.sort((a, b) => b.timestamp - a.timestamp);
            const latest = items[0]; 
            const isToday = (latest.dateStr === todayStr);
            const storeLabel = latest.storeName ? `<span class="bg-indigo-50 text-indigo-700 border border-indigo-100 text-[10px] px-1.5 py-0.5 rounded font-black mr-1.5 shrink-0">${latest.storeName}</span>` : '';
            
            let statusBadge = '';
            if (latest.type === 'DONE') {
                statusBadge = `
                    <div class="flex items-center gap-1.5">
                        <span class="font-black text-[11px] px-2 py-0.5 rounded-md text-emerald-700 bg-emerald-100">✓ 완료 [${latest.tag || '전달'}] ${latest.timeStr}</span>
                        ${latest.photoUrl ? `
                        <button type="button" onclick="event.stopPropagation(); window.viewSearchCompletionPhoto('${latest.photoUrl}', '${(latest.address || '').replace(/'/g, "\\'")}', '${latest.driverPhone}', '${latest.timeStr}')" class="bg-blue-600 hover:bg-blue-700 text-white font-black text-[10px] px-2 py-0.5 rounded shadow-xs flex items-center gap-1 transition active:scale-95">
                            <i class="fa-solid fa-camera"></i> 사진보기
                        </button>` : ''}
                    </div>
                `;
            } else if (latest.type === 'PENDING') {
                statusBadge = `<span class="font-black text-[11px] px-2 py-0.5 rounded-md text-blue-700 bg-blue-100">➔ 이동 대기중</span>`;
            } else {
                statusBadge = `<span class="font-black text-[11px] px-2 py-0.5 rounded-md text-amber-700 bg-amber-100">📦 배정 주문</span>`;
            }

            const driverBtn = latest.driverPhone && latest.driverPhone !== '미배정'
                ? `<button type="button" onclick="event.stopPropagation(); window.inspectDriverRoute('${latest.devId}', '${latest.dateStr}')" class="hover:bg-blue-600 hover:text-white bg-blue-50 text-blue-700 border border-blue-200 font-black px-2 py-0.5 rounded-md text-[11px] flex items-center transition shadow-2xs active:scale-95" title="클릭 시 기사의 동선으로 이동합니다">
                     <i class="fa-solid fa-truck text-[10px] mr-1 text-blue-500"></i>${latest.driverPhone}
                   </button>`
                : `<span class="text-gray-400 font-bold text-[11px] bg-gray-100 px-2 py-0.5 rounded-md border border-gray-200">기사 미배정</span>`;

            // 🌟 UI에 고객 연락처를 기사 연락처 옆에 깔끔하게 표기
            const customerPhoneUI = latest.customerPhone 
                ? `<div class="flex items-center gap-1 ml-1.5 pl-1.5 border-l border-gray-300 text-gray-600 font-bold">
                     <i class="fa-solid fa-user text-[9px] text-gray-400"></i> <span class="text-[11px]">${latest.customerPhone}</span>
                   </div>` 
                : '';

            html += `
            <div class="border border-gray-200 rounded-2xl p-4 bg-white hover:border-blue-400 hover:shadow-md transition shadow-sm cursor-pointer group" onclick="if(window.focusMapPosition && ${latest.lat} && ${latest.lng}){ window.focusMapPosition(${latest.lat}, ${latest.lng}); }">
                <div class="flex justify-between items-start mb-2.5">
                    <div class="flex-1 min-w-0 pr-2">
                        <span class="font-black text-sm text-gray-900 leading-snug break-keep flex items-start">
                            <i class="fa-solid fa-location-dot text-red-500 mt-0.5 mr-1.5 text-xs shrink-0 group-hover:animate-bounce"></i>
                            <span>${storeLabel}${latest.address}</span>
                        </span>
                    </div>
                    <span class="bg-gray-100 text-gray-600 text-[10px] font-black px-2 py-0.5 rounded-full border border-gray-200 shrink-0 mt-0.5 whitespace-nowrap">총 ${items.length}회</span>
                </div>
                <div class="p-3 rounded-xl border ${latest.type === 'DONE' ? 'bg-emerald-50/50 border-emerald-200' : 'bg-blue-50/50 border-blue-200'}">
                    <div class="flex justify-between items-center text-xs flex-wrap gap-1.5">
                        <div class="flex items-center gap-1">
                            <span class="text-[10px] font-black px-2 py-0.5 rounded shadow-sm mr-1 ${isToday ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}">
                                ${latest.dateStr}
                            </span>
                            ${driverBtn}
                            ${customerPhoneUI}
                        </div>
                        ${statusBadge}
                    </div>
                </div>
            </div>`;
        });
        contentEl.innerHTML = html;
    }

    html = contentEl.innerHTML;

    html += `
        <div class="mt-4 pt-4 border-t-2 border-dashed border-gray-200 flex flex-col gap-2.5 bg-white p-3.5 rounded-2xl shadow-xs">
            <div class="flex items-center justify-between">
                <span class="text-xs font-black text-gray-800 flex items-center gap-1.5">
                    <i class="fa-solid fa-clock-rotate-left text-blue-600"></i> 지난 배송 내역 다시 검색
                </span>
                <span class="text-[10px] text-gray-400 font-bold">1주일 / 1달 / 기간 지정</span>
            </div>
            <div class="grid grid-cols-3 gap-2">
                <button type="button" onclick="window.setSearchRangeMode('7days')" class="py-2.5 ${currentSearchRangeMode === '7days' ? 'bg-purple-600 text-white' : 'bg-gray-50 hover:bg-purple-50 hover:text-purple-700 text-gray-700'} font-black text-xs rounded-xl border border-gray-200 transition active:scale-95 shadow-2xs">최근 1주일</button>
                <button type="button" onclick="window.setSearchRangeMode('30days')" class="py-2.5 ${currentSearchRangeMode === '30days' ? 'bg-purple-600 text-white' : 'bg-gray-50 hover:bg-purple-50 hover:text-purple-700 text-gray-700'} font-black text-xs rounded-xl border border-gray-200 transition active:scale-95 shadow-2xs">최근 1달</button>
                <button type="button" onclick="document.getElementById('search-custom-box').classList.toggle('hidden')" class="py-2.5 ${currentSearchRangeMode === 'custom' ? 'bg-emerald-600 text-white' : 'bg-gray-50 hover:bg-emerald-50 hover:text-emerald-700 text-gray-700'} font-black text-xs rounded-xl border border-gray-200 transition active:scale-95 shadow-2xs">기간 설정</button>
            </div>
            <div id="search-custom-box" class="${currentSearchRangeMode === 'custom' ? 'flex' : 'hidden'} items-center gap-1.5 pt-2 border-t border-gray-100 flex-wrap sm:flex-nowrap">
                <input type="date" id="search-custom-start" value="${currentSearchCustomStart || todayStr}" class="bg-gray-50 border border-gray-300 rounded-lg p-1.5 text-xs font-bold outline-none flex-1 cursor-pointer">
                <span class="text-xs text-gray-400 font-bold">~</span>
                <input type="date" id="search-custom-end" value="${currentSearchCustomEnd || todayStr}" class="bg-gray-50 border border-gray-300 rounded-lg p-1.5 text-xs font-bold outline-none flex-1 cursor-pointer">
                <button type="button" onclick="window.applyCustomSearchRange()" class="bg-slate-900 hover:bg-slate-800 text-white text-xs font-black px-3 py-1.5 rounded-lg transition active:scale-95 shadow-2xs whitespace-nowrap">조회</button>
            </div>
        </div>
    `;

    contentEl.innerHTML = html; 
    if (sidePanel) sidePanel.classList.remove('translate-x-full');
}

// 🌟 HTML 인라인 바인딩을 위한 window 객체 매핑
window.closeSearchSidePanel = closeSearchSidePanel;
window.clearSearchInput = clearSearchInput;
window.jumpToDeliveryTarget = jumpToDeliveryTarget;
window.inspectDriverRoute = inspectDriverRoute;
window.viewSearchCompletionPhoto = viewSearchCompletionPhoto;
window.setSearchRangeMode = setSearchRangeMode;
window.applyCustomSearchRange = applyCustomSearchRange;
window.resetSearchToToday = resetSearchToToday;
window.handleGlobalSearch = handleGlobalSearch;