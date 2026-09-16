// js/admin-dispatch-export.js

import { state, getLocalDateString } from "./admin-state.js";

// ==========================================
// 1. 엑셀 추출 모달 제어
// ==========================================
export function openExcelExportModal() {
    const today = getLocalDateString();
    document.getElementById('export-start-date').value = today;
    document.getElementById('export-end-date').value = today;
    document.getElementById('excel-export-modal').classList.remove('hidden');
}

export function closeExcelExportModal() {
    document.getElementById('excel-export-modal').classList.add('hidden');
}

// ==========================================
// 2. 엑셀 리포트 생성 및 다운로드 (SheetJS 활용)
// ==========================================
export function executeExcelExport() {
    const startDateStr = document.getElementById('export-start-date').value;
    const endDateStr = document.getElementById('export-end-date').value;
    const isCompleted = document.getElementById('chk-export-completed').checked;
    const isPending = document.getElementById('chk-export-pending').checked;
    const isCanceled = document.getElementById('chk-export-canceled').checked;

    if (!startDateStr || !endDateStr) { alert("시작일과 종료일을 모두 선택해주세요."); return; }
    if (startDateStr > endDateStr) { alert("시작일이 종료일보다 클 수 없습니다. 날짜를 다시 확인해주세요."); return; }
    if (!isPending && !isCompleted && !isCanceled) { alert("출력할 데이터를 하나 이상 선택해주세요."); return; }

    const startTs = new Date(`${startDateStr}T00:00:00`).getTime();
    const endTs = new Date(`${endDateStr}T23:59:59`).getTime();

    // core 모듈에서 전역에 바인딩된 필터링 함수 호출
    const visibleLicenses = window.getFilteredVisibleDrivers ? window.getFilteredVisibleDrivers() : state.allLicenses;
    const visibleDeviceIds = visibleLicenses.map(l => l.deviceId || l.key);
    const visiblePhones = visibleLicenses.map(l => l.phone).filter(p => p);

    const wb = XLSX.utils.book_new();
    let hasData = false;

    // (1) 배송 완료 데이터 추출
    if (isCompleted) {
        const targetCompletions = state.allCompletions.filter(c => {
            if (!c.completedAt) return false;
            const matchesDev = visibleDeviceIds.includes(c.deviceId) || (c.phone && visiblePhones.includes(c.phone));
            const inRange = c.completedAt >= startTs && c.completedAt <= endTs;
            const isCancelTag = c.tag && (c.tag.includes('취소') || c.tag.includes('반품') || c.tag.includes('거부'));
            return matchesDev && inRange && !isCancelTag;
        }).sort((a, b) => a.completedAt - b.completedAt);

        if (targetCompletions.length > 0) {
            hasData = true;
            const excelData = [["순번", "완료 일시", "기사 연락처", "배송지 주소", "고객 번호", "처리 상태", "사진 링크"]];
            
            targetCompletions.forEach((c, idx) => {
                const dt = new Date(c.completedAt);
                const dStr = `${dt.getFullYear()}.${String(dt.getMonth()+1).padStart(2,'0')}.${String(dt.getDate()).padStart(2,'0')} ${dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
                excelData.push([
                    idx + 1, dStr, c.phone || '연락처 없음', c.address || '', c.customerPhone || '미등록', c.tag || '전달완료', c.photoUrl || '사진 없음'
                ]);
            });
            const ws = XLSX.utils.aoa_to_sheet(excelData);
            ws['!cols'] = [{wch:6}, {wch:20}, {wch:15}, {wch:45}, {wch:15}, {wch:12}, {wch:60}];
            XLSX.utils.book_append_sheet(wb, ws, "배송완료");
        }
    }

    // (2) 미처리 대기 동선 데이터 추출
    if (isPending) {
        let pendingList = [];
        for (const devId in state.activeRoutes) {
            if (!visibleDeviceIds.includes(devId)) continue;
            const driver = state.activeRoutes[devId];
            if (!driver || !driver.updatedAt) continue;

            if (driver.updatedAt >= startTs && driver.updatedAt <= endTs) {
                const dests = driver.destinations || [];
                dests.forEach(d => {
                    const isDone = state.allCompletions.some(c => c.deviceId === devId && c.address === d.address && c.completedAt >= startTs && c.completedAt <= endTs);
                    if (!isDone) {
                        pendingList.push({ ...d, driverPhone: driver.phone || '미등록', updatedAt: driver.updatedAt });
                    }
                });
            }
        }

        if (pendingList.length > 0) {
            hasData = true;
            const excelData = [["순번(코스)", "최종 업데이트", "기사 연락처", "배송지 주소", "처리 상태"]];
            pendingList.forEach((p, idx) => {
                const dt = new Date(p.updatedAt);
                const dStr = `${dt.getFullYear()}.${String(dt.getMonth()+1).padStart(2,'0')}.${String(dt.getDate()).padStart(2,'0')} ${dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
                excelData.push([
                    p.displayNumber || idx + 1, dStr, p.driverPhone, p.address || '', '대기(이동중)'
                ]);
            });
            const ws = XLSX.utils.aoa_to_sheet(excelData);
            ws['!cols'] = [{wch:10}, {wch:20}, {wch:15}, {wch:45}, {wch:12}];
            XLSX.utils.book_append_sheet(wb, ws, "대기동선");
        }
    }

    // (3) 취소/반품/거부 데이터 추출
    if (isCanceled) {
        const targetCanceled = state.allCompletions.filter(c => {
            if (!c.completedAt) return false;
            const matchesDev = visibleDeviceIds.includes(c.deviceId) || (c.phone && visiblePhones.includes(c.phone));
            const inRange = c.completedAt >= startTs && c.completedAt <= endTs;
            const isCancelTag = c.tag && (c.tag.includes('취소') || c.tag.includes('반품') || c.tag.includes('거부'));
            return matchesDev && inRange && isCancelTag;
        }).sort((a, b) => a.completedAt - b.completedAt);

        if (targetCanceled.length > 0) {
            hasData = true;
            const excelData = [["순번", "취소 일시", "기사 연락처", "배송지 주소", "고객 번호", "취소 사유(태그)", "사진 링크"]];
            
            targetCanceled.forEach((c, idx) => {
                const dt = new Date(c.completedAt);
                const dStr = `${dt.getFullYear()}.${String(dt.getMonth()+1).padStart(2,'0')}.${String(dt.getDate()).padStart(2,'0')} ${dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
                excelData.push([
                    idx + 1, dStr, c.phone || '연락처 없음', c.address || '', c.customerPhone || '미등록', c.tag || '배송취소', c.photoUrl || '사진 없음'
                ]);
            });
            const ws = XLSX.utils.aoa_to_sheet(excelData);
            ws['!cols'] = [{wch:6}, {wch:20}, {wch:15}, {wch:45}, {wch:15}, {wch:20}, {wch:60}];
            XLSX.utils.book_append_sheet(wb, ws, "배송취소");
        }
    }

    if (!hasData) {
        alert(`지정하신 기간 (${startDateStr} ~ ${endDateStr}) 내에 다운로드할 수 있는 데이터가 없습니다.`);
        return;
    }

    const fileNameDate = startDateStr === endDateStr ? startDateStr : `${startDateStr}_to_${endDateStr}`;
    XLSX.writeFile(wb, `배송리포트_통합본_${fileNameDate}.xlsx`);
    closeExcelExportModal();
}