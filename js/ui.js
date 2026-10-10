// js/ui.js

// =================================================================
// [배송 동선 PRO] UI 렌더링 및 화면 조작 전담 모듈 (네이버 내비 & 고대비 시인성 테마)
// =================================================================

import { state, destinationIdArgument, destinationIdAttribute, hasValidDeliveryCoordinates } from './state.js';
let memoRenderRevision = 0;

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
    return digits;
}

// 상호명 분리 및 주소 원본 보존 헬퍼
function formatDisplayAddress(rawAddress, storeName) {
    const hasStoreName = storeName !== undefined;
    let extractedStore = storeName ? String(storeName).trim() : "";
    let cleanAddr = (rawAddress || "").trim();

    const match = cleanAddr.match(/^\[(.*?)\]\s*(.*)$/);
    if (match) {
        if (!hasStoreName) extractedStore = match[1].trim();
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
export function renderDestinationList(preloadBatchMemosCallback, renderMemoPreviewCallback, getPersonalMemosCallback) {
    const revision = ++memoRenderRevision;
    const ownerId = state.getRouteOwnerId();
    const isCurrent = () => revision === memoRenderRevision && ownerId === state.getRouteOwnerId();
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
            headerEndAddr.classList.add('text-red-500'); 
            headerEndAddr.classList.remove('text-slate-800'); 
        } else { 
            headerEndAddr.classList.remove('text-red-500'); 
            headerEndAddr.classList.add('text-slate-800'); 
        }
    }
    if (headerEndInput) headerEndInput.value = endLocation.address || '';

    if (destinations.length === 0) {
        if (listEl) {
            listEl.innerHTML = `
                <li id="empty-state" class="text-center text-gray-400 py-16 border-2 border-dashed border-slate-300 rounded-2xl my-2 bg-white">
                    <i class="fa-solid fa-receipt text-5xl mb-3 text-slate-300"></i>
                    <p class="font-bold text-xs text-slate-500 leading-relaxed">주소지를 스캔하거나 관제에서 전송되면<br>동선이 생성됩니다.</p>
                </li>`;
        }
        return;
    }

    if (listEl) {
        listEl.innerHTML = ''; 
        destinations.forEach((dest, index) => {
            const li = document.createElement('li'); 
            li.setAttribute('data-id', dest.id); 
            const idArgument = destinationIdArgument(dest.id);
            const domId = destinationIdAttribute(dest.id);
            const needsLocation = !hasValidDeliveryCoordinates(dest);
            const navigationDisabled = needsLocation ? 'disabled' : '';
            if (dest.orderNo) li.setAttribute('data-orderno', dest.orderNo);
            li.className = "bg-white p-3 rounded-2xl shadow-xs border border-slate-200/90 flex flex-col gap-2";
            
            // 번호 뱃지: 출발지는 인디고 깃발, 일반 순번은 딥 슬레이트
            let numberBadge = startLocation && startLocation.id === dest.id ? 
                `<div class="bg-indigo-600 text-white font-black w-6 h-6 rounded-full flex items-center justify-center text-[10px] shadow-xs shrink-0 ring-2 ring-indigo-100"><i class="fa-solid fa-flag text-[9px]"></i></div>` : 
                `<div class="bg-slate-900 text-white font-black w-6 h-6 rounded-full flex items-center justify-center text-[11px] shadow-xs shrink-0">${state.escapeHtml(dest.displayNumber)}</div>`;
            
            let customerPhoneStr = sanitizePhoneNumber(dest.phone || ""); 
            // 🌟 폰트 크기를 한 단계 낮추고 고정폭(font-mono) 적용으로 자간 여백 확보
            let dynamicTextSize = "text-[10.5px]"; 
            if (customerPhoneStr.length >= 13) dynamicTextSize = "text-[9.5px]"; 
            else if (customerPhoneStr.length >= 11) dynamicTextSize = "text-[10px]";

            const formatted = formatDisplayAddress(dest.address, dest.storeName);
            let displayAddressHTML = "";
            
            if (formatted.storeName) {
                displayAddressHTML = `
                    <span class="text-blue-600 block text-[11.5px] mb-0.5 leading-none font-bold">🏢 ${state.escapeHtml(formatted.storeName)}</span>
                    <span class="block leading-snug text-slate-900 break-keep font-bold text-[13.5px]">${state.escapeHtml(formatted.cleanAddr)}</span>
                `;
            } else {
                displayAddressHTML = `<span class="block leading-snug text-slate-900 break-keep font-bold text-[13.5px]">${formatted.cleanAddr}</span>`;
            }

            const navTargetName = state.inlineArgument(formatted.storeName || formatted.cleanAddr || dest.address || '목적지');
            const navLat = needsLocation ? 0 : dest.lat;
            const navLng = needsLocation ? 0 : dest.lng;
            if (!formatted.cleanAddr && !formatted.storeName) displayAddressHTML = '<span>주소 정보 없음 · 주소 수정 필요</span>';
            if (needsLocation) displayAddressHTML += '<span class="block text-xs text-amber-700">위치 확인 필요 · 주소 수정</span>';
            const isFirst = index === 0;
            const isLast = index === destinations.length - 1;

            li.innerHTML = `
                <div class="flex items-start gap-1.5 pb-0.5 mt-0.5">
                    <div class="flex flex-col items-center justify-center gap-1 shrink-0 -ml-0.5 mr-0.5 mt-0.5">
                        <button onclick="moveDestinationUp(${idArgument})" ${isFirst ? 'disabled' : ''} class="w-8 h-[32px] touch-manipulation flex items-center justify-center rounded bg-slate-50 hover:bg-slate-100 active:bg-slate-200 border border-slate-200 text-slate-600 disabled:opacity-15 disabled:pointer-events-none transition shadow-2xs" title="${isFirst ? '첫 행은 더 위로 이동할 수 없습니다' : '위로 이동'}">
                            <i class="fa-solid fa-chevron-up text-[10px]"></i>
                        </button>
                        <button onclick="moveDestinationDown(${idArgument})" ${isLast ? 'disabled' : ''} class="w-8 h-[32px] touch-manipulation flex items-center justify-center rounded bg-slate-50 hover:bg-slate-100 active:bg-slate-200 border border-slate-200 text-slate-600 disabled:opacity-15 disabled:pointer-events-none transition shadow-2xs" title="${isLast ? '마지막 행은 더 아래로 이동할 수 없습니다' : '아래로 이동'}">
                            <i class="fa-solid fa-chevron-down text-[10px]"></i>
                        </button>
                    </div>
                    ${numberBadge}
                    <div class="font-bold text-slate-900 flex-1 ml-1 min-w-0 flex flex-col justify-center">
                        ${displayAddressHTML}
                    </div>
                    <div class="flex items-center gap-1 shrink-0 -mr-1">
                        <button onclick="editDestinationAddress(${idArgument})" class="text-slate-400 hover:text-slate-700 w-8 h-8 flex items-center justify-center shrink-0 rounded-lg active:bg-slate-100 transition" title="상호·주소 수정"><i class="fa-solid fa-pen text-[13px]"></i></button>
                    </div>
                </div>
                
                <div id="memo-tags-${domId}" class="hidden flex flex-wrap gap-1 mb-0.5 mt-0.5"></div>
                <div id="memo-preview-${domId}" class="hidden bg-slate-50 rounded-lg p-2 text-[11px] text-slate-700 border border-slate-200 truncate shadow-2xs mb-0.5 mt-0.5"></div>
                <div id="personal-memo-preview-${domId}" class="hidden bg-emerald-50/70 rounded-lg p-2 text-[11px] text-emerald-900 border border-emerald-200 truncate shadow-2xs mb-1 mt-0.5"></div>
                
                <div class="flex flex-col gap-1.5 mt-0.5 pt-2 border-t border-slate-100">
                    <div class="flex gap-1.5 h-[40px]">
                        <!-- 전화: 가독성 확보(font-mono, 폰트사이즈 최적화), 편안한 소프트 에메랄드 -->
                        ${customerPhoneStr ? `<a href="tel:${customerPhoneStr}" class="flex-none w-[104px] bg-emerald-50 text-emerald-900 border border-emerald-200 rounded-xl shadow-2xs flex items-center justify-center active:bg-emerald-100 transition px-1 phone-number-box"><i class="fa-solid fa-phone mr-1 text-[10px] text-emerald-600 shrink-0"></i><span class="${dynamicTextSize} font-bold font-mono tracking-tight whitespace-nowrap">${customerPhoneStr}</span></a>` : `<div class="flex-none w-[104px] bg-slate-50 text-slate-400 border border-slate-200 rounded-xl shadow-2xs flex items-center justify-center px-1"><i class="fa-solid fa-phone-slash mr-1 text-[10px] shrink-0"></i><span class="text-[9.5px] font-bold whitespace-nowrap">번호 없음</span></div>`}
                        
                        <!-- 문자 / 메모: 일체감 있는 라이트 슬레이트 베이스 -->
                        <a href="sms:${customerPhoneStr}" class="flex-1 min-w-0 bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-xl shadow-2xs flex items-center justify-center gap-1 active:bg-slate-200 transition flex-nowrap ${!customerPhoneStr ? 'opacity-30 pointer-events-none' : ''}"><i class="fa-solid fa-comment-sms text-[12px] text-sky-600 shrink-0"></i><span class="text-[12px] font-bold whitespace-nowrap tracking-tight">문자</span></a>
                        <button onclick="openMemoModal(${idArgument})" class="flex-1 min-w-0 bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-xl shadow-2xs flex items-center justify-center gap-1 active:bg-slate-200 transition flex-nowrap"><i class="fa-solid fa-pen-to-square text-[12px] text-amber-500 shrink-0"></i><span class="text-[12px] font-bold whitespace-nowrap tracking-tight">메모</span></button>
                        
                        <!-- 완료: 즉각적인 반응을 돕는 솔리드 블루 -->
                        <button onclick="completeDestination(${idArgument})" class="flex-1 min-w-0 bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-xs flex items-center justify-center gap-1 active:bg-blue-800 transition flex-nowrap"><i class="fa-solid fa-check text-[13px] shrink-0"></i><span class="text-[12px] font-black whitespace-nowrap tracking-tight">완료</span></button>
                    </div>
                    <div class="flex gap-1.5 h-[36px]">
                        <div class="flex-1 min-w-0 bg-slate-50 border border-slate-200 p-1 rounded-xl flex items-center gap-1.5 shadow-2xs">
                            <span class="text-[11px] font-bold text-slate-500 px-1.5 shrink-0 whitespace-nowrap leading-none tracking-tight">길찾기</span>
                            <div class="w-px h-3.5 bg-slate-200 shrink-0"></div>
                            <div class="flex-1 grid grid-cols-2 gap-1 h-full">
                                <button ${navigationDisabled} onclick="openTmap(${navLat}, ${navLng}, ${navTargetName})" class="bg-slate-900 text-white text-[11px] font-bold rounded-lg active:bg-black flex items-center justify-center gap-1 shadow-2xs h-full whitespace-nowrap tracking-tight"><i class="fa-solid fa-map-location-dot text-[10px] shrink-0"></i> 티맵</button>
                                <!-- 🌟 카카오내비 완전 대체: 네이버 내비게이션 버튼 연동 -->
                                <button ${navigationDisabled} onclick="openNaverMap(${navLat}, ${navLng}, ${navTargetName})" class="bg-[#03C75A] hover:bg-[#02B351] text-white text-[11px] font-bold rounded-lg border border-[#02B351] active:bg-[#029b46] flex items-center justify-center gap-1 shadow-2xs h-full whitespace-nowrap tracking-tight"><i class="fa-solid fa-location-arrow text-[10px] shrink-0"></i> 네이버</button>
                            </div>
                        </div>
                        <!-- 취소/삭제: 경고성 소프트 로즈 -->
                        <button onclick="cancelDestination(${idArgument})" class="w-[42px] shrink-0 bg-rose-50 text-rose-600 border border-rose-200 rounded-xl shadow-2xs flex items-center justify-center active:bg-rose-100 transition" title="배송 취소"><i class="fa-solid fa-trash-can text-[13px] shrink-0"></i></button>
                    </div>
                </div>`;
            listEl.appendChild(li);
        });
    }
    
    // Basic cards are already visible. Yield before storage reads and memo DOM work.
    let paintRevision = 0;
    const paintMemos = () => {
        if (!isCurrent() || typeof renderMemoPreviewCallback !== 'function') return;
        const paint = ++paintRevision;
        const personalMemos = typeof getPersonalMemosCallback === 'function' ? getPersonalMemosCallback() : null;
        let index = 0;
        const paintChunk = () => {
            if (!isCurrent() || paint !== paintRevision) return;
            const end = Math.min(index + 8, destinations.length);
            for (; index < end; index++) renderMemoPreviewCallback(destinations[index], personalMemos);
            if (index < destinations.length) setTimeout(paintChunk, 0);
        };
        paintChunk();
    };
    setTimeout(() => {
        if (!isCurrent()) return;
        paintMemos();
        if (typeof preloadBatchMemosCallback === 'function') {
            Promise.resolve().then(() => isCurrent() ? preloadBatchMemosCallback() : null)
                .then(() => { if (isCurrent()) setTimeout(paintMemos, 0); })
                .catch(() => {});
        }
    }, 0);
}
