const admin = require('firebase-admin');
const { randomInt, randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const { normalizePhone, phoneDigits, problem } = require('../server/license-integrity.cjs');

// OTP and counters are server-only Firestore collections (default-denied by existing rules).
function createHandler({ sdk = admin, env = process.env, fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
    function config() {
        const values = ['NCP_ACCESS_KEY', 'NCP_SECRET_KEY', 'NCP_SENS_SERVICE_ID', 'NCP_SENS_SENDER'].map(key => env[key]?.trim());
        if (values.some(value => !value) || !/^\d{8,12}$/.test(values[3])) throw problem('문자 인증 서버 설정을 확인해 주세요.', 503);
        return values;
    }
    return async function handler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST 요청만 가능합니다.' });
        try {
            const [access, secret, serviceId, sender] = config();
            let input;
            try { input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
            catch (_) { throw problem('인증 요청이 올바르지 않습니다.'); }
            if (!input || !['send', 'confirm'].includes(input.action)) throw problem('인증 요청이 올바르지 않습니다.');
            const digits = phoneDigits(normalizePhone(input.phone)), phone = '+82' + digits.slice(1);
            const hash = value => createHmac('sha256', secret).update(value).digest('hex');
            if (!sdk.apps.length) sdk.initializeApp({ credential: sdk.credential.cert({
                projectId: env.FIREBASE_PROJECT_ID, clientEmail: env.FIREBASE_CLIENT_EMAIL,
                privateKey: env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
            }) });
            const db = sdk.firestore(), auth = sdk.auth(), stamp = now();
            const challengeRef = db.collection('native_sms_challenges').doc(hash('phone:' + digits));
            if (input.action === 'send') {
                const requestId = randomUUID(), code = String(randomInt(0, 1000000)).padStart(6, '0');
                // Vercel supplies x-forwarded-for. Global + phone caps remain authoritative even if IP changes.
                const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 100);
                const date = new Date(stamp + 9 * 3600000).toISOString(), day = date.slice(0, 10), month = date.slice(0, 7);
                const specs = [
                    { id: 'global', limits: { day: 100, month: 2000 } },
                    { id: hash('phone-rate:' + digits), limits: { hour: 5, day: 20 } },
                    { id: hash('ip-rate:' + ip), limits: { hour: 20, day: 100 } }
                ];
                const refs = specs.map(spec => db.collection('native_sms_limits').doc(spec.id));
                await db.runTransaction(async tx => {
                    const [old, ...limits] = await Promise.all([tx.get(challengeRef), ...refs.map(ref => tx.get(ref))]);
                    if (stamp - (old.data()?.sentAt || 0) < 60000) throw problem('재전송은 60초 후 가능합니다.', 429);
                    const updates = specs.map((spec, index) => {
                        const previous = limits[index].data() || {}, next = {};
                        for (const [period, maximum] of Object.entries(spec.limits)) {
                            const bucket = period === 'hour' ? Math.floor(stamp / 3600000) : period === 'day' ? day : month;
                            const count = previous[period]?.bucket === bucket ? previous[period].count : 0;
                            if (count >= maximum) throw problem('문자 인증 발송 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.', 429);
                            next[period] = { bucket, count: count + 1 };
                        }
                        return next;
                    });
                    refs.forEach((ref, index) => tx.set(ref, updates[index]));
                    tx.set(challengeRef, { requestId, codeHash: hash(requestId + ':' + digits + ':' + code),
                        sentAt: stamp, expiresAt: stamp + 180000, attempts: 0, status: 'pending' });
                });
                const uri = `/sms/v2/services/${encodeURIComponent(serviceId)}/messages`, timestamp = String(now());
                const signature = createHmac('sha256', secret).update(`POST ${uri}\n${timestamp}\n${access}`).digest('base64');
                try {
                    const response = await fetchImpl('https://sens.apigw.ntruss.com' + uri, {
                        method: 'POST', signal: AbortSignal.timeout(15000),
                        headers: { 'Content-Type': 'application/json', 'x-ncp-apigw-timestamp': timestamp,
                            'x-ncp-iam-access-key': access, 'x-ncp-apigw-signature-v2': signature },
                        body: JSON.stringify({ type: 'SMS', contentType: 'COMM', countryCode: '82', from: sender,
                            content: `[배송경로PRO] 인증번호 ${code} (3분 이내 입력)`, messages: [{ to: digits }] })
                    });
                    const result = await response.json();
                    if (!response.ok || String(result.statusCode) !== '202') throw new Error('provider refused');
                    const ready = await db.runTransaction(async tx => {
                        const doc = await tx.get(challengeRef);
                        if (doc.data()?.requestId !== requestId || doc.data()?.status !== 'pending') return false;
                        tx.update(challengeRef, { status: 'ready', expiresAt: now() + 180000 }); return true;
                    });
                    if (!ready) throw new Error('request superseded');
                } catch (_) {
                    await db.runTransaction(async tx => {
                        const doc = await tx.get(challengeRef);
                        if (doc.data()?.requestId === requestId) tx.update(challengeRef, { status: 'failed', codeHash: '' });
                    });
                    throw problem('문자 발송을 완료하지 못했습니다. 60초 후 다시 요청하거나 고객센터에 문의해 주세요.', 502);
                }
                return res.status(200).json({ requestId, expiresIn: 180, resendAfter: 60 });
            }
            if (!/^[a-f0-9-]{36}$/.test(input.requestId || '') || !/^\d{6}$/.test(input.code || '')) throw problem('인증번호 6자리를 입력해 주세요.');
            const failure = await db.runTransaction(async tx => {
                const doc = await tx.get(challengeRef), value = doc.data();
                if (!value || value.requestId !== input.requestId || value.status !== 'ready' || value.expiresAt <= stamp) return '인증번호가 만료되었거나 이미 사용되었습니다. 다시 요청해 주세요.';
                if (value.attempts >= 5) return '인증번호 입력 횟수를 초과했습니다. 다시 요청해 주세요.';
                const expected = Buffer.from(value.codeHash, 'hex'), actual = Buffer.from(hash(input.requestId + ':' + digits + ':' + input.code), 'hex');
                if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
                    const attempts = value.attempts + 1;
                    tx.update(challengeRef, { attempts, ...(attempts >= 5 ? { status: 'locked', codeHash: '' } : {}) });
                    return attempts >= 5 ? '인증번호 입력 횟수를 초과했습니다. 다시 요청해 주세요.' : '인증번호가 올바르지 않습니다.';
                }
                tx.update(challengeRef, { status: 'consumed', codeHash: '' }); return null;
            });
            if (failure) throw problem(failure, 401);
            let user;
            try { user = await auth.getUserByPhoneNumber(phone); }
            catch (error) {
                if (error.code !== 'auth/user-not-found') throw error;
                try { user = await auth.createUser({ phoneNumber: phone }); }
                catch (race) { if (race.code !== 'auth/phone-number-already-exists') throw race; user = await auth.getUserByPhoneNumber(phone); }
            }
            if (user.disabled || user.uid === 'admin_master' || user.customClaims?.role === 'MASTER') throw problem('접속이 제한된 계정입니다.', 403);
            const token = await auth.createCustomToken(user.uid, { nativePhoneVerified: true });
            return res.status(200).json({ token });
        } catch (error) {
            return res.status(error.status || 500).json({ error: error.status ? error.message : '문자 인증 처리에 실패했습니다. 다시 요청해 주세요.' });
        }
    };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
