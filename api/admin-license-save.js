const admin = require('firebase-admin');
const { saveLicenses, repairLicensePhones, deleteLicenseAccount, linkDispatchDriver } = require('../server/license-integrity.cjs');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST 요청만 가능합니다.' });
    res.setHeader('Cache-Control', 'no-store');
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!token) return res.status(401).json({ error: '마스터 로그인이 필요합니다.' });
    try {
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            }) });
        }
        let identity;
        try { identity = await admin.auth().verifyIdToken(token, true); }
        catch (_) { return res.status(401).json({ error: '로그인이 만료되었습니다. 다시 로그인해 주세요.' }); }
        if(req.body?.action==='linkDispatchDriver') return res.status(200).json(await linkDispatchDriver(admin.firestore(),identity,req.body));
        if (identity.role !== 'MASTER') return res.status(403).json({ error: '마스터 관리자만 계정을 저장할 수 있습니다.' });
        if (identity.masterSmsVerified !== true || !(identity.masterSessionExpiresAt > Date.now() / 1000)) {
            return res.status(403).json({ error: '마스터 SMS 인증이 필요합니다. 다시 로그인해 주세요.' });
        }
        if(['smsWallet','adjustSmsCredits'].includes(req.body?.action)) return res.status(200).json(await require('./dispatch-payment.js').createService().execute(admin.firestore(),identity,{...req.body,dispatchKey:req.body.key,action:req.body.action==='smsWallet'?'wallet':'adjust'}));
        if(req.body?.action==='cancelPayment') return res.status(200).json(await require('./payment-confirm.js').createService().cancelPayment(admin.firestore(),req.body,identity.uid));
        if(req.body?.action==='delete') return res.status(200).json(await deleteLicenseAccount(admin.firestore(),req.body));
        if(req.body?.action==='paymentInfo'){
            const key=String(req.body.key||'');
            if(!key||key.includes('/')||key.length>200)return res.status(400).json({error:'계정 키를 확인해 주세요.'});
            const db=admin.firestore(),license=(await db.collection('licenses').doc(key).get()).data();
            const binding=(await db.collection('billing_license_bindings').doc(key).get()).data();
            const uid=binding?.uid||license?.billingUid;
            if(!uid)return res.status(200).json({managed:false,payments:[]});
            const account=(await db.collection('billing_accounts').doc(uid).get()).data()||{};
            const orders=await db.collection('payment_orders').where('uid','==',uid).get();
            const payments=orders.docs.filter(d=>d.data().licenseKey===key).map(d=>{const x=d.data();return {orderId:d.id,months:x.months,amount:x.amount,status:x.status,test:x.test===true,approvedAt:x.approvedAt||null,createdAt:x.createdAt,method:x.method||null,fullyCancelled:x.cancellation?.status==='CANCELED',cancelled:account.webHistory?.find(h=>h.orderId===d.id)?.cancelled===true};}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
            return res.status(200).json({managed:true,provider:account.webManaged?'토스 웹 결제':'Google Play',phone:account.phone,canCancel:account.webManaged===true,payments});
        }
        const result = req.body?.action === 'repairPhones'
            ? await repairLicensePhones(admin.firestore())
            : await saveLicenses(admin.firestore(), req.body);
        return res.status(200).json(result);
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message, code:error.code||null });
        return res.status(500).json({ error: req.body?.action==='cancelPayment' ? '결제 취소 결과 저장을 확인하지 못했습니다. 같은 주문의 취소 버튼으로 다시 확인해 주세요. 재결제하지 마세요.' : '계정 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
    }
};
