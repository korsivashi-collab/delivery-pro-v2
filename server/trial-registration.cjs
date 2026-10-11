const { randomUUID, randomInt } = require('node:crypto');
const { normalizePhone, phoneDigits, problem } = require('./license-integrity.cjs');

async function registerTrial(db, identity, input, now = Date.now()) {
    if (identity?.firebase?.sign_in_provider !== 'phone' || !identity.phone_number) {
        throw problem('전화번호 SMS 인증을 먼저 완료해 주세요.', 403);
    }
    const phone = normalizePhone(input?.phone);
    if (!phone || phoneDigits(phone) !== phoneDigits(identity.phone_number)) {
        throw problem('SMS 인증된 전화번호와 입력 번호가 다릅니다.', 403);
    }
    const deviceId = input?.deviceId;
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(deviceId)) throw problem('기기 식별자가 올바르지 않습니다.');
    const historyRef = db.collection('trial_phone_history').doc(phoneDigits(phone));
    const deviceHistoryRef = db.collection('trial_device_history').doc(deviceId);
    const lockRef = db.collection('admin_license_controls').doc('phone_integrity');
    const expireDate = new Date(now + 9 * 3600000 + 7 * 86400000).toISOString().slice(0, 10).replace(/-/g, '.');
    const chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    const keyChars = Array.from({ length: 8 }, () => chars[randomInt(chars.length)]).join('');
    const trialKey = `TRIAL-${keyChars.slice(0, 4)}-${keyChars.slice(4)}`;
    const routeOwnerId = randomUUID();
    return db.runTransaction(async tx => {
        const lock = await tx.get(lockRef);
        const [history, deviceHistory, blocked, licenses, profiles] = await Promise.all([
            tx.get(historyRef), tx.get(deviceHistoryRef), tx.get(db.collection('blocked_devices').doc(deviceId)),
            tx.get(db.collection('licenses')), tx.get(db.collection('driver_profiles'))
        ]);
        if (blocked.exists) throw problem('접속이 제한된 기기입니다.', 403);
        if (history.exists || [...licenses.docs, ...profiles.docs].some(doc => phoneDigits(doc.data().phone) === phoneDigits(phone))) {
            throw problem('이미 가입 또는 무료 체험 이력이 있는 휴대폰 번호입니다. 정식 라이선스를 이용해 주세요.', 409);
        }
        if (deviceHistory.exists || licenses.docs.some(doc => doc.data().deviceId === deviceId && doc.data().type === 'trial') ||
            profiles.docs.some(doc => doc.data().deviceId === deviceId && (doc.id.startsWith('TRIAL-') || doc.data().type === 'trial'))) {
            throw problem('이미 7일 무료 체험을 사용하신 기기입니다. 정식 라이선스를 이용해 주세요.', 409);
        }
        if (licenses.docs.some(doc => doc.id === trialKey) || profiles.docs.some(doc => doc.id === trialKey)) throw problem('발급 키 충돌이 발생했습니다. 다시 시도해 주세요.', 409);
        const data = { key: trialKey, phone, routeOwnerId, deviceId, status: 'active', expireDate, allowTms: true };
        tx.set(db.collection('licenses').doc(trialKey), { ...data, type: 'trial', dispatchKey: '', createdAt: now });
        tx.set(db.collection('driver_profiles').doc(trialKey), data);
        // 클라이언트가 계정의 phone을 지우거나 계정을 삭제해도 체험 이력은 남습니다.
        tx.create(historyRef, { trialKey, uid: identity.uid, createdAt: now });
        tx.create(deviceHistoryRef, { trialKey, createdAt: now });
        tx.set(lockRef, { revision: (lock.data()?.revision || 0) + 1, updatedAt: now });
        return { valid: true, trialKey, expireDate, dispatchKey: '', routeOwnerId };
    });
}

module.exports = { registerTrial };
