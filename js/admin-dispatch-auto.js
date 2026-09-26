// js/admin-dispatch-auto.js

import { db } from "./admin-api.js";
import { state, getLocalDateString } from "./admin-state.js";
import { getFilteredVisibleDrivers, formatNumber } from "./admin-dispatch-core.js";
import { doc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// ==========================================
// 0. 전국 주요 지형지물(강, 산, 행정구역) 가상 페널티 엔진
// ==========================================

// 전국 대표 강줄기 가상 차단선 (한강, 낙동강, 금강, 영산강)
const RIVER_BARRIER_LINES = [
    // 1. 한강 (일산/김포 ~ 여의도 ~ 잠실 ~ 팔당)
    [
        { lat: 37.605, lng: 126.745 }, { lat: 37.585, lng: 126.815 },
        { lat: 37.558, lng: 126.865 }, { lat: 37.534, lng: 126.935 },
        { lat: 37.518, lng: 126.985 }, { lat: 37.530, lng: 127.050 },
        { lat: 37.532, lng: 127.100 }, { lat: 37.565, lng: 127.155 },
        { lat: 37.545, lng: 127.240 }
    ],
    // 2. 낙동강 (부산 강서구와 사상/사하/북구 분리)
    [
        { lat: 35.320, lng: 128.990 }, { lat: 35.285, lng: 128.985 },
        { lat: 35.215, lng: 128.980 }, { lat: 35.155, lng: 128.960 },
        { lat: 35.095, lng: 128.940 }, { lat: 35.030, lng: 128.930 }
    ],
    // 3. 금강 (세종/대전/공주 분리 라인)
    [
        { lat: 36.560, lng: 127.180 }, { lat: 36.520, lng: 127.260 },
        { lat: 36.480, lng: 127.350 }, { lat: 36.440, lng: 127.420 }
    ],
    // 4. 영산강 (광주/나주 분리 라인)
    [
        { lat: 35.230, lng: 126.780 }, { lat: 35.160, lng: 126.820 },
        { lat: 35.080, lng: 126.750 }
    ]
];

// 서울 강북 14개 구 및 강남 11개 구 목록
const SEOUL_GANGBUK_GU = ['종로구', '중구', '용산구', '성동구', '광진구', '동대문구', '중랑구', '성북구', '강북구', '도봉구', '노원구', '은평구', '서대문구', '마포구'];
const SEOUL_GANGNAM_GU = ['양천구', '강서구', '구로구', '금천구', '영등포구', '동작구', '관악구', '서초구', '강남구', '송파구', '강동구'];

// 수학적 선분 교차 검사 함수 (CCW)
function ccw(p1, p2, p3) {
    const cross = (p2.lng - p1.lng) * (p3.lat - p1.lat) - (p2.lat - p1.lat) * (p3.lng - p1.lng);
    if (Math.abs(cross) < 1e-9) return 0;
    return cross > 0 ? 1 : -1;
}

function linesIntersect(p1, p2, p3, p4) {
    const d1 = ccw(p3, p4, p1);
    const d2 = ccw(p3, p4, p2);
    const d3 = ccw(p1, p2, p3);
    const d4 = ccw(p1, p2, p4);
    return (d1 * d2 < 0) && (d3 * d4 < 0);
}

// 두 지점 사이가 전국 주요 강줄기 차단선을 가로지르는지 확인
function checkRiverCrossings(p1, p2) {
    for (const river of RIVER_BARRIER_LINES) {
        for (let i = 0; i < river.length - 1; i++) {
            if (linesIntersect(p1, p2, river[i], river[i + 1])) {
                return true;
            }
        }
    }
    return false;
}

// 주소 문자열에서 시/도, 시/군/구 및 한강 강남/강북 특성 추출
function parseAreaInfo(addr) {
    if (!addr || typeof addr !== 'string') {
        return { sido: '', sigungu: '', isSeoulGangbuk: false, isSeoulGangnam: false };
    }
    const clean = addr.trim();
    const match = clean.match(/(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별(?:시|자치시)|광역(?:시)|(?:특별)?자치도|도)?\s*([가-힣]+(?:시|군|구))?(?:\s*([가-힣]+구))?/);

    let sido = match ? (match[1] || '') : '';
    let sigungu = '';
    if (match) {
        const p1 = match[2] || '';
        const p2 = match[3] || '';
        sigungu = (p1 + (p2 ? ' ' + p2 : '')).trim();
    }

    const isSeoulGangbuk = sido === '서울' && SEOUL_GANGBUK_GU.some(gu => clean.includes(gu));
    const isSeoulGangnam = sido === '서울' && SEOUL_GANGNAM_GU.some(gu => clean.includes(gu));

    return { sido, sigungu, isSeoulGangbuk, isSeoulGangnam };
}

// 기본 직선거리 (Haversine 공식, km)
function getBaseDist(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 999999;
    const R = 6371; 
    const dLat = (lat2 - lat1) * Math.PI / 180; 
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + 
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 지형지물(강, 산, 행정구역) 가상 페널티가 결합된 실질 거리 계산기
function calculateGeoPenalizedDist(lat1, lon1, lat2, lon2, addr1 = '', addr2 = '') {
    const baseDistance = getBaseDist(lat1, lon1, lat2, lon2);
    if (baseDistance >= 999999) return baseDistance;

    let penalty = 0;

    // 1. 강줄기 가상 차단선 통과 여부 검사
    const p1 = { lat: lat1, lng: lon1 };
    const p2 = { lat: lat2, lng: lon2 };
    if (checkRiverCrossings(p1, p2)) {
        penalty += 25; // 강을 건너야 할 경우 25km 가상 벌점
    }

    // 2. 주소 기반 행정구역 및 한강 남북 분리 검사
    const area1 = parseAreaInfo(addr1);
    const area2 = parseAreaInfo(addr2);

    if (area1.sido && area2.sido) {
        // 서울 강남 ↔ 강북 교차 배정 강력 차단
        if ((area1.isSeoulGangbuk && area2.isSeoulGangnam) || (area1.isSeoulGangnam && area2.isSeoulGangbuk)) {
            penalty += 30;
        }
        // 광역 시/도가 서로 다른 경우 (예: 서울 ↔ 경기 남부, 인천 등)
        else if (area1.sido !== area2.sido) {
            penalty += 12;
        }
        // 같은 시/도 내에서 시·군·구가 다른 경우 (자연 산맥/하천 지형 경계선 우선 클러스터링)
        else if (area1.sigungu && area2.sigungu && area1.sigungu !== area2.sigungu) {
            penalty += 6;
        }
    }

    return baseDistance + penalty;
}

// ==========================================
// 1. 본사 거점 설정 및 UI 동기화
// ==========================================
export function saveCompanyBaseAddress() {
    const input = document.getElementById('company-base-address').value.trim();
    if (!input) { alert("본사 거점 주소를 입력해주세요."); return; }
    
    if (window.kakao && kakao.maps && kakao.maps.services) {
        const geocoder = new kakao.maps.services.Geocoder();
        geocoder.addressSearch(input, (result, status) => {
            if (status === kakao.maps.services.Status.OK && result[0]) {
                let fullAddress = result[0].address_name;
                if (result[0].road_address && result[0].road_address.address_name) {
                    fullAddress = result[0].road_address.address_name;
                }

                const data = { address: fullAddress, lat: parseFloat(result[0].y), lng: parseFloat(result[0].x) };
                localStorage.setItem('deliveryProCompanyBase', JSON.stringify(data));
                updateCompanyBaseUI(data);
                alert("본사 거점이 성공적으로 저장되었습니다.");
            } else {
                alert("주소를 좌표로 변환할 수 없습니다. 정확한 도로명이나 지번 주소를 입력해주세요.");
            }
        });
    } else {
        alert("카카오맵 지도 API가 완전히 로드되지 않았습니다. 잠시 후 다시 시도해주세요.");
    }
}

export function clearCompanyBaseAddress() {
    localStorage.removeItem('deliveryProCompanyBase');
    updateCompanyBaseUI(null);
}

export function updateCompanyBaseUI(data) {
    const textEl = document.getElementById('saved-base-address-text');
    const clearBtn = document.getElementById('btn-clear-company-base');
    const inputEl = document.getElementById('company-base-address');
    if (textEl && clearBtn && inputEl) {
        if (data) {
            textEl.innerText = data.address;
            textEl.classList.add('text-blue-600');
            textEl.classList.remove('text-gray-500');
            clearBtn.classList.remove('hidden');
            inputEl.value = '';
        } else {
            textEl.innerText = '저장된 거점이 없습니다.';
            textEl.classList.remove('text-blue-600');
            textEl.classList.add('text-gray-500');
            clearBtn.classList.add('hidden');
        }
    }
}

// ==========================================
// 2. 드래그 리사이저 바 (Splitter Bar) 실시간 조절 엔진
// ==========================================
export function initDispatchResizer() {
    const resizer = document.getElementById('dispatch-panel-resizer');
    const detailPanel = document.getElementById('dispatch-detail-panel');
    if (!resizer || !detailPanel) return;

    const savedWidth = localStorage.getItem('deliveryPro_dispatchDetailWidth');
    if (savedWidth) {
        detailPanel.style.width = `${savedWidth}px`;
    }

    if (resizer.dataset.bound === 'true') return;

    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    resizer.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startWidth = detailPanel.offsetWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const delta = e.clientX - startX;
        let newWidth = startWidth + delta;
        
        if (newWidth < 300) newWidth = 300;
        if (newWidth > 750) newWidth = 750;

        detailPanel.style.width = `${newWidth}px`;
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            localStorage.setItem('deliveryPro_dispatchDetailWidth', detailPanel.offsetWidth);
        }
    });

    resizer.dataset.bound = 'true';
}

// ==========================================
// 3. 자동할당 기사 목록 및 가중치 / 전체선택 제어
// ==========================================
export const autoDispatchState = {
    selectedDrivers: new Set(),
    weights: {},
    isInit: false
};

export function toggleAllDispatchDrivers(isChecked) {
    const drivers = getFilteredVisibleDrivers();
    if (isChecked) {
        drivers.forEach(d => autoDispatchState.selectedDrivers.add(d.deviceId || d.key));
    } else {
        autoDispatchState.selectedDrivers.clear();
    }
    renderDispatchDriverList();
}

export function renderDispatchDriverList() {
    initDispatchResizer();

    const listEl = document.getElementById('dispatch-driver-list');
    const countEl = document.getElementById('dispatch-driver-count');
    const chkAll = document.getElementById('chk-dispatch-drivers-all');
    if (!listEl || !countEl) return;
    
    const drivers = getFilteredVisibleDrivers();
    
    if (!autoDispatchState.isInit && drivers.length > 0) {
        drivers.forEach(d => autoDispatchState.selectedDrivers.add(d.deviceId || d.key));
        autoDispatchState.isInit = true;
    }

    countEl.innerText = `${autoDispatchState.selectedDrivers.size} / ${drivers.length}명`;
    
    if (chkAll) {
        chkAll.checked = (drivers.length > 0 && autoDispatchState.selectedDrivers.size === drivers.length);
    }

    if (drivers.length === 0) {
        listEl.innerHTML = `<div class="text-center text-gray-400 py-10 text-[10px] font-bold">등록된 운행 기사가 없습니다.</div>`; 
        return;
    }
    
    let html = '';
    drivers.forEach((d) => {
        const devId = d.deviceId || d.key; 
        const phoneDisplay = d.phone || d.key;
        const licKey = d.key || '';
        const tLat = d.territoryLat || ''; 
        const tLng = d.territoryLng || ''; 
        const tScale = d.territoryScale || ''; 
        const t1 = d.territory1 || ''; 
        const t2 = d.territory2 || '';
        
        let territoryBadge = '';
        if (tLat && tLng) {
            let scaleLabel = tScale === 'gu' ? '구/군' : (tScale === 'si' ? '시/도' : '동/읍/면');
            territoryBadge = `
                <div class="flex flex-col items-end gap-1" onclick="event.stopPropagation()">
                    <button type="button" onclick="window.openDriverTerritoryModal('${devId}', '${phoneDisplay}', '${tLat}', '${tLng}', '${tScale}')" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1.5 rounded-xl font-black shadow-xs transition active:scale-95 whitespace-nowrap flex items-center gap-1.5">
                        <i class="fa-solid fa-map-location-dot text-[11px]"></i> 권역 설정 (${scaleLabel})
                    </button>
                    <span class="text-[10px] text-gray-500 font-bold truncate max-w-[140px] text-right" title="${t1} ${t2}">
                        <i class="fa-solid fa-location-dot text-indigo-400 mr-0.5"></i>${t1 || t2 || '설정됨'}
                    </span>
                </div>`;
        } else {
            territoryBadge = `
                <div class="flex flex-col items-end gap-1" onclick="event.stopPropagation()">
                    <button type="button" onclick="window.openDriverTerritoryModal('${devId}', '${phoneDisplay}', '', '', '')" class="bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-300 text-xs px-3 py-1.5 rounded-xl font-black transition active:scale-95 whitespace-nowrap flex items-center gap-1.5">
                        <i class="fa-solid fa-triangle-exclamation text-amber-500 text-[11px]"></i> 권역 미설정
                    </button>
                    <span class="text-[10px] text-amber-600 font-bold">권역 설정 필요</span>
                </div>`;
        }

        const isFocus = state.selectedDispatchDriverId === devId;
        const isChecked = autoDispatchState.selectedDrivers.has(devId);
        const weight = autoDispatchState.weights[devId] || 0;
        const weightText = weight > 0 ? `+${weight}` : weight;

        html += `
        <div onclick="window.selectDispatchDriver('${devId}')" class="cursor-pointer bg-white border ${isFocus ? 'border-blue-500 ring-2 ring-blue-300 bg-blue-50/30' : 'border-gray-200 hover:border-blue-400'} p-3 rounded-2xl flex flex-col gap-2.5 shadow-xs transition mb-2.5">
            <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2.5 mt-1 flex-1 min-w-0">
                    <input type="checkbox" onclick="event.stopPropagation()" onchange="window.toggleDispatchDriver('${devId}')" ${isChecked ? 'checked' : ''} class="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer shrink-0">
                    <div class="min-w-0 select-none">
                        <span class="font-black text-[13px] ${isFocus ? 'text-blue-700' : 'text-gray-900'} block truncate leading-tight">
                            <i class="fa-solid fa-truck ${isFocus ? 'text-blue-600' : 'text-gray-400'} mr-1 text-xs"></i>${phoneDisplay}
                        </span>
                        <span class="text-[10px] text-gray-400 font-mono block mt-0.5">ID: ${licKey}</span>
                    </div>
                </div>
                <div class="shrink-0">${territoryBadge}</div>
            </div>
            
            <div class="flex items-center justify-between bg-gray-50 p-2 rounded-xl border border-gray-100" onclick="event.stopPropagation()">
                <span class="text-[11px] font-black text-gray-600 flex items-center gap-1">
                    <i class="fa-solid fa-scale-balanced text-gray-400 text-xs"></i> 물량 가중치
                </span>
                <div class="flex items-center bg-white border border-gray-200 rounded-lg shadow-2xs">
                    <button onclick="window.adjustDriverWeight('${devId}', -0.5)" class="px-2.5 py-1 hover:bg-gray-100 text-gray-700 font-black text-xs border-r border-gray-200 transition active:scale-95" title="가중치 감소">-</button>
                    <span class="w-10 text-center text-xs font-black ${weight > 0 ? 'text-blue-600' : (weight < 0 ? 'text-red-500' : 'text-gray-700')}">${weightText}</span>
                    <button onclick="window.adjustDriverWeight('${devId}', 0.5)" class="px-2.5 py-1 hover:bg-gray-100 text-gray-700 font-black text-xs border-l border-gray-200 transition active:scale-95" title="가중치 증가">+</button>
                </div>
            </div>
        </div>`;
    });
    listEl.innerHTML = html;
}

export function toggleDispatchDriver(devId) {
    if(autoDispatchState.selectedDrivers.has(devId)) autoDispatchState.selectedDrivers.delete(devId);
    else autoDispatchState.selectedDrivers.add(devId);
    renderDispatchDriverList();
}

export function adjustDriverWeight(devId, delta) {
    let w = autoDispatchState.weights[devId] || 0;
    w += delta;
    autoDispatchState.weights[devId] = w;
    renderDispatchDriverList();
}

export function selectDispatchDriver(devId) {
    state.selectedDispatchDriverId = devId;
    renderDispatchDriverList(); 
    renderDispatchDriverDetail(); 
}

// ==========================================
// 4. 기사별 할당 상세 내역 및 수동 기사 재배정 UI (주소지별 정렬 탑재)
// ==========================================

// 🌟 주소지별 정렬 상태 변수 ('none', 'asc', 'desc')
let detailAddressSortState = 'none';

export function sortDetailByAddress() {
    if (detailAddressSortState === 'none' || detailAddressSortState === 'desc') {
        detailAddressSortState = 'asc';
    } else {
        detailAddressSortState = 'desc';
    }
    renderDispatchDriverDetail();
}

export function renderDispatchDriverDetail() {
    const header = document.getElementById('detail-driver-header');
    const table = document.getElementById('detail-driver-table');
    const tbody = document.getElementById('detail-driver-tbody');
    const badge = document.getElementById('detail-driver-count-badge');
    
    // 기사가 선택되지 않았을 때
    if (!state.selectedDispatchDriverId) {
        if (header) header.classList.remove('hidden'); 
        if (table) table.classList.add('hidden'); 
        if (badge) badge.classList.add('hidden'); 
        return;
    }

    const targetLic = state.allLicenses.find(l => l.deviceId === state.selectedDispatchDriverId || l.key === state.selectedDispatchDriverId);
    const driverName = targetLic ? (targetLic.phone || targetLic.key) : state.selectedDispatchDriverId;
    let assignedItems = state.parsedExcelList.filter(item => item.assignedDriver === driverName);
    const visibleDrivers = getFilteredVisibleDrivers();

    if (header) header.classList.add('hidden'); 
    if (table) table.classList.remove('hidden'); 
    if (badge) {
        badge.classList.remove('hidden');
        badge.innerText = `총 ${assignedItems.length}건`;
    }

    if (assignedItems.length === 0) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="text-center py-16 text-gray-400 font-bold text-[11px]"><i class="fa-solid fa-box-open text-3xl text-gray-300 mb-2 block"></i>배정된 배송 건이 없습니다.</td></tr>`; 
        return;
    }

    // 🌟 주소지별 가나다순 정렬 적용
    if (detailAddressSortState !== 'none') {
        assignedItems = [...assignedItems].sort((a, b) => {
            const addrA = (a.address || a.fullAddress || '').trim();
            const addrB = (b.address || b.fullAddress || '').trim();
            if (detailAddressSortState === 'asc') {
                return addrA.localeCompare(addrB, 'ko');
            } else {
                return addrB.localeCompare(addrA, 'ko');
            }
        });
    }

    // 🌟 테이블 헤더 정렬 화살표 갱신
    const arrowSymbol = detailAddressSortState === 'asc' ? ' ▲' : (detailAddressSortState === 'desc' ? ' ▼' : ' ↕');
    const theadAddressTh = table ? table.querySelector('thead tr th:nth-child(2)') : null;
    if (theadAddressTh) {
        theadAddressTh.className = "font-black cursor-pointer hover:bg-gray-100 select-none transition py-2 px-2 text-blue-700";
        theadAddressTh.onclick = () => window.sortDetailByAddress();
        theadAddressTh.title = "클릭 시 주소지(지역별) 가나다순으로 정렬합니다";
        theadAddressTh.innerHTML = `배송지 주소 / 고객 정보 <span class="text-[10px] text-blue-600 font-bold">${arrowSymbol}</span>`;
    }

    let html = '';
    assignedItems.forEach((item, idx) => {
        let driverSelectOptions = `<option value="">-- 미배정 --</option>`;
        visibleDrivers.forEach(d => {
            const dName = d.phone || d.key;
            driverSelectOptions += `<option value="${dName}" ${dName === driverName ? 'selected' : ''}>${dName}</option>`;
        });

        const tooltipAddress = item.fullAddress || item.address || '';

        html += `
        <tr class="hover:bg-blue-50/50 transition">
            <td class="text-center font-bold text-gray-500 w-12">${item.displayNumber || idx + 1}</td>
            <td class="font-bold text-gray-800 whitespace-normal break-keep" title="${tooltipAddress}">
                ${item.storeName ? `<span class="bg-gray-100 text-gray-700 text-[10px] px-1.5 py-0.5 rounded font-black mr-1">${item.storeName}</span>` : ''}
                ${item.address || '-'}
                ${item.phone ? `<span class="text-[10px] text-gray-400 font-normal block mt-0.5"><i class="fa-solid fa-phone text-[9px] mr-1 text-blue-500"></i>${item.phone}</span>` : ''}
            </td>
            <td class="text-center w-36" onclick="event.stopPropagation()">
                <select onchange="window.changeOrderDriver('${item.id}', this.value)" class="w-full bg-white border border-gray-300 hover:border-blue-500 rounded-lg p-1 text-[11px] font-bold text-gray-800 outline-none shadow-2xs cursor-pointer">
                    ${driverSelectOptions}
                </select>
            </td>
        </tr>`; 
    });
    if (tbody) tbody.innerHTML = html;
}

export function changeOrderDriver(itemId, newDriverPhone) {
    let item = state.parsedExcelList.find(o => String(o.id) === String(itemId) || String(o.orderNo) === String(itemId));
    if (!item && !isNaN(itemId)) {
        item = state.parsedExcelList[parseInt(itemId, 10)];
    }
    if (!item) return;

    item.assignedDriver = newDriverPhone || null;
    if (window.renderDispatchDriverDetail) window.renderDispatchDriverDetail();
    if (window.renderDispatchDriverList) window.renderDispatchDriverList();
    if (window.renderExcelTable) window.renderExcelTable();
    if (window.autoSaveExcelToFirebase) window.autoSaveExcelToFirebase();
}

// ==========================================
// 5. 할당 초기화
// ==========================================
export async function revertAutoDispatch() {
    if (!state.parsedExcelList || state.parsedExcelList.length === 0) {
        alert("초기화할 배송 데이터가 없습니다.");
        return;
    }

    if (!confirm("기사들에게 배정된 모든 할당 내역을 초기화하시겠습니까?\n\n* 관제 엑셀 데이터는 유지되며, 기사 스마트폰(앱)에 전송된 배송 동선도 함께 완전 초기화됩니다.")) {
        return;
    }

    state.parsedExcelList.forEach(item => {
        item.assignedDriver = null;
    });

    if (window.renderExcelTable) window.renderExcelTable();
    if (window.renderDispatchDriverList) window.renderDispatchDriverList();
    if (window.renderDispatchDriverDetail) window.renderDispatchDriverDetail();
    if (window.autoSaveExcelToFirebase) await window.autoSaveExcelToFirebase();

    const visibleDrivers = getFilteredVisibleDrivers();
    let clearedDriverCount = 0;

    for (const d of visibleDrivers) {
        const devId = d.deviceId || d.key;
        try {
            await deleteDoc(doc(db, "routes", devId));
            clearedDriverCount++;
        } catch (e) {
            console.error(`기사(${devId}) 동선 초기화 실패:`, e);
        }
    }

    alert(`[할당 초기화 완료]\n관제 엑셀 배정이 미배정으로 초기화되었으며,\n운행 기사(${clearedDriverCount}명) 스마트폰 앱의 동선도 즉시 초기화되었습니다.`);
}

// ==========================================
// 🌟 6. 자동할당 알고리즘 실행 (지형지물 및 하천 우회 가상 페널티 결합)
// ==========================================
export function runAutoDispatchAlgorithm() { 
    if (!state.parsedExcelList || state.parsedExcelList.length === 0) {
        alert("할당할 엑셀/주문 데이터가 없습니다."); 
        return;
    }
    
    const activeDrivers = getFilteredVisibleDrivers().filter(d => 
        autoDispatchState.selectedDrivers.has(d.deviceId || d.key)
    );
    
    if (activeDrivers.length === 0) {
        alert("자동 할당 대상 기사가 없습니다. 좌측 기사 목록에서 배정할 기사를 1명 이상 체크해주세요."); 
        return;
    }

    const checkedBoxes = document.querySelectorAll('.row-checkbox:checked');
    if (checkedBoxes.length === 0) {
        alert("자동할당할 배송지를 우측 [전체 현황]에서 체크박스로 선택해 주세요.\n\n* 전체 할당: 테이블 헤더의 전체 선택 체크박스 체크 후 실행\n* 일부 할당: 배정할 배송지만 체크박스 선택 후 실행");
        return;
    }

    const selectedIndices = Array.from(checkedBoxes).map(cb => parseInt(cb.getAttribute('data-idx'), 10));
    const targetOrders = selectedIndices.map(idx => state.parsedExcelList[idx]).filter(Boolean);

    if (targetOrders.length === 0) {
        alert("선택된 배송지 데이터가 유효하지 않습니다.");
        return;
    }

    const totalOrders = targetOrders.length;
    const numDrivers = activeDrivers.length;
    
    let totalWeights = 0;
    activeDrivers.forEach(d => { totalWeights += (autoDispatchState.weights[d.deviceId || d.key] || 0); });

    const companyBaseStr = localStorage.getItem('deliveryProCompanyBase');
    const companyBase = companyBaseStr ? JSON.parse(companyBaseStr) : null;

    let driverStats = activeDrivers.map(d => {
        const devId = d.deviceId || d.key;
        let w = autoDispatchState.weights[devId] || 0;
        
        let exactCap = (totalOrders / numDrivers) + w - (totalWeights / numDrivers);
        if (exactCap < 0) exactCap = 0;

        const centerLat = d.territoryLat || (companyBase ? companyBase.lat : null);
        const centerLng = d.territoryLng || (companyBase ? companyBase.lng : null);
        const centerAddr = d.territory1 || (companyBase ? companyBase.address : '') || '';

        return {
            devId,
            phone: d.phone || devId,
            exactCap,
            targetCap: Math.floor(exactCap),
            remainder: exactCap - Math.floor(exactCap),
            assignedCount: 0,
            tLat: centerLat,
            tLng: centerLng,
            tAddr: centerAddr
        };
    });

    let currentSum = driverStats.reduce((sum, d) => sum + d.targetCap, 0);
    let diff = totalOrders - currentSum;
    
    driverStats.sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < diff; i++) {
        driverStats[i % driverStats.length].targetCap++;
    }

    // 외곽 물량 우선 할당을 위해 본사 거점 기준 정렬
    const ordersWithDist = targetOrders.map(order => {
        let distFromBase = 0;
        if (order.lat && order.lng && companyBase && companyBase.lat && companyBase.lng) {
            distFromBase = calculateGeoPenalizedDist(
                order.lat, order.lng, 
                companyBase.lat, companyBase.lng, 
                order.fullAddress || order.address || '', 
                companyBase.address || ''
            );
        }
        return { order, distFromBase };
    });

    ordersWithDist.sort((a, b) => b.distFromBase - a.distFromBase);

    // 🌟 지형지물 우회 가상 페널티를 적용하여 최적 기사 탐색 및 배분
    ordersWithDist.forEach(({ order }) => {
        let bestDriver = null;
        let minDistance = Infinity;

        driverStats.forEach(ds => {
            if (ds.assignedCount >= ds.targetCap) return;

            let d = 999999;
            if (order.lat && order.lng && ds.tLat && ds.tLng) {
                d = calculateGeoPenalizedDist(
                    order.lat, order.lng, 
                    ds.tLat, ds.tLng, 
                    order.fullAddress || order.address || '', 
                    ds.tAddr
                );
            } else if (order.lat && order.lng && companyBase) {
                d = calculateGeoPenalizedDist(
                    order.lat, order.lng, 
                    companyBase.lat, companyBase.lng, 
                    order.fullAddress || order.address || '', 
                    companyBase.address || ''
                );
            }

            if (d < minDistance) {
                minDistance = d;
                bestDriver = ds;
            }
        });

        // 허용 한도 초과 시에도 지형 우회 페널티를 고려한 차선 기사 선택
        if (!bestDriver) {
            let absMinDist = Infinity;
            driverStats.forEach(ds => {
                let d = 999999;
                if (order.lat && order.lng && ds.tLat && ds.tLng) {
                    d = calculateGeoPenalizedDist(
                        order.lat, order.lng, 
                        ds.tLat, ds.tLng, 
                        order.fullAddress || order.address || '', 
                        ds.tAddr
                    );
                }
                if (d < absMinDist) {
                    absMinDist = d;
                    bestDriver = ds;
                }
            });
            if (!bestDriver) {
                bestDriver = driverStats.reduce((prev, curr) => (prev.assignedCount < curr.assignedCount) ? prev : curr);
            }
        }

        bestDriver.assignedCount++;
        order.assignedDriver = bestDriver.phone;
    });

    if (window.renderExcelTable) window.renderExcelTable();
    if (window.renderDispatchDriverList) window.renderDispatchDriverList();
    if (window.renderDispatchDriverDetail) window.renderDispatchDriverDetail();
    if (window.autoSaveExcelToFirebase) window.autoSaveExcelToFirebase();
    
    alert(`[자동할당 배분 완료]\n지형(하천/산맥) 우회 원칙에 따라 총 ${totalOrders}건이 ${activeDrivers.length}명의 기사에게 스마트하게 배분되었습니다.\n\n내역 검토 후 이상이 없으면 [동선 전송] 버튼을 눌러주세요.`);
}

// ==========================================
// 7. 토글(체크박스) 선택 기반 직관적 동선 전송 엔진
// ==========================================
export async function sendRoutesToDrivers() {
    if (!state.parsedExcelList || state.parsedExcelList.length === 0) {
        alert("전송할 배송 데이터가 없습니다.");
        return;
    }

    const visibleDrivers = getFilteredVisibleDrivers();

    const selectedDriverList = visibleDrivers.filter(d => 
        autoDispatchState.selectedDrivers.has(d.deviceId || d.key)
    );

    if (selectedDriverList.length === 0) {
        alert("동선을 전송할 기사를 좌측 목록에서 1명 이상 체크(선택)해 주세요.\n(상단의 [전체선택] 토글을 이용해 전원 선택도 가능합니다.)");
        return;
    }

    const driverMap = {};
    selectedDriverList.forEach(d => {
        const dName = d.phone || d.key;
        const dKey = d.key;
        const devId = d.deviceId || d.key;

        const orders = state.parsedExcelList.filter(o => 
            o.assignedDriver && (o.assignedDriver === dName || o.assignedDriver === dKey || o.assignedDriver === devId)
        );

        if (orders.length > 0) {
            driverMap[devId] = { driver: d, orders };
        }
    });

    const sendTargetDevIds = Object.keys(driverMap);
    if (sendTargetDevIds.length === 0) {
        alert("체크된 기사님들 중 현재 배정된 주문이 있는 기사가 없습니다.\n자동할당을 먼저 실행하거나 기사를 배정해 주세요.");
        return;
    }

    const totalOrdersToSend = sendTargetDevIds.reduce((sum, id) => sum + driverMap[id].orders.length, 0);

    if (!confirm(`체크된 기사 총 ${sendTargetDevIds.length}명에게 ${totalOrdersToSend}건의 배송 동선을 전송하시겠습니까?\n\n* 전송 즉시 기사 스마트폰 앱에 배송 코스가 실시간으로 등록됩니다.`)) {
        return;
    }

    const btn = document.getElementById('btn-send-routes-to-drivers');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 전송 중...';
    }

    try {
        let successCount = 0;
        for (const devId of sendTargetDevIds) {
            const { driver: matchedLic, orders } = driverMap[devId];

            const destinations = orders.map((ord, idx) => ({
                displayNumber: idx + 1,
                address: ord.address || '',
                fullAddress: ord.fullAddress || ord.address || '',
                storeName: ord.storeName || ord.senderName || '',
                phone: ord.phone || '', 
                lat: ord.lat || null,
                lng: ord.lng || null,
                orderNo: ord.orderNo || '', 
                memo: ord.memo || '',
                items: ord.items || (ord.itemName ? [{ name: ord.itemName, qty: ord.qty || 1, unit: ord.unit || '' }] : [])
            }));

            await setDoc(doc(db, "routes", devId), {
                deviceId: devId,
                phone: matchedLic.phone || devId,
                dispatchKey: matchedLic.dispatchKey || sessionStorage.getItem('deliveryProDispatchKey') || '',
                destinations: destinations,
                updatedAt: Date.now()
            }, { merge: true });

            successCount++;
        }

        alert(`[동선 전송 완료]\n체크된 기사 총 ${successCount}명의 스마트폰으로 배송 동선이 성공적으로 전송되었습니다.`);
    } catch (e) {
        alert("기사 앱 전송 중 오류 발생: " + e.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-paper-plane text-sm"></i> 동선 전송';
        }
    }
}

// ==========================================
// 8. 선택된 기사 전용 상품 합산 피킹 리스트 (100% 온전 보존)
// ==========================================
export function printSelectedDriverItemList() {
    if (!state.selectedDispatchDriverId) {
        alert("출력할 기사를 좌측 목록에서 먼저 선택해 주세요.");
        return;
    }

    const targetLic = state.allLicenses.find(l => l.deviceId === state.selectedDispatchDriverId || l.key === state.selectedDispatchDriverId);
    const driverName = targetLic ? (targetLic.phone || targetLic.key) : state.selectedDispatchDriverId;
    const assignedItems = state.parsedExcelList.filter(item => item.assignedDriver === driverName);

    if (!assignedItems || assignedItems.length === 0) {
        alert(`[${driverName}] 기사님에게 배정된 배송 주문 및 상품 데이터가 없습니다.`);
        return;
    }

    const aggregationMap = {};

    assignedItems.forEach(order => {
        if (order.items && order.items.length > 0) {
            order.items.forEach(it => {
                const name = it.name ? it.name.trim() : '기타 품목';
                const qty = parseInt(it.qty, 10) || 1;
                if (!aggregationMap[name]) aggregationMap[name] = 0;
                aggregationMap[name] += qty;
            });
        } else {
            const name = order.itemName ? order.itemName.trim() : '상품명 미지정';
            const qty = parseInt(order.qty, 10) || 1;
            if (!aggregationMap[name]) aggregationMap[name] = 0;
            aggregationMap[name] += qty;
        }
    });

    const dateStr = getLocalDateString();
    
    let listHtml = '';
    for (const [name, qty] of Object.entries(aggregationMap)) {
        listHtml += `
        <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #ccc; padding: 6px 0;">
            <span style="font-size: 15px;">${name}</span>
            <span style="font-size: 15px; font-weight: bold;">${qty}</span>
        </div>`;
    }

    const simplePrintHtml = `<!DOCTYPE html>
    <html lang="ko">
    <head>
        <meta charset="UTF-8">
        <title>기사별 할당 상품 출력</title>
        <style>
            body { 
                font-family: 'Malgun Gothic', 'Dotum', sans-serif; 
                padding: 20px; 
                color: #000; 
                margin: 0 auto; 
                max-width: 450px; 
            }
            @media print { 
                body { padding: 0; } 
            }
            .header-info { 
                margin-bottom: 20px; 
                padding-bottom: 10px; 
                border-bottom: 2px solid #000; 
            }
            .header-info div { 
                margin-bottom: 5px; 
                font-size: 16px; 
                font-weight: bold; 
            }
            .col-header { 
                display: flex; 
                justify-content: space-between; 
                font-size: 14px; 
                font-weight: bold; 
                color: #555; 
                margin-bottom: 5px; 
            }
        </style>
    </head>
    <body>
        <div class="header-info">
            <div>날짜 : ${dateStr}</div>
            <div>기사 ID : ${driverName}</div>
        </div>
        <div class="col-header">
            <span>품목명</span>
            <span>수량</span>
        </div>
        ${listHtml}
    </body>
    </html>`;

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;z-index:-1;';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(simplePrintHtml);
    doc.close();

    iframe.onload = function() {
        setTimeout(() => {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
            setTimeout(() => { document.body.removeChild(iframe); }, 1000);
        }, 500);
    };
}

// ==========================================
// 9. 전역 Window 객체 바인딩 (100% 온전 보존)
// ==========================================
window.saveCompanyBaseAddress = saveCompanyBaseAddress;
window.clearCompanyBaseAddress = clearCompanyBaseAddress;
window.updateCompanyBaseUI = updateCompanyBaseUI;
window.initDispatchResizer = initDispatchResizer;
window.toggleAllDispatchDrivers = toggleAllDispatchDrivers;
window.toggleDispatchDriver = toggleDispatchDriver;
window.adjustDriverWeight = adjustDriverWeight;
window.selectDispatchDriver = selectDispatchDriver;
window.sortDetailByAddress = sortDetailByAddress; // 주소지 정렬 함수
window.renderDispatchDriverDetail = renderDispatchDriverDetail;
window.changeOrderDriver = changeOrderDriver;
window.runAutoDispatchAlgorithm = runAutoDispatchAlgorithm;
window.revertAutoDispatch = revertAutoDispatch;
window.sendRoutesToDrivers = sendRoutesToDrivers;
window.printSelectedDriverItemList = printSelectedDriverItemList; // 외부 참조 완전 보존