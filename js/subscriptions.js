import { Capacitor } from './vendor/capacitor.js';

// 1단계 안내 UI입니다. 가격/구매 권한은 RevenueCat 연결 후 스토어에서 받아야 합니다.
let subscriptionDialog;
let previousFocus;

export function openSubscriptionModal() {
    if (!subscriptionDialog) {
        subscriptionDialog = document.createElement('dialog');
        subscriptionDialog.id = 'subscription-modal';
        subscriptionDialog.className = 'w-[calc(100%_-_2rem)] max-w-md max-h-[90dvh] overflow-y-auto rounded-3xl p-6 bg-white text-slate-900 shadow-2xl backdrop:bg-black/60';
        subscriptionDialog.setAttribute('aria-labelledby', 'subscription-title');
        subscriptionDialog.innerHTML = `
            <div class="flex items-center justify-between gap-3">
                <h2 id="subscription-title" class="text-xl font-black">배송경로PRO 구독</h2>
                <button type="button" data-close aria-label="구독 안내 닫기" class="rounded-lg px-3 py-2 text-slate-500 focus:ring-2 focus:ring-blue-500">✕</button>
            </div>
            <p class="mt-3 text-sm text-slate-500">배송 경로 최적화와 배송 관리에 사용할 이용 기간을 확인하세요.</p>
            <fieldset class="mt-5 grid grid-cols-2 gap-3">
                <legend class="mb-3 font-bold">구독 기간</legend>
                ${[1, 3, 6, 12].map(months => `
                    <label class="cursor-pointer">
                        <input type="radio" name="subscription-months" value="${months}" ${months === 1 ? 'checked' : ''} class="sr-only peer">
                        <span class="block rounded-xl border-2 border-slate-200 p-4 text-center font-bold peer-checked:border-blue-600 peer-checked:bg-blue-50 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500">${months}개월</span>
                    </label>`).join('')}
            </fieldset>
            <p class="mt-4 text-sm text-slate-600">요금과 할인 조건은 스토어 구매 화면에서 확인합니다. 선택한 구독 기간마다 자동 갱신되며, 구독 관리는 구매한 스토어에서 할 수 있습니다.</p>
            <p id="subscription-status" role="status" class="mt-4 rounded-xl bg-blue-50 p-3 text-sm text-blue-800"></p>
            <button type="button" disabled class="mt-4 w-full rounded-xl bg-slate-200 py-3.5 font-bold text-slate-500 cursor-not-allowed">인앱결제 연결 준비 중</button>
            <div class="mt-4 flex flex-wrap justify-center gap-4 text-xs">
                <a href="terms.html" class="underline text-blue-600">이용약관</a>
                <a href="privacy.html" class="underline text-blue-600">개인정보처리방침</a>
            </div>`;
        document.body.appendChild(subscriptionDialog);
        subscriptionDialog.querySelector('[data-close]').addEventListener('click', () => subscriptionDialog.close());
        subscriptionDialog.addEventListener('close', () => previousFocus?.focus());
        subscriptionDialog.addEventListener('click', event => {
            const bounds = subscriptionDialog.getBoundingClientRect();
            if (event.target === subscriptionDialog && (event.clientX < bounds.left || event.clientX > bounds.right ||
                event.clientY < bounds.top || event.clientY > bounds.bottom)) subscriptionDialog.close();
        });
    }
    subscriptionDialog.querySelector('#subscription-status').textContent = Capacitor.isNativePlatform()
        ? '스토어 구독 서비스를 준비하고 있습니다. 현재 결제는 진행되지 않습니다.'
        : '구독은 정식 모바일 앱에서 제공될 예정입니다. 웹에서는 결제를 진행하지 않습니다.';
    if (!subscriptionDialog.open) {
        previousFocus = document.activeElement;
        subscriptionDialog.showModal();
    }
}
