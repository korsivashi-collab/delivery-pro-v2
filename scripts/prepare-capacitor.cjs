const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'js/vendor');
fs.mkdirSync(target, { recursive: true });
// 기존 웹은 번들러 없이 ES 모듈을 직접 사용하므로 설치된 공식 런타임을 로컬 배포합니다.
const runtime = fs.readFileSync(path.join(root, 'node_modules/@capacitor/core/dist/index.js'), 'utf8');
fs.writeFileSync(path.join(target, 'capacitor.js'), runtime.replace(/^\/\/# sourceMappingURL=.*$/m, ''));
fs.copyFileSync(path.join(root, 'node_modules/@capacitor/core/LICENSE'), path.join(target, 'capacitor.LICENSE'));
