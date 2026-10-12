import { FirebaseAuthentication, isNativeApp, exchangeNativePhoneSession } from './native-platform.js';

let requestInProgress = false;
function nativeVerificationError(event) {
    const message = event.message || '휴대폰 인증에 실패했습니다. 다시 시도해 주세요.';
    if (/valid app identifier|Play Integrity|reCAPTCHA|invalid.app.credential/i.test(message)) {
        return Object.assign(new Error('앱 보안 인증에 실패했습니다. 최신 버전으로 업데이트하거나 고객센터로 문의해 주세요.'), { code: 'auth/invalid-app-credential' });
    }
    return new Error(message);
}
export async function sendNativePhoneVerification(phoneNumber, signInWebSession) {
    if (!isNativeApp()) throw new Error('Native phone verification requires a native app');
    if (requestInProgress) throw new Error('휴대폰 인증 요청을 처리 중입니다. 잠시 기다려 주세요.');
    requestInProgress = true;
    const handles = [];
    let timer, settled = false;
    async function cleanup() {
        clearTimeout(timer);
        for (const handle of handles) { try { await handle.remove(); } catch (_) {} }
        requestInProgress = false;
    }
    return new Promise((resolve, reject) => {
        function finish(error, result) {
            if (settled) return;
            settled = true;
            cleanup().then(() => error ? reject(error) : resolve(result));
        }
        async function webSession() {
            const token = await exchangeNativePhoneSession();
            const credential = await signInWebSession(token);
            if (credential.user.phoneNumber !== phoneNumber) {
                throw new Error('인증된 전화번호가 요청한 번호와 다릅니다. 다시 인증해 주세요.');
            }
            return credential;
        }
        async function listen(name, callback) {
            const handle = await FirebaseAuthentication.addListener(name, callback);
            if (settled) await handle.remove(); else handles.push(handle);
        }
        (async () => {
            try {
                timer = setTimeout(() => finish(new Error('앱 인증 요청 시간이 만료되었습니다. 다시 요청해 주세요.')), 90000);
                await listen('phoneVerificationFailed', event => finish(nativeVerificationError(event)));
                await listen('phoneCodeSent', event => {
                    if (!event.verificationId) return finish(new Error('인증 요청 결과를 확인할 수 없습니다.'));
                    finish(null, { confirm: async code => {
                        await FirebaseAuthentication.confirmVerificationCode({ verificationId: event.verificationId, verificationCode: code });
                        return webSession();
                    } });
                });
                await listen('phoneVerificationCompleted', () => finish(null, { autoVerified: true, confirm: webSession }));
                if (!settled) await FirebaseAuthentication.signInWithPhoneNumber({ phoneNumber });
            } catch (error) { finish(error); }
        })();
    });
}
