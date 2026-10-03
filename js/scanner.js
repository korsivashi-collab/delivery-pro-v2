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
    normalizeStoreMatchText,
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
// 한 번 받은 OCR 응답의 복사본을 고정한다. 각 파이프라인은 이 원본만 읽는다.
let ocrScanSequence = 0;
function createScanOCRSnapshot(ocrResult) {
    const pages = JSON.parse(JSON.stringify(ocrResult.pages || []));
    const freeze = value => {
        if (value && typeof value === 'object') {
            Object.values(value).forEach(freeze);
            Object.freeze(value);
        }
        return value;
    };
    return freeze({ scanId: `${Date.now()}-${++ocrScanSequence}`, rawOCRText: ocrResult.text || '', ocrPages: pages });
}

// 상호의 셀/라벨/신뢰도 규칙은 그대로 유지하고 주소 결과에 의존하는 실행 조건만 분리.
function extractScanStoreOCR(snapshot) {
    let finalStoreName = null;
    const storeDecision = {
        rawOCRText: snapshot.rawOCRText, layoutCandidate: null, textCandidate: null,
        kakaoMatched: false, selected: null, source: ''
    };
    try {
                // 3-1. 2D 좌표 기반 상호 추출 (회전 대응)
                let layoutResult = { name: null, candidates: [] };
                try { 
                    layoutResult = extractStoreNameByLayout(snapshot.ocrPages); 
                } catch (err) {}
                storeDecision.layoutCandidate = layoutResult.name;

                // 3-2. 명시적 상호 라벨의 텍스트 값 추출
                let storeOCRText = snapshot.rawOCRText;
                for (const segment of [...(layoutResult.excludedTextSegments || [])].sort((a, b) => b.start - a.start)) {
                    storeOCRText = storeOCRText.slice(0, segment.start) + storeOCRText.slice(segment.start, segment.end).replace(/[^\r\n]/g, ' ') + storeOCRText.slice(segment.end);
                }
                let textStore = null;
                try { 
                    textStore = extractStoreNameLogic(storeOCRText); 
                } catch (err) {}
                storeDecision.textCandidate = textStore;

                // 후보 풀 구성 (레이아웃 상호 -> 텍스트 영역 상호)
                const ocrCandidates = [...new Set([layoutResult.name, ...(layoutResult.candidates || []).map(c => c.name), textStore].filter(Boolean))];
                const normalizedCandidates = [...new Set(ocrCandidates.map(normalizeStoreMatchText))];
                const assessments = ocrCandidates.map(name => assessOCRStoreCandidate(name, storeOCRText));
                const trusted = assessments.filter(a => a.trustworthy && !isInvalidStoreCandidate(a.name));
                const agreement = layoutResult.name && textStore && normalizeStoreMatchText(layoutResult.name) === normalizeStoreMatchText(textStore);
                const clearCell = (layoutResult.candidates || []).some(c => c.name === layoutResult.name && c.cell?.confidenceReliable);
                const unambiguous = normalizedCandidates.length === 1 && trusted.length > 0;
                storeDecision.assessments = assessments;
                storeDecision.kakaoCalled = false;
                if (unambiguous && (agreement || clearCell || trusted.length === 1)) {
                    finalStoreName = layoutResult.name || trusted[0].name;
                    storeDecision.source = agreement ? 'ocr-agreement' : clearCell ? 'ocr-cell' : 'ocr-trusted';
                }

        return { finalStoreName, storeDecision, ocrCandidates, unambiguous, trusted };
    } catch (error) {
        console.error('상호 추출 오류:', error);
        return { finalStoreName: null, storeDecision, ocrCandidates: [], unambiguous: false, trusted: [] };
    }
}

function runScanOCRPipelines(snapshot) {
    let address = null, phone = null;
    const addressDetails = { scanId: snapshot.scanId };
    // 하나의 추출 실패가 다른 필드의 추출을 막지 않는다.
    try { address = extractAddressLogic(snapshot.rawOCRText, addressDetails); }
    catch (error) { console.error('주소 추출 오류:', error); }
    const store = extractScanStoreOCR(snapshot);
    try { phone = extractPhoneLogic(snapshot.rawOCRText); }
    catch (error) { console.error('전화번호 추출 오류:', error); }
    console.log('[OCR진단-독립파이프라인]', {
        scanId: snapshot.scanId,
        rawOCRText: snapshot.rawOCRText,
        legacyAddress: addressDetails.legacyAddress ?? null,
        labeledAddress: addressDetails.labeledAddress ?? null,
        sourceFrozen: Object.isFrozen(snapshot) && Object.isFrozen(snapshot.ocrPages),
        address, storeName: store.finalStoreName, phone,
        layoutCandidate: store.storeDecision.layoutCandidate,
        textCandidate: store.storeDecision.textCandidate,
        storeCandidates: [...store.ocrCandidates],
        stage: '주소 수동 보정/geocode/Kakao 교차검증 이전'
    });
    return { address, store, phone, scanId: snapshot.scanId,
        legacyAddress: addressDetails.legacyAddress ?? null,
        labeledAddress: addressDetails.labeledAddress ?? null,
        labeledStoreName: store.finalStoreName };
}

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
        let ocrFields = null;
        let manualAddress = null;
        let kakaoPlaceSearchAttempted = false;
        
        // 1단계: OCR 원격 판독 (텍스트 및 공간 좌표 추출)
        showLoading("사진 판독 중...");
        try {
            const base64Image = await toBase64_SafeCompress(file);
            const imageContent = base64Image.split(',')[1];
            const ocrResult = await performOCR(imageContent, true);
            
            const ocrSnapshot = createScanOCRSnapshot(ocrResult);
            rawOCRText = ocrSnapshot.rawOCRText;
            ocrPages = ocrSnapshot.ocrPages;
            ocrFields = runScanOCRPipelines(ocrSnapshot);
            
            addressStr = ocrFields.address;
            console.log('[주소진단-1 OCR파싱]', {
                rawOCRText,
                addressStr
            });
            extractedPhone = ocrFields.phone;
            hideLoading();
        } catch (error) {
            hideLoading();
            const result = await promptAddressCustom("사진 인식 실패", "", "", false);
            if (!result || !result.address) { e.target.value = ''; return; }
            manualAddress = result.address;
            addressStr = manualAddress; 
            extractedPhone = result.phone;
        }

        if (!addressStr && rawOCRText) {
            let snippet = rawOCRText.replace(/\n/g, ' ').substring(0, 40);
            const result = await promptAddressCustom(snippet + "...", "", extractedPhone, false);
            if (!result || !result.address) { e.target.value = ''; return; }
            manualAddress = result.address;
            addressStr = manualAddress; 
            extractedPhone = result.phone;
        }

        // 2단계: 카카오 주소 지오코딩 (위도/경도 좌표 획득)
        let coords = null;
        while (!coords) {
            try {
                showLoading("지도 위치 확인 중...");
                coords = await geocodeAddress(addressStr);
                console.log('[주소진단-2 GEOCODE]', {
                    addressStr,
                    coords
                });
                hideLoading();
            } catch (error) {
                hideLoading();
                const result = await promptAddressCustom("지도에서 주소를 찾을 수 없습니다.", addressStr, extractedPhone, true);
                if (!result || !result.address) { e.target.value = ''; return; }
                manualAddress = result.address;
            addressStr = manualAddress; 
                extractedPhone = result.phone;
            }
        }

        // 3단계: 독립 OCR 후보를 유지한 채 필요한 Kakao 교차검증만 최종 단계에서 수행.
        const storeOCR = ocrFields?.store || {
            finalStoreName: null, ocrCandidates: [], unambiguous: false, trusted: [],
            storeDecision: { rawOCRText, layoutCandidate: null, textCandidate: null,
                kakaoMatched: false, selected: null, source: '', kakaoCalled: false }
        };
        let finalStoreName = storeOCR.finalStoreName;
        const storeDecision = storeOCR.storeDecision;
        const { ocrCandidates, unambiguous, trusted } = storeOCR;

        if (rawOCRText) {
            showLoading("상호명 분석 중...");
            try {
                // 최신 기준본의 OCR 상호 선택을 우선 유지한다.
                if (!finalStoreName) {
                    const validOcrCandidate = trusted.length > 0 ? trusted[0].name : (ocrCandidates.length > 0 ? ocrCandidates[0] : null);
                    if (validOcrCandidate) {
                        finalStoreName = validOcrCandidate;
                        storeDecision.source = 'ocr-direct-only';
                    }
                }

                // OCR 최종 상호가 비었을 때만 원문 교차검증용 장소 조회를 최대 1회 수행.
                if ((!finalStoreName || !finalStoreName.trim()) && addressStr && !kakaoPlaceSearchAttempted) {
                    finalStoreName = null;
                    kakaoPlaceSearchAttempted = true;
                    storeDecision.kakaoCalled = true;
                    storeDecision.kakaoCallCount = 1;
                    try {
                        const kakaoResult = await getPOIsByAddress(addressStr, true);
                        storeDecision.kakaoCandidates = kakaoResult.places || [];
                        finalStoreName = matchOCRStoreCandidate(
                            ocrCandidates, storeDecision.kakaoCandidates,
                            STORE_NAME_MATCH_THRESHOLD, rawOCRText, storeDecision
                        );
                        storeDecision.kakaoMatched = Boolean(finalStoreName);
                        storeDecision.source = finalStoreName ? 'kakao-raw-ocr-match' : 'kakao-fallback-unmatched';
                    } catch (error) {
                        storeDecision.kakaoMatched = false;
                        storeDecision.source = 'kakao-fallback-failed';
                    }
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
            let finalAddress = manualAddress || ocrFields?.legacyAddress || ocrFields?.labeledAddress || addressStr;
            const labeledStoreName = finalStoreName || '';
            const finalPhone = extractedPhone;
            
            // 리스트 UI 표출을 위해 순수 주소 앞에 [상호명]을 강제 결합
            if (labeledStoreName && !finalAddress.startsWith('[')) {
                finalAddress = `[${labeledStoreName}] ${finalAddress}`;
            }

            console.log('[주소진단-3 최종주소]', {
                scanId: ocrFields?.scanId, addressStr, manualAddress,
                legacyAddress: ocrFields?.legacyAddress ?? null,
                labeledAddress: ocrFields?.labeledAddress ?? null,
                address_name: coords?.address_name, resolvedAddress: finalAddress
            });
            console.log('[OCR진단-최종조합]', {
                scanId: ocrFields?.scanId,
                legacyAddress: ocrFields?.legacyAddress ?? null,
                labeledAddress: ocrFields?.labeledAddress ?? null,
                manualAddress, labeledStoreName, phone: finalPhone,
                parsedAddress: ocrFields?.address ?? null,
                geocodeInput: addressStr, geocodeAddressName: coords?.address_name,
                finalAddress, finalStoreName: labeledStoreName, finalPhone,
                addressChangedInCombination: Boolean(ocrFields?.address && finalAddress !== ocrFields.address),
                source: manualAddress ? 'manual' : ocrFields?.legacyAddress ? 'legacy' : ocrFields?.labeledAddress ? 'labeled' : 'manual'
            });

            const currentDests = state.getDestinations();
            let nextNum = currentDests.length > 0 ? Math.max(...currentDests.map(d => d.displayNumber)) + 1 : 1;
            const requestedId = idCounter++;
            
            const addedDestination = state.addDestination({
                id: requestedId,
                address: finalAddress,
                lat: coords.lat, 
                lng: coords.lng, 
                phone: finalPhone, 
                displayNumber: nextNum,
                storeName: labeledStoreName
            });
            const newDestId = addedDestination.id;
            
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
