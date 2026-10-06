// Diagnostic metadata never contains delivery values or credentials.
const contexts = new WeakMap();
export function storageErrorContext(error, context) {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) error = new Error('Storage operation failed');
    contexts.set(error, { ...context, ...contexts.get(error) });
    return error;
}

export function storageDiagnostic(error, context = {}) {
    const details = { ...context, ...contexts.get(error) };
    const name = typeof error?.name === 'string' ? error.name : 'Error';
    const category = name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' ? 'quota'
        : name === 'SecurityError' ? 'access'
        : name === 'SyntaxError' || name === 'TypeError' ? 'logic'
        : details.storage === 'indexedDB' ? 'photo-storage'
        : ['read-before', 'write-journal', 'write-value', 'clear-journal', 'rollback'].includes(details.stage)
            ? 'local-storage' : 'logic';
    // JSON.parse errors and arbitrary callbacks can include personal data in their messages.
    // Browser storage exceptions and fixed application messages are safe; stacks omit the message line.
    const fixedMessages = ['로컬 복구 기록을 확인할 수 없습니다.', '이전 로컬 저장 복구가 필요합니다.',
        '로컬 저장 작업이 이미 진행 중입니다.', '배송 이력 소유자 정보가 없습니다.',
        '배송 이력 저장에 실패했습니다.', '전송대기 데이터를 읽을 수 없습니다.',
        '사진 저장소가 다른 창에서 사용 중입니다.', '사진 저장 실패'];
    const safeMessage = fixedMessages.includes(error?.message) ? error.message
        : ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED', 'SecurityError',
        'AbortError', 'InvalidStateError', 'UnknownError', 'NotFoundError', 'VersionError'].includes(name)
        ? String(error?.message || '').replace(/https?:\/\/\S+/g, '[url]') : 'Message redacted; inspect operation, stage and stack';
    const stack = typeof error?.stack === 'string'
        ? error.stack.split('\n').filter(line => /^\s*at\s/.test(line) || /^[^@\s]*@/.test(line))
            .map(line => line.replace(/([?#])[^\s)]*/g, '$1[redacted]')).join('\n') : '';
    return {
        operation: details.operation || 'unknown', stage: details.stage || 'logic', key: details.key || null,
        storage: details.storage || 'localStorage', category,
        error: { name, message: safeMessage, messageRedacted: safeMessage !== String(error?.message || ''),
            code: typeof error?.code === 'number' ? error.code : null, stack },
        activeDestinationCount: details.activeDestinationCount ?? null,
        historyCount: details.historyCount ?? null, transmissionCount: details.transmissionCount ?? null,
        oldLength: details.oldLength ?? null, newLength: details.newLength ?? null,
        journalLength: details.journalLength ?? null, lengths: details.lengths || null,
        photoBytes: details.photoBytes ?? null
    };
}
