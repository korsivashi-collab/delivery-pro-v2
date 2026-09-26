// js/admin-dispatch-territory.js

import { db } from "./admin-api.js";
import { state } from "./admin-state.js";
import { map } from "./admin-map.js";
import { getAddressFromCoords } from "./admin-utils.js";
import { doc, updateDoc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// ==========================================
// 0. 행정구역 디렉토리 & GeoJSON 설정
// ==========================================

// 시/도별 주요 구/군 디렉토리 목록
const ADMINISTRATIVE_DISTRICTS = {
    "서울": [
        "강남구", "강동구", "강북구", "강서구", "관악구", "광진구", "구로구", "금천구",
        "노원구", "도봉구", "동대문구", "동작구", "마포구", "서대문구", "서초구", "성동구",
        "성북구", "송파구", "양천구", "영등포구", "용산구", "은평구", "종로구", "중구", "중랑구"
    ],
    "경기": [
        "수원시", "성남시", "고양시", "용인시", "부천시", "안산시", "안양시", "남양주시",
        "화성시", "평택시", "의정부시", "시흥시", "파주시", "광명시", "김포시", "군포시",
        "광주시", "이천시", "양주시", "오산시", "구리시", "안성시", "포천시", "의왕시",
        "하남시", "여주시", "동두천시", "과천시", "연천군", "가평군", "양평군"
    ],
    "인천": [
        "중구", "동구", "미추홀구", "연수구", "남동구", "부평구", "계양구", "서구", "강화군", "옹진군"
    ]
};

// 서울시 25개 자치구 행정코드 5자리 매핑 테이블
const SEOUL_GU_CODE_MAP = {
    "종로구": "11010", "중구": "11020", "용산구": "11030", "성동구": "11040", "광진구": "11050",
    "동대문구": "11060", "중랑구": "11070", "성북구": "11080", "강북구": "11090", "도봉구": "11100",
    "노원구": "11110", "은평구": "11120", "서대문구": "11130", "마포구": "11140", "양천구": "11150",
    "강서구": "11160", "구로구": "11170", "금천구": "11180", "영등포구": "11190", "동작구": "11200",
    "관악구": "11210", "서초구": "11220", "강남구": "11230", "송파구": "11240", "강동구": "11250"
};

// 서울시 동 경계 오픈소스 경량 GeoJSON
const SEOUL_DONG_GEOJSON_URL = "https://cdn.jsdelivr.net/gh/southkorea/seoul-maps/kostat/2013/json/seoul_submunicipalities_geo_simple.json";

// 메모리 캐시 및 지도 제어 변수
let seoulDongGeoData = null;
let territoryMap = null;
let currentSido = "서울";
let currentSigungu = "강남구";
let currentSelectedZones = []; // 현재 모달 장바구니에 담긴 권역 배열 [{ id, type, sido, sigungu, dong, name }]
let activePolygons = [];       // 현재 지도에 그려진 카카오 Polygon 인스턴스 목록
let activeOverlayLabels = [];  // 현재 지도에 표시된 동 이름 라벨 목록
let allTerritoriesMap = null;
let allTerritoriesOverlays = [];

// ==========================================
// 1. GeoJSON 로드 & 폴리곤 파싱 엔진
// ==========================================

async function loadSeoulDongGeoJSON() {
    if (seoulDongGeoData) return seoulDongGeoData;
    try {
        const res = await fetch(SEOUL_DONG_GEOJSON_URL);
        if (!res.ok) throw new Error("GeoJSON 로드 실패");
        seoulDongGeoData = await res.json();
        return seoulDongGeoData;
    } catch (e) {
        console.warn("서울 동 GeoJSON 로딩 실패:", e);
        return null;
    }
}

// 지도 위의 기존 폴리곤 및 라벨 제거
function clearTerritoryMapPolygons() {
    activePolygons.forEach(p => p.setMap(null));
    activePolygons = [];
    activeOverlayLabels.forEach(lbl => lbl.setMap(null));
    activeOverlayLabels = [];
}

// 카카오맵 폴리곤 경로 변환 헬퍼 (GeoJSON [lng, lat] -> kakao.maps.LatLng)
function convertGeoJsonCoordsToKakao(coordinates, type) {
    if (type === "Polygon") {
        return coordinates.map(ring => ring.map(c => new kakao.maps.LatLng(c[1], c[0])));
    } else if (type === "MultiPolygon") {
        return coordinates.map(polygon => polygon.map(ring => ring.map(c => new kakao.maps.LatLng(c[1], c[0]))));
    }
    return [];
}

// 폴리곤 중심점(무게중심) 계산 헬퍼
function calculatePolygonCentroid(paths) {
    let latSum = 0;
    let lngSum = 0;
    let totalPoints = 0;

    const flattenPoints = (arr) => {
        arr.forEach(item => {
            if (Array.isArray(item)) {
                flattenPoints(item);
            } else if (item.getLat && item.getLng) {
                latSum += item.getLat();
                lngSum += item.getLng();
                totalPoints++;
            }
        });
    };

    flattenPoints(paths);
    if (totalPoints === 0) return null;
    return new kakao.maps.LatLng(latSum / totalPoints, lngSum / totalPoints);
}

// ==========================================
// 2. 권역 모달 초기화 및 드릴다운 렌더링
// ==========================================

export async function openDriverTerritoryModal(devId, phone) {
    try { if (window.event) window.event.stopPropagation(); } catch (e) {}

    const modal = document.getElementById('driver-territory-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    document.getElementById('territory-target-devid').value = devId;
    document.getElementById('territory-target-phone').innerText = phone;
    const searchInput = document.getElementById('territory-address-search');
    if (searchInput) searchInput.value = '';

    // 기사의 기존 저장된 권역 장바구니 데이터 복원
    const targetLic = state.allLicenses.find(l => l.deviceId === devId || l.key === devId);
    if (targetLic && Array.isArray(targetLic.territoryZones)) {
        currentSelectedZones = JSON.parse(JSON.stringify(targetLic.territoryZones));
    } else if (targetLic && targetLic.territory1 && targetLic.territory1 !== '상세 주소 확인 불가') {
        // 기존 반경 방식 데이터에서 주소 텍스트가 있을 경우 첫 항목으로 매핑
        currentSelectedZones = [{
            id: `legacy_${Date.now()}`,
            type: 'dong',
            sido: '서울',
            sigungu: targetLic.territory1.split(' ')[1] || '강남구',
            dong: targetLic.territory1.split(' ')[2] || targetLic.territory1,
            name: targetLic.territory1
        }];
    } else {
        currentSelectedZones = [];
    }

    renderTerritoryBasketChips();

    // 초기 시/도 및 구/군 설정
    currentSido = "서울";
    const sidoSelect = document.getElementById('territory-select-sido');
    if (sidoSelect) sidoSelect.value = currentSido;
    populateSigunguDropdown(currentSido);

    // 장바구니에 이미 담긴 구역이 있다면 그곳으로 지도 시작점 이동
    if (currentSelectedZones.length > 0) {
        const firstZone = currentSelectedZones[0];
        if (firstZone.sido) {
            currentSido = firstZone.sido;
            if (sidoSelect) sidoSelect.value = currentSido;
            populateSigunguDropdown(currentSido);
        }
        if (firstZone.sigungu) {
            currentSigungu = firstZone.sigungu;
            const sigunguSelect = document.getElementById('territory-select-sigungu');
            if (sigunguSelect) sigunguSelect.value = currentSigungu;
        }
    } else {
        currentSigungu = "강남구";
        const sigunguSelect = document.getElementById('territory-select-sigungu');
        if (sigunguSelect) sigunguSelect.value = currentSigungu;
    }

    updateEntireSigunguButtonUI();

    // 카카오 지도 초기화 및 폴리곤 로드
    setTimeout(async () => {
        const container = document.getElementById('territory-map-container');
        if (!territoryMap) {
            territoryMap = new kakao.maps.Map(container, {
                center: new kakao.maps.LatLng(37.566826, 126.978656),
                level: 6
            });
        }
        territoryMap.relayout();
        await renderCurrentSigunguPolygons(currentSido, currentSigungu);
    }, 200);
}

export function closeDriverTerritoryModal() {
    document.getElementById('driver-territory-modal')?.classList.add('hidden');
    clearTerritoryMapPolygons();
}

// 시/군/구 드롭다운 옵션 동적 생성
function populateSigunguDropdown(sido) {
    const select = document.getElementById('territory-select-sigungu');
    if (!select) return;

    const list = ADMINISTRATIVE_DISTRICTS[sido] || [];
    select.innerHTML = list.map(gu => `<option value="${gu}">${gu}</option>`).join('');
    if (list.length > 0) {
        currentSigungu = list[0];
        select.value = currentSigungu;
    }
}

export async function onTerritorySidoChange(sido) {
    currentSido = sido;
    populateSigunguDropdown(sido);
    updateEntireSigunguButtonUI();
    await renderCurrentSigunguPolygons(currentSido, currentSigungu);
}

export async function onTerritorySigunguChange(sigungu) {
    currentSigungu = sigungu;
    updateEntireSigunguButtonUI();
    await renderCurrentSigunguPolygons(currentSido, currentSigungu);
}

// ==========================================
// 3. 지도 위에 '동' 폴리곤 경계선 렌더링 & 클릭 토글
// ==========================================

async function renderCurrentSigunguPolygons(sido, sigungu) {
    if (!territoryMap) return;
    clearTerritoryMapPolygons();

    const currentDevId = document.getElementById('territory-target-devid')?.value;
    const allDrivers = window.getFilteredVisibleDrivers ? window.getFilteredVisibleDrivers() : [];

    // 타 기사들이 선점한 권역 맵핑 (중복 여부 안내용)
    const otherDriverZoneMap = new Map();
    allDrivers.forEach(d => {
        const dId = d.deviceId || d.key;
        if (dId === currentDevId) return;
        if (Array.isArray(d.territoryZones)) {
            d.territoryZones.forEach(z => {
                otherDriverZoneMap.set(z.id, d.phone || d.key);
            });
        }
    });

    const bounds = new kakao.maps.LatLngBounds();
    let hasPoints = false;

    // 1) 서울 지역: GeoJSON 기반 실제 '동' 폴리곤 정밀 렌더링
    if (sido === "서울") {
        const geojson = await loadSeoulDongGeoJSON();
        const guCode = SEOUL_GU_CODE_MAP[sigungu];

        if (geojson && guCode) {
            const filteredFeatures = geojson.features.filter(f => f.properties.code && f.properties.code.startsWith(guCode));

            filteredFeatures.forEach(feature => {
                const dongName = feature.properties.name || "미확인";
                const zoneId = `dong_${sido}_${sigungu}_${dongName}`;
                const guZoneId = `gu_${sido}_${sigungu}`;

                // 현재 기사 선택 여부 (동 개별 선택 또는 구 전체 선택)
                const isSelected = currentSelectedZones.some(z => z.id === zoneId || z.id === guZoneId);
                const assignedOtherDriver = otherDriverZoneMap.get(zoneId) || otherDriverZoneMap.get(guZoneId);

                const paths = convertGeoJsonCoordsToKakao(feature.geometry.coordinates, feature.geometry.type);

                // 폴리곤 스타일 결정 (내 권역: 블루 / 미선택: 화이트-슬레이트 / 타기사: 연회색)
                let strokeColor = isSelected ? '#1d4ed8' : '#94a3b8';
                let fillColor = isSelected ? '#3b82f6' : (assignedOtherDriver ? '#cbd5e1' : '#ffffff');
                let fillOpacity = isSelected ? 0.65 : (assignedOtherDriver ? 0.45 : 0.35);
                let strokeWeight = isSelected ? 2.5 : 1.2;

                const polygon = new kakao.maps.Polygon({
                    path: paths,
                    strokeWeight: strokeWeight,
                    strokeColor: strokeColor,
                    strokeOpacity: 0.9,
                    strokeStyle: 'solid',
                    fillColor: fillColor,
                    fillOpacity: fillOpacity
                });

                polygon.setMap(territoryMap);
                activePolygons.push(polygon);

                // 지도 바운드 확장
                const extendBounds = (coords) => {
                    coords.forEach(pt => {
                        if (Array.isArray(pt)) extendBounds(pt);
                        else { bounds.extend(pt); hasPoints = true; }
                    });
                };
                extendBounds(paths);

                // 동 이름 텍스트 오버레이 라벨
                const centroid = calculatePolygonCentroid(paths);
                if (centroid) {
                    const labelContent = document.createElement('div');
                    labelContent.className = 'select-none pointer-events-none text-center';
                    labelContent.innerHTML = `
                        <div class="px-2 py-0.5 rounded-md text-[11px] font-black shadow-xs border ${
                            isSelected 
                                ? 'bg-blue-600 text-white border-blue-700' 
                                : (assignedOtherDriver ? 'bg-slate-200 text-gray-600 border-slate-300' : 'bg-white/90 text-gray-800 border-gray-300')
                        }">
                            ${dongName}
                            ${assignedOtherDriver ? `<span class="block text-[9px] font-normal text-slate-500">담당: ${assignedOtherDriver}</span>` : ''}
                        </div>`;

                    const overlay = new kakao.maps.CustomOverlay({
                        position: centroid,
                        content: labelContent,
                        yAnchor: 0.5
                    });
                    overlay.setMap(territoryMap);
                    activeOverlayLabels.push(overlay);
                }

                // 마우스 호버 효과
                kakao.maps.event.addListener(polygon, 'mouseover', () => {
                    if (!isSelected) {
                        polygon.setOptions({ fillColor: '#93c5fd', fillOpacity: 0.55 });
                    }
                });
                kakao.maps.event.addListener(polygon, 'mouseout', () => {
                    if (!isSelected) {
                        polygon.setOptions({ fillColor: fillColor, fillOpacity: fillOpacity });
                    }
                });

                // 클릭 시 장바구니 토글
                kakao.maps.event.addListener(polygon, 'click', () => {
                    toggleDongZone(sido, sigungu, dongName);
                });
            });

            if (hasPoints) {
                territoryMap.setBounds(bounds);
            }
            return;
        }
    }

    // 2) 경기/인천 또는 외부 데이터: 카카오 주소 검색 기반 구 중심 확대 및 포커스
    if (window.kakao && kakao.maps && kakao.maps.services) {
        const geocoder = new kakao.maps.services.Geocoder();
        const searchAddr = `${sido} ${sigungu}`;

        geocoder.addressSearch(searchAddr, (result, status) => {
            if (status === kakao.maps.services.Status.OK && result[0]) {
                const centerPos = new kakao.maps.LatLng(parseFloat(result[0].y), parseFloat(result[0].x));
                territoryMap.setLevel(5);
                territoryMap.panTo(centerPos);

                // 해당 구 안내 마커 표시
                const marker = new kakao.maps.Marker({ position: centerPos });
                marker.setMap(territoryMap);
                activePolygons.push(marker);

                const label = new kakao.maps.CustomOverlay({
                    position: centerPos,
                    content: `<div class="bg-indigo-600 text-white font-black text-xs px-3 py-1.5 rounded-xl shadow-md border border-white mb-8">${sigungu} (상단에서 '구 전체'를 담거나 검색하세요)</div>`,
                    yAnchor: 1
                });
                label.setMap(territoryMap);
                activeOverlayLabels.push(label);
            }
        });
    }
}

// ==========================================
// 4. 장바구니 제어 (구/동 추가, 삭제, UI 동기화)
// ==========================================

// 개별 '동' 토글
export function toggleDongZone(sido, sigungu, dong) {
    const zoneId = `dong_${sido}_${sigungu}_${dong}`;
    const guZoneId = `gu_${sido}_${sigungu}`;

    // 만약 이미 해당 구 전체가 선택되어 있다면 동 단위로 세분화 전환
    const guIndex = currentSelectedZones.findIndex(z => z.id === guZoneId);
    if (guIndex !== -1) {
        currentSelectedZones.splice(guIndex, 1);
    }

    const existingIdx = currentSelectedZones.findIndex(z => z.id === zoneId);
    if (existingIdx !== -1) {
        currentSelectedZones.splice(existingIdx, 1);
    } else {
        currentSelectedZones.push({
            id: zoneId,
            type: 'dong',
            sido: sido,
            sigungu: sigungu,
            dong: dong,
            name: `${sigungu} ${dong}`
        });
    }

    renderTerritoryBasketChips();
    updateEntireSigunguButtonUI();
    renderCurrentSigunguPolygons(currentSido, currentSigungu);
}

// '현재 구 전체' 원클릭 토글
export function toggleEntireSigungu() {
    const guZoneId = `gu_${currentSido}_${currentSigungu}`;
    const guIndex = currentSelectedZones.findIndex(z => z.id === guZoneId);

    if (guIndex !== -1) {
        // 이미 구 전체가 담겨있으면 해제
        currentSelectedZones.splice(guIndex, 1);
    } else {
        // 해당 구에 속한 개별 동들을 모두 지우고 '구 전체' 1개로 깔끔하게 치환
        currentSelectedZones = currentSelectedZones.filter(z => !(z.sido === currentSido && z.sigungu === currentSigungu));
        currentSelectedZones.push({
            id: guZoneId,
            type: 'gu',
            sido: currentSido,
            sigungu: currentSigungu,
            name: `${currentSigungu} 전체`
        });
    }

    renderTerritoryBasketChips();
    updateEntireSigunguButtonUI();
    renderCurrentSigunguPolygons(currentSido, currentSigungu);
}

// 장바구니에서 개별 칩 삭제 (✕ 버튼 클릭)
export function removeTerritoryZone(zoneId) {
    currentSelectedZones = currentSelectedZones.filter(z => z.id !== zoneId);
    renderTerritoryBasketChips();
    updateEntireSigunguButtonUI();
    renderCurrentSigunguPolygons(currentSido, currentSigungu);
}

// 장바구니 전체 비우기
export function clearTerritoryBasket() {
    if (currentSelectedZones.length === 0) return;
    if (!confirm("선택된 모든 권역을 장바구니에서 비우시겠습니까?")) return;
    currentSelectedZones = [];
    renderTerritoryBasketChips();
    updateEntireSigunguButtonUI();
    renderCurrentSigunguPolygons(currentSido, currentSigungu);
}

// 장바구니 UI 칩 렌더링
function renderTerritoryBasketChips() {
    const container = document.getElementById('territory-selected-chips');
    const countBadge = document.getElementById('territory-selected-count');
    if (!container) return;

    if (countBadge) {
        countBadge.innerText = `${currentSelectedZones.length}개 구역`;
    }

    if (currentSelectedZones.length === 0) {
        container.innerHTML = `
            <div class="text-center text-gray-400 py-12 text-xs font-bold w-full">
                지도에서 동을 클릭하거나<br>상단에서 '구 전체'를 담아보세요.
            </div>`;
        return;
    }

    container.innerHTML = currentSelectedZones.map(zone => {
        const isGu = zone.type === 'gu';
        return `
        <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-black shadow-2xs transition ${
            isGu ? 'bg-indigo-50 text-indigo-900 border border-indigo-200' : 'bg-blue-50 text-blue-900 border border-blue-200'
        }">
            <span class="text-[9px] px-1 py-0.5 rounded font-black ${isGu ? 'bg-indigo-600 text-white' : 'bg-blue-600 text-white'}">
                ${isGu ? '구 전체' : '동'}
            </span>
            <span>${zone.name}</span>
            <button type="button" onclick="window.removeTerritoryZone('${zone.id}')" class="text-gray-400 hover:text-red-500 ml-0.5 text-xs font-bold transition">✕</button>
        </div>`;
    }).join('');
}

// '현재 구 전체' 버튼 텍스트/스타일 동기화
function updateEntireSigunguButtonUI() {
    const btnText = document.getElementById('btn-toggle-sigungu-text');
    const btn = document.getElementById('btn-toggle-entire-sigungu');
    if (!btnText || !btn) return;

    const guZoneId = `gu_${currentSido}_${currentSigungu}`;
    const isGuSelected = currentSelectedZones.some(z => z.id === guZoneId);

    if (isGuSelected) {
        btnText.innerText = `${currentSigungu} 전체 담김 (클릭 시 해제)`;
        btn.className = "flex-1 bg-indigo-600 hover:bg-indigo-700 text-white border border-indigo-700 py-1.5 rounded-lg text-xs font-black transition active:scale-95 flex items-center justify-center gap-1 shadow-2xs";
    } else {
        btnText.innerText = `${currentSigungu} 전체 담기`;
        btn.className = "flex-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 py-1.5 rounded-lg text-xs font-black transition active:scale-95 flex items-center justify-center gap-1";
    }
}

// 빠른 주소/동 검색창
export function searchTerritoryAddress() {
    const inputEl = document.getElementById('territory-address-search');
    const query = inputEl ? inputEl.value.trim() : '';
    if (!query) { alert("검색할 동 또는 구 이름을 입력하세요."); inputEl?.focus(); return; }

    if (window.kakao && kakao.maps && kakao.maps.services) {
        const geocoder = new kakao.maps.services.Geocoder();
        geocoder.addressSearch(query, (result, status) => {
            if (status === kakao.maps.services.Status.OK && result[0]) {
                const addr = result[0].address;
                const r1 = addr.region_1depth_name.replace(/특별|광역|자치/g, '').slice(0, 2);
                const r2 = addr.region_2depth_name;
                const r3 = addr.region_3depth_name;

                // 시/도 및 시/군/구 자동 이동
                if (ADMINISTRATIVE_DISTRICTS[r1]) {
                    currentSido = r1;
                    const sidoSelect = document.getElementById('territory-select-sido');
                    if (sidoSelect) sidoSelect.value = currentSido;
                    populateSigunguDropdown(currentSido);

                    if (r2) {
                        currentSigungu = r2;
                        const sigunguSelect = document.getElementById('territory-select-sigungu');
                        if (sigunguSelect) sigunguSelect.value = currentSigungu;
                    }
                }

                // 동 단위까지 특정되면 장바구니 자동 추가
                if (r3) {
                    toggleDongZone(currentSido, currentSigungu, r3);
                } else {
                    renderCurrentSigunguPolygons(currentSido, currentSigungu);
                }
            } else {
                alert("해당 지역의 주소를 찾을 수 없습니다. 정확한 동이나 구 이름을 입력해 주세요.");
            }
        });
    }
}

// ==========================================
// 5. Firebase Firestore 저장 엔진
// ==========================================

export async function saveDriverTerritory() {
    const devId = document.getElementById('territory-target-devid')?.value;
    if (!devId) return;

    if (currentSelectedZones.length === 0) {
        alert("최소 1개 이상의 구 또는 동을 장바구니에 담아주세요.");
        return;
    }

    const targetLic = state.allLicenses.find(l => l.deviceId === devId || l.key === devId);
    if (!targetLic) return;

    // 요약 명칭 생성 (예: "양천구 전체", "강서구 화곡1동 외 2곳")
    let summaryText = currentSelectedZones[0].name;
    if (currentSelectedZones.length > 1) {
        summaryText = `${currentSelectedZones[0].name} 외 ${currentSelectedZones.length - 1}곳`;
    }

    // 지도 중심 좌표 산출을 위한 기준 좌표 가져오기
    let centerLat = 37.566826;
    let centerLng = 126.978656;
    if (territoryMap) {
        const c = territoryMap.getCenter();
        centerLat = c.getLat();
        centerLng = c.getLng();
    }

    try {
        await updateDoc(doc(db, "licenses", targetLic.key), {
            territoryZones: currentSelectedZones, // 구+동 혼합 배열
            territoryScale: 'zone',
            territory1: summaryText,              // 기존 UI 호환 텍스트
            territory2: `${currentSelectedZones.length}개 구역 지정`,
            territoryLat: centerLat,
            territoryLng: centerLng,
            updatedAt: Date.now()
        });

        alert(`[권역 저장 완료]\n\n${summaryText}이(가) 기사님의 담당 배송 권역으로 성공적으로 저장되었습니다.`);
        closeDriverTerritoryModal();
        if (window.renderDispatchDriverList) window.renderDispatchDriverList();
    } catch (e) {
        alert("권역 저장 중 오류가 발생했습니다: " + e.message);
    }
}

// ==========================================
// 6. 전체 기사 권역 설정 현황 지도 모달
// ==========================================

export function openAllTerritoriesMap() {
    const modal = document.getElementById('all-territories-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    setTimeout(() => {
        const container = document.getElementById('all-territories-map-container');
        if (!allTerritoriesMap) {
            allTerritoriesMap = new kakao.maps.Map(container, {
                center: new kakao.maps.LatLng(37.566826, 126.978656),
                level: 8
            });
        }
        allTerritoriesMap.relayout();
        allTerritoriesOverlays.forEach(ov => ov.setMap(null));
        allTerritoriesOverlays = [];

        const allDrivers = window.getFilteredVisibleDrivers ? window.getFilteredVisibleDrivers() : [];
        let bounds = new kakao.maps.LatLngBounds();
        let hasValidPoint = false;

        allDrivers.forEach(d => {
            const zones = d.territoryZones || [];
            const dName = d.phone || d.key;

            if (zones.length > 0 && d.territoryLat && d.territoryLng) {
                hasValidPoint = true;
                const pos = new kakao.maps.LatLng(d.territoryLat, d.territoryLng);
                bounds.extend(pos);

                const marker = new kakao.maps.Marker({ position: pos });
                marker.setMap(allTerritoriesMap);
                allTerritoriesOverlays.push(marker);

                const zoneSummary = zones.map(z => z.name).slice(0, 3).join(', ') + (zones.length > 3 ? ` 외 ${zones.length - 3}곳` : '');
                const label = new kakao.maps.CustomOverlay({
                    position: pos,
                    content: `
                    <div class="bg-slate-900 text-white text-xs px-3 py-1.5 rounded-xl shadow-lg border border-indigo-400 mb-8 max-w-[200px] text-center">
                        <span class="font-black text-amber-300 block mb-0.5"><i class="fa-solid fa-truck text-xs mr-1"></i>${dName}</span>
                        <span class="text-[10px] text-gray-300 block truncate">${zoneSummary}</span>
                    </div>`,
                    yAnchor: 1
                });
                label.setMap(allTerritoriesMap);
                allTerritoriesOverlays.push(label);
            }
        });

        if (hasValidPoint) {
            allTerritoriesMap.setBounds(bounds);
        }
    }, 200);
}

export function closeAllTerritoriesMap() {
    document.getElementById('all-territories-modal')?.classList.add('hidden');
}

// ==========================================
// 7. 실시간 기사 GPS 위치 추적 & 사이드바 (기존 기능 100% 보존)
// ==========================================

function isAllowedWorkingHours() {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    return (day >= 1 && day <= 5) && (hour >= 9 && hour < 17);
}

export function renderLocationSidebar() {
    const headerEl = document.getElementById('sidebar-header');
    const contentEl = document.getElementById('sidebar-content');
    const visibleLicenses = window.getFilteredVisibleDrivers ? window.getFilteredVisibleDrivers() : [];

    headerEl.innerHTML = `
        <h2 class="text-xs font-black text-gray-700 uppercase tracking-wider flex items-center gap-1.5"><i class="fa-solid fa-tower-broadcast text-blue-600"></i> 실시간 위치 관제 (<span class="text-blue-600">${visibleLicenses.length}</span>대)</h2>
        <span class="bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded text-[10px] font-black flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span> GPS 수신중</span>
    `;

    if (visibleLicenses.length === 0) {
        contentEl.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">위치를 확인할 기사가 없습니다.</div>`;
        return;
    }

    let html = `<div class="space-y-2.5">`;
    visibleLicenses.forEach(lic => {
        const devId = lic.deviceId || lic.key;
        const phone = lic.phone || '연락처 미등록';
        const driver = state.activeRoutes[devId];
        const driverComps = state.allCompletions.filter(c => c.deviceId === devId || (c.phone && c.phone === lic.phone)).sort((a,b) => b.completedAt - a.completedAt);

        let previewAddress = "최근 위치 데이터 대기중";
        let previewTime = "";
        if (driverComps.length > 0 && driverComps[0].address) {
            previewAddress = driverComps[0].address;
            previewTime = driverComps[0].timeString ? driverComps[0].timeString.split(' ')[1] : '';
        } else if (driver && driver.destinations && driver.destinations.length > 0 && driver.destinations[0].address) {
            previewAddress = driver.destinations[0].address; previewTime = "목적지";
        }

        html += `
        <div class="bg-white border border-gray-200 rounded-2xl p-3.5 shadow-xs flex flex-col gap-2.5 hover:border-blue-300 transition">
            <div class="flex items-center justify-between"><span class="font-black text-sm text-gray-900 tracking-tight flex items-center gap-1.5"><i class="fa-solid fa-phone text-blue-500 text-xs"></i> ${phone}</span><span class="text-[10px] font-mono text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">[${lic.key}]</span></div>
            <div class="bg-slate-50 border border-slate-200/70 rounded-xl p-2.5 flex items-start gap-2 text-xs">
                <i class="fa-solid fa-location-dot text-red-500 text-xs mt-0.5 shrink-0"></i>
                <div class="flex-1 min-w-0">
                    <p class="font-black text-gray-800 text-[11px] truncate leading-tight">${previewAddress}</p>
                    ${previewTime ? `<span class="text-[10px] text-gray-400 font-mono mt-0.5 block">수신: ${previewTime}</span>` : ''}
                </div>
            </div>
            <div class="grid grid-cols-2 gap-2 pt-1 border-t border-gray-100">
                <button onclick="window.focusDriverLocationOnMap('${devId}')" class="py-2 px-3 bg-blue-50 hover:bg-blue-100 text-blue-700 font-black rounded-xl text-xs flex items-center justify-center gap-1.5 transition active:scale-95 border border-blue-200 shadow-xs"><i class="fa-solid fa-crosshairs text-[11px]"></i> 위치 확인</button>
                <button onclick="window.jumpToDriverDelivery('${devId}')" class="py-2 px-3 bg-slate-900 hover:bg-slate-800 text-white font-black rounded-xl text-xs flex items-center justify-center gap-1.5 transition active:scale-95 shadow-xs"><i class="fa-solid fa-route text-[10px]"></i> 배송 관리</button>
            </div>
        </div>`;
    });
    html += `</div>`;
    contentEl.innerHTML = html;
}

export function jumpToDriverDelivery(devId) {
    if (window.setDispatchMode) window.setDispatchMode('DELIVERY');
    if (window.selectDriver) window.selectDriver(devId);
}

export async function focusDriverLocationOnMap(devId) {
    const matchedLic = state.allLicenses.find(l => l.deviceId === devId || l.key === devId);
    const phoneName = matchedLic?.phone || '기사님';

    if (!isAllowedWorkingHours()) {
        alert("[프라이버시 보호 기능]\n\n기사님의 평일(월~금) 오전 9시 ~ 오후 5시 업무 시간 외에는 실시간 위치를 추적할 수 없습니다.\n\n시스템에 저장된 마지막 확인 위치를 표시합니다.");
        showFallbackLocation(devId);
        return;
    }
    if (!map) return;
    closeCurrentLocationOverlay();

    const reqTime = Date.now();
    try { await setDoc(doc(db, "gps_requests", devId), { deviceId: devId, requestedAt: reqTime }); } catch (e) {}
    let isResolved = false;

    const unsub = onSnapshot(doc(db, "gps_reports", devId), async (snap) => {
        if (snap.exists()) {
            const data = snap.data();
            if (data.updatedAt && data.updatedAt >= reqTime) {
                isResolved = true; unsub();
                const lat = data.lat; const lng = data.lng;
                const pos = new kakao.maps.LatLng(lat, lng);
                map.setLevel(3); map.panTo(pos);

                const timeStr = new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const overlayContainer = document.createElement('div');
                overlayContainer.className = 'custom-location-overlay animate-pop-in';
                overlayContainer.innerHTML = `
                    <div style="transform: translate(-50%, -100%); margin-top: -15px;" class="bg-slate-900 text-white p-3.5 rounded-2xl shadow-2xl border-2 border-emerald-400 text-xs flex flex-col gap-1.5 min-w-[240px] max-w-[320px] relative z-50">
                        <div class="flex justify-between items-center pb-1.5 border-b border-slate-700">
                            <span class="font-black text-emerald-400 flex items-center gap-1.5 text-xs"><i class="fa-solid fa-satellite-dish animate-pulse text-emerald-400"></i> 실시간 위치 수신됨</span>
                            <span class="text-[10px] text-gray-400 font-mono">${timeStr}</span>
                        </div>
                        <div id="loc-overlay-addr" class="font-black text-gray-100 text-[13px] leading-snug py-0.5 break-keep"><i class="fa-solid fa-circle-notch fa-spin mr-1 text-emerald-400"></i>주소 확인 중...</div>
                        <div class="flex justify-between items-center pt-1.5 border-t border-slate-800 text-[11px]"><span class="font-bold text-gray-300"><i class="fa-solid fa-phone text-emerald-400 mr-1"></i>${phoneName}</span><button onclick="window.closeCurrentLocationOverlay()" class="text-gray-400 hover:text-white px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-bold transition active:scale-95">닫기</button></div>
                        <div class="absolute left-1/2 -bottom-2 -translate-x-1/2 w-0 h-0 border-x-8 border-x-transparent border-t-8 border-t-emerald-400"></div>
                    </div>`;
                window.currentLocationOverlay = new kakao.maps.CustomOverlay({ position: pos, content: overlayContainer, zIndex: 100 });
                window.currentLocationOverlay.setMap(map);
                if (window.myMapOverlays) window.myMapOverlays.push(window.currentLocationOverlay);

                const resolvedAddr = await getAddressFromCoords(lat, lng);
                const finalAddr = resolvedAddr || "주소 정보를 변환할 수 없습니다.";
                const addrEl = document.getElementById('loc-overlay-addr');
                if (addrEl) addrEl.innerHTML = `<i class="fa-solid fa-map-pin text-emerald-400 mr-1 text-xs"></i>${finalAddr}`;
            }
        }
    });

    setTimeout(() => {
        if (!isResolved) {
            unsub(); alert(`[안내] 실시간 위치 응답을 받지 못했습니다.\n(앱 미실행, 통신 불량 등)\n\n시스템에 저장된 최근 마지막 위치를 표시합니다.`);
            showFallbackLocation(devId);
        }
    }, 7000);
}

export async function showFallbackLocation(devId) {
    const matchedLic = state.allLicenses.find(l => l.deviceId === devId || l.key === devId);
    const driver = state.activeRoutes[devId];
    let lat = null, lng = null, timeStr = '마지막 수신', knownAddress = null;

    const driverComps = state.allCompletions.filter(c => c.deviceId === devId || (c.phone && c.phone === matchedLic?.phone)).sort((a,b) => b.completedAt - a.completedAt);
    if (driverComps.length > 0 && driverComps[0].lat) {
        lat = driverComps[0].lat; lng = driverComps[0].lng; knownAddress = driverComps[0].address;
        timeStr = driverComps[0].timeString || (new Date(driverComps[0].completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } else if (driver && driver.destinations && driver.destinations.length > 0 && driver.destinations[0].lat) {
        lat = driver.destinations[0].lat; lng = driver.destinations[0].lng; knownAddress = driver.destinations[0].address; timeStr = '배송 목적지';
    }

    if (!lat || !lng || !map) { alert("해당 기사의 위치나 동선 데이터가 전혀 없습니다."); return; }
    const pos = new kakao.maps.LatLng(lat, lng); map.setLevel(3); map.panTo(pos);
    if (window.currentLocationOverlay) { window.currentLocationOverlay.setMap(null); window.currentLocationOverlay = null; }

    const phone = matchedLic?.phone || driver?.phone || '기사';
    const overlayContainer = document.createElement('div');
    overlayContainer.className = 'custom-location-overlay animate-pop-in';
    overlayContainer.innerHTML = `
        <div style="transform: translate(-50%, -100%); margin-top: -15px;" class="bg-slate-900 text-white p-3.5 rounded-2xl shadow-2xl border-2 border-sky-400 text-xs flex flex-col gap-1.5 min-w-[240px] max-w-[320px] relative z-50">
            <div class="flex justify-between items-center pb-1.5 border-b border-slate-700"><span class="font-black text-sky-400 flex items-center gap-1.5 text-xs"><i class="fa-solid fa-location-dot text-sky-400"></i> 기사 최근 위치</span><span class="text-[10px] text-gray-400 font-mono">${timeStr}</span></div>
            <div id="loc-overlay-addr" class="font-black text-gray-100 text-[13px] leading-snug py-0.5 break-keep"><i class="fa-solid fa-circle-notch fa-spin mr-1 text-sky-400"></i>주소 확인 중...</div>
            <div class="flex justify-between items-center pt-1.5 border-t border-slate-800 text-[11px]"><span class="font-bold text-gray-300"><i class="fa-solid fa-phone text-sky-400 mr-1"></i>${phone}</span><button onclick="window.closeCurrentLocationOverlay()" class="text-gray-400 hover:text-white px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-bold transition active:scale-95">닫기</button></div>
            <div class="absolute left-1/2 -bottom-2 -translate-x-1/2 w-0 h-0 border-x-8 border-x-transparent border-t-8 border-t-sky-400"></div>
        </div>`;
    window.currentLocationOverlay = new kakao.maps.CustomOverlay({ position: pos, content: overlayContainer, zIndex: 100 });
    window.currentLocationOverlay.setMap(map);
    if (window.myMapOverlays) window.myMapOverlays.push(window.currentLocationOverlay);

    const resolvedAddr = await getAddressFromCoords(lat, lng);
    const finalAddr = resolvedAddr || knownAddress || "주소 정보를 변환할 수 없습니다.";
    const addrEl = document.getElementById('loc-overlay-addr');
    if (addrEl) addrEl.innerHTML = `<i class="fa-solid fa-map-pin text-sky-400 mr-1 text-xs"></i>${finalAddr}`;
}

export function closeCurrentLocationOverlay() {
    if (window.currentLocationOverlay) {
        window.currentLocationOverlay.setMap(null);
        window.currentLocationOverlay = null;
    }
}

export function drawAllDriversOnMap() {
    if (window.forceClearMap) window.forceClearMap();
    if (!map) return;
    const visibleLicenses = window.getFilteredVisibleDrivers ? window.getFilteredVisibleDrivers() : [];
    const bounds = new kakao.maps.LatLngBounds();
    let hasPoints = false;

    visibleLicenses.forEach(lic => {
        const devId = lic.deviceId || lic.key;
        const driver = state.activeRoutes[devId];
        let pos = null;
        const driverComps = state.allCompletions.filter(c => c.deviceId === devId || (c.phone && c.phone === lic.phone)).sort((a,b) => b.completedAt - a.completedAt);

        if (driverComps.length > 0 && driverComps[0].lat) pos = new kakao.maps.LatLng(driverComps[0].lat, driverComps[0].lng);
        else if (driver && driver.destinations && driver.destinations.length > 0 && driver.destinations[0].lat) pos = new kakao.maps.LatLng(driver.destinations[0].lat, driver.destinations[0].lng);

        if (pos) {
            bounds.extend(pos); hasPoints = true;
            const content = document.createElement('div'); content.className = 'driver-pin';
            content.innerHTML = `<i class="fa-solid fa-truck text-sky-400 text-xs"></i><span>${lic.phone || '기사'}</span>`;
            content.onclick = () => { jumpToDriverDelivery(devId); };
            const overlay = new kakao.maps.CustomOverlay({ position: pos, content: content, yAnchor: 1.3, zIndex: 30 });
            overlay.setMap(map);
            if (window.myMapOverlays) window.myMapOverlays.push(overlay);
        }
    });
    if (hasPoints) map.setBounds(bounds);
}

export function fitMapToAllDrivers() {
    drawAllDriversOnMap();
}

// ==========================================
// 8. 전역 Window 객체 바인딩
// ==========================================
window.openDriverTerritoryModal = openDriverTerritoryModal;
window.closeDriverTerritoryModal = closeDriverTerritoryModal;
window.onTerritorySidoChange = onTerritorySidoChange;
window.onTerritorySigunguChange = onTerritorySigunguChange;
window.toggleDongZone = toggleDongZone;
window.toggleEntireSigungu = toggleEntireSigungu;
window.removeTerritoryZone = removeTerritoryZone;
window.clearTerritoryBasket = clearTerritoryBasket;
window.searchTerritoryAddress = searchTerritoryAddress;
window.saveDriverTerritory = saveDriverTerritory;
window.openAllTerritoriesMap = openAllTerritoriesMap;
window.closeAllTerritoriesMap = closeAllTerritoriesMap;

// 실시간 위치 관제 관련 바인딩
window.renderLocationSidebar = renderLocationSidebar;
window.jumpToDriverDelivery = jumpToDriverDelivery;
window.focusDriverLocationOnMap = focusDriverLocationOnMap;
window.showFallbackLocation = showFallbackLocation;
window.closeCurrentLocationOverlay = closeCurrentLocationOverlay;
window.drawAllDriversOnMap = drawAllDriversOnMap;
window.fitMapToAllDrivers = fitMapToAllDrivers;

// 하위 호환성 빈 함수 바인딩
window.toggleTerritoryPinMode = () => {};
window.adjustModalTerritorySize = () => {};
window.setTerritoryScale = () => {};
window.setTerritoryCenter = () => {};