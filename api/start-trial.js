const admin = require('firebase-admin');
const { registerTrial } = require('../server/trial-registration.cjs');

module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ valid: false, msg: 'POST 요청만 가능합니다.' });
    const offer = req.query?.campaign === 'sales-month' ? 'sales-month' : 'standard';
    if (offer === 'sales-month' && String(process.env.SALES_TRIAL_ENABLED || '').trim().toLowerCase() === 'false') {
        return res.status(410).json({valid:false,msg:'30일 무료 체험 신청이 종료되었습니다.'});
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!token) return res.status(401).json({ valid: false, msg: 'SMS 인증을 먼저 완료해 주세요.' });
    try {
        if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        }) });
        let identity;
        try { identity = await admin.auth().verifyIdToken(token, true); }
        catch (_) { return res.status(401).json({ valid: false, msg: '인증 세션이 만료되었습니다. SMS 인증을 다시 진행해 주세요.' }); }
        return res.status(200).json(await registerTrial(admin.firestore(), identity, req.body, Date.now(), offer));
    } catch (error) {
        return res.status(error.status || 500).json({ valid: false,
            msg: error.status ? error.message : '무료 체험 발급에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
    }
};
