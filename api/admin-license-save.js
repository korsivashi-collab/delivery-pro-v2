const admin = require('firebase-admin');
const { saveLicenses, repairLicensePhones } = require('../server/license-integrity.cjs');

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
        if (identity.role !== 'MASTER') return res.status(403).json({ error: '마스터 관리자만 계정을 저장할 수 있습니다.' });
        if (identity.masterSmsVerified !== true || !(identity.masterSessionExpiresAt > Date.now() / 1000)) {
            return res.status(403).json({ error: '마스터 SMS 인증이 필요합니다. 다시 로그인해 주세요.' });
        }
        if(req.body?.action==='paymentInfo'){
            const key=String(req.body.key||'');
            if(!key||key.includes('/')||key.length>200)return res.status(400).json({error:'계정 키를 확인해 주세요.'});
            const db=admin.firestore(),license=(await db.collection('licenses').doc(key).get()).data();
            const binding=(await db.collection('billing_license_bindings').doc(key).get()).data();
            const uid=binding?.uid||license?.billingUid;
            if(!uid)return res.status(200).json({managed:false,payments:[]});
            const account=(await db.collection('billing_accounts').doc(uid).get()).data()||{};
            const orders=await db.collection('payment_orders').where('uid','==',uid).get();
            const payments=orders.docs.map(d=>{const x=d.data();return {orderId:d.id,months:x.months,amount:x.amount,status:x.status,test:x.test===true,approvedAt:x.approvedAt||null,createdAt:x.createdAt,method:x.method||null,cancelled:account.webHistory?.find(h=>h.orderId===d.id)?.cancelled===true};}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
            return res.status(200).json({managed:true,provider:account.webManaged?'토스 웹 결제':'Google Play',payments});
        }
        const result = req.body?.action === 'repairPhones'
            ? await repairLicensePhones(admin.firestore())
            : await saveLicenses(admin.firestore(), req.body);
        return res.status(200).json(result);
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        return res.status(500).json({ error: '계정 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
    }
};
