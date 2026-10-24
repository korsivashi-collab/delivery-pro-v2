const admin = require('firebase-admin');
const { timingSafeEqual } = require('node:crypto');
const { problem, assertDriverSession, assertNotBlocked } = require('../server/license-integrity.cjs');
const { ENTITLEMENT, PRODUCTS, verifiedPhone, deviceId, evaluatePurchase, ensureAndroidAccount, applyPurchase, requestTiming } = require('../server/billing.cjs');
function createHandler({sdk=admin,env=process.env,fetchImpl=(...args)=>fetch(...args),now=Date.now}={}) {
    const ready = () => /^goog_[A-Za-z0-9]+$/.test(env.REVENUECAT_ANDROID_PUBLIC_KEY || '') &&
        !!env.REVENUECAT_SECRET_API_KEY?.trim() && (env.REVENUECAT_WEBHOOK_AUTH || '').length >= 32;
    async function sync(db,uid,device=null) {
        const account = (await db.collection('billing_accounts').doc(uid).get()).data();
        if (!account) throw problem('구독 계정을 찾을 수 없습니다.',404);
        const response=await fetchImpl('https://api.revenuecat.com/v1/subscribers/'+encodeURIComponent(account.rcUserId),{
            headers:{Authorization:'Bearer '+env.REVENUECAT_SECRET_API_KEY,'Content-Type':'application/json'},signal:AbortSignal.timeout(15000)});
        if (!response.ok) throw problem('구독 확인 서버에 연결하지 못했습니다. 구매를 반복하지 말고 구매 복원을 눌러 주세요.',502);
        const payload=await response.json(),stamp=now();
        if (!Number.isFinite(payload.request_date_ms) || Math.abs(stamp-payload.request_date_ms)>120000) throw problem('구독 확인 응답이 오래되었습니다. 다시 확인해 주세요.',502);
        return applyPurchase(db,uid,evaluatePurchase(payload,stamp,env.REVENUECAT_ALLOW_SANDBOX==='true'),stamp,device,account.rcUserId);
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
            const account=await measure('account',()=>ensureAndroidAccount(db,identity,input,now()));
            if(input.licenseKey&&input.licenseKey!==account.licenseKey)throw problem('구독 계정과 이용권이 일치하지 않습니다.',403);
            if(input.action==='sync'&&account.webManaged){
                const service=require('./payment-confirm.js').createService({sdk,env,fetchImpl,now});
                return reply(200,await service.syncWeb(db,account.uid,device,measure));
            }
            if(!ready())throw problem('구독 서비스를 준비하고 있습니다. 잠시 후 다시 확인해 주세요.',503);
            if(input.action==='session')return reply(200,{appUserId:account.rcUserId,canPurchase:account.canPurchase,reason:account.reason});
            if(!account.canPurchase)return reply(200,{active:false,valid:false,msg:account.reason});
            return reply(200,await measure('play_sync',()=>sync(db,account.uid,device)));
        }catch(error){return reply(error.status || 500,{error:error.status?error.message:'구독 확인 중 오류가 발생했습니다. 잠시 후 다시 확인해 주세요.'});}
    };
}
module.exports=createHandler();module.exports.createHandler=createHandler;
