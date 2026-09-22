// js/memo.js

// =================================================================
// [배송 동선 PRO] 현장 주차 및 건물 정보(공용/개인 메모) 전담 모듈
// =================================================================

import { 
    getMemosFromFirestore, 
    getBatchMemosFromFirestore, 
    saveMemoToFirestore, 
    likeMemoInFirestore, 
    reportMemoInFirestore,
    firebaseUploadTempMemoBackup,
    firebaseGetTempMemoBackup,
    firebaseDeleteTempMemoBackup
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

    const personalMemoInputEl = document.getElementById('personal-memo-input');
    if (personalMemoInputEl) {
        personalMemoInputEl.addEventListener('input', function() {
            const countEl = document.getElementById('personal-memo-char-count');
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
// 3. 로컬 개인 메모 관리 헬퍼 (기기 로컬스토리지 전용)
// ==========================================
export function getAllPersonalMemos() {
    try {
        return JSON.parse(localStorage.getItem('deliveryPro_personal_memos') || '{}');
    } catch (e) {
        return {};
    }
}

export function getPersonalMemo(address) {
    if (!address) return "";
    const pureAddr = getPureAddress(address);
    const memos = getAllPersonalMemos();
    return memos[pureAddr] || "";
}

// ==========================================
// 4. 메인 배송 카드 내 메모 미리보기 렌더링
// ==========================================
export function renderMemoPreview(dest) {
    const previewEl = document.getElementById(`memo-preview-${dest.id}`); 
    const tagsEl = document.getElementById(`memo-tags-${dest.id}`);
    const personalPreviewEl = document.getElementById(`personal-memo-preview-${dest.id}`);
    
    const pureAddr = getPureAddress(dest.address);

    // [A] 공용 주차 정보 렌더링
    if (previewEl && tagsEl) {
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

    // [B] 개인 로컬 메모 렌더링 (공용 메모 바로 아랫단)
    if (personalPreviewEl) {
        const personalMemo = getPersonalMemo(pureAddr);
        if (personalMemo) {
            personalPreviewEl.innerHTML = `<i class="fa-solid fa-shield-halved text-emerald-600 mr-1"></i><span class="font-bold text-emerald-800">개인메모:</span> <span class="text-gray-800 font-semibold">${personalMemo}</span>`;
            personalPreviewEl.classList.remove('hidden');
        } else {
            personalPreviewEl.classList.add('hidden');
            personalPreviewEl.innerHTML = '';
        }
    }
}

// ==========================================
// 5. 모달 입력 태그 선택 로직
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

    const personalInput = document.getElementById('personal-memo-input');
    const personalCount = document.getElementById('personal-memo-char-count');
    const personalDelBtn = document.getElementById('btn-delete-personal-memo');
    if (personalInput) personalInput.value = "";
    if (personalCount) personalCount.innerText = "0 / 30";
    if (personalDelBtn) personalDelBtn.classList.add('hidden');
}

// ==========================================
// 6. 주차 정보 모달 열기 / 닫기
// ==========================================
export async function openMemoModal(id) {
    const destinations = state.getDestinations();
    const item = destinations.find(d => d.id === id); 
    if (!item) return; 
    
    currentMemoAddress = getPureAddress(item.address);
    
    const titleEl = document.getElementById('memo-modal-title');
    if (titleEl) titleEl.innerText = currentMemoAddress; 
    resetMemoForm();

    const savedPersonal = getPersonalMemo(currentMemoAddress);
    const pInput = document.getElementById('personal-memo-input');
    const pCount = document.getElementById('personal-memo-char-count');
    const pDelBtn = document.getElementById('btn-delete-personal-memo');
    if (pInput) pInput.value = savedPersonal;
    if (pCount) pCount.innerText = `${savedPersonal.length} / 30`;
    if (pDelBtn) {
        if (savedPersonal) pDelBtn.classList.remove('hidden');
        else pDelBtn.classList.add('hidden');
    }
    
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
// 7. 공용 주차 메모 저장 / 좋아요 / 신고 액션
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
        alert("⚠️ [보안 경고]\n현관 비밀번호 등은 법적 문제로 공유할 수 없습니다.\n비밀번호는 아래 '개인 메모'에 입력해 주세요."); 
        return; 
    }

    showLoading("주차정보 등록/수정 중...");
    try {
        await saveMemoToFirestore(currentMemoAddress, getOrCreateDeviceId(), finalMemo);
        
        // 공용 주차정보 작성 성공 시 로컬 기여 내역(150건 이벤트용)에 주소 기록 (중복 등록 방지 처리)
        try {
            let myParkingMemos = JSON.parse(localStorage.getItem('deliveryPro_my_parking_memos') || '[]');
            if (!myParkingMemos.includes(currentMemoAddress)) {
                myParkingMemos.push(currentMemoAddress);
                localStorage.setItem('deliveryPro_my_parking_memos', JSON.stringify(myParkingMemos));
            }
        } catch (err) {}

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

// ==========================================
// 8. 개인 로컬 메모 저장 및 삭제 액션
// ==========================================
export function savePersonalMemo() {
    if (!currentMemoAddress) {
        alert("배송지 주소 정보를 찾을 수 없습니다.");
        return;
    }
    const inputEl = document.getElementById('personal-memo-input');
    const memoText = (inputEl?.value || '').trim();

    if (!memoText) {
        alert("개인 메모 내용을 입력해 주세요.\n(삭제를 원하시면 '삭제' 버튼을 눌러주세요)");
        return;
    }
    if (memoText.length > 30) {
        alert("개인 메모는 최대 30자까지 입력 가능합니다.");
        return;
    }

    const allMemos = getAllPersonalMemos();
    allMemos[currentMemoAddress] = memoText;
    localStorage.setItem('deliveryPro_personal_memos', JSON.stringify(allMemos));

    alert("개인 메모가 핸드폰에 안전하게 저장되었습니다.");

    const delBtn = document.getElementById('btn-delete-personal-memo');
    if (delBtn) delBtn.classList.remove('hidden');

    const destinations = state.getDestinations();
    const dest = destinations.find(d => getPureAddress(d.address) === currentMemoAddress);
    if (dest) {
        renderMemoPreview(dest);
    }
    if (typeof window.renderList === 'function') {
        window.renderList();
    }
}

export function deletePersonalMemo() {
    if (!currentMemoAddress) return;
    if (!confirm("이 주소에 저장된 개인 메모를 삭제하시겠습니까?")) return;

    const allMemos = getAllPersonalMemos();
    delete allMemos[currentMemoAddress];
    localStorage.setItem('deliveryPro_personal_memos', JSON.stringify(allMemos));

    const inputEl = document.getElementById('personal-memo-input');
    const countEl = document.getElementById('personal-memo-char-count');
    const delBtn = document.getElementById('btn-delete-personal-memo');

    if (inputEl) inputEl.value = "";
    if (countEl) countEl.innerText = "0 / 30";
    if (delBtn) delBtn.classList.add('hidden');

    alert("개인 메모가 삭제되었습니다.");

    const destinations = state.getDestinations();
    const dest = destinations.find(d => getPureAddress(d.address) === currentMemoAddress);
    if (dest) {
        renderMemoPreview(dest);
    }
    if (typeof window.renderList === 'function') {
        window.renderList();
    }
}

// ==========================================
// 9. 기기단 자체 암호화 / 복호화 유틸리티
// ==========================================
function getMemoSecretKey() {
    const rawKey = localStorage.getItem('deliveryProKey') || 'DEV_KEY';
    return (rawKey + '_DELIVERY_PRO_ENC_SALT').replace(/[^a-zA-Z0-9_]/g, '');
}

function encryptPayload(text, secretKey) {
    const encoded = encodeURIComponent(text);
    let result = '';
    for (let i = 0; i < encoded.length; i++) {
        result += String.fromCharCode(encoded.charCodeAt(i) ^ secretKey.charCodeAt(i % secretKey.length));
    }
    return btoa(result);
}

function decryptPayload(cipher, secretKey) {
    const decoded = atob(cipher);
    let result = '';
    for (let i = 0; i < decoded.length; i++) {
        result += String.fromCharCode(decoded.charCodeAt(i) ^ secretKey.charCodeAt(i % secretKey.length));
    }
    return decodeURIComponent(result);
}

// ==========================================
// 10. 개인 메모 기기변경 임시 백업 및 복구 (3중 안전장치)
// ==========================================

// 10-1. 기기변경용 12시간 암호화 백업
export async function backupPersonalMemosToCloud() {
    const rawKey = localStorage.getItem('deliveryProKey');
    if (!rawKey) {
        alert("로그인 정보가 올바르지 않습니다. 다시 로그인해 주세요.");
        return;
    }
    const cleanKey = rawKey.trim().replace(/[\/\\#?]/g, '_');
    const allMemos = getAllPersonalMemos();
    const memoKeys = Object.keys(allMemos);
    const count = memoKeys.length;

    // [안전장치 1] 빈 데이터(0건) 백업 원천 차단
    if (count === 0) {
        alert("⚠️ 현재 핸드폰에 저장된 개인 메모가 0건입니다.\n기존 메모를 가져오시려면 [복구] 버튼을 눌러주세요.");
        return;
    }

    try {
        // [안전장치 2] 기존 백업 존재 여부 사전 검증 및 덮어쓰기 2중 확인
        showLoading("기존 서버 백업 확인 중...");
        const existing = await firebaseGetTempMemoBackup(cleanKey);
        hideLoading();

        if (existing && !existing.expired && existing.count > 0) {
            const ok = confirm(`⚠️ 서버에 기존 백업(${existing.count}건)이 보관되어 있습니다.\n현재 폰의 메모(${count}건)로 덮어쓰시겠습니까?`);
            if (!ok) return;
        }

        showLoading("개인 메모 암호화 보관 중...");
        const secretKey = getMemoSecretKey();
        const encrypted = encryptPayload(JSON.stringify(allMemos), secretKey);

        await firebaseUploadTempMemoBackup(cleanKey, encrypted, count);
        hideLoading();

        alert(`✅ 개인 메모 ${count}건이 서버에 암호화 보관되었습니다.\n\n[안내]\n1. 유효시간은 12시간입니다.\n2. 구 핸드폰에서 [로그아웃] 후, 새 핸드폰에서 로그인하여 [개인메모 복구]를 누르시면 됩니다.`);
    } catch (e) {
        hideLoading();
        alert("백업 처리 중 오류가 발생했습니다: " + e.message);
    }
}

// 10-2. 새 기기에서 복구 실행 (병합 복구 및 서버 즉시 파기)
export async function restorePersonalMemosFromCloud() {
    const rawKey = localStorage.getItem('deliveryProKey');
    if (!rawKey) {
        alert("로그인 정보가 올바르지 않습니다. 다시 로그인해 주세요.");
        return;
    }
    const cleanKey = rawKey.trim().replace(/[\/\\#?]/g, '_');

    try {
        showLoading("서버 백업 확인 중...");
        const backup = await firebaseGetTempMemoBackup(cleanKey);
        hideLoading();

        if (!backup) {
            alert("서버에 보관된 임시 백업이 없습니다.\n기존 핸드폰에서 먼저 [기기변경 백업]을 실행해 주세요.");
            return;
        }

        if (backup.expired) {
            alert("⚠️ 백업 유효시간(12시간)이 초과되어 데이터가 보안상 자동 파기되었습니다.\n기존 기기에서 다시 백업을 진행해 주세요.");
            return;
        }

        const ok = confirm(`서버에서 ${backup.count}건의 암호화 백업을 찾았습니다.\n기존 메모와 병합하여 복구하시겠습니까?`);
        if (!ok) return;

        showLoading("암호 해독 및 복구 중...");
        const secretKey = getMemoSecretKey();
        let restoredObj = {};

        try {
            const decryptedJson = decryptPayload(backup.payload, secretKey);
            restoredObj = JSON.parse(decryptedJson);
        } catch (err) {
            hideLoading();
            alert("암호 해독에 실패했습니다. 키 정보가 일치하지 않습니다.");
            return;
        }

        // [안전장치 3] 기존 메모를 지우지 않고 병합(Merge)
        const currentMemos = getAllPersonalMemos();
        const mergedMemos = { ...currentMemos, ...restoredObj };
        localStorage.setItem('deliveryPro_personal_memos', JSON.stringify(mergedMemos));

        // 복구 성공 즉시 서버 데이터 완전 파기
        await firebaseDeleteTempMemoBackup(cleanKey);
        hideLoading();

        // 화면 갱신
        const destinations = state.getDestinations();
        destinations.forEach(d => renderMemoPreview(d));
        if (typeof window.renderList === 'function') window.renderList();

        alert(`🎉 개인 메모 복구가 성공적으로 완료되었습니다!\n(총 ${Object.keys(mergedMemos).length}건 반영됨)\n\n보안을 위해 서버의 임시 백업 데이터는 영구 파기되었습니다.`);
    } catch (e) {
        hideLoading();
        alert("복구 처리 중 오류가 발생했습니다: " + e.message);
    }
}

// ==========================================
// 11. Window 전역 바인딩
// ==========================================
window.savePersonalMemo = savePersonalMemo;
window.deletePersonalMemo = deletePersonalMemo;
window.backupPersonalMemosToCloud = backupPersonalMemosToCloud;
window.restorePersonalMemosFromCloud = restorePersonalMemosFromCloud;