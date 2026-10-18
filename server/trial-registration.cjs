const { randomUUID, randomInt } = require('node:crypto');
const { normalizePhone, phoneDigits, problem, assertNotBlocked } = require('./license-integrity.cjs');

// Shared by SMS issuance and final registration. Eligibility errors occur before paid SMS.
async function assertTrialEligible(db, reader, phone, deviceId) {
    if (!normalizePhone(phone)) throw problem('휴대폰 번호를 입력해 주세요.');
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(deviceId)) throw problem('기기 식별자가 올바르지 않습니다.');
    const [history, deviceHistory, , licenses, profiles] = await Promise.all([
        reader.get(db.collection('trial_phone_history').doc(phoneDigits(phone))),
        reader.get(db.collection('trial_device_history').doc(deviceId)),
        assertNotBlocked(db, reader, '', phone, deviceId),
        reader.get(db.collection('licenses')), reader.get(db.collection('driver_profiles'))
    ]);
    // Deleted accounts may be registered again. Retained history is only a
    // duplicate guard while its original account still exists.
    const accountKeys = new Set([...licenses.docs, ...profiles.docs].map(doc => doc.id));
    const hasAccount = snapshot => snapshot.exists && accountKeys.has(snapshot.data()?.trialKey);
    if (hasAccount(history) || [...licenses.docs, ...profiles.docs].some(doc => phoneDigits(doc.data().phone) === phoneDigits(phone))) {
        throw problem('이미 가입 또는 무료 체험 이력이 있는 휴대폰 번호입니다. 정식 라이선스를 이용해 주세요.', 409);
    }
    if (hasAccount(deviceHistory) || licenses.docs.some(doc => doc.data().deviceId === deviceId && doc.data().type === 'trial') ||
        profiles.docs.some(doc => doc.data().deviceId === deviceId && (doc.id.startsWith('TRIAL-') || doc.data().type === 'trial'))) {
        throw problem('이미 무료 체험을 사용하신 기기입니다. 정식 라이선스를 이용해 주세요.', 409);
    }
    return {licenses,profiles};
}

async function registerTrial(db, identity, input, now = Date.now(), offer = 'standard') {
    // Only the trusted endpoint selects an offer; body-supplied durations are ignored.
    if (!['standard','sales-month'].includes(offer)) throw problem('무료 체험 경로가 올바르지 않습니다.');
    const trialDays = offer === 'sales-month' ? 30 : 7;
    const provider = identity?.firebase?.sign_in_provider;
    const verifiedPhoneSession = provider === 'phone' || (provider === 'custom' && identity?.nativePhoneVerified === true);
    if (!verifiedPhoneSession || !identity.phone_number) {
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
    const expireDate = new Date(now + 9 * 3600000 + trialDays * 86400000).toISOString().slice(0, 10).replace(/-/g, '.');
    const chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    const keyChars = Array.from({ length: 8 }, () => chars[randomInt(chars.length)]).join('');
    const trialKey = `TRIAL-${keyChars.slice(0, 4)}-${keyChars.slice(4)}`;
    const routeOwnerId = randomUUID();
    return db.runTransaction(async tx => {
        const lock = await tx.get(lockRef);
        const {licenses,profiles} = await assertTrialEligible(db, tx, phone, deviceId);
        if (licenses.docs.some(doc => doc.id === trialKey) || profiles.docs.some(doc => doc.id === trialKey)) throw problem('발급 키 충돌이 발생했습니다. 다시 시도해 주세요.', 409);
        const data = { key: trialKey, phone, routeOwnerId, deviceId, status: 'active', expireDate, allowTms: true, trialDays, trialSource: offer };
        tx.set(db.collection('licenses').doc(trialKey), { ...data, type: 'trial', dispatchKey: '', createdAt: now });
        tx.set(db.collection('driver_profiles').doc(trialKey), data);
        // Account deletion releases eligibility; replace any orphaned history.
        tx.set(historyRef, { trialKey, uid: identity.uid, createdAt: now, trialDays, trialSource: offer });
        tx.set(deviceHistoryRef, { trialKey, createdAt: now, trialDays, trialSource: offer });
        tx.set(lockRef, { revision: (lock.data()?.revision || 0) + 1, updatedAt: now });
        return { valid: true, trialKey, expireDate, dispatchKey: '', routeOwnerId, trialDays };
    });
}

module.exports = { registerTrial, assertTrialEligible };
