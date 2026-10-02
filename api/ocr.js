const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;

// Vercel 환경 변수에 등록할 서비스 계정 JSON 키 설정
let credentialsConfig = {};
try {
    if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
        credentialsConfig = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
    }
} catch (e) {
    console.error("GCP_SERVICE_ACCOUNT_KEY 파싱 오류:", e);
}

// Document AI 클라이언트 초기화
const client = new DocumentProcessorServiceClient({
    credentials: credentialsConfig.client_email ? credentialsConfig : undefined
});

// 방금 생성하신 GCP 프로젝트 및 프로세서 정보
const projectId = 'delivery-ocr-506302'; 
const location = 'us'; 
const processorId = 'acd7355012d6c4a9'; 

const resourceName = `projects/${projectId}/locations/${location}/processors/${processorId}`;

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        let body = req.body;
        if (typeof body === 'string') {
            body = JSON.parse(body);
        }
        const imageContent = body?.imageContent;

        if (!imageContent) {
            return res.status(400).json({ error: '이미지 데이터가 없습니다.' });
        }

        // Base64 이미지를 버퍼로 변환
        const encodedImage = Buffer.from(imageContent, 'base64');
        const request = {
            name: resourceName,
            rawDocument: {
                content: encodedImage,
                mimeType: 'image/jpeg',
            },
        };

        // Enterprise Document AI OCR 호출
        const [result] = await client.processDocument(request);
        const { document } = result;

        if (!document || !document.text) {
            return res.status(404).json({ error: "사진에서 텍스트를 찾을 수 없습니다." });
        }

        // 기존 프론트엔드(app.js)와 완벽히 호환되는 응답 포맷
        return res.status(200).json({
            responses: [{
                fullTextAnnotation: {
                    text: document.text
                }
            }]
        });

    } catch (error) {
        console.error("Document AI OCR 처리 중 오류:", error);
        return res.status(500).json({ error: `Document AI 오류: ${error.message}` });
    }
};