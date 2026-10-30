// js/admin-dispatch-msg.js

import { db, auth, dispatchAccessRequest, sendAdminNotice, prepareDispatchNoticeInbox, requestDispatchSignupSms, dispatchSignupToken } from "./admin-api.js";
import { state, getLocalDateString } from "./admin-state.js";
import { selectLatestOwnedRoute } from "./route-owner.js";
import { playBeepSound, refreshDispatchSoundButton } from "./admin-utils.js";
import { collection, doc, addDoc, deleteDoc, getDoc, getDocs, query, where } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const escapeMessage = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));

let messageBox = 'inbox';
function isReceivedMessage(msg) {
    const key = sessionStorage.getItem('deliveryProDispatchKey');
    if (!key) return false;
    if (msg.senderType === 'DRIVER') return msg.targetDispatchKey === key;
    if (msg.senderKey !== 'MASTER' && msg.senderType !== 'MASTER') return false;
    if (msg.privateInbox === true) return true;
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
function sentHiddenKey(id) {
    return 'hidden_disp_sent_' + encodeURIComponent(sessionStorage.getItem('deliveryProDispatchKey') || 'MASTER') + '_' + id;
}
export function clearCurrentMessageBox() {
    const incoming = messageBox === 'inbox';
    const messages = state.allDispatchMessages.filter(incoming ? isReceivedMessage : isSentMessage);
    const storageKey = id => incoming ? 'deleted_disp_msg_' + id : sentHiddenKey(id);
    const visible = messages.filter(m => !localStorage.getItem(storageKey(m.id)));
    if (!visible.length) { alert('비울 메시지가 없습니다.'); return; }
    if (!confirm((incoming ? '받은내용' : '보내는내용') + ' ' + visible.length + '건을 이 브라우저의 목록에서 모두 지울까요?\n상대방의 기록과 엑셀 내보내기용 서버 기록은 유지됩니다.')) return;
    try {
        visible.forEach(m => localStorage.setItem(storageKey(m.id), 'true'));
    } catch (error) { alert('메시지함 비우기 중 저장 오류가 발생했습니다: ' + error.message); }
    renderMessageFeed();
}
window.clearCurrentMessageBox = clearCurrentMessageBox;

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
        const devId = lic.routeOwnerId || lic.deviceId || lic.key;
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
    else visibleLicenses.forEach(lic => state.selectedMessageDrivers.add(lic.routeOwnerId || lic.deviceId || lic.key));
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
    const selected = window.getFilteredVisibleDrivers().filter(lic => state.selectedMessageDrivers.has(lic.routeOwnerId || lic.deviceId || lic.key));
    const targets = selected.map(lic => lic.routeOwnerId || lic.deviceId || lic.key);
    if (!targets.length) { alert('현재 연결된 기사를 다시 선택해 주세요.'); return; }
    if (text.length > 300) { alert('메시지는 300자까지 전송할 수 있습니다.'); return; }
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 전송 중...';

    try {
        await sendAdminNotice(selected.map(lic => lic.key), text);
        alert(`[회사 알림 발송 완료]\n${targets.length}명에게 보낼 알림을 저장했습니다. 연결된 기사 화면에서 수신합니다.`);
        textarea.value = ''; updateMessageCharCount(); setMessageBox('sent');
    } catch (e) { 
        alert("알림 전송 오류: " + e.message); 
    } finally { 
        btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane text-xs"></i><span>선택한 기사에게 보내기</span>'; 
    }
}

export async function deleteDispatchMessage(msgId) {
    if (!state.allDispatchMessages.some(msg => msg.id === msgId && isSentMessage(msg))) return;
    if (!confirm("이 발송 알림 기록을 삭제하시겠습니까?")) return;
    try { await dispatchAccessRequest('deleteDispatchMessage', [], {messageId:msgId}); } catch (e) { alert("삭제 오류: " + e.message); }
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
    const clearButton = document.getElementById('message-clear-button');
    if (clearButton) clearButton.textContent = messageBox === 'inbox' ? '받은내용 비우기' : '보내는내용 비우기';
    const mySentMessages = state.allDispatchMessages.filter(msg => messageBox === 'sent' ? isSentMessage(msg) && !localStorage.getItem(sentHiddenKey(msg.id)) :
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
        const inboxId=master ? '' : await prepareDispatchNoticeInbox(key);
        const queries = master ? [source] : [query(source, where('senderKey','==',key)), query(source,where('targetDispatchKey','==',key)), collection(db, 'dispatch_inboxes', inboxId, 'messages')];
        const records = new Map();
        for (const [index,q] of queries.entries()) (await getDocs(q)).forEach(d => records.set(d.id,{...d.data(),...(!master && index===2 ? {privateInbox:true} : {})}));
        const from = new Date(start+'T00:00:00').getTime();
        const until = new Date(end+'T00:00:00'); until.setDate(until.getDate()+1);
        const targetPhone = String((state.allLicenses || []).find(l => l.key === key)?.phone || '').replace(/\D/g, '');
        const sessionToken = sessionStorage.getItem('deliveryProSessionToken');
        const normalize = value => String(value || '').toUpperCase().replace(/^(PRO|TRIAL|CTRL)-/i, '');
        const incoming = m => m.senderType === 'DRIVER' ? m.targetDispatchKey === key :
            (m.senderKey === 'MASTER' || m.senderType === 'MASTER') &&
            (m.privateInbox === true || (m.targetDeviceIds || []).some(v => normalize(v) === normalize(key) || v === sessionToken) ||
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

// 배송안내 문자: 배송번호별 선택, 서버 최종 문구 확인 후 명시적 발송 승인.
let customerLoadedOrders=[],customerLoadedDate='',customerLoadedOwner='',customerLoadVersion=0,customerDeliveryPage=1,customerLoadState='idle';
let customerEucCharacters,customerDeliveryFilter='all',customerSelectedNumbers=new Set(),customerDialogFocus=null;
const CUSTOMER_SMS_LIMIT=80,CUSTOMER_TRACKING_LINK='https://mtsk.co.kr/t/Ab3dE5fGh7Jk9LmN',CUSTOMER_SMS_PRICE=35;
const customerBilling={plan:'basic',period:'monthly',drivers:false,seats:5,slotPacks:0,extraPcs:0,extensionPacks:0,extensionPcs:0,smsCount:1000,initialized:false,owner:''};
const customerProductSelections={basic:null,pro:null};
function customerDispatchKey(){return sessionStorage.getItem('deliveryProDispatchKey')||'';}
function customerAccount(){const key=customerDispatchKey();return (state.allLicenses||[]).find(l=>l.key===key||l.id===key);}
const customerMoney=value=>Math.round(value).toLocaleString('ko-KR')+'원';
export function measureCustomerSms(value) {
    if (!customerEucCharacters) {
        customerEucCharacters = new Set();
        const decoder = new TextDecoder('euc-kr');
        for (let lead=0x81; lead<=0xfe; lead++) for (let trail=0x41; trail<=0xfe; trail++) {
            const character=decoder.decode(new Uint8Array([lead,trail]));
            if (Array.from(character).length===1 && character!=='\ufffd') customerEucCharacters.add(character);
        }
    }
    let bytes=0, unsupported=false;
    for (const character of String(value || '')) {
        if (character.codePointAt(0)<=0x7f) bytes++;
        else { bytes+=2; if (!customerEucCharacters.has(character)) unsupported=true; }
    }
    return {bytes,unsupported};
}
function customerCompanyHeading(){const account=customerAccount(),company=String(account?.companyName||account?.name||'업체명').replace(/[\r\n]/g,' ').trim();return `[${company}] 배송조회`;}
function customerFixedMessage(){const groups=customerSelectedMessageGroups();return (groups.length&&groups.every(g=>g.length>1)?'배송조회':'배송번호:Ab234')+'\n'+CUSTOMER_TRACKING_LINK;}
function customerDefaultBody(){const heading=customerCompanyHeading().replace(/ 배송조회$/,'');return measureCustomerSms(heading+'\n'+customerFixedMessage()).bytes<=80?heading:'배송 안내';}
function customerMessage(){const body=document.getElementById('customer-message-input')?.value.replace(/\r\n?/g,'\n')||'';return (body?body+'\n':'')+customerFixedMessage();}
export function updateCustomerMessagePreview(){
 const input=document.getElementById('customer-message-input');if(!input)return;
 const fixed=customerFixedMessage(),body=input.value.replace(/\r\n?/g,'\n'),fixedSize=measureCustomerSms(fixed).bytes,total=measureCustomerSms(customerMessage()),available=Math.max(0,80-total.bytes-(body?0:1));
 document.getElementById('customer-fixed-preview').textContent=fixed;input.style.height='auto';input.style.height=Math.min(260,Math.max(110,input.scrollHeight))+'px';
 const counter=document.getElementById('customer-message-remaining');counter.textContent=total.bytes>80?`${total.bytes-80}바이트 초과 · 문구를 줄여 주세요`:`더 입력 가능 ${available}바이트 · 한글 약 ${Math.floor(available/2)}자`;counter.classList.toggle('is-over',total.bytes>80||total.unsupported);
 document.getElementById('customer-message-bytes').textContent=`전체 ${total.bytes} / 80바이트`;
 const help=document.getElementById('customer-message-validation');help.textContent=total.unsupported?'이모지 등 문자 전송 시 바뀔 수 있는 문자를 제거해 주세요.':total.bytes>80?'단문 한도를 넘었습니다. 자동으로 장문 전환하지 않습니다.':`배송번호와 고객별 전용 주소, 줄바꿈을 포함한 길이입니다. 최종 확인 시 실제 고객별 문구를 다시 검증합니다.`;help.classList.toggle('is-error',total.unsupported||total.bytes>80);
 updateCustomerSelectionSummary();
}
export function saveCustomerMessageDraft(){const key=customerDispatchKey(),input=document.getElementById('customer-message-input');if(!key||!input)return;const note=document.getElementById('customer-draft-notice'),size=measureCustomerSms(customerMessage());if(size.bytes>80||size.unsupported){note.textContent='단문 한도와 지원 문자를 확인한 뒤 저장해 주세요.';return;}try{localStorage.setItem('customerDeliveryDraft:'+encodeURIComponent(key),JSON.stringify({version:2,text:input.value}));note.textContent='현재 브라우저에 안내 문구를 저장했습니다.';}catch(_){note.textContent='저장 공간을 사용할 수 없습니다. 입력 문구는 현재 화면에서 유지됩니다.';}}
function readCustomerMessageDraft(key){
 const raw=localStorage.getItem('customerDeliveryDraft:'+encodeURIComponent(key));if(raw===null)return customerDefaultBody();
 try{const draft=JSON.parse(raw);if(draft?.version===2&&typeof draft.text==='string')return draft.text;}catch(_){}
 // Older drafts contain only the editable intro; bring the company line into the editable body once.
 const heading=customerCompanyHeading();return raw.split(/\r?\n/).includes(heading)?raw:(raw?raw+'\n':'')+heading;
}
export function openCustomerDeliveryPage(){refreshDispatchWallet();const date=document.getElementById('customer-delivery-date'),input=document.getElementById('customer-message-input');if(!date||!input)return;if(!date.value)date.value=document.getElementById('dispatch-assign-date')?.value||getLocalDateString();const key=customerDispatchKey();if(input.dataset.owner!==key){input.dataset.owner=key;try{input.value=readCustomerMessageDraft(key);}catch(_){input.value=customerDefaultBody();}}updateCustomerMessagePreview();return refreshCustomerDeliveryList();}

export async function refreshCustomerDeliveryList(){
 if(customerSendBusy)return;
 customerPreparedBatch=null;customerSendStates.clear();
 const date=document.getElementById('customer-delivery-date')?.value,key=customerDispatchKey();if(!date||!key)return;
 const version=++customerLoadVersion;closeCustomerDialog();customerLoadState='loading';customerLoadedOrders=[];customerLoadedDate=date;customerLoadedOwner=key;customerDeliveryPage=1;customerSelectedNumbers.clear();renderCustomerDeliveryList();
 const button=document.getElementById('customer-refresh-button');if(button)button.disabled=true;
 try{const snapshot=await getDoc(doc(db,'dispatch_orders',`${date}_${key}`));if(version!==customerLoadVersion||key!==customerDispatchKey()||date!==document.getElementById('customer-delivery-date')?.value)return;const orders=snapshot.exists()?snapshot.data().orders:[];customerLoadedOrders=Array.isArray(orders)?orders:[];customerLoadState='ready';}
 catch(_){if(version===customerLoadVersion){customerLoadedOrders=[];customerLoadState='error';}}
 finally{if(version===customerLoadVersion){if(button)button.disabled=false;renderCustomerDeliveryList();await refreshCustomerSmsResults(false);}}
}
function customerPhone(value){const text=String(value||'').trim();if(!/^[+\d\s()-]+$/.test(text))return '';let digits=text.replace(/\D/g,'');if(text.startsWith('+82'))digits='0'+digits.slice(2).replace(/^0/,'');return /^010\d{8}$/.test(digits)?digits:'';}
export function groupCustomerDeliveries(orders, licenses=[]) {
    const groups=new Map();
    (orders || []).forEach((order,index)=>{
        if (!order || typeof order!=='object') return;
        const phone=customerPhone(order.phone),rawAddress=String(order.fullAddress || order.address || '').trim().replace(/\s+/g,' ');
        const storePrefix=order.storeName?'['+String(order.storeName).trim()+']':'';
        const address=storePrefix&&rawAddress.startsWith(storePrefix)?rawAddress.slice(storePrefix.length).trim():rawAddress;
        // 상세 주소까지 보존합니다. 번호/주소 누락 행은 자동 병합하지 않습니다.
        const number=/^[A-Za-z0-9]{5}$/.test(order.deliveryNumber||'')?order.deliveryNumber:'';
        const key=number?'delivery:'+number:phone && address ? JSON.stringify([phone,address]) : 'unresolved:'+index;
        if (!groups.has(key))groups.set(key,{key,deliveryNumber:number,phone,rawPhone:String(order.phone || ''),address,names:new Set(),orders:[],drivers:new Map(),sources:new Set(),unassigned:false});
        const group=groups.get(key);group.sources.add(order.customerSource||'주문서 통합관리');group.orders.push(String(order.orderNo || '주문번호 없음'));
        group.names.add(String(order.recipientName || order.customerName || order.storeName || '').trim());
        const driver=licenses.find(l=>l.key===order.assignedDriver || l.id===order.assignedDriver);
        if (order.assignedDriver) {
            const label=driver?.name || driver?.phone || order.assignedDriver;
            group.drivers.set(String(order.assignedDriver),String(label)+(order.displayNumber ? ` · ${order.displayNumber}번` : ''));
        } else group.unassigned=true;
    });
    return Array.from(groups.values());
}
// Join only the latest route owned by a driver connected to this company.
// Stable order identifiers prevent an allocated order and its driver route from counting twice.
export function buildCustomerDeliveryOrders(orders,licenses,routes,date,dispatchKey){
 const rows=(orders||[]).filter(o=>o&&typeof o==='object').map(o=>({...o,customerSource:'주문서 통합관리'}));
 const ownDrivers=(licenses||[]).filter(l=>l.type!=='dispatch'&&l.dispatchKey===dispatchKey&&l.routeOwnerId);
 const integratedCount=rows.length,matchedIndices=new Set();
 const candidates=Object.entries(routes||{}).map(([id,route])=>({...route,routeDocumentId:id}));
 let routeCount=0,added=0,matched=0;
 for(const driver of ownDrivers){
  const route=selectLatestOwnedRoute(candidates,driver.routeOwnerId);if(!route)continue;
  const plan=route.routePlan,planDay=plan?.ownerId===driver.routeOwnerId&&/^\d{4}-\d{1,2}-\d{1,2}$/.test(plan.date||'')?plan.date.split('-').map((v,i)=>i?v.padStart(2,'0'):v).join('-'):'';
  if((planDay||getLocalDateString(new Date(route.updatedAt)))!==date)continue;
  routeCount++;
  for(const destination of route.destinations||[]){
   if(!destination||typeof destination!=='object')continue;
   const no=String(destination.orderNo||'').trim();
   const matches=rows.slice(0,integratedCount).map((o,index)=>({o,index})).filter(({o})=>{
    if(String(o.assignedDriver||'')!==String(driver.key||driver.id))return false;
    const orderNo=String(o.orderNo||'').trim();
    return no&&orderNo?no===orderNo:destination.id!==undefined&&o.id!==undefined&&String(o.id)===String(destination.id);
   });
   const item={...destination,address:destination.address||'',fullAddress:destination.fullAddress||destination.address||'',phone:destination.phone||'',assignedDriver:driver.key||driver.id,customerSource:'기사 등록 경로'};
   if(matches.length===1&&!matchedIndices.has(matches[0].index)){const index=matches[0].index;matchedIndices.add(index);rows[index]={...rows[index],...item,orderNo:no||rows[index].orderNo,customerSource:'통합주문 · 기사 경로'};matched++;}
   else {rows.push(item);added++;}
  }
 }
 return {orders:rows,routeCount,added,matched};
}
function currentCustomerGroups(){
 const date=document.getElementById('customer-delivery-date')?.value,key=customerDispatchKey();
 const valid=customerLoadedOwner===key&&customerLoadedDate===date;
 const combined=valid?buildCustomerDeliveryOrders(customerLoadedOrders,state.allLicenses,state.activeRoutes,date,key):{orders:[],routeCount:0,added:0,matched:0};
 return {...combined,groups:groupCustomerDeliveries(combined.orders,(state.allLicenses||[]).filter(l=>l.dispatchKey===key&&l.type!=='dispatch'))};
}
function customerReadyPhones(groups){return new Set(groups.filter(g=>g.deliveryNumber&&g.phone&&g.address&&!g.unassigned&&g.drivers.size===1&&!['success','pending'].includes(customerSendStates.get(g.deliveryNumber))).map(g=>g.deliveryNumber));}
function customerPhoneProblem(value){const raw=String(value||'').trim(),digits=raw.replace(/\D/g,'');if(!raw)return '전화번호가 비어 있습니다.';if(/^050/.test(digits))return '050 안심번호입니다. 문자 수신 가능 여부를 확인하고 수취인의 실제 휴대폰 번호를 등록해 주세요.';if(/^(02|0[3-6][1-5]|070)/.test(digits))return '일반전화·인터넷전화 형식입니다. 현재 발송 대상은 010 휴대폰 번호만 지원합니다.';if(/[\/,;]/.test(raw))return '전화번호가 여러 개 들어 있습니다. 수취인의 휴대폰 번호 하나를 등록해 주세요.';return '010으로 시작하는 11자리 휴대폰 번호 형식이 아닙니다. 누락된 숫자나 불필요한 문자를 확인해 주세요.';}
function customerGroupProblems(group){return [['success','pending'].includes(customerSendStates.get(group.deliveryNumber))?'이미 발송했거나 결과 확인 중인 배송입니다.': '',!group.deliveryNumber?'배송번호가 아직 없습니다. 동선 전송 또는 서버 번호 부여 후 새로고침해 주세요.':'',!group.phone?customerPhoneProblem(group.rawPhone):'',!group.address?'배송지 주소가 없습니다.': '',group.unassigned?'아직 담당 기사가 배정되지 않은 주문이 있습니다.':'',group.drivers.size>1?'같은 배송지에 여러 기사가 배정되어 있습니다. 추가 방문인지 분할 배송인지 확인해 주세요.':''].filter(Boolean);}
function customerBlockReason(group,ready){if(!group.phone)return 'invalid';if(!group.address)return 'address';if(group.unassigned)return 'unassigned';if(group.drivers.size>1)return 'split';return ready.has(group.deliveryNumber)?'':'number';}
function customerPhoneFrequencies(groups){const frequencies=new Map();for(const g of groups)if(g.phone)frequencies.set(g.phone,(frequencies.get(g.phone)||0)+1);return frequencies;}
const customerSendStates=new Map();
let customerPreparedBatch=null,customerSendBusy=false;
function customerStateLabel(number){return {success:'발송 완료',failed:'발송 실패',pending:'확인 중'}[customerSendStates.get(number)]||'미발송';}
export function renderCustomerDeliveryList(){
 const tbody=document.getElementById('customer-delivery-tbody');if(!tbody)return;
 const {orders,groups,routeCount,added,matched}=currentCustomerGroups(),ready=customerReadyPhones(groups);
 const phones=new Set(groups.map(g=>g.phone).filter(Boolean));
 customerSelectedNumbers=new Set([...customerSelectedNumbers].filter(n=>ready.has(n)));
 for(const [id,value]of [['customer-order-count',orders.length],['customer-stop-count',groups.length],['customer-phone-count',phones.size],['customer-invalid-count',groups.filter(g=>!g.phone).length]])document.getElementById(id).textContent=value.toLocaleString('ko-KR');
 const sourceNote=document.getElementById('customer-source-note');if(sourceNote)sourceNote.textContent=`통합주문 ${customerLoadedOrders.length}건 + 기사 경로 추가 ${added}건 · 일치 ${matched}건 · 연결 경로 ${routeCount}개. 배송번호별로 선택하며 번호·연락처·주소·기사 배정이 있어야 발송 가능합니다.`;
 document.getElementById('customer-count-explanation').textContent=`배송 ${groups.length}건 · 발송 가능 ${ready.size}건 · 휴대폰 번호 ${phones.size}개. 동일 주소 1건 발송은 주소·수신번호가 같은 선택 배송들을 문자 한 건으로 안내합니다. 전체 발송은 배송번호마다 문자 1건(35원)입니다.`;
 const frequencies=customerPhoneFrequencies(groups),diagnosis=document.getElementById('customer-diagnosis-summary');
 if(diagnosis)diagnosis.innerHTML=[['duplicate','동일 연락처 배송',groups.filter(g=>(frequencies.get(g.phone)||0)>1).length],['blocked','발송 제외',groups.filter(g=>!ready.has(g.deliveryNumber)).length],['invalid','연락처 확인',groups.filter(g=>!g.phone).length],['unassigned','미배정',groups.filter(g=>g.unassigned).length]].map(([filter,title,count])=>`<button type="button" onclick="window.setCustomerDeliveryFilter('${filter}')"><span>${title}</span><b>${count}건</b></button>`).join('');
 const all=document.getElementById('customer-select-all');if(all){all.checked=ready.size>0&&customerSelectedNumbers.size===ready.size;all.indeterminate=customerSelectedNumbers.size>0&&customerSelectedNumbers.size<ready.size;all.disabled=!ready.size||customerSendBusy;}
 const query=String(document.getElementById('customer-delivery-search')?.value||'').trim().toLowerCase();
 document.querySelectorAll('[data-customer-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.customerFilter===customerDeliveryFilter)));
 const filtered=groups.map((g,index)=>({g,index})).filter(({g})=>{
  const f=customerDeliveryFilter,eligible=ready.has(g.deliveryNumber),reason=customerBlockReason(g,ready);
  const match=f==='all'||f==='valid'&&g.phone||f==='invalid'&&!g.phone||f==='ready'&&eligible||['check','blocked'].includes(f)&&!eligible||f==='duplicate'&&(frequencies.get(g.phone)||0)>1||f==='merged'&&g.orders.length>1||f==='selected'&&customerSelectedNumbers.has(g.deliveryNumber)||['address','unassigned','split','linked','number'].includes(f)&&f===reason;
  return match&&[g.deliveryNumber,g.address,g.rawPhone,g.phone,...g.names,...g.orders,...g.drivers.values()].join(' ').toLowerCase().includes(query);
 });
 const maxPage=Math.max(1,Math.ceil(filtered.length/50));customerDeliveryPage=Math.max(1,Math.min(customerDeliveryPage,maxPage));const start=(customerDeliveryPage-1)*50;
 tbody.innerHTML=filtered.slice(start,start+50).map(({g,index},offset)=>{
  const problems=customerGroupProblems(g),eligible=ready.has(g.deliveryNumber);
  return `<tr><td><input type="checkbox" aria-label="배송번호 ${escapeMessage(g.deliveryNumber||'미발급')} 선택" data-number="${escapeMessage(g.deliveryNumber)}" onchange="window.toggleCustomerRecipient(this.dataset.number,this.checked)" ${customerSelectedNumbers.has(g.deliveryNumber)?'checked':''} ${!eligible||customerSendBusy?'disabled':''}></td><td>${start+offset+1}</td><td>${escapeMessage([...g.names].filter(Boolean).join(', ')||'수취인')}<small>${escapeMessage(g.phone||g.rawPhone||'연락처 없음')}</small></td><td>${escapeMessage(g.address||'주소 없음')}</td><td><b>${escapeMessage(g.deliveryNumber||'미발급')}</b><small>${[...g.sources].map(escapeMessage).join(' / ')}</small></td><td>${[...g.drivers.values()].map(escapeMessage).join('<br>')||'미배정'}</td><td>${problems.length?`<button type="button" class="customer-row-tag needs-check" onclick="window.showCustomerDeliveryIssue(${index})">확인 필요 →</button>`:'발송 가능'}</td><td><span class="customer-send-state">${customerStateLabel(g.deliveryNumber)}</span></td></tr>`;
 }).join('')||`<tr><td colspan="8" class="customer-empty-cell">${customerLoadState==='loading'?'배송 목록을 불러오고 있습니다.':customerLoadState==='error'?'목록을 불러오지 못했습니다. 새로고침해 주세요.':'표시할 배송이 없습니다.'}</td></tr>`;
 document.getElementById('customer-list-status').textContent=`표시 ${filtered.length}건 · 발송 방식을 확인하세요`;
 document.getElementById('customer-page-label').textContent=`${customerDeliveryPage} / ${maxPage} 페이지`;document.getElementById('customer-page-prev').disabled=customerDeliveryPage<=1;document.getElementById('customer-page-next').disabled=customerDeliveryPage>=maxPage;updateCustomerMessagePreview();
}
export function filterCustomerDeliveries(){customerDeliveryPage=1;renderCustomerDeliveryList();}
export function changeCustomerDeliveryPage(delta){customerDeliveryPage+=delta;renderCustomerDeliveryList();}
export function setCustomerDeliveryFilter(filter){customerDeliveryFilter=filter;customerDeliveryPage=1;const search=document.getElementById('customer-delivery-search');if(search)search.value='';renderCustomerDeliveryList();}
export function toggleCustomerRecipient(number,checked){if(customerSendBusy||!customerReadyPhones(currentCustomerGroups().groups).has(number))return;if(checked)customerSelectedNumbers.add(number);else customerSelectedNumbers.delete(number);customerPreparedBatch=null;renderCustomerDeliveryList();}
export function selectAllCustomerRecipients(selected){if(customerSendBusy)return;customerSelectedNumbers=selected?customerReadyPhones(currentCustomerGroups().groups):new Set();customerPreparedBatch=null;renderCustomerDeliveryList();}
function customerSmsMode(){return document.getElementById('customer-sms-mode')?.value==='per-delivery'?'per-delivery':'per-address';}
function customerSelectedMessageGroups(){const groups=new Map();for(const stop of customerSelectedStops()){
 const key=customerSmsMode()==='per-address'?JSON.stringify([stop.phone,stop.address]):stop.deliveryNumber;
 if(!groups.has(key))groups.set(key,[]);groups.get(key).push(stop);
}return [...groups.values()];}
export function changeCustomerSmsMode(){if(customerSendBusy)return;customerPreparedBatch=null;updateCustomerMessagePreview();}
function updateCustomerSelectionSummary(){const count=customerSelectedNumbers.size,smsCount=customerSelectedMessageGroups().length,number=document.getElementById('customer-selected-count');if(number)number.textContent=count;const cost=document.getElementById('customer-selected-cost');if(cost)cost.textContent=`문자 ${smsCount}건 · 예상 ${customerMoney(smsCount*CUSTOMER_SMS_PRICE)} · 부가세 포함`;const summary=document.getElementById('customer-list-selection');if(summary)summary.textContent=`배송번호 ${count}건 선택 · 문자 ${smsCount}건 · 예상 ${customerMoney(smsCount*CUSTOMER_SMS_PRICE)}`;const button=document.getElementById('customer-review-button');if(button)button.textContent=smsCount?`문자 발송 확인 (${smsCount}건)`:'문자 발송 확인';}
function openCustomerDialog(title,html){const dialog=document.getElementById('customer-action-dialog');if(!dialog)return;customerDialogFocus=document.activeElement;document.getElementById('customer-dialog-heading').textContent=title;document.getElementById('customer-dialog-body').innerHTML=html;if(!dialog.open)dialog.showModal();}
export function closeCustomerDialog(){const dialog=document.getElementById('customer-action-dialog');if(dialog?.open){dialog.close();if(customerDialogFocus?.isConnected)customerDialogFocus.focus();}}
let customerTrackingBusy=false;
async function customerTrackingRequest(body){
 if(!auth.currentUser)throw Error('관제 계정으로 다시 로그인해 주세요.');
 const owner=customerDispatchKey(),date=document.getElementById('customer-delivery-date').value;
 const token=await auth.currentUser.getIdToken();
 const response=await fetch('/api/tracking',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({...body,dispatchKey:owner,date}),signal:AbortSignal.timeout(55000)});
 const data=await response.json();if(!response.ok)throw Error(data.error||'문자 처리 결과를 확인하지 못했습니다.');
 if(owner!==customerDispatchKey()||date!==document.getElementById('customer-delivery-date').value)throw Error('계정 또는 배송일이 변경되었습니다.');return data;
}
function customerSelectedStops(){const {groups}=currentCustomerGroups(),ready=customerReadyPhones(groups);return groups.filter(g=>customerSelectedNumbers.has(g.deliveryNumber)&&ready.has(g.deliveryNumber));}
export async function createCustomerTrackingLinks(){return reviewCustomerSend();}
export async function copyCustomerTrackingLink(button){try{await navigator.clipboard.writeText(button.dataset.trackingCopy);button.textContent='복사됨';}catch{button.textContent='위 주소를 직접 복사해 주세요';}}
export function showCustomerDeliveryIssue(index){const g=currentCustomerGroups().groups[index];if(!g)return;openCustomerDialog('발송 대상 확인',`<p>배송번호 ${escapeMessage(g.deliveryNumber||'미발급')} · ${escapeMessage(g.address)}</p><ul>${customerGroupProblems(g).map(p=>`<li>${escapeMessage(p)}</li>`).join('')}</ul><p>주문서 통합관리 또는 기사 경로에서 수정 후 새로고침해 주세요. 같은 연락처의 다른 정상 배송건은 개별 선택할 수 있습니다.</p>`);}
function rememberCustomerBatch(batch){
 const key='customerSmsBatches:'+encodeURIComponent(customerDispatchKey())+':'+batch.date;
 try{const ids=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify([...new Set([...ids,batch.batchId])].slice(-20)));}catch{}
 for(const [number,status]of Object.entries(batch.states||{}))customerSendStates.set(number,status);
}
function renderCustomerSendReview(batch){
 const hasStarted=batch.parts.some(p=>p.status!=='prepared');
 openCustomerDialog('배송번호별 문자 발송 확인',`<p><b>문자 ${batch.count}건 · 최대 ${customerMoney(batch.count*35)}</b> · 실제 성공 건만 사용 처리합니다. 실패는 복구하고 확인 중인 건은 예약 건수로 유지합니다.</p><p>선택 배송 ${batch.deliveryCount||batch.messages.flatMap(m=>m.deliveryNumbers||[m.deliveryNumber]).length}건을 문자 ${batch.count}건으로 안내합니다. 동일 주소·수신번호 묶음은 해당 배송들만 조회 링크에 표시됩니다.</p>${batch.messages.map(m=>`<dl class="customer-review-details"><dt>${escapeMessage(m.phone)} · 배송번호 ${escapeMessage((m.deliveryNumbers||[m.deliveryNumber]).join(', '))} · ${m.bytes}/80바이트</dt><dd><pre class="customer-review-message">${escapeMessage(m.content)}</pre><a href="${escapeMessage(m.url)}" target="_blank" rel="noopener noreferrer">해당 배송 조회</a> · ${customerStateLabel(m.deliveryNumber)}</dd></dl>`).join('')}<p id="customer-send-progress" role="status">${batch.parts.some(p=>['unknown','sending'].includes(p.status))?'서버 접수 결과가 불확실한 건이 있습니다. 중복 발송을 막기 위해 재발송과 자동 환불을 보류합니다. 운영사에 확인해 주세요.':hasStarted?'기존 발송 결과입니다. 확인 중인 건을 재발송하지 마세요.':'위 고객별 문구로 발송합니다. 아래 버튼을 누르면 실제 문자가 발송됩니다.'}</p><button type="button" id="customer-confirm-send" class="customer-primary-button" ${customerSendBusy?'disabled':''}>${hasStarted?'미처리 발송 계속하기':'확인한 '+batch.count+'건 실제 발송'}</button><button type="button" id="customer-status-refresh">발송 결과 확인</button>`);
 document.getElementById('customer-confirm-send').onclick=sendPreparedCustomerSms;
 document.getElementById('customer-status-refresh').onclick=refreshCustomerSmsResults;
}
export async function reviewCustomerSend(){
 if(customerTrackingBusy||customerSendBusy)return;
 const stops=customerSelectedStops();if(customerLoadState!=='ready'||!stops.length){openCustomerDialog('발송 대상을 선택해 주세요','<p>배송번호·연락처·주소·기사 배정이 확인된 배송건을 선택하세요.</p>');return;}
 const size=measureCustomerSms(customerMessage());if(size.bytes>80||size.unsupported){openCustomerDialog('문구 확인 필요','<p>배송번호와 전용 링크를 포함해 80바이트 이내로 수정해 주세요. 지원하지 않는 문자는 사용할 수 없습니다.</p>');return;}
 customerTrackingBusy=true;customerPreparedBatch=null;openCustomerDialog('문자 준비 중','<p>고객별 배송번호와 실제 전용 링크를 확인하고 있습니다.</p>');
 try{
  const batch=await customerTrackingRequest({action:'prepare-sms',smsMode:customerSmsMode(),requestId:crypto.randomUUID(),phones:[...new Set(stops.map(g=>g.phone))],deliveryNumbers:stops.map(g=>g.deliveryNumber),message:document.getElementById('customer-message-input').value});
  customerPreparedBatch=batch;rememberCustomerBatch(batch);renderCustomerSendReview(batch);
 }catch(e){openCustomerDialog('문자 준비 확인 필요',`<p>${escapeMessage(e.message)}</p>`);}finally{customerTrackingBusy=false;}
}
async function sendPreparedCustomerSms(){
 if(customerSendBusy||!customerPreparedBatch)return;
 const owner=customerDispatchKey(),date=customerPreparedBatch.date,batchId=customerPreparedBatch.batchId;let failed=false;
 customerSendBusy=true;for(const id of ['customer-delivery-date','customer-refresh-button','customer-sms-mode']){const el=document.getElementById(id);if(el)el.disabled=true;}const button=document.getElementById('customer-confirm-send');if(button)button.disabled=true;
 try{
  for(let part=0;part<customerPreparedBatch.parts.length;part++){
   if(customerPreparedBatch.parts[part].status!=='prepared')continue;
   if(owner!==customerDispatchKey()||date!==document.getElementById('customer-delivery-date').value)throw Error('계정 또는 배송일이 변경되어 남은 발송을 중단했습니다.');
   const progress=document.getElementById('customer-send-progress');if(progress)progress.textContent=`모래시계 · 발송 처리 중 ${part+1}/${customerPreparedBatch.parts.length}. 창을 닫아도 결과 확인 후 다시 진행해 주세요.`;
   customerPreparedBatch=await customerTrackingRequest({action:'send-sms',batchId,part,confirm:true});rememberCustomerBatch(customerPreparedBatch);
  }
  await refreshCustomerSmsResults();
 }catch(e){failed=true;openCustomerDialog('발송 결과 확인 필요',`<p>${escapeMessage(e.message)}</p><p>이미 접수된 문자가 있을 수 있습니다. 재발송하지 말고 발송 결과 확인을 눌러 주세요.</p><button type="button" id="customer-recover-status">발송 결과 확인</button>`);document.getElementById('customer-recover-status').onclick=refreshCustomerSmsResults;}
 finally{customerSendBusy=false;for(const id of ['customer-delivery-date','customer-refresh-button','customer-sms-mode']){const el=document.getElementById(id);if(el)el.disabled=false;}if(!failed&&customerPreparedBatch&&owner===customerDispatchKey())renderCustomerSendReview(customerPreparedBatch);renderCustomerDeliveryList();refreshDispatchWallet();}
}
export async function refreshCustomerSmsResults(showDialog=true){
 const key='customerSmsBatches:'+encodeURIComponent(customerDispatchKey())+':'+document.getElementById('customer-delivery-date').value;
 let ids=[];try{ids=JSON.parse(localStorage.getItem(key)||'[]');}catch{}
 try{
  const numbers=currentCustomerGroups().groups.map(g=>g.deliveryNumber).filter(Boolean);
  if(numbers.length){const receipts=await customerTrackingRequest({action:'sms-receipts',deliveryNumbers:numbers});
   for(const [number,status]of Object.entries(receipts.states||{}))customerSendStates.set(number,status);
   ids=[...new Set([...ids,...receipts.batchIds])];}
 }catch(e){const p=document.getElementById('customer-send-progress');if(p)p.textContent=e.message;}
 for(const batchId of ids){try{
  let batch=await customerTrackingRequest({action:'sms-status',batchId});
  for(let part=0;part<batch.parts.length;part++)if(batch.parts[part].status==='accepted')batch=await customerTrackingRequest({action:'sms-status',batchId,part});
  rememberCustomerBatch(batch);if(!customerPreparedBatch||customerPreparedBatch.batchId===batchId)customerPreparedBatch=batch;
 }catch(e){const p=document.getElementById('customer-send-progress');if(p)p.textContent=e.message;}}
 renderCustomerDeliveryList();if(showDialog&&customerPreparedBatch&&!customerSendBusy)renderCustomerSendReview(customerPreparedBatch);refreshDispatchWallet();
}
export function openCustomerContactGuide(){openCustomerDialog('배송 문의번호 운영 안내','<p><b>배송 문의는 각 배송업체 대표번호로 연결하는 방식을 권합니다.</b> 기사 개인번호는 노출하지 않고, 배송조회 화면 아래에 업체명·문의번호·응대시간을 안내합니다.</p><p>문자에는 짧은 조회 안내를 유지하고, 문의번호는 조회 화면에 표시하면 단문 입력 공간도 확보할 수 있습니다.</p><p class="customer-dialog-note">050 안심번호는 번호 보호·연결 서비스이고, 자동응답(ARS)은 별도 기능입니다. 필요할 때 업체별 문의 분배·응대시간 안내를 검토하되, SMS 발신번호로 사용할 수 있는지는 번호 상품과 SENS 등록 조건을 별도로 확인해야 합니다.</p>');}
export function setDispatchBillingTab(tab){renderDispatchAccount('BILLING');document.getElementById(tab==='sms'?'dispatch-billing-sms':'dispatch-billing-service')?.scrollIntoView({block:'start'});}
export function changeDispatchBilling(field,value){
 if(field==='plan')customerBilling.plan=value==='pro'?'pro':'basic';
 if(field==='period'){customerBilling.period=value==='yearly'?'yearly':'monthly';if(customerBilling.period!=='yearly')customerBilling.drivers=false;}
 if(field==='drivers')customerBilling.drivers=customerBilling.period==='yearly'&&value===true;
 if(field==='seats')customerBilling.seats=Number(value);
 if(field==='slotPacks')customerBilling.slotPacks=Number(value);
 if(field==='extraPcs')customerBilling.extraPcs=Number(value);
 if(field==='extensionPacks')customerBilling.extensionPacks=Number(value);
 if(field==='extensionPcs')customerBilling.extensionPcs=Number(value);
 if(field==='smsCount')customerBilling.smsCount=Number(value);
 updateDispatchBillingQuote();
 updateCustomerExtensionQuote();
}
export function customerSmsQuote(count){
 if(!Number.isSafeInteger(count)||count<100||count>100000)return {error:'충전 건수는 100~100,000 사이의 정수로 입력해 주세요.'};
 const discount=count>=10000?10:count>=5000?5:0,original=count*CUSTOMER_SMS_PRICE,total=Math.round(original*(100-discount)/100);
 return {count,discount,original,total};
}
function customerDateOnly(value){
 const text=String(value||'').replace(/\./g,'-'),match=text.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!match)return '';
 const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));
 return date.toISOString().slice(0,10)===text?text:'';
}
function customerShiftDay(day,amount){const date=new Date(day+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+amount);return date.toISOString().slice(0,10);}
function customerAddMonths(day,months){
 const date=new Date(day+'T00:00:00Z'),originalDay=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+months);
 const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(originalDay,last));return date.toISOString().slice(0,10);
}
export function customerContractPeriod(account,period,today=getLocalDateString()){
 const day=customerDateOnly(today),expiry=customerDateOnly(customerAccountExpiry(account));if(!day)return {error:'계약 시작일을 확인할 수 없습니다.'};
 const months=period==='yearly'?12:1,renewal=!!expiry&&expiry>=day;
 return {start:renewal?customerShiftDay(expiry,1):day,end:renewal?customerAddMonths(expiry,months):customerShiftDay(customerAddMonths(day,months),-1),months,renewal,existingExpiry:expiry};
}
export function customerExtensionQuote(account,packs,pcs,today=getLocalDateString()){
 if(!Number.isSafeInteger(packs)||packs<0||packs>200||!Number.isSafeInteger(pcs)||pcs<0||pcs>49)return {error:'증설 수량은 허용 범위의 정수로 입력해 주세요.'};
 if(!packs&&!pcs)return {error:'추가할 기사 회선 또는 PC 수량을 선택해 주세요.'};
 const day=customerDateOnly(today),expiry=customerDateOnly(customerAccountExpiry(account));
 if(!day||!expiry||expiry<day||['expired','revoked','suspended'].includes(account?.status))return {error:'이용 중인 관제 계정과 사용기한을 먼저 확인해 주세요. 만료된 계정은 계약 갱신 견적을 이용하세요.'};
 const slots=Number(account?.maxSlots),basePcs=Number(account?.maxSessions)>0?Number(account.maxSessions):(account?.isPro?2:1);
 if(packs&&(account?.maxSlots===undefined||!Number.isSafeInteger(slots)||slots<=0))return {error:slots===0&&account?.maxSlots!==undefined?'현재 기사 연결이 무제한으로 설정되어 있습니다. 기사 회선 증설 필요 여부를 관리자에게 확인해 주세요.':'현재 기사 연결 허용량을 확인한 뒤 증설할 수 있습니다.'};
 if(basePcs+pcs>50)return {error:'PC 동시접속 허용량은 최대 50대까지 설정할 수 있습니다.'};
 return {packs,pcs,start:day,end:expiry,monthlyDelta:packs*20000+pcs*30000,maxSlots:slots>0?slots+packs*5:null,maxSessions:basePcs+pcs,total:null};
}
export function dispatchBillingQuote(kind='service',selection=customerBilling){
 if(kind==='sms'){
  const price=customerSmsQuote(customerBilling.smsCount);if(price.error)return price;
  const lines=[['문자 충전',price.count.toLocaleString('ko-KR')+'건 × 35원',price.original]];
  if(price.discount)lines.push(['대량 충전 할인',price.discount+'% 할인',price.total-price.original]);
  return {...price,label:'배송안내 문자 '+price.count.toLocaleString('ko-KR')+'건',lines};
 }
 const yearly=selection.period==='yearly',months=yearly?12:1,basePcs=selection.plan==='pro'?2:1;
 const monthly=selection.plan==='pro'?(yearly?148500:165000):(yearly?49500:55000);
 const lines=[[selection.plan==='pro'?'PRO 관제':'기본 관제',months+'개월 · 기본 10회선 / PC '+basePcs+'대 · 월 환산 '+customerMoney(monthly),monthly*months]];
 if(!Number.isSafeInteger(selection.slotPacks)||selection.slotPacks<0||selection.slotPacks>200)return {error:'추가 기사 회선은 5회선 단위로 최대 1,000회선까지 선택해 주세요.'};
 if(!Number.isSafeInteger(selection.extraPcs)||selection.extraPcs<0||selection.extraPcs+basePcs>50)return {error:'총 PC 동시접속 허용량은 50대 이내로 입력해 주세요.'};
 if(selection.slotPacks)lines.push(['기사 연결 회선 추가',selection.slotPacks*5+'회선 추가 · 월 '+customerMoney(selection.slotPacks*20000)+' × '+months+'개월',selection.slotPacks*20000*months]);
 if(selection.extraPcs)lines.push(['PC 동시접속 추가',selection.extraPcs+'대 추가 · 월 '+customerMoney(selection.extraPcs*30000)+' × '+months+'개월',selection.extraPcs*30000*months]);
 if(selection.drivers){
  if(!yearly)return {error:'기사용 라이선스 할인 구매는 1년 약정 선택 시에만 가능합니다.'};
  if(!Number.isSafeInteger(selection.seats)||selection.seats<5||selection.seats>1000)return {error:'기사용 라이선스는 최소 5개부터 1,000개까지 정수로 입력해 주세요.'};
  lines.push(['기사용 라이선스',selection.seats+'개 × 7,700원 × '+months+'개월',selection.seats*7700*months]);
 }
 const total=lines.reduce((sum,line)=>sum+line[2],0),maxSlots=10+selection.slotPacks*5,maxSessions=basePcs+selection.extraPcs;
 return {total,monthlyTotal:total/months,label:(selection.plan==='pro'?'PRO':'기본')+' 관제 · '+maxSlots+'회선 · PC '+maxSessions+'대',lines,yearly,isPro:selection.plan==='pro',maxSlots,maxSessions,period:customerContractPeriod(customerAccount(),selection.period)};
}
function customerProductSelection(plan){
 if(!customerProductSelections[plan]){
  const account=customerAccount(),current=!!account&&(account.isPro?'pro':'basic')===plan,slots=Number(account?.maxSlots),basePcs=plan==='pro'?2:1;
  customerProductSelections[plan]={plan,period:'monthly',drivers:false,seats:5,slotPacks:current&&Number.isSafeInteger(slots)&&slots>10&&slots%5===0?(slots-10)/5:0,extraPcs:current?Math.max(0,(Number(account?.maxSessions)||basePcs)-basePcs):0};
 }
 return customerProductSelections[plan];
}
export function changeDispatchProduct(plan,field,value){
 if(!['basic','pro'].includes(plan))return;
 const selection=customerProductSelection(plan);
 if(field==='slots')selection.slotPacks=Number(value)/5;
 if(field==='pcs')selection.extraPcs=Number(value);
 if(field==='period'){selection.period=value==='yearly'?'yearly':'monthly';if(selection.period==='monthly')selection.drivers=false;}
 if(field==='drivers')selection.drivers=selection.period==='yearly'&&value===true;
 if(field==='seats')selection.seats=Number(value);
 updateCustomerProduct(plan);
}
function customerProductCard(plan){
 const selection=customerProductSelection(plan),pro=plan==='pro',basePcs=pro?2:1,account=customerAccount(),current=account&&(account.isPro?'pro':'basic')===plan;
 return `<article class="dispatch-product ${pro?'is-pro':''}" id="dispatch-product-${plan}" aria-labelledby="dispatch-product-title-${plan}">
  <div class="dispatch-product-heading"><div><span class="dispatch-product-eyebrow">${pro?'AUTOMATION':'STANDARD'}</span><h3 id="dispatch-product-title-${plan}">${pro?'PRO':'기본'} 관제</h3></div>${current?'<span class="dispatch-product-current">현재 이용 상품</span>':''}</div>
  <p class="dispatch-product-description">${pro?'주문 수집부터 자동할당까지 배송 업무를 통합 관리합니다.':'기사의 배송 진행을 한눈에 확인하고 현장을 관리합니다.'}</p>
  <div class="dispatch-product-price">${customerMoney(pro?165000:55000)}<small>/ 월 · 부가세 포함</small></div>
  <ul class="dispatch-product-features">${(pro?['기본 관제 기능 전체','자동할당','주문서 통합관리']:['배송관리','기사 메시지','위치확인','데이터 추출']).map(text=>`<li><i class="fa-solid fa-check"></i>${text}</li>`).join('')}</ul>
  <div class="dispatch-product-resource"><div><strong>기사 연결 <b>10회선</b> 기본 포함</strong><label for="dispatch-product-slots-${plan}">추가하기</label><select id="dispatch-product-slots-${plan}" onchange="window.changeDispatchProduct('${plan}','slots',this.value)">${Array.from({length:201},(_,i)=>`<option value="${i*5}" ${selection.slotPacks===i?'selected':''}>${i?i*5+'회선 추가':'추가 없음'}</option>`).join('')}</select></div><p id="dispatch-product-slot-fee-${plan}"></p></div>
  <div class="dispatch-product-resource"><div><strong>PC <b>${basePcs}대</b> 기본 포함</strong><label for="dispatch-product-pcs-${plan}">추가하기</label><select id="dispatch-product-pcs-${plan}" onchange="window.changeDispatchProduct('${plan}','pcs',this.value)">${Array.from({length:51-basePcs},(_,i)=>`<option value="${i}" ${selection.extraPcs===i?'selected':''}>${i?i+'대 추가':'추가 없음'}</option>`).join('')}</select></div><p id="dispatch-product-pc-fee-${plan}"></p></div>
  <label class="dispatch-product-period" for="dispatch-product-period-${plan}"><span>이용기간</span><select id="dispatch-product-period-${plan}" onchange="window.changeDispatchProduct('${plan}','period',this.value)"><option value="monthly" ${selection.period==='monthly'?'selected':''}>1개월 이용</option><option value="yearly" ${selection.period==='yearly'?'selected':''}>1년 선납 · 관제 기본료 10% 할인 제안</option></select></label>
  <details class="dispatch-product-drivers"><summary>기사용 라이선스 함께 구매하기</summary><label><input type="checkbox" id="dispatch-product-drivers-${plan}" ${selection.drivers?'checked':''} onchange="window.changeDispatchProduct('${plan}','drivers',this.checked)"> 기사용 라이선스 함께 구매하기</label><label class="billing-field" for="dispatch-product-seats-${plan}">필요 계정 수<input type="number" id="dispatch-product-seats-${plan}" min="5" max="1000" step="1" value="${selection.seats}" oninput="window.changeDispatchProduct('${plan}','seats',this.value)"></label><p>1년 약정 선택 시 구매 가능 · 최소 5계정 · 계정당 월 7,700원. 기사 연결 회선과 별도입니다.</p></details>
  <div class="dispatch-product-checkout" id="dispatch-product-quote-${plan}" aria-live="polite"></div>
  <button type="button" class="customer-primary-button dispatch-product-review" id="dispatch-product-review-${plan}" onclick="window.reviewDispatchBilling('service','${plan}')">${pro?'PRO':'기본'} 관제 구성 확인</button>
  <p class="dispatch-product-note">관제·추가 회선·PC를 같은 이용기간으로 합산합니다. 현재는 구성·금액 확인 단계이며 실제 결제는 진행되지 않습니다.</p>
 </article>`;
}
function updateCustomerProduct(plan){
 const box=document.getElementById('dispatch-product-quote-'+plan);if(!box)return;
 const selection=customerProductSelection(plan),quote=dispatchBillingQuote('service',selection),button=document.getElementById('dispatch-product-review-'+plan);
 const drivers=document.getElementById('dispatch-product-drivers-'+plan),seats=document.getElementById('dispatch-product-seats-'+plan);
 if(drivers){drivers.disabled=selection.period!=='yearly';drivers.checked=selection.drivers;}if(seats)seats.disabled=!selection.drivers||selection.period!=='yearly';
 document.getElementById('dispatch-product-slot-fee-'+plan).textContent=selection.slotPacks?`총 ${10+selection.slotPacks*5}회선 · 추가 월요금 ${customerMoney(selection.slotPacks*20000)} (5회선당 월 20,000원)`:'추가 요금 없음 · 5회선 추가마다 월 20,000원';
 document.getElementById('dispatch-product-pc-fee-'+plan).textContent=selection.extraPcs?`총 ${(plan==='pro'?2:1)+selection.extraPcs}대 · 추가 월요금 ${customerMoney(selection.extraPcs*30000)} (1대당 월 30,000원)`:'추가 요금 없음 · PC 1대 추가마다 월 30,000원';
 if(quote.error){box.innerHTML=`<p class="customer-error">${escapeMessage(quote.error)}</p>`;button.disabled=true;return;}
 box.innerHTML=`<div class="dispatch-product-total"><span>${quote.yearly?'1년':'1개월'} 이용 합계</span><strong>${customerMoney(quote.total)}</strong></div><div class="dispatch-product-capacity"><span>기사 ${quote.maxSlots}회선</span><span>PC 동시접속 ${quote.maxSessions}대</span></div><p>월 환산 ${customerMoney(quote.monthlyTotal)} · 부가세 포함</p><p class="dispatch-product-dates">${escapeMessage(quote.period.start||'기간 확인 필요')} ~ ${escapeMessage(quote.period.end||'기간 확인 필요')}</p><small>계약기간의 총액을 한 번 납부합니다. ${quote.period.renewal?'현재 사용기한 다음 날부터의 갱신 견적입니다.':'오늘 시작하는 참고 견적입니다.'} 연 선납 할인은 계약 확정 후 적용하며 추가 회선·PC 요금에는 중복 적용하지 않습니다.</small>`;
 button.disabled=false;
}
function updateDispatchBillingQuote(){
 updateCustomerProduct('basic');updateCustomerProduct('pro');
 const drivers=document.getElementById('dispatch-billing-drivers');if(drivers){drivers.disabled=customerBilling.period!=='yearly';drivers.checked=customerBilling.drivers;}
 const seats=document.getElementById('dispatch-billing-seats');if(seats)seats.disabled=!customerBilling.drivers||customerBilling.period!=='yearly';
 document.querySelectorAll('[data-sms-pack]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.smsPack)===customerBilling.smsCount)));
 for(const kind of ['service','sms']){
  const box=document.getElementById('dispatch-billing-quote-'+kind);if(!box)continue;
  const quote=dispatchBillingQuote(kind),button=document.getElementById('dispatch-billing-review-'+kind);
  if(quote.error){box.innerHTML=`<p class="customer-error">${escapeMessage(quote.error)}</p>`;if(button)button.disabled=true;continue;}
  box.innerHTML=`${quote.lines.map(([name,detail,amount])=>`<div class="billing-quote-line"><span>${escapeMessage(name)}<small>${escapeMessage(detail)}</small></span><b>${customerMoney(amount)}</b></div>`).join('')}<div class="billing-quote-total"><span>${kind==='service'?'이번 계약 합계 · 한 번 납부':'총 결제 예정금액'}</span><strong>${customerMoney(quote.total)}</strong></div>${kind==='service'?`<div class="billing-contract-summary"><b>${escapeMessage(quote.label)}</b><p>월 환산 합계 ${customerMoney(quote.monthlyTotal)}</p><p>공통 이용기간 ${escapeMessage(quote.period.start||'확인 필요')} ~ ${escapeMessage(quote.period.end||'확인 필요')}</p><small>${quote.period.renewal?'현재 사용기한 다음 날부터 갱신하는 참고 견적입니다.':'오늘 시작하는 신규·재이용 참고 견적입니다.'} 실제 계약기간은 관리자 확인 후 확정합니다.</small></div>`:''}<p>공급가액 ${customerMoney(Math.round(quote.total/1.1))} + 부가세 ${customerMoney(quote.total-Math.round(quote.total/1.1))}</p>`;
  if(button)button.disabled=false;
 }
}
export function reviewDispatchBilling(kind='service',plan=null){
 const selection=kind==='service'?{...customerProductSelection(plan||'basic')}:{count:customerBilling.smsCount};
 const quote=dispatchBillingQuote(kind,selection);if(quote.error)return;
 openCustomerDialog(kind==='sms'?'문자 충전금액 확인':'관제 계약금액 확인',`<dl class="customer-review-details"><dt>선택 상품</dt><dd>${escapeMessage(quote.label)}</dd>${quote.lines.map(([name,detail,amount])=>`<dt>${escapeMessage(name)}</dt><dd>${escapeMessage(detail)} · ${customerMoney(amount)}</dd>`).join('')}<dt>결제 예정금액</dt><dd><b>${customerMoney(quote.total)}</b> · 부가세 포함</dd></dl><p>테스트 결제는 실제 문자 잔액과 이용권에 반영되지 않습니다. 사용 중인 계약의 구성 변경과 기사 라이선스 일괄 구매는 관리자 계약 확인 후 진행합니다.</p><button type="button" id="dispatch-checkout-start" class="customer-primary-button">결제수단 선택하기</button>`);
 document.getElementById('dispatch-checkout-start').onclick=()=>startDispatchCheckout({kind,...selection});
}
function updateCustomerExtensionQuote(){
 const box=document.getElementById('dispatch-extension-quote'),button=document.getElementById('dispatch-extension-review');if(!box)return;
 const quote=customerExtensionQuote(customerAccount(),customerBilling.extensionPacks,customerBilling.extensionPcs);
 if(quote.error){box.innerHTML=`<p class="customer-help">${escapeMessage(quote.error)}</p>`;if(button)button.disabled=true;return;}
 box.innerHTML=`<dl class="customer-review-details"><dt>변경 후 용량</dt><dd>기사 ${quote.maxSlots===null?'현재 설정 유지':quote.maxSlots+'회선'} · PC ${quote.maxSessions}대</dd><dt>추가 월요금</dt><dd>${customerMoney(quote.monthlyDelta)} · 부가세 포함</dd><dt>종료일 유지</dt><dd>${quote.end}</dd><dt>이번 추가 납부금액</dt><dd>남은 계약기간 기준으로 관리자 확인 후 안내</dd></dl>`;
 if(button)button.disabled=false;
}
export function reviewCustomerExtension(){
 const quote=customerExtensionQuote(customerAccount(),customerBilling.extensionPacks,customerBilling.extensionPcs);if(quote.error){updateCustomerExtensionQuote();return;}
 openCustomerDialog('계약 중 증설 상담 내용 확인',`<div class="customer-review-alert">상담 전 확인 화면입니다. 증설 요청 전송·결제·권한 변경은 진행되지 않습니다.</div><dl class="customer-review-details"><dt>관제 계정</dt><dd>${escapeMessage(customerDispatchKey())}</dd><dt>추가 수량</dt><dd>기사 ${quote.packs*5}회선 · PC ${quote.pcs}대</dd><dt>변경 후 용량</dt><dd>기사 ${quote.maxSlots===null?'현재 설정 유지':quote.maxSlots+'회선'} · PC ${quote.maxSessions}대</dd><dt>추가 월요금</dt><dd>${customerMoney(quote.monthlyDelta)} · 부가세 포함</dd><dt>적용 종료일</dt><dd>${quote.end} · 현재 관제 사용기한과 동일</dd><dt>이번 납부금액</dt><dd>남은 기간과 부분월 산정 방식을 관리자 확인 후 확정</dd></dl><ol class="billing-manual-steps"><li>추가 수량과 적용 기간 상담</li><li>남은 계약기간의 추가 금액 안내</li><li>입금 확인 후 마스터에서 허용량 변경</li></ol><p class="customer-dialog-note">다음 계약 갱신부터 증설된 전체 구성을 합산해 납부합니다. 별도 사용기한을 만들지 않습니다. 현재 화면에서는 상담 요청이 발송되지 않습니다.</p>`);
}
function customerAccountExpiry(account){if(account?.expireDate)return account.expireDate;if(account?.expiresAt){const stamp=typeof account.expiresAt.toMillis==='function'?account.expiresAt.toMillis():Number(account.expiresAt);if(Number.isFinite(stamp))return getLocalDateString(new Date(stamp));}return '미등록';}
function customerBillingOptions(){return `<h3>배송안내 문자 충전</h3><p class="billing-intro">기본료 없이 성공 건당 35원 · 배송조회 포함</p><div class="billing-wallet"><span>현재 잔여 발송 건수</span><strong data-dispatch-balance>조회 중</strong><small data-dispatch-test-balance>테스트 건수는 실제 발송에 사용할 수 없습니다.</small></div><div class="sms-pack-grid">${[1000,3000,5000,10000].map(count=>`<button type="button" data-sms-pack="${count}" onclick="window.chooseCustomerSmsPack(${count})"><b>${count.toLocaleString('ko-KR')}건</b><span>${customerMoney(customerSmsQuote(count).total)}</span><small>${customerSmsQuote(count).discount?customerSmsQuote(count).discount+'% 할인':'기본가'}</small></button>`).join('')}</div><label class="billing-field">직접 충전 건수 입력<input type="number" id="dispatch-sms-count" min="100" max="100000" step="1" value="${customerBilling.smsCount}" oninput="window.changeDispatchBilling('smsCount',this.value)"></label><p class="customer-help">5,000~9,999건 5% · 10,000건 이상 10% 할인. 입력한 전체 건수에 적용하며 원 단위 반올림합니다. 충전 건수는 그대로 지급합니다.</p><ul class="billing-terms"><li>동일 주소 1건 발송 또는 배송건수 전체 발송을 선택합니다. 최종 확인의 문자 건수로 차감합니다.</li><li>발송 결과가 확인 중인 건은 예약 건수로 구분합니다.</li><li>최종 실패 건은 결과 확인 시 예약을 해제하고 사용 가능 건수로 복구합니다.</li></ul>`;}
function customerContractExtensionPanel(){return `<details class="billing-contract-extension"><summary>이용 중 회선·PC 증설이 필요한 경우</summary><p>현재 계약은 유지하고 필요한 용량만 추가합니다. 종료일은 현재 사용기한과 같습니다. 남은 기간의 납부금액은 관리자와 확인합니다.</p><label class="billing-field" for="dispatch-extension-packs">기사 연결 추가하기<select id="dispatch-extension-packs" onchange="window.changeDispatchBilling('extensionPacks',Number(this.value)/5)">${Array.from({length:201},(_,i)=>`<option value="${i*5}" ${customerBilling.extensionPacks===i?'selected':''}>${i?i*5+'회선 추가':'추가 없음'}</option>`).join('')}</select></label><p class="customer-help">5회선 추가마다 월 20,000원</p><label class="billing-field" for="dispatch-extension-pcs">PC 추가하기<select id="dispatch-extension-pcs" onchange="window.changeDispatchBilling('extensionPcs',this.value)">${Array.from({length:50},(_,i)=>`<option value="${i}" ${customerBilling.extensionPcs===i?'selected':''}>${i?i+'대 추가':'추가 없음'}</option>`).join('')}</select></label><p class="customer-help">PC 1대 추가마다 월 30,000원</p><div id="dispatch-extension-quote" aria-live="polite"></div><button type="button" id="dispatch-extension-review" onclick="window.reviewCustomerExtension()">증설 상담 내용 확인</button><p class="customer-help">금액 안내 → 입금 확인 → 마스터 설정 반영. 다음 계약 갱신부터 전체 구성을 합산합니다.</p></details>`;}
function customerCapacityInfo(account){
 const basePcs=account?.isPro?2:1,slots=Number(account?.maxSlots);
 return {basePcs,slots:account?.maxSlots===undefined||!Number.isFinite(slots)?'미등록':slots===0?'무제한':slots+'회선',pcs:Number(account?.maxSessions)>0?Number(account.maxSessions):basePcs};
}
export function renderDispatchAccount(mode='ACCOUNT'){
 queueMicrotask(()=>refreshDispatchWallet());
 const account=customerAccount(),expiry=customerAccountExpiry(account),key=customerDispatchKey(),label=document.getElementById('dispatch-expiry-label');if(label)label.textContent=`사용기한 ${expiry}`;
 const container=document.getElementById('dispatch-account-content');if(!container)return;if(customerBilling.owner!==key){customerProductSelections.basic=null;customerProductSelections.pro=null;Object.assign(customerBilling,{owner:key,initialized:false,plan:'basic',period:'monthly',drivers:false,seats:5,slotPacks:0,extraPcs:0,extensionPacks:0,extensionPcs:0,smsCount:1000});}const billing=mode==='BILLING',signature=JSON.stringify([mode,key,account?.companyName,account?.name,expiry,account?.isPro,account?.status,account?.maxSlots,account?.maxSessions,(state.allLicenses||[]).filter(l=>l.dispatchKey===key&&l.type!=='dispatch').length]);if(container.dataset.renderKey===signature)return;container.dataset.renderKey=signature;
 document.getElementById('dispatch-account-heading').textContent=billing?'결제·문자 충전':'이용정보';document.getElementById('dispatch-account-description').textContent=billing?'관제 이용료와 문자 충전을 구분해서 선택하고 금액을 확인하세요. 모든 금액은 부가세 포함입니다.':'현재 관제 등급·사용기한·연결 기사 현황을 확인하세요.';const modeLabel=document.getElementById('dispatch-account-mode-label');if(modeLabel)modeLabel.textContent=billing?'관제 이용료 · 문자 충전':'현재 계정';
 const connected=(state.allLicenses||[]).filter(l=>l.dispatchKey===key&&l.type!=='dispatch'),capacity=customerCapacityInfo(account);
 if(!billing){container.innerHTML=`<div class="account-info-grid">${[['관제 등급',account?account.isPro?'PRO 관제':'기본 관제':'확인 중',account?.isPro?'기본 기능 + 자동할당·주문서 통합관리':'배송관리·기사 메시지·위치확인·데이터 추출'],['사용기한',expiry,'현재 계정에 등록된 사용기한입니다.'],['연결 기사',connected.length+'명','현재 허용량 '+capacity.slots+' · 계약 기본 10회선']].map(([title,value,detail])=>`<article class="service-card"><h3>${title}</h3><strong>${escapeMessage(value)}</strong><p>${escapeMessage(detail)}</p></article>`).join('')}</div><article class="service-card account-detail-card"><h3>회사·계정 정보</h3><dl class="customer-review-details"><dt>업체명</dt><dd>${escapeMessage(account?.companyName||account?.name||'미등록')}</dd><dt>관제 계정</dt><dd>${escapeMessage(key||'확인 중')}</dd><dt>상태</dt><dd>${escapeMessage(account?({active:'이용 중',suspended:'사용 정지',expired:'기간 만료',revoked:'회수됨'}[account.status]||'확인 필요'):'확인 중')}</dd><dt>기사 연결 허용량</dt><dd>${escapeMessage(capacity.slots)} (현재 저장 설정)</dd><dt>PC 동시접속 허용</dt><dd>${capacity.pcs}대 (현재 저장 설정)</dd><dt>요금제 기본 제공</dt><dd>기사 연결 10회선 · PC ${capacity.basePcs}대</dd><dt>계약·납부 정보</dt><dd>계약·결제 기록 서버 연결 후 표시</dd><dt>문자 잔여 건수</dt><dd data-dispatch-balance>조회 중</dd></dl><div class="account-action-row"><button type="button" onclick="window.setDispatchMode('BILLING')">이용료·요금 확인</button><button type="button" onclick="window.setDispatchMode('BILLING');window.setDispatchBillingTab('sms')">문자 충전</button></div></article><article class="service-card account-capacity-guide"><h3>회선·PC 이용요금 안내</h3><div class="account-capacity-grid"><div><b>기사 연결 회선</b><p>기본·PRO 모두 10회선 포함<br>5회선 추가마다 월 20,000원</p></div><div><b>관제 PC 동시접속</b><p>기본 관제 1대 / PRO 2대 포함<br>추가 PC 1대마다 월 30,000원</p></div></div><p class="customer-help">관제·기사 회선·PC 추가를 한 계약으로 관리하고 갱신 시 합산 납부합니다. 계약 중 증설은 기존 종료일까지의 금액 안내·입금 확인 후 마스터가 반영합니다. 문자 충전과 기사용 라이선스는 별도 항목입니다. 모든 요금은 부가세 포함이며 현재 화면에서는 권한을 변경하지 않습니다.</p></article>`;return;}
 if(!customerBilling.initialized&&account){customerBilling.plan=account.isPro?'pro':'basic';const slots=Number(account.maxSlots);customerBilling.slotPacks=Number.isSafeInteger(slots)&&slots>10&&slots%5===0?(slots-10)/5:0;customerBilling.extraPcs=Math.max(0,(Number(account.maxSessions)||(account.isPro?2:1))-(account.isPro?2:1));customerBilling.initialized=true;}
 container.innerHTML=`<section id="dispatch-billing-service" class="billing-page-section" aria-label="관제 상품 선택"><div class="dispatch-products-intro"><h3>관제 상품 선택</h3><p>상품별로 필요한 기사 회선과 PC를 선택하세요. 각 상품 안에서 총액과 이용기간을 확인할 수 있습니다.</p><small>현재 이용 상품은 저장된 허용량을 참고해 불러옵니다. 실제 계약 내용은 관리자 확인 후 확정합니다.</small></div><div class="dispatch-products-grid">${customerProductCard('basic')}${customerProductCard('pro')}</div><article class="service-card billing-extension-card">${customerContractExtensionPanel()}</article></section><section id="dispatch-billing-sms" class="billing-page-section" aria-label="문자 충전"><h3 class="billing-section-heading">문자 충전</h3><div class="billing-layout"><article class="service-card billing-options">${customerBillingOptions()}</article><aside class="service-card billing-checkout"><h3>충전 금액 확인</h3><div id="dispatch-billing-quote-sms"></div><p class="billing-checkout-note">문자 충전은 관제 상품과 별도로 결제합니다. 서버 승인 후 잔여 건수에 반영됩니다.</p><button type="button" id="dispatch-billing-review-sms" class="customer-primary-button" onclick="window.reviewDispatchBilling('sms')">충전금액 확인</button></aside></div></section><article class="service-card billing-history"><h3>결제·충전 및 사용 내역</h3><div id="dispatch-billing-history">조회 중</div><button type="button" onclick="window.refreshDispatchWallet()">잔액·내역 새로고침</button></article>`;updateDispatchBillingQuote();updateCustomerExtensionQuote();
}
function showDispatchSignupResult(r){
 if(window.location?.search&&new URLSearchParams(window.location.search).has('dispatchSignup'))history.replaceState(null,'',location.pathname+'?view=billing');
 const result=r.result||{};
 openCustomerDialog(r.test?'신규 관제 가입 테스트 완료':'관제 가입이 완료되었습니다',`<p><b>${escapeMessage(result.companyName||'')}</b> · ${result.isPro?'PRO':'기본'} 관제</p><dl class="customer-review-details"><dt>이용기간</dt><dd>${escapeMessage(result.expireDate)}</dd><dt>기사 연결</dt><dd>${result.maxSlots}회선</dd><dt>PC 동시접속</dt><dd>${result.maxSessions}대</dd></dl>${r.test?'<p>테스트 결제 결과입니다. 실제 과금과 이용 가능한 관제 계정은 생성하지 않았습니다.</p>':`<p>앞으로 로그인할 때 사용하는 관제 키입니다. 안전하게 보관해 주세요.</p><pre class="customer-review-message" id="dispatch-issued-key">${escapeMessage(result.dispatchKey||r.dispatchKey)}</pre><button type="button" id="dispatch-signup-login" class="customer-primary-button">관제 시작하기</button>`}`);
 const start=document.getElementById('dispatch-signup-login');if(start)start.onclick=()=>{document.getElementById('login-billing-dialog')?.close();closeCustomerDialog();document.getElementById('single-key-input').value=result.dispatchKey||r.dispatchKey;window.handleSingleKeyLogin();};
}
function openDispatchSignup(selection=null){
 openCustomerDialog(selection?'업체 정보 입력 · 휴대폰 인증':'가입·결제 결과 확인',`<p>${selection?'담당자 휴대폰 인증 후 결제하면 관제 계정이 발급됩니다.':'가입할 때 인증한 담당자 휴대폰 번호로 발급된 관제 키와 결제 결과를 확인합니다.'}</p>${selection?'<label class="billing-field">업체명<input id="dispatch-signup-company" maxlength="60" autocomplete="organization" placeholder="업체명을 입력하세요"></label>':''}<label class="billing-field">담당자 휴대폰 번호<input id="dispatch-signup-phone" type="tel" autocomplete="tel" placeholder="010-1234-5678"></label><button type="button" id="dispatch-signup-send">인증번호 받기</button><label class="billing-field">인증번호<input id="dispatch-signup-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="인증번호 6자리"></label><button type="button" id="dispatch-signup-verify" disabled>인증 확인</button><p id="dispatch-signup-status" role="status" class="customer-help">입력한 번호로 인증번호를 보내 드립니다.</p>${selection?'<label style="display:flex;gap:8px;margin:16px 0"><input id="dispatch-signup-consent" type="checkbox"><span><a href="/terms.html" target="_blank" rel="noopener">이용약관</a> 및 <a href="/privacy.html" target="_blank" rel="noopener">개인정보처리방침</a>을 확인하고 가입에 동의합니다.</span></label><button type="button" id="dispatch-signup-next" class="customer-primary-button" disabled>가입 정보 확인 후 결제하기</button>':''}<button type="button" id="dispatch-signup-recover" disabled style="margin-top:12px">기존 가입·결제 결과 확인</button><p class="customer-help">이미 발급된 관제 키가 있으면 키로 로그인해 주세요.</p>`);
 const form=document.getElementById('dispatch-signup-status'),phone=document.getElementById('dispatch-signup-phone'),send=document.getElementById('dispatch-signup-send'),verify=document.getElementById('dispatch-signup-verify'),next=document.getElementById('dispatch-signup-next'),recover=document.getElementById('dispatch-signup-recover');
 let confirmation=null,verified=false;
 send.onclick=async()=>{send.disabled=true;verified=false;verify.disabled=true;if(next)next.disabled=true;recover.disabled=true;form.textContent='인증번호를 요청하고 있습니다.';
  try{confirmation=await requestDispatchSignupSms(phone.value);if(!form.isConnected)return;phone.readOnly=true;verify.disabled=false;form.textContent='인증번호를 발송했습니다. 6자리를 입력해 주세요.';}
  catch(e){form.textContent=e.message;}finally{send.disabled=false;}
 };
 verify.onclick=async()=>{if(!confirmation)return;verify.disabled=true;send.disabled=true;form.textContent='휴대폰 인증 확인 중…';
  try{await confirmation.confirm(document.getElementById('dispatch-signup-code').value.trim());if(!form.isConnected)return;verified=true;form.textContent='휴대폰 인증이 완료되었습니다.';recover.disabled=false;if(next)next.disabled=false;}
  catch(e){form.textContent=e.message;verify.disabled=false;send.disabled=false;}
 };
 if(next)next.onclick=async()=>{if(!verified)return;next.disabled=true;recover.disabled=true;form.textContent='가입 신청을 확인하고 있습니다.';
  try{
   const r=await dispatchPaymentRequest({action:'prepare-signup',companyName:document.getElementById('dispatch-signup-company').value,consent:document.getElementById('dispatch-signup-consent').checked});
   if(!form.isConnected)return;if(r.completed){showDispatchSignupResult(r);return;}
   await startDispatchCheckout({...selection,signup:true});
  }catch(e){form.textContent=e.message;}finally{next.disabled=false;recover.disabled=false;}
 };
 recover.onclick=async()=>{if(!verified)return;recover.disabled=true;if(next)next.disabled=true;form.textContent='가입·결제 결과를 확인하고 있습니다.';
  try{const w=await dispatchPaymentRequest({action:'wallet',signup:true});if(!form.isConnected)return;if(w.completed)showDispatchSignupResult(w);else if(w.pendingOrder){const r=await dispatchPaymentRequest({action:'recover',signup:true});if(form.isConnected)showDispatchSignupResult(r);}else form.textContent='결제 완료 내역이 없습니다. 관제 상품을 선택해 가입을 진행해 주세요.';}
  catch(e){form.textContent=e.message;}finally{recover.disabled=false;if(next)next.disabled=false;}
 };
}
window.openDispatchSignupRecovery=()=>openDispatchSignup();
let dispatchWalletLoading=false,dispatchCheckoutBusy=false,dispatchWidgets=null;
async function dispatchPaymentRequest(input){
 if(input.signup===true||input.action==='prepare-signup'){
  const token=await dispatchSignupToken();
  const r=await fetch('/api/dispatch-payment',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({...input,signup:true})});
  const result=await r.json();if(!r.ok)throw Error(result.error||'가입·결제 서버 연결을 확인해 주세요.');return result;
 }
 await auth.authStateReady?.();
 if(!auth.currentUser||!customerDispatchKey())throw Error('관제 계정으로 로그인한 뒤 결제·충전을 이용해 주세요.');
 const r=await fetch('/api/dispatch-payment',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await auth.currentUser.getIdToken()},body:JSON.stringify({...input,dispatchKey:customerDispatchKey(),sessionToken:sessionStorage.getItem('deliveryProSessionToken')})});
 const result=await r.json();if(!r.ok)throw Error(result.error||'결제 서버 연결을 확인해 주세요.');return result;
}
export async function refreshDispatchWallet(){
 if(dispatchWalletLoading)return;dispatchWalletLoading=true;const key=customerDispatchKey();
 try {
  const w=await dispatchPaymentRequest({action:'wallet'});if(key!==customerDispatchKey())return;
  document.querySelectorAll('[data-dispatch-balance],#customer-wallet-balance').forEach(e=>e.textContent=w.balance.toLocaleString('ko-KR')+'건');
  document.querySelectorAll('[data-dispatch-test-balance]').forEach(e=>e.textContent='테스트 잔여 '+w.testBalance.toLocaleString('ko-KR')+'건 · 실제 발송 사용 불가 · 결과 확인 중 예약 '+Number(w.reserved||0).toLocaleString('ko-KR')+'건');
  const history=document.getElementById('dispatch-billing-history');if(history)history.innerHTML=(w.recent||[]).map(e=>`<p>${e.test?'[테스트] ':''}${escapeMessage(new Date(e.at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))} · ${escapeMessage(e.label||'관리자 건수 수정')} · ${e.amount?customerMoney(e.amount):escapeMessage(e.before+' → '+e.balance+'건')} ${e.reason?'· '+escapeMessage(e.reason):''}</p>`).join('')||'결제·충전 내역이 없습니다.';
  if(history&&w.pendingOrder){const b=document.createElement('button');b.type='button';b.textContent='진행 중 결제 결과 다시 확인';b.onclick=async()=>{b.disabled=true;try{const r=await dispatchPaymentRequest({action:'recover'});alert((r.test?'테스트 ':'')+'결제 결과를 반영했습니다.');await refreshDispatchWallet();}catch(e){alert(e.message);}finally{b.disabled=false;}};history.append(b);}
 }catch(e){document.querySelectorAll('[data-dispatch-balance],#customer-wallet-balance').forEach(el=>el.textContent='조회 불가');const history=document.getElementById('dispatch-billing-history');if(history)history.textContent=e.message;}
 finally{dispatchWalletLoading=false;}
}
async function loadDispatchPaymentSdk(){
 if(window.TossPayments)return;
 await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://js.tosspayments.com/v2/standard';const timer=setTimeout(()=>{script.remove();reject(Error('토스 결제수단을 불러오지 못했습니다. 다시 시도해 주세요.'));},15000);script.onload=()=>{clearTimeout(timer);resolve();};script.onerror=()=>{clearTimeout(timer);script.remove();reject(Error('토스 결제수단 연결에 실패했습니다.'));};document.head.append(script);});
}
async function startDispatchCheckout(selection){
 if(!selection.signup&&(!auth.currentUser||!customerDispatchKey())){
  if(selection.kind==='service')return openDispatchSignup(selection);
  openCustomerDialog('문자 충전은 관제 가입 후 이용해 주세요','<p>관제 키가 있으면 먼저 로그인해 주세요. 처음 이용하는 업체는 기본 또는 PRO 관제 상품으로 가입할 수 있습니다.</p>');return;
 }
 if(dispatchCheckoutBusy)return;dispatchCheckoutBusy=true;
 const button=document.getElementById('dispatch-checkout-start');if(button)button.disabled=true;
 try {
  const order=await dispatchPaymentRequest({action:'create-order',...selection});
  openCustomerDialog('결제수단 선택',`<p>${order.test?'<b>테스트 결제 · 실제 과금 및 이용권 변경 없음</b>':'실제 결제'}</p><p>${escapeMessage(order.quote.label)} · <b>${customerMoney(order.amount)}</b></p><div id="dispatch-payment-method"></div><div id="dispatch-payment-agreement"></div><p id="dispatch-payment-status" role="status">결제수단을 불러오고 있습니다.</p><button type="button" id="dispatch-pay" class="customer-primary-button" disabled>${customerMoney(order.amount)} 결제하기</button>`);
  await loadDispatchPaymentSdk();dispatchWidgets=window.TossPayments(order.clientKey).widgets({customerKey:order.customerKey});
  await dispatchWidgets.setAmount({currency:'KRW',value:order.amount});
  await dispatchWidgets.renderPaymentMethods({selector:'#dispatch-payment-method',variantKey:'DEFAULT'});
  await dispatchWidgets.renderAgreement({selector:'#dispatch-payment-agreement',variantKey:'AGREEMENT'});
  const pay=document.getElementById('dispatch-pay');if(!pay)return;pay.disabled=false;
  document.getElementById('dispatch-payment-status').textContent='결제수단을 선택하고 필수 약관에 동의해 주세요.';
  const returnPage=selection.signup?'/admin.html?view=billing&dispatchSignup=':'/admin-dispatch.html?view=billing&dispatchPayment=';
  pay.onclick=async()=>{pay.disabled=true;try{await dispatchWidgets.requestPayment({orderId:order.orderId,orderName:order.quote.label,successUrl:location.origin+returnPage+'success',failUrl:location.origin+returnPage+'failed'});}catch(e){document.getElementById('dispatch-payment-status').textContent=e.message;pay.disabled=false;}};
 }catch(e){openCustomerDialog('결제 연결 안내',`<p>${escapeMessage(e.message)}</p><a href="/admin.html?view=billing">관제 로그인으로 이동</a>`);}
 finally{dispatchCheckoutBusy=false;if(button)button.disabled=false;}
}
let dispatchPaymentReturnHandled=false;
async function finishDispatchPayment(){
 const params=new URLSearchParams(window.location.search),signup=params.has('dispatchSignup');if(dispatchPaymentReturnHandled||!params.has('dispatchPayment')&&!signup)return;dispatchPaymentReturnHandled=true;
 if(params.get(signup?'dispatchSignup':'dispatchPayment')==='failed'){openCustomerDialog('결제가 완료되지 않았습니다',`<p>${escapeMessage(params.get('message')||'결제를 취소했습니다. 다시 상품을 선택할 수 있습니다.')}</p><p>결제 완료 전에는 관제 계정이 발급되지 않습니다.</p>`);return;}
 openCustomerDialog('결제 승인 확인','<p>결제 결과를 서버에서 확인하고 있습니다. 재결제하지 마세요.</p>');
 try {
  const r=await dispatchPaymentRequest({action:'confirm',orderId:params.get('orderId'),paymentKey:params.get('paymentKey'),amount:Number(params.get('amount')),...(signup?{signup:true}:{})});
  if(signup){showDispatchSignupResult(r);history.replaceState(null,'',location.pathname+'?view=billing');return;}
  openCustomerDialog(r.test?'테스트 결제 완료':'결제 완료',`<p>${r.result.count?`${r.result.count.toLocaleString()}건 충전 · 잔여 ${r.result.balance.toLocaleString()}건`:`관제 이용기간 ${escapeMessage(r.result.expireDate)}까지`}</p><p>${r.test?'테스트 전용 결과입니다. 실제 문자 잔여 건수와 관제 권한은 변경하지 않았습니다.':'서버에 반영되었습니다.'}</p>`);
  history.replaceState(null,'',location.pathname+'?view=billing');await refreshDispatchWallet();
 }catch(e){openCustomerDialog('결제 결과 재확인 필요',`<p>${escapeMessage(e.message)}</p><p>주문번호: ${escapeMessage(params.get('orderId'))}</p><button type="button" id="dispatch-payment-retry">같은 주문 다시 확인</button>${signup?'<button type="button" onclick="window.openDispatchSignupRecovery()">휴대폰 재인증 후 가입·결제 결과 확인</button>':''}`);document.getElementById('dispatch-payment-retry').onclick=()=>{dispatchPaymentReturnHandled=false;finishDispatchPayment();};}
}
window.refreshDispatchWallet=refreshDispatchWallet;
if(window.location?.search&&['dispatchPayment','dispatchSignup'].some(key=>new URLSearchParams(window.location.search).has(key)))setTimeout(finishDispatchPayment,0);
export function chooseCustomerSmsPack(count){customerBilling.smsCount=count;const input=document.getElementById('dispatch-sms-count');if(input)input.value=count;updateDispatchBillingQuote();}
export function openLoginBilling(){
 const dialog=document.getElementById('login-billing-dialog');if(!dialog)return;
 renderDispatchAccount('BILLING');if(!dialog.open)dialog.showModal();
}
Object.assign(window,{openLoginBilling,changeCustomerSmsMode,refreshCustomerSmsResults,createCustomerTrackingLinks,copyCustomerTrackingLink,openCustomerDeliveryPage,refreshCustomerDeliveryList,renderCustomerDeliveryList,updateCustomerMessagePreview,saveCustomerMessageDraft,filterCustomerDeliveries,changeCustomerDeliveryPage,renderDispatchAccount,setCustomerDeliveryFilter,toggleCustomerRecipient,selectAllCustomerRecipients,showCustomerDeliveryIssue,reviewCustomerSend,closeCustomerDialog,openCustomerContactGuide,setDispatchBillingTab,changeDispatchBilling,reviewDispatchBilling,chooseCustomerSmsPack,reviewCustomerExtension,changeDispatchProduct});

if(window.location?.search&&document.getElementById('login-billing-dialog')&&new URLSearchParams(window.location.search).get('view')==='billing')openLoginBilling();
