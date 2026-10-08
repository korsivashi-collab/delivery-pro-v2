// api/optimize-llm.js

// 🌟 실제 구글 Gemini API 호출에 사용될 모델 (환경변수 우선, 기본값 1.5 플래시)
const API_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const TIMEOUT_MS = 15000; // 기사님이 대기하지 않도록 15초 제한

// 🌟 제미나이 배송 동선 최적화 전문가 시스템 프롬프트 (진입/진출 흐름 연계 강화)
const SYSTEM_INSTRUCTION = `당신은 한국의 식자재 및 화물 배송 동선 최적화 전문가입니다.
제공되는 데이터는 밀집된 배송지(destinations) 목록과, 진입 직전 지점(previousLocation), 완료 후 이동할 다음 목적지(nextLocation) 정보입니다.
단순 직선거리(하버사인) 알고리즘만으로는 해결할 수 없는 '지그재그 동선', '도로 횡단', '비효율적인 유턴', '진행 방향 역전'을 방지하기 위해 당신이 호출되었습니다.

[동선 정렬 규칙]
1. [방향성 흐름 유지 - 최우선]:
   - previousLocation이 주어지면 그 위치에서 가장 자연스럽게 진입할 수 있는 배송지부터 배송을 시작하세요.
   - nextLocation이 주어지면 마지막 배송지는 nextLocation으로 이동하기 가장 편리한 출구 쪽 배송지가 되도록 배치하세요.
   - 클러스터 내부에서 동선이 역주행하거나 거꾸로 돌아가지 않고, previousLocation -> [destinations 순서] -> nextLocation 으로 물 흐르듯 한 방향으로 통과하도록 정렬하세요.
2. [도로 및 건물 단위 묶음 배송]:
   - 주소의 텍스트(도로명, 지번, 건물명, 아파트 단지명, 동/호수)와 상호명을 분석하여 실제 배송 기사가 이동하기 가장 매끄러운 순서를 결정하세요.
   - 같은 건물, 같은 상가, 같은 아파트 단지, 혹은 같은 도로나 골목 라인에 있는 배송지는 반드시 연달아 묶어서 배치하세요.
   - 도로 반대편이나 블록이 다른 배송지는 한쪽 라인의 배송이 완전히 끝난 후 도로를 건너가도록 배치하여 왔다 갔다 하는 지그재그 횡단을 없애세요.
3. [결과 제약 사항]:
   - 반드시 destinations에 포함된 배송지 ID(문자열)만 빠짐없이 포함하여 가장 효율적인 방문 순서대로 정렬해야 합니다.
   - previousLocation이나 nextLocation은 진행 방향 참고용이므로 반환할 ID 목록에 절대 포함하지 마세요.

결과는 반드시 지정된 JSON 스키마에 맞춰 '배송지 ID(문자열)'가 정렬된 배열만 반환하세요.`;

// 반환받을 JSON 구조 정의 (프론트엔드 파싱 오류 방지)
const RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        optimized: {
            type: 'ARRAY',
            description: "최적화된 방문 순서대로 정렬된 destinations의 배송지 ID 목록",
            items: { type: 'STRING' }
        }
    },
    required: ["optimized"]
};

function failure(code, status) { 
    return Object.assign(new Error(code), { code, status }); 
}

function createHandler({ 
    fetchImpl = (...args) => fetch(...args), 
    env = process.env,
    timeoutMs = TIMEOUT_MS 
} = {}) {
    return async function handler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        
        try {
            if (req.method !== 'POST') { 
                res.setHeader('Allow', 'POST'); 
                throw failure('METHOD_NOT_ALLOWED', 405); 
            }
            if (!env.GEMINI_API_KEY?.trim()) {
                throw failure('GEMINI_KEY_MISSING', 503);
            }

            let body;
            try { 
                body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; 
            } catch (_) { 
                throw failure('DESTINATIONS_INVALID', 400); 
            }

            const destinations = body?.destinations;
            if (!Array.isArray(destinations) || destinations.length < 2 || destinations.length > 200 ||
                !destinations.every(node => node &&
                    ((typeof node.id === 'string' && node.id.trim() && node.id.length <= 160) ||
                     (typeof node.id === 'number' && Number.isSafeInteger(node.id))) &&
                    typeof node.address === 'string' && node.address.trim() && node.address.length <= 600 &&
                    (node.storeName == null || (typeof node.storeName === 'string' && node.storeName.length <= 160)) &&
                    Number.isFinite(node.lat) && Math.abs(node.lat) <= 90 &&
                    Number.isFinite(node.lng) && Math.abs(node.lng) <= 180) ||
                new Set(destinations.map(node => String(node.id))).size !== destinations.length) {
                throw failure('DESTINATIONS_INVALID', 400);
            }

            // 앵커(진입점/진출점) 데이터 정제
            const prevAnchor = body?.prevAnchor && typeof body.prevAnchor === 'object' ? {
                address: String(body.prevAnchor.address || '').slice(0, 600),
                storeName: String(body.prevAnchor.storeName || '').slice(0, 160)
            } : null;

            const nextAnchor = body?.nextAnchor && typeof body.nextAnchor === 'object' ? {
                address: String(body.nextAnchor.address || '').slice(0, 600),
                storeName: String(body.nextAnchor.storeName || '').slice(0, 160)
            } : null;

            // LLM 토큰 효율화 및 핵심 정렬 데이터 구성
            const nodes = destinations.map(({ id, address, storeName, lat, lng }) => ({
                id: String(id),
                address,
                storeName: storeName || '상호 없음',
                lat,
                lng
            }));

            const promptData = {
                ...(prevAnchor ? {
                    previousLocation: {
                        description: "클러스터 진입 직전 배송지 (진입 방향 참고)",
                        address: prevAnchor.address,
                        storeName: prevAnchor.storeName || "상호 없음"
                    }
                } : {}),
                destinations: nodes.map(n => ({
                    id: n.id,
                    address: n.address,
                    storeName: n.storeName
                })),
                ...(nextAnchor ? {
                    nextLocation: {
                        description: "클러스터 완료 후 이동할 목적지 (진출 방향 참고)",
                        address: nextAnchor.address,
                        storeName: nextAnchor.storeName || "상호 없음"
                    }
                } : {})
            };

            const controller = new AbortController();
            let timer;
            let upstream;

            try {
                upstream = await Promise.race([
                    Promise.resolve().then(async () => {
                        const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${API_MODEL}:generateContent`, {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json', 
                                'x-goog-api-key': env.GEMINI_API_KEY 
                            },
                            signal: controller.signal,
                            body: JSON.stringify({
                                systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
                                contents: [{ 
                                    role: 'user', 
                                    parts: [{ text: JSON.stringify(promptData, null, 2) }] 
                                }],
                                generationConfig: { 
                                    responseMimeType: 'application/json', 
                                    responseSchema: RESPONSE_SCHEMA,
                                    temperature: 0.1,
                                    maxOutputTokens: 4096
                                }
                            })
                        });

                        if (!response.ok) {
                            const code = response.status === 401 ? 'GEMINI_AUTH_ERROR'
                                : [403, 404].includes(response.status) ? 'GEMINI_MODEL_ACCESS_ERROR'
                                : response.status === 429 ? 'GEMINI_RATE_LIMIT' : 'GEMINI_UPSTREAM_ERROR';
                            throw failure(code, 502);
                        }

                        try { 
                            return await response.json(); 
                        } catch (_) { 
                            throw failure('GEMINI_SCHEMA_ERROR', 502); 
                        }
                    }),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => {
                            reject(failure('GEMINI_TIMEOUT', 504));
                            controller.abort();
                        }, timeoutMs);
                    })
                ]);
            } finally { 
                clearTimeout(timer); 
            }

            const candidate = upstream?.candidates?.[0];
            if (!candidate || candidate.finishReason !== 'STOP') {
                throw failure('GEMINI_SCHEMA_ERROR', 502);
            }

            let parsed;
            try {
                parsed = JSON.parse(candidate.content.parts.filter(part => !part.thought)
                    .map(part => part.text || '').join(''));
            } catch (_) { 
                throw failure('GEMINI_SCHEMA_ERROR', 502); 
            }

            const ids = new Set(nodes.map(node => node.id));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
                !Array.isArray(parsed.optimized) ||
                parsed.optimized.length !== ids.size ||
                new Set(parsed.optimized).size !== ids.size ||
                !parsed.optimized.every(id => typeof id === 'string' && ids.has(id))) {
                throw failure('GEMINI_SCHEMA_ERROR', 502);
            }

            return res.status(200).json({ optimized: parsed.optimized });

        } catch (error) {
            console.error('[Optimize LLM Error]', error.code || error.message);
            return res.status(error.status || 502).json({ 
                error: { code: error.code && error.status ? error.code : 'GEMINI_NETWORK_ERROR' } 
            });
        }
    };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;