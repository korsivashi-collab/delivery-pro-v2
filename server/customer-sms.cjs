const crypto = require('node:crypto');
const {problem,assertDispatchSession,isActive} = require('./license-integrity.cjs');
let supported;
function measureSms(value) {
 if(!supported){supported=new Set();const decoder=new TextDecoder('euc-kr');
  for(let a=0x81;a<=0xfe;a++)for(let b=0x41;b<=0xfe;b++){const c=decoder.decode(new Uint8Array([a,b]));if([...c].length===1&&c!=='\ufffd')supported.add(c);}}
 let bytes=0,unsupported=false;
 for(const c of String(value||'')){if(c.codePointAt(0)<=127)bytes++;else{bytes+=2;if(!supported.has(c))unsupported=true;}}
 return {bytes,unsupported};
}
function composeMessage(body,link){
 const intro=String(body||'').replace(/\r\n?/g,'\n');
 if(!/^[A-Za-z0-9]{5}$/.test(link.deliveryNumber||'')||!/^https:\/\/mtsk\.co\.kr\/t\/[A-Za-z0-9_-]{16}$/.test(link.url||''))throw problem('배송번호와 전용 링크를 확인해 주세요.');
 const numbers=link.deliveryNumbers||[link.deliveryNumber];
 if(!Array.isArray(numbers)||!numbers.length||numbers[0]!==link.deliveryNumber||numbers.some(n=>!/^[A-Za-z0-9]{5}$/.test(n)))throw problem('배송번호를 확인해 주세요.');
 const content=(intro?intro+'\n':'')+(numbers.length>1?'배송조회':'배송번호:'+link.deliveryNumber)+'\n'+link.url;
 const size=measureSms(content);
 if(size.bytes>80||size.unsupported||/[\u0000-\u0008\u000b-\u001f\u007f]/.test(content))throw problem('개별 조회 링크와 배송번호를 포함해 80바이트 이내로 작성해 주세요. 지원하지 않는 문자는 사용할 수 없습니다.');
 return {phone:link.phone,deliveryNumber:link.deliveryNumber,...(numbers.length>1?{deliveryNumbers:numbers}:{}),url:link.url,content,bytes:size.bytes};
}
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const messageNumbers=m=>m.deliveryNumbers||[m.deliveryNumber];
const receiptId=(key,date,number)=>digest(JSON.stringify([key,date,number]));
function publicBatch(batch,id){return {batchId:id,date:batch.date,expiresAt:batch.expiresAt,count:batch.messages.length,deliveryCount:batch.messages.flatMap(messageNumbers).length,price:35,
 messages:batch.messages,parts:batch.parts.map(p=>({status:p.status,count:p.indices.length})),states:batch.states||{}};}
async function prepareSms(db,key,date,links,body,requestId,now=Date.now()){
 if(!/^[a-f0-9-]{36}$/.test(requestId||''))throw problem('문자 요청 정보를 새로 준비해 주세요.');
 if(typeof body!=='string'||body.length>500)throw problem('안내 문구를 확인해 주세요.');
 const messages=links.map(l=>composeMessage(body,l));
 if(!messages.length||messages.length>1000||new Set(messages.flatMap(messageNumbers)).size!==messages.flatMap(messageNumbers).length)throw problem('배송번호별 발송 대상을 확인해 주세요.');
 if(messages.some(m=>messageNumbers(m).length>400))throw problem('동일 주소 묶음은 한 번에 배송 400건까지 선택해 주세요.');
 // Each provider request contains distinct phones: delivery results can then be matched without assuming result order.
 const parts=[];
 messages.forEach((m,i)=>{let part=parts.find(p=>p.indices.length<100&&p.indices.reduce((count,j)=>count+messageNumbers(messages[j]).length,0)+messageNumbers(m).length<=400&&!p.indices.some(j=>messages[j].phone===m.phone));
  if(!part){part={indices:[],status:'prepared'};parts.push(part);}part.indices.push(i);});
 const batch={dispatchKey:key,date,body:String(body||'').replace(/\r\n?/g,'\n'),messages,parts,states:{},createdAt:now,expiresAt:now+15*60000};
 const id=digest(JSON.stringify([key,requestId])),ref=db.collection('delivery_sms_batches').doc(id);
 return db.runTransaction(async tx=>{const old=(await tx.get(ref)).data();
  if(old){if(JSON.stringify(old.messages)!==JSON.stringify(messages)||old.date!==date)throw problem('같은 요청의 내용이 변경되었습니다. 다시 확인해 주세요.',409);return publicBatch(old,id);}
  tx.set(ref,batch);return publicBatch(batch,id);});
}
function createSmsService({env=process.env,fetchImpl=(...args)=>fetch(...args),now=Date.now}={}){
 function authorize(account,identity,key){
  if(account?.type!=='dispatch'||!isActive(account,new Date(now()+9*3600000).toISOString().slice(0,10),now()))throw problem('사용 중인 관제 이용권이 필요합니다.',403);
  const master=identity.role==='MASTER'&&identity.masterSmsVerified===true&&identity.masterSessionExpiresAt>now()/1000;
  if(!master){if(identity.uid!==key)throw problem('관제 계정을 확인해 주세요.',403);assertDispatchSession(account,identity);}
 }
 function config(){
  const [access,secret,service]=['NCP_ACCESS_KEY','NCP_SECRET_KEY','NCP_SENS_SERVICE_ID'].map(k=>String(env[k]||'').trim());
  const sender=String(env.NCP_SENS_SENDER||'').replace(/[^0-9]/g,'');
  if(!access||!secret||!/^ncp:sms:[a-z]{2}:\d+:[A-Za-z0-9_-]+$/.test(service||'')||!/^\d{8,11}$/.test(sender||''))throw problem('문자 발송 서버 설정을 확인해 주세요.',503);
  return {access,secret,service,sender};
 }
 async function provider(method,suffix,body){
  const c=config(),uri=`/sms/v2/services/${c.service}/messages${suffix}`,stamp=String(now());
  const signature=crypto.createHmac('sha256',c.secret).update(`${method} ${uri}\n${stamp}\n${c.access}`).digest('base64');
  const response=await fetchImpl('https://sens.apigw.ntruss.com'+uri,{method,signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','x-ncp-apigw-timestamp':stamp,'x-ncp-iam-access-key':c.access,'x-ncp-apigw-signature-v2':signature},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();return {ok:response.ok,data};
 }
 async function execute(db,identity,key,input){
  const account=(await db.collection('licenses').doc(key).get()).data();authorize(account,identity,key);
  if(input.action==='sms-receipts'){
   if(!Array.isArray(input.deliveryNumbers)||input.deliveryNumbers.length>1000||input.deliveryNumbers.some(n=>!/^[A-Za-z0-9]{5}$/.test(n)))throw problem('배송번호를 확인해 주세요.');
   const docs=await Promise.all([...new Set(input.deliveryNumbers)].map(n=>db.collection('delivery_sms_receipts').doc(receiptId(key,input.date,n)).get()));
   const states={},ids=new Set();docs.forEach((d,i)=>{if(d.exists){states[[...new Set(input.deliveryNumbers)][i]]=d.data().status;if(d.data().batchId)ids.add(d.data().batchId);}});
   return {states,batchIds:[...ids]};
  }
  if(!/^[a-f0-9]{64}$/.test(input.batchId||''))throw problem('발송 확인 화면을 다시 열어 주세요.');
  const ref=db.collection('delivery_sms_batches').doc(input.batchId),batch=(await ref.get()).data();
  if(!batch||batch.dispatchKey!==key)throw problem('문자 요청을 찾을 수 없습니다.',404);
  if(input.action==='sms-status'){
   if(input.part!==undefined&&(!Number.isInteger(input.part)||!batch.parts[input.part]))throw problem('발송 결과 대상을 확인해 주세요.');
   for(let i=0;i<batch.parts.length;i++){
    if(i!==input.part)continue;
    const part=batch.parts[i];if(part.status!=='accepted'||!part.requestId)continue;
    let result;try{result=await provider('GET','?requestId='+encodeURIComponent(part.requestId));}catch{continue;}
    if(!result.ok||!Array.isArray(result.data.messages))continue;
    const results=result.data.messages.filter(r=>r.requestId===part.requestId&&r.status==='COMPLETED'&&['success','fail'].includes(r.statusName));
    const final=new Map();for(const row of results){if(final.has(row.to))final.set(row.to,null);else final.set(row.to,row);}
    await db.runTransaction(async tx=>{
     const current=(await tx.get(ref)).data(),walletRef=db.collection('dispatch_wallets').doc(current.walletId),w=(await tx.get(walletRef)).data();
     const states={...current.states};let released=0,refund=0;
     for(const index of current.parts[i].indices){const m=current.messages[index],row=final.get(m.phone);if(!row||states[m.deliveryNumber]==='success'||states[m.deliveryNumber]==='failed')continue;
      const status=row.statusName==='success'?'success':'failed';for(const number of messageNumbers(m))states[number]=status;released++;if(status==='failed')refund++;
      for(const number of messageNumbers(m))tx.set(db.collection('delivery_sms_receipts').doc(receiptId(key,current.date,number)),{batchId:input.batchId,dispatchKey:key,status,at:now()});
     }
     if(!released)return;
     const parts=current.parts.map((p,j)=>j===i&&p.indices.every(n=>['success','failed'].includes(states[current.messages[n].deliveryNumber]))?{...p,status:'finished'}:p);
     tx.set(walletRef,{...w,recent:[{at:now(),kind:'sms-result',label:`문자 결과 확인 ${released}건 · 실패 복구 ${refund}건`,before:w.balance,balance:w.balance+refund},...(w.recent||[])].slice(0,20),balance:w.balance+refund,reserved:Math.max(0,(w.reserved||0)-released),revision:(w.revision||0)+1});
     tx.set(ref,{...current,parts,states});
    });
   }
   return publicBatch((await ref.get()).data(),input.batchId);
  }
  if(input.action!=='send-sms'||input.confirm!==true||!Number.isInteger(input.part)||!batch.parts[input.part])throw problem('최종 발송 승인과 대상을 확인해 주세요.');
  config();
  const acquired=await db.runTransaction(async tx=>{
   const current=(await tx.get(ref)).data(),license=(await tx.get(db.collection('licenses').doc(key))).data();authorize(license,identity,key);
   const part=current.parts[input.part];if(part.status!=='prepared')return false;
   if(current.expiresAt<=now())throw problem('문자 확인 시간이 지났습니다. 다시 확인해 주세요.',409);
   if(!license.dispatchBillingId)throw problem('문자 잔액을 새로고침한 뒤 다시 시도해 주세요.',409);
   const walletRef=db.collection('dispatch_wallets').doc(license.dispatchBillingId),w=(await tx.get(walletRef)).data();
   const receipts=await Promise.all(part.indices.flatMap(i=>messageNumbers(current.messages[i]).map(number=>tx.get(db.collection('delivery_sms_receipts').doc(receiptId(key,current.date,number))))));
   if(receipts.some(r=>r.exists&&r.data().status!=='failed'))throw problem('이미 발송했거나 처리 중인 배송번호가 있습니다. 결과를 확인해 주세요.',409);
   if(!w||!Number.isSafeInteger(w.balance)||w.balance<part.indices.length)throw problem('발송 가능한 잔여 건수가 부족합니다.',409);
   // Revalidate persisted exact content; never accept browser-supplied message/phone at send time.
   for(const i of part.indices){const m=current.messages[i];if(composeMessage(current.body,m).content!==m.content)throw problem('문자 본문을 다시 확인해 주세요.');}
   if(current.walletId&&current.walletId!==license.dispatchBillingId)throw problem('문자 잔액 정보가 변경되었습니다.',409);
   const parts=current.parts.map((p,i)=>i===input.part?{...p,status:'sending',startedAt:now()}:p),states={...current.states};
   for(const i of part.indices){const m=current.messages[i];for(const number of messageNumbers(m)){states[number]='pending';tx.set(db.collection('delivery_sms_receipts').doc(receiptId(key,current.date,number)),{batchId:input.batchId,dispatchKey:key,status:'pending',at:now()});}}
   tx.set(walletRef,{...w,recent:[{at:now(),kind:'sms-send',label:`문자 발송 예약 ${part.indices.length}건`,before:w.balance,balance:w.balance-part.indices.length},...(w.recent||[])].slice(0,20),balance:w.balance-part.indices.length,reserved:(w.reserved||0)+part.indices.length,revision:(w.revision||0)+1});
   tx.set(ref,{...current,parts,states,walletId:license.dispatchBillingId});return true;
  });
  if(!acquired)return publicBatch((await ref.get()).data(),input.batchId);
  const messages=batch.parts[input.part].indices.map(i=>batch.messages[i]);
  let accepted=null,refused=false;
  try{
   const r=await provider('POST','',{type:'SMS',contentType:'COMM',countryCode:'82',from:config().sender,content:messages[0].content,messages:messages.map(m=>({to:m.phone,content:m.content}))});
   if(r.ok&&String(r.data.statusCode)==='202'&&typeof r.data.requestId==='string'&&r.data.requestId)accepted=r.data.requestId;
   else if(r.data.statusName==='fail'&&String(r.data.statusCode)!=='202')refused=true;
  }catch{/* Response loss may mean accepted. Keep reserved; never retry the provider automatically. */}
  await db.runTransaction(async tx=>{
   const current=(await tx.get(ref)).data(),part=current.parts[input.part];if(part.status!=='sending')return;
   const walletRef=db.collection('dispatch_wallets').doc(current.walletId),w=(await tx.get(walletRef)).data();
   const parts=current.parts.map((p,i)=>i===input.part?{...p,status:accepted?'accepted':refused?'failed':'unknown',...(accepted?{requestId:accepted}:{})}:p),states={...current.states};
   if(refused){for(const m of messages){for(const number of messageNumbers(m)){states[number]='failed';tx.set(db.collection('delivery_sms_receipts').doc(receiptId(key,current.date,number)),{batchId:input.batchId,dispatchKey:key,status:'failed',at:now()});}}
    tx.set(walletRef,{...w,recent:[{at:now(),kind:'sms-refund',label:`문자 접수 실패 복구 ${messages.length}건`,before:w.balance,balance:w.balance+messages.length},...(w.recent||[])].slice(0,20),balance:w.balance+messages.length,reserved:Math.max(0,(w.reserved||0)-messages.length),revision:(w.revision||0)+1});}
   tx.set(ref,{...current,parts,states});
  });
  return publicBatch((await ref.get()).data(),input.batchId);
 }
 return {execute};
}
module.exports={measureSms,composeMessage,prepareSms,createSmsService};
