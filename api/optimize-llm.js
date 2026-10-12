// Existing endpoint retained; route ordering now uses Kakao roads, not an LLM.
const TIMEOUT_MS = 40000;
const MAX_CANDIDATES = 24;
function failure(code, status) { return Object.assign(new Error(code), { code, status }); }
function validPoint(p) { return p && Number.isFinite(p.lat) && Math.abs(p.lat)<=90 && Number.isFinite(p.lng) && Math.abs(p.lng)<=180; }
function validNodes(nodes) {
 return Array.isArray(nodes) && nodes.length>=3 && nodes.length<=6 && nodes.every(p=>validPoint(p) &&
  ((typeof p.id==='string' && p.id.trim() && p.id.length<=160)||(typeof p.id==='number' && Number.isSafeInteger(p.id)))) &&
  new Set(nodes.map(p=>String(p.id))).size===nodes.length;
}
function distance(a,b) {
 const r=Math.PI/180,x=(b.lat-a.lat)*r,y=(b.lng-a.lng)*r;
 const h=Math.sin(x/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(y/2)**2;
 return 6371*2*Math.atan2(Math.sqrt(Math.min(1,h)),Math.sqrt(Math.max(0,1-h)));
}
function bearing(a,b) {
 if(a.lat===b.lat && a.lng===b.lng)return null;
 const r=Math.PI/180,d=(b.lng-a.lng)*r;
 return (Math.atan2(Math.sin(d)*Math.cos(b.lat*r),Math.cos(a.lat*r)*Math.sin(b.lat*r)-Math.sin(a.lat*r)*Math.cos(b.lat*r)*Math.cos(d))*180/Math.PI+360)%360;
}
function angleMetrics(points, originAngle=null) {
 let prev=originAngle,angleSum=0,reversals=0;
 for(let i=1;i<points.length;i++) {
  const angle=bearing(points[i-1],points[i]);if(angle==null)continue;
  if(prev!=null) {const d=Math.abs(((angle-prev+540)%360)-180);angleSum+=d;if(d>135)reversals++;}
  prev=angle;
 }
 return {angleSum,directionReversals:reversals,turnScore:angleSum+reversals*180};
}
// Remove small road digitization wiggles before measuring meaningful direction changes (15m RDP).
function roadPoints(route) {
 const raw=[];
 for(const section of route.sections||[])for(const road of section.roads||[]) {
  const vertices=road.vertexes;
  if(!Array.isArray(vertices)||vertices.length%2)throw failure('KAKAO_GEOMETRY_INVALID',502);
  for(let i=0;i<vertices.length;i+=2) {
   const p={lng:vertices[i],lat:vertices[i+1]};if(!validPoint(p))throw failure('KAKAO_GEOMETRY_INVALID',502);
   if(!raw.length||p.lng!==raw.at(-1).lng||p.lat!==raw.at(-1).lat)raw.push(p);
  }
 }
 if(raw.length<2) {if(route.summary.distance===0)return raw;throw failure('KAKAO_GEOMETRY_INVALID',502);}
 const scale=111320*Math.cos(raw[0].lat*Math.PI/180);
 const points=raw.map(p=>({x:(p.lng-raw[0].lng)*scale,y:(p.lat-raw[0].lat)*111320}));
 const keep=new Set([0,points.length-1]),stack=[[0,points.length-1]];
 while(stack.length) {
  const [a,b]=stack.pop(),p=points[a],q=points[b],dx=q.x-p.x,dy=q.y-p.y,len=dx*dx+dy*dy;
  let max=225,chosen=-1;
  for(let i=a+1;i<b;i++) {
   const t=len?Math.max(0,Math.min(1,((points[i].x-p.x)*dx+(points[i].y-p.y)*dy)/len)):0;
   const d=(points[i].x-p.x-t*dx)**2+(points[i].y-p.y-t*dy)**2;
   if(d>max){max=d;chosen=i;}
  }
  if(chosen>=0){keep.add(chosen);stack.push([a,chosen],[chosen,b]);}
 }
 return [...keep].sort((a,b)=>a-b).map(i=>raw[i]);
}
function candidateOrders(nodes, core, prev, next, heading) {
 const permutations=[];
 function walk(prefix,remaining){if(!remaining.length){permutations.push(prefix);return;}remaining.forEach((p,i)=>walk([...prefix,p],remaining.filter((_,j)=>i!==j)));}
 walk([],nodes);
 if(permutations.length<=MAX_CANDIDATES)return permutations;
 const selected=[],seen=new Set();
 function add(order){const k=JSON.stringify(order.map(p=>p.id));if(!seen.has(k)&&selected.length<MAX_CANDIDATES){seen.add(k);selected.push(order);}}
 add(nodes);add([...nodes].reverse());
 // Explicit front/back attachment candidates, entirely inside the same local region.
 const members=new Set(core.map(p=>p.id)),outside=nodes.filter(p=>!members.has(p.id));
 for(let i=0;i<=outside.length;i++)for(const group of [core,[...core].reverse()])add([...outside.slice(0,i),...group,...outside.slice(i)]);
 const byAngle=[...permutations].sort((a,b)=>angleMetrics([prev,...a,next].filter(Boolean),heading).turnScore-angleMetrics([prev,...b,next].filter(Boolean),heading).turnScore);
 for(const order of byAngle.slice(0,6))add(order);
 for(let i=0;i<MAX_CANDIDATES;i++)add(permutations[Math.round(i*(permutations.length-1)/(MAX_CANDIDATES-1))]);
 for(const order of permutations){add(order);if(selected.length>=MAX_CANDIDATES)break;}
 return selected;
}
function createHandler({fetchImpl=(...args)=>fetch(...args),env=process.env,timeoutMs=TIMEOUT_MS}={}) {
 return async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');let timer,controller;
  try {
   if(req.method!=='POST'){res.setHeader('Allow','POST');throw failure('METHOD_NOT_ALLOWED',405);}
   let body;try{body=typeof req.body==='string'?JSON.parse(req.body):req.body;}catch(_){throw failure('DESTINATIONS_INVALID',400);}
   const core=body?.destinations,context=body?.context||core;
   if(!validNodes(core)||!validNodes(context)||!validPoint(body.prevAnchor)||(body.nextAnchor!=null&&!validPoint(body.nextAnchor))||
    (body.originAngle!=null&&(!Number.isFinite(body.originAngle)||body.originAngle<0||body.originAngle>=360))||
    !core.every(p=>context.some(c=>String(c.id)===String(p.id)&&c.lat===p.lat&&c.lng===p.lng)))throw failure('DESTINATIONS_INVALID',400);
   if(context.some((p,i)=>context.slice(i+1).some(q=>distance(p,q)>.900001)))throw failure('CLUSTER_TOO_WIDE',400);
   const key=env.KAKAO_REST_API_KEY?.trim();if(!key)throw failure('KAKAO_KEY_MISSING',503);
   const nodes=context.map(({id,lat,lng})=>({id:String(id),lat,lng}));
   const group=core.map(({id,lat,lng})=>({id:String(id),lat,lng}));
   const candidates=candidateOrders(nodes,group,body.prevAnchor,body.nextAnchor,body.originAngle??null);
   controller=new AbortController();const coordinate=p=>({x:p.lng,y:p.lat});
   const cache=new Map(),results=new Array(candidates.length);let cursor=0,calls=0;
   async function worker(){while(cursor<candidates.length){
    if(controller.signal.aborted)throw failure('KAKAO_TIMEOUT',504);
    const index=cursor++,order=candidates[index],target=body.nextAnchor||order.at(-1);
    const origin=coordinate(body.prevAnchor);if(body.originAngle!=null)origin.angle=Math.round(body.originAngle)%360;
    const payload=JSON.stringify({origin,destination:coordinate(target),waypoints:(body.nextAnchor?order:order.slice(0,-1)).map(coordinate),
     priority:'RECOMMEND',avoid:['uturn'],alternatives:false,road_details:false,summary:false});
    if(!cache.has(payload)){calls++;cache.set(payload,Promise.resolve().then(async()=>{
     const response=await fetchImpl('https://apis-navi.kakaomobility.com/v1/waypoints/directions',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`KakaoAK ${key}`},body:payload,signal:controller.signal});
     if(!response.ok)throw failure(response.status===429?'KAKAO_RATE_LIMIT':[401,403].includes(response.status)?'KAKAO_AUTH_ERROR':'KAKAO_UPSTREAM_ERROR',502);
     let data;try{data=await response.json();}catch(_){throw failure('KAKAO_SCHEMA_ERROR',502);}
     if(!Array.isArray(data?.routes)||!data.routes.length)throw failure('KAKAO_SCHEMA_ERROR',502);
     const route=data.routes[0];if(route.result_code!==0)return null;
     const s=route.summary;if(!Number.isFinite(s?.duration)||s.duration<0||!Number.isFinite(s?.distance)||s.distance<0)throw failure('KAKAO_SCHEMA_ERROR',502);
     return {duration:s.duration,distance:s.distance,...angleMetrics(roadPoints(route),body.originAngle??null)};
    }));}
    const result=await cache.get(payload);results[index]=result&&{...result,index,order};
   }}
   await Promise.race([Promise.all(Array.from({length:3},worker)),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure('KAKAO_TIMEOUT',504));},timeoutMs);})]);
   const viable=results.filter(Boolean);if(!viable.length)throw failure('KAKAO_NO_ROUTE',502);
   const fastest=[...viable].sort((a,b)=>a.duration-b.duration||a.distance-b.distance||a.index-b.index)[0];
   // Time limits detours; angle sum plus direction reversals ranks simplicity within that limit.
   const simple=viable.filter(r=>r.duration<=fastest.duration*1.15)
    .sort((a,b)=>a.turnScore-b.turnScore||a.duration-b.duration||a.distance-b.distance||a.index-b.index)[0];
   const metrics=r=>r?{optimized:r.order.map(p=>p.id),duration:r.duration,distance:r.distance,angleSum:r.angleSum,directionReversals:r.directionReversals}:null;
   return res.status(200).json({source:'kakao',...metrics(simple),compared:candidates.length,calls,exhaustive:nodes.length<=4,
    comparison:{baseline:metrics(results[0]),fastest:metrics(fastest),simple:metrics(simple)}});
  }catch(error){controller?.abort();return res.status(error.status||502).json({error:{code:error.code||'KAKAO_NETWORK_ERROR'}});}
  finally{clearTimeout(timer);}
 };
}
module.exports=createHandler();module.exports.createHandler=createHandler;
