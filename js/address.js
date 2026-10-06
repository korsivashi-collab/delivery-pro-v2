// Normalize an already recognized delivery address, not document text.
// Without a recognizable road/parcel number, retain the address rather than guessing.
export function normalizeDeliveryBaseAddress(rawAddress) {
    if (typeof rawAddress !== 'string') return null;
    const text = rawAddress.replace(/\s+/g, ' ').trim();
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
