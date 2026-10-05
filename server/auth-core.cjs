'use strict';

const { randomBytes, randomUUID, createHmac, createHash } = require('node:crypto');
const SECRET_BYTES = 18; // 144 bits => exactly 24 base64url characters, case-sensitive.
const APP_NAME = 'delivery-pro-auth';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOOKUP = /^v1_[0-9a-f]{64}$/;
const BOOTSTRAP_GUARD = 'auth_principals/_bootstrap_master_v1';

class AuthError extends Error {
    constructor(status = 401, code = 'AUTH_FAILED') {
        super(code);
        this.status = status;
        this.code = code;
    }
}
function deny() { throw new AuthError(); }
function normalizeSecret(value) {
    if (typeof value !== 'string' || value.length > 128) deny();
    const normalized = value.trim();
    if (!/^[A-Za-z0-9_-]{24}$/.test(normalized)) deny();
    return normalized;
}
function hmacKey(value) {
    // Configuration contract: independently generated 32-byte key, 64 hex characters.
    if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
        throw new AuthError(503, 'AUTH_UNAVAILABLE');
    }
    return Buffer.from(value, 'hex');
}
function lookupId(secret, key) {
    return 'v1_' + createHmac('sha256', hmacKey(key)).update(normalizeSecret(secret), 'utf8').digest('hex');
}
function generateSecret() { return randomBytes(SECRET_BYTES).toString('base64url'); }
function normalizePhone(value) {
    if (typeof value !== 'string' || value.length > 32 || !/^[0-9+() -]+$/.test(value)) deny();
    const digits = value.replace(/\D/g, '');
    if (!/^\d{9,13}$/.test(digits)) deny();
    return digits;
}
function validateLicenseLoginKey(value) {
    if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
        throw new AuthError(400, 'INVALID_LICENSE_KEY');
    }
    return value;
}
function driverLicenseLookupId(value, key) {
    return 'v1_' + createHmac('sha256', hmacKey(key)).update('driver-license-v1\0' + validateLicenseLoginKey(value), 'utf8').digest('hex');
}
function currentLicenseLoginKey(license, accountRef) {
    return Object.hasOwn(license, 'loginKey') ? license.loginKey : license.key ?? accountRef.slice('licenses/'.length);
}
function validateMasterSecret(value) {
    if (typeof value !== 'string' || value.length < 8 || value.length > 64 ||
        value.trim() !== value || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
        throw new AuthError(400, 'INVALID_SECRET');
    }
    return value;
}
function masterLookupId(secret, key) {
    return 'v1_' + createHmac('sha256', hmacKey(key)).update(validateMasterSecret(secret), 'utf8').digest('hex');
}
function version(value) { return Number.isSafeInteger(value) && value > 0; }
function accountPath(role, path) {
    const collections = role === 'master' ? ['admin', 'admins'] :
        ['driver', 'dispatch'].includes(role) ? ['licenses'] : [];
    if (typeof path !== 'string') deny();
    const parts = path.split('/');
    if (parts.length !== 2 || !collections.includes(parts[0]) || !parts[1] ||
        ['.', '..'].includes(parts[1]) || Buffer.byteLength(parts[1], 'utf8') > 1500) deny();
    return path;
}
function bindingPath(path) {
    // A reserved metadata document, not a login principal. One UID per business
    // account, including concurrent first issuance. No new public collection.
    if (typeof path !== 'string' || !/^(licenses|admin|admins)\/[^/]+$/.test(path)) deny();
    accountPath(path.startsWith('licenses/') ? 'driver' : 'master', path);
    return 'auth_principals/_account_v1_' + createHash('sha256').update(path).digest('hex');
}
function expiryEnd(value) {
    // Existing YYYY.MM.DD dates expire at the end of that calendar day in Korea.
    if (typeof value !== 'string' || !/^\d{4}([.-])\d{2}\1\d{2}$/.test(value)) deny();
    const [y, m, d] = value.split(/[.-]/).map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) deny();
    return date.getTime() + 86400000 - 9 * 3600000;
}
function licenseMode(data) {
    if (!Object.hasOwn(data, 'securityVersion')) return 'legacy';
    if (data.securityVersion === 1) return 'managed';
    throw new AuthError(409, 'UNKNOWN_SECURITY_VERSION');
}
function validateAccount(role, data, now) {
    if (!data) deny();
    if (role === 'master') {
        if (data.enabled === false || (data.status !== undefined && data.status !== 'active')) deny();
        if (data.expireDate !== undefined && now >= expiryEnd(data.expireDate)) deny();
        return;
    }
    licenseMode(data);
    if (data.status !== 'active' || now >= expiryEnd(data.expireDate)) deny();
    if (role === 'dispatch' && data.type !== 'dispatch') deny();
    // Explicit compatibility for existing legacy driver documents without type.
    if (role === 'driver' && data.type !== undefined && !['regular', 'trial'].includes(data.type)) deny();
}
function principalData(snapshot, ready = true) {
    if (!snapshot.exists) deny();
    const p = snapshot.data();
    accountPath(p.role, p.accountRef);
    if (p.enabled !== true || !version(p.credentialVersion) || !LOOKUP.test(p.lookupId) ||
        (ready && p.credentialReady !== true)) deny();
    return p;
}

function validateProjectEnvironment(env) {
    // Deployment/operator configuration only. Preview must explicitly opt into
    // test mode; local bootstrap/recovery use the same two non-secret selectors.
    const mode = env.AUTH_ENV === undefined ? 'production' : env.AUTH_ENV;
    const project = env.FIREBASE_PROJECT_ID;
    if (!['production', 'test'].includes(mode) || typeof project !== 'string' || !project.trim()) {
        throw new AuthError(503, 'AUTH_UNAVAILABLE');
    }
    if (env.VERCEL_ENV === 'preview' && mode !== 'test') throw new AuthError(503, 'AUTH_UNAVAILABLE');
    if (mode === 'test') {
        const allowed = env.AUTH_TEST_PROJECT_ID;
        if (env.VERCEL_ENV === 'production' || typeof allowed !== 'string' ||
            !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(allowed) ||
            allowed === 'delivery-pro-dd272' || project === 'delivery-pro-dd272' || project !== allowed) {
            throw new AuthError(503, 'AUTH_UNAVAILABLE');
        }
    } else if (env.AUTH_TEST_PROJECT_ID !== undefined) {
        // A partially configured test environment must never become production.
        throw new AuthError(503, 'AUTH_UNAVAILABLE');
    }
}

function logAuthDiagnostic(stage, flags = {}, error, failureStage) {
    // Initialization failures only; never log requests, credentials or SDK messages.
    // Keep the diagnostic call signature for existing service callers.
    try {
        if (stage !== 'core_init_failed' || !error) return;
        const stages = ['project_environment_check', 'hmac_validation', 'required_env_check',
            'admin_require', 'existing_app_project_check', 'certificate_parse',
            'initialize_app', 'firestore_service', 'auth_service'];
        const codes = ['AUTH_UNAVAILABLE', 'app/invalid-credential', 'app/invalid-app-options',
            'app/duplicate-app', 'app/no-app', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED',
            'ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE', 'ERR_INVALID_ARG_TYPE', 'ERR_OSSL_UNSUPPORTED'];
        console.log(JSON.stringify({ failureStage: stages.includes(failureStage) ? failureStage : 'unknown',
            errorCode: codes.includes(error.code) ? error.code : 'OTHER_ERROR' }));
    } catch { /* Logging is best effort; never print the caught error. */ }
}

function getServices(env = process.env, sdk, diagnostics = false) {
    let stage = 'core_init_start';
    try {
        stage = 'project_environment_check';
        validateProjectEnvironment(env); // Before SDK loading, credential parsing or initialization.
        stage = 'hmac_validation';
        hmacKey(env.AUTH_LOOKUP_HMAC_KEY);
        stage = 'required_env_check';
        for (const key of ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']) {
            if (typeof env[key] !== 'string' || !env[key].trim()) throw new AuthError(503, 'AUTH_UNAVAILABLE');
        }
        // Deliberately no ADC/OCR credential fallback. No network calls on module import.
        stage = 'admin_require';
        let modules = sdk;
        if (!modules) {
            const appModule = require('firebase-admin/app');
            const authModule = require('firebase-admin/auth');
            const firestoreModule = require('firebase-admin/firestore');
            modules = { ...appModule, ...authModule, ...firestoreModule };
        }
        stage = 'existing_app_project_check';
        let app = modules.getApps().find(item => item.name === APP_NAME);
        if (app && app.options.projectId !== env.FIREBASE_PROJECT_ID) throw new AuthError(503, 'AUTH_UNAVAILABLE');
        if (!app) {
            stage = 'certificate_parse';
            const credential = modules.cert({ projectId: env.FIREBASE_PROJECT_ID,
                clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') });
            stage = 'initialize_app';
            app = modules.initializeApp({ projectId: env.FIREBASE_PROJECT_ID, credential }, APP_NAME);
        }
        stage = 'firestore_service';
        const db = modules.getFirestore(app);
        stage = 'auth_service';
        const auth = modules.getAuth(app);
        return { db, auth, key: env.AUTH_LOOKUP_HMAC_KEY };
    } catch (error) {
        if (diagnostics === true) logAuthDiagnostic('core_init_failed', {}, error, stage);
        throw error;
    }
}

function createAuthCore({ db, auth, key, now = Date.now }, membershipOnly = false) {
    hmacKey(key);
    const pRef = uid => {
        if (typeof uid !== 'string' || !UUID.test(uid)) deny();
        return db.doc('auth_principals/' + uid);
    };
    const lRef = id => db.doc('auth_secret_lookups/' + id);
    async function checkAccount(reader, p) {
        const snapshot = await reader.get(db.doc(accountPath(p.role, p.accountRef)));
        validateAccount(p.role, snapshot.exists ? snapshot.data() : null, now());
        return snapshot.data();
    }
    async function master(reader, actor) {
        const p = principalData(await reader.get(pRef(actor.uid)));
        if (p.role !== 'master' || actor.credentialVersion !== p.credentialVersion) deny();
        await checkAccount(reader, p);
        return p;
    }
    async function verifyMaster(idToken) {
        if (typeof idToken !== 'string' || !idToken || idToken.length > 16384) deny();
        let actor;
        try { actor = await auth.verifyIdToken(idToken, true); } catch { deny(); }
        await db.runTransaction(tx => master(tx, actor));
        return actor;
    }
    async function session(idToken, deviceId) {
        if (typeof idToken !== 'string' || !idToken || idToken.length > 16384) deny();
        let actor;
        try { actor = await auth.verifyIdToken(idToken, true); } catch { deny(); }
        return db.runTransaction(async tx => {
            const p = principalData(await tx.get(pRef(actor.uid)));
            if (actor.credentialVersion !== p.credentialVersion) deny();
            const license = await checkAccount(tx, p);
            if (deviceId !== undefined && (p.role !== 'driver' || typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId) || license.deviceId !== deviceId)) deny();
            if (p.role === 'driver' && actor.deviceId !== undefined && actor.deviceId !== license.deviceId) deny();
            return { uid: actor.uid, role: p.role, accountRef: p.accountRef,
                credentialVersion: p.credentialVersion };
        });
    }
    async function inspectOwnMaster(idToken) {
        if (typeof idToken !== 'string' || !idToken || idToken.length > 16384) deny();
        let actor;
        try { actor = await auth.verifyIdToken(idToken, true); } catch { deny(); }
        return db.runTransaction(async tx => {
            const snapshot = await tx.get(pRef(actor.uid));
            if (!snapshot.exists) deny();
            const p = snapshot.data();
            if (p.role !== 'master' || !version(p.credentialVersion) || actor.credentialVersion !== p.credentialVersion) deny();
            accountPath('master', p.accountRef);
            const account = await tx.get(db.doc(p.accountRef));
            const binding = await tx.get(db.doc(bindingPath(p.accountRef)));
            const lookup = LOOKUP.test(p.lookupId) ? await tx.get(lRef(p.lookupId)) : null;
            let accountUsable = true;
            try { validateAccount('master', account.exists ? account.data() : null, now()); }
            catch (error) { if (!(error instanceof AuthError)) throw error; accountUsable = false; }
            return { accountRef: p.accountRef, role: 'master', enabled: p.enabled === true,
                credentialReady: p.credentialReady === true, credentialVersion: p.credentialVersion,
                authenticationLinked: accountUsable && p.enabled === true && p.credentialReady === true &&
                    p.credentialOperation == null && binding.exists && binding.data().kind === 'account_binding' &&
                    binding.data().uid === actor.uid && !!lookup?.exists && lookup.data().uid === actor.uid &&
                    lookup.data().credentialVersion === p.credentialVersion };
        });
    }
    async function login(secret) {
        let id;
        try { id = masterLookupId(secret, key); }
        catch (error) {
            if (error.code !== 'INVALID_SECRET') throw error;
            id = lookupId(secret, key); // Retain legacy driver/dispatch input handling.
        }
        const identity = await db.runTransaction(async tx => {
            const snap = await tx.get(lRef(id));
            if (!snap.exists) deny();
            const lookup = snap.data();
            const p = principalData(await tx.get(pRef(lookup.uid)));
            if (p.role === 'master') {
                try { validateMasterSecret(secret); } catch { deny(); }
            } else if (lookupId(secret, key) !== id) deny();
            if (p.lookupId !== id || lookup.credentialVersion !== p.credentialVersion) deny();
            await checkAccount(tx, p);
            return { uid: lookup.uid, credentialVersion: p.credentialVersion };
        });
        // No role/product/company claims copied from writable legacy license documents.
        const customToken = await auth.createCustomToken(identity.uid, { credentialVersion: identity.credentialVersion });
        // Reject rotations/disables that happened while signing; already issued tokens still
        // require version-aware authorization in later stages (Custom Tokens cannot be recalled).
        const current = principalData(await db.getAll(pRef(identity.uid)).then(items => items[0]));
        if (current.lookupId !== id || current.credentialVersion !== identity.credentialVersion) deny();
        return { customToken };
    }
    // Reuse the existing private principal/lookup/binding format. Never replace
    // an existing identity or attempt to repair an inconsistent link at login.
    async function prepareDriverPrincipal(tx, accountRef) {
        const bindingRef = db.doc(bindingPath(accountRef));
        const binding = await tx.get(bindingRef);
        const matches = await tx.get(db.collection('auth_principals').where('accountRef', '==', accountRef));
        const principals = matches.docs.filter(s => s.data().kind !== 'trial_registration');
        if (binding.exists || principals.length) {
            const b = binding.exists ? binding.data() : null;
            if (!b || b.kind !== 'account_binding' || !UUID.test(b.uid) || principals.length !== 1 || principals[0].id !== b.uid) deny();
            const p = principalData(principals[0]);
            if (p.role !== 'driver' || p.accountRef !== accountRef || p.credentialOperation != null) deny();
            const lookup = await tx.get(lRef(p.lookupId));
            if (!lookup.exists || lookup.data().uid !== b.uid || lookup.data().credentialVersion !== p.credentialVersion) deny();
            return { uid: b.uid, p, created: false, write() {} };
        }
        const uid = randomUUID(), id = lookupId(generateSecret(), key), timestamp = now();
        const principal = pRef(uid), lookup = lRef(id);
        if ((await tx.get(principal)).exists || (await tx.get(lookup)).exists) deny();
        const p = { role: 'driver', accountRef, enabled: true, credentialVersion: 1,
            credentialReady: true, lookupId: id, createdAt: timestamp, updatedAt: timestamp };
        return { uid, p, created: true, write() {
            tx.create(principal, p); tx.create(lookup, { uid, credentialVersion: 1 });
            tx.create(bindingRef, { kind: 'account_binding', uid });
        } };
    }
    async function prepareOwnRouteOwner(tx, accountRef, license) {
        if (typeof license.routeOwnerId === 'string' && license.routeOwnerId.trim()) {
            return { routeOwnerId: license.routeOwnerId, write() {} };
        }
        const conflict = () => { throw new AuthError(409, 'OWNER_REPAIR_CONFLICT'); };
        if (licenseMode(license) !== 'legacy' || ![undefined, ''].includes(license.routeOwnerId)) conflict();
        const id = accountRef.slice('licenses/'.length), company = license.dispatchKey || '';
        const identified = await tx.get(db.collection('routes').where('licenseKey', '==', id).limit(301));
        if (identified.docs.length > 300) conflict();
        const routes = new Map(identified.docs.map(s => [s.id, s.data()]));
        for (const device of new Set([id, license.deviceId].filter(v => typeof v === 'string' && v && !v.includes('/')))) {
            const snapshot = await tx.get(db.doc('routes/' + device));
            if (!snapshot.exists) continue;
            const links = await tx.get(db.collection('licenses').where('deviceId', '==', device).limit(301));
            if (links.docs.some(s => s.id !== id)) conflict();
            routes.set(device, snapshot.data());
        }
        const owners = new Set();
        for (const r of routes.values()) {
            if ((r.licenseKey !== undefined && r.licenseKey !== id) ||
                (r.dispatchKey !== undefined && r.dispatchKey !== company)) conflict();
            if (r.routeOwnerId !== undefined && r.routeOwnerId !== '' &&
                (typeof r.routeOwnerId !== 'string' || !r.routeOwnerId.trim())) conflict();
            if (r.routeOwnerId) owners.add(r.routeOwnerId);
        }
        // Completed/history records can retain the owner after active routes vanish.
        // Read their explicit account link only; never rewrite historical payloads.
        for (const collection of ['completions', 'history']) {
            const rows = await tx.get(db.collection(collection).where('licenseKey', '==', id).limit(301));
            if (rows.docs.length > 300) conflict();
            for (const s of rows.docs) {
                const r = s.data();
                if (r.routeOwnerId !== undefined && r.routeOwnerId !== '' &&
                    (typeof r.routeOwnerId !== 'string' || !r.routeOwnerId.trim())) conflict();
                if (r.routeOwnerId) owners.add(r.routeOwnerId);
            }
        }
        if (owners.size > 1) conflict();
        const routeOwnerId = owners.size ? [...owners][0] : randomUUID();
        const linked = await tx.get(db.collection('licenses').where('routeOwnerId', '==', routeOwnerId).limit(301));
        if (linked.docs.some(s => s.id !== id)) conflict();
        const historical = await tx.get(db.collection('routes').where('routeOwnerId', '==', routeOwnerId).limit(301));
        if (historical.docs.length > 300) conflict();
        for (const s of historical.docs) {
            const r = s.data();
            // Owner alone cannot authorize an otherwise unidentified historical route.
            if (!routes.has(s.id) && r.licenseKey !== id) conflict();
            if ((r.licenseKey !== undefined && r.licenseKey !== id) ||
                (r.dispatchKey !== undefined && r.dispatchKey !== company)) conflict();
        }
        return { routeOwnerId, write() {
            tx.update(db.doc(accountRef), { routeOwnerId });
            for (const [routeId, r] of routes) if (!r.routeOwnerId) {
                tx.update(db.doc('routes/' + routeId), { routeOwnerId });
            }
        } };
    }
    async function driverLogin(input) {
        if (!input || Object.keys(input).some(f => !['action', 'licenseKey', 'phone', 'deviceId'].includes(f)) ||
            input.action !== 'driverLogin' || typeof input.licenseKey !== 'string' || !input.licenseKey ||
            input.licenseKey !== input.licenseKey.trim() || typeof input.deviceId !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(input.deviceId)) deny();
        const loginKey = validateLicenseLoginKey(input.licenseKey), loginId = driverLicenseLookupId(loginKey, key), phone = normalizePhone(input.phone);
        const identity = await db.runTransaction(async tx => {
            const loginLookup = await tx.get(lRef(loginId));
            let accountRef;
            if (loginLookup.exists) {
                const mapping = loginLookup.data(), p = principalData(await tx.get(pRef(mapping.uid)));
                if (mapping.kind !== 'driver_license' || p.role !== 'driver' || p.lookupId !== loginId || mapping.credentialVersion !== p.credentialVersion) deny();
                accountRef = p.accountRef;
            } else accountRef = accountPath('driver', 'licenses/' + loginKey);
            const ref = db.doc(accountRef), snapshot = await tx.get(ref);
            const license = snapshot.exists ? snapshot.data() : null;
            validateAccount('driver', license, now());
            if (currentLicenseLoginKey(license, accountRef) !== loginKey || (!loginLookup.exists && Object.hasOwn(license, 'loginKey')) ||
                (await tx.get(db.doc('blocked_devices/' + input.deviceId))).exists) deny();
            // Remembered history is server-written; mutable active deviceId must
            // not override it and bypass the cooldown after a client-side clear.
            const previousDevice = license.lastDeviceId || license.deviceId || '';
            const changedDevice = Boolean(previousDevice && previousDevice !== input.deviceId);
            const changedAt = license.lastDeviceChangeAt === 0 ? undefined : license.lastDeviceChangeAt;
            if ((license.lastDeviceId !== undefined && (typeof license.lastDeviceId !== 'string' ||
                (license.lastDeviceId && !/^[A-Za-z0-9_-]{1,128}$/.test(license.lastDeviceId)))) ||
                (changedAt !== undefined && (!Number.isSafeInteger(changedAt) || changedAt < 0))) {
                throw new AuthError(409, 'DEVICE_CHANGE_STATE_INVALID');
            }
            const timestamp = now();
            if (changedDevice && changedAt !== undefined && timestamp - changedAt < 24 * 60 * 60 * 1000) {
                throw new AuthError(409, 'DEVICE_CHANGE_LIMIT');
            }
            // A cooldown timestamp without any remembered device cannot safely
            // distinguish a same-device return from logout-based evasion.
            if (!previousDevice && changedAt !== undefined) throw new AuthError(409, 'DEVICE_CHANGE_STATE_INVALID');
            const prepared = await prepareDriverPrincipal(tx, accountRef);
            const owner = await prepareOwnRouteOwner(tx, accountRef, license);
            owner.write();
            prepared.write();
            // The license is the account. Telephone is current-driver information,
            // not an ownership credential. A different driver on the same device
            // must still invalidate the preceding session using the existing version.
            const phoneChanged = String(license.phone || '').replace(/\D/g, '') !== phone;
            const currentPhone = phoneChanged ? input.phone.trim() : license.phone;
            const switching = !prepared.created && (license.deviceId !== input.deviceId || phoneChanged);
            if (switching) {
                if (prepared.p.credentialVersion >= Number.MAX_SAFE_INTEGER) deny();
                prepared.p.credentialVersion++;
                tx.update(pRef(prepared.uid), { credentialVersion: prepared.p.credentialVersion, updatedAt: now() });
                tx.update(lRef(prepared.p.lookupId), { credentialVersion: prepared.p.credentialVersion });
            }
            const deviceChanges = {};
            if (license.deviceId !== input.deviceId || phoneChanged) Object.assign(deviceChanges, { deviceId: input.deviceId, phone: currentPhone });
            if (license.lastDeviceId !== input.deviceId || changedDevice) Object.assign(deviceChanges, { lastDeviceId: input.deviceId,
                ...(changedDevice ? { lastDeviceChangeAt: timestamp } : {}) });
            if (Object.keys(deviceChanges).length) tx.update(ref, deviceChanges);
            return { uid: prepared.uid, accountRef, credentialVersion: prepared.p.credentialVersion, lookupId: prepared.p.lookupId };
        });
        const accountRef = identity.accountRef;
        const customToken = await auth.createCustomToken(identity.uid, { credentialVersion: identity.credentialVersion, deviceId: input.deviceId });
        // Recheck device, account and identity after signing, just as secret
        // login rechecks its version. No business identifiers are changed.
        await db.runTransaction(async tx => {
            const p = principalData(await tx.get(pRef(identity.uid)));
            const license = await checkAccount(tx, p);
            const binding = await tx.get(db.doc(bindingPath(accountRef))), lookup = await tx.get(lRef(p.lookupId));
            if (p.role !== 'driver' || p.accountRef !== accountRef || p.lookupId !== identity.lookupId ||
                p.credentialVersion !== identity.credentialVersion || p.credentialOperation != null ||
                currentLicenseLoginKey(license, accountRef) !== loginKey ||
                license.deviceId !== input.deviceId ||
                !binding.exists || binding.data().kind !== 'account_binding' || binding.data().uid !== identity.uid ||
                !lookup.exists || lookup.data().uid !== identity.uid || lookup.data().credentialVersion !== identity.credentialVersion ||
                (await tx.get(db.doc('blocked_devices/' + input.deviceId))).exists) deny();
        });
        return { customToken, accountRef };
    }
    async function credentials(actor, input) {
        if (!input || !['issue', 'rotate', 'changeOwnSecret'].includes(input.action)) throw new AuthError(400, 'INVALID_REQUEST');
        const ownChange = input.action === 'changeOwnSecret';
        if (ownChange && Object.keys(input).some(field => !['action', 'currentSecret', 'newSecret'].includes(field))) {
            throw new AuthError(400, 'INVALID_REQUEST');
        }
        const issuing = input.action === 'issue';
        // A target role never grants requester authority; master() is checked in
        // the same transaction for every issuance, including another master.
        if (issuing && !['driver', 'dispatch', 'master'].includes(input.role)) deny();
        let uid = ownChange ? actor.uid : issuing ? randomUUID() : input.uid;
        const operation = randomUUID();
        const secret = ownChange ? validateMasterSecret(input.newSecret) : generateSecret();
        const nextId = ownChange ? masterLookupId(secret, key) : lookupId(secret, key);
        const changed = await db.runTransaction(async tx => {
            await master(tx, actor); // Recheck protected authority inside mutation transaction.
            let bindingRef;
            if (input.accountRef !== undefined) {
                bindingRef = db.doc(bindingPath(input.accountRef));
                const binding = await tx.get(bindingRef);
                if (issuing && binding.exists) throw new AuthError(409, 'CREDENTIAL_EXISTS');
                if (!issuing) {
                    if (!binding.exists || binding.data().kind !== 'account_binding') deny();
                    uid = binding.data().uid;
                }
            }
            const ref = pRef(uid);
            const existing = await tx.get(ref);
            let p;
            if (issuing) {
                if (existing.exists) throw new AuthError(409, 'CREDENTIAL_CONFLICT');
                p = { role: input.role, accountRef: accountPath(input.role, input.accountRef),
                    enabled: true, credentialVersion: 0, createdAt: now() };
            } else {
                p = principalData(existing, false); // Non-master retries retain existing behavior.
                // Master failures require explicit local recovery after the previous
                // process has stopped. Never expire or silently steal this lock.
                if (p.role === 'master' && (p.credentialReady !== true || p.credentialOperation != null)) {
                    throw new AuthError(409, 'CREDENTIAL_BUSY');
                }
                if (input.accountRef !== undefined && p.accountRef !== input.accountRef) deny();
                if (!bindingRef) {
                    bindingRef = db.doc(bindingPath(p.accountRef));
                    const binding = await tx.get(bindingRef);
                    if (!binding.exists || binding.data().kind !== 'account_binding' || binding.data().uid !== uid) deny();
                }
                if (p.credentialVersion === Number.MAX_SAFE_INTEGER) deny();
                const old = await tx.get(lRef(p.lookupId));
                if (!old.exists || old.data().uid !== uid || old.data().credentialVersion !== p.credentialVersion) deny();
                if (ownChange) {
                    let currentId;
                    try { currentId = masterLookupId(input.currentSecret, key); } catch { deny(); }
                    if (uid !== actor.uid || p.role !== 'master' || currentId !== p.lookupId) deny();
                    if (nextId === p.lookupId) throw new AuthError(400, 'SECRET_UNCHANGED');
                }
            }
            const linkedAccount = await checkAccount(tx, p);
            if (p.role === 'driver' && Object.hasOwn(linkedAccount, 'loginKey')) throw new AuthError(409, 'LICENSE_KEY_MANAGED');
            if ((await tx.get(lRef(nextId))).exists) throw new AuthError(409, 'CREDENTIAL_CONFLICT');
            const next = { ...p, lookupId: nextId, credentialVersion: p.credentialVersion + 1,
                credentialReady: issuing, updatedAt: now() };
            if (!issuing && p.role === 'master') next.credentialOperation = operation;
            if (!issuing) tx.delete(lRef(p.lookupId));
            else tx.create(bindingRef, { kind: 'account_binding', uid });
            tx.create(lRef(nextId), { uid, credentialVersion: next.credentialVersion });
            tx.set(ref, next);
            return next;
        }).catch(error => {
            // Logical transaction rejection proves no write committed; transport
            // failures do not prove that a commit failed.
            if (ownChange && error instanceof AuthError) error.changeOutcome = 'notChanged';
            throw error;
        });
        if (!issuing) {
            const ref = pRef(uid);
            // Firestore and Firebase Auth have no cross-service transaction. Keep the
            // credential unavailable until revocation AND finalization both succeed.
            try { await auth.revokeRefreshTokens(uid); }
            catch (error) {
                // A never-signed-in Custom Token user may not exist in Firebase Auth yet.
                if (error?.code !== 'auth/user-not-found') throw new AuthError(503, 'AUTH_UNAVAILABLE');
            }
            await db.runTransaction(async tx => {
                // Supports master self-rotation: authorization was checked before disabling
                // its credential. Only this exact generated version may be finalized here.
                if (actor.uid !== uid) await master(tx, actor);
                const p = principalData(await tx.get(ref), false);
                if (p.lookupId !== nextId || p.credentialVersion !== changed.credentialVersion || p.credentialReady !== false) deny();
                if (changed.role === 'master' && (p.role !== 'master' || p.credentialOperation !== operation)) deny();
                await checkAccount(tx, p);
                tx.update(ref, { credentialReady: true, updatedAt: now(),
                    ...(changed.role === 'master' ? { credentialOperation: null } : {}) });
            });
        }
        return ownChange ? { changed: true, credentialVersion: changed.credentialVersion } :
            { uid, secret, credentialVersion: changed.credentialVersion };
    }
    async function startTrial(input) {
        if (!input || Object.keys(input).some(field => !['action', 'phone', 'deviceId'].includes(field)) ||
            input.action !== 'startTrial' || typeof input.phone !== 'string' || input.phone.length > 32 ||
            !/^[0-9+() -]+$/.test(input.phone) || !/^\d{9,13}$/.test(input.phone.replace(/\D/g, '')) ||
            typeof input.deviceId !== 'string' || !/^DEV-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/.test(input.deviceId)) {
            throw new AuthError(400, 'INVALID_REQUEST');
        }
        const { deviceId } = input;
        const timestamp = now();
        const expireDate = new Date(timestamp + 7 * 86400000 + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '.');
        const uid = randomUUID();
        const licenseKey = 'TRIAL-' + randomBytes(16).toString('hex');
        const accountRef = 'licenses/' + licenseKey;
        const secret = generateSecret();
        const id = lookupId(secret, key);
        // Private registration marker serializes this device's new requests. It
        // never grants login/recovery authority and is unrelated to driver slots.
        const marker = db.doc('auth_principals/_trial_device_v1_' + createHash('sha256').update(deviceId).digest('hex'));
        const license = db.doc(accountRef);
        const principal = pRef(uid);
        const lookup = lRef(id);
        const binding = db.doc(bindingPath(accountRef));
        await db.runTransaction(async tx => {
            if ((await tx.get(db.doc('blocked_devices/' + deviceId))).exists) deny();
            if ((await tx.get(marker)).exists) throw new AuthError(409, 'TRIAL_EXISTS');
            // One equality filter needs no new composite index. Includes legacy
            // trial documents created before registration markers existed.
            const previous = await tx.get(db.collection('licenses').where('deviceId', '==', deviceId));
            if (previous.docs.some(doc => doc.data().type === 'trial' || doc.data().isTrial === true || doc.id.startsWith('TRIAL-'))) {
                throw new AuthError(409, 'TRIAL_EXISTS');
            }
            for (const ref of [license, principal, lookup, binding]) {
                if ((await tx.get(ref)).exists) throw new AuthError(409, 'CREDENTIAL_CONFLICT');
            }
            tx.create(license, { key: licenseKey, type: 'trial', securityVersion: 1, status: 'active', expireDate,
                phone: input.phone.trim(), deviceId, routeOwnerId: randomUUID(), dispatchKey: '', allowTms: true, createdAt: timestamp });
            tx.create(principal, { role: 'driver', accountRef, enabled: true, credentialVersion: 1,
                credentialReady: true, lookupId: id, createdAt: timestamp, updatedAt: timestamp });
            tx.create(lookup, { uid, credentialVersion: 1 });
            tx.create(binding, { kind: 'account_binding', uid });
            tx.create(marker, { kind: 'trial_registration', accountRef });
        });
        // Returned once, only after commit; never recover it using phone/deviceId.
        return { secret, accountRef };
    }
    async function membership(idToken, input) {
        const fields = { checkDevice: ['action', 'deviceId'], lookup: ['action', 'licenseKey'], link: ['action', 'licenseKey', 'dispatchKey'],
            releaseDevice: ['action', 'deviceId'], readOwnParkingMemos: ['action'], ensureOwnRouteOwner: ['action'],
            unlink: ['action', 'licenseKey'], setTmsPermission: ['action', 'allowed'],
            createLicense: ['action', 'type', 'keyword', 'count', 'expireDate', 'phones'],
            changeLicenseKey: ['action', 'licenseKey', 'newKey', 'expectedKey'],
            adoptLicense: ['action', 'licenseKey'], suspendLicense: ['action', 'licenseKey'],
            updateLicense: ['action', 'licenseKey', 'changes'],
            readLegacyRoutes: ['action', 'licenseKeys'],
            repairRouteOwner: ['action', 'licenseKey', 'routeOwnerId', 'confirmNewOwner'] };
        if (!input || !Object.hasOwn(fields, input.action) || Object.keys(input).some(k => !fields[input.action].includes(k))) throw new AuthError(400, 'INVALID_REQUEST');
        if (typeof idToken !== 'string' || !idToken || idToken.length > 16384) deny();
        let actor;
        try { actor = await auth.verifyIdToken(idToken, true); } catch { deny(); }
        return db.runTransaction(async tx => {
            const p = principalData(await tx.get(pRef(actor.uid)));
            if (actor.credentialVersion !== p.credentialVersion || !['master', 'dispatch', 'driver'].includes(p.role)) deny();
            const actorAccount = await checkAccount(tx, p);
            if (p.role === 'driver' && actor.deviceId !== undefined && actor.deviceId !== actorAccount.deviceId) deny();
            if (input.action === 'ensureOwnRouteOwner') {
                if (p.role !== 'driver') deny();
                const owner = await prepareOwnRouteOwner(tx, p.accountRef, actorAccount);
                owner.write();
                return { routeOwnerId: owner.routeOwnerId };
            }
            if (input.action === 'readOwnParkingMemos') {
                if (p.role !== 'driver' || typeof actorAccount.routeOwnerId !== 'string' || !actorAccount.routeOwnerId.trim()) deny();
                const company = actorAccount.dispatchKey || '';
                const ownId = p.accountRef.slice('licenses/'.length), owner = actorAccount.routeOwnerId;
                const related = await tx.get(db.collection('licenses').where('routeOwnerId', '==', owner).limit(301));
                if (related.docs.length > 300) throw new AuthError(409, 'MEMO_READ_LIMIT');
                const members = new Set([ownId]), devices = new Set();
                for (const s of related.docs) {
                    const l = s.data();
                    if (!['regular', 'trial'].includes(l.type || 'regular') || (l.dispatchKey || '') !== company) {
                        throw new AuthError(409, 'MEMO_OWNERSHIP_CONFLICT');
                    }
                    members.add(s.id);
                    if (typeof l.deviceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(l.deviceId)) devices.add(l.deviceId);
                }
                const historical = await tx.get(db.collection('routes').where('routeOwnerId', '==', owner).limit(301));
                if (historical.docs.length > 300 || members.size > 30) throw new AuthError(409, 'MEMO_READ_LIMIT');
                for (const s of historical.docs) {
                    const r = s.data();
                    if ((r.licenseKey !== undefined && !members.has(r.licenseKey)) ||
                        (r.dispatchKey !== undefined && r.dispatchKey !== company)) continue;
                    if (typeof r.deviceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(r.deviceId)) devices.add(r.deviceId);
                }
                if (devices.size > 60) throw new AuthError(409, 'MEMO_READ_LIMIT');
                const addresses = new Set();
                const accept = (r, deviceOwned = false) => {
                    if (typeof r.address !== 'string' || !r.address || r.address.length > 4096 ||
                        (r.dispatchKey !== undefined && r.dispatchKey !== company) ||
                        (r.licenseKey !== undefined && !members.has(r.licenseKey)) ||
                        (r.routeOwnerId !== undefined && r.routeOwnerId !== owner)) return;
                    if (deviceOwned || r.routeOwnerId === owner || members.has(r.licenseKey)) addresses.add(r.address);
                };
                const readMemos = async (field, value, deviceOwned = false) => {
                    const rows = await tx.get(db.collection('memos').where(field, '==', value).limit(1001));
                    if (rows.docs.length > 1000) throw new AuthError(409, 'MEMO_READ_LIMIT');
                    for (const s of rows.docs) accept(s.data(), deviceOwned);
                    if (addresses.size > 3000) throw new AuthError(409, 'MEMO_READ_LIMIT');
                };
                for (const device of devices) {
                    const links = await tx.get(db.collection('licenses').where('deviceId', '==', device).limit(301));
                    if (links.docs.length > 300 || links.docs.some(s => !members.has(s.id))) continue;
                    const deviceRoutes = await tx.get(db.collection('routes').where('deviceId', '==', device).limit(301));
                    if (deviceRoutes.docs.length > 300 || deviceRoutes.docs.some(s => {
                        const r = s.data();
                        return (r.licenseKey !== undefined && !members.has(r.licenseKey)) ||
                            (r.routeOwnerId !== undefined && r.routeOwnerId !== owner) ||
                            (r.dispatchKey !== undefined && r.dispatchKey !== company);
                    })) continue;
                    await readMemos('deviceId', device, true);
                }
                await readMemos('routeOwnerId', owner);
                for (const id of members) await readMemos('licenseKey', id);
                // Telephone-only records provide no proof of ownership. Return addresses only.
                return { addresses: [...addresses] };
            }
            if (input.action === 'releaseDevice') {
                if (p.role !== 'driver' || typeof input.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.deviceId) ||
                    actorAccount.deviceId !== input.deviceId || p.credentialVersion >= Number.MAX_SAFE_INTEGER) deny();
                const lookup = await tx.get(lRef(p.lookupId));
                if (!lookup.exists || lookup.data().uid !== actor.uid || lookup.data().credentialVersion !== p.credentialVersion) deny();
                const nextVersion = p.credentialVersion + 1;
                tx.update(pRef(actor.uid), { credentialVersion: nextVersion, updatedAt: now() });
                tx.update(lRef(p.lookupId), { credentialVersion: nextVersion });
                tx.update(db.doc(p.accountRef), { deviceId: '', phone: '', lastDeviceId: actorAccount.deviceId });
                return { released: true };
            }
            if (input.action === 'changeLicenseKey') {
                if (p.role !== 'master') deny();
                if (typeof input.licenseKey !== 'string' || !input.licenseKey || input.licenseKey !== input.licenseKey.trim()) throw new AuthError(400, 'INVALID_REQUEST');
                const newKey = validateLicenseLoginKey(input.newKey), expectedKey = validateLicenseLoginKey(input.expectedKey);
                const accountRef = accountPath('driver', 'licenses/' + input.licenseKey), ref = db.doc(accountRef), snapshot = await tx.get(ref);
                if (!snapshot.exists) deny();
                const license = snapshot.data(); validateAccount('driver', license, now());
                if (currentLicenseLoginKey(license, accountRef) !== expectedKey) throw new AuthError(409, 'LICENSE_KEY_CONFLICT');
                if (newKey === expectedKey) throw new AuthError(400, 'LICENSE_KEY_UNCHANGED');
                // Reserve the name globally, including legacy fallback names and
                // fixed document IDs, so two accounts cannot acquire the same key.
                const nextId = driverLicenseLookupId(newKey, key), nextRef = lRef(nextId), next = await tx.get(nextRef);
                const named = await tx.get(db.collection('licenses').where('loginKey', '==', newKey));
                const legacy = await tx.get(db.collection('licenses').where('key', '==', newKey));
                let documentName = null;
                try { documentName = db.doc(accountPath('driver', 'licenses/' + newKey)); } catch (error) { if (!(error instanceof AuthError)) throw error; }
                const documentSnapshot = documentName ? await tx.get(documentName) : null;
                if (next.exists || named.docs.length || legacy.docs.some(s => s.id !== ref.path.split('/')[1]) ||
                    (documentSnapshot?.exists && documentName.path !== ref.path)) throw new AuthError(409, 'LICENSE_KEY_EXISTS');
                const prepared = await prepareDriverPrincipal(tx, accountRef);
                // Key changes must preserve an already established Firebase UID.
                if (prepared.created || prepared.p.credentialVersion >= Number.MAX_SAFE_INTEGER) throw new AuthError(409, 'LICENSE_KEY_CONFLICT');
                const oldLookups = await tx.get(db.collection('auth_secret_lookups').where('uid', '==', prepared.uid));
                const nextVersion = prepared.p.credentialVersion + 1;
                for (const old of oldLookups.docs) tx.delete(db.doc('auth_secret_lookups/' + old.id));
                tx.create(nextRef, { uid: prepared.uid, credentialVersion: nextVersion, kind: 'driver_license' });
                tx.update(pRef(prepared.uid), { lookupId: nextId, credentialVersion: nextVersion, updatedAt: now() });
                tx.update(ref, { loginKey: newKey });
                return { changed: true, accountRef, loginKey: newKey, credentialVersion: nextVersion };
            }
            if (input.action === 'checkDevice') {
                if (p.role !== 'driver') deny();
                if (typeof input.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.deviceId)) throw new AuthError(400, 'INVALID_REQUEST');
                if (actorAccount.deviceId && actorAccount.deviceId !== input.deviceId) deny();
                return { blocked: (await tx.get(db.doc('blocked_devices/' + input.deviceId))).exists };
            }
            if (input.action === 'readLegacyRoutes') {
                if (p.role !== 'dispatch' || !Array.isArray(input.licenseKeys) || input.licenseKeys.length < 1 || input.licenseKeys.length > 30 ||
                    new Set(input.licenseKeys).size !== input.licenseKeys.length) throw new AuthError(400, 'INVALID_REQUEST');
                const company = p.accountRef.slice('licenses/'.length), members = new Map(), owners = new Set();
                for (const id of input.licenseKeys) {
                    if (typeof id !== 'string' || !id || id !== id.trim()) throw new AuthError(400, 'INVALID_REQUEST');
                    const ref = accountPath('driver', 'licenses/' + id), s = await tx.get(db.doc(ref));
                    if (!s.exists || (s.data().type !== undefined && !['regular', 'trial'].includes(s.data().type)) || s.data().dispatchKey !== company) deny();
                    licenseMode(s.data()); members.set(id, s.data());
                    if (typeof s.data().routeOwnerId === 'string' && s.data().routeOwnerId.trim()) owners.add(s.data().routeOwnerId);
                }
                if (!owners.size) return { routes: [], pollRequired: false };
                // Owner-only historical routes have no inverse license path. Verify
                // every current license sharing these owners before returning data.
                const links = await tx.get(db.collection('licenses').where('routeOwnerId', 'in', [...owners]));
                const conflicting = new Set(links.docs.filter(s => s.data().dispatchKey !== company ||
                    (s.data().type !== undefined && !['regular', 'trial'].includes(s.data().type))).map(s => s.data().routeOwnerId));
                for (const s of links.docs) {
                    if (s.data().dispatchKey === company && s.data().type !== 'dispatch' && !conflicting.has(s.data().routeOwnerId)) {
                        licenseMode(s.data()); members.set(s.id, s.data());
                    }
                }
                const snapshot = await tx.get(db.collection('routes').where('routeOwnerId', 'in', [...owners]).limit(301));
                if (snapshot.docs.length > 300) throw new AuthError(409, 'ROUTE_READ_LIMIT');
                const fields = ['routeOwnerId', 'licenseKey', 'dispatchKey', 'deviceId', 'phone', 'updatedAt', 'destinations', 'endLocation', 'startSelected', 'startLocation', 'cleared'];
                const routes = [];
                for (const s of snapshot.docs) {
                    const r = s.data();
                    // Only current-company tags have the realtime company source.
                    // Historical tags need the current license/owner relationship.
                    if (!owners.has(r.routeOwnerId) || conflicting.has(r.routeOwnerId)) continue;
                    if (r.dispatchKey !== undefined) {
                        // Current-company routes belong to the realtime source. A
                        // historical company tag grants no authority by itself.
                        if (typeof r.dispatchKey !== 'string' || !r.dispatchKey.trim() || r.dispatchKey !== r.dispatchKey.trim() || r.dispatchKey === company) continue;
                        try { accountPath('dispatch', 'licenses/' + r.dispatchKey); } catch { continue; }
                        const member = members.get(r.licenseKey);
                        if (!member || member.routeOwnerId !== r.routeOwnerId ||
                            !['regular', 'trial'].includes(member.type) ||
                            links.docs.filter(s => s.data().routeOwnerId === r.routeOwnerId).length !== 1) continue;
                        try { validateAccount('driver', member, now()); } catch { continue; }
                    }
                    if (r.licenseKey !== undefined && (!members.has(r.licenseKey) || members.get(r.licenseKey).routeOwnerId !== r.routeOwnerId)) continue;
                    const data = Object.fromEntries(fields.filter(f => Object.hasOwn(r, f)).map(f => [f, r[f]]));
                    if (typeof r.updatedAt?.toMillis === 'function') data.updatedAt = r.updatedAt.toMillis();
                    routes.push({ id: s.id, data });
                }
                // Legacy clients may still save owner-only routes later. Managed
                // accounts also keep polling when historical routes actually exist.
                const pollRequired = routes.length > 0 || snapshot.docs.some(s => s.data().dispatchKey === undefined) || conflicting.size > 0 ||
                    [...members.values()].some(license => licenseMode(license) === 'legacy');
                return { routes, pollRequired }; // No business or authentication writes.
            }
            if (input.action === 'repairRouteOwner') {
                if (p.role !== 'master') deny();
                const ref = db.doc(accountPath('driver', 'licenses/' + input.licenseKey)), s = await tx.get(ref);
                if (!s.exists || licenseMode(s.data()) !== 'legacy') throw new AuthError(409, 'OWNER_REPAIR_CONFLICT');
                const license = s.data();
                if (license.routeOwnerId !== undefined && license.routeOwnerId !== '') throw new AuthError(409, 'OWNER_REPAIR_CONFLICT');
                if (license.key !== undefined && license.key !== input.licenseKey) deny();
                const create = input.confirmNewOwner === true;
                if (create ? input.routeOwnerId !== undefined : typeof input.routeOwnerId !== 'string' || !input.routeOwnerId.trim() || input.routeOwnerId.length > 256) throw new AuthError(400, 'INVALID_REQUEST');
                const identified = await tx.get(db.collection('routes').where('licenseKey', '==', input.licenseKey).limit(301));
                if (identified.docs.length > 300) throw new AuthError(409, 'OWNER_REPAIR_CONFLICT');
                const historical = new Set(identified.docs.map(d => d.data().routeOwnerId).filter(id => typeof id === 'string' && id.trim()));
                for (const id of new Set([input.licenseKey, license.deviceId].filter(id => typeof id === 'string' && id && !id.includes('/')))) {
                    const route = await tx.get(db.doc('routes/' + id));
                    if (!route.exists) continue;
                    const r = route.data();
                    if (r.licenseKey !== undefined && r.licenseKey !== input.licenseKey) throw new AuthError(409, 'OWNER_REPAIR_CONFLICT');
                    if (typeof r.routeOwnerId === 'string' && r.routeOwnerId.trim()) historical.add(r.routeOwnerId);
                }
                const owner = create ? randomUUID() : input.routeOwnerId;
                if (create ? historical.size > 0 : historical.size !== 1 || !historical.has(owner)) throw new AuthError(409, 'OWNER_REPAIR_CONFLICT');
                const used = await tx.get(db.collection('licenses').where('routeOwnerId', '==', owner));
                if (used.docs.some(d => d.id !== input.licenseKey)) throw new AuthError(409, 'OWNER_REPAIR_CONFLICT');
                const ownerRoutes = await tx.get(db.collection('routes').where('routeOwnerId', '==', owner).limit(301));
                if (ownerRoutes.docs.length > 300 || ownerRoutes.docs.some(d =>
                    (d.data().licenseKey !== undefined && d.data().licenseKey !== input.licenseKey) ||
                    (d.data().dispatchKey !== undefined && d.data().dispatchKey !== (license.dispatchKey || '')))) throw new AuthError(409, 'OWNER_REPAIR_CONFLICT');
                tx.update(ref, { routeOwnerId: owner });
                return { changed: true, routeOwnerId: owner };
            }
            if (['createLicense', 'adoptLicense', 'suspendLicense', 'updateLicense'].includes(input.action)) {
                if (p.role !== 'master') deny();
                if (input.action === 'createLicense') {
                    if (!['regular', 'dispatch'].includes(input.type) || !Number.isSafeInteger(input.count) || input.count < 1 || input.count > 50 ||
                        typeof input.keyword !== 'string' || input.keyword.length > 255 || now() >= expiryEnd(input.expireDate)) throw new AuthError(400, 'INVALID_REQUEST');
                    let phones = [];
                    if (input.type === 'regular') {
                        if (!Array.isArray(input.phones) || input.phones.length !== input.count) throw new AuthError(400, 'INVALID_REQUEST');
                        try { phones = input.phones.map(normalizePhone); } catch { throw new AuthError(400, 'INVALID_REQUEST'); }
                    } else if (input.phones !== undefined) throw new AuthError(400, 'INVALID_REQUEST');
                    const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
                    const prefix = input.keyword.trim().replace(/[^A-Z0-9가-힣]/gi, '').toUpperCase().slice(0, 7);
                    const licenses = [];
                    for (let i = 0; i < input.count; i++) {
                        const bytes = randomBytes(8);
                        let text = prefix;
                        while (text.length < 8) text += alphabet[bytes[text.length] % alphabet.length];
                        const licenseKey = text.slice(0, 4) + '-' + text.slice(4);
                        const ref = db.doc('licenses/' + licenseKey);
                        if (licenses.some(item => item.licenseKey === licenseKey) || (await tx.get(ref)).exists) throw new AuthError(409, 'LICENSE_EXISTS');
                        if ((await tx.get(lRef(driverLicenseLookupId(licenseKey, key)))).exists ||
                            (await tx.get(db.collection('licenses').where('loginKey', '==', licenseKey))).docs.length ||
                            (await tx.get(db.collection('licenses').where('key', '==', licenseKey))).docs.length) throw new AuthError(409, 'LICENSE_EXISTS');
                        licenses.push({ ref, licenseKey });
                    }
                    // All reads precede writes; license and authentication readiness
                    // commit atomically. Dispatch creation retains its existing flow.
                    const prepared = input.type === 'regular' ? await Promise.all(licenses.map(({ licenseKey }) =>
                        prepareDriverPrincipal(tx, 'licenses/' + licenseKey))) : [];
                    if (prepared.some(item => !item.created)) throw new AuthError(409, 'LICENSE_EXISTS');
                    for (const [i, { ref, licenseKey }] of licenses.entries()) {
                        tx.create(ref, {
                        key: licenseKey, type: input.type, securityVersion: 1, status: 'active', expireDate: input.expireDate,
                        phone: phones[i] || '', deviceId: '', dispatchKey: '', allowTms: true, maxSessions: 1, isPro: false,
                        maxSlots: input.type === 'dispatch' ? 10 : 0, createdAt: now(),
                        ...(input.type === 'regular' ? { routeOwnerId: randomUUID() } : { membershipVersion: 0 })
                    });
                        prepared[i]?.write();
                    }
                    return { licenseKeys: licenses.map(item => item.licenseKey) };
                }
                if (typeof input.licenseKey !== 'string' || !input.licenseKey || input.licenseKey !== input.licenseKey.trim()) throw new AuthError(400, 'INVALID_REQUEST');
                const accountRef = accountPath('driver', 'licenses/' + input.licenseKey);
                const ref = db.doc(accountRef), snapshot = await tx.get(ref);
                if (!snapshot.exists) deny();
                const license = snapshot.data(), mode = licenseMode(license);
                if (license.key !== undefined && license.key !== input.licenseKey) deny();
                const knownType = ['regular', 'dispatch', 'trial'].includes(license.type);
                if ((!knownType && !(mode === 'legacy' && license.type === undefined)) || !['active', 'suspended'].includes(license.status)) deny();
                if (input.action === 'adoptLicense') {
                    if (mode === 'managed') return { changed: false };
                    if (!knownType) throw new AuthError(409, 'ADOPTION_CONFLICT');
                    if (typeof license.routeOwnerId !== 'string' || !license.routeOwnerId.trim()) throw new AuthError(409, 'ADOPTION_CONFLICT');
                    if (license.dispatchKey !== undefined && typeof license.dispatchKey !== 'string') deny();
                    expiryEnd(license.expireDate);
                    if (license.type === 'dispatch' && (!Number.isSafeInteger(license.maxSlots) || license.maxSlots < 0)) throw new AuthError(409, 'INVALID_SLOT_LIMIT');
                    const binding = await tx.get(db.doc(bindingPath(accountRef)));
                    const matches = await tx.get(db.collection('auth_principals').where('accountRef', '==', accountRef));
                    const principals = matches.docs.filter(s => s.data().kind !== 'trial_registration');
                    if (binding.exists || principals.length) {
                        const b = binding.exists ? binding.data() : null;
                        if (!b || b.kind !== 'account_binding' || !UUID.test(b.uid) || principals.length !== 1 || principals[0].id !== b.uid) throw new AuthError(409, 'ADOPTION_CONFLICT');
                        const target = principals[0].data();
                        if (target.accountRef !== accountRef || target.role !== (license.type === 'dispatch' ? 'dispatch' : 'driver') ||
                            typeof target.enabled !== 'boolean' || !version(target.credentialVersion) || target.credentialReady !== true ||
                            target.credentialOperation != null || !LOOKUP.test(target.lookupId)) throw new AuthError(409, 'ADOPTION_CONFLICT');
                        const lookup = await tx.get(lRef(target.lookupId));
                        if (!lookup.exists || lookup.data().uid !== b.uid || lookup.data().credentialVersion !== target.credentialVersion) throw new AuthError(409, 'ADOPTION_CONFLICT');
                    }
                    const changes = { securityVersion: 1 };
                    if (license.type === 'dispatch') {
                        const v = license.membershipVersion;
                        if (v === undefined) changes.membershipVersion = 0;
                        else if (!Number.isSafeInteger(v) || v < 0) throw new AuthError(409, 'ADOPTION_CONFLICT');
                    }
                    tx.update(ref, changes);
                    return { changed: true };
                }
                const changes = input.action === 'suspendLicense' ? { status: 'suspended' } : input.changes && { ...input.changes };
                if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length ||
                    Object.keys(changes).some(k => !['phone', 'deviceId', 'expireDate', 'status', 'type', 'maxSlots', 'maxSessions', 'isPro'].includes(k))) throw new AuthError(400, 'INVALID_REQUEST');
                // The existing UI renders typeless legacy drivers as regular. Do
                // not persist that display fallback or silently convert the document.
                if (mode === 'legacy' && license.type === undefined && changes.type === 'regular') delete changes.type;
                if (changes.type !== undefined && changes.type !== license.type) throw new AuthError(409, 'LICENSE_TYPE_IMMUTABLE');
                if (changes.status !== undefined && !['active', 'suspended'].includes(changes.status)) throw new AuthError(400, 'INVALID_REQUEST');
                for (const k of ['phone', 'deviceId']) if (changes[k] !== undefined && (typeof changes[k] !== 'string' || changes[k].length > 256)) throw new AuthError(400, 'INVALID_REQUEST');
                if (changes.expireDate !== undefined) expiryEnd(changes.expireDate);
                if (changes.maxSlots !== undefined && (license.type !== 'dispatch' || !Number.isSafeInteger(changes.maxSlots) || changes.maxSlots < 0)) throw new AuthError(400, 'INVALID_REQUEST');
                if (changes.maxSessions !== undefined && (license.type !== 'dispatch' || !Number.isSafeInteger(changes.maxSessions) || changes.maxSessions < 1 || changes.maxSessions > 50)) throw new AuthError(400, 'INVALID_REQUEST');
                if (changes.isPro !== undefined && (license.type !== 'dispatch' || typeof changes.isPro !== 'boolean')) throw new AuthError(400, 'INVALID_REQUEST');
                // Existing master edit/reset may clear the current driver binding.
                // Invalidate issued sessions without creating/replacing an identity.
                const resetDriver = license.type !== 'dispatch' &&
                    ((changes.deviceId !== undefined && changes.deviceId !== (license.deviceId || '')) ||
                     (changes.phone === '' && Boolean(license.phone)));
                if (license.type !== 'dispatch' && changes.phone === '' && changes.deviceId === '') {
                    // Explicit existing master account/device reset is the exception.
                    // A normal driver logout never enters this master-only branch.
                    changes.lastDeviceId = '';
                    changes.lastDeviceChangeAt = 0;
                }
                if (resetDriver) {
                    const binding = await tx.get(db.doc(bindingPath(accountRef)));
                    const matches = await tx.get(db.collection('auth_principals').where('accountRef', '==', accountRef));
                    if (binding.exists || matches.docs.some(s => s.data().kind !== 'trial_registration')) {
                        const target = await prepareDriverPrincipal(tx, accountRef);
                        if (target.created || target.p.credentialVersion >= Number.MAX_SAFE_INTEGER) throw new AuthError(409, 'CREDENTIAL_CONFLICT');
                        const nextVersion = target.p.credentialVersion + 1;
                        tx.update(pRef(target.uid), { credentialVersion: nextVersion, updatedAt: now() });
                        tx.update(lRef(target.p.lookupId), { credentialVersion: nextVersion });
                    }
                }
                tx.update(ref, changes); // Preserve fixed identity, membership and driving collections.
                return { changed: true };
            }
            const selfTms = input.action === 'setTmsPermission';
            if (selfTms ? p.role !== 'driver' || typeof input.allowed !== 'boolean' : !['master', 'dispatch'].includes(p.role)) deny();
            if (!selfTms && (typeof input.licenseKey !== 'string' || !input.licenseKey.trim() || input.licenseKey !== input.licenseKey.trim())) throw new AuthError(400, 'INVALID_REQUEST');
            let targetAccountRef = selfTms ? p.accountRef : null;
            if (input.action === 'lookup') {
                const aliasId = driverLicenseLookupId(input.licenseKey, key), alias = await tx.get(lRef(aliasId));
                if (alias.exists) {
                    const target = principalData(await tx.get(pRef(alias.data().uid)));
                    if (alias.data().kind !== 'driver_license' || target.role !== 'driver' || target.lookupId !== aliasId || target.credentialVersion !== alias.data().credentialVersion) deny();
                    targetAccountRef = target.accountRef;
                }
            }
            const ref = db.doc(targetAccountRef || accountPath('driver', 'licenses/' + input.licenseKey));
            const snapshot = await tx.get(ref);
            if (!snapshot.exists) deny();
            const driver = snapshot.data();
            licenseMode(driver);
            if (driver.type !== undefined && !['regular', 'trial'].includes(driver.type)) deny();
            if (driver.dispatchKey !== undefined && typeof driver.dispatchKey !== 'string') deny();
            const oldKey = driver.dispatchKey || '';
            const ownKey = p.role === 'dispatch' ? p.accountRef.slice('licenses/'.length) : null;
            if (input.action === 'lookup') {
                if (currentLicenseLoginKey(driver, ref.path) !== input.licenseKey) deny();
                if (ownKey && oldKey && oldKey !== ownKey) deny();
                return { licenseKey: ref.path.slice('licenses/'.length), linked: !!oldKey,
                    allowTms: driver.allowTms === undefined || driver.allowTms === true };
            }
            if (input.action === 'link') {
                if (ownKey && input.dispatchKey !== undefined) throw new AuthError(400, 'INVALID_REQUEST');
                if (ownKey && oldKey && oldKey !== ownKey) deny();
                validateAccount('driver', driver, now());
                if (driver.allowTms !== undefined && driver.allowTms !== true) deny();
            }
            if (input.action === 'unlink' && ownKey && oldKey !== ownKey) deny();
            let newKey = oldKey;
            if (input.action === 'link') {
                newKey = ownKey || input.dispatchKey;
                accountPath('dispatch', 'licenses/' + newKey);
                if (typeof newKey !== 'string' || !newKey || newKey !== newKey.trim()) throw new AuthError(400, 'INVALID_REQUEST');
            } else if (input.action === 'unlink' || (selfTms && !input.allowed)) newKey = '';
            const companies = new Map();
            // Every membership change touches the common company document. No counter.
            for (const company of [...new Set([oldKey, newKey].filter(Boolean))].sort()) {
                const companyRef = db.doc(accountPath('dispatch', 'licenses/' + company));
                const s = await tx.get(companyRef);
                if (!s.exists || s.data().type !== 'dispatch') deny();
                licenseMode(s.data());
                companies.set(company, { ref: companyRef, data: s.data() });
            }
            if (input.action === 'link') {
                const target = companies.get(newKey).data;
                validateAccount('dispatch', target, now());
                if (oldKey !== newKey) {
                    if (!Number.isSafeInteger(target.maxSlots) || target.maxSlots < 0) throw new AuthError(409, 'INVALID_SLOT_LIMIT');
                    if (target.maxSlots > 0) {
                        const members = await tx.get(db.collection('licenses').where('dispatchKey', '==', newKey));
                        if (members.docs.length >= target.maxSlots) throw new AuthError(409, 'SLOT_LIMIT_REACHED');
                    }
                }
            }
            if (oldKey !== newKey) {
                for (const entry of companies.values()) {
                    const v = entry.data.membershipVersion === undefined ? 0 : entry.data.membershipVersion;
                    if (!Number.isSafeInteger(v) || v < 0 || v === Number.MAX_SAFE_INTEGER) throw new AuthError(409, 'MEMBERSHIP_CONFLICT');
                    entry.next = v + 1;
                }
                for (const entry of companies.values()) tx.update(entry.ref, { membershipVersion: entry.next });
            }
            const changes = { ...(oldKey !== newKey ? { dispatchKey: newKey } : {}),
                ...(selfTms && driver.allowTms !== input.allowed ? { allowTms: input.allowed } : {}) };
            if (Object.keys(changes).length) tx.update(ref, changes);
            return { changed: Object.keys(changes).length > 0 };
        });
    }
    return membershipOnly ? { membership } : { login, driverLogin, session, verifyMaster, inspectOwnMaster, credentials, startTrial };
}

function createMembershipCore(services) { return createAuthCore(services, true); }

async function bootstrapMaster({ db, key, now = Date.now }, accountRef) {
    // Trusted service-account capability only. Neither HTTP handler exports or
    // dispatches this operation. Its guard is independent of the selected admin.
    hmacKey(key);
    accountPath('master', accountRef);
    const uid = randomUUID();
    const secret = generateSecret();
    const id = lookupId(secret, key);
    const guard = db.doc(BOOTSTRAP_GUARD);
    const binding = db.doc(bindingPath(accountRef));
    const principal = db.doc('auth_principals/' + uid);
    const lookup = db.doc('auth_secret_lookups/' + id);
    await db.runTransaction(async tx => {
        if ((await tx.get(guard)).exists) throw new AuthError(409, 'BOOTSTRAP_ALREADY_DONE');
        if ((await tx.get(binding)).exists) throw new AuthError(409, 'CREDENTIAL_EXISTS');
        const account = await tx.get(db.doc(accountRef));
        validateAccount('master', account.exists ? account.data() : null, now());
        if ((await tx.get(principal)).exists || (await tx.get(lookup)).exists) throw new AuthError(409, 'CREDENTIAL_CONFLICT');
        const timestamp = now();
        tx.create(principal, { role: 'master', accountRef, enabled: true, credentialVersion: 1,
            lookupId: id, credentialReady: true, createdAt: timestamp, updatedAt: timestamp });
        tx.create(lookup, { uid, credentialVersion: 1 });
        tx.create(binding, { kind: 'account_binding', uid });
        tx.create(guard, { kind: 'bootstrap_guard', uid, createdAt: timestamp });
    });
    return { uid, secret, credentialVersion: 1 };
}

async function runBootstrapCli({ args = process.argv.slice(2), env = process.env,
    input = process.stdin, output = process.stdout, services = getServices,
    openPrompt = () => require('node:readline/promises').createInterface({ input, output }) } = {}) {
    // Refuse Vercel runtimes and redirected command output. Secret is
    // never a command argument or file; it is shown once in a private local TTY.
    if (env.VERCEL || !input.isTTY || !output.isTTY || args.length !== 2 || args[0] !== 'bootstrap-master') {
        throw new AuthError(400, 'LOCAL_INTERACTIVE_BOOTSTRAP_ONLY');
    }
    accountPath('master', args[1]);
    if (!env.FIREBASE_PROJECT_ID) throw new AuthError(503, 'AUTH_UNAVAILABLE');
    validateProjectEnvironment(env);
    const prompt = openPrompt();
    try {
        const confirmation = await prompt.question('After separate operator approval, type BOOTSTRAP followed by the target project ID: ');
        if (confirmation !== 'BOOTSTRAP ' + env.FIREBASE_PROJECT_ID) throw new AuthError(400, 'BOOTSTRAP_CANCELLED');
        const result = await bootstrapMaster(services(env), args[1]);
        // This is the explicitly requested one-time delivery, not diagnostic logging.
        output.write('Master login secret (shown once; store securely): ' + result.secret + '\n');
        result.secret = '';
    } finally { prompt.close(); }
}

async function runRecoveryCli({ args = process.argv.slice(2), env = process.env,
    input = process.stdin, output = process.stdout, services = getServices,
    openPrompt = () => require('node:readline/promises').createInterface({ input, output }) } = {}) {
    // This local entry point is intentionally absent from createAuthCore and both
    // HTTP handlers. Service-account IAM is the authority, not the supplied IDs.
    const [command, project, accountRef, uid] = args;
    if (env.VERCEL !== undefined || !input.isTTY || !output.isTTY ||
        typeof process === 'undefined' || !process.versions?.node ||
        args.length !== 4 || !['recover-master', 'inspect-master-recovery', 'resume-master-recovery'].includes(command)) {
        throw new AuthError(400, 'LOCAL_INTERACTIVE_RECOVERY_ONLY');
    }
    if (!project || project !== env.FIREBASE_PROJECT_ID || !UUID.test(uid)) {
        throw new AuthError(400, 'RECOVERY_TARGET_MISMATCH');
    }
    accountPath('master', accountRef);
    validateProjectEnvironment(env);
    const prompt = openPrompt();
    try {
        for (const [label, expected] of [['PROJECT', project], ['ACCOUNT', accountRef], ['UID', uid]]) {
            if (await prompt.question('Type ' + label + ' followed by the independently verified target value: ') !== label + ' ' + expected) {
                throw new AuthError(400, 'RECOVERY_CANCELLED');
            }
        }
        const { db, auth, key, now = Date.now } = services(env);
        hmacKey(key);
        const ref = db.doc('auth_principals/' + uid);
        async function target(tx) {
            const p = principalData(await tx.get(ref), false);
            if (p.role !== 'master' || p.accountRef !== accountRef ||
                typeof p.credentialReady !== 'boolean' ||
                (p.credentialOperation != null && !UUID.test(p.credentialOperation)) ||
                (p.credentialReady && p.credentialOperation != null)) deny();
            const binding = await tx.get(db.doc(bindingPath(accountRef)));
            const guard = await tx.get(db.doc(BOOTSTRAP_GUARD));
            if (!binding.exists || binding.data().kind !== 'account_binding' || binding.data().uid !== uid ||
                !guard.exists || guard.data().kind !== 'bootstrap_guard' || guard.data().uid !== uid) deny();
            const account = await tx.get(db.doc(accountRef));
            validateAccount('master', account.exists ? account.data() : null, now());
            const lookup = await tx.get(db.doc('auth_secret_lookups/' + p.lookupId));
            if (!lookup.exists || lookup.data().uid !== uid || lookup.data().credentialVersion !== p.credentialVersion) deny();
            return p;
        }
        async function checkUser(allowMissing = false) {
            // Only an explicit Auth not-found response can select pre-login recovery.
            // Permission/network failures never mean that a user does not exist.
            let user;
            try { user = await auth.getUser(uid); }
            catch (error) {
                if (allowMissing && error?.code === 'auth/user-not-found') return false;
                throw new AuthError(503, 'RECOVERY_USER_UNAVAILABLE');
            }
            if (user.uid !== uid || user.disabled !== false) deny();
            return true;
        }
        const observed = await db.runTransaction(target);
        const userExists = await checkUser(true);
        if (!userExists) {
            // The bootstrap guard/binding/lookup were verified by target(). Never
            // take over a pending operation merely because its Auth user is missing.
            if (!observed.credentialReady || observed.credentialOperation != null || command === 'resume-master-recovery') {
                throw new AuthError(409, 'CREDENTIAL_BUSY');
            }
            if (command === 'inspect-master-recovery') {
                output.write('Recovery state: bootstrap credential usable; Auth user absent. Confirm first sign-in has never occurred before recovery. No changes made.\n');
                return;
            }
            // Auth absence alone cannot distinguish never-created from externally
            // deleted users. Require an independent operator history confirmation.
            if (await prompt.question('Only if this bootstrap master has NEVER signed in and its Auth user was NOT deleted, type RECOVER BEFORE FIRST LOGIN: ') !== 'RECOVER BEFORE FIRST LOGIN') {
                throw new AuthError(400, 'RECOVERY_CANCELLED');
            }
            if (observed.credentialVersion === Number.MAX_SAFE_INTEGER) deny();
            let secret = generateSecret();
            const nextId = lookupId(secret, key);
            try {
                await db.runTransaction(async tx => {
                    const p = await target(tx);
                    if (p.credentialVersion !== observed.credentialVersion || p.lookupId !== observed.lookupId ||
                        p.credentialReady !== true || p.credentialOperation != null ||
                        p.credentialOperation !== observed.credentialOperation) {
                        throw new AuthError(409, 'CREDENTIAL_BUSY');
                    }
                    const nextRef = db.doc('auth_secret_lookups/' + nextId);
                    if ((await tx.get(nextRef)).exists) throw new AuthError(409, 'CREDENTIAL_CONFLICT');
                    // Read-only Auth check is safe on Firestore transaction retries.
                    // Do not create users or bypass revocation if a user appeared.
                    if (await checkUser(true)) throw new AuthError(409, 'RECOVERY_USER_APPEARED');
                    tx.delete(db.doc('auth_secret_lookups/' + p.lookupId));
                    tx.create(nextRef, { uid, credentialVersion: p.credentialVersion + 1 });
                    tx.set(ref, { ...p, lookupId: nextId, credentialVersion: p.credentialVersion + 1,
                        credentialReady: true, updatedAt: now() });
                });
                // No external mutation/saga is needed without an Auth user. The
                // single transaction shares the version/operation fence with normal
                // rotations. A user appearing after commit requires normal recovery.
                if (await checkUser(true)) throw new AuthError(409, 'RECOVERY_USER_APPEARED');
                output.write('Master login secret (shown once; store securely): ' + secret + '\n');
            } finally { secret = ''; }
            return;
        }
        if (command === 'inspect-master-recovery') {
            output.write(observed.credentialReady ? 'Recovery state: usable. No changes made.\n' :
                'Recovery state: pending/unusable. No changes made. Stop and verify the previous execution before explicit resume.\n');
            return;
        }
        if (command === 'resume-master-recovery') {
            if (observed.credentialReady) throw new AuthError(409, 'RECOVERY_NOT_PENDING');
            // Human confirmation is necessary: Firestore cannot determine whether
            // an old process or its outstanding Auth revoke call has really ended.
            if (await prompt.question('Pending state verified. After confirming the previous process AND outstanding requests have ended, type RESUME STOPPED: ') !== 'RESUME STOPPED') {
                throw new AuthError(400, 'RECOVERY_CANCELLED');
            }
        } else if (!observed.credentialReady) throw new AuthError(409, 'CREDENTIAL_BUSY');
        if (observed.credentialVersion === Number.MAX_SAFE_INTEGER) deny();
        const operation = randomUUID();
        let secret = generateSecret();
        const nextId = lookupId(secret, key);
        const nextVersion = observed.credentialVersion + 1;
        try {
            await db.runTransaction(async tx => {
                const p = await target(tx);
                // Fence every observation, including a pending-operation takeover.
                if (p.credentialVersion !== observed.credentialVersion || p.lookupId !== observed.lookupId ||
                    p.credentialReady !== observed.credentialReady || p.credentialOperation !== observed.credentialOperation) {
                    throw new AuthError(409, 'CREDENTIAL_BUSY');
                }
                const nextRef = db.doc('auth_secret_lookups/' + nextId);
                if ((await tx.get(nextRef)).exists) throw new AuthError(409, 'CREDENTIAL_CONFLICT');
                tx.delete(db.doc('auth_secret_lookups/' + p.lookupId));
                tx.create(nextRef, { uid, credentialVersion: nextVersion });
                tx.set(ref, { ...p, lookupId: nextId, credentialVersion: nextVersion,
                    credentialReady: false, credentialOperation: operation, updatedAt: now() });
            });
            try { await auth.revokeRefreshTokens(uid); }
            catch { throw new AuthError(503, 'AUTH_UNAVAILABLE'); }
            await checkUser();
            await db.runTransaction(async tx => {
                const p = await target(tx);
                if (p.credentialVersion !== nextVersion || p.lookupId !== nextId ||
                    p.credentialReady !== false || p.credentialOperation !== operation) deny();
                tx.update(ref, { credentialReady: true, credentialOperation: null, updatedAt: now() });
            });
            // Only confirmed finalization permits one-time delivery. Unknown commit
            // outcomes never trigger an automatic retry, unlock, or secret delivery.
            output.write('Master login secret (shown once; store securely): ' + secret + '\n');
        } finally { secret = ''; }
    } finally { prompt.close(); }
}

function sendError(res, error) {
    const known = error instanceof AuthError;
    return res.status(known ? error.status : 503).json({ error: known ? error.code : 'AUTH_UNAVAILABLE' });
}
function prepareRequest(req, res, allowedFields) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new AuthError(405, 'METHOD_NOT_ALLOWED'); }
    if (Object.keys(req.query || {}).length) throw new AuthError(400, 'INVALID_REQUEST');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) throw new AuthError(415, 'INVALID_REQUEST');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).some(field => !allowedFields.includes(field)) ||
        Buffer.byteLength(JSON.stringify(req.body)) > 2048) throw new AuthError(400, 'INVALID_REQUEST');
}

/* Separate operator approval is REQUIRED before any real execution:
 * node server/auth-core.cjs bootstrap-master admin/<existing-account-id>
 * Set the four dedicated auth environment variables in a trusted local environment.
 * Check the actual deployed Rules deny both auth collections before execution.
 * Use a private terminal without recording/transcripts. No web endpoint, output
 * redirection, secret argument, OCR credentials, or production test accounts.
 * The one-time guard cannot be reset through HTTP, even after principal disable.
 * A master interrupted during rotation requires separately authorized local
 * recovery; rerunning bootstrap or HTTP rotation cannot clear its operation lock.
 * Local recovery (same four dedicated env vars, no API action):
 * node server/auth-core.cjs recover-master <project-id> admin/<id> <expected-uid>
 * Use inspect-master-recovery after ANY uncertain outcome. If still pending,
 * independently stop the previous process and wait for outstanding requests to
 * finish before resume-master-recovery with the same arguments. Never delete
 * the bootstrap guard or expire a credentialOperation lock. If already usable
 * but the secret was lost, use recover-master again to issue a NEW version.
 * Missing Auth user permits only confirmed pre-first-login bootstrap recovery,
 * without any pending operation. Corrupt/disabled identity still requires investigation.
 */
module.exports = { SECRET_BYTES, AuthError, generateSecret, normalizeSecret, lookupId,
    expiryEnd, bindingPath, BOOTSTRAP_GUARD, bootstrapMaster, runBootstrapCli, runRecoveryCli,
    getServices, createAuthCore, createMembershipCore, prepareRequest, sendError, logAuthDiagnostic };

if (require.main === module) {
    const run = process.argv[2] === 'bootstrap-master' ? runBootstrapCli : runRecoveryCli;
    run().catch(() => {
        // Never print raw SDK errors, account details, credentials or tokens.
        process.stderr.write('Operation was not confirmed complete. Check the trusted setup and inspect recovery state before any retry.\n');
        process.exitCode = 1;
    });
}
