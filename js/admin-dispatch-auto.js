// js/admin-dispatch-auto.js

import { db } from "./admin-api.js";
import { state, getLocalDateString } from "./admin-state.js";
import { getFilteredVisibleDrivers, formatNumber } from "./admin-dispatch-core.js";
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

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
// 2. 자동할당 기사 목록 및 가중치 제어
// ==========================================
export const autoDispatchState = {
    selectedDrivers: new Set(),
    weights: {},
    isInit: false
};

export function renderDispatchDriverList() {
    const listEl = document.getElementById('dispatch-driver-list');
    const countEl = document.getElementById('dispatch-driver-count');
    if (!listEl || !countEl) return;
    
    const drivers = getFilteredVisibleDrivers();
    
    if (!autoDispatchState.isInit && drivers.length > 0) {
        drivers.forEach(d => autoDispatchState.selectedDrivers.add(d.deviceId || d.key));
        autoDispatchState.isInit = true;
    }

    countEl.innerText = `${autoDispatchState.selectedDrivers.size} / ${drivers.length}명`;
    
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
// 3. 기사별 할당 상세 내역 및 수동 기사 재배정 UI
// ==========================================
export function renderDispatchDriverDetail() {
    const header = document.getElementById('detail-driver-header');
    const table = document.getElementById('detail-driver-table');
    const tbody = document.getElementById('detail-driver-tbody');
    const badge = document.getElementById('detail-driver-count-badge');
    const btnDriverPrint = document.getElementById('btn-driver-items-print');
    const btnSendRoutes = document.getElementById('btn-send-routes-to-drivers'); // 🌟 이동된 동선 전송 버튼
    
    // 🌟 기사 선택 해제 상태일 때 버튼 감추기
    if (!state.selectedDispatchDriverId) {
        if (header) header.classList.remove('hidden'); 
        if (table) table.classList.add('hidden'); 
        if (badge) badge.classList.add('hidden'); 
        if (btnDriverPrint) btnDriverPrint.classList.add('hidden');
        if (btnSendRoutes) btnSendRoutes.classList.add('hidden');
        return;
    }

    const targetLic = state.allLicenses.find(l => l.deviceId === state.selectedDispatchDriverId || l.key === state.selectedDispatchDriverId);
    const driverName = targetLic ? (targetLic.phone || targetLic.key) : state.selectedDispatchDriverId;
    const assignedItems = state.parsedExcelList.filter(item => item.assignedDriver === driverName);
    const visibleDrivers = getFilteredVisibleDrivers();

    if (header) header.classList.add('hidden'); 
    if (table) table.classList.remove('hidden'); 
    if (badge) {
        badge.classList.remove('hidden');
        badge.innerText = `총 ${assignedItems.length}건`;
    }

    if (assignedItems.length === 0) {
        if (btnDriverPrint) btnDriverPrint.classList.add('hidden');
        if (btnSendRoutes) btnSendRoutes.classList.add('hidden');
        if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="text-center py-16 text-gray-400 font-bold text-[11px]"><i class="fa-solid fa-box-open text-3xl text-gray-300 mb-2 block"></i>배정된 배송 건이 없습니다.</td></tr>`; 
        return;
    }

    // 🌟 선택된 기사에게 배정된 물량이 1건 이상일 때만 상품 합산 출력 버튼 및 전송 버튼 노출
    if (btnDriverPrint) btnDriverPrint.classList.remove('hidden');
    if (btnSendRoutes) btnSendRoutes.classList.remove('hidden');

    let html = '';
    assignedItems.forEach((item, idx) => {
        let driverSelectOptions = `<option value="">-- 미배정 --</option>`;
        visibleDrivers.forEach(d => {
            const dName = d.phone || d.key;
            driverSelectOptions += `<option value="${dName}" ${dName === driverName ? 'selected' : ''}>${dName}</option>`;
        });

        html += `
        <tr class="hover:bg-blue-50/50 transition">
            <td class="text-center font-bold text-gray-500 w-12">${item.displayNumber || idx + 1}</td>
            <td class="font-bold text-gray-800 whitespace-normal break-keep">
                ${item.storeName ? `<span class="bg-gray-100 text-gray-700 text-[10px] px-1.5 py-0.5 rounded font-black mr-1">${item.storeName}</span>` : ''}
                ${item.address || '-'}
                ${item.phone ? `<span class="text-[10px] text-gray-400 font-normal block mt-0.5"><i class="fa-solid fa-phone text-[9px] mr-1"></i>${item.phone}</span>` : ''}
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

// 개별 주문의 담당 기사를 수동으로 변경하는 함수
export function changeOrderDriver(itemId, newDriverPhone) {
    const item = state.parsedExcelList.find(o => String(o.id) === String(itemId));
    if (!item) return;

    item.assignedDriver = newDriverPhone || null;
    renderDispatchDriverDetail();
    renderDispatchDriverList();
    if (window.renderExcelTable) window.renderExcelTable();
    if (window.autoSaveExcelToFirebase) window.autoSaveExcelToFirebase();
}

// ==========================================
// 4. 자동할당 알고리즘 실행 (외곽 우선 1원칙)
// ==========================================
export function runAutoDispatchAlgorithm() { 
    if (!state.parsedExcelList || state.parsedExcelList.length === 0) {
        alert("할당할 엑셀 데이터가 없습니다."); return;
    }
    
    const activeDrivers = getFilteredVisibleDrivers().filter(d => 
        autoDispatchState.selectedDrivers.has(d.deviceId || d.key)
    );
    
    if (activeDrivers.length === 0) {
        alert("자동 할당 대상 기사가 없습니다. 목록에서 배정할 기사를 체크해주세요."); return;
    }

    const unassignedOrders = state.parsedExcelList.filter(o => !o.assignedDriver);
    if (unassignedOrders.length === 0) {
        alert("모든 주문이 이미 기사들에게 할당되었습니다."); return;
    }

    const totalOrders = unassignedOrders.length;
    const numDrivers = activeDrivers.length;
    
    let totalWeights = 0;
    activeDrivers.forEach(d => { totalWeights += (autoDispatchState.weights[d.deviceId || d.key] || 0); });

    const getDist = (lat1, lon1, lat2, lon2) => {
        if (!lat1 || !lon1 || !lat2 || !lon2) return 999999;
        const R = 6371; 
        const dLat = (lat2 - lat1) * Math.PI / 180; 
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + 
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    const companyBaseStr = localStorage.getItem('deliveryProCompanyBase');
    const companyBase = companyBaseStr ? JSON.parse(companyBaseStr) : null;

    let driverStats = activeDrivers.map(d => {
        const devId = d.deviceId || d.key;
        let w = autoDispatchState.weights[devId] || 0;
        
        let exactCap = (totalOrders / numDrivers) + w - (totalWeights / numDrivers);
        if (exactCap < 0) exactCap = 0;

        const centerLat = d.territoryLat || (companyBase ? companyBase.lat : null);
        const centerLng = d.territoryLng || (companyBase ? companyBase.lng : null);

        return {
            devId,
            phone: d.phone || devId,
            exactCap,
            targetCap: Math.floor(exactCap),
            remainder: exactCap - Math.floor(exactCap),
            assignedCount: 0,
            tLat: centerLat,
            tLng: centerLng
        };
    });

    let currentSum = driverStats.reduce((sum, d) => sum + d.targetCap, 0);
    let diff = totalOrders - currentSum;
    
    driverStats.sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < diff; i++) {
        driverStats[i % driverStats.length].targetCap++;
    }

    const ordersWithDist = unassignedOrders.map(order => {
        let distFromBase = 0;
        if (order.lat && order.lng && companyBase && companyBase.lat && companyBase.lng) {
            distFromBase = getDist(order.lat, order.lng, companyBase.lat, companyBase.lng);
        }
        return { order, distFromBase };
    });

    ordersWithDist.sort((a, b) => b.distFromBase - a.distFromBase);

    ordersWithDist.forEach(({ order }) => {
        let bestDriver = null;
        let minDistance = Infinity;

        driverStats.forEach(ds => {
            if (ds.assignedCount >= ds.targetCap) return;

            let d = 999999;
            if (order.lat && order.lng && ds.tLat && ds.tLng) {
                d = getDist(order.lat, order.lng, ds.tLat, ds.tLng);
            } else if (order.lat && order.lng && companyBase) {
                d = getDist(order.lat, order.lng, companyBase.lat, companyBase.lng);
            }

            if (d < minDistance) {
                minDistance = d;
                bestDriver = ds;
            }
        });

        if (!bestDriver) {
            let absMinDist = Infinity;
            driverStats.forEach(ds => {
                let d = 999999;
                if (order.lat && order.lng && ds.tLat && ds.tLng) {
                    d = getDist(order.lat, order.lng, ds.tLat, ds.tLng);
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
    if (window.autoSaveExcelToFirebase) window.autoSaveExcelToFirebase();
    alert(`[자동할당 배분 완료]\n외곽 물량 우선 할당 원칙에 따라 총 ${totalOrders}건이 ${activeDrivers.length}명의 기사에게 성공적으로 배분되었습니다.\n\n내역 검토 후 이상이 없으면 상단의 [기사 앱으로 동선 전송]을 눌러주세요.`);
    
    if (window.renderDispatchDriverDetail) window.renderDispatchDriverDetail();
}

// ==========================================
// 5. 기사 앱 수동 전송 엔진 (숨은 주문번호 탑재)
// ==========================================
export async function sendRoutesToDrivers() {
    // 🌟 선택된 기사의 데이터만 전송하도록 조건 수정 (전체 전송 방지)
    if (!state.selectedDispatchDriverId) {
        alert("전송할 기사를 좌측 목록에서 먼저 선택해 주세요.");
        return;
    }

    const targetLic = state.allLicenses.find(l => l.deviceId === state.selectedDispatchDriverId || l.key === state.selectedDispatchDriverId);
    if (!targetLic) return;
    
    const driverName = targetLic.phone || targetLic.key;
    const assignedOrders = state.parsedExcelList.filter(item => item.assignedDriver === driverName);

    if (assignedOrders.length === 0) {
        alert(`[${driverName}] 기사님에게 배정된 주문이 없습니다.`);
        return;
    }

    if (!confirm(`[${driverName}] 기사님에게 총 ${assignedOrders.length}건의 배송 코스를 전송하시겠습니까?\n\n* 전송 즉시 해당 기사의 스마트폰 앱에 반영됩니다.`)) {
        return;
    }

    const btn = document.getElementById('btn-send-routes-to-drivers');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 기사 앱 전송 중...';
    }

    try {
        const devId = targetLic.deviceId || targetLic.key;

        const destinations = assignedOrders.map((ord, idx) => ({
            displayNumber: idx + 1,
            address: ord.address || '',
            storeName: ord.storeName || ord.senderName || '',
            phone: ord.phone || '',
            lat: ord.lat || null,
            lng: ord.lng || null,
            orderNo: ord.orderNo || '', // 숨겨진 주문번호
            memo: ord.memo || '',
            items: ord.items || (ord.itemName ? [{ name: ord.itemName, qty: ord.qty || 1, unit: ord.unit || '' }] : [])
        }));

        await setDoc(doc(db, "routes", devId), {
            deviceId: devId,
            phone: targetLic.phone || devId,
            dispatchKey: targetLic.dispatchKey || sessionStorage.getItem('deliveryProDispatchKey') || '',
            destinations: destinations,
            updatedAt: Date.now()
        }, { merge: true });

        alert(`[동선 전송 완료]\n해당 기사님의 스마트폰으로 배송 동선이 전송되었습니다.\n기사님은 스캔 없이 앱에서 코스를 바로 확인하고 운행할 수 있습니다.`);
    } catch (e) {
        alert("기사 앱 전송 중 오류 발생: " + e.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-paper-plane text-white"></i> 기사 앱으로 동선 전송';
        }
    }
}

// ==========================================
// 🌟 6. 심플하고 직관적인 상품 합산 피킹 리스트 (1장 출력)
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
        alert(`[${driverName}] 기사님에게 배정된 상품 데이터가 없습니다.`);
        return;
    }

    // 선택된 기사의 품목 그룹화, 수량 합산 및 배송 지역 추출
    const aggregationMap = {};
    const regions = new Set();

    assignedItems.forEach(order => {
        // 배송 지역(구/시 단위) 추출
        if (order.address) {
            const parts = order.address.split(' ').filter(Boolean);
            if (parts.length >= 2) regions.add(`${parts[0]} ${parts[1]}`);
        }

        // 아이템 배열이 있을 경우
        if (order.items && order.items.length > 0) {
            order.items.forEach(it => {
                const name = it.name ? it.name.trim() : '기타 품목';
                const unit = it.unit ? it.unit.trim() : '개';
                const qty = parseInt(it.qty, 10) || 1;
                const key = `${name}___${unit}`;

                if (!aggregationMap[key]) {
                    aggregationMap[key] = { name, unit, totalQty: 0 };
                }
                aggregationMap[key].totalQty += qty;
            });
        } 
        // 하위 호환: itemName이 문자열로 있을 경우
        else if (order.itemName) {
            const name = order.itemName.trim();
            const unit = order.unit ? order.unit.trim() : '개';
            const qty = parseInt(order.qty, 10) || 1;
            const key = `${name}___${unit}`;

            if (!aggregationMap[key]) {
                aggregationMap[key] = { name, unit, totalQty: 0 };
            }
            aggregationMap[key].totalQty += qty;
        }
    });

    const aggregatedList = Object.values(aggregationMap).sort((a, b) => b.totalQty - a.totalQty);
    
    // 메타 정보
    const now = new Date();
    const dateStr = getLocalDateString(now);
    const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    const regionStr = Array.from(regions).join(', ') || '지역 정보 없음';

    let tableRowsHtml = '';
    if (aggregatedList.length === 0) {
        tableRowsHtml = `<tr><td colspan="3" style="padding: 15px; text-align: center; color: #666;">합산할 상품 내역이 없습니다. (주문서에 상품 정보가 누락됨)</td></tr>`;
    } else {
        aggregatedList.forEach((item, idx) => {
            tableRowsHtml += `
            <tr style="border-bottom: 1px solid #e5e7eb;">
                <td style="padding: 10px; text-align: center;">${idx + 1}</td>
                <td style="padding: 10px; font-weight: bold;">${item.name}</td>
                <td style="padding: 10px; text-align: center; color: #1d4ed8; font-weight: bold;">${formatNumber(item.totalQty)} <span style="color: #6b7280; font-weight: normal;">${item.unit}</span></td>
            </tr>`;
        });
    }

    // 🌟 요청하신 단순하고 깔끔한 출력용 HTML 양식
    const pickingHtml = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>기사별 상품 합산 리스트</title><style>
        body { font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; margin: 0; padding: 25px; color: #111827; }
        .header { margin-bottom: 20px; border-bottom: 3px solid #111827; padding-bottom: 15px; text-align: center;}
        .header h2 { margin: 0; font-size: 26px; font-weight: 900; letter-spacing: -0.5px; }
        .info-grid { display: flex; flex-wrap: wrap; gap: 10px 20px; font-size: 15px; margin-bottom: 25px; padding: 15px; background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;}
        .info-item span { font-weight: 900; color: #4b5563; margin-right: 6px; }
        .info-item.full-width { width: 100%; }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th { background-color: #f3f4f6; border-bottom: 2px solid #374151; border-top: 2px solid #374151; padding: 12px; text-align: left; font-weight: 900; }
        th.center { text-align: center; }
    </style></head><body>
        <div class="header">
            <h2>담당 기사 상품 합산 리스트</h2>
        </div>
        <div class="info-grid">
            <div class="info-item"><span>배송 일자:</span> ${dateStr}</div>
            <div class="info-item"><span>출력 시간:</span> ${timeStr}</div>
            <div class="info-item"><span>담당 기사:</span> <b style="color: #1d4ed8; font-size: 16px;">${driverName}</b></div>
            <div class="info-item full-width"><span>배송 구역:</span> ${regionStr}</div>
        </div>
        <table>
            <colgroup>
                <col style="width: 15%;">
                <col style="width: 55%;">
                <col style="width: 30%;">
            </colgroup>
            <thead>
                <tr>
                    <th class="center">순번</th>
                    <th>상 품 명 (품목 규격)</th>
                    <th class="center">합산 총 수량</th>
                </tr>
            </thead>
            <tbody>
                ${tableRowsHtml}
            </tbody>
        </table>
    </body></html>`;

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
            setTimeout(() => { document.body.removeChild(iframe); }, 1000);
        }, 500);
    };
}

// ==========================================
// 7. 전역 Window 객체 바인딩
// ==========================================
window.saveCompanyBaseAddress = saveCompanyBaseAddress;
window.clearCompanyBaseAddress = clearCompanyBaseAddress;
window.updateCompanyBaseUI = updateCompanyBaseUI;
window.toggleDispatchDriver = toggleDispatchDriver;
window.adjustDriverWeight = adjustDriverWeight;
window.selectDispatchDriver = selectDispatchDriver;
window.renderDispatchDriverDetail = renderDispatchDriverDetail;
window.changeOrderDriver = changeOrderDriver;
window.runAutoDispatchAlgorithm = runAutoDispatchAlgorithm;
window.sendRoutesToDrivers = sendRoutesToDrivers;
window.printSelectedDriverItemList = printSelectedDriverItemList;