const admin = require('firebase-admin');
const {assertDriverSession,assertDispatchSession,isActive,problem} = require('../server/license-integrity.cjs');
const alphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeNumber(value){
 let result='';for(let i=0;i<5;i++){result=alphabet[value%alphabet.length]+result;value=Math.floor(value/alphabet.length);}
 if(value)throw problem('배송번호 발급 범위를 초과했습니다.',503);return result;
}
async function allocate(db,scope,ids){
 return db.runTransaction(async tx=>{
  const counterRef=db.collection('delivery_number_registry').doc('_counter');
  const refs=ids.map(id=>db.collection('delivery_number_registry').doc(id));
  const [counter,...records]=await Promise.all([tx.get(counterRef),...refs.map(ref=>tx.get(ref))]);
  let next=counter.data()?.next||0;
  for(const record of records)if(record.exists&&record.data().scope!==scope)throw problem('배송 등록 계정이 일치하지 않습니다.',403);
  const result=records.map((record,index)=>{
   if(record.exists)return {deliveryId:ids[index],deliveryNumber:record.data().number};
   const number=encodeNumber(next++);tx.set(refs[index],{scope,number,createdAt:Date.now()});
   return {deliveryId:ids[index],deliveryNumber:number};
  });
  tx.set(counterRef,{next});return result;
 });
}
function createHandler(sdk=admin){return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{
  if(req.method!=='POST')throw problem('POST 요청만 가능합니다.',405);
  const body=req.body||{},ids=body.ids;
  if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)))throw problem('배송 등록 정보를 확인해 주세요.');
  if(!sdk.apps.length)sdk.initializeApp({credential:sdk.credential.cert({projectId:process.env.FIREBASE_PROJECT_ID,clientEmail:process.env.FIREBASE_CLIENT_EMAIL,privateKey:process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,'\n')})});
  let identity;try{const bearer=/^Bearer (.+)$/.exec(req.headers?.authorization||'')?.[1];if(!bearer)throw Error();identity=await sdk.auth().verifyIdToken(bearer,true);}catch{throw problem('로그인 후 배송을 등록해 주세요.',401);}
  const db=sdk.firestore();let scope;
  if(identity.role==='DISPATCH'||identity.role==='MASTER'){
   const key=identity.role==='DISPATCH'?identity.uid:body.dispatchKey;
   if(typeof key!=='string'||!key||key.includes('/'))throw problem('관제 계정을 확인해 주세요.',403);
   if(identity.role==='MASTER'&&!(identity.masterSmsVerified&&identity.masterSessionExpiresAt>Date.now()/1000))throw problem('관리자 인증을 확인해 주세요.',403);
   const account=(await db.collection('licenses').doc(key).get()).data();
   if(account?.type!=='dispatch'||!isActive(account,new Date(Date.now()+9*3600000).toISOString().slice(0,10),Date.now()))throw problem('관제 이용권을 확인해 주세요.',403);
   if(identity.role==='DISPATCH')assertDispatchSession(account,identity);scope='dispatch:'+key;
  }else{
   await assertDriverSession(db,identity,body.key,body.deviceId);scope='driver:'+body.key;
  }
  return res.status(200).json({deliveries:await allocate(db,scope,ids)});
 }catch(error){return res.status(error.status||500).json({error:error.status?error.message:'배송번호를 발급하지 못했습니다. 다시 시도해 주세요.'});}
};}
module.exports=createHandler();module.exports.createHandler=createHandler;module.exports.allocate=allocate;module.exports.encodeNumber=encodeNumber;
