// js/admin-api.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";

// 👇 새롭게 추가된 부분: 인증(Auth) 모듈 불러오기
import { getAuth, initializeAuth, browserSessionPersistence, signInWithCustomToken, RecaptchaVerifier, signInWithPhoneNumber,
    setPersistence, inMemoryPersistence, signOut } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyBZKERmiPis4PCVDSYg0SSRTWV7L3z_5tw",
    authDomain: "delivery-pro-dd272.firebaseapp.com",
    projectId: "delivery-pro-dd272",
    storageBucket: "delivery-pro-dd272.firebasestorage.app",
    messagingSenderId: "329406776647",
    appId: "1:329406776647:web:62b32568328dd1eecab862"
};

// Admin pages share a tab session across navigation, isolated from driver logins
// and from other administrator tabs on the same origin.
const app = initializeApp(firebaseConfig, 'deliverypro-admin');
export const auth = initializeAuth(app, { persistence: browserSessionPersistence });
export const db = getFirestore(app);
export const storage = getStorage(app);

// 관리자 세션은 위에서 탭 단위로 초기화합니다.
export { signInWithCustomToken };

// Signup phone proofs survive payment redirects without replacing admin/driver sessions.
let dispatchSignupAuthPromise=null;
async function getDispatchSignupAuth(){
    if(!dispatchSignupAuthPromise)dispatchSignupAuthPromise=(async()=>{
        const signupAuth=initializeAuth(initializeApp(firebaseConfig,'dispatch-signup'),{persistence:browserSessionPersistence});
        await signupAuth.authStateReady();return signupAuth;
    })();
    return dispatchSignupAuthPromise;
}
export async function requestDispatchSignupSms(phone){
    let digits=String(phone||'').replace(/[\s()-]/g,'');
    if(/^010\d{8}$/.test(digits))digits='+82'+digits.slice(1);
    if(!/^\+8210\d{8}$/.test(digits))throw new Error('휴대폰 번호를 010-1234-5678 형식으로 입력해 주세요.');
    const signupAuth=await getDispatchSignupAuth();await signOut(signupAuth);
    const {sendNativePhoneVerification}=await import('./native-phone-auth.js');
    return sendNativePhoneVerification(digits,token=>signInWithCustomToken(signupAuth,token));
}
export async function dispatchSignupToken(){
    const signupAuth=await getDispatchSignupAuth();
    if(!signupAuth.currentUser)throw new Error('가입할 업체의 담당자 휴대폰 인증을 완료해 주세요.');
    return signupAuth.currentUser.getIdToken();
}

function requireAdminSession() {
    window.dispatchEvent(new CustomEvent('admin-auth-required'));
    throw new Error('관리자 로그인이 만료되었습니다. 다시 로그인해 주세요.');
}

export async function connectDispatchDriver(driverInput, dispatchKey) {
    await auth.authStateReady();
    if (!auth.currentUser) requireAdminSession();
    const token = await auth.currentUser.getIdToken();
    const response = await fetch('/api/admin-license-save', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'linkDispatchDriver', driverInput, dispatchKey,
            sessionToken: sessionStorage.getItem('deliveryProSessionToken') || '' })
    });
    const result = await response.json();
    if (response.status === 401) requireAdminSession();
    if (!response.ok) throw new Error(result.error || '기사 연결에 실패했습니다.');
    return result;
}

// SMS 확인용 세션은 기사/관제/마스터의 실제 로그인 세션과 분리합니다.
const masterSmsAuth = getAuth(initializeApp(firebaseConfig, 'master-sms-verification'));
masterSmsAuth.languageCode = 'ko';
let masterRecaptcha = null;
export function resetMasterSms() {
    if (masterRecaptcha) { try { masterRecaptcha.clear(); } catch (_) {} masterRecaptcha = null; }
    return signOut(masterSmsAuth);
}
export async function requestMasterSms(phone) {
    await resetMasterSms();
    await setPersistence(masterSmsAuth, inMemoryPersistence);
    const verifier = new RecaptchaVerifier(masterSmsAuth, 'master-sms-recaptcha', { size: 'invisible' });
    masterRecaptcha = verifier;
    try { return await signInWithPhoneNumber(masterSmsAuth, phone, verifier); }
    catch (error) {
        if (masterRecaptcha === verifier) await resetMasterSms();
        throw error;
    }
}

export function generateSecureKey() {
    const chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    let p1 = "", p2 = "";
    for (let i = 0; i < 4; i++) {
        p1 += chars.charAt(Math.floor(Math.random() * chars.length));
        p2 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `${p1}-${p2}`;
}
