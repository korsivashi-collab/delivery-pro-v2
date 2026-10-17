const admin = require('firebase-admin');
const {createHash} = require('node:crypto');
const {verifiedPhone} = require('../server/billing.cjs');
const {problem,phoneDigits} = require('../server/license-integrity.cjs');

function createHandler(sdk=admin) {
 return async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
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
    const snap=await db.collection('memos').where('ownerPhone','==',ownerPhone).get();
    return res.status(200).json({addresses:[...new Set(snap.docs.map(d=>d.data().address))],phone});
   }
   if(input.action==='save'){
    const address=String(input.address||'').trim(),memo=String(input.memo||'').trim();
    if(!address||address.length>500||!memo||memo.length>500)throw problem('메모 주소와 내용을 확인해 주세요.');
    const id=createHash('sha256').update(JSON.stringify([ownerPhone,address])).digest('hex'),ref=db.collection('memos').doc(id);
    await db.runTransaction(async tx=>{
     const previous=await tx.get(ref);if(previous.exists&&previous.data().ownerPhone!==ownerPhone)throw problem('메모 작성자가 일치하지 않습니다.',409);
     const now=Date.now(),time=new Date(now+9*3600000).toISOString().slice(0,16).replace('T',' ').replace(/-/g,'.');
     tx.set(ref,{...(previous.data()||{likes:0,createdAt:now}),address,memo,ownerUid:uid,ownerPhone,phone,time,updatedAt:now,reported:false});
    });
    return res.status(200).json({id,phone});
   }
   if(!['like','report','delete'].includes(input.action)||typeof input.id!=='string'||!input.id||input.id.includes('/')||input.id.length>200)throw problem('메모 요청이 올바르지 않습니다.');
   const ref=db.collection('memos').doc(input.id);
   await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);if(!snap.exists)throw problem('메모를 찾을 수 없습니다.',404);
    if(input.action==='delete'){
     if(snap.data().ownerPhone!==ownerPhone)throw problem('본인이 작성한 메모만 삭제할 수 있습니다.',403);
     tx.delete(ref);
    }else tx.set(ref,input.action==='like'?{likes:(Number(snap.data().likes)||0)+1}:{reported:true},{merge:true});
   });
   return res.status(200).json({success:true});
  }catch(e){return res.status(e.status||500).json({error:e.status?e.message:'메모 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.'});}
 };
}
module.exports=createHandler();module.exports.createHandler=createHandler;
