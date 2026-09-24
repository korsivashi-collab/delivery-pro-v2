// js/admin-utils.js
export const KAKAO_REST_API_KEY = "625c74c7254b3dbf7eea75ba0cac4c5f";

export function playBeepSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = 880; gain.gain.value = 0.3;
        osc.start();
        setTimeout(() => { osc.stop(); }, 250);
    } catch(e) {}
}

export async function getAddressFromCoords(lat, lng) {
    try {
        const res = await fetch(`https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${lng}&y=${lat}`, {
            headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` }
        });
        const data = await res.json();
        if (data.documents && data.documents.length > 0) {
            const doc = data.documents[0];
            if (doc.road_address && doc.road_address.address_name) return doc.road_address.address_name;
            if (doc.address && doc.address.address_name) return doc.address.address_name;
        }
    } catch (e) {}

    if (window.kakao && kakao.maps && kakao.maps.services) {
        try {
            const geocoder = new window.kakao.maps.services.Geocoder();
            const addr = await new Promise((resolve) => {
                geocoder.coord2Address(lng, lat, (result, status) => {
                    if (status === window.kakao.maps.services.Status.OK && result.length > 0) {
                        const r = result[0];
                        resolve(r.road_address ? r.road_address.address_name : r.address.address_name);
                    } else {
                        resolve(null);
                    }
                });
            });
            if (addr) return addr;
        } catch (e) {}
    }
    return null;
}

// ==========================================
// 🌟 단일 일자 배송 완료 엑셀 다운로드 (상호명 열 추가 반영)
// ==========================================
export function downloadDispatchExcel(targetCompletions, selectedDate) {
    if (!targetCompletions || targetCompletions.length === 0) {
        alert(`선택하신 날짜(${selectedDate})에 해당하는 배송 완료 데이터가 없습니다.`);
        return;
    }

    const excelData = [
        ["순번", "기사 연락처", "배송완료(시간)", "상호명(간판명)", "배송지 주소", "고객 전화번호", "완료 메시지", "사진 링크"]
    ];

    targetCompletions.forEach((c, idx) => {
        let dateTimeStr = '';
        if (c.timeString && c.timeString.includes(' ')) {
            dateTimeStr = c.timeString;
        } else if (c.completedAt) {
            const dt = new Date(c.completedAt);
            const dPart = `${dt.getFullYear()}.${String(dt.getMonth() + 1).padStart(2, '0')}.${String(dt.getDate()).padStart(2, '0')}`;
            const tPart = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            dateTimeStr = `${dPart} ${tPart}`;
        }

        excelData.push([
            idx + 1,
            c.phone || '연락처 없음',
            dateTimeStr,
            c.storeName || c.senderName || '-',
            c.address || '',
            c.customerPhone || '미등록',
            c.tag || '전달완료',
            c.photoUrl || '사진 없음'
        ]);
    });

    const ws = XLSX.utils.aoa_to_sheet(excelData);
    ws['!cols'] = [{ wch: 6 }, { wch: 15 }, { wch: 20 }, { wch: 20 }, { wch: 45 }, { wch: 15 }, { wch: 15 }, { wch: 60 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "배송완료목록");
    XLSX.writeFile(wb, `배송완료리스트_${selectedDate}.xlsx`);
}