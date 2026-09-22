// js/support.js
// =================================================================
// [배송 동선 PRO] 보조 기능 전담 모듈 (연결 설정 / 알림함 / 지난 배송 이력)
// =================================================================

import { deleteCompletionFromFirestore, firebaseSetTmsPermission } from './api.js';

// 내부 상태 변수
let currentActiveAlertMsgId = null;
let pendingTmsState = null;
let onRestoreDestinationCallback = null;
let onGpsToggleCallback = null;

// ==========================================
// 1. 공통 로딩 오버레이 제어
// ==========================================
function showLoading(text) { 
    const elText = document.getElementById('loading-text');
    const elOverlay = document.getElementById('loading-overlay');
    if (elText) elText.innerText = text; 
    if (elOverlay) elOverlay.classList.remove('hidden'); 
}

function hideLoading() { 
    const elOverlay = document.getElementById('loading-overlay');
    if (elOverlay) elOverlay.classList.add('hidden'); 
}

// ==========================================
// 2. 외부 콜백/핸들러 등록 (app.js 연동용)
// ==========================================
export function setRestoreDestinationHandler(fn) {
    onRestoreDestinationCallback = fn;
}

export function setGpsToggleHandler(fn) {
    onGpsToggleCallback = fn;
}

// 카카오 단독 주소 지오코딩 보조 함수 (배송지 복원 시 좌표 보정용)
async function geocodeAddress(address) {
    const KAKAO_REST_API_KEY = "625c74c7254b3dbf7eea75ba0cac4c5f";
    let response = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`, { 
        headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
    });
    let data = await response.json();
    if (data.documents && data.documents.length > 0) {
        return { lat: parseFloat(data.documents[0].y), lng: parseFloat(data.documents[0].x), address_name: data.documents[0].address_name };
    }
    response = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(address)}`, { 
        headers: { 'Authorization': `KakaoAK ${KAKAO_REST_API_KEY}` } 
    });
    data = await response.json();
    if (data.documents && data.documents.length > 0) {
        let finalName = data.documents[0].place_name;
        if(data.documents[0].address_name) finalName += ` (${data.documents[0].address_name})`;
        return { lat: parseFloat(data.documents[0].y), lng: parseFloat(data.documents[0].x), address_name: finalName };
    }
    throw new Error('주소 좌표 변환 실패');
}

// ==========================================
// 3. 알림함 및 관제 팝업 관리 기능
// ==========================================
export function playBeepSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); 
        gain.connect(ctx.destination);
        osc.frequency.value = 880; 
        gain.gain.value = 0.3;
        osc.start();
        setTimeout(() => { osc.stop(); }, 250);
    } catch(e) {}
}

export function saveMessageToLocalHistory(msgId, content, dateStr, timeStr, senderTitle, senderType) {
    let notices = JSON.parse(localStorage.getItem('deliveryPro_notices') || '[]');
    const isMaster = (senderType === 'MASTER' || senderTitle === '운영사 알림');
    const finalTitle = senderTitle || (isMaster ? '운영사 알림' : '회사 알림');

    if (!notices.some(n => n.msgId === msgId)) {
        notices.unshift({
            msgId: msgId, 
            content: content,
            dateStr: dateStr || new Date().toISOString().split('T')[0],
            timeStr: timeStr || '00:00',
            senderTitle: finalTitle,
            senderType: senderType || (isMaster ? 'MASTER' : 'DISPATCH'),
            timestamp: Date.now()
        });
        if (notices.length > 50) notices = notices.slice(0, 50);
        localStorage.setItem('deliveryPro_notices', JSON.stringify(notices));
        checkUnreadNotices();
    }
}

export function checkUnreadNotices() {
    const dot = document.getElementById('notice-unread-dot');
    if (!dot) return;
    const notices = JSON.parse(localStorage.getItem('deliveryPro_notices') || '[]');
    const unread = notices.some(n => !localStorage.getItem(`acked_msg_${n.msgId}`));
    if (unread) dot.classList.remove('hidden');
    else dot.classList.add('hidden');
}

export function showDispatchAlertPopup(content, timeStr, msgId, senderTitle, senderType) {
    currentActiveAlertMsgId = msgId;
    const isMaster = (senderType === 'MASTER' || senderTitle === '운영사 알림');
    const title = senderTitle || (isMaster ? '운영사 알림' : '회사 알림');

    const modalBox = document.getElementById('dispatch-alert-box');
    const iconBox = document.getElementById('dispatch-alert-icon-box');
    const badge = document.getElementById('dispatch-alert-badge');

    if (isMaster) {
        if (modalBox) modalBox.className = "bg-white w-full max-w-sm rounded-3xl p-6 shadow-2xl relative border-2 border-amber-500 text-center";
        if (iconBox) iconBox.className = "w-14 h-14 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center text-2xl mx-auto mb-3 shadow-inner animate-bounce";
        if (badge) { badge.className = "bg-amber-500 text-white text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-wider"; badge.innerText = title; }
    } else {
        if (modalBox) modalBox.className = "bg-white w-full max-w-sm rounded-3xl p-6 shadow-2xl relative border-2 border-blue-500 text-center";
        if (iconBox) iconBox.className = "w-14 h-14 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center text-2xl mx-auto mb-3 shadow-inner animate-bounce";
        if (badge) { badge.className = "bg-blue-600 text-white text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-wider"; badge.innerText = title; }
    }

    const contentEl = document.getElementById('dispatch-alert-content');
    const timeEl = document.getElementById('dispatch-alert-time');
    const modalEl = document.getElementById('dispatch-alert-modal');

    if (contentEl) contentEl.innerText = content;
    if (timeEl) timeEl.innerText = `${timeStr || '방금'} 수신`;
    if (modalEl) modalEl.classList.remove('hidden');

    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    playBeepSound();
    checkUnreadNotices();
}

export function closeDispatchAlertModal() {
    if (currentActiveAlertMsgId) {
        localStorage.setItem(`acked_msg_${currentActiveAlertMsgId}`, "true");
    }
    document.getElementById('dispatch-alert-modal')?.classList.add('hidden');
    checkUnreadNotices();
}

export function openNoticeHistoryModal() {
    const container = document.getElementById('notice-history-container');
    const notices = JSON.parse(localStorage.getItem('deliveryPro_notices') || '[]');
    if (!container) return;

    if (notices.length === 0) {
        container.innerHTML = `<div class="text-center text-gray-400 py-20 text-xs font-bold">수신된 알림 내역이 없습니다.</div>`;
    } else {
        let html = '';
        notices.forEach(n => {
            const isMaster = (n.senderType === 'MASTER' || n.senderTitle === '운영사 알림');
            const badgeTitle = n.senderTitle || (isMaster ? '운영사 알림' : '회사 알림');
            const badgeClass = isMaster ? 'bg-amber-500 text-white' : 'bg-blue-600 text-white';

            html += `
            <div class="bg-white border border-gray-200 rounded-2xl p-4 shadow-xs flex flex-col gap-2">
                <div class="flex justify-between items-center text-xs">
                    <span class="${badgeClass} font-black text-[10px] px-2 py-0.5 rounded-md">${badgeTitle}</span>
                    <span class="text-[11px] font-mono text-gray-400">${n.dateStr} ${n.timeStr}</span>
                </div>
                <div class="p-3 bg-slate-50 border border-slate-100 rounded-xl text-xs font-bold text-gray-800 whitespace-pre-line leading-relaxed">
                    ${n.content}
                </div>
            </div>`;
        });
        container.innerHTML = html;
    }
    document.getElementById('notice-history-modal')?.classList.remove('hidden');
}

export function closeNoticeHistoryModal() { 
    document.getElementById('notice-history-modal')?.classList.add('hidden'); 
}

export function clearLocalNotices() {
    if (!confirm("알림 보관함을 모두 비우시겠습니까?")) return;
    localStorage.removeItem('deliveryPro_notices');
    openNoticeHistoryModal();
    checkUnreadNotices();
}

// ==========================================
// 4. 지난 배송 이력 관리 기능
// ==========================================
export function cleanOldHistory() {
    let history = JSON.parse(localStorage.getItem('deliveryPro_history') || '[]');
    let sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    history = history.filter(h => h.timestamp > sevenDaysAgo);
    localStorage.setItem('deliveryPro_history', JSON.stringify(history));
}

export function openHistoryModal() {
    let history = JSON.parse(localStorage.getItem('deliveryPro_history') || '[]');
    let container = document.getElementById('history-list-container');
    if (!container) return;
    if (history.length === 0) {
        container.innerHTML = `<div class="text-center text-gray-400 py-16 text-sm"><p>완료된 배송 이력이 없습니다.</p></div>`;
    } else {
        let grouped = {}; 
        history.forEach(h => { 
            if (!grouped[h.date]) grouped[h.date] = []; 
            grouped[h.date].push(h); 
        });
        let html = '';
        for (let date in grouped) {
            html += `<div class="sticky top-0 bg-white/95 backdrop-blur-sm z-10 py-2 mt-1 mb-2 border-b border-gray-100"><span class="text-[11px] font-black text-gray-600 bg-gray-100 px-2 py-1 rounded-md">${date}</span></div><div class="space-y-2 mb-4">`;
            let dailyTotal = grouped[date].length;
            grouped[date].forEach((h, idx) => { 
                let sequentialNum = dailyTotal - idx;
                let tagBadge = "";
                if (h.tag) {
                    if (h.tag === "배송 취소") {
                        tagBadge = `<span class="bg-red-50 border border-red-200 text-red-600 text-[9px] font-black px-1.5 py-0.5 rounded ml-1.5 shrink-0 whitespace-nowrap shadow-sm">[${h.tag}]</span>`;
                    } else {
                        tagBadge = `<span class="bg-emerald-50 border border-emerald-200 text-emerald-700 text-[9px] font-black px-1.5 py-0.5 rounded ml-1.5 shrink-0 whitespace-nowrap shadow-sm">[${h.tag}]</span>`;
                    }
                }
                let photoBadge = h.photoUrl 
                    ? `<a href="${h.photoUrl}" target="_blank" class="bg-blue-50 border border-blue-200 text-blue-700 text-[9px] font-black px-1.5 py-0.5 rounded ml-1 shrink-0 flex items-center gap-0.5 shadow-sm active:bg-blue-100"><i class="fa-solid fa-camera"></i> 사진</a>`
                    : (h.hasPhoto ? `<span class="bg-blue-50 border border-blue-200 text-blue-700 text-[9px] font-black px-1.5 py-0.5 rounded ml-1 shrink-0"><i class="fa-solid fa-camera"></i></span>` : "");
                html += `
                <div class="bg-gray-50 border border-gray-200 p-2.5 rounded-xl flex justify-between items-center text-xs shadow-sm">
                    <div class="flex items-center gap-1.5 flex-1 min-w-0">
                        <span class="bg-gray-200 text-gray-700 font-bold px-2 py-0.5 rounded-full shrink-0 text-[10px]">${sequentialNum}건</span>
                        <span class="font-bold text-gray-800 truncate ml-0.5">${h.address}</span>${tagBadge}${photoBadge}
                    </div>
                    <div class="flex items-center gap-2 shrink-0 ml-2">
                        <span class="text-gray-400 text-[9px] font-semibold">${h.time}</span>
                        <button onclick="restoreHistoryItem(${h.timestamp})" class="bg-blue-50 text-blue-600 border border-blue-200 px-2 py-1.5 rounded-lg text-[10px] font-bold active:bg-blue-100 shadow-sm transition flex items-center"><i class="fa-solid fa-rotate-left mr-1"></i> 복원</button>
                    </div>
                </div>`; 
            });
            html += `</div>`;
        }
        container.innerHTML = html;
    }
    document.getElementById('history-modal')?.classList.remove('hidden');
}

export function closeHistoryModal() { 
    document.getElementById('history-modal')?.classList.add('hidden'); 
}

export function clearAllHistory() { 
    if (confirm("이력을 모두 삭제하시겠습니까?")) { 
        localStorage.removeItem('deliveryPro_history'); 
        openHistoryModal(); 
    } 
}

export function archiveCompletedDelivery(item, tag = "", completionDocId = null, photoUrl = null) {
    let history = JSON.parse(localStorage.getItem('deliveryPro_history') || '[]');
    let now = new Date(); 
    let archivedItem = { ...item }; 
    history.unshift({ 
        id: item.id, 
        address: item.address, 
        tag: tag, 
        hasPhoto: !!photoUrl, 
        photoUrl: photoUrl || "", 
        completionDocId: completionDocId, 
        date: now.toLocaleDateString(), 
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 
        timestamp: now.getTime(), 
        originalData: archivedItem 
    });
    localStorage.setItem('deliveryPro_history', JSON.stringify(history));
}

export async function restoreHistoryItem(timestamp) {
    if (!confirm("이 배송지를 다시 진행 목록으로 되돌리시겠습니까?")) return;
    let history = JSON.parse(localStorage.getItem('deliveryPro_history') || '[]');
    const idx = history.findIndex(h => h.timestamp === timestamp);
    
    if (idx > -1) {
        showLoading("배송지 복원 중...");
        const targetHistory = history[idx];

        if (targetHistory.completionDocId) {
            await deleteCompletionFromFirestore(targetHistory.completionDocId);
        }

        let itemToRestore = targetHistory.originalData;
        if (!itemToRestore) {
            try {
                const coords = await geocodeAddress(targetHistory.address);
                itemToRestore = { id: targetHistory.id || Date.now(), address: targetHistory.address, lat: coords.lat, lng: coords.lng, phone: null };
            } catch(e) { 
                itemToRestore = { id: targetHistory.id || Date.now(), address: targetHistory.address, lat: 0, lng: 0, phone: null }; 
            }
        }
        
        if (itemToRestore) { 
            history.splice(idx, 1); 
            localStorage.setItem('deliveryPro_history', JSON.stringify(history)); 
            
            if (onRestoreDestinationCallback) {
                await onRestoreDestinationCallback(itemToRestore);
            }
            openHistoryModal(); 
        }
        hideLoading();
    }
}

// ==========================================
// 5. 연결 설정 모달 및 TMS/GPS 제어 기능
// ==========================================
export function openSettingsModal() {
    // 설정 모달 오픈 시 기여 현황 카운팅 수치 업데이트
    updateContributionStats();
    document.getElementById('settings-modal')?.classList.remove('hidden');
}

export function closeSettingsModal() {
    document.getElementById('settings-modal')?.classList.add('hidden');
}

// 내 기여 활동 통계 카운트 및 이벤트 프로그레스바 갱신 함수
function updateContributionStats() {
    try {
        // 1. 개인 메모 건수 계산 (로컬스토리지)
        const personalMemos = JSON.parse(localStorage.getItem('deliveryPro_personal_memos') || '{}');
        const personalCount = Object.keys(personalMemos).length;

        // 2. 공용 주차정보 작성 건수 계산 (기기 고유 ID 기준 또는 로컬 백업 기록 등 연동, 여기서는 기기별 기여 기록 또는 임시로 로컬에 기록된 내 공용 메모 카운트 연동)
        // 사용자가 공용 주차정보를 등록할 때 로컬에 기록된 키 혹은 기기 ID 기반 카운트 연동
        const myParkingMemos = JSON.parse(localStorage.getItem('deliveryPro_my_parking_memos') || '[]');
        const parkingCount = myParkingMemos.length;

        // UI 엘리먼트 반영
        const parkingCountEl = document.getElementById('stat-parking-memo-count');
        const personalCountEl = document.getElementById('stat-personal-memo-count');
        const progressTextEl = document.getElementById('stat-event-progress');
        const progressBarEl = document.getElementById('stat-event-bar');

        if (parkingCountEl) parkingCountEl.innerText = `${parkingCount}건`;
        if (personalCountEl) personalCountEl.innerText = `${personalCount}건`;

        // 150건 이벤트 프로그레스 계산 (공용 주차정보 150건 기준 또는 합산 기준 - 기획에 맞춰 공용 주차정보 기준 150건)
        const targetCount = 150;
        const currentProgress = Math.min(parkingCount, targetCount);
        const percent = Math.round((currentProgress / targetCount) * 100);

        if (progressTextEl) progressTextEl.innerText = `${currentProgress} / ${targetCount}`;
        if (progressBarEl) progressBarEl.style.width = `${percent}%`;
    } catch (e) {
        console.error("기여 통계 갱신 오류:", e);
    }
}

export function toggleTMS(isChecked) {
    if (!isChecked) {
        document.getElementById('tms-confirm-modal')?.classList.remove('hidden');
        pendingTmsState = false;
    } else {
        pendingTmsState = true;
        confirmTMSToggle();
    }
}

export function cancelTMSToggle() {
    const tmsToggle = document.getElementById('tms-toggle');
    if (tmsToggle) tmsToggle.checked = true;
    document.getElementById('tms-confirm-modal')?.classList.add('hidden');
}

export async function confirmTMSToggle() {
    const key = localStorage.getItem('deliveryProKey');
    if (!key) return;

    showLoading("TMS 설정 변경 중...");
    try {
        await firebaseSetTmsPermission(key, pendingTmsState);
        document.getElementById('tms-confirm-modal')?.classList.add('hidden');
        
        const descEl = document.getElementById('tms-success-desc');
        if (descEl) {
            descEl.innerHTML = pendingTmsState 
                ? "관제(TMS) 연결이 <b>허용</b>되었습니다.<br>이제 사무실과 데이터가 동기화됩니다." 
                : "관제(TMS) 연결이 <b>차단</b>되었습니다.<br>기존 연결이 해제되었습니다.";
        }
        document.getElementById('tms-success-modal')?.classList.remove('hidden');
    } catch (e) {
        alert("상태 변경 중 오류가 발생했습니다: " + e.message);
        const tmsToggle = document.getElementById('tms-toggle');
        if (tmsToggle) tmsToggle.checked = !pendingTmsState;
    } finally {
        hideLoading();
    }
}

export function toggleGPS(isChecked) {
    if (onGpsToggleCallback) {
        onGpsToggleCallback(isChecked);
    }
}

// ==========================================
// 6. Window 전역 객체 바인딩 (인라인 HTML 이벤트용)
// ==========================================
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.toggleTMS = toggleTMS;
window.cancelTMSToggle = cancelTMSToggle;
window.confirmTMSToggle = confirmTMSToggle;
window.toggleGPS = toggleGPS;

window.showDispatchAlertPopup = showDispatchAlertPopup;
window.closeDispatchAlertModal = closeDispatchAlertModal;
window.openNoticeHistoryModal = openNoticeHistoryModal;
window.closeNoticeHistoryModal = closeNoticeHistoryModal;
window.clearLocalNotices = clearLocalNotices;

window.openHistoryModal = openHistoryModal;
window.closeHistoryModal = closeHistoryModal;
window.clearAllHistory = clearAllHistory;
window.restoreHistoryItem = restoreHistoryItem;