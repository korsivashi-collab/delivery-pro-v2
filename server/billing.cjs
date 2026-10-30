const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { normalizePhone, phoneDigits, problem, isActive, assertNotBlocked, effectivePeriod, withoutDriverConnection, releaseInactiveDriverConnections } = require('./license-integrity.cjs');
const ENTITLEMENT = 'delivery_pro';
const PRODUCTS = ['delivery_pro:monthly','delivery_pro:quarterly','delivery_pro:halfyearly','delivery_pro:yearly'];
// Request-local durations only: no tokens, phone numbers, keys or payment data.
function requestTiming(res) {
    const started = performance.now(), spans = new Map();
    return {
        async measure(name, operation) {
            const start = performance.now();
            try { return await operation(); }
            finally { spans.set(name, (spans.get(name) || 0) + performance.now() - start); }
        },
        finish() {
            spans.set('total', performance.now() - started);
            res.setHeader('Server-Timing', [...spans].map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`).join(', '));
        }
    };
}
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
// RevenueCat v1 may return the Google subscription ID and base plan separately.
function canonicalProduct(id, plan) {
    if (typeof id !== 'string') return '';
    const combined=id.includes(':')?id:typeof plan==='string'?id+':'+plan:'';
    if (!PRODUCTS.includes(combined)) return '';
    if (id.includes(':') && plan && plan!==id.split(':')[1]) return '';
    return combined;
}
// A bounded summary of the server response; never store credentials or the raw receipt.
function purchaseDiagnosis(payload, now, allowSandbox = false) {
    const subscriber=payload?.subscriber || {}, entitlement=subscriber.entitlements?.[ENTITLEMENT];
    const subscriptions=Object.entries(subscriber.subscriptions || {}).slice(0,20).map(([id,p])=>({
        productId:String(id).slice(0,160), productPlanId:String(p.product_plan_identifier || '').slice(0,160),
        store:String(p.store || '').slice(0,40), sandbox:typeof p.is_sandbox==='boolean'?p.is_sandbox:null,
        refunded:p.refunded_at!=null,
        expiresAt:Math.max(Date.parse(p.expires_date)||0,Date.parse(p.grace_period_expires_date)||0)
    }));
    const product=entitlement?.product_identifier;
    const matching=subscriptions.filter(p=>p.productId===product || p.productId.split(':')[0]===product);
    let code='ACTIVE';
    if(!entitlement)code='ENTITLEMENT_MISSING';
    else if(!matching.length)code='SUBSCRIPTION_MISSING';
    else if(!matching.some(p=>!!canonicalProduct(p.productId,p.productPlanId)))code='PRODUCT_ID_UNRECOGNIZED';
    else if(!matching.some(p=>!!canonicalProduct(p.productId,p.productPlanId)&&p.store==='play_store'&&!p.refunded&&typeof p.sandbox==='boolean'&&(!p.sandbox||allowSandbox)))code='STORE_REFUND_OR_SANDBOX_REJECTED';
    else if(!evaluatePurchase(payload,now,allowSandbox).active)code='EXPIRED_OR_INVALID_EXPIRY';
    return {code,checkedAt:now,allowSandbox,entitlementProduct:String(product || '').slice(0,160),
        entitlementExpiresAt:Math.max(Date.parse(entitlement?.expires_date)||0,Date.parse(entitlement?.grace_period_expires_date)||0),subscriptions};
}
function evaluatePurchase(payload, now, allowSandbox = false) {
    if (!payload?.subscriber || !Number.isFinite(payload.request_date_ms)) throw problem('구독 확인 서버 응답이 올바르지 않습니다.', 502);
    const subscriber = payload.subscriber, entitlement = subscriber.entitlements?.[ENTITLEMENT];
    const empty = { active: false, expiresAt: 0, snapshotAt: payload.request_date_ms };
    if (!entitlement) return empty;
    const product = entitlement.product_identifier;
    const entries = Object.entries(subscriber.subscriptions || {}).filter(([id]) => id === product || id.split(':')[0] === product);
    const candidates = entries.filter(([id, purchase]) => canonicalProduct(id,purchase.product_plan_identifier) && purchase.store === 'play_store' &&
        purchase.refunded_at == null && typeof purchase.is_sandbox === 'boolean' && (!purchase.is_sandbox || allowSandbox));
    const entitlementExpiry = Math.max(Date.parse(entitlement.expires_date) || 0, Date.parse(entitlement.grace_period_expires_date) || 0);
    const valid = candidates.map(([id, purchase]) => ({ productId: canonicalProduct(id,purchase.product_plan_identifier), sandbox: purchase.is_sandbox,
        ...(typeof purchase.store_transaction_id==='string'?{transactionId:purchase.store_transaction_id}:{}),
        expiresAt: Math.min(entitlementExpiry, Math.max(Date.parse(purchase.expires_date) || 0, Date.parse(purchase.grace_period_expires_date) || 0)) }))
        .filter(purchase => purchase.expiresAt > now).sort((a,b) => b.expiresAt-a.expiresAt)[0];
    return valid ? { ...valid, active: true, snapshotAt: payload.request_date_ms } : empty;
}
// The web checkout uses the default path unchanged. Only the Android API opts
// into key-owned billing with replaceable, verified checkout contacts.
async function ensureAndroidAccount(db, identity, input, now) {
    if(identity?.testDriverSession)throw problem('구매 전 실제 휴대폰 인증이 필요합니다.',403);
    const phone=verifiedPhone(identity), device=deviceId(input.deviceId);
    const key=String(input.newLicense===true ? '' : input.licenseKey || identity.driverKey || '').trim().toUpperCase();
    if(key && (key.length>100 || /[\/\\\u0000-\u001f]/.test(key)))throw problem('라이선스 키가 올바르지 않습니다.');
    if(key)await releaseInactiveDriverConnections(db,now,key);
    return db.runTransaction(async tx=>{
        await assertNotBlocked(db,tx,key,phone,device);
        const accounts=await tx.get(db.collection('billing_accounts'));
        let license={}, profile={}, binding={}, owner, ref, selectedKey=key;
        if(key){
            const [l,p,b]=await Promise.all(['licenses','driver_profiles','billing_license_bindings'].map(c=>tx.get(db.collection(c).doc(key))));
            license=l.data() || {};profile=p.data() || {};binding=b.data() || {};
            const candidates=accounts.docs.filter(d=>d.data().licenseKey===key && d.data().deletedAt==null);
            if(candidates.length>1)throw problem('이 키의 결제 연결을 확인해 주세요.',409);
            const saved=binding.uid ? accounts.docs.find(d=>d.id===binding.uid) : candidates[0];
            owner=saved?.data();ref=saved?.ref;
            if(binding.uid && (!owner || owner.deletedAt!=null || owner.licenseKey!==key))throw problem('결제 소유자 연결 정보를 확인해 주세요.',409);
            if(license.billingUid && license.billingUid!==ref?.id)throw problem('이 키의 결제 소유자 연결을 확인해 주세요.',409);
            if(!l.exists && !owner)throw problem('등록되지 않은 라이선스 키입니다.',404);
            if(['suspended','revoked','upgraded'].includes(license.status) || ['suspended','revoked','upgraded'].includes(profile.status) || license.type==='dispatch')throw problem('접속이 제한된 이용권입니다.',403);
            const session=identity.driverKey===key && identity.driverSessionId && license.driverSessionId===identity.driverSessionId &&
                license.driverUid===identity.uid && license.deviceId===device && identity.driverDeviceId===device && phoneDigits(license.phone)===phoneDigits(phone);
            if(identity.driverKey===key && !session && isActive(license,new Date(now+9*3600000).toISOString().slice(0,10),now))throw problem('접속이 해제되었습니다. 전화번호를 다시 인증해 주세요.',401);
            const age=Math.floor(now/1000)-identity.auth_time;
            if(!session && !(owner?.checkoutUid===identity.uid && owner?.checkoutDevice===device && owner?.checkoutUntil>now) &&
                (!Number.isFinite(age)||age < -30||age>300))throw problem('이 키로 구매하려면 전화번호를 다시 인증해 주세요.',401);
        }else{
            const saved=accounts.docs.find(d=>d.data().checkoutUid===identity.uid && d.data().checkoutDevice===device &&
                d.data().checkoutUntil>now && d.data().keyScoped===true && !d.data().access?.active && d.data().deletedAt==null);
            owner=saved?.data();ref=saved?.ref;selectedKey=owner?.licenseKey || '';
        }
        const web=license.webManaged || profile.webManaged || binding.provider==='toss' || owner?.webManaged || owner?.pendingWebOrder || owner?.webHistory?.length;
        const manual=key && license.type && license.type!=='trial' && !license.billingManaged && isActive(license,new Date(now+9*3600000).toISOString().slice(0,10),now) && !binding.uid;
        if(web || manual)return {...owner,licenseKey:key,canPurchase:false,reason:web?'웹에서 구매한 이용권 또는 주문이 연결되어 있습니다. 기존 웹 결제 경로에서 확인해 주세요.':'현재 사용 중인 기존 이용권의 만료일은 '+(license.expireDate || '')+'입니다. 남은 기간을 확인해 주세요.'};
        if(!selectedKey){
            for(let i=0;i<10;i++){
                const candidate=randomBytes(4).toString('hex').toUpperCase();
                const reserved=await Promise.all(['licenses','driver_profiles','billing_license_bindings'].map(c=>tx.get(db.collection(c).doc(candidate))));
                if(!reserved.some(d=>d.exists)&&!accounts.docs.some(d=>d.data().licenseKey===candidate)){selectedKey=candidate;break;}
            }
            if(!selectedKey)throw problem('이용권 생성에 실패했습니다.',503);
        }
        if(!owner){
            const uid='license-'+selectedKey;ref=db.collection('billing_accounts').doc(uid);
            if((await tx.get(ref)).exists)throw problem('이 키의 결제 연결을 확인해 주세요.',409);
            owner={uid,licenseKey:selectedKey,rcUserId:'dp_android_'+randomUUID(),createdAt:now,keyScoped:true};
        }
        const result={...owner,uid:ref.id,checkoutUid:identity.uid,checkoutDevice:device,checkoutUntil:now+30*60*1000,
            notificationPhone:phone,phone:owner.phone || phone};
        tx.set(ref,result);
        tx.set(db.collection('billing_customer_ids').doc(result.rcUserId),{uid:ref.id});
        tx.set(db.collection('billing_license_bindings').doc(selectedKey),{...binding,uid:ref.id,rcUserId:result.rcUserId});
        return {...result,canPurchase:true,reason:''};
    });
}
async function ensureAccount(db, identity, input, now, android = false) {
    const phone = verifiedPhone(identity), device = deviceId(input.deviceId), ref = db.collection('billing_accounts').doc(identity.uid);
    const lockRef = db.collection('admin_license_controls').doc('phone_integrity');
    return db.runTransaction(async tx => {
        const [saved, lock, blocked, licenses] = await Promise.all([tx.get(ref), tx.get(lockRef),
            assertNotBlocked(db, tx, '', phone, device), tx.get(db.collection('licenses'))]);
        const previous = saved.data();
        if (previous?.licenseKey) await assertNotBlocked(db, tx, previous.licenseKey, phone, device, blocked);
        const restarting = previous?.deletedAt != null;
        const account = restarting ? null : previous;
        if (account && phoneDigits(account.phone) !== phoneDigits(phone)) throw problem('구독 계정의 인증 번호가 변경되었습니다. 고객센터에 문의해 주세요.', 409);
        // Android keeps the signed login key stable, including legacy PLAY keys.
        // The existing web migration path is unchanged.
        const migrate=!android && account && /^PLAY-[0-9A-F]{32}$/.test(account.licenseKey);
        // Existing accounts use their fixed key. Profiles are needed only for legacy lookup/migration.
        // Keep the license scan: legacy phone formats and duplicate active accounts must still be checked.
        const profiles = !account || migrate ? await tx.get(db.collection('driver_profiles')) : {docs:[]};
        const matched = licenses.docs.filter(doc => phoneDigits(doc.data().phone) === phoneDigits(phone));
        let current = account ? licenses.docs.find(doc => doc.id === account.licenseKey) :
            matched.find(doc => doc.data().type !== 'dispatch' && !['revoked','upgraded'].includes(doc.data().status)) ||
            profiles.docs.find(doc => phoneDigits(doc.data().phone) === phoneDigits(phone) && !['revoked','upgraded'].includes(doc.data().status));
        let androidWebOwned = false;
        if (android) {
            const key = identity.driverKey;
            if (key) {
                // Verify the signed session against the canonical server record.
                // Expiry alone must not prevent buying a new prepaid period.
                const loggedIn = licenses.docs.find(doc => doc.id === key), data = loggedIn?.data();
                if (!data || !identity.driverSessionId || data.driverSessionId !== identity.driverSessionId ||
                    data.driverUid !== identity.uid || data.deviceId !== device || identity.driverDeviceId !== device ||
                    phoneDigits(data.phone) !== phoneDigits(phone)) throw problem('로그인 연결이 변경되었습니다. 휴대폰 인증 후 다시 로그인해 주세요.', 401);
                if (input.licenseKey && input.licenseKey !== key) throw problem('로그인한 이용권과 요청한 이용권이 다릅니다.', 403);
                if (['suspended','revoked','upgraded'].includes(data.status) || data.type === 'dispatch') throw problem('접속이 제한된 이용권입니다.',403);
                if (account && account.licenseKey !== key) throw problem('로그인 이용권과 기존 결제 연결이 다릅니다. 고객센터에 연결 확인을 요청해 주세요.',409);
                current = loggedIn;
            } else if (!account) {
                const candidates = matched.filter(doc => doc.data().type !== 'dispatch' && !['suspended','revoked','upgraded'].includes(doc.data().status));
                const activePaid = candidates.filter(doc => doc.data().type !== 'trial' && isActive(doc.data(),new Date(now+9*3600000).toISOString().slice(0,10),now));
                const activeTrial = candidates.filter(doc => doc.data().type === 'trial' && isActive(doc.data(),new Date(now+9*3600000).toISOString().slice(0,10),now));
                const choices = activePaid.length ? activePaid : activeTrial.length ? activeTrial : candidates;
                if (choices.length > 1) throw problem('같은 번호의 이용권 연결을 확인해야 합니다. 고객센터에 문의해 주세요.',409);
                current = choices[0] || current;
            }
            if (input.licenseKey && input.licenseKey !== current?.id) throw problem('구독 계정과 이용권이 일치하지 않습니다.',403);
            if (current) {
                const binding = await tx.get(db.collection('billing_license_bindings').doc(current.id));
                const profile = await tx.get(db.collection('driver_profiles').doc(current.id));
                const data = current.data();
                androidWebOwned = binding.data()?.provider === 'toss' || data.webManaged === true || profile.data()?.webManaged === true;
                if (binding.exists && binding.data().uid !== identity.uid || data.billingUid && data.billingUid !== identity.uid || data.driverUid && data.driverUid !== identity.uid) {
                    throw problem('이용권 소유자 정보를 확인해 주세요.',403);
                }
            }
        }
        if (matched.some(doc => doc.data().type === 'dispatch')) throw problem('관제 계정은 기사 앱 구독으로 변경할 수 없습니다.', 409);
        if (matched.some(doc => doc.id !== current?.id && doc.data().type !== 'trial' && isActive(doc.data(), new Date(now+9*3600000).toISOString().slice(0,10), now))) {
            throw problem('같은 번호에 다른 이용권이 있습니다. 고객센터에 문의해 주세요.', 409);
        }
        if (current?.data().deviceId && current.data().deviceId !== device) throw problem('다른 기기에 연결된 계정입니다. 고객센터에 기기 변경을 요청해 주세요.', 409);
        if (['suspended','revoked'].includes(current?.data().status)) throw problem('접속이 제한된 계정입니다.', 403);
        const oldProfile=migrate?profiles.docs.find(d=>d.id===account.licenseKey):null;
        const orders=migrate?await tx.get(db.collection('payment_orders').where('uid','==',identity.uid)):null;
        let newKey;
        if ((!account && !current) || migrate) {
            const reservedAccounts=await tx.get(db.collection('billing_accounts'));
            for (let attempt=0;attempt<10;attempt++) {
                const candidate=randomBytes(5).toString('hex').slice(0,8).toUpperCase();
                const binding=await tx.get(db.collection('billing_license_bindings').doc(candidate));
                if (!binding.exists && !reservedAccounts.docs.some(d=>d.data().licenseKey===candidate) && !licenses.docs.some(d=>d.id===candidate) && !profiles.docs.some(d=>d.id===candidate)) { newKey=candidate;break; }
            }
            if (!newKey) throw problem('이용권 번호 생성에 실패했습니다. 다시 시도해 주세요.',503);
        }
        const result = migrate ? {...account,licenseKey:newKey,previousLicenseKey:account.licenseKey} : account || { uid: identity.uid, phone, rcUserId: 'dp_android_'+randomUUID(),
            licenseKey: current?.id || newKey, createdAt: now };
        const activeManual = android && (androidWebOwned || account?.pendingWebOrder || account?.webHistory?.length) || account?.webManaged === true || account?.pendingWebUntil > now || current && current.data().type !== 'trial' && !current.data().billingManaged &&
            isActive(current.data(), new Date(now+9*3600000).toISOString().slice(0,10), now);
        if (migrate) {
            const oldKey=account.licenseKey;
            const owner=current?.data().routeOwnerId||oldProfile?.data().routeOwnerId||oldKey;
            if(current)tx.set(db.collection('licenses').doc(newKey),{...current.data(),key:newKey,routeOwnerId:owner});
            if(oldProfile)tx.set(db.collection('driver_profiles').doc(newKey),{...oldProfile.data(),key:newKey,routeOwnerId:owner});
            for(const [name,doc] of [['licenses',current],['driver_profiles',oldProfile]])if(doc)tx.set(db.collection(name).doc(oldKey),{...doc.data(),status:'upgraded',upgradedTo:newKey,upgradedAt:now});
            for(const doc of orders.docs)if(doc.data().uid===identity.uid&&doc.data().licenseKey===oldKey)tx.set(doc.ref,{...doc.data(),licenseKey:newKey});
            tx.set(db.collection('billing_license_bindings').doc(newKey),{uid:identity.uid,...(account.webManaged?{provider:'toss'}:{})});
            tx.set(ref,result);
            tx.set(lockRef,{revision:(lock.data()?.revision||0)+1,updatedAt:now});
        }
        if (!account) {
            if(restarting){
                tx.set(db.collection('admin_license_controls').doc('billing-archive-'+previous.rcUserId),previous);
                tx.delete(db.collection('billing_customer_ids').doc(previous.rcUserId));
                tx.set(ref,result);
            }else tx.create(ref, result);
            tx.create(db.collection('billing_customer_ids').doc(result.rcUserId), { uid: identity.uid });
            tx.set(lockRef, { revision: (lock.data()?.revision || 0)+1, updatedAt: now });
        }
        const reason = activeManual ? account?.webManaged ? '웹 기간권 계정입니다. Google Play 구독으로 전환하려면 고객센터에 문의해 주세요.' : '현재 이용권 또는 진행 중인 주문이 있습니다. 확인 후 다시 요청하거나 고객센터에 문의해 주세요.' : '';
        const androidReason = activeManual ? account?.webManaged || androidWebOwned
            ? '웹에서 구매한 이용권이 연결되어 있습니다. 기존 이용권과 이용기간은 유지됩니다. Google Play 결제 전환은 고객센터에서 확인해 주세요.'
            : account?.pendingWebOrder || account?.webHistory?.length || account?.pendingWebUntil > now ? '웹 주문 연결이 남아 있습니다. 관리자에서 기존 주문을 확인해 주세요. 앱에서 주문이나 이용권을 자동 변경하지 않습니다.'
            : '현재 사용 중인 기존 이용권'+(current?.data().expireDate?'의 만료일은 '+current.data().expireDate+'입니다.':'이 있습니다.')+' 남은 기간의 중복 결제를 막기 위해 Google Play 구매를 제한합니다.' : '';
        return { ...result, canPurchase: !activeManual, reason: android ? androidReason : reason };
    });
}
async function applyPurchase(db, uid, entitlement, now, device = null, expectedCustomer = null) {
    const ref = db.collection('billing_accounts').doc(uid), lockRef = db.collection('admin_license_controls').doc('phone_integrity');
    const known=(await ref.get()).data();if(known?.licenseKey)await releaseInactiveDriverConnections(db,now,known.licenseKey);
    return db.runTransaction(async tx => {
        const accountSnap = await tx.get(ref), account = accountSnap.data();
        if (!account) throw problem('구독 계정을 찾을 수 없습니다.',404);
        if(expectedCustomer && account.rcUserId!==expectedCustomer)return {active:false,valid:false,msg:'계정이 변경되었습니다. 다시 확인해 주세요.'};
        if(account.deletedAt!=null)return {active:false,valid:false,msg:'삭제된 계정입니다.'};
        // A web period must never be overwritten by an unrelated Play webhook.
        if (account.webManaged || account.webHistory?.length || account.pendingWebOrder) return {active:false,valid:false,msg:'웹 주문 또는 이용권 연결 확인이 필요합니다. 기존 이용권은 유지됩니다.'};
        const licenseRef = db.collection('licenses').doc(account.licenseKey), profileRef = db.collection('driver_profiles').doc(account.licenseKey);
        const bindingRef = db.collection('billing_license_bindings').doc(account.licenseKey);
        const [licenseSnap, profileSnap, binding, lock, blocked, allLicenses] = await Promise.all([
            tx.get(licenseRef), tx.get(profileRef), tx.get(bindingRef), tx.get(lockRef),
            assertNotBlocked(db, tx, account.licenseKey, '', device), tx.get(db.collection('licenses'))]);
        const license = licenseSnap.data() || {}, profile = profileSnap.data() || {};
        if (license.webManaged || profile.webManaged || binding.data()?.provider === 'toss') {
            return {active:false,valid:false,msg:'웹 이용권을 다시 확인해 주세요.'};
        }
        if (binding.exists && binding.data().uid !== uid) throw problem('이용권 소유자가 다릅니다.',403);
        if (license.routeOwnerId && profile.routeOwnerId && license.routeOwnerId !== profile.routeOwnerId) throw problem('계정 소유자 정보를 확인해 주세요.',409);
        if(account.keyScoped && entitlement.active && !entitlement.transactionId)throw problem('결제 식별자를 확인하지 못했습니다. 잠시 후 기존 구매 확인을 눌러 주세요.',502);
        let transactionRef;
        if(entitlement.active && entitlement.transactionId){
            transactionRef=db.collection('billing_purchase_bindings').doc(createHash('sha256').update(entitlement.transactionId).digest('hex'));
            const original=(await tx.get(transactionRef)).data();
            const owners=await tx.get(db.collection('billing_accounts'));
            if(original && original.uid!==uid || owners.docs.some(d=>d.data().licenseKey!==account.licenseKey && d.data().access?.transactionId===entitlement.transactionId))
                throw problem('이 구매는 다른 라이선스 키에 연결되어 있습니다. 원래 키에서 기존 구매를 확인해 주세요.',409);
        }
        // Prevent old concurrent REST responses from rolling back newer subscription state.
        const latest = (account.billingSnapshotAt || 0) > entitlement.snapshotAt ? account.access : entitlement;
        if (['suspended','revoked'].includes(license.status) || ['suspended','revoked'].includes(profile.status)) return {active:false,valid:false,msg:'접속이 제한된 계정입니다.'};
        if (latest.active && !binding.exists) {
            if (license.type === 'dispatch') throw problem('관제 계정은 구독으로 변경할 수 없습니다.',409);
            if (license.type !== 'trial' && licenseSnap.exists && isActive(license,new Date(now+9*3600000).toISOString().slice(0,10),now)) throw problem('기존 이용권이 남아 있습니다. 고객센터에 문의해 주세요.',409);
        }
        const active = latest.active === true && latest.expiresAt > now;
        if (active || binding.exists || license.adminExpiresAt > now) {
            const routeOwnerId = license.routeOwnerId || profile.routeOwnerId || randomUUID();
            const expiresAt = effectivePeriod(license, active ? latest.expiresAt : Math.min(latest.expiresAt || now,now), now).expiresAt;
            const effectiveActive = expiresAt > now;
            const expireDate = new Date(expiresAt+9*3600000).toISOString().slice(0,10).replace(/-/g,'.');
            const data = { phone: license.phone || '', routeOwnerId, deviceId: license.deviceId || profile.deviceId || '',
                type:'regular', isTrial:false, status:effectiveActive?'active':'expired', billingManaged:true, billingUid:uid,
                expiresAt, expireDate, subscriptionProduct:latest.productId || '', subscriptionSandbox:latest.sandbox === true };
            tx.set(licenseRef,effectiveActive?{...license,...data,key:account.licenseKey,dispatchKey:license.dispatchKey || '',isPro:true,createdAt:license.createdAt || now}:withoutDriverConnection({...license,...data,key:account.licenseKey,dispatchKey:license.dispatchKey || '',isPro:true,createdAt:license.createdAt || now}));
            tx.set(profileRef,effectiveActive?{...profile,...data,key:account.licenseKey,allowTms:profile.allowTms ?? license.allowTms ?? true}:withoutDriverConnection({...profile,...data,key:account.licenseKey,allowTms:profile.allowTms ?? license.allowTms ?? true}));
            tx.set(bindingRef,{uid,rcUserId:account.rcUserId});
            if(transactionRef)tx.set(transactionRef,{licenseKey:account.licenseKey,uid,transactionId:entitlement.transactionId});
            tx.set(lockRef,{revision:(lock.data()?.revision || 0)+1,updatedAt:now});
            tx.set(ref,{...account,access:{...latest,active},billingSnapshotAt:latest.snapshotAt,lastSyncAt:now});
            return {active:effectiveActive,valid:effectiveActive,billingManaged:true,actualKey:account.licenseKey,phone:account.phone,expireDate,expiresAt,
                routeOwnerId,dispatchKey:license.dispatchKey || '',allowTms:profile.allowTms ?? license.allowTms ?? true,
                msg:effectiveActive?'':'구독 이용기간이 만료되었습니다. 구독을 확인해 주세요.'};
        }
        tx.set(ref,{...account,access:latest,billingSnapshotAt:latest.snapshotAt,lastSyncAt:now});
        return {active:false,valid:false,msg:'확인된 Google Play 구독이 없습니다.'};
    });
}
module.exports = { purchaseDiagnosis, ENTITLEMENT, PRODUCTS, verifiedPhone, deviceId, evaluatePurchase, ensureAccount, ensureAndroidAccount, applyPurchase, requestTiming };
