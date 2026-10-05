import { doc, runTransaction } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getVerifiedAuthSession, requestLicenseMembership } from './admin-api.js';

// 라이선스 키/전화번호와 독립적이며, 라이선스 이름 변경 시에도 유지합니다.
export async function ensureRouteOwner(db, licenseKey, expectedDeviceId = null, phone = null) {
    const licenseRef = doc(db, 'licenses', licenseKey);
    const existingOwner = await runTransaction(db, async transaction => {
        const snapshot = await transaction.get(licenseRef);
        if (!snapshot.exists()) throw new Error('라이선스가 존재하지 않습니다.');
        const license = snapshot.data();
        if (expectedDeviceId && license.deviceId && license.deviceId !== expectedDeviceId) {
            throw new Error('다른 기기에 등록된 라이선스입니다.');
        }
        const routeOwnerId = license.routeOwnerId;
        if (typeof routeOwnerId !== 'string' || !routeOwnerId.trim()) {
            return null;
        }
        const changes = {};
        if (expectedDeviceId && license.deviceId !== expectedDeviceId) changes.deviceId = expectedDeviceId;
        if (phone !== null && license.phone !== phone) changes.phone = phone;
        if (Object.keys(changes).length) transaction.update(licenseRef, changes);
        return routeOwnerId;
    });
    if (existingOwner) return existingOwner;
    const identity = getVerifiedAuthSession('driver');
    if (!identity || identity.accountRef !== `licenses/${licenseKey}`) throw new Error('동선 소유자를 확인할 수 없습니다.');
    const result = await requestLicenseMembership({ action: 'ensureOwnRouteOwner' });
    if (getVerifiedAuthSession('driver') !== identity || typeof result?.routeOwnerId !== 'string' || !result.routeOwnerId.trim()) {
        throw new Error('동선 소유자를 확인할 수 없습니다.');
    }
    return result.routeOwnerId;
}

// 빈 최신 경로도 비교하여 완료/취소 전의 오래된 경로가 부활하지 않게 합니다.
export function selectLatestOwnedRoute(routes, ownerId) {
    return routes.filter(route => route && route.routeOwnerId === ownerId &&
        (Array.isArray(route.destinations) || route.cleared === true) && Number.isFinite(route.updatedAt))
        .map(route => route.cleared === true ? { ...route, destinations: [] } : route)
        .sort((a, b) => b.updatedAt - a.updatedAt ||
            String(a.routeDocumentId || '').localeCompare(String(b.routeDocumentId || '')))[0] || null;
}
