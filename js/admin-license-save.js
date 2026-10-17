import { auth } from './admin-api.js';

export function normalizeMasterPhone(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    let digits = input.replace(/\D/g, '');
    if (input.startsWith('+82')) digits = '0' + digits.slice(2).replace(/^0/, '');
    if (!/^(?:\+82)?[0-9\s()-]+$/.test(input) || !/^010\d{8}$/.test(digits)) {
        throw new Error('휴대폰 번호를 정확하게 입력해 주세요. (예: 010-1234-5678)');
    }
    return digits.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3');
}

export function formatMasterPhoneInput(input) {
    try {
        input.value = normalizeMasterPhone(input.value);
        input.setCustomValidity('');
        return true;
    } catch (error) {
        input.setCustomValidity(error.message);
        input.reportValidity();
        return false;
    }
}

function requireMasterLogin(message) {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('admin-auth-required'));
    }
    throw Object.assign(new Error(message), {code:'MASTER_AUTH_REQUIRED'});
}

export async function saveMasterLicenses(request) {
    await auth.authStateReady();
    const user=auth.currentUser;
    if (!user) requireMasterLogin('마스터 로그인이 필요합니다. 다시 로그인해 주세요.');
    const identity=await user.getIdTokenResult();
    const claims=identity.claims;
    if (claims.role !== 'MASTER' || claims.masterSmsVerified !== true || !(claims.masterSessionExpiresAt > Date.now()/1000)) {
        requireMasterLogin('마스터 인증이 만료되었거나 다른 계정으로 변경되었습니다. 다시 로그인해 주세요.');
    }
    const response = await fetch('/api/admin-license-save', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.token}` },
        body: JSON.stringify(request)
    });
    const result = await response.json();
    if (!response.ok) {
        if (response.status === 401 || response.status === 403 && /^(마스터 관리자만|마스터 SMS 인증)/.test(result.error || '')) requireMasterLogin(result.error || '마스터 인증을 다시 진행해 주세요.');
        throw Object.assign(new Error(result.error || '계정 저장에 실패했습니다.'), {code:result.code});
    }
    return result;
}
