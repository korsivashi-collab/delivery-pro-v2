// js/state.js

// =================================================================
// [배송 동선 PRO] 공용 상태(데이터) 저장소
// 배송지 목록, 시작/종료 위치, GPS 정보를 안전하게 중앙 관리합니다.
// =================================================================

let destinations = [];
let endLocation = { lat: 0, lng: 0, address: "" }; 
let startLocation = null;
let routeOwnerId = null;
let routeUpdatedAt = 0;
let onActiveDataSaved = null;
let lastKnownGps = null;
// One watcher cache window (15s) plus its acquisition timeout (15s).
export const GPS_CACHE_MAX_AGE_MS = 30000;
let gpsValidAfter = 0;
let gpsWatchId = null;
let lastGeneratedDestinationId = 0;
const LOCAL_TRANSACTION_KEY = 'deliveryPro_local_transaction';
let committedMemory = null;
let localTransaction = null;

function memorySnapshot(updatedAt = routeUpdatedAt) {
    return JSON.stringify({ destinations, endLocation, startLocation, routeUpdatedAt: updatedAt });
}

function restoreMemory(snapshot) {
    if (!snapshot) return;
    const saved = JSON.parse(snapshot);
    destinations = saved.destinations;
    endLocation = saved.endLocation;
    startLocation = saved.startLocation;
    routeUpdatedAt = saved.routeUpdatedAt;
}

function restoreLocalValues(before) {
    let restored = true;
    for (const [key, value] of Object.entries(before)) {
        try {
            if (value === null && typeof localStorage.removeItem === 'function') localStorage.removeItem(key);
            else localStorage.setItem(key, value === null ? '' : value);
        } catch (_) { restored = false; }
    }
    if (restored) {
        try { localStorage.setItem(LOCAL_TRANSACTION_KEY, ''); }
        catch (_) { restored = false; }
    }
    return restored;
}

function pendingLocalRecovery() {
    const raw = localStorage.getItem(LOCAL_TRANSACTION_KEY);
    if (!raw) return null;
    const journal = JSON.parse(raw);
    const allowed = ['deliveryPro_active_destinations', 'deliveryPro_end_location', 'deliveryPro_route_metadata', 'deliveryPro_history', 'deliveryPro_transmissions'];
    if (journal.version !== 1 || !journal.before ||
        !Object.entries(journal.before).every(([key, value]) => allowed.includes(key) && (value === null || typeof value === 'string'))) {
        throw new Error('로컬 복구 기록을 확인할 수 없습니다.');
    }
    return journal.before;
}

function writeLocalValues(values) {
    const pending = pendingLocalRecovery();
    if (pending && !restoreLocalValues(pending)) throw new Error('이전 로컬 저장 복구가 필요합니다.');
    const before = Object.fromEntries(Object.keys(values).map(key => [key, localStorage.getItem(key)]));
    // All new values and the undo record have already been serialized before any write.
    localStorage.setItem(LOCAL_TRANSACTION_KEY, JSON.stringify({ version: 1, before }));
    try {
        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
        // Clearing the undo record is the commit point. Until then recovery reads the old state.
        localStorage.setItem(LOCAL_TRANSACTION_KEY, '');
    } catch (error) {
        restoreLocalValues(before);
        throw error;
    }
}

function safeDeliveryText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
}

function coordinateNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') return Number(value);
    return NaN;
}

export function hasValidDeliveryCoordinates(location) {
    return !!location && Number.isFinite(location.lat) && Number.isFinite(location.lng) &&
        Math.abs(location.lat) <= 90 && Math.abs(location.lng) <= 180 &&
        !(location.lat === 0 && location.lng === 0);
}

function normalizeDeliveryObject(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const changes = {};
    for (const field of ['address', 'storeName', 'phone', 'name']) {
        if (field !== 'address' && !(field in item)) continue;
        const text = safeDeliveryText(item[field]);
        if (text !== item[field]) changes[field] = text;
    }
    const coordinates = { lat: coordinateNumber(item.lat), lng: coordinateNumber(item.lng) };
    // Null coordinates retain the delivery for address correction, never as a real map point.
    const lat = hasValidDeliveryCoordinates(coordinates) ? coordinates.lat : null;
    const lng = hasValidDeliveryCoordinates(coordinates) ? coordinates.lng : null;
    if (item.lat !== lat) changes.lat = lat;
    if (item.lng !== lng) changes.lng = lng;
    if ('progress' in item && !Number.isFinite(item.progress)) changes.progress = undefined;
    if (!Object.keys(changes).length) return item;
    const normalized = { ...item, ...changes };
    if (changes.progress === undefined && 'progress' in changes) delete normalized.progress;
    return normalized;
}

function normalizeDeliveryList(list) {
    if (!Array.isArray(list)) return [];
    let changed = false;
    const normalized = [];
    for (const item of list) {
        const validItem = normalizeDeliveryObject(item);
        if (validItem !== item || !validItem) changed = true;
        if (validItem) normalized.push(validItem);
    }
    return ensureUniqueDestinationIds(changed ? normalized : list);
}

// 사용자 선택은 배송지 ID에 연결한다. 목록의 첫 항목은 선택 여부의 근거가 아니다.
function reconcileStartLocation() {
    if (!startLocation) return;
    const selected = destinations.find(d => d.id === startLocation.id);
    if (!hasValidDeliveryCoordinates(selected)) { startLocation = null; return; }
    if (startLocation.lat !== selected.lat || startLocation.lng !== selected.lng || startLocation.address !== selected.address) {
        startLocation = { id: selected.id, lat: selected.lat, lng: selected.lng, address: selected.address };
    }
}

function isDestinationId(id) {
    return (typeof id === 'number' && Number.isSafeInteger(id)) ||
        (typeof id === 'string' && id.trim().length > 0);
}

function createDestinationId(reservedIds) {
    let id = Math.max(Date.now(), lastGeneratedDestinationId + 1);
    while (reservedIds.has(String(id))) id++;
    lastGeneratedDestinationId = id;
    return id;
}

// DOM IDs use string keys too, so numeric 1 and string "1" must not coexist.
// Reserve the entire input first so repairs never replace a later valid ID.
function ensureUniqueDestinationIds(list) {
    const reservedIds = new Set(list.filter(item => item && isDestinationId(item.id)).map(item => String(item.id)));
    const seenIds = new Set();
    let changed = false;
    const normalized = list.map(item => {
        if (!item || typeof item !== 'object') return item;
        if (isDestinationId(item.id) && !seenIds.has(String(item.id))) {
            seenIds.add(String(item.id));
            return item;
        }
        const id = createDestinationId(reservedIds);
        reservedIds.add(String(id));
        seenIds.add(String(id));
        changed = true;
        return { ...item, id };
    });
    return changed ? normalized : list;
}

export function destinationIdAttribute(id) {
    return String(id).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Preserve legacy string IDs and their type when used in inline button handlers.
export function destinationIdArgument(id) {
    return destinationIdAttribute(JSON.stringify(id));
}

export const state = {
    getRouteOwnerId() { return routeOwnerId; },
    getRouteUpdatedAt() { return routeUpdatedAt; },
    setActiveDataSavedHandler(handler) { onActiveDataSaved = handler; },
    activateRouteOwner(ownerId) {
        if (routeOwnerId !== (ownerId || null)) this.deactivateRouteOwner();
        routeOwnerId = ownerId || null;
        this.loadActiveData();
    },
    deactivateRouteOwner() {
        routeOwnerId = null;
        routeUpdatedAt = 0;
        destinations = [];
        endLocation = { lat: 0, lng: 0, address: '' };
        startLocation = null;
        committedMemory = memorySnapshot();
    },
    reportStorageFailure(error) {
        console.error('배송 데이터 로컬 저장 실패:', error);
        if (typeof alert === 'function') alert('기기에 배송 데이터를 저장하지 못했습니다. 마지막으로 저장된 상태를 유지합니다. 저장 공간과 저장소 접근 상태를 확인한 후 다시 시도해 주세요.');
        try { if (typeof window !== 'undefined' && typeof window.renderList === 'function') window.renderList(); } catch (_) {}
    },
    readLocalData(key) {
        const before = pendingLocalRecovery();
        if (before) {
            restoreLocalValues(before);
            if (Object.prototype.hasOwnProperty.call(before, key)) return before[key];
        }
        return localStorage.getItem(key);
    },
    writeLocalHistory(history) {
        if (localTransaction) { localTransaction.history = history; return true; }
        try { writeLocalValues({ deliveryPro_history: JSON.stringify(history) }); return true; }
        catch (error) { this.reportStorageFailure(error); return false; }
    },
    writeTransmissions(queue, history = undefined) {
        if (localTransaction) {
            localTransaction.transmissions = queue;
            if (history !== undefined) localTransaction.history = history;
            return true;
        }
        try {
            const values = { deliveryPro_transmissions: JSON.stringify(queue) };
            if (history !== undefined) values.deliveryPro_history = JSON.stringify(history);
            writeLocalValues(values);
            return true;
        } catch (error) {
            // Background bookkeeping must retain the previous queue and never show a network popup.
            console.error('전송대기 로컬 저장 실패:', error);
            return false;
        }
    },
    runLocalTransaction(change) {
        const before = committedMemory;
        if (localTransaction) throw new Error('로컬 저장 작업이 이미 진행 중입니다.');
        localTransaction = {};
        try {
            change();
            const history = localTransaction.history;
            const transmissions = localTransaction.transmissions;
            localTransaction = null;
            return this.saveActiveData(null, history, transmissions);
        } catch (error) {
            localTransaction = null;
            restoreMemory(before);
            this.reportStorageFailure(error);
            return false;
        }
    },

    // 1. 배송지 목록(destinations) 관리
    getDestinations() {
        return destinations;
    },
    setDestinations(newList) {
        destinations = normalizeDeliveryList(newList);
        reconcileStartLocation();
    },
    addDestination(item, { prepend = false } = {}) {
        item = normalizeDeliveryObject(item);
        if (!item) return null;
        const reservedIds = new Set(destinations.map(destination => String(destination.id)));
        const addedItem = isDestinationId(item.id) && !reservedIds.has(String(item.id))
            ? item : { ...item, id: createDestinationId(reservedIds) };
        if (prepend) destinations.unshift(addedItem);
        else destinations.push(addedItem);
        return addedItem;
    },
    removeDestination(id) {
        destinations = destinations.filter(d => d.id !== id);
        reconcileStartLocation();
    },

    // 2. 종료 지점(endLocation) 관리
    getEndLocation() {
        return endLocation;
    },
    setEndLocation(loc) {
        // Existing empty endpoint sentinel is configuration, not a delivery coordinate.
        endLocation = loc && loc.lat === 0 && loc.lng === 0 && loc.address === ''
            ? loc : normalizeDeliveryObject(loc) || { lat: 0, lng: 0, address: '' };
    },

    // 3. 시작 지점(startLocation) 관리
    getStartLocation() {
        reconcileStartLocation();
        return startLocation;
    },
    setStartLocation(loc) {
        const normalized = normalizeDeliveryObject(loc);
        // 기존 좌표형 호출도 정확히 하나의 배송지와 일치할 때만 연결한다.
        const matches = normalized ? destinations.filter(d => normalized.id !== undefined
            ? d.id === normalized.id
            : d.lat === normalized.lat && d.lng === normalized.lng && d.address === normalized.address) : [];
        const selected = matches.length === 1 ? matches[0] : null;
        startLocation = hasValidDeliveryCoordinates(selected)
            ? { id: selected.id, lat: selected.lat, lng: selected.lng, address: selected.address } : null;
    },

    // 4. GPS 센서 상태 관리
    getLastKnownGps() {
        return this.isFreshGps(lastKnownGps) ? lastKnownGps : null;
    },
    setLastKnownGps(gps) {
        if (!gps) {
            lastKnownGps = null;
            gpsValidAfter = Date.now();
            return false;
        }
        if (!this.isFreshGps(gps)) return false;
        lastKnownGps = { ...gps };
        return true;
    },
    isFreshGps(gps) {
        if (!hasValidDeliveryCoordinates(gps) || !Number.isFinite(gps.timestamp)) return false;
        const age = Date.now() - gps.timestamp;
        return gps.timestamp >= gpsValidAfter && age >= 0 && age <= GPS_CACHE_MAX_AGE_MS &&
            (gps.accuracy === undefined || (Number.isFinite(gps.accuracy) && gps.accuracy >= 0));
    },
    getGpsWatchId() {
        return gpsWatchId;
    },
    setGpsWatchId(id) {
        gpsWatchId = id;
    },

    // 5. 로컬스토리지에 현재 작업 데이터 저장
    saveActiveData(updatedAt = null, history = undefined, transmissions = undefined) {
        if (localTransaction) return true;
        if (!routeOwnerId) return false;
        try {
            reconcileStartLocation();
            const revision = updatedAt === null ? Math.max(Date.now(), routeUpdatedAt + 1) : updatedAt;
            const snapshot = memorySnapshot(revision);
            const values = {};
            if (history !== undefined) values.deliveryPro_history = JSON.stringify(history);
            if (transmissions !== undefined) values.deliveryPro_transmissions = JSON.stringify(transmissions);
            values.deliveryPro_active_destinations = JSON.stringify(destinations);
            values.deliveryPro_end_location = JSON.stringify(endLocation);
            values.deliveryPro_route_metadata = JSON.stringify({ routeOwnerId, updatedAt: revision, destinations, endLocation,
                startSelected: startLocation !== null, startLocation });
            writeLocalValues(values);
            routeUpdatedAt = revision;
            committedMemory = snapshot;
        } catch (error) {
            restoreMemory(committedMemory);
            this.reportStorageFailure(error);
            return false;
        }
        if (updatedAt === null && onActiveDataSaved) onActiveDataSaved();
        return true;
    },

    // 소유자 없는 기존 캐시는 추측해서 가져오지 않습니다.
    loadActiveData() {
        try {
            const metadata = JSON.parse(this.readLocalData('deliveryPro_route_metadata') || 'null');
            destinations = [];
            endLocation = { lat: 0, lng: 0, address: '' };
            startLocation = null;
            routeUpdatedAt = 0;
            committedMemory = memorySnapshot();
            if (!metadata || metadata.routeOwnerId !== routeOwnerId || !Number.isFinite(metadata.updatedAt)) return;
            // 하나의 소유자 스냅샷을 읽어 다른 탭의 별도 키 쓰기와 섞이지 않게 합니다.
            const savedList = metadata.destinations;
            if (!Array.isArray(savedList)) return;
            destinations = normalizeDeliveryList(savedList);
            const savedEnd = metadata.endLocation;
            this.setEndLocation(savedEnd || endLocation);
            routeUpdatedAt = metadata.updatedAt;
            if (metadata.startSelected === true && isDestinationId(metadata.startLocation?.id)) this.setStartLocation(metadata.startLocation);
            committedMemory = memorySnapshot();
            // Persist repaired input without advancing the server revision.
            if (destinations !== savedList || endLocation !== savedEnd) this.saveActiveData(routeUpdatedAt);
        } catch (error) {
            this.reportStorageFailure(error);
        }
    },

    // 7. 배송 순번(1, 2, 3...) 번호 재정렬 및 자동 저장
    updateDisplayNumbers(updatedAt = null) {
        destinations = destinations.filter(d => d != null);
        destinations.forEach((d, i) => {
            d.displayNumber = i + 1;
        });
        return this.saveActiveData(updatedAt);
    }
};
