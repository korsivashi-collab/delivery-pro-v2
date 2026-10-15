// js/admin-dispatch-msg.js

import { db } from "./admin-api.js";
import { state, getLocalDateString } from "./admin-state.js";
import { playBeepSound, refreshDispatchSoundButton } from "./admin-utils.js";
import { collection, doc, addDoc, deleteDoc, getDocs, query, where } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const escapeMessage = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));

let messageBox = 'inbox';
function isReceivedMessage(msg) {
    const key = sessionStorage.getItem('deliveryProDispatchKey');
    if (!key) return false;
    if (msg.senderType === 'DRIVER') return msg.targetDispatchKey === key;
    if (msg.senderKey !== 'MASTER' && msg.senderType !== 'MASTER') return false;
    const normalize = value => String(value || '').toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '');
    const token = sessionStorage.getItem('deliveryProSessionToken');
    const phone = String((state.allLicenses || []).find(l => l.key === key)?.phone || '').replace(/\D/g,'');
    return (msg.targetDeviceIds || []).some(v => normalize(v) === normalize(key) || token && v === token) ||
        !!phone && (msg.targetPhones || []).some(v => String(v).replace(/\D/g,'') === phone);
}
function isSentMessage(msg) {
    const key = sessionStorage.getItem('deliveryProDispatchKey') || (state.currentUserRole === 'MASTER' ? 'MASTER' : '');
    return !!key && msg.senderKey === key && msg.senderType !== 'DRIVER';
}
export function setMessageBox(box) {
    messageBox = box === 'sent' ? 'sent' : 'inbox';
    renderMessageFeed();
}
window.setMessageBox = setMessageBox;
window.exportCurrentMessageBox = () => exportDispatchMessages(messageBox);

// ==========================================
// 1. 발송할 기사 선택 목록 (메시지 사이드바)
// ==========================================
export function renderMessageSidebar() {
    const headerEl = document.getElementById('sidebar-header');
    const contentEl = document.getElementById('sidebar-content');
    const visibleLicenses = window.getFilteredVisibleDrivers();

    headerEl.innerHTML = `
        <h2 class="text-xs font-black text-gray-700 uppercase tracking-wider flex items-center gap-1.5"><i class="fa-solid fa-comments text-blue-600"></i> 발송 대상 기사 선택</h2>
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
    const selected = window.getFilteredVisibleDrivers().filter(lic => state.selectedMessageDrivers.has(lic.deviceId || lic.key));
    const targets = selected.map(lic => lic.deviceId || lic.key);
    if (!targets.length) { alert('현재 연결된 기사를 다시 선택해 주세요.'); return; }
    if (text.length > 300) { alert('메시지는 300자까지 전송할 수 있습니다.'); return; }
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
            targetLicenseKeys: selected.map(lic => lic.key), targetDeviceIds: [...new Set([...targets, ...selected.map(lic => lic.key)])], targetPhones: targetPhones, content: text,
            createdAt: now.getTime(), dateStr: dateStr, timeStr: timeStr, acknowledged: []
        });
        
        alert(`[회사 알림 발송 완료]\n${targets.length}명에게 보낼 알림을 저장했습니다. 연결된 기사 화면에서 수신합니다.`);
        textarea.value = ''; updateMessageCharCount(); setMessageBox('sent');
    } catch (e) { 
        alert("알림 전송 오류: " + e.message); 
    } finally { 
        btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane text-xs"></i><span>회사 알림 발송</span>'; 
    }
}

export async function deleteDispatchMessage(msgId) {
    if (!state.allDispatchMessages.some(msg => msg.id === msgId && isSentMessage(msg))) return;
    if (!confirm("이 발송 알림 기록을 삭제하시겠습니까?")) return;
    try { await deleteDoc(doc(db, "dispatch_messages", msgId)); } catch (e) { alert("삭제 오류: " + e.message); }
}

export function renderMessageFeed() {
    const feedEl = document.getElementById('dispatch-message-feed');
    if (!feedEl) return;
    if (typeof refreshDispatchSoundButton === 'function') refreshDispatchSoundButton();
    for (const box of ['inbox','sent']) {
        const button = document.getElementById('message-tab-' + box);
        if (button) {
            button.className = 'rounded px-3 py-2 ' + (box === messageBox ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700');
            button.setAttribute('aria-pressed', String(box === messageBox));
        }
    }
    for (const id of ['message-export-start','message-export-end']) {
        const input = document.getElementById(id);
        if (input && !input.value) input.value = getLocalDateString(new Date());
    }
    const mySentMessages = state.allDispatchMessages.filter(msg => messageBox === 'sent' ? isSentMessage(msg) :
        isReceivedMessage(msg) && !localStorage.getItem(`deleted_disp_msg_${msg.id}`));
    checkDispatchInboxNotifications();
    if (state.dispatchNavState === 'MESSAGE' && messageBox === 'inbox') {
        mySentMessages.forEach(msg => localStorage.setItem(`acked_disp_inbox_${msg.id}`, 'true'));
    }
    checkDispatchInboxNotifications();

    if (mySentMessages.length === 0) {
        feedEl.innerHTML = `<div class="text-center text-gray-400 py-20 text-xs font-bold space-y-2"><div class="w-14 h-14 bg-white border border-gray-200 rounded-2xl flex items-center justify-center mx-auto text-xl text-gray-300 shadow-xs"><i class="fa-regular fa-bell"></i></div><p>${messageBox === 'inbox' ? '수신된 메시지' : '발송한 메시지'}가 없습니다.</p></div>`;
        return;
    }

    let html = '';
    mySentMessages.forEach(msg => {
        const targetPreview = msg.targetPhones && msg.targetPhones.length > 0 ? (msg.targetPhones.length === 1 ? msg.targetPhones[0] : `${msg.targetPhones[0]} 외 ${msg.targetPhones.length - 1}명`) : '전체 기사';
        html += `
        <div class="bg-white border border-gray-200 rounded-2xl p-4 shadow-xs flex flex-col gap-2 hover:border-blue-300 transition">
            <div class="flex justify-between items-center text-xs">
                <div class="flex items-center gap-2">
                    <span class="bg-blue-600 text-white font-black text-[10px] px-2 py-0.5 rounded-md shadow-xs">${escapeMessage(msg.senderType === 'DRIVER' ? '기사 → 사무실' : (msg.senderTitle || '회사 알림'))}</span>
                    <span class="font-bold text-gray-800"><i class="fa-solid fa-user-check text-blue-500 mr-1"></i>${msg.senderType === 'DRIVER' ? '발신: ' + escapeMessage(msg.senderPhone || msg.senderKey) : messageBox === 'inbox' ? '발신: 운영사' : '수신: ' + escapeMessage(targetPreview)}</span>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-[11px] font-mono text-gray-400">${escapeMessage(msg.dateStr || '')} ${escapeMessage(msg.timeStr || '')}</span>
                    <button type="button" onclick="window.${messageBox === 'inbox' ? 'deleteNoticeFromDispatchInbox' : 'deleteDispatchMessage'}('${escapeMessage(msg.id)}')" class="text-gray-400 hover:text-red-500 p-1 transition" title="이 기록 삭제"><i class="fa-solid fa-trash-can text-xs"></i></button>
                </div>
            </div>
            <div class="p-3 bg-slate-50 border border-slate-200/80 rounded-xl text-xs font-bold text-gray-800 whitespace-pre-line leading-relaxed">${escapeMessage(msg.content)}</div>
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
                <span onclick="window.insertCustomTemplateById('${tpl.id}')" class="font-black text-xs text-gray-900 cursor-pointer hover:text-blue-600 flex items-center gap-1.5 truncate flex-1"><i class="fa-solid fa-file-lines text-blue-500 text-[11px] shrink-0"></i><span class="truncate">${escapeMessage(tpl.title || '제목 없음')}</span></span>
                <button onclick="window.deleteCustomTemplate('${tpl.id}')" class="text-gray-300 hover:text-red-500 p-1 text-xs transition" title="틀 삭제"><i class="fa-solid fa-trash-can text-[11px]"></i></button>
            </div>
            <p onclick="window.insertCustomTemplateById('${tpl.id}')" class="text-[11px] text-gray-600 font-medium line-clamp-2 leading-relaxed cursor-pointer hover:text-gray-800">${escapeMessage(tpl.content || '')}</p>
        </div>`;
    });
    listEl.innerHTML = html;
}

// ==========================================
// 4. 수신 상태는 메시지 메뉴의 읽지 않은 건수와 알림음으로 안내합니다.
export function showDispatchPopupAlert() { playBeepSound(); }
export function closeDispatchPopupAlertModal() { checkDispatchInboxNotifications(); }
export function checkDispatchInboxNotifications() {
    if (state.currentUserRole !== 'DISPATCH') return;
    const unread = state.allDispatchMessages.filter(msg => isReceivedMessage(msg) &&
        !localStorage.getItem(`deleted_disp_msg_${msg.id}`) && !localStorage.getItem(`acked_disp_inbox_${msg.id}`));
    const badge = document.getElementById('dispatch-inbox-badge');
    if (badge) {
        badge.innerText = unread.length;
        if (unread.length) badge.classList.remove('hidden'); else badge.classList.add('hidden');
    }
    // 읽고 있는 수신함에도 새 메시지 소리는 한 번 재생합니다.
    const fresh = state.allDispatchMessages.filter(msg => isReceivedMessage(msg) &&
        !localStorage.getItem(`deleted_disp_msg_${msg.id}`) && !sessionStorage.getItem(`popped_disp_alert_${msg.id}`) &&
        !localStorage.getItem(`acked_disp_inbox_${msg.id}`));
    if (fresh.length) {
        fresh.forEach(msg => sessionStorage.setItem(`popped_disp_alert_${msg.id}`, 'true'));
        playBeepSound();
    }
}
// 이전 호출부와의 호환: 별도 알림함 대신 통합 메시지 화면으로 이동합니다.
export function openDispatchInboxModal() {
    messageBox = 'inbox';
    window.setDispatchMode('MESSAGE');
}
export function closeDispatchInboxModal() {}
export async function deleteNoticeFromDispatchInbox(msgId) {
    if (!state.allDispatchMessages.some(m => m.id === msgId && isReceivedMessage(m))) return;
    if (!confirm('이 수신 메시지를 목록에서 숨기시겠습니까?')) return;
    localStorage.setItem(`deleted_disp_msg_${msgId}`, 'true');
    renderMessageFeed();
}
export async function clearAllDispatchInbox() {
    if (!confirm('수신 메시지를 목록에서 모두 숨기시겠습니까?')) return;
    state.allDispatchMessages.filter(isReceivedMessage).forEach(m => localStorage.setItem(`deleted_disp_msg_${m.id}`, 'true'));
    renderMessageFeed();
}
export async function exportDispatchMessages(scope = 'messages') {
    const start = document.getElementById('message-export-start').value;
    const end = document.getElementById('message-export-end').value;
    if (!start || !end || start > end) { alert('올바른 시작일과 종료일을 선택해 주세요.'); return; }
    const key = sessionStorage.getItem('deliveryProDispatchKey');
    const master = sessionStorage.getItem('deliveryProRole') === 'MASTER';
    if (!master && !key) return;
    try {
        const source = collection(db, 'dispatch_messages');
        const queries = master ? [source] : [query(source, where('senderKey','==',key)), query(source,where('targetDispatchKey','==',key)), query(source,where('senderKey','==','MASTER'))];
        const records = new Map();
        for (const q of queries) (await getDocs(q)).forEach(d => records.set(d.id,d.data()));
        const from = new Date(start+'T00:00:00').getTime();
        const until = new Date(end+'T00:00:00'); until.setDate(until.getDate()+1);
        const targetPhone = String((state.allLicenses || []).find(l => l.key === key)?.phone || '').replace(/\D/g, '');
        const sessionToken = sessionStorage.getItem('deliveryProSessionToken');
        const normalize = value => String(value || '').toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '');
        const incoming = m => m.senderType === 'DRIVER' ? m.targetDispatchKey === key :
            (m.senderKey === 'MASTER' || m.senderType === 'MASTER') &&
            ((m.targetDeviceIds || []).some(v => normalize(v) === normalize(key) || v === sessionToken) ||
             targetPhone && (m.targetPhones || []).some(p => String(p).replace(/\D/g, '') === targetPhone));
        const messages = [...records.values()].filter(m => (master || m.senderKey === key || incoming(m)) &&
            (scope !== 'inbox' || incoming(m)) && (scope !== 'sent' || isSentMessage(m)) && m.createdAt >= from && m.createdAt < until.getTime()).sort((a,b)=>a.createdAt-b.createdAt);
        if (!messages.length) { alert('해당 기간의 메시지가 없습니다.'); return; }
        const rows = [['날짜','시간','구분','발신 전화번호/계정','수신 전화번호/계정','내용']];
        messages.forEach(m => rows.push([m.dateStr || '',m.timeStr || '',m.senderType === 'DRIVER' ? '기사 → 사무실' : m.senderKey === 'MASTER' || m.senderType === 'MASTER' ? '운영사 → 관제' : '사무실 → 기사',m.senderPhone || m.senderKey || '',m.targetDispatchKey || (m.targetPhones || []).join(', '),m.content || '']));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'메시지');
        XLSX.writeFile(wb,`메시지_${scope === 'inbox' ? '수신' : scope === 'sent' ? '발신' : '전체'}_${start}_${end}.xlsx`);
    } catch(error) { alert('메시지 내보내기 실패: '+error.message); }
}
window.exportDispatchMessages = exportDispatchMessages;

window.insertCustomTemplateById = id => {
    const template = state.allDispatchTemplates.find(t => t.id === id);
    if (template) insertCustomTemplate(template.content || '');
};
