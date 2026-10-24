const admin = require('firebase-admin');
const { timingSafeEqual, createHmac, createHash } = require('node:crypto');
const { problem, assertDriverSession, assertNotBlocked } = require('../server/license-integrity.cjs');
const { ENTITLEMENT, PRODUCTS, verifiedPhone, deviceId, purchaseDiagnosis, evaluatePurchase, ensureAccount, ensureAndroidAccount, applyPurchase, requestTiming } = require('../server/billing.cjs');

async function sendPlayLicenseSms(db,uid,customer,purchase,{env,fetchImpl,stamp}) {
    const [access,secret,serviceId]=['NCP_ACCESS_KEY','NCP_SECRET_KEY','NCP_SENS_SERVICE_ID'].map(k=>env[k]?.trim());
    if(!access||!secret||!/^ncp:sms:[a-z]{2}:\d+:[A-Za-z0-9_-]+$/.test(serviceId||''))return 'unavailable';
    const notificationId=createHash('sha256').update(JSON.stringify([customer,purchase.productId,purchase.transactionId||'',purchase.expiresAt])).digest('hex');
    const ref=db.collection('billing_purchase_notifications').doc(notificationId);
    const claim=await db.runTransaction(async tx=>{
        const account=(await tx.get(db.collection('billing_accounts').doc(uid))).data();
        const saved=(await tx.get(ref)).data();
        if(!account || account.deletedAt!=null || account.rcUserId!==customer || account.webManaged ||
            !account.access?.active || account.access.expiresAt<=stamp || !purchase.active)return {status:'unavailable'};
        const license=(await tx.get(db.collection('licenses').doc(account.licenseKey))).data();
        if(!license || license.billingUid!==uid || license.webManaged ||
            ['suspended','revoked'].includes(license.status))return {status:'unavailable'};
        if(saved)return {status:saved.status};
        const to=String(account.notificationPhone||account.phone||'').replace(/\D/g,'');
        if(!/^010\d{8}$/.test(to))return {status:'unavailable'};
        tx.create(ref,{uid,licenseKey:account.licenseKey,status:'sending',requestedAt:stamp});
        return {send:true,to,key:account.licenseKey,expireDate:license.expireDate};
    });
    if(!claim.send)return claim.status;
    let status='unknown',requestId=null;
    try {
        const uri=`/sms/v2/services/${serviceId}/messages`,timestamp=String(stamp);
        const signature=createHmac('sha256',secret).update(`POST ${uri}
${timestamp}
${access}`).digest('base64');
        const response=await fetchImpl('https://sens.apigw.ntruss.com'+uri,{method:'POST',signal:AbortSignal.timeout(10000),
            headers:{'Content-Type':'application/json','x-ncp-apigw-timestamp':timestamp,'x-ncp-iam-access-key':access,'x-ncp-apigw-signature-v2':signature},
            body:JSON.stringify({type:'LMS',contentType:'COMM',countryCode:'82',from:'01083294575',subject:'배송경로PRO 이용권 안내',
                content:`[배송경로PRO 이용권 안내]
결제가 완료되었습니다.
라이선스 키: ${claim.key}
사용기한: ${claim.expireDate}
위 키로 전화번호 인증 후 로그인해 주세요.`,
                messages:[{to:claim.to}]})});
        const data=await response.json();status=response.ok&&String(data.statusCode)==='202'?'accepted':'failed';
        requestId=typeof data.requestId==='string'?data.requestId:null;
    } catch {}
    await db.runTransaction(async tx=>{
        const saved=(await tx.get(ref)).data();
        if(saved)tx.set(ref,{...saved,status,requestId,updatedAt:stamp});
    });
    return status;
}

function createHandler({sdk=admin,env=process.env,fetchImpl=(...args)=>fetch(...args),now=Date.now}={}) {
    const ready = () => /^goog_[A-Za-z0-9]+$/.test(env.REVENUECAT_ANDROID_PUBLIC_KEY || '') &&
        !!env.REVENUECAT_SECRET_API_KEY?.trim() && (env.REVENUECAT_WEBHOOK_AUTH || '').length >= 32;
    async function sync(db,uid,device=null) {
        const account = (await db.collection('billing_accounts').doc(uid).get()).data();
        if (!account) throw problem('구독 계정을 찾을 수 없습니다.',404);
        async function readCustomer(customer){
            const response=await fetchImpl('https://api.revenuecat.com/v1/subscribers/'+encodeURIComponent(customer),{
                headers:{Authorization:'Bearer '+env.REVENUECAT_SECRET_API_KEY,'Content-Type':'application/json'},signal:AbortSignal.timeout(15000)});
            if(!response.ok)throw problem('구독 확인 서버에 연결하지 못했습니다. 기존 구매 확인을 눌러 주세요.',502);
            const data=await response.json();
            if(!Number.isFinite(data.request_date_ms)||Math.abs(now()-data.request_date_ms)>120000)throw problem('구독 확인 응답이 오래되었습니다. 다시 확인해 주세요.',502);
            return data;
        }
        const allowSandbox=env.REVENUECAT_ALLOW_SANDBOX==='true', stamp=now();
        let payload=await readCustomer(account.rcUserId),purchase=evaluatePurchase(payload,stamp,allowSandbox);
        const receiptRef=id=>db.collection('billing_purchase_bindings').doc(createHash('sha256').update(id).digest('hex'));
        // RevenueCat may transfer a receipt on restore. Our original key ownership stays fixed.
        if(!purchase.active && account.receiptCustomerId && account.receiptCustomerId!==account.rcUserId){
            const transferred=await readCustomer(account.receiptCustomerId),candidate=evaluatePurchase(transferred,stamp,allowSandbox);
            const binding=candidate.transactionId ? (await receiptRef(candidate.transactionId).get()).data() : null;
            if(binding?.uid===uid){payload=transferred;purchase=candidate;}
        }
        if(purchase.active && purchase.transactionId){
            const binding=(await receiptRef(purchase.transactionId).get()).data();
            if(binding && binding.uid!==uid){
                const original=await db.runTransaction(async tx=>{
                    const ref=db.collection('billing_accounts').doc(binding.uid),saved=(await tx.get(ref)).data();
                    if(!saved || saved.deletedAt!=null)return null;
                    tx.set(ref,{...saved,receiptCustomerId:account.rcUserId});return saved;
                });
                if(original)await applyPurchase(db,binding.uid,purchase,stamp,null,original.rcUserId);
                return {valid:false,active:false,msg:'이 구매는 다른 라이선스 키에 연결되어 있습니다. 원래 키로 기존 구매를 확인해 주세요.'};
            }
        }
        const diagnosis=purchaseDiagnosis(payload,stamp,allowSandbox);
        const result=await applyPurchase(db,uid,purchase,stamp,device,account.rcUserId);
        // Keep diagnostics separate from ownership and paid access. A read-only summary survives expiry.
        await db.runTransaction(async tx=>{
            const ref=db.collection('billing_accounts').doc(uid), current=(await tx.get(ref)).data();
            if(current && current.deletedAt==null && current.rcUserId===account.rcUserId &&
                !(current.purchaseDiagnosis?.checkedAt>stamp))
                tx.set(ref,{...current,purchaseDiagnosis:diagnosis});
        });
        if(result.valid && purchase.active) {
            try { result.licenseSms=await sendPlayLicenseSms(db,uid,account.rcUserId,purchase,{env,fetchImpl,stamp}); }
            catch { result.licenseSms='unknown'; }
        }
        return result;
    }
    return async(req,res)=>{
        const timing=requestTiming(res), measure=timing.measure;
        const reply=(status,data)=>{timing.finish();return res.status(status).json(data);};
        res.setHeader('Cache-Control','no-store');
        if(req.method!=='POST')return res.status(405).json({error:'POST 요청만 가능합니다.'});
        try {
            let input;try{input=typeof req.body==='string'?JSON.parse(req.body):req.body;}catch{throw problem('요청 형식이 올바르지 않습니다.');}
            if(input?.action==='config')return res.status(200).json({enabled:ready(),...(ready()?{publicKey:env.REVENUECAT_ANDROID_PUBLIC_KEY,entitlementId:ENTITLEMENT,offeringId:'default',productIds:PRODUCTS}: {})});
            if(!sdk.apps.length)sdk.initializeApp({credential:sdk.credential.cert({projectId:env.FIREBASE_PROJECT_ID,clientEmail:env.FIREBASE_CLIENT_EMAIL,privateKey:env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,'\n')})});
            const db=sdk.firestore();
            if(input?.event){
                if(!ready())throw problem('구독 서비스를 준비하고 있습니다.',503);
                const expected=Buffer.from(env.REVENUECAT_WEBHOOK_AUTH),provided=Buffer.from(String(req.headers.authorization || ''));
                if(expected.length!==provided.length||!timingSafeEqual(expected,provided))throw problem('허용되지 않은 알림입니다.',401);
                const event=input.event;if(event.type==='TEST')return res.status(200).json({ok:true,test:true});
                const id=event.id;if(typeof id!=='string'||!id||id.length>200||id.includes('/'))throw problem('알림 식별자가 올바르지 않습니다.');
                const eventRef=db.collection('billing_events').doc(id);if((await eventRef.get()).exists)return res.status(200).json({ok:true,duplicate:true});
                const ids=[event.app_user_id,event.original_app_user_id,...(Array.isArray(event.aliases)?event.aliases:[]),...(Array.isArray(event.transferred_from)?event.transferred_from:[]),...(Array.isArray(event.transferred_to)?event.transferred_to:[])];
                const known=new Set();for(const userId of [...new Set(ids)].filter(id=>typeof id==='string'&&/^dp_android_[a-f0-9-]{36}$/.test(id)).slice(0,20)){
                    const owner=(await db.collection('billing_customer_ids').doc(userId).get()).data();if(owner?.uid)known.add(owner.uid);
                }
                for(const uid of known)await sync(db,uid);
                await eventRef.set({processedAt:now(),type:String(event.type || '').slice(0,80),matchedAccounts:known.size});
                return res.status(200).json({ok:true});
            }
            if(!['session','sync','driver-sync'].includes(input?.action))throw problem('지원하지 않는 요청입니다.');
            const token=/^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];if(!token)throw problem('휴대폰 인증을 완료해 주세요.',401);
            let identity;try{identity=await measure('auth',()=>sdk.auth().verifyIdToken(token,true));}catch{throw problem('인증이 만료되었습니다. 휴대폰 인증을 다시 진행해 주세요.',401);}
            verifiedPhone(identity);const device=deviceId(input.deviceId);
            if (input.action === 'driver-sync') {
                await assertDriverSession(db, identity, input.licenseKey, device, now());
                await assertNotBlocked(db, db, input.licenseKey, identity.phone_number, device);
                const binding = (await db.collection('billing_license_bindings').doc(input.licenseKey).get()).data();
                if (!binding?.uid) throw problem('결제 연결 정보를 확인해 주세요.',409);
                const owner = (await db.collection('billing_accounts').doc(binding.uid).get()).data();
                if (owner?.licenseKey !== input.licenseKey || owner.deletedAt != null) throw problem('결제 계정 연결이 변경되었습니다.',409);
                if (owner.webManaged) {
                    const service = require('./payment-confirm.js').createService({sdk,env,fetchImpl,now});
                    return reply(200,await service.syncWeb(db,binding.uid,null,measure));
                }
                if (!ready()) throw problem('구독 서비스를 준비하고 있습니다.',503);
                return reply(200,await sync(db,binding.uid));
            }
            // Preserve the existing web buyer's sync path; Android key selection is independent.
            if(input.action==='sync' && input.newLicense!==true){
                const webOwner=(await db.collection('billing_accounts').doc(identity.uid).get()).data();
                if(webOwner?.webManaged && (!input.licenseKey || input.licenseKey===webOwner.licenseKey)){
                    await ensureAccount(db,identity,input,now());
                    const service=require('./payment-confirm.js').createService({sdk,env,fetchImpl,now});
                    return reply(200,await service.syncWeb(db,identity.uid,device,measure));
                }
            }
            const account=await measure('account',()=>ensureAndroidAccount(db,identity,input,now()));
            if(input.licenseKey&&input.licenseKey!==account.licenseKey)throw problem('구독 계정과 이용권이 일치하지 않습니다.',403);
            if(input.action==='sync'&&account.webManaged){
                const service=require('./payment-confirm.js').createService({sdk,env,fetchImpl,now});
                return reply(200,await service.syncWeb(db,account.uid,device,measure));
            }
            if(!ready())throw problem('구독 서비스를 준비하고 있습니다. 잠시 후 다시 확인해 주세요.',503);
            if(input.action==='session')return reply(200,{licenseKey:account.licenseKey,appUserId:account.rcUserId,canPurchase:account.canPurchase,reason:account.reason});
            if(!account.canPurchase)return reply(200,{active:false,valid:false,msg:account.reason});
            return reply(200,await measure('play_sync',()=>sync(db,account.uid,device)));
        }catch(error){return reply(error.status || 500,{error:error.status?error.message:'구독 확인 중 오류가 발생했습니다. 잠시 후 다시 확인해 주세요.'});}
    };
}
module.exports=createHandler();module.exports.createHandler=createHandler;

module.exports.sendPlayLicenseSms=sendPlayLicenseSms;
