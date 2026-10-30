const admin = require('firebase-admin');
const {randomInt,createHash}=require('node:crypto');
const {assertDriverSession,assertDispatchSession,isActive,problem} = require('./license-integrity.cjs');
const alphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeNumber(value){
 let result='';for(let i=0;i<5;i++){result=alphabet[value%alphabet.length]+result;value=Math.floor(value/alphabet.length);}
 if(value)throw problem('배송번호 발급 범위를 초과했습니다.',503);return result;
}
async function allocate(db,scope,ids,draw=()=>randomInt(alphabet.length**5)){
 return db.runTransaction(async tx=>{
  const registry=db.collection('delivery_number_registry'),counterRef=registry.doc('_counter');
  const refs=ids.map(id=>registry.doc(id));
  const [counter,...records]=await Promise.all([tx.get(counterRef),...refs.map(ref=>tx.get(ref))]);
  const legacyNext=counter.data()?.next||0;
  for(const record of records)if(record.exists&&record.data().scope!==scope)throw problem('배송 등록 계정이 일치하지 않습니다.',403);
  const chosen=new Set(records.filter(record=>record.exists).map(record=>record.data().number)),reservations=[];
  const result=await Promise.all(ids.map(async(id,index)=>{
   if(records[index].exists)return {deliveryId:id,deliveryNumber:records[index].data().number};
   let number,reservation;
   for(let attempt=0;attempt<100;attempt++){
    const value=draw();
    // Every value below the legacy counter was already issued sequentially.
    if(value<legacyNext)continue;
    const candidate=encodeNumber(value);if(chosen.has(candidate))continue;
    chosen.add(candidate);
    const ref=registry.doc('number_'+candidate),existing=await tx.get(ref);
    if(existing.exists)continue;
    number=candidate;reservation=ref;break;
   }
   if(!number)throw problem('배송번호 발급이 지연되고 있습니다. 다시 시도해 주세요.',503);
   reservations.push({index,ref:reservation,number});return {deliveryId:id,deliveryNumber:number};
  }));
  // No writes before all collision checks: Firestore requires reads before writes.
  for(const entry of reservations){
   tx.set(entry.ref,{deliveryId:ids[entry.index],scope});
   tx.set(refs[entry.index],{scope,number:entry.number,createdAt:Date.now()});
  }
  return result;
 });
}

async function numberRoute(db,identity,key,deviceId){
 const license=await assertDriverSession(db,identity,key,deviceId),owner=license.routeOwnerId;
 if(!owner)throw problem('배송 자료 연결 정보를 확인해 주세요.',409);
 const ref=db.collection('routes').doc(owner),initial=(await ref.get()).data();
 if(!initial||initial.routeOwnerId!==owner||initial.cleared)return {updated:0};
 const pending=(initial.destinations||[]).filter(d=>!d.deliveryNumber);
 const idFor=d=>{if(/^[a-f0-9-]{36}$/.test(d.deliveryId||''))return d.deliveryId;const hex=createHash('sha256').update(JSON.stringify([owner,initial.resetId||'',String(d.id)])).digest('hex').slice(0,32);return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);};
 const mappings=new Map();
 for(let offset=0;offset<pending.length;offset+=100){
  const items=pending.slice(offset,offset+100),numbers=await allocate(db,'route:'+owner,items.map(idFor));
  items.forEach((item,i)=>mappings.set(String(item.id),numbers[i]));
 }
 if(!mappings.size)return {updated:0};
 return db.runTransaction(async tx=>{
  const [routeSnap,licenseSnap]=await Promise.all([tx.get(ref),tx.get(db.collection('licenses').doc(key))]);
  const route=routeSnap.data(),current=licenseSnap.data();
  if(current?.driverSessionId!==identity.driverSessionId||current?.routeOwnerId!==owner)throw problem('접속이 해제되었습니다.',401);
  if(!route||route.cleared||route.routeOwnerId!==owner||route.resetId!==initial.resetId)return {updated:0};
  let updated=0;
  const destinations=(route.destinations||[]).map(d=>{
   const entry=mappings.get(String(d.id));if(d.deliveryNumber||!entry||idFor(d)!==entry.deliveryId)return d;updated++;
   return {...d,...entry};
  });
  if(updated)tx.set(ref,{...route,destinations});
  return {updated};
 });
}
function createHandler(sdk=admin){return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{
  if(req.method!=='POST')throw problem('POST 요청만 가능합니다.',405);
  const body=req.body||{},ids=body.ids;
  const routeRequest=body.action==='number-route';
  if(!routeRequest&&(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))))throw problem('배송 등록 정보를 확인해 주세요.');
  if(!sdk.apps.length)sdk.initializeApp({credential:sdk.credential.cert({projectId:process.env.FIREBASE_PROJECT_ID,clientEmail:process.env.FIREBASE_CLIENT_EMAIL,privateKey:process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,'\n')})});
  let identity;try{const bearer=/^Bearer (.+)$/.exec(req.headers?.authorization||'')?.[1];if(!bearer)throw Error();identity=await sdk.auth().verifyIdToken(bearer,true);}catch{throw problem('로그인 후 배송을 등록해 주세요.',401);}
  const db=sdk.firestore();let scope;
  if(routeRequest){
   if(identity.role==='MASTER'||identity.role==='DISPATCH')throw problem('기사 접속이 필요합니다.',403);
   return res.status(200).json(await numberRoute(db,identity,body.key,body.deviceId));
  }
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
module.exports.numberRoute=numberRoute;
