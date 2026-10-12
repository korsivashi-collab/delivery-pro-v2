# 배송경로PRO 네이티브 패키징 1단계

- App ID: `com.fastwave.deliverypro`
- App Name: `배송경로PRO`
- webDir: `www` (현재 정적 소스에서 생성하는 앱 전용 웹 루트)
- Android scheme: `https`
- 기존 프로젝트와 호환되는 Capacitor 6 의존성을 유지합니다. 스토어 제출 전에는 당시 SDK/타깃 OS 요건에 맞는 Capacitor 업그레이드가 필요할 수 있습니다.

## 최초 실행

프로젝트의 `app` 폴더에서 실행합니다.

```sh
npm ci
npm run build:native
npm run cap:add:android
npm run cap:sync:android
npm run cap:android
```

iOS는 macOS와 Xcode, Capacitor 6에서 사용하는 CocoaPods 환경에서 실행합니다.

```sh
npm ci
npm run build:native
npm run cap:add:ios
npm run cap:sync:ios
npm run cap:ios
```

플랫폼 폴더가 이미 존재하면 `cap:add:*`는 생략합니다. 소스 변경 후 `cap:sync:android` 또는 `cap:sync:ios`를 다시 실행합니다.

## 포함 범위와 다음 단계

`www`는 생성 전용입니다. 빌드는 기사 앱에서 참조하는 로컬 모듈, 아이콘, 정책 문서만 복사합니다. `payment.html`, `success-payment.html`, 관리자 화면, API 서버, 환경변수 및 백업은 복사하지 않습니다. 포함되는 소스에서 웹 결제 참조를 발견하면 빌드가 실패합니다.

`js/vendor/capacitor.js`는 설치된 `@capacitor/core`의 공식 ES 모듈을 복사한 웹 배포 파일입니다. 웹 배포에도 이 파일과 라이선스를 포함하세요. `npm ci`의 postinstall 및 네이티브 빌드에서 갱신합니다.

구독 버튼은 웹과 네이티브 모두 `openSubscriptionModal()`을 호출합니다. 1·3·6·12개월 안내만 제공하고 구매 버튼은 비활성화되어 있습니다. RevenueCat SDK, 스토어 상품 조회·구매·복원, 계정 연결, 서버 영수증 검증·웹훅은 아직 연결하지 않았습니다. 가격은 연동 후 스토어 상품 정보에서 표시해야 합니다.

원격 웹사이트를 로드하던 `server.url`을 제거했습니다. 따라서 네이티브 연동 단계에서 `/api/start-trial`, `/api/scan`, `/api/optimize-llm` 호출의 HTTPS 백엔드 주소와 CORS/네이티브 HTTP 처리를 연결해야 합니다. Firebase SMS 인증, 카메라·위치 권한 및 외부 내비게이션 실행도 실기기에서 검증해야 합니다. 현재 웹 앱은 Firebase·지도·스타일 CDN을 사용하므로 네트워크 연결이 필요합니다.

기존 토스 파일/API는 과거 소스로 남아 있지만 네이티브 번들과 앱의 결제 진입점에서는 사용하지 않습니다. 기존 웹 주소의 공개 배포까지 중단하려면 해당 파일/API의 웹 배포 제거도 별도로 수행해야 합니다. 이 단계는 스토어 제출 또는 실제 인앱결제 완료 단계가 아닙니다.
