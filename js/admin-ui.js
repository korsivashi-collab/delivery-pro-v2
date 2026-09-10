// js/admin-ui.js
export const PAGE_SIZE_MASTER = 20;

export function renderPaginationControls(tabKey, currentPage, totalItems, pageSize, onPageChangeFnName) {
    const totalPages = Math.ceil(totalItems / pageSize) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIndex = totalItems > 0 ? (currentPage - 1) * pageSize + 1 : 0;
    const endIndex = Math.min(currentPage * pageSize, totalItems);

    let pageBtns = '';
    for (let p = 1; p <= totalPages; p++) {
        if (p === 1 || p === totalPages || (p >= currentPage - 2 && p <= currentPage + 2)) {
            if (p === currentPage) {
                pageBtns += `<button class="w-8 h-8 rounded-xl text-xs font-black bg-blue-600 text-white shadow-xs">${p}</button>`;
            } else {
                pageBtns += `<button onclick="${onPageChangeFnName}('${tabKey}', ${p})" class="w-8 h-8 rounded-xl text-xs font-bold text-gray-700 bg-white hover:bg-gray-100 border border-gray-200 transition active:scale-95">${p}</button>`;
            }
        } else if (p === currentPage - 3 || p === currentPage + 3) {
            pageBtns += `<span class="px-1 text-gray-400 text-xs font-bold">...</span>`;
        }
    }

    return `
    <div class="flex flex-wrap items-center justify-between px-5 py-3 border-t border-gray-200 bg-gray-50/80 gap-2">
        <span class="text-xs text-gray-500 font-bold">
            총 <b class="text-blue-600 font-black">${totalItems}</b>개 항목 중 
            <b class="text-gray-900">${startIndex} - ${endIndex}</b>번째 표시
        </span>
        <div class="flex items-center gap-1.5">
            <button onclick="${onPageChangeFnName}('${tabKey}', ${currentPage - 1})" ${currentPage === 1 ? 'disabled class="px-3 py-1.5 rounded-xl text-xs font-bold text-gray-300 bg-gray-100 cursor-not-allowed"' : 'class="px-3 py-1.5 rounded-xl text-xs font-bold text-gray-600 bg-white hover:bg-gray-100 border border-gray-200 shadow-2xs transition active:scale-95"'}>
                <i class="fa-solid fa-chevron-left text-[10px]"></i> 이전
            </button>
            ${pageBtns}
            <button onclick="${onPageChangeFnName}('${tabKey}', ${currentPage + 1})" ${currentPage === totalPages ? 'disabled class="px-3 py-1.5 rounded-xl text-xs font-bold text-gray-300 bg-gray-100 cursor-not-allowed"' : 'class="px-3 py-1.5 rounded-xl text-xs font-bold text-gray-600 bg-white hover:bg-gray-100 border border-gray-200 shadow-2xs transition active:scale-95"'}>
                다음 <i class="fa-solid fa-chevron-right text-[10px]"></i>
            </button>
        </div>
    </div>`;
}