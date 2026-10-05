// js/admin-dispatch-msg.js

import { db } from "./admin-api.js";
import { state, getLocalDateString } from "./admin-state.js";
import { playBeepSound } from "./admin-utils.js";
import { collection, doc, addDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// ==========================================
// 1. 발송할 기사 선택 목록 (메시지 사이드바)
// ==========================================
export function renderMessageSidebar() {
    const headerEl = document.getElementById('sidebar-header');
    const contentEl = document.getElementById('sidebar-content');
    const visibleLicenses = window.getFilteredVisibleDrivers();

    headerEl.innerHTML = `
        <h2 class="text-xs font-black text-gray-700 uppercase tracking-wider flex items-center gap-1.5"><i class="fa-solid fa-comments text-blue-600"></i> 수신 기사 선택</h2>
        <button onclick="window.toggleAllMessageSelection()" class="text-[11px] font-black text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md border border-blue-200 hover:bg-blue-100 transition">
            ${state.selectedMessageDrivers.size === visibleLicenses.length && visibleLicenses.length > 0 ? '선택 해제' : '전체 선택'}
        </button>`;

    if (visibleLicenses.length === 0) {
        contentEl.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">등록된 기사가 없습니다.</div>`; return;
    }
    
    let html = `<div class="space-y-2">`;
    visibleLicenses.forEach(lic => {
        const devId = lic.deviceId || lic.key;
        const phone = lic.phone || '연락처 미등록';
        const isChecked = state.selectedMessageDrivers.has(devId);
        
        html += `
        <label class="flex items-center justify-between p-3.5 bg-white border ${isChecked ? 'border-blue-500 bg-blue-50/40 ring-1 ring-blue-300' : 'border-gray-200 hover:bg-gray-50'} rounded-2xl cursor-pointer transition shadow-xs">
            <div class="flex items-center gap-3">
                <input type="checkbox" onchange="window.toggleMessageDriver('${devId}')" ${isChecked ? 'checked' : ''} class="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer">
                <div><span class="font-black text-sm text-gray-900 block leading-tight">${phone}</span><span class="text-[10px] text-gray-400 font-mono">ID: ${lic.key}</span></div>
            </div>
            <span class="text-[10px] font-black px-2 py-0.5 rounded-full ${isChecked ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'}">${isChecked ? '선택됨' : '대기'}</span>
        </label>`;
    });
    html += `</div>`;
    contentEl.innerHTML = html;
    document.getElementById('msg-selected-count').innerText = state.selectedMessageDrivers.size;
}

export function toggleMessageDriver(devId) {
    if (state.selectedMessageDrivers.has(devId)) state.selectedMessageDrivers.delete(devId);
    else state.selectedMessageDrivers.add(devId);
    renderMessageSidebar();
}

export function toggleAllMessageSelection() {
    const visibleLicenses = window.getFilteredVisibleDrivers();
    if (state.selectedMessageDrivers.size === visibleLicenses.length) state.selectedMessageDrivers.clear();
    else visibleLicenses.forEach(lic => state.selectedMessageDrivers.add(lic.deviceId || lic.key));
    renderMessageSidebar();
}

// ==========================================
// 2. 메시지 발송 로직 및 피드
// ==========================================
export function updateMessageCharCount() {
    const len = document.getElementById('message-input').value.length;
    document.getElementById('message-char-count').innerText = `${len} / 300자`;
}

export async function sendDispatchMessage() {
    const textarea = document.getElementById('message-input');
    const text = textarea.value.trim();
    const btn = document.getElementById('btn-send-message');
    
    if (state.selectedMessageDrivers.size === 0) { alert("좌측 목록에서 회사 알림을 수신할 기사님을 1명 이상 선택해 주세요."); return; }
    if (!text) { alert("전송할 회사 알림 내용을 입력해 주세요."); textarea.focus(); return; }

    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey') || 'MASTER';
    const targets = Array.from(state.selectedMessageDrivers);
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 전송 중...';

    try {
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const dateStr = getLocalDateString(now);

        const targetPhones = [];
        targets.forEach(tId => {
            const lic = state.allLicenses.find(l => (l.deviceId && l.deviceId === tId) || l.key === tId);
            if (lic && lic.phone) targetPhones.push(lic.phone);
            else targetPhones.push(tId);
        });

        await addDoc(collection(db, "dispatch_messages"), {
            senderKey: dispatchKey, senderType: "DISPATCH", senderTitle: "회사 알림", 
            targetDeviceIds: targets, targetPhones: targetPhones, content: text,
            createdAt: now.getTime(), dateStr: dateStr, timeStr: timeStr, acknowledged: []
        });
        
        alert(`[회사 알림 발송 완료]\n${targets.length}명의 기사 스마트폰으로 알림이 실시간 전송되었습니다.`);
        textarea.value = ''; updateMessageCharCount();
    } catch (e) { 
        alert("알림 전송 오류: " + e.message); 
    } finally { 
        btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane text-xs"></i><span>회사 알림 발송</span>'; 
    }
}

export async function deleteDispatchMessage(msgId) {
    if (!confirm("이 발송 알림 기록을 삭제하시겠습니까?")) return;
    try { await deleteDoc(doc(db, "dispatch_messages", msgId)); } catch (e) { alert("삭제 오류: " + e.message); }
}

export function renderMessageFeed() {
    const feedEl = document.getElementById('dispatch-message-feed');
    if (!feedEl) return;
    const currentDispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const mySentMessages = state.allDispatchMessages.filter(msg => {
        if (msg.senderKey === 'MASTER' || msg.senderType === 'MASTER') return false;
        if (state.currentUserRole === 'DISPATCH') return msg.senderKey === currentDispatchKey;
        return true;
    });

    if (mySentMessages.length === 0) {
        feedEl.innerHTML = `<div class="text-center text-gray-400 py-20 text-xs font-bold space-y-2"><div class="w-14 h-14 bg-white border border-gray-200 rounded-2xl flex items-center justify-center mx-auto text-xl text-gray-300 shadow-xs"><i class="fa-regular fa-bell"></i></div><p>발송된 회사 알림 내역이 없습니다.</p></div>`;
        return;
    }

    let html = '';
    mySentMessages.forEach(msg => {
        const targetPreview = msg.targetPhones && msg.targetPhones.length > 0 ? (msg.targetPhones.length === 1 ? msg.targetPhones[0] : `${msg.targetPhones[0]} 외 ${msg.targetPhones.length - 1}명`) : '전체 기사';
        html += `
        <div class="bg-white border border-gray-200 rounded-2xl p-4 shadow-xs flex flex-col gap-2 hover:border-blue-300 transition">
            <div class="flex justify-between items-center text-xs">
                <div class="flex items-center gap-2">
                    <span class="bg-blue-600 text-white font-black text-[10px] px-2 py-0.5 rounded-md shadow-xs">${msg.senderTitle || '회사 알림'}</span>
                    <span class="font-bold text-gray-800"><i class="fa-solid fa-user-check text-blue-500 mr-1"></i>수신: ${targetPreview}</span>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-[11px] font-mono text-gray-400">${msg.dateStr || ''} ${msg.timeStr || ''}</span>
                    <button type="button" onclick="window.deleteDispatchMessage('${msg.id}')" class="text-gray-400 hover:text-red-500 p-1 transition" title="이 기록 삭제"><i class="fa-solid fa-trash-can text-xs"></i></button>
                </div>
            </div>
            <div class="p-3 bg-slate-50 border border-slate-200/80 rounded-xl text-xs font-bold text-gray-800 whitespace-pre-line leading-relaxed">${msg.content}</div>
        </div>`;
    });
    feedEl.innerHTML = html;
}

// ==========================================
// 3. 커스텀 템플릿(상용구) 로직
// ==========================================
export async function saveCustomTemplate() {
    const titleInput = document.getElementById('tpl-title-input');
    const contentInput = document.getElementById('tpl-content-input');
    const title = titleInput.value.trim(); const content = contentInput.value.trim();
    
    if (!title) { alert("알림 틀의 제목을 입력해 주세요."); titleInput.focus(); return; }
    if (!content) { alert("알림 틀 본문을 입력해 주세요."); contentInput.focus(); return; }

    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey') || 'MASTER';
    try {
        await addDoc(collection(db, "dispatch_templates"), { title: title, content: content, dispatchKey: dispatchKey, createdAt: Date.now() });
        titleInput.value = ''; contentInput.value = ''; alert(`[${title}] 알림 틀이 저장되었습니다.`);
    } catch (e) { alert("틀 저장 오류: " + e.message); }
}

export function insertCustomTemplate(content) {
    const textarea = document.getElementById('message-input');
    textarea.value = content; textarea.focus(); updateMessageCharCount();
}

export async function deleteCustomTemplate(id) {
    if (!confirm("이 알림 틀을 삭제하시겠습니까?")) return;
    try { await deleteDoc(doc(db, "dispatch_templates", id)); } catch (e) { alert("삭제 오류: " + e.message); }
}

export function renderCustomTemplates() {
    const listEl = document.getElementById('custom-template-list');
    if (!listEl) return;
    if (state.allDispatchTemplates.length === 0) { 
        listEl.innerHTML = `<div class="text-center text-gray-400 py-12 text-xs font-bold">저장된 알림 틀이 없습니다.</div>`; 
        return; 
    }

    let html = '';
    state.allDispatchTemplates.forEach(tpl => {
        const escapedContent = (tpl.content || '').replace(/"/g, '&quot;').replace(/'/g, "\\'").replace(/\n/g, '\\n');
        html += `
        <div class="group p-3 bg-white border border-gray-200 rounded-2xl hover:border-blue-400 hover:shadow-xs transition flex flex-col gap-1.5 relative">
            <div class="flex justify-between items-start gap-2">
                <span onclick="window.insertCustomTemplate('${escapedContent}')" class="font-black text-xs text-gray-900 cursor-pointer hover:text-blue-600 flex items-center gap-1.5 truncate flex-1"><i class="fa-solid fa-file-lines text-blue-500 text-[11px] shrink-0"></i><span class="truncate">${tpl.title || '제목 없음'}</span></span>
                <button onclick="window.deleteCustomTemplate('${tpl.id}')" class="text-gray-300 hover:text-red-500 p-1 text-xs transition" title="틀 삭제"><i class="fa-solid fa-trash-can text-[11px]"></i></button>
            </div>
            <p onclick="window.insertCustomTemplate('${escapedContent}')" class="text-[11px] text-gray-600 font-medium line-clamp-2 leading-relaxed cursor-pointer hover:text-gray-800">${tpl.content || ''}</p>
        </div>`;
    });
    listEl.innerHTML = html;
}

// ==========================================
// 4. 운영사 알림 (Inbox 수신 및 팝업)
// ==========================================
export function showDispatchPopupAlert(msg) {
    state.activeDispatchPopupMsgId = msg.id;
    const contentEl = document.getElementById('dispatch-popup-alert-content');
    const timeEl = document.getElementById('dispatch-popup-alert-time');
    const modal = document.getElementById('dispatch-popup-alert-modal');
    if (!contentEl || !modal) return;
    contentEl.innerText = msg.content || '';
    timeEl.innerText = `${msg.timeStr || '방금'} 수신`;
    modal.classList.remove('hidden');
    playBeepSound();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

export function closeDispatchPopupAlertModal() {
    if (state.activeDispatchPopupMsgId) localStorage.setItem(`acked_disp_inbox_${state.activeDispatchPopupMsgId}`, 'true');
    const modal = document.getElementById('dispatch-popup-alert-modal');
    if (modal) modal.classList.add('hidden');
    state.activeDispatchPopupMsgId = null;
    checkDispatchInboxNotifications();
}

export function checkDispatchInboxNotifications() {
    if (state.currentUserRole !== 'DISPATCH') return;
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const sessionToken = sessionStorage.getItem('deliveryProSessionToken');
    const matchedLic = state.allLicenses.find(l => l.key === dispatchKey);
    const phone = (matchedLic?.phone || '').replace(/[^0-9]/g, '');

    const normalizeKey = (k) => k ? k.toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '') : '';
    const normalizedDispatchKey = normalizeKey(dispatchKey);

    const myReceivedMasterNotices = state.allDispatchMessages.filter(msg => {
        if (msg.senderKey !== 'MASTER' && msg.senderType !== 'MASTER') return false;
        if (localStorage.getItem(`deleted_disp_msg_${msg.id}`)) return false;

        const hasTargets = msg.targetDeviceIds && msg.targetDeviceIds.length > 0;
        let keyMatch = false;
        if (hasTargets) {
            keyMatch = msg.targetDeviceIds.some(targetKey => normalizeKey(targetKey) === normalizedDispatchKey || targetKey === sessionToken);
        }
        const phoneMatch = phone && msg.targetPhones && msg.targetPhones.some(p => p.replace(/[^0-9]/g, '') === phone);
        return keyMatch || phoneMatch;
    });

    const unreadMessages = myReceivedMasterNotices.filter(m => !localStorage.getItem(`acked_disp_inbox_${m.id}`));
    const unreadCount = unreadMessages.length;

    const badge = document.getElementById('dispatch-inbox-badge');
    const btn = document.getElementById('btn-dispatch-inbox');
    if (badge) {
        if (unreadCount > 0) { badge.innerText = unreadCount; badge.classList.remove('hidden'); badge.classList.add('animate-pulse'); }
        else { badge.classList.add('hidden'); badge.classList.remove('animate-pulse'); }
    }
    if (btn) {
        if (unreadCount > 0) { btn.classList.add('ring-2', 'ring-red-500', 'animate-pulse', 'bg-amber-100'); btn.classList.remove('bg-amber-50'); }
        else { btn.classList.remove('ring-2', 'ring-red-500', 'animate-pulse', 'bg-amber-100'); btn.classList.add('bg-amber-50'); }
    }

    if (unreadMessages.length > 0) {
        const latest = unreadMessages[0];
        const alreadyPopped = sessionStorage.getItem(`popped_disp_alert_${latest.id}`);
        if (!alreadyPopped) {
            sessionStorage.setItem(`popped_disp_alert_${latest.id}`, 'true');
            showDispatchPopupAlert(latest);
        }
    }
}

export function openDispatchInboxModal() {
    const container = document.getElementById('dispatch-inbox-container');
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const sessionToken = sessionStorage.getItem('deliveryProSessionToken');
    const matchedLic = state.allLicenses.find(l => l.key === dispatchKey);
    const phone = (matchedLic?.phone || '').replace(/[^0-9]/g, '');

    const normalizeKey = (k) => k ? k.toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '') : '';
    const normalizedDispatchKey = normalizeKey(dispatchKey);

    const myReceivedMasterNotices = state.allDispatchMessages.filter(msg => {
        if (msg.senderKey !== 'MASTER' && msg.senderType !== 'MASTER') return false;
        if (localStorage.getItem(`deleted_disp_msg_${msg.id}`)) return false;

        const hasTargets = msg.targetDeviceIds && msg.targetDeviceIds.length > 0;
        let keyMatch = false;
        if (hasTargets) {
            keyMatch = msg.targetDeviceIds.some(targetKey => normalizeKey(targetKey) === normalizedDispatchKey || targetKey === sessionToken);
        }
        const phoneMatch = phone && msg.targetPhones && msg.targetPhones.some(p => p.replace(/[^0-9]/g, '') === phone);
        return keyMatch || phoneMatch;
    });

    if (myReceivedMasterNotices.length === 0) {
        container.innerHTML = `<div class="text-center text-gray-400 py-16 text-xs font-bold">수신된 알림이 없습니다.</div>`;
    } else {
        let html = '';
        myReceivedMasterNotices.forEach(m => {
            localStorage.setItem(`acked_disp_inbox_${m.id}`, 'true');
            html += `
            <div class="bg-amber-50/40 border border-amber-200 rounded-2xl p-4 shadow-2xs flex flex-col gap-1.5 hover:border-amber-300 transition">
                <div class="flex justify-between items-center text-xs">
                    <span class="bg-amber-500 text-white font-black text-[10px] px-2 py-0.5 rounded-md">${m.senderTitle || '운영사 알림'}</span>
                    <div class="flex items-center gap-2"><span class="text-[11px] font-mono text-gray-400">${m.dateStr || ''} ${m.timeStr || ''}</span><button type="button" onclick="window.deleteNoticeFromDispatchInbox('${m.id}')" class="text-gray-400 hover:text-red-500 p-1 transition active:scale-95" title="알림 삭제"><i class="fa-solid fa-trash-can text-xs"></i></button></div>
                </div>
                <p class="text-xs font-bold text-gray-800 whitespace-pre-line leading-relaxed mt-1">${m.content}</p>
            </div>`;
        });
        container.innerHTML = html;
    }
    checkDispatchInboxNotifications();
    document.getElementById('dispatch-inbox-modal').classList.remove('hidden');
}

export function closeDispatchInboxModal() { document.getElementById('dispatch-inbox-modal').classList.add('hidden'); }

export async function deleteNoticeFromDispatchInbox(msgId) {
    if (!confirm("이 알림을 삭제하시겠습니까?")) return;
    try {
        localStorage.setItem(`deleted_disp_msg_${msgId}`, 'true');
        openDispatchInboxModal();
        checkDispatchInboxNotifications();
    } catch(e) { alert("삭제 오류: " + e.message); }
}

export async function clearAllDispatchInbox() {
    if (!confirm("알림함의 모든 알림을 삭제하시겠습니까?")) return;
    const dispatchKey = sessionStorage.getItem('deliveryProDispatchKey');
    const sessionToken = sessionStorage.getItem('deliveryProSessionToken');
    const matchedLic = state.allLicenses.find(l => l.key === dispatchKey);
    const phone = (matchedLic?.phone || '').replace(/[^0-9]/g, '');

    const normalizeKey = (k) => k ? k.toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '') : '';
    const normalizedDispatchKey = normalizeKey(dispatchKey);

    const myNotices = state.allDispatchMessages.filter(msg => {
        if (msg.senderKey !== 'MASTER' && msg.senderType !== 'MASTER') return false;
        if (localStorage.getItem(`deleted_disp_msg_${msg.id}`)) return false;
        const hasTargets = msg.targetDeviceIds && msg.targetDeviceIds.length > 0;
        let keyMatch = false;
        if (hasTargets) {
            keyMatch = msg.targetDeviceIds.some(targetKey => normalizeKey(targetKey) === normalizedDispatchKey || targetKey === sessionToken);
        }
        const phoneMatch = phone && msg.targetPhones && msg.targetPhones.some(p => p.replace(/[^0-9]/g, '') === phone);
        return keyMatch || phoneMatch;
    });

    for (const m of myNotices) localStorage.setItem(`deleted_disp_msg_${m.id}`, 'true');
    openDispatchInboxModal();
    checkDispatchInboxNotifications();
}