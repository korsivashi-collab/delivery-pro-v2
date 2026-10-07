// js/scanner.js

// =================================================================
// [배송 동선 PRO] 카메라 스캔 및 Gemini 명세서 판독 전담 모듈
// ==========================================
import { performGeminiScan, imageFromDataUrl, buildGeminiDestination, GEMINI_SCAN_MODEL } from './scan-gemini.js';
import { normalizeDeliveryBaseAddress } from './address.js';
import { toBase64_SafeCompress, showLoading, hideLoading, withRequestDeadline, getPureAddress } from './utils.js';
import { geocodeAddress } from './kakao.js';
import { state, hasValidDeliveryCoordinates } from './state.js';
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
// 3. 주소 수동 입력/수정 모달
// ==========================================
let activeAddressModal = null;

export function promptAddressCustom(snippet, defaultText, defaultPhone = "", isEditMode = false, signal = null, defaultStoreName = null) {
    return new Promise((resolve) => {
        if (signal?.aborted) { resolve(null); return; }
        activeAddressModal?.cancel();
        const modal = document.getElementById('address-input-modal');
        const addrInput = document.getElementById('manual-address-input');
        const phoneInput = document.getElementById('manual-phone-input');
        const storeInput = document.getElementById('manual-store-name-input');
        const storeContainer = document.getElementById('manual-store-name-container');
        const editStoreName = isEditMode && defaultStoreName !== null;
        if (storeContainer) {
            if (editStoreName) storeContainer.classList.remove('hidden');
            else storeContainer.classList.add('hidden');
        }
        if (storeInput) storeInput.value = editStoreName ? defaultStoreName : '';
        const snippetEl = document.getElementById('scan-snippet');
        const snippetContainer = document.getElementById('scan-snippet-container');
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
        
        const focusTimer = setTimeout(() => { if (addrInput) addrInput.focus(); }, 100);

        let settled = false;
        const request = { cancel: () => onCancel() };
        activeAddressModal = request;
        const onConfirm = () => {
            if (settled) return; settled = true;
            cleanup(); 
            resolve({ address: addrInput.value.trim(), phone: phoneInput.value.trim(),
                ...(editStoreName ? { storeName: storeInput ? storeInput.value.trim() : defaultStoreName } : {}) });
        };
        const onCancel = () => {
            if (settled) return; settled = true;
            cleanup(); 
            resolve(null); 
        };
        const cleanup = () => { 
            clearTimeout(focusTimer);
            if (activeAddressModal === request) activeAddressModal = null;
            signal?.removeEventListener('abort', onCancel);
            btnConfirm.removeEventListener('click', onConfirm); 
            btnCancel.removeEventListener('click', onCancel); 
            if (modal) modal.classList.add('hidden'); 
        };
        
        btnConfirm.addEventListener('click', onConfirm); 
        btnCancel.addEventListener('click', onCancel);
        signal?.addEventListener('abort', onCancel, { once: true });
    });
}

// ==========================================
// 4. 배송지 상호/주소/전화번호 수정 액션 (관제 서버 동기화 포함)
// ==========================================
const activeAddressEdits = new Set();
let activeAddressEditLoading = null;
export async function editDestinationAddress(id) {
    if (activeAddressEdits.has(id)) return;
    const item = state.getDestinations().find(d => d.id === id);
    if (!item) return;
    const owner = state.getRouteOwnerId();
    const original = JSON.stringify(item);
    const addressPrefix = item.address.match(/^\[(.*?)\]\s*(.*)$/);
    // storeName is authoritative; bracket-only legacy records remain editable.
    const originalStoreName = item.storeName !== undefined ? String(item.storeName || '').trim() : addressPrefix?.[1].trim() || '';
    const hasStorePrefix = addressPrefix && addressPrefix[1].trim() === originalStoreName;
    const originalAddress = getPureAddress(item.address);
    const edit = {};
    activeAddressEdits.add(id);
    const stillCurrent = () => owner === state.getRouteOwnerId()
        && JSON.stringify(state.getDestinations().find(d => d.id === id)) === original;
    try {
        const result = await promptAddressCustom('', originalAddress, item.phone || '', true, null, originalStoreName);
        if (!result || !stillCurrent()) return;
        const newAddr = result.address, newPhone = result.phone;
        const newStoreName = typeof result.storeName === 'string' ? result.storeName : originalStoreName;
        const storeChanged = newStoreName !== originalStoreName;
        const phoneChanged = newPhone !== (item.phone || '');
        const nameOnly = storeChanged && newAddr === originalAddress && !phoneChanged;
        const addrChanged = newAddr !== originalAddress || (!nameOnly && !hasValidDeliveryCoordinates(item));
        if (!addrChanged && !phoneChanged && !storeChanged) return;
        let updated = { ...item, phone: newPhone, storeName: newStoreName };
        // Synchronize the existing display prefix without changing the physical address or coordinates.
        if (storeChanged && hasStorePrefix) updated.address = newStoreName ? `[${newStoreName}] ${addressPrefix[2]}` : addressPrefix[2];
        if (addrChanged) {
            activeAddressEditLoading = edit;
            showLoading('수정된 주소 확인 중...');
            try {
                const pureAddr = newAddr.replace(/\[.*?\]/g, '').trim();
                const coords = await geocodeAddress(pureAddr || newAddr.trim());
                if (!stillCurrent()) return;
                if (coords) {
                    const prefixMatch = newAddr.match(/^(\[.*?\])\s*/);
                    const prefix = addressPrefix
                        ? (hasStorePrefix ? (newStoreName ? `[${newStoreName}] ` : '') : `[${addressPrefix[1]}] `)
                        : (prefixMatch ? prefixMatch[1] + ' ' : '');
                    updated = { ...updated, address: prefix + (coords.address_name || pureAddr), lat: coords.lat, lng: coords.lng };
                }
            } catch (error) {
                if (stillCurrent()) alert('수정된 주소를 지도에서 찾을 수 없습니다.');
                return;
            } finally {
                if (activeAddressEditLoading === edit) { activeAddressEditLoading = null; hideLoading(); }
            }
        }
        if (!stillCurrent()) return;
        // 기다리는 동안 추가/삭제된 다른 배송지는 최신 목록에서 그대로 보존한다.
        state.setDestinations(state.getDestinations().map(d => d.id === id ? updated : d));
        if (!state.saveActiveData()) return;
        if (typeof window.renderList === 'function') window.renderList();
        const deviceId = getOrCreateDeviceId();
        const driverPhone = localStorage.getItem('deliveryProUserPhone') || '';
        saveRouteToFirestore(deviceId, driverPhone, state.getDestinations());
    } finally {
        activeAddressEdits.delete(id);
    }
}

// 🌟 주소 비교 헬퍼: 공백, 특수문자를 제거하고 핵심 문자열만 비교하여 부분 매칭(Fallback)을 감지합니다.
function isStrictMatch(geminiAddress, kakaoAddress) {
    if (!geminiAddress || !kakaoAddress) return false;
    const cleanG = geminiAddress.replace(/[^가-힣0-9]/g, '');
    const cleanK = kakaoAddress.replace(/[^가-힣0-9]/g, '');
    
    // 두 주소의 핵심 문자열이 정확히 일치하거나, 어느 한쪽이 다른 쪽을 온전히 포함하고 있어야 정상 판정
    return cleanG === cleanK || cleanG.includes(cleanK) || cleanK.includes(cleanG);
}

// ==========================================
// 5. 카메라 스캔 및 Gemini 판독 파이프라인
// ==========================================
let activeScanRequest = null;
const initializedCameraInputs = new WeakSet();

export function triggerCameraScan() {
    if (activeScanRequest && !activeScanRequest.controller.signal.aborted) return;
    const cameraInput = document.getElementById('camera-input');
    if (!cameraInput) return;
    try {
        // Keep the native picker launch synchronous with the user's button click.
        cameraInput.click();
    } catch (error) {
        cameraInput.value = '';
        console.error('카메라/파일 선택창 실행 실패:', error);
        alert('카메라 또는 파일 선택창을 열 수 없습니다. 다시 시도해 주세요.');
    }
}

export function initCameraScan() {
    const cameraInput = document.getElementById('camera-input');
    if (!cameraInput || initializedCameraInputs.has(cameraInput)) return;
    initializedCameraInputs.add(cameraInput);
    cameraInput.addEventListener('click', event => {
        if (activeScanRequest && !activeScanRequest.controller.signal.aborted) {
            event.preventDefault();
            return;
        }
        // A canceled picker may retain its old selection. Allow the same photo on retry.
        cameraInput.value = '';
    });
    cameraInput.addEventListener('cancel', () => {
        // Picker cancellation is not scan cancellation and must not abort an active scan.
        if (!activeScanRequest) cameraInput.value = '';
    });
    
    cameraInput.addEventListener('change', async (e) => {
        let file;
        try { file = e.target?.files?.[0]; }
        catch (error) {
            if (!activeScanRequest) {
                cameraInput.value = '';
                console.error('선택한 사진 접근 실패:', error);
                alert('사진을 불러올 수 없습니다. 다시 촬영하거나 선택해주세요.');
            }
            return;
        }
        if (!file) {
            if (!activeScanRequest) cameraInput.value = '';
            return;
        }
        if (activeScanRequest && !activeScanRequest.controller.signal.aborted && activeScanRequest.owner === state.getRouteOwnerId()) return;
        if (file.size === 0) {
            cameraInput.value = '';
            alert('선택한 사진이 비어 있습니다. 다시 촬영하거나 선택해주세요.');
            return;
        }
        activeScanRequest?.controller.abort();
        if (activeScanRequest?.loading) hideLoading();
        const scan = { controller: new AbortController(), owner: state.getRouteOwnerId(), loading: false,
            diagnostics: { model: GEMINI_SCAN_MODEL, stage: 'validation', geminiSuccess: false, deliveryAdded: false,
                manualAddressUsed: false, kakaoGeocodeAttemptCount: 0, kakaoRequestCount: 0, kakaoPlaceSearchCount: 0, errorCode: null } };
        activeScanRequest = scan;
        const signal = scan.controller.signal;
        const assertCurrent = () => {
            if (signal.aborted || activeScanRequest !== scan || scan.owner !== state.getRouteOwnerId()) {
                const error = new Error('스캔이 취소되었습니다.'); error.name = 'AbortError'; throw error;
            }
        };
        const showScanLoading = text => {
            assertCurrent(); scan.loading = true;
            showLoading(text, () => {
                scan.controller.abort();
                if (activeScanRequest === scan) { hideScanLoading(); activeScanRequest = null; e.target.value = ''; }
            });
        };
        const hideScanLoading = () => {
            if (activeScanRequest === scan && scan.loading) { scan.loading = false; hideLoading(); }
        };
        const promptScanAddress = async (...args) => {
            assertCurrent();
            const result = await promptAddressCustom(...args, signal);
            assertCurrent(); return result;
        };
        try {

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

        assertCurrent();
        if (!checkScanLimit()) { e.target.value = ''; return; }

        scan.diagnostics.stage = 'image';
        showScanLoading('명세서 판독 중...');
        const dataUrl = await withRequestDeadline(() => toBase64_SafeCompress(file, { preserveColor: true }),
            15000, { signal, label: '사진 준비' });
        assertCurrent();
        scan.diagnostics.stage = 'gemini';
        const fields = await performGeminiScan(imageFromDataUrl(dataUrl), { signal });
        assertCurrent();
        scan.diagnostics.geminiSuccess = true;
        scan.diagnostics.fieldsPresent = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value !== null]));
        hideScanLoading();
        let addressStr = normalizeDeliveryBaseAddress(fields.address), extractedPhone = fields.phone, manualAddress = null;
        if (!addressStr) {
            const result = await promptScanAddress('배송지 주소를 확인할 수 없습니다.', '', extractedPhone || '', false);
            if (!result || !result.address) return;
            manualAddress = result.address;
            addressStr = normalizeDeliveryBaseAddress(manualAddress);
            extractedPhone = result.phone;
            scan.diagnostics.manualAddressUsed = true;
        }
        let coords = null;
        scan.diagnostics.stage = 'geocode';
        while (!coords) {
            try {
                showScanLoading('지도 위치 확인 중...');
                scan.diagnostics.kakaoGeocodeAttemptCount++;
                coords = await geocodeAddress(addressStr, { signal,
                    onRequest: () => { scan.diagnostics.kakaoRequestCount++; } });
                assertCurrent();
                
                // 🌟 2차 방어선 (Strict Match 검증): 카카오가 찾은 주소와 원본 주소의 텍스트가 확연히 다르면 (부분 매칭/오타 발생)
                if (!isStrictMatch(addressStr, coords.address_name)) {
                    throw Object.assign(new Error('Address text mismatch'), { code: 'KAKAO_ADDRESS_MISMATCH', suggestion: coords.address_name });
                }

                if (!hasValidDeliveryCoordinates(coords)) throw Object.assign(new Error('Invalid coordinates'), { code: 'KAKAO_ADDRESS_ERROR' });
                hideScanLoading();
            } catch (error) {
                coords = null;
                hideScanLoading();
                if (error.name === 'AbortError') throw error;
                
                // 🌟 팝업 안내 분기 처리: 텍스트 불일치(오타)인지, 검색 완전 실패인지 구분
                let promptTitle = '지도에서 주소를 찾을 수 없습니다.';
                if (error.code === 'KAKAO_ADDRESS_MISMATCH') {
                    promptTitle = '인식된 주소가 불확실합니다. 확인해 주세요.';
                    // 카카오가 추천한 공식 주소를 팝업에 미리 채워주어 기사님이 한 번에 쉽게 수정할 수 있도록 돕습니다.
                    if (error.suggestion) addressStr = error.suggestion;
                }
                
                const result = await promptScanAddress(promptTitle, addressStr, extractedPhone || '', true);
                if (!result || !result.address) return;
                manualAddress = result.address;
                addressStr = normalizeDeliveryBaseAddress(manualAddress);
                extractedPhone = result.phone;
                scan.diagnostics.manualAddressUsed = true;
            }
        }
        // Gemini storeName is kept as returned, without Kakao store-name correction.
        assertCurrent();
        scan.diagnostics.stage = 'save';
        const currentDests = state.getDestinations();
        const nextNum = currentDests.length > 0 ? Math.max(...currentDests.map(d => d.displayNumber)) + 1 : 1;
        const added = state.addDestination(buildGeminiDestination({ ...fields, phone: extractedPhone },
            coords, idCounter++, nextNum, manualAddress), { prepend: true });
        if (!state.saveActiveData()) { scan.diagnostics.errorCode = 'LOCAL_SAVE_FAILED'; return; }
        scan.diagnostics.deliveryAdded = true;
        if (typeof window.renderList === 'function') window.renderList();
        saveRouteToFirestore(deviceId, localStorage.getItem('deliveryProUserPhone') || '', state.getDestinations());
        const newEl = document.querySelector('li[data-id="' + added.id + '"]');
        if (newEl) newEl.scrollIntoView({ behavior: 'auto', block: 'start' });
        } catch (error) {
            scan.diagnostics.errorCode = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code
                : error.name === 'AbortError' ? 'SCAN_ABORTED' : error.name === 'TimeoutError' ? 'SCAN_TIMEOUT' : 'SCAN_ERROR';
            if (error.name !== 'AbortError') alert('명세서 정보를 인식하지 못했습니다. 다시 촬영해 주세요.');
        } finally {
            console.debug('[Gemini 스캔 진단]', scan.diagnostics);
            if (activeScanRequest === scan) {
                hideScanLoading(); activeScanRequest = null; e.target.value = '';
            }
        }
    });
}