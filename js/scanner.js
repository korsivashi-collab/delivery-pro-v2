// js/scanner.js

// =================================================================
// [배송 동선 PRO] 카메라 스캔 및 AI 하이브리드 주소/상호명 매칭 전담 모듈
// =================================================================

import { 
    toBase64_SafeCompress, 
    extractPhoneLogic, 
    extractAddressLogic, 
    extractStoreNameLogic,
    extractStoreNameByLayout,
    logStoreNameDiagnostic, 
    showLoading, 
    hideLoading 
} from './utils.js';
import { 
    geocodeAddress, 
    getPOIsByAddress, 
    matchOCRStoreCandidate,
    assessOCRStoreCandidate,
    STORE_NAME_MATCH_THRESHOLD
} from './kakao.js';
import { state } from './state.js';
import { 
    isLicenseExpiredLocally, 
    clearAuthStorage, 
    getOrCreateDeviceId 
} from './auth.js';
import { 
    firebaseCheckLicenseOnce, 
    checkIfDeviceBlocked,
    saveRouteToFirestore 
} from './api.js';

const MAX_MONTHLY_SCANS = 1250; 
const SCAN_COOLDOWN_MS = 1000;
let idCounter = Date.now();

// ==========================================
// 1. 월간 스캔 한도 및 쿨다운 검사
// ==========================================
export function checkScanLimit() {
    const now = Date.now();
    const currentMonth = new Date().toISOString().slice(0, 7);
    const lastScanTime = localStorage.getItem('deliveryProLastScanTime');
    
    if (lastScanTime && (now - parseInt(lastScanTime) < SCAN_COOLDOWN_MS)) { 
        alert("1초 후 다시 스캔해주세요."); 
        return false; 
    }
    
    let scanData = JSON.parse(localStorage.getItem('deliveryProScanData') || '{"month": "", "count": 0}');
    if (scanData.month !== currentMonth) { 
        scanData = { month: currentMonth, count: 0 }; 
    }
    
    if (scanData.count >= MAX_MONTHLY_SCANS) { 
        alert(`⚠️ 월간 최대 스캔 한도(${MAX_MONTHLY_SCANS}장) 초과.`); 
        return false; 
    }
    
    scanData.count++;
    localStorage.setItem('deliveryProScanData', JSON.stringify(scanData));
    localStorage.setItem('deliveryProLastScanTime', now.toString());
    
    return true;
}

// ==========================================
// 2. 서버 OCR API 통신
// ==========================================
export async function performOCR(base64Data, includeLayout = false) {
    const response = await fetch('/api/ocr', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ imageContent: base64Data }) 
    });
    const data = await response.json();
    
    if (data.error) throw new Error(data.error);
    if (data.responses && data.responses[0].error) throw new Error(data.responses[0].error.message);
    if (data.responses && data.responses[0].fullTextAnnotation) {
        const annotation = data.responses[0].fullTextAnnotation;
        return includeLayout ? { text: annotation.text, pages: annotation.pages || [] } : annotation.text;
    }
    
    throw new Error("사진에서 글자를 찾을 수 없습니다.");
}

// ==========================================
// 3. 주소 수동 입력/수정 모달
// ==========================================
export function promptAddressCustom(snippet, defaultText, defaultPhone = "", isEditMode = false) {
    return new Promise((resolve) => {
        const modal = document.getElementById('address-input-modal');
        const addrInput = document.getElementById('manual-address-input');
        const phoneInput = document.getElementById('manual-phone-input');
        const snippetEl = document.getElementById('ocr-snippet');
        const snippetContainer = document.getElementById('ocr-snippet-container');
        const titleEl = document.getElementById('address-modal-title');
        const descEl = document.getElementById('address-modal-desc');
        const btnConfirm = document.getElementById('address-modal-confirm');
        const btnCancel = document.getElementById('address-modal-cancel');

        if (isEditMode) {
            if (titleEl) titleEl.innerText = "정보 확인 및 수정"; 
            if (descEl) descEl.innerText = "정확한 배송지 정보를 입력해 주세요.";
            if (snippetContainer) snippetContainer.classList.add('hidden');
        } else {
            if (titleEl) titleEl.innerText = "주소 확인"; 
            if (descEl) descEl.innerText = "인식 오류 시 직접 입력해 주세요";
            if (snippetContainer) snippetContainer.classList.remove('hidden'); 
            if (snippetEl) snippetEl.innerText = snippet || "인식된 텍스트가 없습니다.";
        }

        if (addrInput) addrInput.value = defaultText || ""; 
        if (phoneInput) phoneInput.value = defaultPhone || "";
        if (modal) modal.classList.remove('hidden');
        
        setTimeout(() => { if (addrInput) addrInput.focus(); }, 100);

        const onConfirm = () => { 
            cleanup(); 
            resolve({ address: addrInput.value.trim(), phone: phoneInput.value.trim() }); 
        };
        const onCancel = () => { 
            cleanup(); 
            resolve(null); 
        };
        const cleanup = () => { 
            btnConfirm.removeEventListener('click', onConfirm); 
            btnCancel.removeEventListener('click', onCancel); 
            if (modal) modal.classList.add('hidden'); 
        };
        
        btnConfirm.addEventListener('click', onConfirm); 
        btnCancel.addEventListener('click', onCancel);
    });
}

// ==========================================
// 4. 배송지 주소/전화번호 수정 액션 (관제 서버 동기화 포함)
// ==========================================
export async function editDestinationAddress(id) {
    const destinations = state.getDestinations();
    const item = destinations.find(d => d.id === id); 
    if (!item) return;
    
    const result = await promptAddressCustom("", item.address, item.phone || "", true); 
    if (!result) return;
    
    const newAddr = result.address; 
    const newPhone = result.phone;
    let addrChanged = newAddr !== item.address; 
    let phoneChanged = newPhone !== (item.phone || "");
    
    if (!addrChanged && !phoneChanged) return;

    if (addrChanged) {
        showLoading("수정된 주소 확인 중...");
        try {
            let pureAddr = newAddr.replace(/\[.*?\]/g, '').trim();
            const coords = await geocodeAddress(pureAddr || newAddr.trim());
            if (coords) { 
                let prefixMatch = newAddr.match(/^(\[.*?\])\s*/);
                let storePrefix = prefixMatch ? (prefixMatch[1] + " ") : "";
                
                item.address = storePrefix + (coords.address_name || pureAddr); 
                item.lat = coords.lat; 
                item.lng = coords.lng; 
            }
        } catch (e) { 
            alert("수정된 주소를 지도에서 찾을 수 없습니다."); 
            hideLoading(); 
            return; 
        } finally { 
            hideLoading(); 
        }
    }
    item.phone = newPhone; 
    state.saveActiveData(); 
    if (typeof window.renderList === 'function') window.renderList();

    // 🌟 수정된 경로를 관제 센터 서버에도 즉시 동기화
    const deviceId = getOrCreateDeviceId();
    const driverPhone = localStorage.getItem('deliveryProUserPhone') || "";
    saveRouteToFirestore(deviceId, driverPhone, state.getDestinations());
}

// ==========================================
// 5-1. 상호 매칭 전 주소 칸(셀) 일괄 삭제 헬퍼 (1단계용)
// ==========================================
function removeAddressCellFromOCR(rawText, addressStr) {
    if (!rawText) return "";
    let cleaned = rawText;

    const nextFieldPattern = "(?=\\n\\s*(?:배송지명|간판명|상호|업체명|연락처|전화|010|받는분|수령인|구매자|고객명|공급|금액|수량|단가)|배송지명|간판명|상호|업체명|연락처|전화|010|받는분|수령인|구매자|고객명|공급|금액|수량|단가|$)";

    // 1) '주소' 라벨로 시작하는 영역 제거
    const addrLabelRegex = new RegExp(`(주소[\\s\\:\\|\\-]*(\\[\\d{5}\\]|\\d{5})?[\\s\\S]*?)${nextFieldPattern}`, 'i');
    if (addrLabelRegex.test(cleaned)) {
        cleaned = cleaned.replace(addrLabelRegex, ' ');
    }

    // 2) 우편번호 영역 제거
    const zipRegex = new RegExp(`((\\[\\d{5}\\]|\\b\\d{5}\\b)[\\s\\S]*?)${nextFieldPattern}`, 'i');
    if (zipRegex.test(cleaned)) {
        cleaned = cleaned.replace(zipRegex, ' ');
    }

    // 3) 인식된 도로명 주소부터 다음 필드 직전까지 제거
    if (addressStr) {
        let safeAddr = addressStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const directAddrRegex = new RegExp(`(${safeAddr}[\\s\\S]*?)${nextFieldPattern}`, 'i');
        if (directAddrRegex.test(cleaned)) {
            cleaned = cleaned.replace(directAddrRegex, ' ');
        }
    }

    if (!cleaned || cleaned.trim().length === 0) {
        return rawText;
    }

    return cleaned;
}

// ==========================================
// 5-2. 주소지 영역 텍스트 추출 헬퍼 (2단계용)
// ==========================================
function extractAddressAreaText(rawOCRText, addressStr) {
    if (!rawOCRText) return "";

    const nextFieldPattern = "(?=\\n\\s*(?:배송지명|간판명|상호|업체명|연락처|전화|010|받는분|수령인|구매자|고객명|공급|금액|수량|단가)|배송지명|간판명|상호|업체명|연락처|전화|010|받는분|수령인|구매자|고객명|공급|금액|수량|단가|$)";
    const addrLabelRegex = new RegExp(`(주소[\\s\\:\\|\\-]*[\\s\\S]*?)${nextFieldPattern}`, 'i');
    const match = rawOCRText.match(addrLabelRegex);
    if (match && match[1]) {
        return match[1];
    }

    if (addressStr) {
        const lines = rawOCRText.split(/\n/);
        const cleanAddr = addressStr.replace(/[^\w가-힣]/g, '');
        for (let i = 0; i < lines.length; i++) {
            const cleanLine = lines[i].replace(/[^\w가-힣]/g, '');
            if (cleanLine.includes(cleanAddr) || (cleanAddr.length >= 6 && cleanLine.includes(cleanAddr.substring(0, 6)))) {
                let block = lines[i];
                if (i + 1 < lines.length) block += " " + lines[i + 1];
                return block;
            }
        }
    }

    return addressStr || "";
}

// ==========================================
// 6. 카메라 스캔 및 순수 주소 기반 3단계 판독 파이프라인
// ==========================================
export function initCameraScan() {
    const cameraInput = document.getElementById('camera-input');
    if (!cameraInput) return;
    
    cameraInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // 🌟 [보안 및 라이선스 1회 단발성 검증] 스캔 전 계정 유효성 점검
        const deviceId = getOrCreateDeviceId();
        try {
            const isBlocked = await checkIfDeviceBlocked(deviceId);
            if (isBlocked) {
                window.location.replace('error.html');
                return;
            }
        } catch (err) {}

        if (isLicenseExpiredLocally()) {
            alert("⚠️ 라이선스 사용기한이 만료되었습니다.\n관리자에게 문의해 주세요.");
            clearAuthStorage();
            window.location.reload();
            return;
        }

        const savedKey = localStorage.getItem('deliveryProKey');
        if (savedKey) {
            const licCheck = await firebaseCheckLicenseOnce(savedKey, deviceId);
            if (!licCheck.valid && !licCheck.isOffline) {
                alert(`⚠️ [라이선스 알림]\n${licCheck.msg || "라이선스가 유효하지 않습니다."}`);
                clearAuthStorage();
                window.location.reload();
                return;
            }
        }

        if (!checkScanLimit()) { e.target.value = ''; return; }

        let addressStr = null; 
        let rawOCRText = ""; 
        let ocrPages = [];
        let extractedPhone = null;
        
        // 1. OCR 판독
        showLoading("사진 판독 중...");
        try {
            const base64Image = await toBase64_SafeCompress(file);
            const imageContent = base64Image.split(',')[1];
            const ocrResult = await performOCR(imageContent, true);
            rawOCRText = ocrResult.text;
            ocrPages = ocrResult.pages;
            addressStr = extractAddressLogic(rawOCRText, ocrPages);
            extractedPhone = extractPhoneLogic(rawOCRText);
            hideLoading();
        } catch (error) {
            hideLoading();
            const result = await promptAddressCustom("사진 인식 실패", "", "", false);
            if (!result || !result.address) { e.target.value = ''; return; }
            addressStr = result.address; 
            extractedPhone = result.phone;
        }

        if (!addressStr && rawOCRText) {
            let snippet = rawOCRText.replace(/\n/g, ' ').substring(0, 40);
            const result = await promptAddressCustom(snippet + "...", "", extractedPhone, false);
            if (!result || !result.address) { e.target.value = ''; return; }
            addressStr = result.address; 
            extractedPhone = result.phone;
        }

        // 2. 주소 좌표 획득
        let coords = null;
        while (!coords) {
            try {
                showLoading("지도 위치 확인 중...");
                coords = await geocodeAddress(addressStr);
                hideLoading();
            } catch (error) {
                hideLoading();
                const result = await promptAddressCustom("지도에서 주소를 찾을 수 없습니다.", addressStr, extractedPhone, true);
                if (!result || !result.address) { e.target.value = ''; return; }
                addressStr = result.address; 
                extractedPhone = result.phone;
            }
        }

        // 3. 후보 수집과 최종 선택을 분리. 위치/텍스트 결과를 즉시 확정하지 않는다.
        let finalStoreName = null;
        let diagnosticPath = '빈 값';
        const storeDecision = { version: 'store-selection-v2', rawOCRText, positionCandidates: [], textCandidate: null, kakaoCandidates: [], similarities: [], kakaoCalled: false, kakaoStatus: 'not-called', reason: '' };
        if (addressStr && rawOCRText) {
            showLoading("상호명 AI 매칭 중...");
            try {
                let positionResult = { name: null, candidates: [], excludedTextSegments: [] };
                try { positionResult = extractStoreNameByLayout(ocrPages); }
                catch (error) { storeDecision.positionError = error.message; }
                storeDecision.positionCandidate = positionResult.name;
                storeDecision.positionCandidates = positionResult.candidates || [];
                let storeOCRText = rawOCRText;
                for (const segment of [...(positionResult.excludedTextSegments || [])].sort((a, b) => b.start - a.start)) {
                    storeOCRText = storeOCRText.slice(0, segment.start) + storeOCRText.slice(segment.start, segment.end).replace(/[^\r\n]/g, ' ') + storeOCRText.slice(segment.end);
                }
                let textCandidate = null;
                try { textCandidate = extractStoreNameLogic(storeOCRText); }
                catch (error) { storeDecision.textError = error.message; }
                storeDecision.textCandidate = textCandidate;
                const names = [...new Set([positionResult.name, ...storeDecision.positionCandidates.map(item => item.name), textCandidate].filter(Boolean))];
                const assessments = names.map(name => assessOCRStoreCandidate(name, storeOCRText));
                storeDecision.assessments = assessments;
                const trusted = assessments.filter(item => item.trustworthy);
                let result = { places: [], buildingNames: [] };
                // 비용 최적화보다 검증을 우선: 주소당 장소 검색은 이 지점에서 1회만 수행.
                storeDecision.kakaoCalled = true;
                try {
                    result = await getPOIsByAddress(addressStr, true);
                    storeDecision.kakaoStatus = result.status || (result.places.length ? 'success' : 'empty');
                } catch (error) { storeDecision.kakaoStatus = 'failed'; storeDecision.kakaoError = error.message; }
                storeDecision.kakaoCandidates = result.places;
                finalStoreName = matchOCRStoreCandidate(names, result.places, STORE_NAME_MATCH_THRESHOLD, rawOCRText, storeDecision);
                if (finalStoreName) { diagnosticPath = 'ocr-kakao-match'; storeDecision.reason = '70% 이상 일치 장소가 유일함'; }
                if (!finalStoreName) {
                    const buildings = [...new Set([coords?.road_address?.building_name, coords?.building_name, ...result.buildingNames].filter(Boolean))];
                    if (buildings.length === 1) { finalStoreName = buildings[0]; diagnosticPath = 'kakao-building'; storeDecision.reason = '장소 매칭 실패 후 명시적 건물명 하나'; }
                }
                if (!finalStoreName && !result.places.length && trusted.length === 1) {
                    finalStoreName = trusted[0].name;
                    diagnosticPath = 'ocr-trusted-fallback';
                    storeDecision.reason = '장소 조회 실패/빈 결과이며 상호 필드 전체와 일치하는 OCR 후보가 유일함';
                }
                if (!finalStoreName) storeDecision.reason = '유일한 장소 매칭/건물명/신뢰 가능한 OCR fallback 없음';
            } catch (error) { storeDecision.reason = '선택 오류'; storeDecision.error = error.message; }
            hideLoading();
        }
        storeDecision.selected = finalStoreName;
        storeDecision.source = diagnosticPath;
        logStoreNameDiagnostic('상호 선택 구조', storeDecision);

        // 4. 배송 목록 추가 및 렌더링 + 관제 센터 서버 동기화
        if (coords) {
            let resolvedAddress = coords.address_name || addressStr;
            if (finalStoreName && !resolvedAddress.includes(finalStoreName)) {
                resolvedAddress = `[${finalStoreName}] ${resolvedAddress}`;
            }

            const currentDests = state.getDestinations();
            let nextNum = currentDests.length > 0 ? Math.max(...currentDests.map(d => d.displayNumber)) + 1 : 1;
            const newDestId = idCounter++; 
            
            state.addDestination({
                id: newDestId, 
                address: resolvedAddress,
                lat: coords.lat, 
                lng: coords.lng, 
                phone: extractedPhone, 
                displayNumber: nextNum,
                storeName: finalStoreName || ""
            });
            
            state.saveActiveData(); 
            if (typeof window.renderList === 'function') window.renderList();

            // 🌟 새로 스캔된 배송지를 관제 센터 서버(routes/{deviceId})에도 즉시 동기화
            const driverPhone = localStorage.getItem('deliveryProUserPhone') || "";
            saveRouteToFirestore(deviceId, driverPhone, state.getDestinations());
            
            setTimeout(() => { 
                const newEl = document.querySelector(`li[data-id="${newDestId}"]`); 
                if (newEl) newEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); 
            }, 150);
        }
        e.target.value = ''; 
    });
}
