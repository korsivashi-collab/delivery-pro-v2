// Normalize an already recognized delivery address, not document text.
// Keep user-written memo/address text literal inside HTML text and quoted attributes.
export function escapeMemoHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);
}

// Stored on the source document itself: one indexed array query discovers a customer's driver.
export function trackingLookupKeys(date, items, owner = '') {
    const day = String(date || '').split('-').map((v,i) => i ? v.padStart(2,'0') : v).join('-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    const keys = new Set(owner ? [JSON.stringify([day,'owner',owner])] : []);
    for (const item of items || []) {
        let phone = String(item?.customerPhone || item?.phone || '').replace(/\D/g,'');
        if (phone.startsWith('82')) phone = '0' + phone.slice(2);
        if (/^010\d{8}$/.test(phone)) keys.add(JSON.stringify([day,'phone',phone]));
        const order = String(item?.orderNo || '').trim().replace(/\s+/g,' ');
        if (order) keys.add(JSON.stringify([day,'order',order]));
    }
    return [...keys];
}

// Dispatch keeps the original separately; only navigation/search addresses use this rule.
export function dispatchNavigationAddress(value) {
    return typeof value === 'string'
        ? value.split(/[,，(（]/, 1)[0].replace(/\s+/g, ' ').trim() : '';
}

export function validDispatchCoordinates(point) {
    return point && [point.lat, point.lng].every(v =>
        v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v))) &&
        Math.abs(Number(point.lat)) <= 90 && Math.abs(Number(point.lng)) <= 180 &&
        !(Number(point.lat) === 0 && Number(point.lng) === 0);
}

export function dispatchAddressMatches(input, candidate) {
    const normalize = value => (normalizeDeliveryBaseAddress(dispatchNavigationAddress(value)) || '')
        .normalize('NFKC')
        .replace(/특별자치도|특별자치시|특별시|광역시/g, '')
        .replace(/경기도/g, '경기').replace(/강원도/g, '강원').replace(/제주도/g, '제주')
        .replace(/충청북도/g, '충북').replace(/충청남도/g, '충남')
        .replace(/전라북도/g, '전북').replace(/전라남도/g, '전남')
        .replace(/경상북도/g, '경북').replace(/경상남도/g, '경남')
        .replace(/[^\p{L}\p{N}-]/gu, '');
    const a = normalize(input), b = normalize(candidate);
    const region = /^(?:(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)|[가-힣]+(?:시|군|구|읍|면|동|리))+$/u;
    const suffix = (longer, shorter) => longer.endsWith(shorter) &&
        region.test(longer.slice(0, -shorter.length));
    return !!a && !!b && (a === b || suffix(a, b) || suffix(b, a));
}

export function dispatchOrderReady(order) {
    return validDispatchCoordinates(order) && !order.geocodeError &&
        (!order.fullAddress || dispatchAddressMatches(order.fullAddress, order.address));
}

// Without a recognizable road/parcel number, retain the address rather than guessing.
export function normalizeDeliveryBaseAddress(rawAddress) {
    if (typeof rawAddress !== 'string') return null;
    // A leading five-digit postcode is not part of the road/parcel address.
    const text = rawAddress.replace(/\s+/g, ' ').trim()
        .replace(/^(?:\d{5}|\(\d{5}\)|\[\d{5}\])\s+(?=[가-힣])/u, '');
    if (!text) return null;
    const road = /(?:^|\s)([^\s,()]+(?:대로|로|길))\s*(\d+(?:\s*-\s*\d+)?)(?=$|[\s,.(])/u.exec(text);
    const parcel = /(?:^|\s)([^\s,()]+(?:동|리|가|읍|면))\s*(산\s*)?(\d+(?:\s*-\s*\d+)?)(?=$|[\s,.(])/u.exec(text);
    const candidates = [road && { match: road, number: road[2], mountain: '' },
        parcel && { match: parcel, number: parcel[3], mountain: parcel[2] ? '산 ' : '' }]
        .filter(Boolean).sort((a, b) => a.match.index - b.match.index);
    if (!candidates.length) return text;
    const { match, number, mountain } = candidates[0];
    const prefix = text.slice(0, match.index).trimEnd();
    const core = `${match[1]} ${mountain}${number.replace(/\s*-\s*/g, '-')}`;
    return (prefix ? `${prefix} ${core}` : core).trim();
}
