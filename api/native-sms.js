const admin = require('firebase-admin');
const { randomInt, randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const { normalizePhone, phoneDigits, problem } = require('../server/license-integrity.cjs');

// A new device may replace the old binding only after recent SENS verification.
async function claimDevice(sdk, req, input, stamp) {
    const bearer = /^Bearer (.+)$/.exec(req.headers?.authorization || '')?.[1];
    if (!bearer) throw problem('휴대폰 인증을 다시 진행해 주세요.', 401);
    let identity;
    try { identity = await sdk.auth().verifyIdToken(bearer, true); }
    catch (_) { throw problem('휴대폰 인증이 만료되었습니다.', 401); }
    const age = Math.floor(stamp / 1000) - identity.auth_time;
    if (identity.firebase?.sign_in_provider !== 'custom' || identity.nativePhoneVerified !== true ||
        !Number.isFinite(age) || age < -30 || age > 300 || !identity.phone_number || identity.uid === 'admin_master' || identity.role === 'MASTER') {
        throw problem('새 기기 로그인은 최근 SENS 휴대폰 인증이 필요합니다.', 403);
    }
    const key = input.key, deviceId = input.deviceId;
    if (typeof key !== 'string' || !key || key.length > 200 || key.includes('/') ||
        typeof deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(deviceId)) throw problem('로그인 정보가 올바르지 않습니다.');
    const verified = phoneDigits(normalizePhone(identity.phone_number));
    const db = sdk.firestore();
    return db.runTransaction(async tx => {
        const licenseRef = db.collection('licenses').doc(key), profileRef = db.collection('driver_profiles').doc(key);
        const [license, profile, blocked] = await Promise.all([tx.get(licenseRef), tx.get(profileRef), tx.get(db.collection('blocked_devices').doc(deviceId))]);
        if (blocked.exists) throw problem('접속이 제한된 기기입니다.', 403);
        const records = [license, profile].filter(s => s.exists);
        if (!records.length) throw problem('등록되지 않은 라이선스입니다.', 404);
        const today = new Date(stamp + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
        let owner = '';
        for (const snapshot of records) {
            const data = snapshot.data();
            if (data.type === 'dispatch' || ['suspended','revoked','expired','upgraded'].includes(data.status)) throw problem('사용할 수 없는 계정입니다.', 403);
            const expiry = String(data.expireDate || '').replace(/\D/g, '');
            if (expiry && expiry < today || data.expiresAt && data.expiresAt <= stamp) throw problem('이용기간이 만료되었습니다.', 403);
            if (data.phone && phoneDigits(normalizePhone(data.phone)) !== verified) throw problem('등록된 본인 전화번호로 인증해 주세요.', 403);
            if (data.routeOwnerId && owner && owner !== data.routeOwnerId) throw problem('계정 소유자 정보 확인이 필요합니다.', 409);
            owner = data.routeOwnerId || owner;
        }
        if (!records.some(s => s.data().phone)) throw problem('등록된 전화번호가 없어 관리자 확인이 필요합니다.', 403);
        for (const [snapshot, ref] of [[license, licenseRef], [profile, profileRef]]) {
            if (snapshot.exists) tx.update(ref, { deviceId, deviceChangedAt: stamp });
        }
        return { success: true };
    });
}

// OTP and counters are server-only Firestore collections (default-denied by existing rules).
function createHandler({ sdk = admin, env = process.env, fetchImpl = (...args) => fetch(...args), now = Date.now, log = record => console.warn('[SENS SMS]', JSON.stringify(record)) } = {}) {
    function config() {
        const values = ['NCP_ACCESS_KEY', 'NCP_SECRET_KEY', 'NCP_SENS_SERVICE_ID', 'NCP_SENS_SENDER'].map(key => env[key]?.trim());
        if (values.some(value => !value) || !/^\d{8,12}$/.test(values[3])) throw problem('문자 인증 서버 설정을 확인해 주세요.', 503);
        if (!/^ncp:sms:[a-z]{2}:\d+:[A-Za-z0-9_-]+$/.test(values[2])) throw problem('NCP_SENS_SERVICE_ID 설정을 확인해 주세요. SMS 서비스 ID 전체를 입력해야 합니다.', 503);
        return values;
    }
    return async function handler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        const supportDigits = String(env.NCP_SENS_SENDER || '').trim();
        const contact = /^0\d{8,10}$/.test(supportDigits) ? (supportDigits.startsWith('02') ?
            supportDigits.replace(/^(02)(\d{3,4})(\d{4})$/, '$1-$2-$3') :
            supportDigits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3')) :
            /^\d{8}$/.test(supportDigits) ? supportDigits.replace(/^(\d{4})(\d{4})$/, '$1-$2') : '010-7650-7542';
        const supportNotice = `고객센터 ${contact}로 문의해 주세요.`;

        if (req.method !== 'POST') return res.status(405).json({ error: 'POST 요청만 가능합니다.' });
        try {
            const [access, secret, serviceId, sender] = config();
            let input;
            try { input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
            catch (_) { throw problem('인증 요청이 올바르지 않습니다.'); }
            if (input?.action === 'claim-device') {
                if (!sdk.apps.length) sdk.initializeApp({ credential: sdk.credential.cert({ projectId: env.FIREBASE_PROJECT_ID,
                    clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') }) });
                return res.status(200).json(await claimDevice(sdk, req, input, now()));
            }
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
                const uri = `/sms/v2/services/${serviceId}/messages`, timestamp = String(now());
                const signature = createHmac('sha256', secret).update(`POST ${uri}\n${timestamp}\n${access}`).digest('base64');
                let stage = 'request', upstreamStatus = null, providerStatus = null, providerErrorCode = null;
                try {
                    const response = await fetchImpl('https://sens.apigw.ntruss.com' + uri, {
                        method: 'POST', signal: AbortSignal.timeout(15000),
                        headers: { 'Content-Type': 'application/json', 'x-ncp-apigw-timestamp': timestamp,
                            'x-ncp-iam-access-key': access, 'x-ncp-apigw-signature-v2': signature },
                        body: JSON.stringify({ type: 'SMS', contentType: 'COMM', countryCode: '82', from: sender,
                            content: `[배송경로PRO 전화번호 인증]\n인증번호 ${code}\n3분 이내에 입력해 주세요.`, messages: [{ to: digits }] })
                    });
                    upstreamStatus = response.status || null;
                    stage = 'response';
                    const result = await response.json();
                    const safeCode = value => /^[A-Za-z0-9_-]{1,40}$/.test(String(value ?? '')) ? String(value) : null;
                    providerStatus = safeCode(result.statusCode);
                    providerErrorCode = safeCode(result.error?.errorCode ?? result.errorCode ?? result.error?.code);
                    if (!response.ok || String(result.statusCode) !== '202') throw new Error('provider refused');
                    stage = 'save';
                    const ready = await db.runTransaction(async tx => {
                        const doc = await tx.get(challengeRef);
                        if (doc.data()?.requestId !== requestId || doc.data()?.status !== 'pending') return false;
                        tx.update(challengeRef, { status: 'ready', expiresAt: now() + 180000 }); return true;
                    });
                    if (!ready) throw new Error('request superseded');
                } catch (error) {
                    const diagnostic = stage === 'save' ? 'SMS_SESSION_SAVE_FAILED' :
                        error.name === 'TimeoutError' || error.name === 'AbortError' ? 'SENS_TIMEOUT' :
                        upstreamStatus ? 'SENS_HTTP_' + upstreamStatus : 'SENS_NETWORK_ERROR';
                    // Never log request body, OTP, phone, authorization, raw provider message or credentials.
                    log({ code: diagnostic, stage, httpStatus: upstreamStatus, providerStatus, providerErrorCode });
                    try {
                        await db.runTransaction(async tx => {
                            const doc = await tx.get(challengeRef);
                            if (doc.data()?.requestId === requestId) tx.update(challengeRef, { status: 'failed', codeHash: '' });
                        });
                    } catch (_) { log({ code: 'SMS_FAILURE_STATE_SAVE_FAILED' }); }
                    const reason = stage === 'save' ? '문자 요청은 접수됐지만 인증 상태 저장에 실패했습니다.' :
                        [401, 403].includes(upstreamStatus) ? 'SENS API 인증 또는 접근 권한을 확인해 주세요.' :
                        upstreamStatus === 404 ? 'SENS 서비스 ID와 API 경로를 확인해 주세요.' :
                        upstreamStatus === 400 ? 'SENS 발신번호 등록과 문자 요청 설정을 확인해 주세요.' :
                        upstreamStatus === 429 ? 'SENS 발송 한도를 확인해 주세요.' :
                        diagnostic === 'SENS_TIMEOUT' ? 'SENS 서버 응답 시간이 초과되었습니다.' : 'SENS 문자 발송 요청에 실패했습니다.';
                    return res.status(502).json({ error: `${reason} (${diagnostic})\n문제가 계속되면 ${supportNotice}`, code: diagnostic });
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
            return res.status(error.status || 500).json({ error: (error.status ? error.message : '문자 인증 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.') + '\n문제가 계속되면 ' + supportNotice });
        }
    };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.claimDevice = claimDevice;
