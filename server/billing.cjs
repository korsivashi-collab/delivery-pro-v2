const { randomUUID, randomBytes } = require('node:crypto');
const { normalizePhone, phoneDigits, problem, isActive } = require('./license-integrity.cjs');
const ENTITLEMENT = 'delivery_pro';
const PRODUCTS = ['delivery_pro:monthly','delivery_pro:quarterly','delivery_pro:halfyearly','delivery_pro:yearly'];
function verifiedPhone(identity) {
    const provider = identity?.firebase?.sign_in_provider;
    if (!(provider === 'phone' || provider === 'custom' && identity.nativePhoneVerified === true) || !identity.phone_number || identity.uid === 'admin_master') {
        throw problem('구독 신청 전에 휴대폰 인증을 완료해 주세요.', 403);
    }
    return normalizePhone(identity.phone_number);
}
function deviceId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw problem('기기 정보가 올바르지 않습니다.');
    return value;
}
function evaluatePurchase(payload, now, allowSandbox = false) {
    if (!payload?.subscriber || !Number.isFinite(payload.request_date_ms)) throw problem('구독 확인 서버 응답이 올바르지 않습니다.', 502);
    const subscriber = payload.subscriber, entitlement = subscriber.entitlements?.[ENTITLEMENT];
    const empty = { active: false, expiresAt: 0, snapshotAt: payload.request_date_ms };
    if (!entitlement) return empty;
    const product = entitlement.product_identifier;
    const entries = Object.entries(subscriber.subscriptions || {}).filter(([id]) => id === product || id.split(':')[0] === product);
    const candidates = entries.filter(([id, purchase]) => PRODUCTS.includes(id) && purchase.store === 'play_store' &&
        purchase.refunded_at == null && typeof purchase.is_sandbox === 'boolean' && (!purchase.is_sandbox || allowSandbox));
    const entitlementExpiry = Math.max(Date.parse(entitlement.expires_date) || 0, Date.parse(entitlement.grace_period_expires_date) || 0);
    const valid = candidates.map(([id, purchase]) => ({ productId: id, sandbox: purchase.is_sandbox,
        expiresAt: Math.min(entitlementExpiry, Math.max(Date.parse(purchase.expires_date) || 0, Date.parse(purchase.grace_period_expires_date) || 0)) }))
        .filter(purchase => purchase.expiresAt > now).sort((a,b) => b.expiresAt-a.expiresAt)[0];
    return valid ? { ...valid, active: true, snapshotAt: payload.request_date_ms } : empty;
}
async function ensureAccount(db, identity, input, now) {
    const phone = verifiedPhone(identity), device = deviceId(input.deviceId), ref = db.collection('billing_accounts').doc(identity.uid);
    const lockRef = db.collection('admin_license_controls').doc('phone_integrity');
    return db.runTransaction(async tx => {
        const [saved, lock, blocked, licenses, profiles] = await Promise.all([tx.get(ref), tx.get(lockRef),
            tx.get(db.collection('blocked_devices').doc(device)), tx.get(db.collection('licenses')), tx.get(db.collection('driver_profiles'))]);
        if (blocked.exists) throw problem('접속이 제한된 기기입니다.', 403);
        const account = saved.data();
        if (account && phoneDigits(account.phone) !== phoneDigits(phone)) throw problem('구독 계정의 인증 번호가 변경되었습니다. 고객센터에 문의해 주세요.', 409);
        const matched = licenses.docs.filter(doc => phoneDigits(doc.data().phone) === phoneDigits(phone));
        const current = account ? licenses.docs.find(doc => doc.id === account.licenseKey) :
            matched.find(doc => doc.data().type !== 'dispatch' && !['revoked','upgraded'].includes(doc.data().status)) ||
            profiles.docs.find(doc => phoneDigits(doc.data().phone) === phoneDigits(phone) && !['revoked','upgraded'].includes(doc.data().status));
        if (matched.some(doc => doc.data().type === 'dispatch')) throw problem('관제 계정은 기사 앱 구독으로 변경할 수 없습니다.', 409);
        if (matched.some(doc => doc.id !== current?.id && doc.data().type !== 'trial' && isActive(doc.data(), new Date(now+9*3600000).toISOString().slice(0,10), now))) {
            throw problem('같은 번호에 다른 이용권이 있습니다. 고객센터에 문의해 주세요.', 409);
        }
        if (current?.data().deviceId && current.data().deviceId !== device) throw problem('다른 기기에 연결된 계정입니다. 고객센터에 기기 변경을 요청해 주세요.', 409);
        if (['suspended','revoked'].includes(current?.data().status)) throw problem('접속이 제한된 계정입니다.', 403);
        const reservedAccounts=await tx.get(db.collection('billing_accounts'));
        let newKey;
        if (!account && !current) {
            for (let attempt=0;attempt<10;attempt++) {
                const candidate=randomBytes(5).toString('hex').slice(0,8).toUpperCase();
                const binding=await tx.get(db.collection('billing_license_bindings').doc(candidate));
                if (!binding.exists && !reservedAccounts.docs.some(d=>d.data().licenseKey===candidate) && !licenses.docs.some(d=>d.id===candidate) && !profiles.docs.some(d=>d.id===candidate)) { newKey=candidate;break; }
            }
            if (!newKey) throw problem('이용권 번호 생성에 실패했습니다. 다시 시도해 주세요.',503);
        }
        const result = account || { uid: identity.uid, phone, rcUserId: 'dp_android_'+randomUUID(),
            licenseKey: current?.id || newKey, createdAt: now };
        const activeManual = account?.webManaged === true || account?.pendingWebUntil > now || current && current.data().type !== 'trial' && !current.data().billingManaged &&
            isActive(current.data(), new Date(now+9*3600000).toISOString().slice(0,10), now);
        if (!account) {
            tx.create(ref, result);
            tx.create(db.collection('billing_customer_ids').doc(result.rcUserId), { uid: identity.uid });
            tx.set(lockRef, { revision: (lock.data()?.revision || 0)+1, updatedAt: now });
        }
        return { ...result, canPurchase: !activeManual, reason: activeManual ? account?.webManaged ? '웹 기간권 계정입니다. Google Play 구독으로 전환하려면 고객센터에 문의해 주세요.' : '현재 이용권 또는 진행 중인 주문이 있습니다. 확인 후 다시 요청하거나 고객센터에 문의해 주세요.' : '' };
    });
}
async function applyPurchase(db, uid, entitlement, now, device = null) {
    const ref = db.collection('billing_accounts').doc(uid), lockRef = db.collection('admin_license_controls').doc('phone_integrity');
    return db.runTransaction(async tx => {
        const accountSnap = await tx.get(ref), account = accountSnap.data();
        if (!account) throw problem('구독 계정을 찾을 수 없습니다.',404);
        // A web period must never be overwritten by an unrelated Play webhook.
        if (account.webManaged) return {active:false,valid:false,msg:'웹 이용권을 다시 확인해 주세요.'};
        const licenseRef = db.collection('licenses').doc(account.licenseKey), profileRef = db.collection('driver_profiles').doc(account.licenseKey);
        const bindingRef = db.collection('billing_license_bindings').doc(account.licenseKey);
        const [licenseSnap, profileSnap, binding, lock, blocked, allLicenses] = await Promise.all([
            tx.get(licenseRef), tx.get(profileRef), tx.get(bindingRef), tx.get(lockRef),
            device ? tx.get(db.collection('blocked_devices').doc(device)) : Promise.resolve({exists:false}), tx.get(db.collection('licenses'))]);
        if (blocked.exists) throw problem('접속이 제한된 기기입니다.',403);
        const license = licenseSnap.data() || {}, profile = profileSnap.data() || {};
        if (binding.exists && binding.data().uid !== uid) throw problem('이용권 소유자가 다릅니다.',403);
        if (license.phone && phoneDigits(license.phone) !== phoneDigits(account.phone) || profile.phone && phoneDigits(profile.phone) !== phoneDigits(account.phone)) throw problem('이용권 전화번호가 변경되었습니다. 고객센터에 문의해 주세요.',409);
        if (license.routeOwnerId && profile.routeOwnerId && license.routeOwnerId !== profile.routeOwnerId) throw problem('계정 소유자 정보를 확인해 주세요.',409);
        if (device && (license.deviceId || profile.deviceId) && (license.deviceId || profile.deviceId) !== device) throw problem('다른 기기에 연결된 계정입니다.',409);
        // Prevent old concurrent REST responses from rolling back newer subscription state.
        const latest = (account.billingSnapshotAt || 0) > entitlement.snapshotAt ? account.access : entitlement;
        if (['suspended','revoked'].includes(license.status) || ['suspended','revoked'].includes(profile.status)) return {active:false,valid:false,msg:'접속이 제한된 계정입니다.'};
        if (latest.active && !binding.exists) {
            if (license.type === 'dispatch') throw problem('관제 계정은 구독으로 변경할 수 없습니다.',409);
            if (license.type !== 'trial' && licenseSnap.exists && isActive(license,new Date(now+9*3600000).toISOString().slice(0,10),now)) throw problem('기존 이용권이 남아 있습니다. 고객센터에 문의해 주세요.',409);
            if (allLicenses.docs.some(doc => doc.id !== account.licenseKey && phoneDigits(doc.data().phone) === phoneDigits(account.phone) && doc.data().type !== 'trial' && isActive(doc.data(),new Date(now+9*3600000).toISOString().slice(0,10),now))) throw problem('같은 번호에 다른 이용권이 등록되었습니다.',409);
        }
        const active = latest.active === true && latest.expiresAt > now;
        if (active || binding.exists) {
            const routeOwnerId = license.routeOwnerId || profile.routeOwnerId || randomUUID();
            const expiresAt = active ? latest.expiresAt : Math.min(latest.expiresAt || now,now);
            const expireDate = new Date(expiresAt+9*3600000).toISOString().slice(0,10).replace(/-/g,'.');
            const data = { phone: account.phone, routeOwnerId, deviceId: device || license.deviceId || profile.deviceId || '',
                type:'regular', status:active?'active':'expired', billingManaged:true, billingUid:uid,
                expiresAt, expireDate, subscriptionProduct:latest.productId || '', subscriptionSandbox:latest.sandbox === true };
            tx.set(licenseRef,{...license,...data,key:account.licenseKey,dispatchKey:license.dispatchKey || '',isPro:true,createdAt:license.createdAt || now});
            tx.set(profileRef,{...profile,...data,key:account.licenseKey,allowTms:profile.allowTms ?? license.allowTms ?? true});
            tx.set(bindingRef,{uid,rcUserId:account.rcUserId});
            tx.set(lockRef,{revision:(lock.data()?.revision || 0)+1,updatedAt:now});
            tx.set(ref,{...account,access:{...latest,active},billingSnapshotAt:latest.snapshotAt,lastSyncAt:now});
            return {active,valid:active,billingManaged:true,actualKey:account.licenseKey,phone:account.phone,expireDate,expiresAt,
                routeOwnerId,dispatchKey:license.dispatchKey || '',allowTms:profile.allowTms ?? license.allowTms ?? true,
                msg:active?'':'구독 이용기간이 만료되었습니다. 구독을 확인해 주세요.'};
        }
        tx.set(ref,{...account,access:latest,billingSnapshotAt:latest.snapshotAt,lastSyncAt:now});
        return {active:false,valid:false,msg:'확인된 Google Play 구독이 없습니다.'};
    });
}
module.exports = { ENTITLEMENT, PRODUCTS, verifiedPhone, deviceId, evaluatePurchase, ensureAccount, applyPurchase };
