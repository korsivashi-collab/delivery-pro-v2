import { doc, runTransaction } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// 라이선스 키/전화번호와 독립적이며, 라이선스 이름 변경 시에도 유지합니다.
export async function ensureRouteOwner(db, licenseKey, expectedDeviceId = null, phone = null) {
    const licenseRef = doc(db, 'licenses', licenseKey);
    const newOwnerId = crypto.randomUUID();
    return runTransaction(db, async transaction => {
        const snapshot = await transaction.get(licenseRef);
        if (!snapshot.exists()) throw new Error('라이선스가 존재하지 않습니다.');
        const license = snapshot.data();
        if (expectedDeviceId && license.deviceId && license.deviceId !== expectedDeviceId) {
            throw new Error('다른 기기에 등록된 라이선스입니다.');
        }
        const routeOwnerId = license.routeOwnerId || newOwnerId;
        const changes = { routeOwnerId };
        if (expectedDeviceId) changes.deviceId = expectedDeviceId;
        if (phone !== null) changes.phone = phone;
        transaction.update(licenseRef, changes);
        return routeOwnerId;
    });
}

// 빈 최신 경로도 비교하여 완료/취소 전의 오래된 경로가 부활하지 않게 합니다.
export function selectLatestOwnedRoute(routes, ownerId) {
    return routes.filter(route => route && route.routeOwnerId === ownerId &&
        (Array.isArray(route.destinations) || route.cleared === true) && Number.isFinite(route.updatedAt))
        .map(route => route.cleared === true ? { ...route, destinations: [] } : route)
        .sort((a, b) => b.updatedAt - a.updatedAt ||
            String(a.routeDocumentId || '').localeCompare(String(b.routeDocumentId || '')))[0] || null;
}
