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
    if (input.testSmsBypass !== undefined && typeof input.testSmsBypass !== 'boolean') throw problem('테스트 인증 생략 설정이 올바르지 않습니다.');
    const testSmsBypass = input.testSmsBypass === true;
    if (testSmsBypass && (type !== 'regular' || !normalizePhone(input.phone))) throw problem('테스트 인증 생략은 전화번호가 등록된 일반 계정에만 설정할 수 있습니다.');
    return { key, type, phone: normalizePhone(input.phone), expireDate, status, deviceId,
        testSmsBypass, maxSlots, maxSessions, isPro: type === 'dispatch' && !!input.isPro };
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

// Contact/device fields are a temporary driver connection, never license ownership.
function withoutDriverConnection(record) {
    const clean={...record};
    for(const field of ['phone','deviceId','driverUid','driverSessionId','deviceChangedAt'])delete clean[field];
    return clean;
}
async function releaseInactiveDriverConnections(db,now=Date.now(),key=null) {
    const today=new Date(now+9*3600000).toISOString().slice(0,10);
    return db.runTransaction(async tx=>{
        const licenses=key ? await Promise.all([key,'PRO-'+key,'TRIAL-'+key].map(k=>tx.get(db.collection('licenses').doc(k)))) :
            (await tx.get(db.collection('licenses'))).docs;
        const blocked=(await tx.get(db.collection('blocked_devices'))).docs;
        const profileSnapshots=key ? await Promise.all(licenses.filter(s=>s.exists).map(s=>tx.get(db.collection('driver_profiles').doc(s.id)))) :
            (await tx.get(db.collection('driver_profiles'))).docs;
        const profileMap=new Map(profileSnapshots.map(s=>[s.id,s]));
        const hasConnection=data=>data && ['phone','deviceId','driverUid','driverSessionId','deviceChangedAt'].some(f=>Object.hasOwn(data,f));
        const candidates=licenses.filter(s=>s.exists && s.data().type!=='dispatch' &&
            (hasConnection(s.data()) || hasConnection(profileMap.get(s.id)?.data())) && (!isActive(s.data(),today,now) || blocked.some(b=>{
            const d=b.data(),license=s.data();
            return [b.id,d.key,d.licenseKey,d.licenseId].includes(s.id) || license.phone &&
                [b.id,d.phone,d.phoneNumber].filter(Boolean).some(p=>phoneDigits(p)===phoneDigits(license.phone));
        }))).slice(0,200);
        const profiles=candidates.map(s=>profileMap.get(s.id));
        let changed=0;
        for(let i=0;i<candidates.length;i++){
            const l=candidates[i],p=profiles[i],data=l.data();
            let wrote=false;
            for(const doc of [l,p])if(doc?.exists && ['phone','deviceId','driverUid','driverSessionId','deviceChangedAt'].some(f=>Object.hasOwn(doc.data(),f))){
                const clean=withoutDriverConnection(doc.data());
                if(data.status==='active' && !isActive(data,today,now))clean.status='expired';
                tx.set(doc.ref,clean);wrote=true;
            }
            if(wrote)changed++;
        }
        return {ok:true,changed,hasMore:!key && candidates.length===200};
    });
}

// Block-list failures propagate; an unavailable list must never grant access.
async function assertNotBlocked(db, reader, key, phone, device, existingSnapshot = null) {
    const collection = db.collection('blocked_devices');
    const snapshot = existingSnapshot || await (reader === db ? collection.get() : reader.get(collection));
    const digits = phoneDigits(phone), cleanKey = String(key || '').trim().toUpperCase();
    for (const item of snapshot.docs) {
        const data = item.data();
        const keys = [data.key, data.licenseKey, data.licenseId, item.id].filter(Boolean).map(v => String(v).trim().toUpperCase());
        const phones = [data.phone, data.phoneNumber, item.id].filter(Boolean).map(phoneDigits);
        if ((cleanKey && keys.includes(cleanKey)) || (digits && phones.includes(digits))) {
            throw problem('접속이 제한된 계정입니다.', 403);
        }
    }
    return snapshot;
}

async function assertDriverSession(db, identity, key, device, now = Date.now()) {
    if (!identity?.driverSessionId || identity.driverKey !== key || identity.driverDeviceId !== device) {
        throw problem('접속이 해제되었습니다. 다시 로그인해 주세요.', 401);
    }
    const snapshot = await db.collection('licenses').doc(key).get(), data = snapshot.data();
    if (!snapshot.exists || data.driverSessionId !== identity.driverSessionId || data.driverUid !== identity.uid || data.deviceId !== device) {
        throw problem('다른 기기에서 로그인하여 접속이 해제되었습니다.', 401);
    }
    if (!isActive(data, new Date(now + 9 * 3600000).toISOString().slice(0, 10), now)) throw problem('사용할 수 없는 이용권입니다.', 403);
    if (identity.testDriverSession === true && (data.testSmsBypass !== true || data.type !== 'regular' || data.billingManaged)) throw problem('테스트 접속 허용이 해제되었습니다.', 401);
    return data;
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
        const billingSnap = await tx.get(db.collection('billing_accounts'));
        const billing = billingSnap.docs.filter(d => d.data().licenseKey === origKey);
        if (billing.length > 1) throw problem('결제 계정 연결이 중복되어 있습니다. 계정을 덮어쓸 수 없습니다.', 409);
        const bound = billing[0], account = bound?.data();
        if (payloads.some(p => p.testSmsBypass) && (account || licenses.get(origKey)?.billingManaged)) throw problem('결제 계정에는 테스트 인증 생략을 설정할 수 없습니다.', 409);
        const renaming = !create && payloads[0].key !== origKey;
        const registrations = renaming && licenses.get(origKey)?.dispatchBillingId
            ? await tx.get(db.collection('dispatch_registrations').where('walletId','==',licenses.get(origKey).dispatchBillingId)) : {docs:[]};
        const releasedKeys = [];
        for (const payload of payloads) {
            const binding = await tx.get(db.collection('billing_license_bindings').doc(payload.key));
            if (payload.testSmsBypass && binding.exists) throw problem('결제 계정에는 테스트 인증 생략을 설정할 수 없습니다.', 409);
            if ((create || payload.key !== origKey) && (binding.exists || billingSnap.docs.some(d => d.data().licenseKey === payload.key))) {
                const deleted = await tx.get(db.collection('admin_license_controls').doc('deleted-'+payload.key));
                const pastOrders = await tx.get(db.collection('payment_orders').where('licenseKey','==',payload.key));
                // Only the same verified billing owner may reclaim a deleted key after re-registration.
                // Move historical order references aside so refunds and callbacks cannot affect the new account.
                if (!bound || !renaming || !binding.exists || binding.data().uid !== bound.id ||
                    !deleted.data()?.deletedAt || licenses.has(payload.key) || profiles.has(payload.key) ||
                    billingSnap.docs.some(d => d.data().licenseKey === payload.key) ||
                    pastOrders.docs.some(d => d.data().uid !== bound.id)) {
                    throw problem('결제 이력이 예약한 키입니다. 다른 키를 사용해 주세요.', 409);
                }
                releasedKeys.push({key:payload.key, historicalKey:'ARCHIVED-'+randomUUID(), binding:binding.data(), orders:pastOrders.docs});
            }
        }
        if (bound) {
            const originalBinding = await tx.get(db.collection('billing_license_bindings').doc(origKey));
            if (originalBinding.exists && originalBinding.data().uid !== bound.id) throw problem('결제 소유자 연결이 일치하지 않습니다.',409);
        }
        const orderSnap = renaming && bound ? await tx.get(db.collection('payment_orders').where('uid', '==', bound.id)) : {docs:[]};
        // Pending allocations store the login key, while delivered routes keep their stable owner.
        const allocationSnap = renaming && payloads[0].type !== 'dispatch'
            ? await tx.get(db.collection('dispatch_orders')) : {docs:[]};
        const retired = new Map(), changed = [], memoPhones = new Set(), orphanProfiles = new Map();
        for (const payload of payloads) {
            if ((create || payload.key !== origKey) && (licenses.has(payload.key) || profiles.has(payload.key))) {
                if (licenses.has(payload.key)) throw problem(`이미 존재하는 라이선스 키입니다. (${payload.key})`, 409);
                const orphan=profiles.get(payload.key);
                const pastOrders=await tx.get(db.collection('payment_orders').where('licenseKey','==',payload.key));
                if(orphan.billingManaged || pastOrders.docs.length) throw problem('기존 결제 이력이 연결된 키입니다. 다른 키를 사용해 주세요.',409);
                orphanProfiles.set(payload.key,orphan);
                profiles.delete(payload.key);
            }
            if (account) {
                const currentPhone = licenses.get(origKey).phone || '';
                if (payload.phone && phoneDigits(payload.phone) !== phoneDigits(currentPhone)) throw problem('결제 계정의 인증된 휴대폰 번호는 변경할 수 없습니다.', 409);
                payload.phone = normalizePhone(currentPhone);
                if (payload.type !== (licenses.get(origKey).type || 'regular')) throw problem('결제 계정의 유형은 변경할 수 없습니다.', 409);
                if (renaming && payload.key.length > 8) throw problem('새 라이선스 키는 8자리 이하로 입력해 주세요.');
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
            if(previous.dispatchBillingId && payload.type !== 'dispatch') throw problem('문자·결제 이력이 있는 관제 계정은 다른 계정 유형으로 변경할 수 없습니다.',409);
            const previousProfile = create ? {} : profiles.get(origKey) || {};
            if (previous.billingManaged && !account) throw problem('결제 연결 정보를 찾을 수 없습니다. 저장하지 않았습니다.', 409);
            if (previous.routeOwnerId && previousProfile.routeOwnerId && previous.routeOwnerId !== previousProfile.routeOwnerId) {
                throw problem('라이선스와 기사 신분증의 소유자 정보가 다릅니다. 기존 소유권을 확인한 뒤 다시 저장해 주세요.', 409);
            }
            const routeOwnerId = previous.routeOwnerId || previousProfile.routeOwnerId || randomUUID();
            const license = { ...previous, ...payload, ...(account?{isPro:previous.isPro??true}:{}), routeOwnerId,
                dispatchKey: previous.dispatchKey || '', createdAt: previous.createdAt ?? now + changed.length };
            if(previous.dispatchBillingId && Number.isFinite(previous.expiresAt)) license.expiresAt=Date.parse(payload.expireDate.replace(/\./g,'-')+'T23:59:59.999+09:00');
            if (account && (payload.expireDate !== previous.expireDate || payload.status !== previous.status)) {
                license.adminExpiresAt = Date.parse(payload.expireDate.replace(/\./g,'-')+'T23:59:59.999+09:00');
                license.adminPeriodUpdatedAt = now;
                Object.assign(license,effectivePeriod(license, account.webManaged ? account.webExpiresAt : account.access?.active ? account.access.expiresAt : 0, now));
            }
            // Toggle/phone/key changes revoke any existing test session immediately.
            if (previous.testSmsBypass === true && (!payload.testSmsBypass || renaming ||
                phoneDigits(previous.phone) !== phoneDigits(payload.phone))) {
                Object.assign(license, {deviceId:'', driverUid:'', driverSessionId:randomUUID()});
            }
            // licenses에 없던 TMS 허용 설정은 기존 신분증의 설정을 우선 보존합니다.
            const profile = { ...previousProfile, key: payload.key, phone: payload.phone,
                deviceId: payload.deviceId, status: payload.status, expireDate: payload.expireDate,
                routeOwnerId, allowTms: previousProfile.allowTms ?? previous.allowTms ?? true };
            if (Number.isFinite(license.adminExpiresAt)) Object.assign(profile, {
                adminExpiresAt:license.adminExpiresAt, adminPeriodUpdatedAt:license.adminPeriodUpdatedAt,
                expiresAt:license.expiresAt, expireDate:license.expireDate, status:license.status
            });
            if (license.driverUid === '' && license.driverSessionId) Object.assign(profile,
                {deviceId:license.deviceId, driverUid:'', driverSessionId:license.driverSessionId});
            if (previousProfile.type) profile.type = payload.type;
            if(license.type!=='dispatch' && !isActive(license,today,now)){
                for(const record of [license,profile])for(const field of ['phone','deviceId','driverUid','driverSessionId','deviceChangedAt'])delete record[field];
            }
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
        for (const retired of releasedKeys) {
            set(db.collection('billing_license_bindings').doc(retired.historicalKey), {...retired.binding, originalLicenseKey:retired.key});
            for (const order of retired.orders) set(order.ref, {licenseKey:retired.historicalKey, originalLicenseKey:retired.key}, {merge:true});
        }
        for (const [key, profile] of orphanProfiles) {
            set(db.collection('admin_license_controls').doc('deleted-'+key),{key,deletedAt:now,license:null,profile});
            if(!changed.some(item=>item.payload.key===key && item.hasProfile)) remove(db.collection('driver_profiles').doc(key));
        }
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
        if (renaming && bound) {
            set(bound.ref, {...account, licenseKey:payloads[0].key});
            set(db.collection('billing_license_bindings').doc(payloads[0].key), {uid:bound.id,provider:account.webManaged?'toss':'google_play'});
            remove(db.collection('billing_license_bindings').doc(origKey));
            for (const order of orderSnap.docs) if(order.data().licenseKey===origKey) set(order.ref, {licenseKey:payloads[0].key}, {merge:true});
        }
        for(const registration of registrations.docs){
            const data=registration.data();
            set(registration.ref,{key:payloads[0].key,...(data.result?{result:{...data.result,dispatchKey:payloads[0].key}}:{})},{merge:true});
        }
        for (const document of allocationSnap.docs) {
            const orders = document.data().orders;
            if (!Array.isArray(orders) || !orders.some(order => order.assignedDriver === origKey)) continue;
            set(document.ref, {orders:orders.map(order => order.assignedDriver === origKey
                ? {...order,assignedDriver:payloads[0].key} : order)}, {merge:true});
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
    await releaseInactiveDriverConnections(db,now);
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
            if(license.type!=='dispatch' && !isActive(license,new Date(now+9*3600000).toISOString().slice(0,10),now))continue;
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

async function deleteLicenseAccount(db, request, now = Date.now()) {
    const key = validateKey(request.key), lockRef = db.collection('admin_license_controls').doc('phone_integrity');
    return db.runTransaction(async tx => {
        const lock = await tx.get(lockRef);
        const lRef=db.collection('licenses').doc(key), pRef=db.collection('driver_profiles').doc(key);
        const [l,p,binding,accounts,orders,licenses] = await Promise.all([
            tx.get(lRef), tx.get(pRef), tx.get(db.collection('billing_license_bindings').doc(key)),
            tx.get(db.collection('billing_accounts')), tx.get(db.collection('payment_orders').where('licenseKey','==',key)), tx.get(db.collection('licenses'))
        ]);
        if(request.orphanOnly && l.exists) throw problem('계정이 현재 존재합니다. 삭제된 프로필 정리를 중단했습니다.',409);
        if(l.data()?.dispatchBillingId){
            const wallet=(await tx.get(db.collection('dispatch_wallets').doc(l.data().dispatchBillingId))).data();
            if(wallet && (wallet.balance>0 || wallet.testBalance>0 || wallet.pendingOrder)) throw problem('문자 잔여 건수 또는 진행 중인 관제 결제가 있습니다. 잔액·결제 결과를 정리한 뒤 삭제해 주세요.',409);
        }
        const linkedAccounts=accounts.docs.filter(d=>d.data().licenseKey===key);
        const paid=l.data()?.billingManaged || p.data()?.billingManaged || binding.exists || linkedAccounts.length || orders.docs.length;
        if(paid){
            if(request.orphanOnly || linkedAccounts.length!==1 || (binding.exists && binding.data().uid!==linkedAccounts[0].id)) throw problem('결제 연결 정보를 확인할 수 없어 삭제하지 않았습니다.',409);
            const account=linkedAccounts[0].data();
            if(account.pendingWebUntil>now)throw problem('진행 중인 결제 요청이 있습니다. 결제 결과 확인 후 삭제해 주세요.',409);
            const expiry=value=>{
                if(Number.isFinite(value?.expiresAt))return value.expiresAt;
                if(value?.expiresAt?.toMillis)return value.expiresAt.toMillis();
                const m=/^(\d{4})[.-](\d{2})[.-](\d{2})$/.exec(value?.expireDate||'');
                return m?Date.UTC(+m[1],+m[2]-1,+m[3]+1)-9*3600000-1:NaN;
            };
            const paidExpiry=account.webManaged?account.webExpiresAt:account.access?.expiresAt;
            if(!Number.isFinite(paidExpiry))throw problem('결제 이용기간 확인이 필요합니다. 이용권 상태를 동기화한 뒤 삭제해 주세요.',409);
            if(paidExpiry>now || [l.data(),p.data()].some(x=>x && expiry(x)>now))throw problem('남은 이용기간이 있습니다. 만료되거나 결제 취소가 반영된 후 삭제할 수 있습니다.',409);
        }
        if(!l.exists && !p.exists) return {deleted:true,key};
        const linked=licenses.docs.filter(d=>d.data().dispatchKey===key);
        if(linked.length>440)throw problem('연결 계정이 많아 개별 해제 후 삭제해 주세요.',409);
        tx.set(db.collection('admin_license_controls').doc('deleted-'+key),{key,deletedAt:now,license:l.data()||null,profile:p.data()||null});
        for(const a of linkedAccounts)tx.set(a.ref,{...a.data(),deletedAt:now});
        if(l.exists)tx.delete(lRef);
        if(p.exists)tx.delete(pRef);
        for(const d of linked)tx.set(d.ref,{dispatchKey:''},{merge:true});
        // Route/completion history is retained with its old routeOwnerId; reusing the key does not transfer ownership.
        tx.set(lockRef,{revision:(lock.data()?.revision||0)+1,updatedAt:now});
        return {deleted:true,key};
    });
}

async function linkDispatchDriver(db, identity, request, now = Date.now()) {
    const master = identity?.role === 'MASTER' && identity.masterSmsVerified === true && identity.masterSessionExpiresAt > now / 1000;
    if (!master && identity?.role !== 'DISPATCH') throw problem('관제 또는 마스터 로그인이 필요합니다.', 403);
    const dispatchKey = validateKey(master ? request.dispatchKey : identity.uid);
    if (!master && request.dispatchKey && request.dispatchKey !== dispatchKey) throw problem('다른 관제소로 연결할 수 없습니다.', 403);
    const input = validateKey(request.driverInput);
    const today = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
    return db.runTransaction(async tx => {
        const lockRef = db.collection('admin_license_controls').doc('phone_integrity');
        const lock = await tx.get(lockRef);
        const licenses = await tx.get(db.collection('licenses'));
        const dispatcher = licenses.docs.find(doc => doc.id === dispatchKey)?.data();
        if (dispatcher?.type !== 'dispatch' || !isActive(dispatcher, today, now)) throw problem('관제 이용권이 만료되었거나 사용할 수 없습니다.', 403);
        if (!master) {
            const sessions = Array.isArray(dispatcher.activeSessions) && dispatcher.activeSessions.length ? dispatcher.activeSessions :
                (dispatcher.currentSessionToken ? [dispatcher.currentSessionToken] : []);
            if (sessions.length && !sessions.includes(request.sessionToken)) throw problem('관제 접속이 해제되었습니다. 다시 로그인해 주세요.', 401);
        }
        const keys = [input, `TRIAL-${input}`, `PRO-${input}`];
        let target = licenses.docs.find(doc => keys.includes(doc.id) && doc.data().type !== 'dispatch');
        if (!target && /^(010[\d\s()-]+|\+82[\d\s()-]+)$/.test(input)) {
            const phone = phoneDigits(input);
            const matches = licenses.docs.filter(doc => doc.data().type !== 'dispatch' && phoneDigits(doc.data().phone) === phone);
            if (matches.length > 1) throw problem('같은 번호의 계정이 여러 개입니다. 라이선스 키로 연결해 주세요.', 409);
            target = matches[0];
        }
        if (!target) throw problem('기사 계정을 찾을 수 없습니다. 키 또는 번호를 확인해 주세요.', 404);
        const driver = target.data();
        const profileRef = db.collection('driver_profiles').doc(target.id);
        const profile = await tx.get(profileRef);
        if (!isActive(driver, today, now)) throw problem('기사 이용권이 만료되었거나 사용할 수 없습니다.', 403);
        if ([driver.allowTms, profile.data()?.allowTms].some(value => value === false || value === 'false')) throw problem('기사 앱의 연결설정에서 TMS 연결을 켜 주세요.', 403);
        if (!master && driver.dispatchKey && driver.dispatchKey !== dispatchKey) throw problem('이미 다른 관제소에 연결된 기사입니다. 마스터 관리자에게 문의해 주세요.', 409);
        const count = licenses.docs.filter(doc => doc.data().type !== 'dispatch' && doc.data().dispatchKey === dispatchKey).length;
        if (driver.dispatchKey !== dispatchKey && Number(dispatcher.maxSlots) > 0 && count >= Number(dispatcher.maxSlots)) throw problem('관제 기사 연결 슬롯이 모두 사용 중입니다.', 409);
        // Trial duration does not affect dispatch eligibility. Keep both records in sync.
        tx.update(target.ref, { dispatchKey });
        if (profile.exists) tx.update(profileRef, { dispatchKey });
        tx.set(lockRef, { revision: (lock.data()?.revision || 0) + 1, updatedAt: now });
        return { success: true, key: target.id, phone: driver.phone || '', dispatchKey };
    });
}

// Server-owned indexes authorize legacy owner/device documents without exposing all licenses.
async function dispatchAccessAction(db, identity, request, now = Date.now()) {
    if (request.action === 'prepareNoticeInbox') return prepareNoticeInbox(db, identity, request, now);
    if (request.action === 'sendDispatchMessage') return sendPrivateNotice(db, identity, request, now);
    if (request.action === 'deleteDispatchMessage') return deletePrivateNotice(db, identity, request, now);
    const master = identity?.role === 'MASTER' && identity.masterSmsVerified === true && identity.masterSessionExpiresAt > now / 1000;
    if (!master && identity?.role !== 'DISPATCH') throw problem('관제 로그인이 필요합니다.', 403);
    const keys = [...new Set((Array.isArray(request.keys) ? request.keys : []).map(validateKey))];
    if (!keys.length || (request.action !== 'sendDispatchMessage' && keys.length > 50)) throw problem('기사 계정을 1~50개씩 선택해 주세요.');
    const today = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
    return db.runTransaction(async tx => {
        if (!master) {
            const dispatcher = (await tx.get(db.collection('licenses').doc(identity.uid))).data();
            if (dispatcher?.type !== 'dispatch' || !isActive(dispatcher, today, now)) throw problem('관제 이용권을 확인해 주세요.', 403);
            const sessions = dispatcher.activeSessions?.length ? dispatcher.activeSessions : [dispatcher.currentSessionToken].filter(Boolean);
            if (sessions.length && !sessions.includes(request.sessionToken)) throw problem('관제 접속이 해제되었습니다.', 401);
        }
        const drivers = await Promise.all(keys.map(key => tx.get(db.collection('licenses').doc(key))));
        for (const d of drivers) {
            if (!d.exists || d.data().type === 'dispatch' || (!master && d.data().dispatchKey !== identity.uid)) throw problem('연결된 기사만 처리할 수 있습니다.', 403);
        }
        if (request.action === 'unlinkDispatchDriver') {
            if (keys.length !== 1) throw problem('기사를 한 명씩 해제해 주세요.');
            const d = drivers[0], driver = d.data();
            const profile = await tx.get(db.collection('driver_profiles').doc(d.id));
            const routes = driver.routeOwnerId ? await tx.get(db.collection('routes').where('routeOwnerId', '==', driver.routeOwnerId)) : { docs: [] };
            for (const r of routes.docs) if ([driver.deviceId, d.id].includes(r.id)) tx.delete(r.ref);
            tx.update(d.ref, { dispatchKey: '' });
            if (profile.exists) tx.update(profile.ref, { dispatchKey: '' });
            return { success: true };
        }
        if (request.action !== 'prepareAccess') throw problem('지원하지 않는 작업입니다.');
        const owners = drivers.map(d => d.data().routeOwnerId || randomUUID());
        if (new Set(owners).size !== owners.length) throw problem('기사 소유권이 중복되어 관리자 확인이 필요합니다.', 409);
        const mappings = await Promise.all(owners.map(owner => tx.get(db.collection('access_owners').doc(owner))));
        const prior = await Promise.all(mappings.map(m => m.exists && !keys.includes(m.data().licenseKey)
            ? tx.get(db.collection('licenses').doc(m.data().licenseKey)) : Promise.resolve(null)));
        for (let i = 0; i < drivers.length; i++) {
            const d = drivers[i], owner = owners[i];
            if (prior[i]?.exists && prior[i].data().routeOwnerId === owner) throw problem('기사 소유권이 중복되어 관리자 확인이 필요합니다.', 409);
            if (!d.data().routeOwnerId) tx.update(d.ref, { routeOwnerId: owner });
            if (mappings[i].data()?.licenseKey !== d.id) tx.set(db.collection('access_owners').doc(owner), { licenseKey: d.id });
            for (const id of new Set([d.id, d.data().deviceId].filter(Boolean))) {
                tx.set(db.collection('access_devices').doc(id), { licenseKey: d.id, routeOwnerId: owner });
            }
        }
        return { success: true, owners: Object.fromEntries(drivers.map((d, i) => [d.id, owners[i]])) };
    });
}

// Public inbox copies never contain recipient keys, phones, devices, or the sender's address book.
function noticeInboxId(key, license) {
    if (typeof license.routeOwnerId !== 'string' || !license.routeOwnerId || license.routeOwnerId.includes('/')) throw problem('기사 데이터 연결을 먼저 확인해 주세요.', 409);
    return (license.type === 'dispatch' ? 'dispatch_' : 'driver_') + license.routeOwnerId;
}
function noticeBody(message) {
    return {senderKey:message.senderKey, senderType:message.senderType || (message.senderKey === 'MASTER' ? 'MASTER' : 'DISPATCH'),
        senderTitle:message.senderTitle || (message.senderKey === 'MASTER' ? '운영사 알림' : '회사 알림'),
        content:String(message.content || ''), createdAt:Number(message.createdAt) || 0,
        dateStr:String(message.dateStr || ''), timeStr:String(message.timeStr || '')};
}
async function assertNoticeSender(db, tx, identity, request, now) {
    const master = identity?.role === 'MASTER' && identity.masterSmsVerified === true && identity.masterSessionExpiresAt > now / 1000;
    if (master) return 'MASTER';
    if (identity?.role !== 'DISPATCH') throw problem('관제 로그인이 필요합니다.', 403);
    const account = (await tx.get(db.collection('licenses').doc(identity.uid))).data();
    if (account?.type !== 'dispatch' || !isActive(account, new Date(now + 9*3600000).toISOString().slice(0,10), now)) throw problem('관제 이용권을 확인해 주세요.', 403);
    const sessions = account.activeSessions?.length ? account.activeSessions : [account.currentSessionToken].filter(Boolean);
    if (sessions.length && !sessions.includes(request.sessionToken)) throw problem('관제 접속이 해제되었습니다.', 401);
    return identity.uid;
}
async function prepareNoticeInbox(db, identity, request, now) {
    return db.runTransaction(async tx=>{
        const sender=await assertNoticeSender(db,tx,identity,request,now);
        const key=validateKey(request.keys?.[0]);
        if(sender!=='MASTER' && sender!==key) throw problem('본인 수신함만 준비할 수 있습니다.',403);
        const account=await tx.get(db.collection('licenses').doc(key)), data=account.data();
        if(!account.exists || data.type!=='dispatch') throw problem('관제 계정을 확인해 주세요.',403);
        if(!data.routeOwnerId){data.routeOwnerId=randomUUID();tx.update(account.ref,{routeOwnerId:data.routeOwnerId});}
        return {inboxId:noticeInboxId(key,data)};
    });
}
async function sendPrivateNotice(db, identity, request, now = Date.now()) {
    const keys = [...new Set((Array.isArray(request.keys) ? request.keys : []).map(validateKey))];
    if (!keys.length || keys.length > 400) throw problem('알림은 한 요청에 1~400명씩 전송해 주세요.');
    const content = String(request.content || '').trim();
    if (!content || content.length > 5000 || (identity?.role !== 'MASTER' && content.length > 300)) throw problem('알림 내용의 길이를 확인해 주세요.');
    const id = request.messageId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw problem('발송 식별정보를 확인해 주세요.');
    const ref = db.collection('dispatch_messages').doc(id);
    return db.runTransaction(async tx => {
        const senderKey = await assertNoticeSender(db, tx, identity, request, now);
        const previous = await tx.get(ref);
        if (previous.exists) {
            const old = previous.data();
            if (old.senderKey !== senderKey || old.content !== content || JSON.stringify(old.targetLicenseKeys) !== JSON.stringify(keys) || old.deleting) throw problem('이미 사용된 발송 식별정보입니다.', 409);
            return {success:true, sent:keys.length, messageId:id};
        }
        const recipients = await Promise.all(keys.map(key => tx.get(db.collection('licenses').doc(key))));
        for (const recipient of recipients) {
            if (!recipient.exists || (senderKey !== 'MASTER' && (recipient.data().type === 'dispatch' || recipient.data().dispatchKey !== senderKey))) throw problem('연결된 수신 계정만 선택해 주세요.', 403);
        }
        const inboxIds = recipients.map(d => {
            const data=d.data();
            if(data.type==='dispatch' && !data.routeOwnerId){data.routeOwnerId=randomUUID();tx.update(d.ref,{routeOwnerId:data.routeOwnerId});}
            return noticeInboxId(d.id,data);
        });
        const date = new Date(now + 9*3600000).toISOString();
        const message = {senderKey, senderType:senderKey === 'MASTER' ? 'MASTER' : 'DISPATCH', senderTitle:senderKey === 'MASTER' ? '운영사 알림' : '회사 알림',
            content, createdAt:now, dateStr:date.slice(0,10), timeStr:date.slice(11,16),
            targetLicenseKeys:keys, targetDeviceIds:[...new Set(recipients.flatMap(d => [d.id,d.data().deviceId].filter(Boolean)))],
            targetPhones:recipients.map(d => d.data().phone || '').filter(Boolean), acknowledged:[], inboxIds, inboxVersion:2};
        tx.set(ref, message);
        for (const inboxId of new Set(inboxIds)) tx.set(db.collection('dispatch_inboxes').doc(inboxId).collection('messages').doc(id), noticeBody(message));
        return {success:true, sent:keys.length, messageId:id};
    });
}
async function deletePrivateNotice(db, identity, request, now = Date.now()) {
    const id = request.messageId;
    if (typeof id !== 'string' || !id || id.length > 200 || id.includes('/')) throw problem('알림 식별정보를 확인해 주세요.');
    const ref = db.collection('dispatch_messages').doc(id);
    const inboxIds = await db.runTransaction(async tx => {
        const senderKey = await assertNoticeSender(db, tx, identity, request, now);
        const message = await tx.get(ref);
        if (!message.exists) return [];
        if (senderKey !== 'MASTER' && message.data().senderKey !== senderKey) throw problem('본인이 보낸 알림만 삭제할 수 있습니다.', 403);
        tx.update(ref, {deleting:true});
        return message.data().inboxIds || [];
    });
    // A legacy broadcast can have more than 500 recipients. Keep its source until all copies are removed so retry can finish cleanup.
    for (let i=0; i<inboxIds.length; i+=400) {
        const batch = db.batch();
        for (const inboxId of inboxIds.slice(i,i+400)) batch.delete(db.collection('dispatch_inboxes').doc(inboxId).collection('messages').doc(id));
        await batch.commit();
    }
    await ref.delete();
    return {success:true};
}
async function migrateNoticeInboxes(db, request = {}) {
    const checkpointRef=db.collection('admin_license_controls').doc('notice_inboxes_v2');
    const checkpoint=(await checkpointRef.get()).data() || {};
    if(checkpoint.complete && request.restart!==true) return {success:true,migrated:0,skipped:0,hasMore:false,cursor:checkpoint.cursor || ''};
    const cursor=request.cursor || (request.restart ? '' : checkpoint.cursor) || '';
    let query = db.collection('dispatch_messages').orderBy(require('firebase-admin').firestore.FieldPath.documentId()).limit(10);
    if (cursor) {
        if (typeof cursor !== 'string' || cursor.includes('/') || cursor.length>200) throw problem('이관 위치가 올바르지 않습니다.');
        query = query.startAfter(cursor);
    }
    const page = await query.get(); let migrated=0, skipped=0;
    for (const source of page.docs) {
        const initial = source.data();
        if (initial.inboxVersion === 2 || initial.senderType === 'DRIVER' || !initial.senderKey || initial.deleting) continue;
        const keys = [...new Set((initial.targetLicenseKeys || []).filter(k=>typeof k==='string' && k && !k.includes('/')))];
        if (!keys.length) { skipped++; continue; }
        for (let i=0; i<keys.length; i+=400) {
            await db.runTransaction(async tx => {
                const current = await tx.get(source.ref);
                if (!current.exists || current.data().inboxVersion===2 || current.data().deleting) return;
                const message = current.data();
                const recipients = await Promise.all(keys.slice(i,i+400).map(k=>tx.get(db.collection('licenses').doc(k))));
                const inboxIds = new Set(message.inboxIds || []);
                for (const recipient of recipients) {
                    const data = recipient.data();
                    const created = data?.createdAt?.toMillis ? data.createdAt.toMillis() : Number(data?.createdAt);
                    if (!recipient.exists || (Number.isFinite(created) && created > Number(message.createdAt))) { skipped++; continue; }
                    if(data.type==='dispatch' && !data.routeOwnerId){data.routeOwnerId=randomUUID();tx.update(recipient.ref,{routeOwnerId:data.routeOwnerId});}
                    let inboxId; try { inboxId = noticeInboxId(recipient.id, data); } catch (_) { skipped++; continue; }
                    inboxIds.add(inboxId);
                    tx.set(db.collection('dispatch_inboxes').doc(inboxId).collection('messages').doc(source.id), noticeBody(message));
                }
                tx.update(source.ref, {inboxIds:[...inboxIds], ...(i+400>=keys.length ? {inboxVersion:2} : {})});
            });
        }
        migrated++;
    }
    const nextCursor=page.docs.at(-1)?.id || cursor;
    await checkpointRef.set({cursor:nextCursor,complete:page.size<10},{merge:true});
    return {success:true,migrated,skipped,hasMore:page.size===10,cursor:nextCursor};
}

// Administrator grants are independent of provider payment history and cancellation arithmetic.
function effectivePeriod(license, paidExpiresAt, now) {
    const expiresAt = Math.max(paidExpiresAt || 0, Number.isFinite(license.adminExpiresAt) ? license.adminExpiresAt : 0);
    const status = ['suspended','revoked'].includes(license.status) ? license.status : expiresAt > now ? 'active' : 'expired';
    return { expiresAt, expireDate:new Date(expiresAt+9*3600000).toISOString().slice(0,10).replace(/-/g,'.'), status };
}
module.exports = { migrateNoticeInboxes, dispatchAccessAction, withoutDriverConnection, releaseInactiveDriverConnections, effectivePeriod, normalizePhone, phoneDigits, saveLicenses, repairLicensePhones, deleteLicenseAccount, linkDispatchDriver, problem, isActive, assertNotBlocked, assertDriverSession };
