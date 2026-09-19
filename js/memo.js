// js/memo.js

// =================================================================
// [배송 동선 PRO] 현장 주차 및 건물 정보(메모) 전담 모듈
// =================================================================

import { 
    getMemosFromFirestore, 
    getBatchMemosFromFirestore, 
    saveMemoToFirestore, 
    likeMemoInFirestore, 
    reportMemoInFirestore 
} from './api.js';
import { getPureAddress, showLoading, hideLoading } from './utils.js';
import { state } from './state.js';
import { getOrCreateDeviceId } from './auth.js';

let batchMemosCache = {}; 
let currentMemoAddress = "";
let selectedHeightText = "";
let selectedTimeText = "";

// ==========================================
// 1. 메모 글자 수 실시간 카운트 리스너 초기화
// ==========================================
export function initMemoEvents() {
    const memoInputEl = document.getElementById('memo-input');
    if (memoInputEl) {
        memoInputEl.addEventListener('input', function() {
            const countEl = document.getElementById('memo-char-count');
            if (countEl) countEl.innerText = `${this.value.length} / 30`;
        });
    }
}

// ==========================================
// 2. 전체 배송지 주차 메모 일괄 미리 불러오기 (캐시)
// ==========================================
export async function preloadBatchMemos() {
    const destinations = state.getDestinations();
    if (destinations.length === 0) return;
    
    const addresses = destinations.map(d => getPureAddress(d.address));
    const uniqueAddrs = [...new Set(addresses)];
    try { 
        batchMemosCache = await getBatchMemosFromFirestore(uniqueAddrs); 
    } catch (e) { 
        batchMemosCache = {}; 
    }
}

// ==========================================
// 3. 메인 배송 카드 내 주차 정보 미리보기 렌더링
// ==========================================
export function renderMemoPreview(dest) {
    const previewEl = document.getElementById(`memo-preview-${dest.id}`); 
    const tagsEl = document.getElementById(`memo-tags-${dest.id}`);
    if (!previewEl || !tagsEl) return;
    
    const pureAddr = getPureAddress(dest.address);
    const memos = batchMemosCache[pureAddr] || []; 
    const memoText = memos.length > 0 ? memos[0].memo : null;

    if (memoText) {
        const tagRegex = /\[(.*?)\]/g; 
        let tags = []; 
        let match;
        
        while ((match = tagRegex.exec(memoText)) !== null) {
            let text = match[1]; 
            text = text.replace('주차장 높이 ', '높이:'); 
            text = text.replace('무료 회차 시간 ', '회차:'); 
            tags.push(text);
        }
        
        let rawText = memoText.replace(/\[.*?\]/g, '').trim();
        
        if (tags.length > 0) {
            tagsEl.innerHTML = tags.map(t => `<span class="bg-gray-100 text-gray-600 border border-gray-200 text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0">${t}</span>`).join(''); 
            tagsEl.classList.remove('hidden');
        } else { 
            tagsEl.classList.add('hidden'); 
            tagsEl.innerHTML = ''; 
        }
        
        if (rawText) { 
            previewEl.innerHTML = `<i class="fa-solid fa-circle-info text-blue-500 mr-1"></i><span class="font-bold">주차정보:</span> <span class="text-gray-700">${rawText}</span>`; 
            previewEl.classList.remove('hidden');
        } else { 
            previewEl.classList.add('hidden'); 
        }
    } else { 
        tagsEl.classList.add('hidden'); 
        previewEl.classList.add('hidden'); 
    }
}

// ==========================================
// 4. 모달 입력 태그 선택 로직
// ==========================================
export function selectHeightTag(btn, val) {
    const isActive = btn.dataset.active === "true";
    document.querySelectorAll('.height-tag-btn').forEach(b => { 
        b.dataset.active = "false"; 
        b.classList.remove('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
        b.classList.add('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
    });
    if (isActive) { 
        selectedHeightText = ""; 
    } else { 
        btn.dataset.active = "true"; 
        btn.classList.remove('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
        btn.classList.add('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
        selectedHeightText = `[주차장 높이 ${val}]`; 
    }
}

export function selectTimeTag(btn, val) {
    const isActive = btn.dataset.active === "true";
    document.querySelectorAll('.time-tag-btn').forEach(b => { 
        b.dataset.active = "false"; 
        b.classList.remove('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
        b.classList.add('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
    });
    if (isActive) { 
        selectedTimeText = ""; 
    } else { 
        btn.dataset.active = "true"; 
        btn.classList.remove('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
        btn.classList.add('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
        selectedTimeText = `[무료 회차 시간 ${val}]`; 
    }
}

export function toggleEtcTag(btn) {
    const isActive = btn.dataset.active === "true";
    if (isActive) { 
        btn.dataset.active = "false"; 
        btn.classList.remove('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
        btn.classList.add('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
    } else { 
        btn.dataset.active = "true"; 
        btn.classList.remove('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
        btn.classList.add('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
    }
}

function resetMemoForm() {
    document.querySelectorAll('.height-tag-btn, .time-tag-btn, .etc-tag-btn').forEach(b => { 
        b.dataset.active = "false"; 
        b.classList.remove('bg-yellow-100', 'border-yellow-400', 'text-yellow-800'); 
        b.classList.add('bg-gray-50', 'border-gray-200', 'text-gray-700'); 
    });
    
    selectedHeightText = ""; 
    selectedTimeText = ""; 
    
    const memoInput = document.getElementById('memo-input');
    const countEl = document.getElementById('memo-char-count');
    
    if (memoInput) memoInput.value = ""; 
    if (countEl) countEl.innerText = "0 / 30";
}

// ==========================================
// 5. 주차 정보 모달 열기 / 닫기
// ==========================================
export async function openMemoModal(id) {
    const destinations = state.getDestinations();
    const item = destinations.find(d => d.id === id); 
    if (!item) return; 
    
    currentMemoAddress = getPureAddress(item.address);
    
    const titleEl = document.getElementById('memo-modal-title');
    if (titleEl) titleEl.innerText = currentMemoAddress; 
    resetMemoForm();
    
    const listContainer = document.getElementById('memo-list-container');
    if (listContainer) {
        listContainer.innerHTML = `<div class="flex justify-center items-center py-6 text-gray-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>목록을 불러오는 중...</div>`;
    }
    document.getElementById('memo-modal')?.classList.remove('hidden');

    try {
        const memos = await getMemosFromFirestore(currentMemoAddress);
        const myDeviceId = getOrCreateDeviceId();
        
        const myMemo = memos.find(m => m.deviceId === myDeviceId);
        if (myMemo) {
            const rawMemo = myMemo.memo || "";
            const heightMatch = rawMemo.match(/\[주차장 높이 (.*?)\]/);
            if (heightMatch) {
                const val = heightMatch[1];
                document.querySelectorAll('.height-tag-btn').forEach(b => {
                    if (b.innerText.trim() === val) selectHeightTag(b, val);
                });
            }

            const timeMatch = rawMemo.match(/\[무료 회차 시간 (.*?)\]/);
            if (timeMatch) {
                const val = timeMatch[1];
                document.querySelectorAll('.time-tag-btn').forEach(b => {
                    if (b.innerText.trim() === val) selectTimeTag(b, val);
                });
            }

            ['도로변 주차', '지하주차장', '지상주차장'].forEach(tag => {
                if (rawMemo.includes(`[${tag}]`)) {
                    document.querySelectorAll('.etc-tag-btn').forEach(b => {
                        if (b.dataset.val === tag && b.dataset.active !== "true") toggleEtcTag(b);
                    });
                }
            });

            const pureText = rawMemo.replace(/\[.*?\]/g, '').trim();
            const memoInput = document.getElementById('memo-input');
            const countEl = document.getElementById('memo-char-count');
            
            if (memoInput) memoInput.value = pureText;
            if (countEl) countEl.innerText = `${pureText.length} / 30`;
        }

        if (memos.length > 0) {
            let html = "";
            memos.forEach((m, idx) => {
                let isMyMemo = (m.deviceId === myDeviceId);
                let crownHtml = (idx === 0) ? `<i class="fa-solid fa-crown text-yellow-400 mr-1 text-sm drop-shadow-sm"></i> ` : '';
                let myBadge = isMyMemo ? `<span class="bg-blue-100 text-blue-700 text-[9px] font-bold px-1.5 py-0.5 rounded ml-1">내가 쓴 정보</span>` : '';
                
                html += `
                <div class="bg-white border ${isMyMemo ? 'border-blue-300 ring-1 ring-blue-200' : 'border-gray-200'} rounded-xl p-3 shadow-sm relative overflow-hidden">
                    ${idx === 0 ? '<div class="absolute top-0 left-0 w-1 h-full bg-yellow-400"></div>' : ''}
                    <div class="text-[12px] text-gray-800 font-bold whitespace-pre-line leading-relaxed mb-2 pl-1">${crownHtml}${m.memo} ${myBadge}</div>
                    <div class="flex justify-between items-center border-t border-gray-100 pt-2 mt-2">
                        <span class="text-[9px] text-gray-400">${m.time}</span>
                        <div class="flex items-center gap-1.5">
                            <button onclick="likeMemo('${m.id}')" class="text-[10px] bg-blue-50 hover:bg-blue-100 text-blue-600 px-2 py-1 rounded-lg font-bold border border-blue-100 active:scale-95 transition"><i class="fa-solid fa-thumbs-up mr-0.5"></i> ${m.likes || 0}</button>
                            <button onclick="reportMemo('${m.id}')" class="text-[10px] text-gray-400 bg-gray-50 hover:bg-red-50 hover:text-red-500 px-2 py-1 rounded-lg border border-gray-100 active:scale-95 transition">🚨 신고</button>
                        </div>
                    </div>
                </div>`;
            });
            if (listContainer) listContainer.innerHTML = html;
        } else { 
            if (listContainer) listContainer.innerHTML = `<div class="bg-white border border-gray-200 rounded-xl p-6 text-center shadow-sm"><p class="text-gray-400 text-xs font-bold">등록된 주차정보가 없습니다.<br>첫 번째 정보를 남겨주세요!</p></div>`; 
        }
    } catch (e) { 
        if (listContainer) listContainer.innerHTML = `<div class="text-red-500 text-center text-xs py-4">데이터를 불러오지 못했습니다.</div>`; 
    }
}

export function closeMemoModal() { 
    document.getElementById('memo-modal')?.classList.add('hidden'); 
}

// ==========================================
// 6. 주차 메모 저장 / 좋아요 / 신고 액션
// ==========================================
export async function saveCurrentMemo() {
    const rawText = (document.getElementById('memo-input')?.value || '').trim();
    let tags = [];
    
    if (selectedHeightText) tags.push(selectedHeightText); 
    if (selectedTimeText) tags.push(selectedTimeText);
    
    document.querySelectorAll('.etc-tag-btn').forEach(btn => { 
        if (btn.dataset.active === "true") tags.push(`[${btn.dataset.val}]`); 
    });
    
    const tagString = tags.join(" "); 
    let finalMemo = "";
    if (tagString && rawText) {
        finalMemo = tagString + "\n" + rawText; 
    } else {
        finalMemo = (tagString + rawText).trim();
    }

    if (!finalMemo) { 
        alert("항목을 선택하거나 내용을 입력해주세요."); 
        return; 
    }
    
    const sensitiveRegex = /(비번|비밀번호|패스워드|#|\*|\d{4,})/g;
    if (sensitiveRegex.test(rawText)) { 
        alert("⚠️ [보안 경고]\n현관 비밀번호 등은 법적 문제로 공유할 수 없습니다."); 
        return; 
    }

    showLoading("주차정보 등록/수정 중...");
    try {
        await saveMemoToFirestore(currentMemoAddress, getOrCreateDeviceId(), finalMemo);
        hideLoading(); 
        alert("주차 정보가 등록(수정)되었습니다.");
        
        const destinations = state.getDestinations();
        const dest = destinations.find(d => getPureAddress(d.address) === currentMemoAddress); 
        if (dest) { 
            state.saveActiveData(); 
            if (typeof window.renderList === 'function') window.renderList();
            openMemoModal(dest.id); 
        }
    } catch (e) { 
        hideLoading(); 
        alert("통신 오류가 발생했습니다."); 
    }
}

export async function likeMemo(docId) {
    try {
        await likeMemoInFirestore(docId);
        const destinations = state.getDestinations();
        const dest = destinations.find(d => getPureAddress(d.address) === currentMemoAddress);
        if (dest) { 
            state.saveActiveData(); 
            if (typeof window.renderList === 'function') window.renderList();
            openMemoModal(dest.id); 
        }
    } catch (e) { 
        alert("통신 오류가 발생했습니다."); 
    }
}

export async function reportMemo(docId) {
    if (!confirm("이 메모에 부적절한 내용이 있습니까?\n신고하시면 즉시 블라인드 처리됩니다.")) return;
    
    showLoading("신고 처리 중...");
    try {
        await reportMemoInFirestore(docId);
        hideLoading(); 
        alert("신고가 접수되어 블라인드 처리되었습니다."); 
        
        const destinations = state.getDestinations();
        const dest = destinations.find(d => getPureAddress(d.address) === currentMemoAddress);
        if (dest) { 
            state.saveActiveData(); 
            if (typeof window.renderList === 'function') window.renderList();
            openMemoModal(dest.id); 
        }
    } catch (e) { 
        hideLoading(); 
        alert("통신 오류가 발생했습니다."); 
    }
}