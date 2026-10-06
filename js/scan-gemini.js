import { withRequestDeadline } from './utils.js';
import { normalizeDeliveryBaseAddress } from './address.js';

export const GEMINI_SCAN_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_SCAN_TIMEOUT_MS = 60000;
const LIMITS = { storeName: 160, address: 600, phone: 80 };
function scanError(code) { return Object.assign(new Error('명세서 정보를 인식하지 못했습니다. 다시 촬영해 주세요.'), { code }); }
export function normalizeGeminiFields(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
        !Object.keys(value).every(key => Object.prototype.hasOwnProperty.call(LIMITS, key))) throw scanError('GEMINI_SCHEMA_ERROR');
    const fields = {};
    for (const [key, limit] of Object.entries(LIMITS)) {
        if (value[key] !== null && (typeof value[key] !== 'string' || value[key].length > limit)) throw scanError('GEMINI_SCHEMA_ERROR');
        fields[key] = value[key] === null ? null : value[key].trim() || null;
    }
    // Generic phone cleanup only; no OCR patterns or inferred digits.
    if (fields.phone) fields.phone = fields.phone.replace(/[^0-9+()\s-]/g, '').trim() || null;
    return fields;
}
export function imageFromDataUrl(dataUrl) {
    const match = typeof dataUrl === 'string' && /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match) throw scanError('IMAGE_FORMAT_ERROR');
    return { mimeType: match[1], imageContent: match[2] };
}
export function buildGeminiDestination(fields, coords, id, displayNumber, addressOverride = null) {
    if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) throw scanError('KAKAO_ADDRESS_ERROR');
    const originalAddress = addressOverride || fields.address;
    const baseAddress = normalizeDeliveryBaseAddress(originalAddress);
    let address = baseAddress;
    if (typeof address !== 'string' || !address.trim()) throw scanError('ADDRESS_REQUIRED');
    address = address.trim();
    const storeName = fields.storeName || '';
    if (storeName && !address.startsWith('[')) address = `[${storeName}] ${address}`;
    const destination = { id, address, lat: coords.lat, lng: coords.lng, phone: fields.phone, displayNumber, storeName };
    // Reuse the project's original-address field only when it adds information.
    // A manual correction does not overwrite the address recognized by Gemini.
    const rawAddress = fields.address || originalAddress;
    if (rawAddress !== baseAddress) destination.fullAddress = rawAddress;
    return destination;
}
export async function performGeminiScan(image, { signal } = {}) {
    return withRequestDeadline(async requestSignal => {
        const response = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(image), signal: requestSignal });
        let data;
        try { data = await response.json(); } catch (_) { throw scanError('GEMINI_SCHEMA_ERROR'); }
        if (!response.ok) {
            const code = typeof data?.error?.code === 'string' && /^GEMINI_[A-Z_]+$|^IMAGE_FORMAT_ERROR$/.test(data.error.code)
                ? data.error.code : 'GEMINI_SERVER_ERROR';
            throw scanError(code);
        }
        if (data?.engine !== 'gemini' || data.model !== GEMINI_SCAN_MODEL) throw scanError('GEMINI_SCHEMA_ERROR');
        return normalizeGeminiFields(data.result);
    }, GEMINI_SCAN_TIMEOUT_MS, { signal, label: '명세서 판독' });
}
