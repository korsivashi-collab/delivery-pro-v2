const admin = require('firebase-admin');

module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST 요청만 가능합니다.' });
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!token) return res.status(401).json({ error: '휴대폰 인증이 필요합니다.' });
    try {
        if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        }) });
        let identity;
        try { identity = await admin.auth().verifyIdToken(token, true); }
        catch (_) { return res.status(401).json({ error: '앱 인증이 만료되었습니다. 다시 인증해 주세요.' }); }
        if (identity.firebase?.sign_in_provider !== 'phone' || !identity.phone_number) {
            return res.status(403).json({ error: '검증된 휴대폰 인증만 앱 세션으로 연결할 수 있습니다.' });
        }
        // nativePhoneVerified는 검증된 네이티브 phone ID 토큰에 대해서만 서버가 부여합니다.
        const webToken = await admin.auth().createCustomToken(identity.uid, { nativePhoneVerified: true });
        return res.status(200).json({ token: webToken });
    } catch (_) {
        return res.status(500).json({ error: '앱 인증 서버 설정을 확인해 주세요.' });
    }
};
