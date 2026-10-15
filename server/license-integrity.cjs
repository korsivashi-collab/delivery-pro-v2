const { randomUUID } = require('node:crypto');

function problem(message, status = 400) {
    return Object.assign(new Error(message), { status });
}

function phoneDigits(value) {
    const input = String(value || '').trim();
    const digits = input.replace(/\D/g, '');
    return input.startsWith('+82') ? '0' + digits.slice(2).replace(/^0/, '') : digits;
}

function normalizePhone(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    const digits = phoneDigits(input);
    if (!/^(?:\+82)?[0-9\s()-]+$/.test(input) || !/^010\d{8}$/.test(digits)) {
        throw problem('휴대폰 번호를 정확하게 입력해 주세요. (예: 010-1234-5678)');
    }
    return digits.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3');
}

function validateKey(key) {
    if (typeof key !== 'string' || !key.trim() || key.length > 100 || /[\/\u0000-\u001f]/.test(key)) {
        throw problem('라이선스 키가 올바르지 않습니다.');
    }
    return key.trim().toUpperCase();
}

function validatePayload(input, create) {
    if (!input || typeof input !== 'object') throw problem('계정 정보가 올바르지 않습니다.');
    const key = validateKey(input.key);
    const type = input.type || 'regular';
    if (!(create ? ['regular', 'dispatch'] : ['regular', 'trial', 'dispatch']).includes(type)) {
        throw problem('계정 유형이 올바르지 않습니다.');
    }
    const expireDate = String(input.expireDate || '');
    const parts = expireDate.split('.').map(Number);
    const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(expireDate) || date.getUTCFullYear() !== parts[0] ||
        date.getUTCMonth() !== parts[1] - 1 || date.getUTCDate() !== parts[2]) throw problem('만료일이 올바르지 않습니다.');
    const status = create ? 'active' : input.status;
    if (!['active', 'suspended', 'expired', 'revoked', 'upgraded'].includes(status)) throw problem('계정 상태가 올바르지 않습니다.');
    const maxSessions = type === 'dispatch' ? Number(input.maxSessions || 1) : 1;
    const maxSlots = type === 'dispatch' ? Number(input.maxSlots || 0) : 0;
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 50 ||
        !Number.isInteger(maxSlots) || maxSlots < 0) throw problem('회선 수 또는 기사 슬롯 수가 올바르지 않습니다.');
    const deviceId = create ? '' : String(input.deviceId || '');
    if (deviceId.length > 200) throw problem('기기 식별자가 올바르지 않습니다.');
    return { key, type, phone: normalizePhone(input.phone), expireDate, status, deviceId,
        maxSlots, maxSessions, isPro: type === 'dispatch' && !!input.isPro };
}

function isActive(data, today, now) {
    if (!data || ['suspended', 'expired', 'revoked', 'upgraded'].includes(data.status)) return false;
    const expiry = String(data.expireDate || '').replace(/\D/g, '').slice(0, 8);
    if (expiry.length === 8 && expiry < today.replace(/-/g, '')) return false;
    const timestamp = data.expiresAt;
    if (timestamp) {
        const ms = typeof timestamp.toMillis === 'function' ? timestamp.toMillis() : Number(timestamp);
        if (Number.isFinite(ms) && ms <= now) return false;
    }
    return true;
}

async function saveLicenses(db, request, now = Date.now()) {
    const create = request?.action === 'create';
    if (!create && request?.action !== 'edit') throw problem('지원하지 않는 저장 요청입니다.');
    const entries = create ? request.entries : [request.license];
    if (!Array.isArray(entries) || !entries.length || entries.length > 50) throw problem('계정은 한 번에 1~50개까지 발급할 수 있습니다.');
    const payloads = entries.map(entry => validatePayload(entry, create));
    if (new Set(payloads.map(p => p.key)).size !== payloads.length) throw problem('발급 키가 중복되었습니다. 다시 시도해 주세요.', 409);
    if (payloads.length > 1 && payloads.some(p => p.phone)) throw problem('전화번호 사전 등록은 계정 1개씩 발급해 주세요.');
    const origKey = create ? '' : validateKey(request.origKey);
    const today = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
    const yesterday = new Date(now + 9 * 3600000 - 86400000).toISOString().slice(0, 10).replace(/-/g, '.');
    const lockRef = db.collection('admin_license_controls').doc('phone_integrity');

    return db.runTransaction(async tx => {
        // 같은 전화번호를 동시에 등록하는 관리자 요청도 순서대로 판정합니다.
        const lock = await tx.get(lockRef);
        // 기존의 임의 하이픈/공백 저장값까지 판정하므로 특정 표기만 where로 조회하지 않습니다.
        const [licensesSnap, profilesSnap] = await Promise.all([
            tx.get(db.collection('licenses')), tx.get(db.collection('driver_profiles'))
        ]);
        const licenses = new Map(licensesSnap.docs.map(d => [d.id, { ...d.data() }]));
        const profiles = new Map(profilesSnap.docs.map(d => [d.id, { ...d.data() }]));
        if (!create && !licenses.has(origKey)) throw problem('수정할 라이선스가 존재하지 않습니다.', 404);
        const retired = new Map(), changed = [], memoPhones = new Set();
        for (const payload of payloads) {
            if ((create || payload.key !== origKey) && (licenses.has(payload.key) || profiles.has(payload.key))) {
                throw problem(`이미 존재하는 라이선스 키입니다. (${payload.key})`, 409);
            }
            const digits = phoneDigits(payload.phone);
            if (digits) {
                for (const [collectionName, records] of [['licenses', licenses], ['driver_profiles', profiles]]) {
                    for (const [id, data] of records) {
                        if (id === origKey || (data.key && data.key === origKey)) continue;
                        if (phoneDigits(data.phone) !== digits) continue;
                        const linkedLicense = licenses.get(id) || licenses.get(data.key);
                        const isTrial = (linkedLicense || data).type === 'trial' ||
                            (!(linkedLicense || data).type && ((linkedLicense || data).isTrial || id.startsWith('TRIAL-')));
                        if (!isTrial && isActive(data, today, now)) {
                            throw problem(`이미 등록되어 사용 중인 휴대폰 번호입니다. (라이선스 키: ${data.key || id})`, 409);
                        }
                        if (isTrial && payload.type !== 'trial') {
                            retired.set(id, payload.key);
                            if (data.phone) memoPhones.add(data.phone);
                            if (linkedLicense?.phone) memoPhones.add(linkedLicense.phone);
                        }
                    }
                }
            }
            const previous = create ? {} : licenses.get(origKey);
            const previousProfile = create ? {} : profiles.get(origKey) || {};
            if (previous.billingManaged && payload.key !== origKey) throw problem('스토어 구독 계정의 키는 변경할 수 없습니다.', 409);
            if (previous.routeOwnerId && previousProfile.routeOwnerId && previous.routeOwnerId !== previousProfile.routeOwnerId) {
                throw problem('라이선스와 기사 신분증의 소유자 정보가 다릅니다. 기존 소유권을 확인한 뒤 다시 저장해 주세요.', 409);
            }
            const routeOwnerId = previous.routeOwnerId || previousProfile.routeOwnerId || randomUUID();
            const license = { ...previous, ...payload, routeOwnerId,
                dispatchKey: previous.dispatchKey || '', createdAt: previous.createdAt ?? now + changed.length };
            // licenses에 없던 TMS 허용 설정은 기존 신분증의 설정을 우선 보존합니다.
            const profile = { ...previousProfile, key: payload.key, phone: payload.phone,
                deviceId: payload.deviceId, status: payload.status, expireDate: payload.expireDate,
                routeOwnerId, allowTms: previousProfile.allowTms ?? previous.allowTms ?? true };
            if (previousProfile.type) profile.type = payload.type;
            if (previous.phone && phoneDigits(previous.phone) === digits && previous.phone !== payload.phone) memoPhones.add(previous.phone);
            changed.push({ payload, license, profile, hasProfile: payload.type !== 'dispatch' || profiles.has(origKey) });
        }
        // TRIAL 이력의 phone 표기가 달라도 정식 계정의 phone 조회로 메모가 이어집니다.
        const memoWrites = new Map();
        for (const oldPhone of memoPhones) {
            const snap = await tx.get(db.collection('memos').where('phone', '==', oldPhone));
            const destination = changed.find(item => phoneDigits(item.payload.phone) === phoneDigits(oldPhone));
            if (destination) for (const memo of snap.docs) memoWrites.set(memo.ref.path, { ref: memo.ref, phone: destination.payload.phone });
        }
        let writes = 1;
        const set = (ref, data, options) => { if (++writes > 450) throw problem('연결된 이력이 많아 한 번에 저장할 수 없습니다. 관리자에게 문의해 주세요.'); tx.set(ref, data, options); };
        const remove = ref => { if (++writes > 450) throw problem('연결된 이력이 많아 한 번에 저장할 수 없습니다.'); tx.delete(ref); };
        for (const { payload, license, profile, hasProfile } of changed) {
            set(db.collection('licenses').doc(payload.key), license);
            if (hasProfile) set(db.collection('driver_profiles').doc(payload.key), profile);
            if (!create && payload.key !== origKey) {
                remove(db.collection('licenses').doc(origKey));
                if (profiles.has(origKey)) remove(db.collection('driver_profiles').doc(origKey));
                if (payload.type === 'dispatch') for (const [id, data] of licenses) {
                    if (data.dispatchKey === origKey) set(db.collection('licenses').doc(id), { dispatchKey: payload.key }, { merge: true });
                }
            }
        }
        for (const [id, upgradedTo] of retired) {
            const phone = changed.find(item => item.payload.key === upgradedTo).payload.phone;
            const update = { phone, status: 'upgraded', expireDate: yesterday, upgradedTo, upgradedAt: now };
            if (licenses.has(id)) set(db.collection('licenses').doc(id), update, { merge: true });
            if (profiles.has(id)) set(db.collection('driver_profiles').doc(id), update, { merge: true });
        }
        for (const { ref, phone } of memoWrites.values()) set(ref, { phone }, { merge: true });
        tx.set(lockRef, { revision: (lock.data()?.revision || 0) + 1, updatedAt: now });
        return { keys: payloads.map(p => p.key), upgradedTrials: [...retired.keys()] };
    });
}

async function repairLicensePhones(db, now = Date.now()) {
    const lockRef = db.collection('admin_license_controls').doc('phone_integrity');
    return db.runTransaction(async tx => {
        const lock = await tx.get(lockRef);
        const [licensesSnap, profilesSnap] = await Promise.all([
            tx.get(db.collection('licenses')), tx.get(db.collection('driver_profiles'))
        ]);
        const profiles = new Map(profilesSnap.docs.map(doc => [doc.id, doc.data()]));
        const repaired = [], conflicts = [], skipped = [];
        let hasMore = false;
        const writes = [];
        for (const snapshot of licensesSnap.docs) {
            const license = snapshot.data(), profile = profiles.get(snapshot.id);
            if (license.type === 'dispatch' && !profile) continue;
            if (license.routeOwnerId && profile?.routeOwnerId && license.routeOwnerId !== profile.routeOwnerId) {
                conflicts.push(snapshot.id); continue;
            }
            const licensePhone = String(license.phone || '').trim(), profilePhone = String(profile?.phone || '').trim();
            if (licensePhone && profilePhone) {
                if (phoneDigits(licensePhone) !== phoneDigits(profilePhone)) conflicts.push(snapshot.id);
                continue;
            }
            const donorPhone = licensePhone ? license.phone : profile?.phone;
            if (!donorPhone) continue;
            try { normalizePhone(donorPhone); } catch (_) { skipped.push(snapshot.id); continue; }
            const accountWriteStart = writes.length;
            // 누락 필드만 복사합니다. 기존 메모의 phone 표기와 소유권을 그대로 보존합니다.
            if (!licensePhone) writes.push([snapshot.ref, { phone: donorPhone }]);
            else if (profile) writes.push([db.collection('driver_profiles').doc(snapshot.id), { phone: donorPhone }]);
            else {
                const routeOwnerId = license.routeOwnerId || randomUUID();
                if (!license.routeOwnerId) writes.push([snapshot.ref, { routeOwnerId }]);
                writes.push([db.collection('driver_profiles').doc(snapshot.id), {
                    key: snapshot.id, phone: donorPhone, routeOwnerId, status: license.status || 'active',
                    expireDate: license.expireDate || '', deviceId: license.deviceId || '', allowTms: license.allowTms !== false
                }]);
            }
            if (writes.length > 440) {
                writes.length = accountWriteStart;
                hasMore = true;
                continue;
            }
            repaired.push(snapshot.id);
        }
        // 계정별 양쪽 문서를 한 트랜잭션에 묶고, 초과분은 다음 요청에서 계속합니다.
        for (const [ref, data] of writes) tx.set(ref, data, { merge: true });
        if (writes.length) tx.set(lockRef, { revision: (lock.data()?.revision || 0) + 1, updatedAt: now });
        return { repaired, conflicts, skipped, hasMore };
    });
}

module.exports = { normalizePhone, phoneDigits, saveLicenses, repairLicensePhones, problem, isActive };
