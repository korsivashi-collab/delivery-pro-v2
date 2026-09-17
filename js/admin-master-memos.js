// js/admin-master-memos.js

import { db } from "./admin-api.js";
import { PAGE_SIZE_MASTER, renderPaginationControls } from "./admin-ui.js";
import { state } from "./admin-state.js";
import { doc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// ==========================================
// 주차 메모 DB 관리 및 정렬 로직
// ==========================================

// 🌟 메모 테이블 정렬 상태 변수
let memoSortField = 'time'; // 'time' (작성 일시) 또는 'likes' (추천수)
let memoSortAsc = false;    // 기본적으로 최신순/추천많은순(내림차순) 표시

// 🌟 헤더 클릭 시 호출되는 정렬 실행 함수
export function sortMemos(field) {
    if (memoSortField === field) {
        memoSortAsc = !memoSortAsc; // 동일 항목 클릭 시 오름/내림차순 변경
    } else {
        memoSortField = field;
        memoSortAsc = false; // 다른 항목 클릭 시 무조건 내림차순(최신/인기)부터 시작
    }
    state.masterPages['memos'] = 1; // 정렬 시 페이지를 1페이지로 리셋
    renderMemosTable(state.allMemos);
}

export function renderMemosTable(memos) {
    const tbody = document.getElementById('table-body-memos');
    const pagEl = document.getElementById('pagination-memos');
    if (!tbody) return;

    // 🌟 1. 테이블 헤더 화살표 UI 및 색상 업데이트
    const arrowTime = document.getElementById('sort-arrow-time');
    const arrowLikes = document.getElementById('sort-arrow-likes');
    
    if (arrowTime && arrowLikes) {
        // 작성 일시 헤더 상태 갱신
        arrowTime.innerText = (memoSortField === 'time') ? (memoSortAsc ? '▲' : '▼') : '↕';
        arrowTime.parentElement.className = (memoSortField === 'time') 
            ? "sortable-th py-3 px-3 text-center text-blue-700 font-black hover:bg-gray-100 transition" 
            : "sortable-th py-3 px-3 text-center text-gray-500 hover:bg-gray-100 transition";
        
        // 추천수 헤더 상태 갱신
        arrowLikes.innerText = (memoSortField === 'likes') ? (memoSortAsc ? '▲' : '▼') : '↕';
        arrowLikes.parentElement.className = (memoSortField === 'likes') 
            ? "sortable-th py-3 px-3 text-center text-blue-700 font-black hover:bg-gray-100 transition" 
            : "sortable-th py-3 px-3 text-center text-gray-500 hover:bg-gray-100 transition";
    }

    if (!memos || memos.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-12 text-center text-gray-400 font-bold">등록된 주차 메모가 없습니다.</td></tr>`;
        if (pagEl) pagEl.innerHTML = '';
        return;
    }

    // 🌟 2. 선택된 기준(시간 or 좋아요)에 맞게 데이터 배열 실제 정렬 적용
    let sortedMemos = [...memos];
    sortedMemos.sort((a, b) => {
        if (memoSortField === 'likes') {
            const valA = a.likes || 0;
            const valB = b.likes || 0;
            return memoSortAsc ? (valA - valB) : (valB - valA);
        } else {
            // 시간 기준 (데이터가 없으면 0 처리)
            const timeA = a.createdAt || a.updatedAt || 0;
            const timeB = b.createdAt || b.updatedAt || 0;
            return memoSortAsc ? (timeA - timeB) : (timeB - timeA);
        }
    });

    const total = sortedMemos.length;
    const totalPages = Math.ceil(total / PAGE_SIZE_MASTER) || 1;
    let curPage = state.masterPages['memos'] || 1;
    if (curPage > totalPages) curPage = totalPages;
    if (curPage < 1) curPage = 1;
    state.masterPages['memos'] = curPage;

    const start = (curPage - 1) * PAGE_SIZE_MASTER;
    const pagedMemos = sortedMemos.slice(start, start + PAGE_SIZE_MASTER);

    tbody.innerHTML = pagedMemos.map((m, idx) => `
        <tr class="hover:bg-gray-50 transition">
            <td class="py-3 px-3 font-bold text-gray-400 text-center">${start + idx + 1}</td>
            <td class="py-3 px-3 font-black text-gray-900 max-w-[220px] truncate" title="${m.address}">${m.address}</td>
            <td class="py-3 px-3 font-bold text-gray-700 max-w-[340px] truncate" title="${m.memo}">${m.memo}</td>
            <td class="py-3 px-3 text-gray-400 font-medium whitespace-nowrap text-center">${m.time || '-'}</td>
            <td class="py-3 px-3 text-center font-bold text-blue-600">${m.likes || 0}</td>
            <td class="py-3 px-3 text-center whitespace-nowrap"><button onclick="window.deleteParkingMemo('${m.id}')" class="px-2.5 py-1 bg-red-50 text-red-600 font-bold rounded-lg text-[11px] shadow-sm active:scale-95">삭제</button></td>
        </tr>
    `).join('');
    
    if (pagEl) pagEl.innerHTML = renderPaginationControls('memos', curPage, total, PAGE_SIZE_MASTER, 'window.changeMasterTabPagination');
}

export async function deleteParkingMemo(id) {
    if (!confirm("이 주차 메모를 삭제하시겠습니까?")) return;
    try { await deleteDoc(doc(db, "memos", id)); } catch (e) { alert("삭제 오류: " + e.message); }
}