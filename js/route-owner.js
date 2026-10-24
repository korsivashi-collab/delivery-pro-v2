import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// 라이선스 키/전화번호와 독립적이며, 라이선스 이름 변경 시에도 유지합니다.
export async function ensureRouteOwner(db, licenseKey, expectedDeviceId = null, phone = null) {
    const snapshot = await getDoc(doc(db, 'licenses', licenseKey));
    const license = snapshot.data();
    if (!license || (expectedDeviceId && license.deviceId && license.deviceId !== expectedDeviceId)) throw new Error('기사 기기 연결을 다시 확인해 주세요.');
    if (!license.routeOwnerId) throw new Error('기사 데이터 접근 준비 후 다시 시도해 주세요.');
    return license.routeOwnerId;
}

// 빈 최신 경로도 비교하여 완료/취소 전의 오래된 경로가 부활하지 않게 합니다.
export function selectLatestOwnedRoute(routes, ownerId) {
    return routes.filter(route => route && route.routeOwnerId === ownerId &&
        (Array.isArray(route.destinations) || route.cleared === true) && Number.isFinite(route.updatedAt))
        .map(route => route.cleared === true ? { ...route, destinations: [] } : route)
        .sort((a, b) => b.updatedAt - a.updatedAt ||
            String(a.routeDocumentId || '').localeCompare(String(b.routeDocumentId || '')))[0] || null;
}
