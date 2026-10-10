import { state } from './state.js';
import { completionPhotos } from './completion-photos.js';
import { firebaseUploadDeliveryPhoto, saveCompletionToFirestore, deleteCompletionFromFirestore, saveRouteToFirestore } from './api.js';
import { storageDiagnostic } from './storage-diagnostics.js';

export function readCompletionQueue() {
    const jobs = JSON.parse(state.readLocalData('deliveryPro_transmissions') || '[]');
    if (!Array.isArray(jobs)) throw new Error('전송대기 데이터를 읽을 수 없습니다.');
    return jobs;
}

export function renderCompletionQueueStatus() {
    const node = document.getElementById('transmission-status');
    if (!node) return;
    // Older cached HTML may still contain the removed banner. Never expose internal recovery state.
    node.textContent = '';
    node.hidden = true;
}

function refreshCompletionQueueStatus() {
    renderCompletionQueueStatus();
}

export function createCompletionTask(item, tag, context, photoId = null, photoUrl = null) {
    const gps = state.getLastKnownGps();
    const real = !!(gps && gps.lat && gps.lng);
    return {
        id: photoId || crypto.randomUUID(), action: 'complete', status: 'pending',
        completedAt: Date.now(), attempts: 0, nextAttemptAt: 0,
        ownership: { routeOwnerId: context.completionOwnership.routeOwnerId,
            licenseKey: context.completionOwnership.licenseKey }, deviceId: context.deviceId, phone: context.phone,
        item: { ...item }, tag, lat: real ? gps.lat : item.lat, lng: real ? gps.lng : item.lng,
        isReal: real, photoId, photoUrl: photoUrl || '', stage: photoId ? 'photo' : 'completion'
    };
}

// Called inside the same local transaction as the history and active-list mutation.
export function stageCompletionTask(job, historyEntry) {
    historyEntry.transmissionStatus = 'pending';
    historyEntry.transmissionId = job.id;
    historyEntry.completionDocId = job.id;
    historyEntry.hasPhoto = !!(job.photoId || job.photoUrl);
    job.historyTimestamp = historyEntry.timestamp;
    state.writeTransmissions([...readCompletionQueue(), job]);
}

export function stageCompletionDeletion(record, context, restoredItem) {
    if (!record.transmissionId && !record.completionDocId) return;
    const jobs = readCompletionQueue();
    const id = record.transmissionId || crypto.randomUUID();
    const previous = jobs.find(job => job.id === id);
    const job = {
        id, action: 'delete', status: 'pending', stage: 'completion', attempts: 0, nextAttemptAt: 0,
        completedAt: Date.now(), completionDocId: record.completionDocId || id,
        ownership: { routeOwnerId: context.routeOwnerId, licenseKey: context.licenseKey },
        deviceId: context.deviceId, phone: context.phone, photoId: previous?.photoId || null,
        restoredItem, restoreContext: record.restoreContext || null,
        routeId: record.restoreContext?.routeId || null,
        stateVersion: (record.restoreContext?.stateVersion || 0) + 1
    };
    state.writeTransmissions([...jobs.filter(entry => entry.id !== id), job]);
}

// A stale remote route must not reintroduce a locally completed delivery.
export function excludeLocallyCompleted(list) {
    const owner = state.getRouteOwnerId();
    const history = JSON.parse(state.readLocalData('deliveryPro_history') || '[]');
    const routeId = state.getRoutePlan()?.routeId;
    const sameRoute = context => !context?.routeId || context.routeId === routeId;
    const completed = new Set(history.filter(h => !h.restoredAt && h.routeOwnerId === owner && h.transmissionId && sameRoute(h.restoreContext)).map(h => String(h.id)));
    const jobs = readCompletionQueue();
    for (const job of jobs) {
        if (job.ownership.routeOwnerId === owner && sameRoute(job) && job.action === 'complete') completed.add(String(job.item.id));
    }
    const filtered = list.filter(item => !item || !completed.has(String(item.id)));
    for (const job of jobs) {
        if (job.action === 'delete' && job.ownership.routeOwnerId === owner && sameRoute(job) && job.restoredItem &&
            !completed.has(String(job.restoredItem.id)) && !filtered.some(item => item && String(item.id) === String(job.restoredItem.id))) {
            const order = job.restoreContext?.orderIds || [], pivot = order.indexOf(String(job.restoredItem.id));
            const successor = pivot < 0 ? -1 : order.slice(pivot + 1).map(id => filtered.findIndex(d => String(d.id) === id)).find(at => at >= 0);
            const predecessor = pivot < 0 ? -1 : order.slice(0, pivot).reverse().map(id => filtered.findIndex(d => String(d.id) === id)).find(at => at >= 0);
            filtered.splice(successor >= 0 ? successor : predecessor >= 0 ? predecessor + 1 : filtered.length, 0, job.restoredItem);
        }
    }
    return filtered;
}

// Injectable clock/transport for deterministic offline/restart/fault tests; no new state library.
export function createCompletionWorker({
    read = readCompletionQueue, write = (jobs, history) => state.writeTransmissions(jobs, history),
    history = () => JSON.parse(state.readLocalData('deliveryPro_history') || '[]'),
    owner = () => state.getRouteOwnerId(), photos = completionPhotos,
    upload = job => photos.get(job.photoId).then(blob => {
        if (!blob) throw new Error('보존된 배송 사진을 찾을 수 없습니다.');
        return firebaseUploadDeliveryPhoto(blob, job.deviceId, job.id);
    }),
    complete = job => saveCompletionToFirestore(job.deviceId, job.phone, job.item, job.tag,
        job.lat, job.lng, job.isReal, job.photoUrl,
        { routeOwnerId: job.ownership.routeOwnerId, licenseKey: job.ownership.licenseKey },
        { id: job.id, completedAt: job.completedAt }),
    remove = job => deleteCompletionFromFirestore(job.completionDocId, job.id, job.ownership.routeOwnerId),
    route = async job => {
        const revision = state.getRouteUpdatedAt();
        const saved = await saveRouteToFirestore(job.deviceId, job.phone, state.getDestinations(), true);
        if (state.getRouteOwnerId() !== job.ownership.routeOwnerId || revision !== state.getRouteUpdatedAt()) {
            throw new Error('변경된 배송 목록 재전송 필요');
        }
        return saved;
    },
    now = () => Date.now(), online = () => navigator.onLine !== false,
    later = (fn, ms) => setTimeout(fn, ms), cancel = timer => clearTimeout(timer),
    status = () => {}, resumeOwner = async () => {}
} = {}) {
    let busy = false, timer = null, transport = null, stopped = false;
    const refreshHistory = job => {
        try {
            if (typeof document.dispatchEvent === 'function' && typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent('completion-photo-saved', {detail:{transmissionId:job.id,routeOwnerId:job.ownership.routeOwnerId}}));
        } catch (_) {}
    };
    const matches = (a, b) => a.id === b.id && a.action === b.action && a.stateVersion === b.stateVersion && a.ownership.routeOwnerId === b.ownership.routeOwnerId;
    const update = (job, patch) => {
        const jobs = read();
        const index = jobs.findIndex(current => matches(current, job));
        if (index < 0) return false; // Restored/replaced while awaiting a response.
        jobs[index] = { ...jobs[index], ...patch };
        if (!write(jobs)) throw new Error('전송대기 상태 저장 실패');
        Object.assign(job, patch);
        return true;
    };
    const saveHistoryPhoto = job => {
        if (job.action !== 'complete' || !job.photoUrl || owner() !== job.ownership.routeOwnerId) return;
        const jobs = read();
        // A restore replaces the complete job with a delete job while upload is in flight.
        if (!jobs.some(current => matches(current, job) && current.ownership.routeOwnerId === job.ownership.routeOwnerId)) return;
        const records = history();
        const record = records.find(h => h.transmissionId === job.id && h.routeOwnerId === job.ownership.routeOwnerId);
        if (!record || (record.photoUrl === job.photoUrl && record.hasPhoto)) return;
        record.photoUrl = job.photoUrl;
        record.hasPhoto = true;
        // Keep the job and original Blob until completion and route acknowledgements succeed.
        if (!write(jobs, records)) throw new Error('사진 이력 저장 실패');
        try {
            if (typeof document.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                document.dispatchEvent(new CustomEvent('completion-photo-saved', {
                    detail: { transmissionId: job.id, routeOwnerId: job.ownership.routeOwnerId }
                }));
            }
        } catch (error) { console.error('사진 이력 화면 갱신 실패:', error); }
    };
    const request = async operation => {
        let timeout;
        const pending = Promise.resolve().then(operation);
        transport = pending;
        pending.then(() => { if (transport === pending) transport = null; },
            () => { if (transport === pending) transport = null; });
        try {
            return await Promise.race([pending, new Promise((_, reject) => {
                timeout = later(() => reject(new Error('전송 응답 시간 초과')), 30000);
            })]);
        } finally { cancel(timeout); }
        // A timed-out SDK request can still be running. Never start another until it settles.
    };
    async function drain() {
        if (busy || stopped) return;
        busy = true;
        try {
            if (!transport && online() && !owner() && read().length) await request(resumeOwner);
            while (online() && owner() && !transport) {
                const job = read().find(j => j.ownership.routeOwnerId === owner() && j.nextAttemptAt <= now());
                if (!job) break;
                try {
                    if (!update(job, { status: job.attempts ? 'retrying' : 'sending', attempts: job.attempts + 1 })) continue;
                    if (job.action === 'complete' && job.photoId && !job.photoUrl) {
                        const photoUrl = await request(() => upload(job));
                        if (!photoUrl) throw new Error('사진 업로드 응답 미확인');
                        if (!update(job, { photoUrl, stage: 'completion' })) {
                            // Preserve evidence from a late upload without reviving completion.
                            const records = history();
                            const record = records.find(h => h.transmissionId === job.id && h.routeOwnerId === job.ownership.routeOwnerId);
                            if (record && owner() === job.ownership.routeOwnerId) {
                                record.photoUrl = photoUrl; record.hasPhoto = true;
                                if (!write(read(), records)) throw new Error('사진 이력 저장 실패');
                            }
                            continue;
                        }
                    }
                    // Also repairs history on restart/retry when the queue already has the URL.
                    saveHistoryPhoto(job);
                    if (job.stage !== 'route') {
                        const receipt = await request(() => job.action === 'delete' ? remove(job) : complete(job));
                        if (job.action === 'complete' && !receipt) throw new Error('완료 기록 전송 미확인');
                        if (!update(job, { stage: 'route' })) continue;
                    }
                    if (owner() !== job.ownership.routeOwnerId) break;
                    const saved = await request(() => route(job));
                    if (saved === false) throw new Error('배송 목록 전송 미확인');
                    const jobs = read();
                    if (!jobs.some(current => matches(current, job))) continue;
                    const records = history();
                    const record = records.find(h => h.transmissionId === job.id && h.routeOwnerId === job.ownership.routeOwnerId);
                    const clearFailure = job.action === 'complete' && record?.transmissionStatus === 'failed';
                    if (record && job.action === 'complete') {
                        record.photoUrl = job.photoUrl;
                        record.hasPhoto = !!job.photoUrl;
                        record.transmissionStatus = 'sent';
                    }
                    if (!write(jobs.filter(current => !matches(current, job)), records)) throw new Error('전송 완료 상태 저장 실패');
                    if (clearFailure) refreshHistory(job);
                    try { status(read().filter(current => current.ownership.routeOwnerId === owner())); } catch (_) {}
                    // A restored delivery retains its existing photo evidence.
                    if (job.photoId && job.action === 'complete') photos.remove(job.photoId).catch(error => console.error('전송 사진 정리 실패:', storageDiagnostic(error, { operation: 'completionPhotoCleanup', storage: 'indexedDB' })));
                } catch (error) {
                    const longFailure = job.attempts >= 8 || now() - job.completedAt >= 86400000;
                    const delay = longFailure ? 3600000 : Math.min(300000, 5000 * 2 ** Math.min(job.attempts - 1, 6));
                    try { const current = update(job, { status: longFailure ? 'longFailure' : 'pending',
                        lastError: String(error.code || error.message || error).slice(0, 200),
                        lastFailureAt: now(), nextAttemptAt: now() + delay });
                        if (current && job.action === 'complete' && job.attempts >= 2) {
                            const records = history();
                            const record = records.find(h => !h.restoredAt && h.transmissionId === job.id && h.routeOwnerId === job.ownership.routeOwnerId);
                            if (record && record.transmissionStatus !== 'failed') { record.transmissionStatus = 'failed'; if (!write(read(), records)) throw new Error('전송 결과 저장 실패'); refreshHistory(job); }
                        }
                    }
                    catch (storageError) { console.error('전송 작업 보존 확인 필요:', storageDiagnostic(storageError, { operation: 'completionWorker', stage: 'bookkeeping' })); break; }
                }
            }
        } catch (error) { console.error('전송대기 처리 실패:', storageDiagnostic(error, { operation: 'completionWorker', stage: 'read-before' })); }
        finally {
            busy = false;
            try { status(read().filter(job => job.ownership.routeOwnerId === owner())); } catch (_) {}
            if (!stopped) { cancel(timer); timer = later(drain, 5000); }
        }
    }
    return {
        drain,
        wake() { if (!stopped) { cancel(timer); timer = later(drain, 0); } },
        stop() { stopped = true; cancel(timer); }
    };
}

let completionWorker;
export function wakeCompletionQueue() { refreshCompletionQueueStatus(); completionWorker?.wake(); }
export function initCompletionQueue(resumeSavedOwner = null) {
    if (completionWorker) { refreshCompletionQueueStatus(); return; }
    let nextOwnerCheck = 0;
    completionWorker = createCompletionWorker({ async resumeOwner() {
        if (!resumeSavedOwner || Date.now() < nextOwnerCheck) return;
        const key = localStorage.getItem('deliveryProKey');
        const deviceId = localStorage.getItem('deliveryProDeviceId');
        if (!key || !readCompletionQueue().some(job => job.ownership.licenseKey === key && job.deviceId === deviceId)) return;
        nextOwnerCheck = Date.now() + 60000;
        // Reuse the existing authentication flow only for pending work belonging to saved credentials.
        await resumeSavedOwner();
    }, status: renderCompletionQueueStatus });
    window.addEventListener('online', wakeCompletionQueue);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakeCompletionQueue(); });
    wakeCompletionQueue();
}
