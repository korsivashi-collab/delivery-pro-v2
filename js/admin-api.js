// js/admin-api.js
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { getAuth, setPersistence, browserLocalPersistence, signInWithCustomToken, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyBZKERmiPis4PCVDSYg0SSRTWV7L3z_5tw",
    authDomain: "delivery-pro-dd272.firebaseapp.com",
    projectId: "delivery-pro-dd272",
    storageBucket: "delivery-pro-dd272.firebasestorage.app",
    messagingSenderId: "329406776647",
    appId: "1:329406776647:web:62b32568328dd1eecab862"
};

// Source/build-time configuration only: replace this literal in the approved test
// artifact with mode 'test', its exact allowed project ID and full public Web config.
// Never select an environment through browser input, globals, URLs or storage.
const firebaseEnvironment = Object.freeze({ mode: 'production', testProjectId: null, config: null });
function selectFirebaseConfig() {
    if (firebaseEnvironment.mode === 'production') {
        if (firebaseEnvironment.testProjectId !== null || firebaseEnvironment.config !== null) throw new Error('FIREBASE_CONFIG_INVALID');
        return firebaseConfig;
    }
    const { mode, testProjectId, config } = firebaseEnvironment;
    if (mode !== 'test' || typeof testProjectId !== 'string' ||
        !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(testProjectId) ||
        testProjectId === 'delivery-pro-dd272' || !config ||
        config.projectId === 'delivery-pro-dd272' || config.projectId !== testProjectId ||
        ['apiKey', 'authDomain', 'appId'].some(key => typeof config[key] !== 'string' || !config[key].trim())) {
        throw new Error('FIREBASE_CONFIG_INVALID');
    }
    return Object.freeze({ ...config });
}
const selectedFirebaseConfig = selectFirebaseConfig();
const app = getApps().some(item => item.name === '[DEFAULT]') ? getApp() : initializeApp(selectedFirebaseConfig);
// Reusing an existing default app must not silently reuse another project's SDKs.
if (app.options?.projectId !== selectedFirebaseConfig.projectId) throw new Error('FIREBASE_CONFIG_INVALID');
export const db = getFirestore(app);
export const storage = getStorage(app);
const firebaseAuth = getAuth(app);
export const AUTH_FAILURE_MESSAGE = '로그인을 확인할 수 없습니다. 로그인 정보와 네트워크 상태를 확인해 주세요.';
let authReady;
let verifiedSession = null;
let sessionRequest = null;
let authGeneration = 0;
let signingIn = false;
let loginAttempt = 0;
const sessionListeners = new Set();

function authFailure() { return new Error(AUTH_FAILURE_MESSAGE); }
function invalidateVerifiedSession() {
    verifiedSession = null;
    sessionRequest = null;
    authGeneration++;
    for (const listener of sessionListeners) {
        try { listener(); } catch { /* One UI cleanup must not prevent Firebase signOut. */ }
    }
}
function readyForAuth() {
    if (!authReady) authReady = (async () => {
        await setPersistence(firebaseAuth, browserLocalPersistence);
        await firebaseAuth.authStateReady();
        let observedUid = firebaseAuth.currentUser?.uid || null;
        onAuthStateChanged(firebaseAuth, user => {
            const uid = user?.uid || null;
            if (uid !== observedUid) { observedUid = uid; invalidateVerifiedSession(); }
        });
    })().catch(() => { authReady = null; throw authFailure(); });
    return authReady;
}
export function onVerifiedSessionInvalidated(listener) {
    sessionListeners.add(listener);
    return () => sessionListeners.delete(listener);
}
export function getVerifiedAuthSession(role) {
    if (!verifiedSession || firebaseAuth.currentUser?.uid !== verifiedSession.uid ||
        (role && verifiedSession.role !== role)) return null;
    return verifiedSession;
}
async function authPost(body, idToken, endpoint = '/api/auth') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
            body: JSON.stringify(body), signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error'
        });
        if (!response.ok) throw authFailure();
        return await response.json();
    } catch { throw authFailure(); }
    finally { clearTimeout(timer); }
}
export async function restoreFirebaseSession() {
    await readyForAuth();
    const user = firebaseAuth.currentUser;
    if (!user) return null;
    if (getVerifiedAuthSession()) return verifiedSession;
    if (sessionRequest) return sessionRequest;
    const generation = authGeneration;
    const pending = (async () => {
        try {
            const identity = await authPost({ action: 'session' }, await user.getIdToken());
            if (generation !== authGeneration || firebaseAuth.currentUser !== user || identity.uid !== user.uid ||
                !['driver', 'dispatch', 'master'].includes(identity.role) ||
                !Number.isSafeInteger(identity.credentialVersion) || identity.credentialVersion < 1 ||
                typeof identity.accountRef !== 'string' ||
                !(identity.role === 'master' ? /^(admin|admins)\/[^/]+$/ : /^licenses\/[^/]+$/).test(identity.accountRef)) throw authFailure();
            verifiedSession = Object.freeze({ uid: identity.uid, role: identity.role,
                accountRef: identity.accountRef, credentialVersion: identity.credentialVersion });
            return verifiedSession;
        } catch { throw authFailure(); }
        finally { if (sessionRequest === pending) sessionRequest = null; }
    })();
    sessionRequest = pending;
    return pending;
}
export async function loginWithSecret(secret, expectedRole) {
    if (signingIn) throw authFailure();
    signingIn = true;
    const attempt = ++loginAttempt;
    try {
        await readyForAuth();
        invalidateVerifiedSession();
        const allowedRoles = Array.isArray(expectedRole) ? expectedRole : [expectedRole];
        const masterInput = allowedRoles.includes('master');
        const normalized = typeof secret === 'string' ? (masterInput ? secret : secret.trim()) : '';
        if (masterInput ? normalized.length < 16 || normalized.length > 128 || normalized.trim() !== normalized ||
            /[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalized) : !/^[A-Za-z0-9_-]{24}$/.test(normalized)) throw authFailure();
        const response = await authPost({ secret: normalized });
        if (attempt !== loginAttempt) throw authFailure();
        if (typeof response.customToken !== 'string' || !response.customToken) throw authFailure();
        await signInWithCustomToken(firebaseAuth, response.customToken);
        if (attempt !== loginAttempt) throw authFailure();
        const identity = await restoreFirebaseSession();
        if (!identity || !allowedRoles.includes(identity.role)) throw authFailure();
        return identity;
    } catch {
        invalidateVerifiedSession();
        try { await signOut(firebaseAuth); } catch { /* UI stays locked even if persistence fails. */ }
        throw authFailure();
    } finally { signingIn = false; }
}
export async function signOutFirebaseSession() {
    loginAttempt++;
    invalidateVerifiedSession();
    try { await signOut(firebaseAuth); } catch { throw authFailure(); }
}

export async function requestAuthCredential(input) {
    const identity = getVerifiedAuthSession('master');
    const user = firebaseAuth.currentUser;
    if (!identity || !user) throw authFailure();
    // UI role is only a precondition; the endpoint independently verifies the
    // ID token, revocation, current principal/version and linked admin account.
    const idToken = await user.getIdToken();
    if (getVerifiedAuthSession('master') !== identity || firebaseAuth.currentUser !== user) throw authFailure();
    const result = await authPost(input, idToken, '/api/auth-credentials');
    if (getVerifiedAuthSession('master') !== identity || firebaseAuth.currentUser !== user ||
        typeof result.uid !== 'string' || !/^[0-9a-f-]{36}$/.test(result.uid) ||
        !Number.isSafeInteger(result.credentialVersion) || result.credentialVersion < 1 ||
        typeof result.secret !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(result.secret)) throw authFailure();
    return { uid: result.uid, secret: result.secret, credentialVersion: result.credentialVersion };
}

export async function changeOwnMasterSecret(currentSecret, newSecret) {
    const identity = getVerifiedAuthSession('master');
    const user = firebaseAuth.currentUser;
    if (!identity || !user) throw authFailure();
    const token = await user.getIdToken();
    if (getVerifiedAuthSession('master') !== identity || firebaseAuth.currentUser !== user) throw authFailure();
    const result = await authPost({ action: 'changeOwnSecret', currentSecret, newSecret }, token, '/api/auth-credentials');
    if (getVerifiedAuthSession('master') !== identity || firebaseAuth.currentUser !== user || result.changed !== true ||
        result.credentialVersion !== identity.credentialVersion + 1 ||
        Object.keys(result).some(key => !['changed', 'credentialVersion'].includes(key))) throw authFailure();
    return result;
}

export function subscribeLegacyRoutes(licenseKeys, callback, onError, getRevision) {
    const identity = getVerifiedAuthSession('dispatch');
    if (!identity || !Array.isArray(licenseKeys) || licenseKeys.length < 1 || licenseKeys.length > 30) throw authFailure();
    const keys = [...licenseKeys];
    let stopped = false, timer, pollRequired = true;
    const current = () => !stopped && getVerifiedAuthSession('dispatch') === identity;
    const read = async () => {
        if (!current()) return;
        try {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            const requestRevision = typeof getRevision === 'function' ? getRevision() : undefined;
            const result = await requestLicenseMembership({ action: 'readLegacyRoutes', licenseKeys: keys });
            if (!current()) return;
            if (!Array.isArray(result.routes) || result.routes.some(r => !r || typeof r.id !== 'string' || !r.data || typeof r.data !== 'object')) throw authFailure();
            // Only an explicit, consistent server decision stops this generation.
            // Missing metadata keeps compatibility with older server responses.
            if (result.pollRequired !== undefined && typeof result.pollRequired !== 'boolean') throw authFailure();
            if (result.pollRequired === false && result.routes.length > 0) throw authFailure();
            pollRequired = result.pollRequired !== false;
            callback({ requestRevision, forEach: fn => result.routes.forEach(r => fn({ id: r.id, data: () => r.data })) });
        } catch { pollRequired = true; if (current() && typeof onError === 'function') onError(); }
        finally { if (current() && pollRequired) timer = setTimeout(read, 30000); }
    };
    void read();
    return () => { stopped = true; clearTimeout(timer); };
}

export async function requestLicenseMembership(input) {
    const identity = getVerifiedAuthSession();
    const user = firebaseAuth.currentUser;
    if (!identity || !user) throw authFailure();
    const idToken = await user.getIdToken();
    if (getVerifiedAuthSession() !== identity || firebaseAuth.currentUser !== user) throw authFailure();
    const result = await authPost(input, idToken, '/api/license-membership');
    if (getVerifiedAuthSession() !== identity || firebaseAuth.currentUser !== user) throw authFailure();
    return result;
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
