const admin = require('firebase-admin');
const { timingSafeEqual } = require('node:crypto');
const { problem, assertDriverSession, assertNotBlocked } = require('../server/license-integrity.cjs');
const { ENTITLEMENT, PRODUCTS, verifiedPhone, deviceId, evaluatePurchase, ensureAndroidAccount, applyPurchase, requestTiming } = require('../server/billing.cjs');
function createHandler({sdk=admin,env=process.env,fetchImpl=(...args)=>fetch(...args),now=Date.now}={}) {
    const ready = () => /^goog_[A-Za-z0-9]+$/.test(env.REVENUECAT_ANDROID_PUBLIC_KEY || '') &&
        !!env.REVENUECAT_SECRET_API_KEY?.trim() && (env.REVENUECAT_WEBHOOK_AUTH || '').length >= 32;
    async function verifyUnused({account,orders}) {
        // Only fixed diagnostic labels/statuses reach the app. Never expose
        // upstream bodies, keys, customer IDs or order identifiers.
        const denied=(code,message)=>problem('['+code+'] '+message+' 기존 연결은 유지됩니다.',409);
        const httpStatus=r=>Number.isInteger(r.status)&&r.status>=100&&r.status<=599?r.status:0;
        async function request(stage,url,headers){
            try{return await fetchImpl(url,{headers,signal:AbortSignal.timeout(15000)});}
            catch{throw denied(stage+'_NETWORK',stage==='RC'?'RevenueCat 조회 연결 실패 또는 시간 초과입니다.':'토스 주문 조회 연결 실패 또는 시간 초과입니다.');}
        }
        async function json(stage,response){
            try{return await response.json();}
            catch{throw denied(stage+'_JSON','결제 조회 응답을 해석하지 못했습니다.');}
        }
        if(!ready())throw denied('RC_CONFIG','RevenueCat 서버 설정 확인이 필요합니다.');
        const response=await request('RC','https://api.revenuecat.com/v1/subscribers/'+encodeURIComponent(account.rcUserId),{
            Authorization:'Bearer '+env.REVENUECAT_SECRET_API_KEY});
        if(!response.ok)throw denied('RC_HTTP_'+httpStatus(response),'RevenueCat 고객 조회가 거절되었습니다.');
        const payload=await json('RC',response),s=payload?.subscriber;
        if(!s||!Number.isFinite(payload?.request_date_ms))throw denied('RC_FORMAT','RevenueCat 응답에 필요한 정보가 없습니다.');
        if(Math.abs(now()-payload.request_date_ms)>120000)throw denied('RC_STALE','RevenueCat 조회 응답 시간이 유효하지 않습니다.');
        const fields=['subscriptions','non_subscriptions','entitlements'];
        if(!fields.every(k=>s[k]&&typeof s[k]==='object'&&!Array.isArray(s[k])))throw denied('RC_FORMAT','RevenueCat 구매 목록 형식을 확인하지 못했습니다.');
        if(s.original_purchase_date||fields.some(k=>Object.keys(s[k]).length>0))throw denied('RC_HISTORY','RevenueCat에 구매 또는 이용권 기록이 있어 자동 연결을 중단했습니다.');
        for(const order of orders){
            const secret=env.TOSS_SECRET_KEY||'';
            if(!/^(test|live)_(gsk|sk)_/.test(secret))throw denied('TOSS_CONFIG','토스 조회용 서버 키 설정 확인이 필요합니다.');
            if(secret.startsWith('test_')!==order.test)throw denied('TOSS_MODE','이전 주문과 토스 조회 키의 테스트·운영 환경이 다릅니다.');
            const r=await request('TOSS','https://api.tosspayments.com/v1/payments/orders/'+encodeURIComponent(order.id),{
                Authorization:'Basic '+Buffer.from(secret+':').toString('base64')});
            const data=await json('TOSS',r);
            // A timeout, wrong credential, or any actual payment is not proof of non-use.
            if(r.status>=200&&r.status<300)throw denied('TOSS_RECORD','토스에 결제 정보가 있어 상태 확인이 필요합니다.');
            if(r.status!==404)throw denied('TOSS_HTTP_'+httpStatus(r),'토스 주문 조회가 거절되거나 실패했습니다.');
            if(data?.code!=='NOT_FOUND_PAYMENT')throw denied('TOSS_NOT_FOUND_UNCONFIRMED','토스의 조회 결과를 미결제 확인으로 판단할 수 없습니다.');
        }
    }
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
            const account=await measure('account',()=>ensureAndroidAccount(db,identity,input,now(),verifyUnused));
            if(input.licenseKey&&input.licenseKey!==account.licenseKey)throw problem('구독 계정과 이용권이 일치하지 않습니다.',403);
            if(input.action==='sync'&&account.webManaged){
                const service=require('./payment-confirm.js').createService({sdk,env,fetchImpl,now});
                return reply(200,await service.syncWeb(db,identity.uid,device,measure));
            }
            if(!ready())throw problem('구독 서비스를 준비하고 있습니다. 잠시 후 다시 확인해 주세요.',503);
            if(input.action==='session')return reply(200,{appUserId:account.rcUserId,canPurchase:account.canPurchase,reason:account.reason});
            return reply(200,await measure('play_sync',()=>sync(db,identity.uid,device)));
        }catch(error){return reply(error.status || 500,{error:error.status?error.message:'구독 확인 중 오류가 발생했습니다. 잠시 후 다시 확인해 주세요.'});}
    };
}
module.exports=createHandler();module.exports.createHandler=createHandler;
