const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));
const file = path.join(root, 'android/app/google-services.json');
if (!fs.existsSync(file)) {
    console.error(`Firebase Android 앱 ${config.appId} 등록 후 google-services.json을 android/app/에 저장하세요.`);
    process.exit(1);
}
const services = JSON.parse(fs.readFileSync(file, 'utf8'));
const client = services.client?.find(item => item.client_info?.android_client_info?.package_name === config.appId);
if (services.project_info?.project_id !== 'delivery-pro-dd272' || !client?.client_info?.mobilesdk_app_id) {
    console.error('Firebase 프로젝트 또는 Android 패키지명이 웹 앱/Capacitor 설정과 다릅니다.');
    process.exit(1);
}
console.log(`PASS Firebase project=${services.project_info.project_id}, package=${config.appId}`);
console.log('SHA 지문 등록, 전화번호 공급자 및 SMS 국가/결제 설정은 Firebase 콘솔에서 별도 확인하세요.');
