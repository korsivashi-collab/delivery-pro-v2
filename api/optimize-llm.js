// api/optimize-llm.js

const API_MODEL = 'gemini-1.5-flash';
const TIMEOUT_MS = 15000; // 기사님이 오래 기다리지 않도록 15초 제한

// 🌟 제미나이에게 부여할 배송 동선 최적화 전문가 프롬프트
const SYSTEM_INSTRUCTION = `당신은 한국의 택배 및 물류 배송 동선 최적화 전문가입니다.
제공되는 데이터는 반경 300m 이내에 밀집된 배송지(Cluster) 목록입니다. 하버사인(단순 직선거리) 알고리즘만으로는 해결할 수 없는 '지그재그 동선', '도로 횡단', '비효율적인 유턴'을 방지하기 위해 당신이 호출되었습니다.

[동선 정렬 규칙]
1. 주소의 텍스트(도로명, 지번, 아파트 단지명, 동/호수)와 상호명을 분석하여 실제 배송 기사가 이동하기 가장 매끄러운 순서를 결정하세요.
2. 같은 건물, 같은 아파트 단지, 혹은 같은 도로나 골목 라인에 있는 배송지는 반드시 연달아 묶어서 배치하세요.
3. 길을 건너야 하거나 블록이 다른 배송지는 묶음 처리된 동선이 끝난 후 넘어가도록 배치하여 왔다 갔다 하는 현상을 없애세요.
4. 반드시 주어진 배송지 ID들을 빠짐없이 포함하여 가장 효율적인 방문 순서대로 정렬해야 합니다.

결과는 반드시 지정된 JSON 스키마에 맞춰 '배송지 ID(문자열)'가 정렬된 배열만 반환하세요.`;

// 반환받을 JSON 구조 정의 (프론트엔드 파싱 오류 방지)
const RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        optimized: {
            type: 'ARRAY',
            description: "최적화된 방문 순서대로 정렬된 배송지 ID 목록",
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

            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            const destinations = body?.destinations;

            if (!Array.isArray(destinations) || destinations.length < 2) {
                throw failure('INVALID_INPUT', 400);
            }

            // LLM 토큰 절약 및 집중도 향상을 위해 불필요한 데이터(고객 전화번호 등) 제거하고 핵심만 추출
            const promptData = destinations.map(d => ({
                id: String(d.id),
                address: d.address,
                storeName: d.storeName || "상호 없음"
            }));

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
                                    temperature: 0.1 // 🌟 창의성보다는 논리적이고 일관된 정답을 내도록 온도 낮춤
                                }
                            })
                        });

                        if (!response.ok) throw failure('GEMINI_API_ERROR', response.status === 429 ? 429 : 502);
                        return await response.json();
                    }),
                    new Promise((_, reject) => { 
                        timer = setTimeout(() => {
                            reject(failure('LLM_TIMEOUT', 504)); 
                            controller.abort();
                        }, timeoutMs); 
                    })
                ]);
            } catch (error) {
                if (error.status) throw error;
                throw failure('NETWORK_ERROR', 502);
            } finally { 
                clearTimeout(timer); 
            }

            // 결과 검증 및 추출
            const candidate = upstream.candidates?.[0];
            if (!candidate || candidate.finishReason !== 'STOP') throw failure('INVALID_RESPONSE', 502);
            
            const textPart = candidate.content?.parts?.[0]?.text;
            if (!textPart) throw failure('INVALID_RESPONSE', 502);

            let parsed;
            try { 
                parsed = JSON.parse(textPart); 
            } catch (_) { 
                throw failure('JSON_PARSE_ERROR', 502); 
            }

            if (!parsed.optimized || !Array.isArray(parsed.optimized)) {
                throw failure('SCHEMA_MISMATCH', 502);
            }

            // 성공적으로 정렬된 ID 배열 반환
            return res.status(200).json({ optimized: parsed.optimized });

        } catch (error) {
            console.error('[Optimize LLM Error]', error.code || error.message);
            // 에러 발생 시 프론트엔드(optimizer.js)가 기본 하버사인 정렬을 유지하도록 500 에러 처리
            return res.status(error.status || 500).json({ 
                error: { code: error.code || 'SERVER_ERROR' } 
            });
        }
    };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;