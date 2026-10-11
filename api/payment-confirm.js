const admin = require('firebase-admin');
const { randomBytes, randomUUID } = require('node:crypto');

const PRICES = { 1: 9900, 3: 28200, 6: 53400, 12: 95000 };
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
function phoneValue(value) {
    if (typeof value !== 'string' || !/^01[016789][\d -]+$/.test(value)) throw problem('휴대폰 번호를 확인해 주세요.');
    const digits = value.replace(/\D/g, '');
    if (!/^01[016789]\d{7,8}$/.test(digits)) throw problem('휴대폰 번호는 10~11자리로 입력해 주세요.');
    return digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
}
function parseDate(value) {
    const match = /^(\d{4})[.-](\d{2})[.-](\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const [, y, m, d] = match.map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}
function extendDate(value, months) {
    const today = parseDate(new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10));
    const previous = parseDate(value);
    const base = previous && previous >= today ? previous : today;
    const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months + 1, 0));
    end.setUTCDate(Math.min(base.getUTCDate(), end.getUTCDate()));
    return end.toISOString().slice(0, 10).replace(/-/g, '.');
}
module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({ success: false, error: 'GET 또는 POST 요청만 가능합니다.' });
    }
    try {
        if (!process.env.TOSS_SECRET_KEY || !process.env.TOSS_CLIENT_KEY) throw problem('결제 서비스 설정이 준비되지 않았습니다.', 503);
        if (req.method === 'GET') return res.status(200).json({ clientKey: process.env.TOSS_CLIENT_KEY });
        const input = req.body || {};
        const phone = phoneValue(input.phone);
        const months = Number(input.months);
        if (!Number.isInteger(months) || !Object.hasOwn(PRICES, months)) throw problem('이용 기간을 확인해 주세요.');
        const amount = PRICES[months];
        if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        }) });
        const db = admin.firestore();
        if (input.action === 'create-order') {
            const orderId = 'PRO_' + randomUUID();
            await db.collection('payment_orders').doc(orderId).create({ orderId, phone, months, amount,
                createdAt: admin.firestore.FieldValue.serverTimestamp() });
            return res.status(200).json({ success: true, orderId, phone, months, amount });
        }
        const { orderId, paymentKey } = input;
        if (typeof orderId !== 'string' || !/^PRO_[a-f0-9-]{36}$/.test(orderId) ||
            typeof paymentKey !== 'string' || !/^[\w-]{1,200}$/.test(paymentKey) ||
            !Number.isSafeInteger(input.amount) || input.amount !== amount) throw problem('결제 정보가 올바르지 않습니다.');
        const orderRef = db.collection('payment_orders').doc(orderId);
        const logRef = db.collection('payments').doc(orderId);
        const order = (await orderRef.get()).data();
        if (!order || order.phone !== phone || order.months !== months || order.amount !== amount) throw problem('주문 정보가 일치하지 않습니다.');
        const completed = await logRef.get();
        if (completed.exists) {
            const data = completed.data();
            if (data.paymentKey !== paymentKey) throw problem('결제 정보가 일치하지 않습니다.', 409);
            return res.status(200).json({ success: true, licenseKey: data.licenseKey, expireDate: data.expireDate, phone });
        }
        const headers = { Authorization: `Basic ${Buffer.from(process.env.TOSS_SECRET_KEY + ':').toString('base64')}`,
            'Content-Type': 'application/json', 'Idempotency-Key': orderId };
        let response = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
            method: 'POST', headers, body: JSON.stringify({ paymentKey, orderId, amount }), signal: AbortSignal.timeout(15000)
        });
        let payment = await response.json();
        // DB 저장 실패 후 재시도할 때 이미 승인된 결제를 다시 조회하여 복구합니다.
        if (!response.ok && payment.code === 'ALREADY_PROCESSED_PAYMENT') {
            response = await fetch(`https://api.tosspayments.com/v1/payments/${encodeURIComponent(paymentKey)}`, {
                headers, signal: AbortSignal.timeout(15000)
            });
            payment = await response.json();
        }
        if (!response.ok) throw problem('결제 승인에 실패했습니다. 결제 정보를 확인하고 다시 시도해 주세요.', 502);
        if (payment.status !== 'DONE' || payment.orderId !== orderId || payment.paymentKey !== paymentKey ||
            payment.totalAmount !== amount || payment.currency !== 'KRW' || payment.balanceAmount !== amount ||
            !payment.approvedAt || !Number.isFinite(Date.parse(payment.approvedAt))) throw problem('결제 완료 상태 또는 금액이 일치하지 않습니다.', 409);
        const result = await db.runTransaction(async tx => {
            // 관리자 계정 발급/체험 발급과 같은 잠금을 사용해 전화번호별 중복 계정을 방지합니다.
            const lockRef = db.collection('admin_license_controls').doc('phone_integrity');
            await tx.get(lockRef);
            const logged = await tx.get(logRef);
            if (logged.exists) {
                const data = logged.data();
                if (data.paymentKey !== paymentKey) throw problem('결제 정보가 일치하지 않습니다.', 409);
                return { licenseKey: data.licenseKey, expireDate: data.expireDate };
            }
            const licenses = await tx.get(db.collection('licenses'));
            const profiles = await tx.get(db.collection('driver_profiles'));
            const matches = licenses.docs.filter(doc => String(doc.data().phone || '').replace(/\D/g, '') === phone.replace(/\D/g, '') && doc.data().status !== 'upgraded');
            if (matches.length > 1 || matches.some(doc => doc.data().type === 'dispatch')) throw problem('계정 확인이 필요합니다. 고객센터에 주문번호를 알려 주세요.', 409);
            if (profiles.docs.some(doc => String(doc.data().phone || '').replace(/\D/g, '') === phone.replace(/\D/g, '') &&
                doc.data().status !== 'upgraded' && doc.id !== matches[0]?.id)) throw problem('기사 프로필 확인이 필요합니다. 고객센터에 주문번호를 알려 주세요.', 409);
            let license = matches[0];
            let licenseKey = license?.id;
            if (!licenseKey) {
                do {
                    const code = randomBytes(4).toString('hex').toUpperCase();
                    licenseKey = `PRO-${code.slice(0, 4)}-${code.slice(4)}`;
                    license = await tx.get(db.collection('licenses').doc(licenseKey));
                } while (license.exists);
            }
            const profileRef = db.collection('driver_profiles').doc(licenseKey);
            const profile = (await tx.get(profileRef)).data() || {};
            const previous = license?.data() || {};
            if (previous.routeOwnerId && profile.routeOwnerId && previous.routeOwnerId !== profile.routeOwnerId) throw problem('계정 소유권 확인이 필요합니다.', 409);
            const routeOwnerId = previous.routeOwnerId || profile.routeOwnerId || randomUUID();
            const expireDate = extendDate(previous.expireDate, months);
            const data = { key: licenseKey, phone, routeOwnerId, expireDate, status: 'active', type: previous.type || 'regular',
                updatedAt: admin.firestore.FieldValue.serverTimestamp() };
            tx.set(db.collection('licenses').doc(licenseKey), { ...data, expiresAt: admin.firestore.FieldValue.delete() }, { merge: true });
            tx.set(profileRef, { ...data, expiresAt: admin.firestore.FieldValue.delete() }, { merge: true });
            tx.set(logRef, { orderId, amount, phone, months, paymentKey, approvedAt: payment.approvedAt, licenseKey, expireDate,
                createdAt: admin.firestore.FieldValue.serverTimestamp() });
            tx.set(orderRef, { status: 'completed' }, { merge: true });
            tx.set(lockRef, { updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            return { licenseKey, expireDate };
        });
        return res.status(200).json({ success: true, ...result, phone });
    } catch (error) {
        console.error('Payment pipeline failed:', error.code || error.name);
        return res.status(error.status || 500).json({ success: false, error: error.status ? error.message :
            '결제 처리 확인이 필요합니다. 같은 화면에서 다시 시도해 주세요. 계속 실패하면 주문번호로 고객센터에 문의해 주세요.' });
    }
};
