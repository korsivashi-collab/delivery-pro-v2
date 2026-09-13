// js/admin-state.js

// 프로젝트 전체에서 공유할 상태(변수)들을 하나의 객체(state)로 모아둡니다.
export const state = {
    // 1. 공통 상태
    currentUserRole: null,
    allLicenses: [],
    allMemos: [],
    activeRoutes: {},
    allCompletions: [],
    allDispatchMessages: [],
    allDispatchTemplates: [],

    // 2. 관제(Dispatch) 탭 및 지도 상태
    dispatchNavState: 'DELIVERY',
    dispatchDetailTab: 'ROUTE',
    currentMapPolylineMode: 'all',
    selectedDeviceId: null,
    selectedMessageDrivers: new Set(),
    activeDispatchPopupMsgId: null,

    // 3. PRO 기능 전용 상태 (엑셀, 인쇄, 권역 등)
    excelSortAsc: true,
    parsedExcelList: [],
    printReadyList: [],
    selectedDispatchDriverId: null,
    currentSelectedFormIndex: null,
    previewDebounceTimer: null,
    
    territoryMap: null,
    territoryMarker: null,
    territoryCircles: [],
    otherTerritoryOverlays: [],
    currentTerritoryScale: 'dong',
    allTerritoriesMap: null,
    allTerritoriesOverlays: [],

    // 4. 마스터(Master) 히스토리 및 페이지네이션 상태
    masterPages: { regular: 1, trial: 1, dispatch: 1, memos: 1 },
    historySortField: 'originalIndex',
    historySortAsc: true,
    historyAccountTypeFilter: 'ALL',
    currentSelectedAccountKey: '',
    historyMasterSubTab: 'ALL',
    historyCurrentPage: 1,
    historyNoticeMode: false,
    historySelectedAccountKeys: new Set(),
};

// 전역에서 공통으로 사용되는 날짜 포맷 함수
export function getLocalDateString(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const todayStr = getLocalDateString();