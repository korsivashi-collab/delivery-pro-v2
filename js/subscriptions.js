import { Capacitor } from './vendor/capacitor.js';
import * as billingApi from './api.js';
import * as billingAuth from './auth.js';
// Older web deployments do not export the Android billing helpers yet.
// Optional billing must never prevent the main application from starting.
const { billingRequest, getBillingIdentity, firebaseSendSmsVerification, firebaseConfirmSmsCode } = billingApi;
const { getOrCreateDeviceId, activatePurchasedLicense } = billingAuth;

let subscriptionDialog, previousFocus, version=0, busy=false, purchasing=false;
let config, identity, confirmation, requestedPhone='', deadline=0, timer=null, sdkUser=null;
let packages=new Map(), selectedMonths=1, canPurchase=false;
let Purchases;
async function loadPurchases(){
    if(Purchases)return;
    try{({Purchases}=await import('./vendor/purchases.js'));}
    catch{throw new Error('결제 기능을 불러오지 못했습니다. 앱을 최신 버전으로 업데이트한 뒤 다시 시도해 주세요.');}
}
const plans=[{months:1,id:'monthly',label:'1개월',discount:0},
    {months:6,id:'halfyearly',label:'6개월',discount:5},{months:12,id:'yearly',label:'12개월',discount:10}];
const webPlans=[{months:1,label:'1개월',discount:0},{months:3,label:'3개월',discount:5},
    {months:6,label:'6개월',discount:10},{months:12,label:'12개월',discount:15}];
const basePrice=9900;
const isAndroid=()=>Capacitor.getPlatform()==='android';
const visiblePlans=()=>isAndroid()?plans:webPlans;
const won=value=>Math.round(value).toLocaleString('ko-KR')+'원';
function renderPrices(){
    const baseline=packages.get(1)?.product;
    const actual=packages.size>0;
    for(const plan of visiblePlans()){
        const product=packages.get(plan.months)?.product;
        const comparable=product&&baseline&&Number.isFinite(product.price)&&Number.isFinite(baseline.price)&&product.currencyCode===baseline.currencyCode;
        const preview=!actual;
        const total=preview?Math.round(basePrice*plan.months*(100-plan.discount)/100):product?.price;
        const regular=preview?basePrice*plan.months:comparable?baseline.price*plan.months:null;
        const money=value=>preview||product?.currencyCode==='KRW'?won(value):new Intl.NumberFormat('ko-KR',{style:'currency',currency:product.currencyCode,maximumFractionDigits:2}).format(value);
        const saving=regular!=null&&Number.isFinite(total)?Math.max(0,regular-total):0;
        const percent=saving>0?Math.floor(saving/regular*100+0.000001):0;
        el('plan-price-'+plan.months).textContent=preview?won(total):product?.priceString||'준비 중';
        el('plan-monthly-'+plan.months).textContent=Number.isFinite(total)&&(preview||product?.currencyCode)?'월 '+money(total/plan.months):'가격 확인 대기';
        el('plan-original-'+plan.months).textContent=saving>0?money(regular):'';
        el('plan-saving-'+plan.months).textContent=saving>0?money(saving)+' 절약':'한 달씩 가볍게 시작';
        el('plan-badge-'+plan.months).textContent=percent>0?percent+'% 할인':'기본 요금';
        el('plan-'+plan.months).disabled=busy||(actual&&!product);
    }
    const chosen=visiblePlans().find(plan=>plan.months===selectedMonths);
    if(!chosen)return;
    el('billing-summary').textContent=chosen.label+' 총 '+el('plan-price-'+selectedMonths).textContent+(actual?' 결제 · '+chosen.label+'마다 자동 갱신':' · 부가세 포함 금액');
    el('billing-price-note').textContent=actual?'월 환산 금액은 비교용입니다. 선택한 기간의 총액이 한 번에 결제됩니다. 할인은 1개월 상품을 같은 기간 이용한 금액 대비입니다.':'월 9,900원(부가세 포함) 기준입니다. 월 환산 금액은 비교용이며, 선택한 기간의 총액을 한 번에 결제합니다.';
}
const el=id=>subscriptionDialog.querySelector('#'+id);
const normalized=phone=>String(phone||'').replace(/^\+82/,'0').replace(/\D/g,'');
function message(text){el('subscription-status').textContent=text;el('subscription-status').hidden=!text;}
function stopTimer(){clearInterval(timer);timer=null;}
function refreshButtons(){
    el('billing-send').disabled=busy||!config?.enabled;
    el('billing-confirm').disabled=busy||!confirmation;
    el('billing-continue').disabled=busy||!identity||!config?.enabled;
    el('billing-buy').disabled=busy||!identity||!canPurchase||!packages.has(selectedMonths);
    if(!isAndroid())el('billing-buy').disabled=busy||!window.deliveryProPeriodCheckout;
    el('billing-restore').disabled=busy||!identity||!config?.enabled;
    subscriptionDialog.querySelector('[data-close]').disabled=busy;
    subscriptionDialog.querySelectorAll('input').forEach(input=>input.disabled=busy);
    renderPrices();
}
async function work(callback){if(busy)return;busy=true;refreshButtons();try{await callback();}
    catch(error){if(error?.userCancelled||String(error?.code)==='1')message('구매를 취소했습니다.');
        else if(String(error?.code)==='20'){canPurchase=false;message('결제 승인을 기다리고 있습니다. 승인 후 구매 복원으로 확인해 주세요.');}
        else message(error.message||'구독 처리에 실패했습니다. 구매를 반복하지 말고 구매 복원으로 확인해 주세요.');}
    finally{busy=false;purchasing=false;refreshButtons();}}
async function checkIdentity(){const current=await getBillingIdentity();
    if(!current||!identity||current.uid!==identity.uid||normalized(current.phone)!==normalized(identity.phone))throw new Error('전화번호가 변경되었습니다. 인증을 다시 진행해 주세요.');
    return current;
}
async function connectPurchases(){
    await checkIdentity();
    await loadPurchases();
    const session=await billingRequest('session',{deviceId:getOrCreateDeviceId()},identity.uid);
    if(!sdkUser){await Purchases.configure({apiKey:config.publicKey,appUserID:session.appUserId});sdkUser=session.appUserId;}
    else if(sdkUser!==session.appUserId){await Purchases.logIn({appUserID:session.appUserId});sdkUser=session.appUserId;}
    return session;
}
async function prepareAccount(){
    const currentVersion=version;const session=await connectPurchases();
    const offerings=await Purchases.getOfferings();
    if(currentVersion!==version)return;
    const offering=offerings.all?.[config.offeringId];packages.clear();
    for(const pkg of offering?.availablePackages||[]){
        const plan=plans.find(plan=>pkg.product?.identifier==='delivery_pro:'+plan.id);
        // Current launch products are base plans without introductory offers.
        const expectedPeriod=plan&&({1:['P1M'],3:['P3M'],6:['P6M'],12:['P1Y','P12M']}[plan.months]);
        if(plan&&expectedPeriod.includes(pkg.product.subscriptionPeriod)&&pkg.product.priceString&&!(pkg.product.defaultOption?.pricingPhases?.length>1))packages.set(plan.months,pkg);
    }
    if(!packages.has(selectedMonths))selectedMonths=plans.find(plan=>packages.has(plan.months))?.months||1;
    el('plan-'+selectedMonths).checked=true;
    const access=await billingRequest('sync',{deviceId:getOrCreateDeviceId()},identity.uid);
    if(currentVersion!==version)return;
    canPurchase=session.canPurchase&&!access.active;
    if(access.active)message('이용 중인 구독이 있습니다. 구독 관리는 Google Play에서 진행해 주세요.');
    else if(!session.canPurchase)message(session.reason);
    else if(!packages.size)message('구독 상품을 준비하고 있습니다. 잠시 후 다시 확인해 주세요.');
    else message('기간과 총 결제금액을 확인한 후 구독을 신청해 주세요.');
    refreshButtons();
}
async function syncAccess(){await checkIdentity();const result=await billingRequest('sync',{deviceId:getOrCreateDeviceId()},identity.uid);
    if(!result.valid){message('활성 구독을 확인하지 못했습니다. Google Play 결제 상태를 확인한 뒤 구매 복원을 다시 눌러 주세요.');return;}
    activatePurchasedLicense(result);subscriptionDialog.close();}
function buildDialog(){
    subscriptionDialog=document.createElement('dialog');subscriptionDialog.id='subscription-modal';
    subscriptionDialog.className='w-[calc(100%_-_2rem)] max-h-[90dvh] overflow-y-auto rounded-3xl p-6 bg-white text-slate-900 shadow-2xl backdrop:bg-black/60';
    subscriptionDialog.setAttribute('aria-labelledby','subscription-title');
    subscriptionDialog.innerHTML=`<div class="flex items-center justify-between gap-3"><h2 id="subscription-title" class="text-xl font-black">배송경로PRO 구독</h2><button type="button" data-close aria-label="닫기" style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;min-width:48px;border:2px solid #94a3b8;border-radius:10px;background:#e2e8f0;color:#0f172a;font-size:26px;font-weight:800;line-height:1;cursor:pointer">✕</button></div>
    <style>
    #subscription-modal{width:calc(100% - 24px);max-width:600px;padding:24px;border:0;border-radius:24px;color:#142540;background:white;font-family:inherit;box-sizing:border-box}
    #subscription-modal::backdrop{background:#14254099}#subscription-modal *{box-sizing:border-box}
    #subscription-modal .billing-hero{margin:20px 0;padding:22px;border-radius:18px;background:linear-gradient(120deg,#102d63,#205fbd);color:white}
    #subscription-modal .billing-hero h3{font-size:25px;line-height:1.35;margin:8px 0;font-weight:900;letter-spacing:-.8px}
    #subscription-modal .billing-hero p{font-size:13px;line-height:1.65;margin:0;color:#dceaff}
    #subscription-modal .billing-benefits{display:flex;gap:8px;flex-wrap:wrap;margin-top:15px;font-size:12px}
    #subscription-modal .billing-benefits span{padding:5px 9px;border-radius:20px;background:#ffffff1c}
    #subscription-modal .billing-plans{border:0;padding:0;margin:20px 0 12px;display:grid;gap:10px}
    #subscription-modal .billing-plans legend{font-weight:800;margin-bottom:12px}
    #subscription-modal .billing-card{position:relative;display:block;cursor:pointer}
    #subscription-modal .billing-card input{position:absolute;top:22px;left:15px;accent-color:#2563eb;width:17px;height:17px}
    #subscription-modal .billing-card-body{display:grid;grid-template-columns:1fr auto;gap:10px;border:2px solid #e2e8f0;border-radius:16px;padding:16px 16px 16px 42px;background:white;align-items:center}
    #subscription-modal .billing-card input:checked+.billing-card-body{border-color:#2563eb;background:#eff6ff}
    #subscription-modal .billing-card input:focus-visible+.billing-card-body{outline:3px solid #93c5fd;outline-offset:2px}
    #subscription-modal .billing-card input:disabled+.billing-card-body{opacity:.6}
    #subscription-modal .billing-badge{font-size:11px;font-weight:800;border-radius:20px;padding:4px 7px;background:#dbeafe;color:#174dab;display:inline-block;margin-left:6px}
    #subscription-modal .billing-monthly{display:block;font-size:22px;font-weight:900;margin-top:8px;letter-spacing:-.6px}
    #subscription-modal .billing-saving{display:block;color:#14624a;font-weight:700;font-size:12px;margin-top:5px}
    #subscription-modal .billing-total{text-align:right;font-size:12px;color:#52627a;line-height:1.7}
    #subscription-modal .billing-total strong{display:block;font-size:17px;color:#142540}
    #subscription-modal .billing-total del{display:block;color:#8290a5;font-size:12px;min-height:20px}
    #subscription-modal .billing-summary{background:#f1f5f9;padding:13px;border-radius:12px;font-size:14px;font-weight:800;margin-top:14px}
    #subscription-modal .billing-note{font-size:12px;color:#64748b;line-height:1.7;margin-top:10px}
    #subscription-modal [hidden]{display:none!important}
    @media(max-width:390px){#subscription-modal{padding:18px}#subscription-modal .billing-monthly{font-size:19px}#subscription-modal .billing-card-body{padding-right:10px;gap:6px}#subscription-modal .billing-total strong{font-size:15px}}
    </style>
    <div class="billing-hero"><h3>배송 준비는 간편하게,<br>이용 요금은 합리적으로.</h3><p>매일의 배송을 함께하는 배송경로PRO.<br>오래 이용할수록 더 알뜰하게 시작하세요.</p><div class="billing-benefits"><span>주문서 스캔</span><span>배송 경로 최적화</span><span>배송 목록 관리</span></div></div>
    <section id="billing-auth" class="mt-4"><label class="block text-sm font-bold">휴대폰 번호<input id="billing-phone" type="tel" autocomplete="tel" maxlength="20" class="mt-2 w-full rounded-xl border p-3" placeholder="010-1234-5678"></label><button id="billing-send" type="button" class="mt-2 rounded-xl border px-4 py-2">인증번호 받기</button>
    <div id="billing-code-group" class="hidden mt-3"><label>인증번호 <span id="billing-timer"></span><input id="billing-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="mt-2 w-full rounded-xl border p-3"></label><button id="billing-confirm" type="button" class="mt-2 rounded-xl bg-blue-600 px-4 py-2 text-white">전화번호 인증</button></div></section>
    <button id="billing-continue" type="button" class="mt-3 rounded-xl border px-4 py-2 hidden">인증된 번호로 상품 확인</button>
    <fieldset class="billing-plans"><legend>나에게 맞는 이용 기간</legend>${visiblePlans().map(plan=>`<label class="billing-card"><input type="radio" name="subscription-months" id="plan-${plan.months}" value="${plan.months}" ${plan.months===1?'checked':''}><span class="billing-card-body"><span><b>${plan.label}</b><span id="plan-badge-${plan.months}" class="billing-badge"></span><span id="plan-monthly-${plan.months}" class="billing-monthly"></span><span id="plan-saving-${plan.months}" class="billing-saving"></span></span><span class="billing-total">${plan.months}개월 총액<del id="plan-original-${plan.months}"></del><strong id="plan-price-${plan.months}"></strong></span></span></label>`).join('')}</fieldset>
    <div id="billing-summary" class="billing-summary"></div><p id="billing-price-note" class="billing-note"></p>
    <p id="billing-renewal" class="billing-note">해지 전까지 선택한 기간마다 자동 갱신됩니다. 다음 결제를 원하지 않으면 Google Play에서 구독을 취소해 주세요. 취소 후에도 결제한 이용기간까지 사용할 수 있습니다.</p>
    <p id="subscription-status" role="status" class="mt-4 whitespace-pre-line rounded-xl bg-blue-50 p-3 text-sm text-blue-800"></p>
    <button id="billing-buy" type="button" class="mt-4 w-full rounded-xl bg-blue-600 py-3 font-bold text-white disabled:bg-slate-300">Google Play로 구독하기</button>
    <button id="billing-restore" type="button" class="mt-3 w-full rounded-xl border py-3">구매 복원</button>
    <div class="mt-4 flex flex-wrap justify-center gap-4 text-xs"><a id="billing-manage" href="https://play.google.com/store/account/subscriptions" target="_blank" rel="noopener noreferrer" class="underline">구독 관리</a><a href="terms.html" class="underline">이용약관</a><a href="privacy.html" class="underline">개인정보처리방침</a></div>`;
    // Keep the offer visible before asking the customer to verify their phone.
    el('billing-renewal').after(el('billing-auth'),el('billing-continue'));
    document.body.appendChild(subscriptionDialog);
    subscriptionDialog.querySelector('[data-close]').onclick=()=>subscriptionDialog.close();
    subscriptionDialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    subscriptionDialog.addEventListener('close',()=>{version++;stopTimer();previousFocus?.focus();});
    el('billing-phone').oninput=()=>{identity=null;confirmation=null;canPurchase=false;packages.clear();stopTimer();el('billing-code-group').classList.add('hidden');refreshButtons();};
    subscriptionDialog.querySelectorAll('[name="subscription-months"]').forEach(input=>input.onchange=()=>{selectedMonths=Number(input.value);refreshButtons();});
    el('billing-send').onclick=()=>work(async()=>{
        const phone=el('billing-phone').value.trim();if(!/^010\d{8}$/.test(normalized(phone)))throw new Error('휴대폰 번호를 정확하게 입력해 주세요.');
        identity=null;confirmation=null;canPurchase=false;const operation=version;requestedPhone=phone;
        const result=await firebaseSendSmsVerification(phone);
        if(operation!==version)return;confirmation=result;deadline=Date.now()+180000;el('billing-code').value='';el('billing-code-group').classList.remove('hidden');stopTimer();
        const update=()=>{const left=Math.max(0,Math.ceil((deadline-Date.now())/1000));el('billing-timer').textContent=Math.floor(left/60)+':'+String(left%60).padStart(2,'0');if(!left){confirmation=null;stopTimer();refreshButtons();message('인증번호가 만료되었습니다. 다시 요청해 주세요.');}};
        timer=setInterval(update,1000);update();el('billing-code').focus();message('인증번호를 보내드렸습니다. 3분 이내에 입력해 주세요.');
    });
    el('billing-confirm').onclick=()=>work(async()=>{
        if(!confirmation||Date.now()>=deadline||normalized(requestedPhone)!==normalized(el('billing-phone').value))throw new Error('인증번호를 다시 요청해 주세요.');
        const operation=version;const user=await firebaseConfirmSmsCode(confirmation,el('billing-code').value.trim());if(operation!==version)return;
        if(normalized(user.phoneNumber)!==normalized(requestedPhone))throw new Error('인증된 번호가 입력한 번호와 다릅니다.');
        identity=await getBillingIdentity();confirmation=null;stopTimer();el('billing-code-group').classList.add('hidden');await prepareAccount();
    });
    el('billing-continue').onclick=()=>work(prepareAccount);
    el('billing-buy').onclick=()=>work(async()=>{
        if(!isAndroid()){document.dispatchEvent(new CustomEvent('deliverypro:period-checkout',{detail:{months:selectedMonths}}));return;}
        if(!canPurchase||!packages.has(selectedMonths))throw new Error('구독 상품을 먼저 확인해 주세요.');
        await checkIdentity();const session=await billingRequest('session',{deviceId:getOrCreateDeviceId()},identity.uid);
        if(!session.canPurchase||session.appUserId!==sdkUser)throw new Error(session.reason||'구독 계정을 다시 확인해 주세요.');
        purchasing=true;refreshButtons();message('Google Play 결제창에서 금액과 구독 조건을 확인해 주세요.');
        await Purchases.purchasePackage({aPackage:packages.get(selectedMonths)});canPurchase=false;message('구매 결과를 확인하고 있습니다.');await syncAccess();
    });
    el('billing-restore').onclick=()=>work(async()=>{
        await connectPurchases();await checkIdentity();
        purchasing=true;refreshButtons();message('기존 구매를 확인하고 있습니다.');await Purchases.restorePurchases();await syncAccess();
    });
}
export async function openSubscriptionModal(){
    if(subscriptionDialog?.open)return;if(!subscriptionDialog)buildDialog();
    previousFocus=document.activeElement;subscriptionDialog.showModal();version++;const operation=version;
    config=null;identity=null;confirmation=null;packages.clear();canPurchase=false;stopTimer();
    el('billing-code-group').classList.add('hidden');el('billing-continue').classList.add('hidden');refreshButtons();
    for(const id of ['billing-auth','billing-restore','billing-manage','billing-renewal'])el(id).hidden=!isAndroid();
    el('billing-buy').textContent=isAndroid()?'Google Play로 구독하기':window.deliveryProPeriodCheckout?'이용권 구매하기':'결제 준비 중';
    if(!isAndroid()){message('');return;}
    await work(async()=>{
        if([billingRequest,getBillingIdentity,getOrCreateDeviceId,activatePurchasedLicense].some(fn=>typeof fn!=='function')){
            message('결제 기능 업데이트가 필요합니다. 앱을 최신 버전으로 업데이트해 주세요.');return;
        }
        message('구독 서비스를 확인하고 있습니다.');const loaded=await billingRequest('config');if(operation!==version)return;config=loaded;
        if(!config.enabled){message('구독 서비스를 준비하고 있습니다. 현재 결제는 진행되지 않습니다.');return;}
        identity=await getBillingIdentity();
        if(identity?.phone){el('billing-phone').value=identity.phone;el('billing-continue').classList.remove('hidden');message('인증된 번호로 상품 확인을 눌러 주세요.');}
        else{identity=null;el('billing-phone').value=localStorage.getItem('deliveryProUserPhone')||'';message('휴대폰 인증 후 구독 상품을 확인할 수 있습니다.');}
    });
}

export function openLicenseRenewal(){
    if(isAndroid()){
        window.open('https://play.google.com/store/account/subscriptions','_blank','noopener,noreferrer');
        return;
    }
    return openSubscriptionModal();
}
