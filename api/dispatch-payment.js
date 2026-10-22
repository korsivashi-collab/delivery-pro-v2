// Dispatch commerce is isolated from phone-authenticated driver purchases.
const admin = require('firebase-admin');
const {randomUUID,randomBytes} = require('node:crypto');
const {problem,phoneDigits,assertNotBlocked} = require('../server/license-integrity.cjs');
const {verifiedPhone} = require('../server/billing.cjs');
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
 function signupPhone(identity){
  if(identity.role||identity.testDriverSession)throw problem('신규 관제 가입을 위한 휴대폰 인증이 필요합니다.',403);
  return verifiedPhone(identity);
 }
 async function signupContext(db,identity,input){
  const phone=signupPhone(identity),draftRef=db.collection('dispatch_registrations').doc(identity.uid+'_'+(test()?'test':'live'));
  return db.runTransaction(async tx=>{
   const draft=(await tx.get(draftRef)).data();
   if(!draft||draft.uid!==identity.uid||draft.phone!==phone)throw problem('업체 정보 입력과 휴대폰 인증을 먼저 완료해 주세요.',403);
   const ref=db.collection('licenses').doc(draft.key),walletRef=db.collection('dispatch_wallets').doc(draft.walletId);
   const l=(await tx.get(ref)).data(),w=(await tx.get(walletRef)).data();
   await assertNotBlocked(db,tx,draft.key,phone,'');
   if(!w||l&&l.dispatchBillingId!==draft.walletId)throw problem('가입 신청 정보를 확인해 주세요.',409);
   if(draft.completed&&!draft.test&&!l)throw problem('삭제된 관제 계정입니다. 관리자에게 재가입을 문의해 주세요.',410);
   return {id:draft.walletId,ref,walletRef,w,l:l||{},signup:true,draft,draftRef};
  });
 }
 async function prepareSignup(db,identity,input){
  const phone=signupPhone(identity),age=Math.floor(now()/1000)-identity.auth_time;
  if(!Number.isFinite(age)||age< -30||age>300)throw problem('휴대폰 인증을 다시 진행해 주세요.',401);
  const companyName=String(input.companyName||'').trim();
  if(companyName.length<2||companyName.length>60||/[\u0000-\u001f]/.test(companyName)||input.consent!==true)throw problem('업체명과 약관·개인정보 동의를 확인해 주세요.');
  if(!ready())throw problem('토스 결제 설정을 확인해 주세요.',503);
  const draftRef=db.collection('dispatch_registrations').doc(identity.uid+'_'+(test()?'test':'live')),lockRef=db.collection('admin_license_controls').doc('phone_integrity');
  return db.runTransaction(async tx=>{
   const [saved,licenses,profiles,lock]=await Promise.all([tx.get(draftRef),tx.get(db.collection('licenses')),tx.get(db.collection('driver_profiles')),tx.get(lockRef)]);
   await assertNotBlocked(db,tx,'',phone,'');
   const old=saved.data();
   if(old?.phone!==phone&&old)throw problem('가입 신청의 인증 번호가 다릅니다.',409);
   const matches=[...licenses.docs,...profiles.docs].filter(d=>phoneDigits(d.data().phone)===phoneDigits(phone));
   if(matches.some(d=>d.id!==old?.key))throw problem('이미 이 전화번호로 등록된 계정이 있습니다. 기존 관제 키로 로그인하거나 관리자에게 문의해 주세요.',409);
   if(old){
    if(old.completed)return {success:true,completed:true,test:test(),dispatchKey:old.key,result:old.result};
    if(old.companyName!==companyName)throw problem('기존 가입 신청의 업체명이 다릅니다. 먼저 기존 신청의 결제 결과를 확인해 주세요.',409);
    return {success:true,test:test(),companyName:old.companyName};
   }
   let key;
   for(let attempt=0;attempt<5;attempt++){
    const candidate='CTRL-'+randomBytes(12).toString('hex').toUpperCase();
    if(!(await tx.get(db.collection('licenses').doc(candidate))).exists&&!(await tx.get(db.collection('driver_profiles').doc(candidate))).exists){key=candidate;break;}
   }
   if(!key)throw problem('계정 번호 생성에 실패했습니다. 다시 시도해 주세요.',503);
   const walletId=randomUUID();
   tx.create(draftRef,{uid:identity.uid,phone,companyName,key,walletId,test:test(),createdAt:now(),consentedAt:now(),consentVersion:'20261022'});
   tx.create(db.collection('dispatch_wallets').doc(walletId),{balance:0,testBalance:0,revision:0,recent:[]});
   tx.set(lockRef,{revision:(lock.data()?.revision||0)+1,updatedAt:now()});
   return {success:true,test:test(),companyName};
  });
 }
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
  if(input.action==='prepare-signup')return prepareSignup(db,identity,input);
  const c=await (input.signup===true?signupContext(db,identity,input):context(db,identity,input)),{ref,walletRef,id}=c;
  const authorizeCurrent=l=>{if(!c.signup)return authorize(l,identity,input);signupPhone(identity);if(l&&l.dispatchBillingId!==id)throw problem('계정 정보가 변경되었습니다.',409);};
  if(input.action==='wallet')return {...config(),...c.w,customerKey:'dispatch_'+id,...(c.signup?{companyName:c.draft.companyName,completed:!!c.draft.completed,result:c.draft.result||null,dispatchKey:c.draft.completed?c.draft.key:null}:{})};
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
   if(c.signup)throw problem('관제 로그인이 필요합니다.',403);
   if(identity.role!=='MASTER'||identity.masterSmsVerified!==true||!(identity.masterSessionExpiresAt>now()/1000))throw problem('마스터 SMS 인증이 필요합니다.',403);
   const reason=String(input.reason||'').trim(),field=input.test===true?'testBalance':'balance';
   if(!['add','reset'].includes(input.operation)||input.balance!==undefined||!Number.isSafeInteger(input.count)||(input.operation==='add'?(input.count<=0||input.count>10000000):input.count!==0)||!Number.isSafeInteger(input.revision)||reason.length<2||reason.length>200||!/^[a-f0-9-]{36}$/.test(input.requestId||''))throw problem('건수와 수정 사유를 확인해 주세요.');
   return db.runTransaction(async tx=>{
    const l=(await tx.get(ref)).data(),w=(await tx.get(walletRef)).data(),eventRef=db.collection('dispatch_billing_events').doc(input.requestId),old=await tx.get(eventRef);authorize(l,identity,input);
    if(l.dispatchBillingId!==id)throw problem('계정이 변경되었습니다.',409);
    if(old.exists){if(old.data().walletId!==id||old.data().operation!==input.operation||old.data().count!==input.count||old.data().reason!==reason||old.data().test!==(input.test===true))throw problem('수정 요청이 일치하지 않습니다.',409);return w;}
    if(w.revision!==input.revision)throw problem('잔여 건수가 변경되었습니다. 다시 불러온 뒤 수정해 주세요.',409);
    if(input.operation==='reset' && (Number(w.reserved||0)>0 || Number(w.testReserved||0)>0 || w.pendingOrder))throw problem('발송 또는 결제 처리 중에는 0건 처리할 수 없습니다. 처리 결과를 확인한 뒤 다시 진행해 주세요.',409);
    const balance=input.operation==='add'?w[field]+input.count:0;
    if(!Number.isSafeInteger(balance)||balance>10000000)throw problem('최대 보유 건수를 초과합니다.');
    const event={walletId:id,at:now(),by:identity.uid,kind:'adjust',operation:input.operation,count:input.count,before:w[field],balance,reason,test:input.test===true};
    const updated={...w,[field]:balance,revision:w.revision+1,recent:[event,...w.recent].slice(0,20)};
    tx.create(eventRef,event);tx.set(walletRef,updated);return updated;
   });
  }
  if(!ready())throw problem('토스 결제 설정이 필요합니다. 결제 키와 WEB_PAYMENT_ENABLED / WEB_PAYMENT_ALLOW_TEST 설정을 확인해 주세요.',503);
  if(input.action==='create-order') {
   const q=quote(input);if(c.signup&&(q.kind!=='service'||c.draft.completed))throw problem('신규 관제 가입은 관제 이용료 결제로 진행해 주세요. 발급된 계정은 관제 키로 로그인해 주세요.',409);if(!test()&&!c.signup)checkService(c.l,q);
   return db.runTransaction(async tx=>{
    const l=(await tx.get(ref)).data(),w=(await tx.get(walletRef)).data();authorizeCurrent(l);if(!test()&&!c.signup)checkService(l,q);
    if(c.signup&&(await tx.get(c.draftRef)).data()?.completed)throw problem('이미 가입이 완료되었습니다. 관제 키로 로그인해 주세요.',409);
    if(!c.signup&&l.dispatchBillingId!==id)throw problem('계정이 변경되었습니다.',409);
    const pending=w.pendingOrder?(await tx.get(db.collection('dispatch_payment_orders').doc(w.pendingOrder))).data():null;
    if(pending?.status==='created'&&(pending.paymentKey||pending.createdAt>now()-1800000)) {
     if(JSON.stringify(pending.quote)!==JSON.stringify(q)||pending.test!==test())throw problem('진행 중인 결제 주문을 먼저 확인해 주세요. 승인 요청 전 주문은 30분 후 다른 상품으로 변경할 수 있습니다.',409);
     return {...pending,...config(),customerKey:'dispatch_'+id};
    }
    const orderId='DSP_'+randomUUID(),order={orderId,walletId:id,dispatchKey:c.signup?c.draft.key:input.dispatchKey,quote:q,amount:q.amount,status:'created',test:test(),createdAt:now(),...(c.signup?{signupUid:identity.uid}:{})};
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
   const o=(await tx.get(orderRef)).data(),l=(await tx.get(ref)).data(),w=(await tx.get(walletRef)).data();authorizeCurrent(l);
   if(!c.signup&&l.dispatchBillingId!==id)throw problem('계정이 변경되었습니다. 관리자에게 주문번호를 알려 주세요.',409);
   if(o.status==='completed')return {success:true,test:o.test,result:c.signup?{...o.result,dispatchKey:c.draft.key}:o.result};
   let signupLock,signupLockRef;
   if(c.signup){
    if(o.signupUid!==identity.uid||o.quote.kind!=='service'||l)throw problem('신규 계정 발급 상태를 확인해 주세요.',409);
    const draft=(await tx.get(c.draftRef)).data();if(draft?.completed)throw problem('이미 처리된 가입 신청입니다.',409);
    signupLockRef=db.collection('admin_license_controls').doc('phone_integrity');
    signupLock=await tx.get(signupLockRef);
    const licenses=await tx.get(db.collection('licenses')),profiles=await tx.get(db.collection('driver_profiles'));
    await assertNotBlocked(db,tx,c.draft.key,c.draft.phone,'');
    if([...licenses.docs,...profiles.docs].some(d=>phoneDigits(d.data().phone)===phoneDigits(c.draft.phone)))throw problem('이 전화번호의 계정이 이미 등록되어 발급을 보류했습니다. 재결제하지 말고 관리자에게 주문번호를 알려 주세요.',409);
   }
   const q=o.quote,field=o.test?'testBalance':'balance',updated={...w,pendingOrder:null,revision:w.revision+1};let result;
   if(q.kind==='sms'){updated[field]+=q.count;result={balance:updated[field],count:q.count};}
   else {
    if(!o.test&&!c.signup)checkService(l,q);
    const expiresAt=addMonths(Math.max(Date.parse(p.approvedAt),expiryOf(l||{})),q.months),expireDate=dateOf(expiresAt);
    result={expireDate,isPro:q.isPro,maxSlots:q.maxSlots,maxSessions:q.maxSessions};
    if(c.signup){
     result={...result,dispatchKey:c.draft.key,companyName:c.draft.companyName};
     if(!o.test)tx.create(ref,{...result,key:c.draft.key,name:c.draft.companyName,type:'dispatch',phone:c.draft.phone,dispatchBillingId:id,routeOwnerId:randomUUID(),status:'active',expiresAt,createdAt:now(),deviceId:'',activeSessions:[]});
     tx.set(c.draftRef,{completed:true,completedAt:now(),result},{merge:true});
     tx.set(signupLockRef,{revision:(signupLock.data()?.revision||0)+1,updatedAt:now()});
    }else if(!o.test)tx.set(ref,{...result,expiresAt,status:'active'},{merge:true});
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
