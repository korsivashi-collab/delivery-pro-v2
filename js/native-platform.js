import { Capacitor, CapacitorHttp, registerPlugin } from './vendor/capacitor.js';

export const FirebaseAuthentication = registerPlugin('FirebaseAuthentication');
export const KakaoNavigation = registerPlugin('KakaoNavigation');
export const isNativeApp = () => Capacitor.isNativePlatform();
// 공개 백엔드 주소입니다. 앱 자산은 로컬, API만 HTTPS 서버로 연결합니다.
const backendOrigin = 'https://delivery-pro-ksco.vercel.app';
export function getApiUrl(path) {
    if (!/^\/api\//.test(path)) throw new Error('Invalid API path');
    return isNativeApp() ? backendOrigin + path : path;
}
// Firebase Web SDK의 Auth/Firestore 스트리밍은 브라우저 통신을 그대로 사용합니다.
// 회사 API만 직접 네이티브 HTTP를 사용해 로컬 WebView의 CORS를 우회합니다.
export async function apiFetch(path, options = {}) {
    const url = getApiUrl(path);
    if (!isNativeApp()) return fetch(url, options);
    const signal = options.signal;
    const aborted = () => Object.assign(new Error('요청이 취소되었습니다.'), { name: 'AbortError' });
    if (signal?.aborted) throw aborted();
    const data = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            if (error) reject(error); else resolve(value);
        };
        const onAbort = () => finish(aborted());
        signal?.addEventListener('abort', onAbort, { once: true });
        Promise.resolve().then(() => {
            if (settled) return null;
            return CapacitorHttp.request({ url, method: options.method || 'GET', headers: options.headers || {},
                data, connectTimeout: 15000, readTimeout: 65000 });
        }).then(response => {
            if (settled || !response) return;
            finish(null, { ok: response.status >= 200 && response.status < 300, status: response.status,
                json: async () => typeof response.data === 'string' ? JSON.parse(response.data) : response.data });
        }, error => finish(error));
    });
}
export async function exchangeNativePhoneSession() {
    const { token } = await FirebaseAuthentication.getIdToken({ forceRefresh: true });
    const response = await apiFetch('/api/native-auth-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({})
    });
    let data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (response.status !== 200 || !data?.token) {
        throw Object.assign(new Error(data.error || '앱 로그인 서버 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.'), { code: 'auth/native-session-failed' });
    }
    return data.token;
}
