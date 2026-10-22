// Dispatch commerce is isolated from phone-authenticated driver purchases.
const admin = require('firebase-admin');
const {randomUUID} = require('node:crypto');
const {problem} = require('../server/license-integrity.cjs');
const {addMonths} = require('./payment-confirm.js');
const dateOf = n => new Date(n + 9*3600000).toISOString().slice(0,10).replace(/-/g,'.');
const expiryOf = l => Date.parse(String(l.expireDate||'').replace(/\./g,'-')+'T23:59:59.999+09:00') || 0;
function quote(input) {
 if(input.kind==='sms') {
  const count=input.count;if(!Number.isSafeInteger(count)||count<100||count>100000)throw problem('충전 건수는 100~100,000건으로 입력해 주세요.');
  return {kind:'sms',count,amount:Math.round(count*35*(count>=10000?.9:count>=5000?.95:1)),label:'배송안내 문자 '+count+'건'};
 }
 if(input.kind!=='service'||!['basic','pro'].includes(input.plan)||!['monthly','yearly'].includes(input.period))throw problem('관제 상품을 확인해 주세요.');
 const {slotPacks=0,extraPcs=0}=input,pro=input.plan==='pro',months=input.period==='yearly'?12:1;
 if(!Number.isSafeInteger(slotPacks)||slotPacks<0||slotPacks>200||!Number.isSafeInteger(extraPcs)||extraPcs<0||extraPcs+(pro?2:1)>50)throw problem('추가 회선과 PC 수를 확인해 주세요.');
 // Bulk driver issuance still requires the existing master issuance workflow.
 if(input.drivers)throw problem('기사용 라이선스 함께 구매는 관리자 계약 확인이 필요합니다. 해당 선택을 해제하면 관제 이용료를 결제할 수 있습니다.',409);
 return {kind:'service',isPro:pro,months,maxSlots:10+slotPacks*5,maxSessions:(pro?2:1)+extraPcs,amount:((pro?165000:55000)*(months===12?.9:1)+slotPacks*20000+extraPcs*30000)*months,label:(pro?'PRO':'기본')+' 관제 '+months+'개월'};
}
function createService({sdk=admin,env=process.env,fetchImpl=(...args)=>fetch(...args),now=Date.now}={}) {
 const test=()=>String(env.TOSS_CLIENT_KEY||'').startsWith('test_');
 const ready=()=>env.WEB_PAYMENT_ENABLED==='true'&&/^(test|live)_gck_/.test(env.TOSS_CLIENT_KEY||'')&&/^(test|live)_gsk_/.test(env.TOSS_SECRET_KEY||'')&&test()===env.TOSS_SECRET_KEY.startsWith('test_')&&(!test()||env.WEB_PAYMENT_ALLOW_TEST==='true');
 const config=()=>({enabled:ready(),test:test(),clientKey:ready()?env.TOSS_CLIENT_KEY:null});
 function authorize(l,identity,input) {
  const master=identity.role==='MASTER'&&identity.masterSmsVerified===true&&identity.masterSessionExpiresAt>now()/1000;
  if(l?.type!=='dispatch')throw problem('관제 계정을 찾을 수 없습니다.',404);
  if(master)return;
  if(identity.role!=='DISPATCH'||identity.uid!==input.dispatchKey)throw problem('본인 관제 계정으로 로그인해 주세요.',403);
  const sessions=l.activeSessions?.length?l.activeSessions:l.currentSessionToken?[l.currentSessionToken]:[];
  if(!sessions.includes(input.sessionToken))throw problem('관제 접속이 해제되었습니다. 다시 로그인해 주세요.',401);
  if(['suspended','revoked'].includes(l.status))throw problem('이용 제한 계정입니다.',403);
 }
 async function context(db,identity,input) {
  const key=String(input.dispatchKey||'');if(!key||key.includes('/')||key.length>200)throw problem('관제 계정을 확인해 주세요.');
  const ref=db.collection('licenses').doc(key);
  return db.runTransaction(async tx=>{
   const l=(await tx.get(ref)).data();authorize(l,identity,input);
   const id=l.dispatchBillingId||randomUUID(),walletRef=db.collection('dispatch_wallets').doc(id),w=(await tx.get(walletRef)).data()||{balance:0,testBalance:0,revision:0,recent:[]};
   if(!l.dispatchBillingId){tx.set(ref,{dispatchBillingId:id},{merge:true});tx.set(walletRef,w);}
   return {id,ref,walletRef,w,l};
  });
 }
 function checkService(l,q) {
  if(q.kind==='service'&&expiryOf(l)>now()&&(!!l.isPro!==q.isPro||Number(l.maxSlots)!==q.maxSlots||Number(l.maxSessions||(l.isPro?2:1))!==q.maxSessions))throw problem('사용 중인 계약의 등급·회선 변경은 관리자 확인이 필요합니다. 현재 구성과 동일한 갱신 결제는 가능합니다.',409);
 }
 async function provider(path,body,id) {
  const r=await fetchImpl('https://api.tosspayments.com/v1/payments'+path,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from(env.TOSS_SECRET_KEY+':').toString('base64'),'Content-Type':'application/json',...(id?{'Idempotency-Key':id}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  return {ok:r.ok,data:await r.json()};
 }
 async function execute(db,identity,input) {
  const c=await context(db,identity,input),{ref,walletRef,id}=c;
  if(input.action==='wallet')return {...config(),...c.w,customerKey:'dispatch_'+id};
  if(input.action==='recover') {
   if(!ready())throw problem('토스 결제 설정을 확인해 주세요.',503);
   if(!c.w.pendingOrder)throw problem('확인할 진행 중 주문이 없습니다.',404);
   const o=(await db.collection('dispatch_payment_orders').doc(c.w.pendingOrder).get()).data();
   if(!o||o.walletId!==id||o.test!==test())throw problem('주문과 결제 환경을 확인해 주세요.',409);
   const r=await provider('/orders/'+encodeURIComponent(o.orderId));
   if(!r.ok||!r.data.paymentKey)throw problem('아직 승인된 결제가 없습니다. 결제를 진행했다면 잠시 후 다시 확인해 주세요.',409);
   return execute(db,identity,{...input,action:'confirm',orderId:o.orderId,paymentKey:r.data.paymentKey,amount:o.amount});
  }
  if(input.action==='adjust') {
   if(identity.role!=='MASTER'||identity.masterSmsVerified!==true||!(identity.masterSessionExpiresAt>now()/1000))throw problem('마스터 SMS 인증이 필요합니다.',403);
   const reason=String(input.reason||'').trim(),field=input.test===true?'testBalance':'balance';
   if(!Number.isSafeInteger(input.balance)||input.balance<0||input.balance>10000000||!Number.isSafeInteger(input.revision)||reason.length<2||reason.length>200||!/^[a-f0-9-]{36}$/.test(input.requestId||''))throw problem('건수와 수정 사유를 확인해 주세요.');
   return db.runTransaction(async tx=>{
    const l=(await tx.get(ref)).data(),w=(await tx.get(walletRef)).data(),eventRef=db.collection('dispatch_billing_events').doc(input.requestId),old=await tx.get(eventRef);authorize(l,identity,input);
    if(l.dispatchBillingId!==id)throw problem('계정이 변경되었습니다.',409);
    if(old.exists){if(old.data().walletId!==id||old.data().balance!==input.balance||old.data().test!==input.test)throw problem('수정 요청이 일치하지 않습니다.',409);return w;}
    if(w.revision!==input.revision)throw problem('잔여 건수가 변경되었습니다. 다시 불러온 뒤 수정해 주세요.',409);
    const event={walletId:id,at:now(),by:identity.uid,kind:'adjust',before:w[field],balance:input.balance,reason,test:input.test===true};
    const updated={...w,[field]:input.balance,revision:w.revision+1,recent:[event,...w.recent].slice(0,20)};
    tx.create(eventRef,event);tx.set(walletRef,updated);return updated;
   });
  }
  if(!ready())throw problem('토스 결제 설정이 필요합니다. 결제 키와 WEB_PAYMENT_ENABLED / WEB_PAYMENT_ALLOW_TEST 설정을 확인해 주세요.',503);
  if(input.action==='create-order') {
   const q=quote(input);if(!test())checkService(c.l,q);
   return db.runTransaction(async tx=>{
    const l=(await tx.get(ref)).data(),w=(await tx.get(walletRef)).data();authorize(l,identity,input);if(!test())checkService(l,q);
    if(l.dispatchBillingId!==id)throw problem('계정이 변경되었습니다.',409);
    const pending=w.pendingOrder?(await tx.get(db.collection('dispatch_payment_orders').doc(w.pendingOrder))).data():null;
    if(pending?.status==='created'&&(pending.paymentKey||pending.createdAt>now()-1800000)) {
     if(JSON.stringify(pending.quote)!==JSON.stringify(q)||pending.test!==test())throw problem('진행 중인 결제 주문을 먼저 확인해 주세요. 승인 요청 전 주문은 30분 후 다른 상품으로 변경할 수 있습니다.',409);
     return {...pending,...config(),customerKey:'dispatch_'+id};
    }
    const orderId='DSP_'+randomUUID(),order={orderId,walletId:id,dispatchKey:input.dispatchKey,quote:q,amount:q.amount,status:'created',test:test(),createdAt:now()};
    tx.create(db.collection('dispatch_payment_orders').doc(orderId),order);tx.set(walletRef,{...w,pendingOrder:orderId});
    return {...order,...config(),customerKey:'dispatch_'+id};
   });
  }
  if(input.action!=='confirm'||!/^DSP_[a-f0-9-]{36}$/.test(input.orderId||'')||!/^[\w-]{1,200}$/.test(input.paymentKey||''))throw problem('결제 요청을 확인해 주세요.');
  const orderRef=db.collection('dispatch_payment_orders').doc(input.orderId);
  const order=await db.runTransaction(async tx=>{
   const o=(await tx.get(orderRef)).data();
   if(!o||o.walletId!==id)throw problem('본인 관제 주문만 확인할 수 있습니다.',403);
   if(o.test!==test()||o.amount!==input.amount||o.paymentKey&&o.paymentKey!==input.paymentKey)throw problem('결제 금액 또는 결제 환경이 일치하지 않습니다.',409);
   if(!o.paymentKey)tx.set(orderRef,{paymentKey:input.paymentKey},{merge:true});return o;
  });
  let r=await provider('/'+encodeURIComponent(input.paymentKey));
  if((!r.ok&&r.data.code==='NOT_FOUND_PAYMENT')||r.ok&&['READY','IN_PROGRESS'].includes(r.data.status)) {
   if(order.status==='completed'||order.createdAt<now()-1800000)throw problem('승인 결과를 확인해 주세요. 재결제하지 말고 관리자에게 주문번호를 알려 주세요.',409);
   r=await provider('/confirm',{orderId:order.orderId,paymentKey:input.paymentKey,amount:order.amount},order.orderId);
  }
  const p=r.data;
  if(!r.ok||p.status!=='DONE'||p.orderId!==order.orderId||p.paymentKey!==input.paymentKey||p.currency!=='KRW'||p.totalAmount!==order.amount||p.balanceAmount!==order.amount||!Number.isFinite(Date.parse(p.approvedAt)))throw problem('결제 완료가 확인되지 않았습니다. 재결제하지 말고 같은 주문을 다시 확인해 주세요.',409);
  return db.runTransaction(async tx=>{
   const o=(await tx.get(orderRef)).data(),l=(await tx.get(ref)).data(),w=(await tx.get(walletRef)).data();authorize(l,identity,input);
   if(l.dispatchBillingId!==id)throw problem('계정이 변경되었습니다. 관리자에게 주문번호를 알려 주세요.',409);
   if(o.status==='completed')return {success:true,test:o.test,result:o.result};
   const q=o.quote,field=o.test?'testBalance':'balance',updated={...w,pendingOrder:null,revision:w.revision+1};let result;
   if(q.kind==='sms'){updated[field]+=q.count;result={balance:updated[field],count:q.count};}
   else {
    if(!o.test)checkService(l,q);
    const expiresAt=addMonths(Math.max(Date.parse(p.approvedAt),expiryOf(l)),q.months),expireDate=dateOf(expiresAt);
    result={expireDate,isPro:q.isPro,maxSlots:q.maxSlots,maxSessions:q.maxSessions};
    if(!o.test)tx.set(ref,{...result,expiresAt,status:'active'},{merge:true});
   }
   const event={walletId:id,kind:q.kind,orderId:o.orderId,at:now(),amount:o.amount,test:o.test,result,label:q.label};updated.recent=[event,...w.recent].slice(0,20);
   tx.set(walletRef,updated);tx.create(db.collection('dispatch_billing_events').doc(o.orderId),event);tx.set(orderRef,{status:'completed',approvedAt:p.approvedAt,result},{merge:true});return {success:true,test:o.test,result};
  });
 }
 async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');if(req.method!=='POST')return res.status(405).json({error:'POST 요청만 가능합니다.'});
  try {
   if(!sdk.apps.length)sdk.initializeApp({credential:sdk.credential.cert({projectId:env.FIREBASE_PROJECT_ID,clientEmail:env.FIREBASE_CLIENT_EMAIL,privateKey:env.FIREBASE_PRIVATE_KEY.replace(/\\n/g,'\n')})});
   const token=/^Bearer (.+)$/.exec(req.headers.authorization||'')?.[1];let identity;
   try{if(!token)throw Error();identity=await sdk.auth().verifyIdToken(token,true);}catch{throw problem('관제 로그인이 필요합니다.',401);}
   return res.status(200).json(await execute(sdk.firestore(),identity,req.body||{}));
  }catch(e){return res.status(e.status||500).json({error:e.status?e.message:'결과를 확인하지 못했습니다. 재결제하지 말고 다시 확인해 주세요.'});}
 }
 return {handler,execute};
}
module.exports=createService().handler;module.exports.createService=createService;module.exports.quote=quote;
