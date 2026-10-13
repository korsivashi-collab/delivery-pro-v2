import { isNativeApp, apiFetch } from './native-platform.js';

let requestInProgress = false;
async function smsRequest(payload) {
    const response = await apiFetch('/api/native-sms', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    let data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) throw Object.assign(new Error(data.error || '문자 인증 서버에 연결할 수 없습니다.'), { code: 'auth/native-session-failed' });
    return data;
}
export async function sendNativePhoneVerification(phoneNumber, signInWebSession) {
    if (!isNativeApp()) throw new Error('Native phone verification requires a native app');
    if (requestInProgress) throw new Error('휴대폰 인증 요청을 처리 중입니다. 잠시 기다려 주세요.');
    requestInProgress = true;
    try {
        const result = await smsRequest({ action: 'send', phone: phoneNumber });
        if (!result.requestId) throw new Error('문자 인증 요청 결과를 확인해 주세요.');
        let confirming = false;
        return { confirm: async code => {
            if (confirming) throw new Error('인증번호를 확인 중입니다. 잠시 기다려 주세요.');
            if (!/^\d{6}$/.test(code)) throw new Error('인증번호 6자리를 입력해 주세요.');
            confirming = true;
            try {
                const data = await smsRequest({ action: 'confirm', phone: phoneNumber, requestId: result.requestId, code });
                if (!data.token) throw new Error('인증 결과를 확인할 수 없습니다. 다시 요청해 주세요.');
                const credential = await signInWebSession(data.token);
                if (credential.user.phoneNumber !== phoneNumber) throw new Error('인증된 전화번호가 요청한 번호와 다릅니다. 다시 인증해 주세요.');
                return credential;
            } finally { confirming = false; }
        } };
    } finally { requestInProgress = false; }
}
