// js/admin-state.js

// 프로젝트 전체에서 공유할 상태(변수)들을 하나의 객체(state)로 모아둡니다.
export const state = {
    // 1. 공통 상태
    currentUserRole: null,
    allLicenses: [],
    allBlockedDevices: [], // 접속 제한(블랙리스트) 기기 목록
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

    // 3. PRO 기능 전용 상태 (엑셀, PDF, 자동할당, 인쇄, 권역 등)
    excelSortAsc: true,
    parsedExcelList: [],          // 업로드된 엑셀/PDF 주문 통합 리스트
    printReadyList: [],           // 인쇄 대기 주문 리스트
    selectedDispatchDriverId: null,
    currentSelectedFormIndex: null,
    previewDebounceTimer: null,
    
    // 권역(Territory) 지도 관련 상태
    territoryMap: null,
    territoryMarker: null,
    territoryCircles: [],
    otherTerritoryOverlays: [],
    currentTerritoryScale: 'dong',
    allTerritoriesMap: null,
    allTerritoriesOverlays: [],

    // 4. 마스터(Master) 히스토리 및 페이지네이션 상태
    masterPages: { regular: 1, trial: 1, dispatch: 1, memos: 1, blocked: 1 },
    historySortField: 'originalIndex',
    historySortAsc: true,
    historyAccountTypeFilter: 'ALL',
    currentSelectedAccountKey: '',
    historyMasterSubTab: 'ALL',
    historyCurrentPage: 1,
    historyNoticeMode: false,
    historySelectedAccountKeys: new Set(),
};

// 전역에서 공통으로 사용되는 로컬 기준 날짜 포맷 함수 (YYYY-MM-DD)
export function getLocalDateString(d = new Date()) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export const todayStr = getLocalDateString();