const admin = require('firebase-admin');
const { saveLicenses } = require('../server/license-integrity.cjs');

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
        const result = await saveLicenses(admin.firestore(), req.body);
        return res.status(200).json(result);
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        return res.status(500).json({ error: '계정 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
    }
};
