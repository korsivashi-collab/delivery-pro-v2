const admin = require('firebase-admin');
const { randomInt, randomUUID, createHmac, createHash, timingSafeEqual } = require('node:crypto');
const { assertTrialEligible } = require('../server/trial-registration.cjs');
const { normalizePhone, phoneDigits, problem, isActive, assertNotBlocked } = require('../server/license-integrity.cjs');

// Phone identity owns memos; a replaceable session owns access to a license.
async function claimDevice(sdk, req, input, stamp) {
    const testLogin = input.action === 'login-test-driver';
    const bearer = /^Bearer (.+)$/.exec(req.headers?.authorization || '')?.[1];
    if (!bearer && !testLogin) throw problem('휴대폰 인증을 다시 진행해 주세요.', 401);
    let identity;
    try { identity = testLogin ? {testDriverSession:true} : await sdk.auth().verifyIdToken(bearer, true); }
    catch (_) { throw problem('휴대폰 인증이 만료되었습니다.', 401); }
    const testSession = identity.testDriverSession === true;
    const provider = identity.firebase?.sign_in_provider;
    if (!testSession && (!(provider === 'phone' || provider === 'custom' && identity.nativePhoneVerified === true) ||
        !identity.phone_number || identity.uid === 'admin_master' || ['MASTER','DISPATCH'].includes(identity.role))) {
        throw problem('휴대폰 인증을 완료해 주세요.', 403);
    }
    const phone = normalizePhone(testLogin ? input.phone : testSession ? identity.testPhone : identity.phone_number), deviceId = input.deviceId;
    const key = typeof input.key === 'string' ? input.key.trim().toUpperCase() : '';
    if (!key || key.length > 100 || /[\/\u0000-\u001f]/.test(key) ||
        typeof deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(deviceId)) throw problem('로그인 정보가 올바르지 않습니다.');
    if (input.phone && phoneDigits(input.phone) !== phoneDigits(phone)) throw problem('인증된 휴대폰 번호가 다릅니다.', 403);
    const db = sdk.firestore(), resume = input.action === 'resume-driver';
    const result = await db.runTransaction(async tx => {
        const [exact, blockedSnapshot] = await Promise.all([
            tx.get(db.collection('licenses').doc(key)),
            assertNotBlocked(db, tx, key, phone, deviceId)
        ]);
        let license = exact;
        if (!license.exists) {
            const aliases=await Promise.all([`PRO-${key}`,`TRIAL-${key}`].map(k=>tx.get(db.collection('licenses').doc(k))));
            license=aliases.find(s=>s.exists);
        }
        if (!license?.exists) throw problem('등록되지 않은 라이선스 키입니다.', 404);
        const actualKey = license.id, data = license.data();
        if (testSession) {
            if (data.testSmsBypass !== true || data.type !== 'regular' || data.billingManaged === true ||
                !phone || phoneDigits(data.phone) !== phoneDigits(phone) ||
                (!testLogin && identity.driverKey !== actualKey) ||
                (await tx.get(db.collection('billing_license_bindings').doc(actualKey))).exists) {
                throw Object.assign(problem('이 계정은 휴대폰 인증이 필요합니다.', 403), {code:'SMS_REQUIRED'});
            }
            if (testLogin) identity.uid = 'test-driver-' + createHash('sha256').update(actualKey).digest('hex');
        }
        if (actualKey !== key) await assertNotBlocked(db, tx, actualKey, phone, deviceId, blockedSnapshot);
        if (data.type === 'dispatch' || !isActive(data, new Date(stamp + 9 * 3600000).toISOString().slice(0,10), stamp)) {
            throw problem('사용이 정지되었거나 이용기간이 만료된 계정입니다.', 403);
        }
        const sameBinding = data.deviceId === deviceId && phoneDigits(data.phone) === phoneDigits(phone) && (!data.driverUid || data.driverUid === identity.uid);
        const sameSession = sameBinding && data.driverSessionId && identity.driverSessionId === data.driverSessionId && identity.driverKey === actualKey && identity.driverDeviceId === deviceId;
        if (resume && !sameSession && !(sameBinding && !data.driverSessionId)) throw problem('다른 기기에서 로그인했거나 인증이 만료되었습니다. 다시 인증해 주세요.', 401);
        if (input.action === 'release-driver') {
            if (!sameSession) throw problem('이미 해제된 접속입니다.',401);
            const released={deviceId:'',driverUid:'',driverSessionId:randomUUID()};
            tx.set(db.collection('licenses').doc(actualKey),released,{merge:true});
            tx.set(db.collection('driver_profiles').doc(actualKey),released,{merge:true});
            return {valid:true,released:true};
        }
        const age = Math.floor(stamp / 1000) - identity.auth_time;
        if (!testSession && !sameSession && !(resume && sameBinding && !data.driverSessionId) && (!Number.isFinite(age) || age < -30 || age > 300)) {
            throw problem('새 로그인은 최근 휴대폰 인증이 필요합니다.', 401);
        }
        let routeOwnerId = data.routeOwnerId;
        const changed = !sameSession || !routeOwnerId;
        let profile;
        if (changed) {
            profile = await tx.get(db.collection('driver_profiles').doc(actualKey));
            if (routeOwnerId && profile.data()?.routeOwnerId && routeOwnerId !== profile.data().routeOwnerId) throw problem('배송 자료 연결 정보를 확인해 주세요.', 409);
            routeOwnerId = routeOwnerId || profile.data()?.routeOwnerId || randomUUID();
        }
        const driverSessionId = sameSession ? data.driverSessionId : randomUUID();
        if (changed) {
            const connection = {phone, deviceId, driverUid:identity.uid, driverSessionId, routeOwnerId};
            tx.set(db.collection('licenses').doc(actualKey), {...connection, deviceChangedAt:stamp}, {merge:true});
            tx.set(db.collection('driver_profiles').doc(actualKey), {...connection, key:actualKey,
                status:data.status || 'active', expireDate:data.expireDate || '',
                allowTms:profile.data()?.allowTms ?? data.allowTms ?? true}, {merge:true});
        }
        return {valid:true, actualKey, phone, deviceId, driverSessionId, routeOwnerId,
            expireDate:data.expireDate || '', expiresAt:typeof data.expiresAt?.toMillis === 'function' ? data.expiresAt.toMillis() : data.expiresAt || null,
            billingManaged:data.billingManaged === true, dispatchKey:data.dispatchKey || '', allowTms:data.allowTms !== false,
            testSmsBypass:testSession, needsToken:!sameSession || testLogin};
    });
    if (result.needsToken) result.token = await sdk.auth().createCustomToken(identity.uid, {
        ...(testSession ? {testDriverSession:true, testPhone:phone} : {nativePhoneVerified:true}),
        driverKey:result.actualKey, driverDeviceId:deviceId, driverSessionId:result.driverSessionId
    });
    delete result.needsToken;
    return result;
}

// OTP and counters are server-only Firestore collections (default-denied by existing rules).
function createHandler({ sdk = admin, env = process.env, fetchImpl = (...args) => fetch(...args), now = Date.now, log = record => console.warn('[SENS SMS]', JSON.stringify(record)) } = {}) {
    function config() {
        const values = ['NCP_ACCESS_KEY', 'NCP_SECRET_KEY', 'NCP_SENS_SERVICE_ID'].map(key => env[key]?.trim());
        if (values.some(value => !value)) throw problem('문자 인증 서버 설정을 확인해 주세요.', 503);
        if (!/^ncp:sms:[a-z]{2}:\d+:[A-Za-z0-9_-]+$/.test(values[2])) throw problem('NCP_SENS_SERVICE_ID 설정을 확인해 주세요. SMS 서비스 ID 전체를 입력해야 합니다.', 503);
        return [...values, '01083294575']; // Approved SENS sender; separate from the company contact.
    }
    return async function handler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        const contact = '010-7650-7542';
        const supportNotice = `고객센터 ${contact}로 문의해 주세요.`;

        if (req.method !== 'POST') return res.status(405).json({ error: 'POST 요청만 가능합니다.' });
        try {
            let input;
            try { input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
            catch (_) { throw problem('인증 요청이 올바르지 않습니다.'); }
            if (['claim-device', 'login-driver', 'resume-driver', 'release-driver', 'login-test-driver'].includes(input?.action)) {
                if (!sdk.apps.length) sdk.initializeApp({ credential: sdk.credential.cert({ projectId: env.FIREBASE_PROJECT_ID,
                    clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') }) });
                return res.status(200).json(await claimDevice(sdk, req, input, now()));
            }
            if (!input || !['send', 'confirm'].includes(input.action)) throw problem('인증 요청이 올바르지 않습니다.');
            const [access, secret, serviceId, sender] = config();
            const digits = phoneDigits(normalizePhone(input.phone)), phone = '+82' + digits.slice(1);
            const hash = value => createHmac('sha256', secret).update(value).digest('hex');
            if (!sdk.apps.length) sdk.initializeApp({ credential: sdk.credential.cert({
                projectId: env.FIREBASE_PROJECT_ID, clientEmail: env.FIREBASE_CLIENT_EMAIL,
                privateKey: env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
            }) });
            const db = sdk.firestore(), auth = sdk.auth(), stamp = now();
            const challengeRef = db.collection('native_sms_challenges').doc(hash('phone:' + digits));
            if (input.action === 'send') {
                const isTrial = input.purpose === 'trial';
                if (isTrial && input.trialOffer === 'sales-month' && String(env.SALES_TRIAL_ENABLED || '').trim().toLowerCase() === 'false') {
                    throw problem('30일 무료 체험 신청이 종료되었습니다.',410);
                }
                const requestId = randomUUID(), code = String(randomInt(0, 1000000)).padStart(6, '0');
                // Vercel supplies x-forwarded-for. Global + phone caps remain authoritative even if IP changes.
                const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 100);
                const date = new Date(stamp + 9 * 3600000).toISOString(), day = date.slice(0, 10), month = date.slice(0, 7);
                const specs = [
                    { id: 'global', limits: { day: 100, month: 2000 } },
                    { id: hash('phone-rate:' + digits), limits: { hour: 5, day: 20 } },
                    { id: hash('ip-rate:' + ip), limits: { hour: 20, day: 100 } }
                ];
                if (isTrial) specs.push({id:hash('trial-device-rate:'+String(input.deviceId || '')),limits:{hour:5,day:10}});
                const refs = specs.map(spec => db.collection('native_sms_limits').doc(spec.id));
                await db.runTransaction(async tx => {
                    if (isTrial) await assertTrialEligible(db, tx, digits, input.deviceId);
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
            return res.status(error.status || 500).json({ code:error.code || null, error: (error.status ? error.message : '문자 인증 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.') + '\n문제가 계속되면 ' + supportNotice });
        }
    };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.claimDevice = claimDevice;
