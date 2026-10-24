const admin = require('firebase-admin');
const {createHash,timingSafeEqual,randomUUID} = require('node:crypto');
const {verifiedPhone} = require('../server/billing.cjs');
const {problem,phoneDigits} = require('../server/license-integrity.cjs');

// A normalized ownerPhone is authoritative. Older records used only phone.
function memoOwnerPhone(data) {
 return phoneDigits(data.ownerPhone || data.phone);
}
function phoneVariants(phone) {
 const digits=phoneDigits(phone), formatted=digits.replace(/^(010)(\d{4})(\d{4})$/,'$1-$2-$3');
 return [...new Set([digits,formatted,'+82'+digits.slice(1),formatted.replace(/-/g,' '),
  '+82 '+formatted.slice(1),'+82 '+formatted.slice(1).replace(/-/g,' '),'+82-'+formatted.slice(1)])];
}
function hasInternetAddress(value) {
 if(typeof value!=='string')return false;
 const text=value.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g,'').replace(/[。｡]/g,'.');
 if(/\b(?:https?|ftp):\/\/|\bwww\.|\b(?:javascript|data|file):/i.test(text))return true;
 // A hostname needs a letter-only TLD (or an IDN TLD); heights such as 2.2m are not domains.
 if(/(?:^|[^\p{L}\p{N}_@.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59}|한국|닷컴|닷넷)(?![\p{L}\p{N}-])/iu.test(text))return true;
 return [...text.matchAll(/(?:^|[^\p{L}\p{N}.])((?:\d{1,3}\.){3}\d{1,3})(?![\p{L}\p{N}.])/gu)]
  .some(m=>m[1].split('.').every(n=>Number(n)<=255));
}
const urlMemo = data => hasInternetAddress(data?.memo) || hasInternetAddress(data?.address);
async function cleanupUrlMemos(db, now=()=>Date.now()) {
 const started=now(), day=new Date(started+9*3600000).toISOString().slice(0,10), runId=randomUUID();
 const statusRef=db.collection('maintenance_jobs').doc('memo-url-cleanup');
 const acquired=await db.runTransaction(async tx=>{
  const data=(await tx.get(statusRef)).data() || {};
  if(data.completedDay===day || data.lockUntil>started)return null;
  const cursor=typeof data.cursor==='string'?data.cursor:null;
  tx.set(statusRef,{runId,lockUntil:started+60000,cursor,startedAt:started},{merge:true});return {cursor};
 });
 if(!acquired)return {skipped:true};
 let cursor=acquired.cursor,scanned=0,deleted=0,complete=false;
 const progress=async values=>db.runTransaction(async tx=>{
  if((await tx.get(statusRef)).data()?.runId!==runId)throw Error('Cleanup lease ended');
  tx.set(statusRef,values,{merge:true});
 });
 try {
  do {
   let query=db.collection('memos').orderBy(admin.firestore.FieldPath.documentId()).limit(200);
   if(cursor)query=query.startAfter(cursor);
   const page=await query.get();
   if(page.empty){complete=true;break;}
   const candidates=page.docs.filter(d=>urlMemo(d.data()));
   if(candidates.length)deleted+=await db.runTransaction(async tx=>{
    // Recheck current content so a concurrently corrected ordinary memo is preserved.
    const latest=await Promise.all(candidates.map(d=>tx.get(d.ref)));let count=0;
    for(const d of latest)if(d.exists && urlMemo(d.data())){tx.delete(d.ref);count++;}
    return count;
   });
   scanned+=page.size;cursor=page.docs.at(-1).id;
   complete=page.size<200;
   await progress({cursor:complete?null:cursor,scanned,deleted});
  } while(!complete && now()-started<45000);
  await progress({cursor:complete?null:cursor,runId:null,lockUntil:0,finishedAt:now(),scanned,deleted,complete,
   ...(complete?{completedDay:day}:{})});
  return {scanned,deleted,complete};
 } catch(error) {
  await progress({runId:null,lockUntil:0,failedAt:now()}).catch(()=>{});throw error;
 }
}
function createHandler(sdk=admin,env=process.env) {
 return async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET'){
   const secret=env.CRON_SECRET,provided=/^Bearer (.+)$/.exec(req.headers?.authorization||'')?.[1];
   if(typeof secret!=='string'||secret.length<32||!provided||Buffer.byteLength(secret)!==Buffer.byteLength(provided)||!timingSafeEqual(Buffer.from(secret),Buffer.from(provided)))return res.status(401).json({error:'허용되지 않은 요청입니다.'});
   try{
    if(!sdk.apps.length)sdk.initializeApp({credential:sdk.credential.cert({projectId:env.FIREBASE_PROJECT_ID,clientEmail:env.FIREBASE_CLIENT_EMAIL,privateKey:env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,'\n')})});
    const result=await cleanupUrlMemos(sdk.firestore());
    console.info('[memo URL cleanup]',result);return res.status(200).json(result);
   }catch{return res.status(500).json({error:'공용 메모 자동 정리에 실패했습니다.'});}
  }
  if(req.method!=='POST')return res.status(405).json({error:'POST 요청만 가능합니다.'});
  try {
   if(!sdk.apps.length)sdk.initializeApp({credential:sdk.credential.cert({projectId:process.env.FIREBASE_PROJECT_ID,clientEmail:process.env.FIREBASE_CLIENT_EMAIL,privateKey:process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g,'\n')})});
   const token=/^Bearer (.+)$/.exec(req.headers?.authorization||'')?.[1];
   if(!token)throw problem('휴대폰 인증 후 메모를 이용해 주세요.',401);
   let identity;try{identity=await sdk.auth().verifyIdToken(token,true);}catch{throw problem('휴대폰 인증을 다시 진행해 주세요.',401);}
   const phone=verifiedPhone(identity),db=sdk.firestore(),input=req.body||{},uid=identity.uid;
   const ownerPhone=phoneDigits(phone);
   if (['backup-save','backup-read','backup-delete'].includes(input.action)) {
    const ref=db.collection('temp_memo_backups').doc(ownerPhone);
    if(input.action==='backup-save') {
     if(typeof input.payload!=='string'||input.payload.length>700000||!Number.isInteger(input.count)||input.count<1)throw problem('백업 자료가 올바르지 않습니다.');
     await ref.set({ownerPhone,payload:input.payload,count:input.count,createdAt:Date.now(),expireAt:Date.now()+43200000});
     return res.status(200).json({success:true});
    }
    const backup=await db.runTransaction(async tx=>{
     const snap=await tx.get(ref),data=snap.data();
     if(!snap.exists)return null;
     if(input.action==='backup-delete'||data.expireAt<=Date.now()){tx.delete(ref);return {expired:true};}
     return {...data,expired:false};
    });
    return res.status(200).json({backup});
   }
   if(input.action==='mine'){
    const queries=[db.collection('memos').where('ownerPhone','==',ownerPhone),
     ...phoneVariants(phone).map(value=>db.collection('memos').where('phone','==',value))];
    const snapshots=await Promise.all(queries.map(query=>query.get()));
    const addresses=new Set();
    for(const snapshot of snapshots)for(const item of snapshot.docs){
     const data=item.data();
     if(memoOwnerPhone(data)===ownerPhone && typeof data.address==='string' && data.address.trim())addresses.add(data.address);
    }
    return res.status(200).json({addresses:[...addresses],phone});
   }
   if(input.action==='save'){
    const address=String(input.address||'').trim(),memo=String(input.memo||'').trim();
    if(!address||address.length>500||!memo||memo.length>500)throw problem('메모 주소와 내용을 확인해 주세요.');
    let id=createHash('sha256').update(JSON.stringify([ownerPhone,address])).digest('hex');
    const canonicalRef=db.collection('memos').doc(id);
    await db.runTransaction(async tx=>{
     const [canonical,existing]=await Promise.all([tx.get(canonicalRef),tx.get(db.collection('memos').where('address','==',address))]);
     if(canonical.exists&&memoOwnerPhone(canonical.data())!==ownerPhone)throw problem('메모 작성자가 일치하지 않습니다.',409);
     const previous=canonical.exists?canonical:existing.docs.filter(item=>memoOwnerPhone(item.data())===ownerPhone).sort((a,b)=>a.id.localeCompare(b.id))[0];
     const ref=previous?.ref || canonicalRef;
     id=ref.id;
     const now=Date.now(),time=new Date(now+9*3600000).toISOString().slice(0,16).replace('T',' ').replace(/-/g,'.');
     tx.set(ref,{...(previous?.data()||{likes:0,createdAt:now}),address,memo,ownerUid:uid,ownerPhone,phone,time,updatedAt:now,reported:false});
    });
    return res.status(200).json({id,phone});
   }
   if(!['like','report','delete'].includes(input.action)||typeof input.id!=='string'||!input.id||input.id.includes('/')||input.id.length>200)throw problem('메모 요청이 올바르지 않습니다.');
   const ref=db.collection('memos').doc(input.id);
   await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);if(!snap.exists)throw problem('메모를 찾을 수 없습니다.',404);
    if(input.action==='delete'){
     if(memoOwnerPhone(snap.data())!==ownerPhone)throw problem('본인이 작성한 메모만 삭제할 수 있습니다.',403);
     tx.delete(ref);
    }else tx.set(ref,input.action==='like'?{likes:(Number(snap.data().likes)||0)+1}:{reported:true},{merge:true});
   });
   return res.status(200).json({success:true});
  }catch(e){return res.status(e.status||500).json({error:e.status?e.message:'메모 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.'});}
 };
}
module.exports=createHandler();module.exports.createHandler=createHandler;
module.exports.hasInternetAddress=hasInternetAddress;module.exports.cleanupUrlMemos=cleanupUrlMemos;
