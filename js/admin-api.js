// js/admin-api.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";

// 👇 새롭게 추가된 부분: 인증(Auth) 모듈 불러오기
import { getAuth, signInWithCustomToken, RecaptchaVerifier, signInWithPhoneNumber,
    setPersistence, inMemoryPersistence, signOut } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyBZKERmiPis4PCVDSYg0SSRTWV7L3z_5tw",
    authDomain: "delivery-pro-dd272.firebaseapp.com",
    projectId: "delivery-pro-dd272",
    storageBucket: "delivery-pro-dd272.firebasestorage.app",
    messagingSenderId: "329406776647",
    appId: "1:329406776647:web:62b32568328dd1eecab862"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);

// 👇 새롭게 추가된 부분: Auth 객체 초기화 및 내보내기
export const auth = getAuth(app);
export { signInWithCustomToken };

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
