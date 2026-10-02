// js/scanner.js

// =================================================================
// [배송 동선 PRO] 카메라 스캔 및 AI 하이브리드 주소/상호명 매칭 전담 모듈
// ==========================================
import { 
    toBase64_SafeCompress, 
    extractPhoneLogic, 
    extractAddressLogic, 
    extractStoreNameLogic,
    extractStoreNameByLayout,
    isInvalidStoreCandidate,
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

    const deviceId = getOrCreateDeviceId();
    const driverPhone = localStorage.getItem('deliveryProUserPhone') || "";
    saveRouteToFirestore(deviceId, driverPhone, state.getDestinations());
}

// ==========================================
// 5. 카메라 스캔 및 AI 하이브리드 판독 파이프라인
// ==========================================
export function initCameraScan() {
    const cameraInput = document.getElementById('camera-input');
    if (!cameraInput) return;
    
    cameraInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // 계정 유효성 검증
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
        
        // 1단계: OCR 원격 판독 (텍스트 및 공간 좌표 추출)
        showLoading("사진 판독 중...");
        try {
            const base64Image = await toBase64_SafeCompress(file);
            const imageContent = base64Image.split(',')[1];
            const ocrResult = await performOCR(imageContent, true);
            
            rawOCRText = ocrResult.text || "";
            ocrPages = ocrResult.pages || [];
            
            addressStr = extractAddressLogic(rawOCRText);
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

        // 2단계: 카카오 주소 지오코딩 (위도/경도 좌표 획득)
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

        // 3단계: 범용 상호명 다중 슬롯 추출 및 카카오 매칭
        let finalStoreName = null;
        const storeDecision = { 
            rawOCRText, 
            layoutCandidate: null, 
            textCandidate: null, 
            kakaoMatched: false,
            selected: null,
            source: '' 
        };

        if (addressStr && rawOCRText) {
            showLoading("상호명 분석 중...");
            try {
                // 3-1. 2D 좌표 기반 상호 추출 (회전 대응)
                let layoutResult = { name: null, candidates: [] };
                try { 
                    layoutResult = extractStoreNameByLayout(ocrPages); 
                } catch (err) {}
                storeDecision.layoutCandidate = layoutResult.name;

                // 3-2. 배송처 영역(Recipient Zone) 및 주소 후미 상호 추출
                let textStore = null;
                try { 
                    textStore = extractStoreNameLogic(rawOCRText); 
                } catch (err) {}
                storeDecision.textCandidate = textStore;

                // 후보 풀 구성 (레이아웃 상호 -> 텍스트 영역 상호)
                const ocrCandidates = [...new Set([layoutResult.name, textStore].filter(Boolean))];

                // 3-3. 카카오 POI 조회 (보정용 교차 검증)
                let kakaoResult = { places: [], buildingNames: [] };
                try {
                    kakaoResult = await getPOIsByAddress(addressStr, true);
                } catch (err) {}

                // [경로 A] 카카오 등록 장소와 70% 이상 일치 시 공식 장소명 채택
                if (ocrCandidates.length > 0 && kakaoResult.places && kakaoResult.places.length > 0) {
                    finalStoreName = matchOCRStoreCandidate(ocrCandidates, kakaoResult.places, STORE_NAME_MATCH_THRESHOLD, rawOCRText, storeDecision);
                    if (finalStoreName) {
                        storeDecision.kakaoMatched = true;
                        storeDecision.source = 'kakao-poi-match';
                    }
                }

                // [경로 B] 카카오 장소 검색에 없는 경우: OCR 추출 상호를 100% 보존 (절대 버리지 않음)
                if (!finalStoreName) {
                    const validOcrCandidate = ocrCandidates.find(c => !isInvalidStoreCandidate(c));
                    if (validOcrCandidate) {
                        finalStoreName = validOcrCandidate;
                        storeDecision.source = 'ocr-direct-fallback';
                    }
                }

                // [경로 C] 최후 보루: 카카오 공식 건물명이 단일하게 존재하는 경우
                if (!finalStoreName && kakaoResult.buildingNames && kakaoResult.buildingNames.length === 1) {
                    finalStoreName = kakaoResult.buildingNames[0];
                    storeDecision.source = 'kakao-building';
                }

            } catch (error) {
                console.error("상호 추출 오류:", error);
            }
            hideLoading();
        }

        storeDecision.selected = finalStoreName;
        logStoreNameDiagnostic('상호 최종 결정', storeDecision);

        // 4단계: 배송 목록 추가, 렌더링 및 관제 서버 실시간 동기화
        if (coords) {
            let resolvedAddress = coords.address_name || addressStr;
            
            // 상호명이 확인된 경우 [상호명] 주소 형식으로 조합
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

            // 관제 센터 서버(routes/{deviceId}) 실시간 동기화
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