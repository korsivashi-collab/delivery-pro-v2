const admin = require('firebase-admin');

// Vercel 환경 변수에서 비공개 키를 불러와 파이어베이스에 한 번만 연결합니다.
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Vercel 환경변수 줄바꿈 처리
    })
  });
}

const db = admin.firestore();

module.exports = async function handler(req, res) {
  // 웹에서 POST 방식으로 키를 받아옵니다.
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST 요청만 가능합니다.' });
  
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: '키를 입력해주세요.' });

  try {
    const searchKey = key.toUpperCase();

    // 1. 마스터 계정 확인
    let adminDoc = await db.collection('admin').doc(key).get();
    if (!adminDoc.exists) adminDoc = await db.collection('admins').doc(searchKey).get();
    
    if (adminDoc.exists) {
      // 마스터 토큰 발행 (안전한 고정 식별자 사용)
      const token = await admin.auth().createCustomToken('admin_master', { role: 'MASTER' });
      return res.status(200).json({ token, role: 'MASTER', data: adminDoc.data() });
    }

    // 2. 관제/일반 라이선스 확인
    let licDoc = await db.collection('licenses').doc(searchKey).get();
    if (!licDoc.exists) licDoc = await db.collection('licenses').doc(`CTRL-${searchKey}`).get();

    if (licDoc.exists) {
      const data = licDoc.data();

      // [상태 검증 1] 정지 및 회수 상태 즉시 차단
      if (data.status === 'suspended' || data.status === 'revoked') {
        return res.status(403).json({ error: data.status });
      }

      // [상태 검증 2] 만료일자 정밀 정규화 검증
      const now = new Date();
      // KST (UTC+9) 기준 오늘 날짜를 정수 8자리(YYYYMMDD)로 계산
      const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      const todayNum = parseInt(kstTime.toISOString().slice(0, 10).replace(/-/g, ''), 10);

      let isExpired = (data.status === 'expired');

      // 1) expireDate 처리: 'YYYY-MM-DD', 'YYYY.MM.DD' 구분자 무관하게 8자리 숫자로 변환
      if (data.expireDate) {
        const expNum = parseInt(String(data.expireDate).replace(/\D/g, '').slice(0, 8), 10);
        // 만료일 숫자가 오늘보다 엄격하게 작은 경우에만 만료 (당일은 사용 허용)
        if (expNum && expNum < todayNum) {
          isExpired = true;
        }
      }

      // 2) expiresAt 처리: 숫자 밀리초 또는 Firestore Timestamp 지원
      if (data.expiresAt) {
        const expMs = typeof data.expiresAt.toMillis === 'function'
          ? data.expiresAt.toMillis()
          : Number(data.expiresAt);
        if (!isNaN(expMs) && expMs > 0 && expMs < Date.now()) {
          isExpired = true;
        }
      }

      if (isExpired) {
        return res.status(403).json({ error: 'expired' });
      }
      
      // 관제(DISPATCH) 또는 기사 토큰 발행
      const token = await admin.auth().createCustomToken(licDoc.id, { role: data.type === 'dispatch' ? 'DISPATCH' : 'DRIVER' });
      
      // 실제 조회된 문서 ID(licDoc.id)를 licenseId로 명시 반환하여 프론트엔드 finalKey/FIFO 일치 보장
      return res.status(200).json({ 
        token, 
        role: data.type === 'dispatch' ? 'DISPATCH' : 'DRIVER', 
        licenseId: licDoc.id, 
        data: { ...data, id: licDoc.id } 
      });
    }

    return res.status(401).json({ error: 'invalid' });
  } catch (error) {
    console.error('로그인 에러:', error);
    return res.status(500).json({ error: '서버 에러가 발생했습니다.' });
  }
};