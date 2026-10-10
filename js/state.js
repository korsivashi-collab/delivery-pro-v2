// js/state.js
import { storageErrorContext, storageDiagnostic } from './storage-diagnostics.js';

// =================================================================
// [배송 동선 PRO] 공용 상태(데이터) 저장소
// 배송지 목록, 시작/종료 위치, GPS 정보를 안전하게 중앙 관리합니다.
// =================================================================

let destinations = [];
let endLocation = { lat: 0, lng: 0, address: "" }; 
let startLocation = null;
let routePlan = null;
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
    return serializeLocal('deliveryPro_route_metadata', { destinations, endLocation, startLocation, routePlan, routeUpdatedAt: updatedAt }, 'memorySnapshot');
}

function restoreMemory(snapshot) {
    if (!snapshot) return;
    const saved = JSON.parse(snapshot);
    destinations = saved.destinations;
    endLocation = saved.endLocation;
    startLocation = saved.startLocation;
    routePlan = saved.routePlan || null;
    routeUpdatedAt = saved.routeUpdatedAt;
}

function localCounts() {
    const count = key => { try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value.length : null; } catch (_) { return null; } };
    let journalLength = null;
    try { journalLength = (localStorage.getItem(LOCAL_TRANSACTION_KEY) || '').length; } catch (_) {}
    return { activeDestinationCount: destinations.length, historyCount: count('deliveryPro_history'), transmissionCount: count('deliveryPro_transmissions'), journalLength };
}

function serializeLocal(key, value, operation) {
    try { return JSON.stringify(value); }
    catch (error) {
        let oldLength = null;
        try { oldLength = localStorage.getItem(key)?.length || 0; } catch (_) {}
        throw storageErrorContext(error, { operation, stage: 'serialize', key, oldLength, ...localCounts() });
    }
}

function restoreLocalValues(before, context = {}) {
    let restored = true;
    // Free space before restoring values that grow. Keep the journal until every restore succeeds.
    const entries = Object.entries(before);
    const delta = ([key, value]) => { try { return (value?.length || 0) - (localStorage.getItem(key)?.length || 0); } catch (_) { return 0; } };
    entries.sort((a, b) => delta(a) - delta(b));
    for (const [key, value] of entries) {
        let oldLength = null;
        try {
            const current = localStorage.getItem(key);
            oldLength = current?.length || 0;
            if (current === value) continue;
            if (value === null && typeof localStorage.removeItem === 'function') localStorage.removeItem(key);
            else localStorage.setItem(key, value === null ? '' : value);
        } catch (error) {
            restored = false;
            console.error('배송 저장 복구 실패:', storageDiagnostic(error, { ...localCounts(), ...context, operation: 'restoreLocalValues', stage: 'rollback', key, oldLength, newLength: value?.length || 0 }));
        }
    }
    if (restored) {
        try { localStorage.setItem(LOCAL_TRANSACTION_KEY, ''); }
        catch (error) {
            restored = false;
            console.error('배송 저장 복구 실패:', storageDiagnostic(error, { ...localCounts(), ...context, operation: 'restoreLocalValues', stage: 'rollback', key: LOCAL_TRANSACTION_KEY, oldLength: context.journalLength ?? null, newLength: 0 }));
        }
    }
    return restored;
}

function pendingLocalRecovery() {
    let raw;
    try { raw = localStorage.getItem(LOCAL_TRANSACTION_KEY); }
    catch (error) { throw storageErrorContext(error, { operation: 'pendingLocalRecovery', stage: 'read-before', key: LOCAL_TRANSACTION_KEY }); }
    if (!raw) return null;
    let journal;
    try { journal = JSON.parse(raw); }
    catch (error) { throw storageErrorContext(error, { operation: 'pendingLocalRecovery', stage: 'read-before', key: LOCAL_TRANSACTION_KEY, journalLength: raw.length }); }
    const allowed = ['deliveryPro_active_destinations', 'deliveryPro_end_location', 'deliveryPro_route_metadata', 'deliveryPro_history', 'deliveryPro_transmissions'];
    if (!journal || journal.version !== 1 || !journal.before || typeof journal.before !== 'object' || Array.isArray(journal.before) ||
        !Object.entries(journal.before).every(([key, value]) => allowed.includes(key) && (value === null || typeof value === 'string'))) {
        throw storageErrorContext(new TypeError('로컬 복구 기록을 확인할 수 없습니다.'), { operation: 'pendingLocalRecovery', stage: 'read-before', key: LOCAL_TRANSACTION_KEY, journalLength: raw.length });
    }
    return journal.before;
}

function writeLocalValues(values, operation = 'writeLocalValues', counts = localCounts()) {
    const pending = pendingLocalRecovery();
    if (pending && !restoreLocalValues(pending)) throw storageErrorContext(new Error('이전 로컬 저장 복구가 필요합니다.'), { operation, stage: 'rollback', key: LOCAL_TRANSACTION_KEY });
    if (operation === 'saveActiveData') {
        // Resolve old journals first. The owned metadata is the sole read source, so these
        // unused copies can be retired before allocating a new journal, including on upgrade.
        for (const key of ['deliveryPro_active_destinations', 'deliveryPro_end_location']) {
            try { localStorage.removeItem(key); }
            catch (error) { console.error('배송 중복 캐시 정리 실패:', storageDiagnostic(error, { ...counts, operation: 'retireLegacyCache', stage: 'cleanup', key })); }
        }
    }
    const before = {}, changed = {}, lengths = {};
    for (const [key, value] of Object.entries(values)) {
        let old;
        try { old = localStorage.getItem(key); }
        catch (error) { throw storageErrorContext(error, { operation, stage: 'read-before', key, ...counts, newLength: value.length }); }
        lengths[key] = { oldLength: old?.length || 0, newLength: value.length };
        if (old !== value) { before[key] = old; changed[key] = value; }
    }
    if (!Object.keys(changed).length) return;
    // All new values and the undo record have already been serialized before any write.
    const journal = serializeLocal(LOCAL_TRANSACTION_KEY, { version: 1, before }, operation);
    const context = { operation, ...counts, lengths, journalLength: journal.length };
    try { localStorage.setItem(LOCAL_TRANSACTION_KEY, journal); }
    catch (error) { throw storageErrorContext(error, { ...context, stage: 'write-journal', key: LOCAL_TRANSACTION_KEY, oldLength: 0, newLength: journal.length }); }
    let stage = 'write-value', key = null;
    try {
        // Shrinking replacements first avoids a needless intermediate peak.
        const entries = Object.entries(changed).sort(([a], [b]) =>
            (lengths[a].newLength - lengths[a].oldLength) - (lengths[b].newLength - lengths[b].oldLength));
        for (const [entryKey, value] of entries) { key = entryKey; localStorage.setItem(key, value); }
        // Clearing the undo record is the commit point. Until then recovery reads the old state.
        stage = 'clear-journal'; key = LOCAL_TRANSACTION_KEY;
        localStorage.setItem(LOCAL_TRANSACTION_KEY, '');
    } catch (error) {
        restoreLocalValues(before, context);
        throw storageErrorContext(error, { ...context, stage, key,
            ...(lengths[key] || { oldLength: journal.length, newLength: 0 }) });
    }
    console.debug('배송 로컬 저장 완료:', { ...context, stage: 'committed' });
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

const copyPlanValue = value => JSON.parse(JSON.stringify(value));
const deliveryKey = item => String(item.id);
function routeDay() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; }
function ensureRoutePlan() {
    if (!routePlan) routePlan = { version: 1, routeId: `route-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        date: routeDay(), ownerId: routeOwnerId, baseline: null, orderIds: [], deliveries: [], changes: [] };
    return routePlan;
}
function recordPlanChange(action, id = null) {
    const plan = ensureRoutePlan();
    const index = destinations.findIndex(d => String(d.id) === String(id));
    plan.changes.push({ action, id, at: Date.now(), index, deliveryCount: destinations.length,
        previousId: index > 0 ? deliveryKey(destinations[index - 1]) : null,
        nextId: index >= 0 && index + 1 < destinations.length ? deliveryKey(destinations[index + 1]) : null });
    plan.changes = plan.changes.slice(-200);
}
// Replace only the active slots; inactive deliveries keep their historical relative positions.
function syncRoutePlan() {
    if (!routePlan && !destinations.length) return;
    const plan = ensureRoutePlan(), current = destinations.map(deliveryKey), active = new Set(current);
    const known = new Set(plan.orderIds), existing = current.filter(id => known.has(id));
    let next = 0;
    plan.orderIds = plan.orderIds.map(id => active.has(id) ? existing[next++] : id);
    for (let i = 0; i < current.length; i++) {
        const id = current[i]; if (known.has(id)) continue;
        const successor = current.slice(i + 1).find(key => plan.orderIds.includes(key));
        const before = successor === undefined ? plan.orderIds.length : plan.orderIds.indexOf(successor);
        plan.orderIds.splice(before, 0, id);
    }
    plan.orderIds = [...new Set(plan.orderIds)];
    for (const item of destinations) {
        let entry = plan.deliveries.find(d => d.id === deliveryKey(item));
        if (!entry) { entry = { id: deliveryKey(item), stateVersion: 0 }; plan.deliveries.push(entry); }
        // Full active information already lives in destinations; avoid a second memo/items cache.
        entry.item = { id: item.id, address: item.address || '', storeName: item.storeName || '', lat: item.lat, lng: item.lng };
        entry.status = 'active';
        entry.addedAfterBaseline = !!plan.baseline && !plan.baseline.orderIds.includes(entry.id);
    }
}
function insertionIndex(list, item, context) {
    const order = context?.orderIds || [], pivot = order.indexOf(deliveryKey(item));
    if (pivot < 0) return list.length;
    // Prefer the nearest surviving successor, otherwise the nearest surviving predecessor.
    for (let i = pivot + 1; i < order.length; i++) {
        const at = list.findIndex(d => deliveryKey(d) === order[i]); if (at >= 0) return at;
    }
    for (let i = pivot - 1; i >= 0; i--) {
        const at = list.findIndex(d => deliveryKey(d) === order[i]); if (at >= 0) return at + 1;
    }
    return list.length;
}

export const state = {
    // Text/attribute encoding and JSON-in-event encoding are separate operations.
    escapeHtml(value) { return destinationIdAttribute(value ?? ''); },
    inlineArgument(value) { return destinationIdArgument(value); },
    safePhotoUrl(value) {
        try {
            const url = new URL(String(value));
            return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
        } catch (_) { return ''; }
    },
    getRouteOwnerId() { return routeOwnerId; },
    getRouteUpdatedAt() { return routeUpdatedAt; },
    getRoutePlan() { return routePlan ? copyPlanValue(routePlan) : null; },
    prepareRemoteRoute(list, plan) {
        if (!plan && routePlan && list.length && !list.some(d => routePlan.orderIds.includes(String(d.id)))) routePlan = null;
        this.setRemoteRoutePlan(plan);
    },
    setRemoteRoutePlan(plan) {
        if (plan?.version === 1 && plan.ownerId === routeOwnerId && typeof plan.routeId === 'string' &&
            Array.isArray(plan.orderIds) && Array.isArray(plan.deliveries) && Array.isArray(plan.changes)) {
            routePlan = copyPlanValue(plan);
        }
    },
    captureRemoval(id, status = 'completed') {
        syncRoutePlan(); const plan = ensureRoutePlan();
        const entry = plan.deliveries.find(d => d.id === String(id));
        if (!entry) throw new Error('복구할 배송 정보를 찾을 수 없습니다.');
        entry.status = status; entry.stateVersion++;
        const context = { routeId: plan.routeId, ownerId: routeOwnerId, orderIds: [...plan.orderIds],
            stateVersion: entry.stateVersion, startLocation: startLocation ? { ...startLocation } : null };
        recordPlanChange(status, id);
        return context;
    },
    restoreDestination(item, context = null) {
        if (context && (context.ownerId !== routeOwnerId || context.routeId !== routePlan?.routeId)) {
            throw new Error('다른 날짜·경로의 배송입니다. 현재 경로로 복구할 수 없습니다.');
        }
        if (destinations.some(d => deliveryKey(d) === deliveryKey(item))) return destinations.find(d => deliveryKey(d) === deliveryKey(item));
        const restored = normalizeDeliveryObject({ ...item });
        const at = insertionIndex(destinations, restored, context);
        destinations.splice(at, 0, restored);
        if (!startLocation && context?.startLocation?.id === restored.id) this.setStartLocation(context.startLocation);
        if (startLocation) { const i = destinations.findIndex(d => d.id === startLocation.id); if (i > 0) destinations.unshift(destinations.splice(i, 1)[0]); }
        syncRoutePlan(); const entry = routePlan.deliveries.find(d => d.id === deliveryKey(restored));
        entry.stateVersion++; recordPlanChange('restore', restored.id);
        return restored;
    },
    captureInitialRoute() {
        syncRoutePlan(); const plan = ensureRoutePlan();
        if (!plan.baseline) plan.baseline = { orderIds: destinations.map(deliveryKey),
            deliveries: copyPlanValue(destinations.map((d, i) => ({ ...d, displayNumber: i + 1 }))), startLocation: copyPlanValue(startLocation),
            endLocation: copyPlanValue(endLocation), routeId: plan.routeId, confirmedAt: Date.now() };
        recordPlanChange('optimize');
    },
    moveDestination(id, direction) {
        const at = destinations.findIndex(d => d.id === id), target = at + direction;
        if (at < 0 || target < 0 || target >= destinations.length) return '목록의 끝이므로 더 이동할 수 없습니다.';
        if (startLocation && (destinations[at].id === startLocation.id || destinations[target].id === startLocation.id)) return '선택한 시작점은 첫 위치에 고정됩니다. 시작점을 변경하려면 시작점 선택을 사용하세요.';
        destinations = [...destinations];
        [destinations[at], destinations[target]] = [destinations[target], destinations[at]];
        syncRoutePlan(); recordPlanChange('move', id);
        return this.updateDisplayNumbers() ? null : '순서를 저장하지 못했습니다.';
    },
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
        routePlan = null;
        committedMemory = memorySnapshot();
    },
    reportStorageFailure(error, context = {}) {
        console.error('배송 데이터 로컬 저장 실패:', storageDiagnostic(error, { ...localCounts(), ...context }));
        if (typeof alert === 'function') alert('기기에 배송 데이터를 저장하지 못했습니다. 마지막으로 저장된 상태를 유지합니다. 저장 공간과 저장소 접근 상태를 확인한 후 다시 시도해 주세요.');
        try { if (typeof window !== 'undefined' && typeof window.renderList === 'function') window.renderList(); } catch (_) {}
    },
    readLocalData(key) {
        const before = pendingLocalRecovery();
        if (before) {
            restoreLocalValues(before);
            if (Object.prototype.hasOwnProperty.call(before, key)) return before[key];
        }
        try { return localStorage.getItem(key); }
        catch (error) { throw storageErrorContext(error, { operation: 'readLocalData', stage: 'read-before', key }); }
    },
    writeLocalHistory(history) {
        if (localTransaction) { localTransaction.history = history; return true; }
        try { writeLocalValues({ deliveryPro_history: serializeLocal('deliveryPro_history', history, 'writeLocalHistory') }, 'writeLocalHistory', { ...localCounts(), historyCount: history.length }); return true; }
        catch (error) { this.reportStorageFailure(error, { operation: 'writeLocalHistory' }); return false; }
    },
    writeTransmissions(queue, history = undefined) {
        if (localTransaction) {
            localTransaction.transmissions = queue;
            if (history !== undefined) localTransaction.history = history;
            return true;
        }
        try {
            const values = { deliveryPro_transmissions: serializeLocal('deliveryPro_transmissions', queue, 'writeTransmissions') };
            if (history !== undefined) values.deliveryPro_history = serializeLocal('deliveryPro_history', history, 'writeTransmissions');
            writeLocalValues(values, 'writeTransmissions', { ...localCounts(), transmissionCount: queue.length,
                ...(history !== undefined ? { historyCount: history.length } : {}) });
            return true;
        } catch (error) {
            // Background bookkeeping must retain the previous queue and never show a network popup.
            console.error('전송대기 로컬 저장 실패:', storageDiagnostic(error, { ...localCounts(), operation: 'writeTransmissions', stage: 'serialize' }));
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
            this.reportStorageFailure(error, { operation: 'runLocalTransaction', stage: 'logic' });
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
        if (!destinations.length && routePlan && routePlan.date !== routeDay()) routePlan = null;
        const reservedIds = new Set([...destinations.map(destination => String(destination.id)), ...(routePlan?.orderIds || [])]);
        const addedItem = isDestinationId(item.id) && !reservedIds.has(String(item.id))
            ? item : { ...item, id: createDestinationId(reservedIds) };
        if (prepend && !startLocation) destinations.unshift(addedItem);
        else if (prepend && startLocation) destinations.splice(1, 0, addedItem);
        else destinations.push(addedItem);
        syncRoutePlan(); recordPlanChange('add', addedItem.id);
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
            syncRoutePlan();
            const revision = updatedAt === null ? Math.max(Date.now(), routeUpdatedAt + 1) : updatedAt;
            const snapshot = memorySnapshot(revision);
            const values = {};
            if (history !== undefined) values.deliveryPro_history = serializeLocal('deliveryPro_history', history, 'saveActiveData');
            if (transmissions !== undefined) values.deliveryPro_transmissions = serializeLocal('deliveryPro_transmissions', transmissions, 'saveActiveData');
            // loadActiveData already reads only this owned snapshot.
            values.deliveryPro_route_metadata = serializeLocal('deliveryPro_route_metadata', { routeOwnerId, updatedAt: revision, destinations, endLocation,
                startSelected: startLocation !== null, startLocation, routePlan }, 'saveActiveData');
            writeLocalValues(values, 'saveActiveData', { ...localCounts(),
                ...(history !== undefined ? { historyCount: history.length } : {}),
                ...(transmissions !== undefined ? { transmissionCount: transmissions.length } : {}) });
            routeUpdatedAt = revision;
            committedMemory = snapshot;
        } catch (error) {
            restoreMemory(committedMemory);
            this.reportStorageFailure(error, { operation: 'saveActiveData', stage: 'serialize' });
            return false;
        }
        if (updatedAt === null && onActiveDataSaved) {
            const reportCallbackFailure = error => console.error('배송 저장 후 콜백 실패:', storageDiagnostic(error, { ...localCounts(), operation: 'onActiveDataSaved', stage: 'callback', storage: 'memory' }));
            try {
                const result = onActiveDataSaved();
                if (result && typeof result.then === 'function') Promise.resolve(result).catch(reportCallbackFailure);
            } catch (error) { reportCallbackFailure(error); }
        }
        return true;
    },

    // 소유자 없는 기존 캐시는 추측해서 가져오지 않습니다.
    loadActiveData() {
        try {
            const metadata = JSON.parse(this.readLocalData('deliveryPro_route_metadata') || 'null');
            destinations = [];
            endLocation = { lat: 0, lng: 0, address: '' };
            startLocation = null;
            routePlan = null;
            routeUpdatedAt = 0;
            committedMemory = memorySnapshot();
            if (!metadata || metadata.routeOwnerId !== routeOwnerId || !Number.isFinite(metadata.updatedAt)) return;
            // 하나의 소유자 스냅샷을 읽어 다른 탭의 별도 키 쓰기와 섞이지 않게 합니다.
            const savedList = metadata.destinations;
            if (!Array.isArray(savedList)) return;
            destinations = normalizeDeliveryList(savedList);
            this.setRemoteRoutePlan(metadata.routePlan);
            const savedEnd = metadata.endLocation;
            this.setEndLocation(savedEnd || endLocation);
            routeUpdatedAt = metadata.updatedAt;
            if (metadata.startSelected === true && isDestinationId(metadata.startLocation?.id)) this.setStartLocation(metadata.startLocation);
            committedMemory = memorySnapshot();
            // Persist repaired input without advancing the server revision.
            if (destinations !== savedList || endLocation !== savedEnd) this.saveActiveData(routeUpdatedAt);
        } catch (error) {
            this.reportStorageFailure(error, { operation: 'loadActiveData', stage: 'read-before', key: 'deliveryPro_route_metadata' });
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
