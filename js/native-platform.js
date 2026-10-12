import { Capacitor, CapacitorHttp, registerPlugin } from './vendor/capacitor.js';

export const FirebaseAuthentication = registerPlugin('FirebaseAuthentication');
export const isNativeApp = () => Capacitor.isNativePlatform();
// 공개 백엔드 주소입니다. 앱 자산은 로컬, API만 HTTPS 서버로 연결합니다.
const backendOrigin = 'https://delivery-pro-ksco.vercel.app';
export function getApiUrl(path) {
    if (!/^\/api\//.test(path)) throw new Error('Invalid API path');
    return isNativeApp() ? backendOrigin + path : path;
}
export async function exchangeNativePhoneSession() {
    const { token } = await FirebaseAuthentication.getIdToken({ forceRefresh: true });
    const response = await CapacitorHttp.post({
        url: getApiUrl('/api/native-auth-session'),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        data: {}, connectTimeout: 15000, readTimeout: 15000
    });
    if (response.status !== 200 || !response.data?.token) {
        throw new Error(response.data?.error || '앱 인증 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    }
    return response.data.token;
}
