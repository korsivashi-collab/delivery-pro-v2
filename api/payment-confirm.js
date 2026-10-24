const admin=require('firebase-admin');
const {randomUUID,createHmac}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {verifiedPhone,deviceId,ensureAccount,requestTiming}=require('../server/billing.cjs');
const {problem,phoneDigits,effectivePeriod}=require('../server/license-integrity.cjs');
const PRICES=Object.freeze({1:9900,3:28215,6:53460,12:100980});
function addMonths(stamp,months){
 const local=new Date(stamp+9*3600000),year=local.getUTCFullYear(),month=local.getUTCMonth();
 const end=new Date(Date.UTC(year,month+months,1,local.getUTCHours(),local.getUTCMinutes(),local.getUTCSeconds(),local.getUTCMilliseconds()));
 end.setUTCDate(Math.min(local.getUTCDate(),new Date(Date.UTC(year,month+months+1,0)).getUTCDate()));
 return end.getTime()-9*3600000;
}
function legacyExpiry(data){if(Number.isFinite(data.expiresAt))return data.expiresAt;const m=/^(\d{4})[.-](\d{2})[.-](\d{2})$/.exec(data.expireDate||'');return m?Date.UTC(+m[1],+m[2]-1,+m[3]+1)-9*3600000-1:0;}
function result(account,license,now){const expiresAt=effectivePeriod(license,account.webExpiresAt,now).expiresAt;return {active:expiresAt>now&&!['suspended','revoked'].includes(license.status),valid:expiresAt>now&&!['suspended','revoked'].includes(license.status),status:license.status,billingManaged:true,actualKey:account.licenseKey,phone:account.phone,expiresAt,expireDate:new Date(expiresAt+9*3600000).toISOString().slice(0,10).replace(/-/g,'.'),routeOwnerId:license.routeOwnerId,dispatchKey:license.dispatchKey||'',allowTms:license.allowTms??true,msg:expiresAt>now?'':'이용기간이 만료되었습니다.'};}
function createService({sdk=admin,env=process.env,fetchImpl=(...args)=>fetch(...args),now=Date.now}={}){
 const ready=()=>/^(test|live)_(gck|ck)_/.test(env.TOSS_CLIENT_KEY||'')&&/^(test|live)_(gsk|sk)_/.test(env.TOSS_SECRET_KEY||'')&&(env.TOSS_CLIENT_KEY.startsWith('test_')===env.TOSS_SECRET_KEY.startsWith('test_'))&&(env.WEB_PAYMENT_ENABLED==='true')&&(!env.TOSS_CLIENT_KEY.startsWith('test_')||env.WEB_PAYMENT_ALLOW_TEST==='true');
 async function provider(path,body,id){const response=await fetchImpl('https://api.tosspayments.com/v1/payments'+path,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from(env.TOSS_SECRET_KEY+':').toString('base64'),'Content-Type':'application/json',...(id?{'Idempotency-Key':id}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});let data;try{data=await response.json();}catch{throw problem('결제 상태를 확인하지 못했습니다. 재결제하지 말고 다시 확인해 주세요.',502);}return {ok:response.ok,data};}
 function validate(payment,order){if(payment.orderId!==order.orderId||payment.totalAmount!==order.amount||payment.currency!=='KRW'||payment.paymentKey!==order.paymentKey||!Number.isFinite(Date.parse(payment.approvedAt)))throw problem('결제 금액 또는 주문 정보가 일치하지 않습니다.',409);}
 async function reconcile(db,uid,payments=[],device=null,cancellation=null,expectedCustomer=null){return db.runTransaction(async tx=>{
  const accountRef=db.collection('billing_accounts').doc(uid),account=(await tx.get(accountRef)).data();if(!account)throw problem('계정을 찾을 수 없습니다.',404);if(account.deletedAt!=null)throw problem('삭제된 결제 계정입니다.',410);
  if(expectedCustomer && account.rcUserId!==expectedCustomer)throw problem('계정이 변경되었습니다. 다시 확인해 주세요.',409);
  const licenseRef=db.collection('licenses').doc(account.licenseKey),profileRef=db.collection('driver_profiles').doc(account.licenseKey),lockRef=db.collection('admin_license_controls').doc('phone_integrity');
  const bindingRef=db.collection('billing_license_bindings').doc(account.licenseKey);
  const [l,p,lock,blocked,binding]=await Promise.all([tx.get(licenseRef),tx.get(profileRef),tx.get(lockRef),device?require('../server/license-integrity.cjs').assertNotBlocked(db,tx,account.licenseKey,account.phone,device):Promise.resolve(null),tx.get(bindingRef)]);
  const license=l.data()||{},profile=p.data()||{};
  const cancelRef=cancellation?db.collection('payment_orders').doc(cancellation.orderId):null;
  const cancelOrder=cancelRef?(await tx.get(cancelRef)).data():null;
  if(binding.exists&&binding.data().uid!==uid)throw problem('이용권 소유자 정보를 확인해 주세요.',403);
  if(!cancellation&&[license.status,profile.status].some(status=>['suspended','revoked'].includes(status)))throw problem('이용이 제한된 계정입니다.',403);
  if(device&&(license.deviceId||profile.deviceId)&&(license.deviceId||profile.deviceId)!==device)throw problem('다른 기기에 연결된 계정입니다.',409);
  if(!license.driverSessionId&&(license.phone&&phoneDigits(license.phone)!==phoneDigits(account.phone)||profile.phone&&phoneDigits(profile.phone)!==phoneDigits(account.phone)))throw problem('전화번호 정보를 확인해 주세요.',409);
  if(license.routeOwnerId&&profile.routeOwnerId&&license.routeOwnerId!==profile.routeOwnerId)throw problem('계정 소유권을 확인해 주세요.',409);
  const history=(account.webHistory||[]).map(x=>({...x}));
  for(const payment of payments){const old=history.find(x=>x.orderId===payment.orderId);if(!old)throw problem('결제 이력을 찾을 수 없습니다.',409);old.cancelled=old.cancelled===true||payment.status!=='DONE'||payment.balanceAmount!==old.amount;}
  let expiresAt=account.webBaseExpiresAt||0;for(const entry of history)if(!entry.cancelled)expiresAt=addMonths(Math.max(expiresAt,entry.approvedAt),entry.months);
  const data={phone:license.driverSessionId?license.phone:account.phone,key:account.licenseKey,routeOwnerId:license.routeOwnerId||profile.routeOwnerId||randomUUID(),deviceId:license.driverSessionId?license.deviceId:device||license.deviceId||profile.deviceId||'',billingManaged:true,webManaged:true,billingUid:uid,type:'regular',status:cancellation&&['suspended','revoked'].includes(license.status)?license.status:expiresAt>now()?'active':'expired',expiresAt,expireDate:new Date(expiresAt+9*3600000).toISOString().slice(0,10).replace(/-/g,'.')};
  Object.assign(data,effectivePeriod(license,expiresAt,now()));
  let changed=false;
  const saveChanged=(ref,before,after)=>{if(!isDeepStrictEqual(before,after)){tx.set(ref,after);changed=true;}};
  if(cancellation)saveChanged(cancelRef,cancelOrder,{...cancelOrder,cancellation:cancelOrder.cancellation||{status:'CANCELED',at:now(),by:cancellation.by,reason:cancellation.reason},method:cancellation.payment.method||cancelOrder.method||null});
  saveChanged(licenseRef,l.data(),{...license,...data,isPro:true});saveChanged(profileRef,p.data(),{...profile,...data,allowTms:profile.allowTms??license.allowTms??true});
  const updated={...account,webHistory:history,webExpiresAt:expiresAt,webManaged:true};saveChanged(accountRef,account,updated);saveChanged(bindingRef,binding.data(),{uid,provider:'toss'});
  if(changed)tx.set(lockRef,{revision:(lock.data()?.revision||0)+1,updatedAt:now()});
  return result(updated,{...license,...profile,...data,dispatchKey:license.dispatchKey||''},now());
 });}
 async function syncWeb(db,uid,device=null,measure=async(_name,operation)=>operation()){const account=(await measure('billing_read',()=>db.collection('billing_accounts').doc(uid).get())).data();if(account?.deletedAt!=null)throw problem('삭제된 결제 계정입니다.',410);if(!account?.webManaged)return null;if(!ready())throw problem('이용권 확인 서비스 설정을 확인해 주세요.',503);
  const entries=(account.webHistory||[]).filter(entry=>!entry.cancelled),payments=[];
  const refs=entries.map(entry=>db.collection('payment_orders').doc(entry.orderId));
  const orders=refs.length?await measure('orders_read',()=>db.getAll(...refs)):[];
  // Bounded concurrency; validate every response before changing access.
  await measure('toss_lookup',async()=>{
  for(let i=0;i<entries.length;i+=4){
   const batch=await Promise.allSettled(orders.slice(i,i+4).map(async snapshot=>{
    const saved=snapshot.data();
    if(!saved?.paymentKey)throw problem('결제 이력을 확인해 주세요.',409);
    const r=await provider('/'+encodeURIComponent(saved.paymentKey));
    if(!r.ok)throw problem('결제 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',502);
    validate(r.data,saved);return r.data;
   }));
   const failure=batch.find(item=>item.status==='rejected');if(failure)throw failure.reason;
   payments.push(...batch.map(item=>item.value));
  }
  });
  return measure('reconcile',()=>reconcile(db,uid,payments,device,null,account.rcUserId));
 }
 // Only the SMS-authenticated master endpoint calls this helper; never a customer action.
 async function cancelPayment(db,{key,orderId,reason},by){
  if(!ready())throw problem('토스 결제 설정을 확인해 주세요.',503);
  if(typeof key!=='string'||!key||key.includes('/')||key.length>100||!/^WEB_[a-f0-9-]{36}$/.test(orderId||''))throw problem('계정과 주문번호를 확인해 주세요.');
  reason=String(reason||'').trim();if(!reason||reason.length>200)throw problem('취소 사유를 1~200자로 입력해 주세요.');
  const order=(await db.collection('payment_orders').doc(orderId).get()).data();
  if(!order?.uid||!order.paymentKey||order.status!=='completed')throw problem('승인된 웹 결제만 취소할 수 있습니다.',409);
  const account=(await db.collection('billing_accounts').doc(order.uid).get()).data();
  if(!account?.webManaged||account.licenseKey!==key||!account.webHistory?.some(x=>x.orderId===orderId))throw problem('선택한 계정의 결제 내역이 아닙니다. 새로 조회해 주세요.',409);
  if(typeof order.test!=='boolean'||order.test!==env.TOSS_SECRET_KEY.startsWith('test_'))throw problem('이 주문의 테스트/실결제 구분과 현재 토스 키가 다릅니다.',409);
  let r=await provider('/'+encodeURIComponent(order.paymentKey));
  if(!r.ok)throw problem('토스 결제 조회에 실패했습니다. 취소를 실행하지 않았습니다.',502);
  validate(r.data,order);
  if(r.data.status!=='CANCELED'||r.data.balanceAmount!==0){
   if(r.data.status!=='DONE'||r.data.balanceAmount!==order.amount)throw problem('부분 취소 또는 처리 중인 결제입니다. 토스 관리자에서 확인해 주세요.',409);
   if(r.data.method==='가상계좌')throw problem('가상계좌 환불은 환불계좌 확인이 필요합니다. 토스 관리자에서 처리해 주세요.',409);
   r=await provider('/'+encodeURIComponent(order.paymentKey)+'/cancel',{cancelReason:reason},'cancel-'+orderId);
   if(!r.ok)throw problem('취소 결과를 확인하지 못했습니다. 같은 내역의 취소 버튼으로 다시 확인해 주세요.',502);
   validate(r.data,order);
  }
  if(r.data.status!=='CANCELED'||r.data.balanceAmount!==0)throw problem('전액 취소 완료가 확인되지 않았습니다. 토스 결제 내역을 확인해 주세요.',409);
  // The provider call is idempotent; period and audit are committed together. Retry can recover a DB failure.
  const access=await reconcile(db,order.uid,[r.data],null,{orderId,order,by,reason,payment:r.data},account.rcUserId);
  return {success:true,...access};
 }
 async function sendLicenseSms(db,uid,orderId,customer){
  const [access,secret,serviceId]=['NCP_ACCESS_KEY','NCP_SECRET_KEY','NCP_SENS_SERVICE_ID'].map(k=>env[k]?.trim());
  const sender='01083294575'; // Approved SENS sender; never the sales/contact number.
  if(!access||!secret||!/^ncp:sms:[a-z]{2}:\d+:[A-Za-z0-9_-]+$/.test(serviceId||'')||!/^\d{8,11}$/.test(sender||''))return 'unavailable';
  const ref=db.collection('payment_orders').doc(orderId);
  const claim=await db.runTransaction(async tx=>{
   const saved=(await tx.get(ref)).data(),a=(await tx.get(db.collection('billing_accounts').doc(uid))).data();
   if(!a||a.deletedAt!=null||a.rcUserId!==customer||saved?.uid!==uid||saved.licenseKey!==a.licenseKey||saved.status!=='completed'||!a.webHistory?.some(x=>x.orderId===orderId&&!x.cancelled))return {status:'unavailable'};
   if(saved.licenseSms)return {status:saved.licenseSms.status};
   const to=phoneDigits(a.phone);if(!/^010\d{8}$/.test(to))return {status:'unavailable'};
   const expireDate=new Date(a.webExpiresAt+9*3600000).toISOString().slice(0,10).replace(/-/g,'.');
   // Record before calling SENS: an ambiguous timeout must not trigger a duplicate SMS.
   tx.set(ref,{...saved,licenseSms:{status:'sending',requestedAt:now()}});
   return {send:true,to,key:a.licenseKey,expireDate};
  });
  if(!claim.send)return claim.status;
  let status='unknown',requestId=null;
  try{
   const uri=`/sms/v2/services/${serviceId}/messages`,timestamp=String(now());
   const signature=createHmac('sha256',secret).update(`POST ${uri}\n${timestamp}\n${access}`).digest('base64');
   const response=await fetchImpl('https://sens.apigw.ntruss.com'+uri,{method:'POST',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json','x-ncp-apigw-timestamp':timestamp,'x-ncp-iam-access-key':access,'x-ncp-apigw-signature-v2':signature},body:JSON.stringify({type:'LMS',contentType:'COMM',countryCode:'82',from:sender,subject:'배송경로PRO 이용권 안내',content:`[배송경로PRO 이용권 안내]\n결제가 완료되었습니다.\n라이선스 키: ${claim.key}\n사용기한: ${claim.expireDate}\n위 키와 인증하신 휴대폰 번호로 로그인해 주세요.\n이용해 주셔서 감사합니다.`,messages:[{to:claim.to}]})});
   const data=await response.json();status=response.ok&&String(data.statusCode)==='202'?'accepted':'failed';requestId=typeof data.requestId==='string'?data.requestId:null;
  }catch{status='unknown';}
  await db.runTransaction(async tx=>{const saved=(await tx.get(ref)).data();if(saved)tx.set(ref,{...saved,licenseSms:{...saved.licenseSms,status,requestId,updatedAt:now()}});});
  return status;
 }
 async function handler(req,res){const timing=requestTiming(res),measure=timing.measure;const reply=(code,data)=>{timing.finish();return res.status(code).json(data);};res.setHeader('Cache-Control','no-store');if(req.method!=='POST')return res.status(405).json({error:'POST 요청만 가능합니다.'});try{
  const input=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
  if(input.action==='config')return res.status(200).json({enabled:ready(),prices:PRICES,...(ready()?{clientKey:env.TOSS_CLIENT_KEY,test:env.TOSS_CLIENT_KEY.startsWith('test_')}:{})});
  if(!ready())throw problem('결제 서비스를 준비하고 있습니다.',503);
  if(!sdk.apps.length)sdk.initializeApp({credential:sdk.credential.cert({projectId:env.FIREBASE_PROJECT_ID,clientEmail:env.FIREBASE_CLIENT_EMAIL,privateKey:env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,'\n')})});const db=sdk.firestore();
  const token=/^Bearer (.+)$/.exec(req.headers.authorization||'')?.[1];if(!token)throw problem('휴대폰 인증이 필요합니다.',401);let identity;try{identity=await measure('auth',()=>sdk.auth().verifyIdToken(token,true));}catch{throw problem('휴대폰 인증을 다시 진행해 주세요.',401);}verifiedPhone(identity);
  const device=deviceId(input.deviceId),account=await measure('account',()=>ensureAccount(db,identity,{deviceId:device},now()));
  if(input.action==='sync')return reply(200,await syncWeb(db,identity.uid,device,measure)||{valid:false});
  if(input.action==='pending-order'||input.action==='checkout-session'){
   const a=(await db.collection('billing_accounts').doc(identity.uid).get()).data();
   const pending=a?.pendingWebOrder&&a.pendingWebUntil>now()?(await db.collection('payment_orders').doc(a.pendingWebOrder).get()).data():null;
   return reply(200,{customerKey:account.rcUserId,months:pending?.uid===identity.uid&&pending.licenseKey===account.licenseKey&&pending.status==='created'?pending.months:null});
  }
  if(input.action==='create-order'){
   const months=Number(input.months);if(!Object.hasOwn(PRICES,months))throw problem('이용기간을 확인해 주세요.');
   const orderId='WEB_'+randomUUID(),ref=db.collection('payment_orders').doc(orderId),aRef=db.collection('billing_accounts').doc(identity.uid);
   const order=await db.runTransaction(async tx=>{const a=(await tx.get(aRef)).data(),l=(await tx.get(db.collection('licenses').doc(a.licenseKey))).data()||{},lockRef=db.collection('admin_license_controls').doc('phone_integrity'),lock=await tx.get(lockRef);
    if(a.deletedAt!=null || a.rcUserId!==account.rcUserId)throw problem('계정이 변경되었습니다. 다시 확인해 주세요.',409);
    if(l.billingUid&&l.billingUid!==identity.uid)throw problem('이용권 소유자 정보를 확인해 주세요.',403);
    if(l.billingManaged&&!l.webManaged||a.access?.active&&a.access.expiresAt>now())throw problem('Google Play 구독 이력이 있습니다. 중복 결제를 막기 위해 고객센터에서 전환을 확인해 주세요.',409);
    if(a.webHistory?.length>=100)throw problem('결제 이력 확인이 필요합니다. 고객센터에 문의해 주세요.',409);
    if(a.pendingWebOrder&&a.pendingWebUntil>now()){
     const pending=(await tx.get(db.collection('payment_orders').doc(a.pendingWebOrder))).data();
     if(pending?.uid===identity.uid&&pending.licenseKey===a.licenseKey&&pending.status==='created'&&!pending.paymentKey&&pending.months===months&&pending.amount===PRICES[months]&&pending.test===env.TOSS_CLIENT_KEY.startsWith('test_'))return pending;
     throw problem('진행 중인 주문이 있습니다. 먼저 기존에 선택한 이용기간으로 다시 진행해 주세요. 기간을 변경하려면 기존 주문 생성 후 30분이 지나야 합니다.',409);
    }
    const row={orderId,uid:identity.uid,phone:account.phone,licenseKey:a.licenseKey,months,amount:PRICES[months],createdAt:now(),status:'created',test:env.TOSS_CLIENT_KEY.startsWith('test_')};tx.create(ref,row);tx.set(aRef,{...a,pendingWebOrder:orderId,pendingWebUntil:now()+1800000});tx.set(lockRef,{revision:(lock.data()?.revision||0)+1,updatedAt:now()});return row;});return res.status(200).json({orderId:order.orderId,amount:order.amount,months:order.months,customerKey:account.rcUserId});
  }
  if(input.action!=='confirm')throw problem('지원하지 않는 요청입니다.');
  if(!/^WEB_[a-f0-9-]{36}$/.test(input.orderId||'')||typeof input.paymentKey!=='string'||!/^[\w-]{1,200}$/.test(input.paymentKey))throw problem('결제 정보가 올바르지 않습니다.');
  const ref=db.collection('payment_orders').doc(input.orderId),order=(await ref.get()).data();if(!order||order.uid!==identity.uid||order.licenseKey!==account.licenseKey)throw problem('본인의 주문만 확인할 수 있습니다.',403);
  if(!Number.isSafeInteger(input.amount)||input.amount!==order.amount)throw problem('결제 금액이 일치하지 않습니다.',409);
  if(order.paymentKey&&order.paymentKey!==input.paymentKey)throw problem('결제 정보가 일치하지 않습니다.',409);
  let r=await provider('/'+encodeURIComponent(input.paymentKey));
  if(!r.ok||r.data.status==='READY'||r.data.status==='IN_PROGRESS'){
   if(order.status==='completed')throw problem('결제 결과를 다시 확인해 주세요.',502);
   if(now()-order.createdAt>1800000)throw problem('주문 유효시간이 지났습니다. 결제 내역을 고객센터에 확인해 주세요.',409);
   r=await provider('/confirm',{orderId:order.orderId,paymentKey:input.paymentKey,amount:order.amount},order.orderId);
  }
  if(!r.ok)throw problem('승인 결과를 확인하지 못했습니다. 재결제하지 말고 다시 확인해 주세요.',502);
  const payment=r.data;validate(payment,{...order,paymentKey:input.paymentKey});if(payment.status!=='DONE'||payment.balanceAmount!==order.amount)throw problem('완료된 결제가 아닙니다. 결제 내역을 확인해 주세요.',409);
  await db.runTransaction(async tx=>{const aRef=db.collection('billing_accounts').doc(identity.uid),a=(await tx.get(aRef)).data(),current=(await tx.get(ref)).data(),l=(await tx.get(db.collection('licenses').doc(a.licenseKey))).data()||{},lockRef=db.collection('admin_license_controls').doc('phone_integrity'),lock=await tx.get(lockRef);
   if(a.deletedAt!=null || a.rcUserId!==account.rcUserId)throw problem('계정이 변경되었습니다. 다시 확인해 주세요.',409);
   if(current.status==='completed')return;
   if(a.pendingWebOrder!==order.orderId||l.billingManaged&&!l.webManaged)throw problem('계정 상태가 변경되었습니다. 재결제하지 말고 고객센터에 주문번호를 알려 주세요.',409);
   const history=[...(a.webHistory||[]),{orderId:order.orderId,amount:order.amount,months:order.months,approvedAt:Date.parse(payment.approvedAt),cancelled:false}];
   tx.set(ref,{...current,paymentKey:input.paymentKey,status:'completed',method:payment.method||null,approvedAt:payment.approvedAt});tx.set(aRef,{...a,webHistory:history,webBaseExpiresAt:a.webBaseExpiresAt??Math.max(0,legacyExpiry(l)),webManaged:true,pendingWebOrder:null,pendingWebUntil:0});tx.set(lockRef,{revision:(lock.data()?.revision||0)+1,updatedAt:now()});
  });
  const access=await syncWeb(db,identity.uid,device,measure);let licenseSms='unknown';
  try{licenseSms=await sendLicenseSms(db,identity.uid,order.orderId,account.rcUserId);}catch{}
  return reply(200,{success:true,...access,licenseSms});
 }catch(error){return reply(error.status||500,{error:error.status?error.message:'결제 확인 중 오류가 발생했습니다. 재결제하지 말고 다시 확인해 주세요.'});}}
 return {handler,syncWeb,ready,cancelPayment};
}
module.exports=createService().handler;module.exports.createService=createService;module.exports.addMonths=addMonths;module.exports.PRICES=PRICES;
