// js/ui.js

// =================================================================
// [배송 동선 PRO] UI 렌더링 및 화면 조작 전담 모듈
// =================================================================

import { state } from './state.js';

// 전화번호 정제 보조 함수
function sanitizePhoneNumber(rawVal) {
    if (!rawVal) return "";
    let strVal = String(rawVal).trim();
    let digits = strVal.replace(/[^0-9]/g, '');

    if (digits.length < 8 || digits === '0') return "";

    if (digits.length === 11 && digits.startsWith('010')) {
        return digits.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
    }
    if (digits.length === 10) {
        if (digits.startsWith('02')) {
            return digits.replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3');
        } else {
            return digits.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
        }
    }
    return strVal;
}

// 상호명 분리 및 주소 원본 보존 헬퍼
function formatDisplayAddress(rawAddress, storeName = "") {
    let extractedStore = storeName ? String(storeName).trim() : "";
    let cleanAddr = (rawAddress || "").trim();

    const match = cleanAddr.match(/^\[(.*?)\]\s*(.*)$/);
    if (match) {
        if (!extractedStore) extractedStore = match[1].trim();
        cleanAddr = match[2].trim();
    }

    if (extractedStore && cleanAddr.startsWith(extractedStore)) {
        cleanAddr = cleanAddr.substring(extractedStore.length).trim();
    }

    return {
        storeName: extractedStore,
        cleanAddr: cleanAddr,
        fullAddr: cleanAddr
    };
}

// 거리 계산 (위경도 기반 실거리 산출)
function calculateDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
    const R = 6371; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + 
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDistance(distKm) {
    if (distKm < 1) return Math.round(distKm * 1000) + "m";
    return distKm.toFixed(1) + "km";
}

// 배송 목록 메인 렌더링 UI 업데이트
export function renderDestinationList(preloadBatchMemosCallback, renderMemoPreviewCallback) {
    const listEl = document.getElementById('destination-list');
    const headerEndAddr = document.getElementById('header-end-address'); 
    const headerEndInput = document.getElementById('header-inline-end-input');
    const endLocation = state.getEndLocation();
    const destinations = state.getDestinations();
    const startLocation = state.getStartLocation();
    const lastGps = state.getLastKnownGps();
    
    if (headerEndAddr) {
        headerEndAddr.innerText = endLocation.address || '설정 안 함';
        if (!endLocation.address) { 
            headerEndAddr.classList.add('text-red-400'); 
            headerEndAddr.classList.remove('text-red-700'); 
        } else { 
            headerEndAddr.classList.remove('text-red-400'); 
            headerEndAddr.classList.add('text-red-700'); 
        }
    }
    if (headerEndInput) headerEndInput.value = endLocation.address || '';

    if (destinations.length === 0) {
        if (listEl) {
            listEl.innerHTML = `
                <li id="empty-state" class="text-center text-gray-400 py-16 border-2 border-dashed border-gray-200 rounded-2xl my-2 bg-gray-50/50">
                    <i class="fa-solid fa-receipt text-5xl mb-3 text-gray-300"></i>
                    <p class="font-bold text-xs text-gray-500 leading-relaxed">주소지를 스캔하거나 관제에서 전송되면<br>동선이 생성됩니다.</p>
                </li>`;
        }
        return;
    }

    if (listEl) {
        listEl.innerHTML = ''; 
        destinations.forEach((dest, index) => {
            const li = document.createElement('li'); 
            li.setAttribute('data-id', dest.id); 
            if (dest.orderNo) li.setAttribute('data-orderno', dest.orderNo);
            li.className = "bg-white p-3 rounded-2xl shadow-xs border border-gray-200 flex flex-col gap-2";
            
            let numberBadge = index === 0 && (startLocation && startLocation.lat) ? 
                `<div class="bg-indigo-600 text-white font-black w-6 h-6 rounded-full flex items-center justify-center text-[11px] shadow-sm shrink-0 ring-2 ring-indigo-200"><i class="fa-solid fa-flag text-[10px]"></i></div>` : 
                `<div class="bg-blue-600 text-white font-black w-6 h-6 rounded-full flex items-center justify-center text-[11px] shadow-sm shrink-0">${dest.displayNumber}</div>`;
            
            let customerPhoneStr = sanitizePhoneNumber(dest.phone || ""); 
            let dynamicTextSize = "text-[12px]"; 
            if (customerPhoneStr.length >= 13) dynamicTextSize = "text-[10.5px]"; 
            else if (customerPhoneStr.length >= 11) dynamicTextSize = "text-[11px]"; 
            else if (customerPhoneStr.length >= 9) dynamicTextSize = "text-[11.5px]";

            const formatted = formatDisplayAddress(dest.address, dest.storeName);
            let displayAddressHTML = "";
            
            if (formatted.storeName) {
                displayAddressHTML = `
                    <span class="text-blue-600 block text-[12px] mb-0.5 leading-none font-bold">🏢 ${formatted.storeName}</span>
                    <span class="block leading-snug text-gray-900 break-keep font-extrabold text-[14px]">${formatted.cleanAddr}</span>
                `;
            } else {
                displayAddressHTML = `<span class="block leading-snug text-gray-900 break-keep font-extrabold text-[14px]">${formatted.cleanAddr}</span>`;
            }

            let distHtml = "";
            if (lastGps && lastGps.lat && lastGps.lng && dest.lat && dest.lng) {
                const dist = calculateDistance(lastGps.lat, lastGps.lng, dest.lat, dest.lng);
                distHtml = `<span class="text-[10px] text-blue-500 font-bold bg-blue-50 px-1.5 py-0.5 rounded shadow-2xs whitespace-nowrap border border-blue-100 flex items-center h-[22px]"><i class="fa-solid fa-location-arrow mr-0.5"></i>${formatDistance(dist)}</span>`;
            }

            let navTargetName = (formatted.storeName || formatted.cleanAddr || dest.address).replace(/['"]/g, '');
            const isFirst = index === 0;
            const isLast = index === destinations.length - 1;

            // 🌟 색상 통일화: 정보/소통 그룹(전화, 문자, 메모)을 블루/스카이/인디고 계열로 일원화
            li.innerHTML = `
                <div class="flex items-start gap-1.5 pb-0.5 mt-0.5">
                    <div class="flex flex-col items-center justify-center gap-1 shrink-0 -ml-0.5 mr-0.5 mt-0.5">
                        <button onclick="moveDestinationUp(${dest.id})" ${isFirst ? 'disabled' : ''} class="w-6 h-[20px] flex items-center justify-center rounded bg-gray-50 hover:bg-gray-100 active:bg-gray-200 border border-gray-200 text-gray-600 disabled:opacity-15 disabled:pointer-events-none transition shadow-2xs" title="위로 이동">
                            <i class="fa-solid fa-chevron-up text-[10px]"></i>
                        </button>
                        <button onclick="moveDestinationDown(${dest.id})" ${isLast ? 'disabled' : ''} class="w-6 h-[20px] flex items-center justify-center rounded bg-gray-50 hover:bg-gray-100 active:bg-gray-200 border border-gray-200 text-gray-600 disabled:opacity-15 disabled:pointer-events-none transition shadow-2xs" title="아래로 이동">
                            <i class="fa-solid fa-chevron-down text-[10px]"></i>
                        </button>
                    </div>
                    ${numberBadge}
                    <div class="font-bold text-gray-900 flex-1 ml-1 min-w-0 flex flex-col justify-center">
                        ${displayAddressHTML}
                    </div>
                    <div class="flex items-center gap-1 shrink-0 -mr-1">
                        ${distHtml}
                        <button onclick="editDestinationAddress(${dest.id})" class="text-gray-400 hover:text-blue-500 w-8 h-8 flex items-center justify-center shrink-0 rounded-lg active:bg-gray-100 transition" title="주소 수정"><i class="fa-solid fa-pen text-[14px]"></i></button>
                    </div>
                </div>
                
                <div id="memo-tags-${dest.id}" class="hidden flex flex-wrap gap-1 mb-0.5 mt-0.5"></div>
                <div id="memo-preview-${dest.id}" class="hidden bg-gray-50 rounded-lg p-2 text-[11.5px] text-gray-800 border border-gray-100 truncate shadow-2xs mb-0.5 mt-0.5"></div>
                <div id="personal-memo-preview-${dest.id}" class="hidden bg-emerald-50 rounded-lg p-2 text-[11.5px] text-emerald-950 border border-emerald-200 truncate shadow-2xs mb-1 mt-0.5"></div>
                
                <div class="flex flex-col gap-1.5 mt-0.5 pt-2 border-t border-gray-100">
                    <div class="flex gap-1.5 h-[42px]">
                        ${customerPhoneStr ? `<a href="tel:${customerPhoneStr}" class="flex-none w-[106px] bg-blue-50 text-blue-700 border border-blue-200 rounded-xl shadow-2xs flex items-center justify-center active:bg-blue-100 transition px-1.5 phone-number-box"><i class="fa-solid fa-phone mr-1 text-[11px] shrink-0"></i><span class="${dynamicTextSize} font-black tracking-tight whitespace-nowrap">${customerPhoneStr}</span></a>` : `<div class="flex-none w-[106px] bg-gray-50 text-gray-400 border border-gray-100 rounded-xl shadow-2xs flex items-center justify-center px-1.5"><i class="fa-solid fa-phone-slash mr-1 text-[11px] shrink-0"></i><span class="text-[10.5px] font-bold whitespace-nowrap">번호 없음</span></div>`}
                        <a href="sms:${customerPhoneStr}" class="flex-1 min-w-0 bg-sky-50 text-sky-700 border border-sky-200 rounded-xl shadow-2xs flex items-center justify-center gap-1 active:bg-sky-100 transition flex-nowrap ${!customerPhoneStr ? 'opacity-30 pointer-events-none' : ''}"><i class="fa-solid fa-comment-sms text-[13px] shrink-0"></i><span class="text-[12.5px] font-black whitespace-nowrap tracking-tight">문자</span></a>
                        <button onclick="openMemoModal(${dest.id})" class="flex-1 min-w-0 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-xl shadow-2xs flex items-center justify-center gap-1 active:bg-indigo-100 transition flex-nowrap"><i class="fa-solid fa-pen-to-square text-[13px] shrink-0"></i><span class="text-[12.5px] font-black whitespace-nowrap tracking-tight">메모</span></button>
                        <button onclick="completeDestination(${dest.id})" class="flex-1 min-w-0 bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-xl shadow-2xs flex items-center justify-center gap-1 active:bg-emerald-100 transition flex-nowrap"><i class="fa-solid fa-check text-[14px] shrink-0"></i><span class="text-[12.5px] font-black whitespace-nowrap tracking-tight">완료</span></button>
                    </div>
                    <div class="flex gap-1.5 h-[38px]">
                        <div class="flex-1 min-w-0 bg-gray-50 border border-gray-200 p-1 rounded-xl flex items-center gap-1.5 shadow-2xs">
                            <span class="text-[11.5px] font-black text-gray-500 px-1.5 shrink-0 whitespace-nowrap leading-none tracking-tight">길찾기</span>
                            <div class="w-px h-4 bg-gray-300 shrink-0"></div>
                            <div class="flex-1 grid grid-cols-2 gap-1 h-full">
                                <button onclick="openTmap(${dest.lat}, ${dest.lng}, '${navTargetName}')" class="bg-black text-white text-[11.5px] font-bold rounded-lg active:opacity-80 flex items-center justify-center gap-1 shadow-2xs h-full whitespace-nowrap tracking-tight"><i class="fa-solid fa-map-location-dot text-[11px] shrink-0"></i> 티맵</button>
                                <!-- 🌟 카카오내비 버튼을 네이버 내비로 교체 및 디자인 변경 -->
                                <button onclick="openNaverMap(${dest.lat}, ${dest.lng}, '${navTargetName}')" class="bg-[#03C75A] text-white text-[11.5px] font-bold rounded-lg border border-[#02B351] active:bg-[#02B351] flex items-center justify-center gap-1 shadow-2xs h-full whitespace-nowrap tracking-tight"><i class="fa-solid fa-location-arrow text-[11px] shrink-0"></i> 네이버</button>
                            </div>
                        </div>
                        <button onclick="cancelDestination(${dest.id})" class="w-[44px] shrink-0 bg-red-50 text-red-500 border border-red-200 rounded-xl shadow-2xs flex items-center justify-center active:bg-red-100 transition" title="배송 취소"><i class="fa-solid fa-trash-can text-[14px] shrink-0"></i></button>
                    </div>
                </div>`;
            listEl.appendChild(li);
        });
    }
    
    if (typeof preloadBatchMemosCallback === 'function') {
        preloadBatchMemosCallback().then(() => {
            destinations.forEach(dest => {
                if (typeof renderMemoPreviewCallback === 'function') {
                    renderMemoPreviewCallback(dest);
                }
            });
        });
    }
}