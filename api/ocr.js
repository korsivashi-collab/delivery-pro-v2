// LEGACY OCR - disabled during Gemini vision evaluation.
// Restore only after explicit review; neither this factory nor its provider client is invoked.
module.exports = async function disabledLegacyOCR(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(410).json({ error: { code: 'LEGACY_OCR_DISABLED', message: '기존 OCR은 Gemini 평가 중 비활성화되어 있습니다.' } });
};
function createLegacyOCRHandler() {
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

// 구조 진단 출력은 이 함수에 모음. false로 바꾸면 전체 출력을 끔.
const OCR_STRUCTURE_DIAGNOSTICS_ENABLED = true;
function logOcrResponseStructure(document) {
    if (!OCR_STRUCTURE_DIAGNOSTICS_ENABLED) return;
    try {
        const pages = Array.isArray(document?.pages) ? document.pages : [];
        const fields = ['tokens', 'lines', 'blocks', 'tables', 'formFields'];
        const summary = {
            pages: { present: Array.isArray(document?.pages), count: pages.length },
            boundingPoly: { presentCount: 0, usableCount: 0, available: false },
            confidence: { presentCount: 0, usableCount: 0, available: false }
        };
        for (const field of fields) {
            summary[field] = {
                present: pages.some(page => Array.isArray(page?.[field])),
                presentOnPages: pages.filter(page => Array.isArray(page?.[field])).length,
                count: pages.reduce((count, page) => count + (Array.isArray(page?.[field]) ? page[field].length : 0), 0)
            };
        }
        // Layout (표 셀과 폼의 fieldName/fieldValue 포함)의 메타데이터만 집계.
        // 원문, 좌표값, 이미지, 개별 confidence 값은 출력하지 않음.
        const stack = [...pages];
        while (stack.length) {
            const node = stack.pop();
            if (!node || typeof node !== 'object') continue;
            if (node.boundingPoly || node.textAnchor) {
                if (node.boundingPoly) {
                    summary.boundingPoly.presentCount++;
                    const polygons = [node.boundingPoly.normalizedVertices, node.boundingPoly.vertices];
                    if (polygons.some(vertices => {
                        if (!Array.isArray(vertices) || vertices.length < 3 || !vertices.every(vertex =>
                            vertex && Number.isFinite(vertex.x ?? 0) && Number.isFinite(vertex.y ?? 0))) return false;
                        const xs = vertices.map(vertex => vertex.x ?? 0);
                        const ys = vertices.map(vertex => vertex.y ?? 0);
                        return Math.max(...xs) > Math.min(...xs) && Math.max(...ys) > Math.min(...ys);
                    })) {
                        summary.boundingPoly.usableCount++;
                    }
                }
                if (node.confidence !== undefined && node.confidence !== null) {
                    summary.confidence.presentCount++;
                    if (typeof node.confidence === 'number' && Number.isFinite(node.confidence) && node.confidence >= 0 && node.confidence <= 1) {
                        summary.confidence.usableCount++;
                    }
                }
            }
            for (const [key, value] of Object.entries(node)) {
                if (['text', 'textAnchor', 'image', 'boundingPoly'].includes(key)) continue;
                if (Array.isArray(value)) stack.push(...value);
                else if (value && typeof value === 'object') stack.push(value);
            }
        }
        summary.boundingPoly.available = summary.boundingPoly.usableCount > 0;
        summary.confidence.available = summary.confidence.usableCount > 0;
        console.log('[OCR 응답 구조 진단]', summary);
    } catch (_) {
        // 진단 실패로 기존 OCR 응답이 변경되지 않도록 함.
        console.log('[OCR 응답 구조 진단] 집계 실패');
    }
}

// 원문 응답은 유지하고, 상호 판정에 필요한 가벼운 레이아웃 정보만 추가.
function getOcrLayoutPages(document) {
    const getText = layout => (layout?.textAnchor?.textSegments || []).map(segment =>
        document.text.slice(Number(segment.startIndex || 0), Number(segment.endIndex || 0))).join('');
    return (document.pages || []).map((page, index) => {
        const serialize = item => {
            const layout = item.layout || {};
            const poly = layout.boundingPoly || {};
            let vertices = poly.normalizedVertices;
            if (!Array.isArray(vertices) || !vertices.length) {
                const width = page.image?.width || page.dimension?.width;
                const height = page.image?.height || page.dimension?.height;
                vertices = width && height ? (poly.vertices || []).map(vertex => ({ x: (vertex.x || 0) / width, y: (vertex.y || 0) / height })) : [];
            }
            const xs = (vertices || []).map(vertex => vertex.x ?? 0);
            const ys = (vertices || []).map(vertex => vertex.y ?? 0);
            return {
                text: getText(layout),
                box: xs.length >= 3 ? { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) } : null,
                confidence: typeof layout.confidence === 'number' ? layout.confidence : null,
                textSegments: (layout.textAnchor?.textSegments || []).map(segment => ({ start: Number(segment.startIndex || 0), end: Number(segment.endIndex || 0) }))
            };
        };
        return { pageNumber: page.pageNumber || index + 1, tokens: (page.tokens || []).map(serialize), lines: (page.lines || []).map(serialize) };
    });
}

return async function handler(req, res) {
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
        logOcrResponseStructure(document);

        if (!document || !document.text) {
            return res.status(404).json({ error: "사진에서 텍스트를 찾을 수 없습니다." });
        }

        // 기존 프론트엔드(app.js)와 완벽히 호환되는 응답 포맷
        return res.status(200).json({
            responses: [{
                fullTextAnnotation: {
                    text: document.text,
                    pages: getOcrLayoutPages(document)
                }
            }]
        });

    } catch (error) {
        console.error("Document AI OCR 처리 중 오류:", error);
        return res.status(500).json({ error: `Document AI 오류: ${error.message}` });
    }
};

}
