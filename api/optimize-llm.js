// api/optimize-llm.js

const API_MODEL = 'gemini-1.5-flash-latest'; // 🌟 404 에러 방지를 위해 '-latest' 버전명 확실하게 적용
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
                throw failure('GEMINI_KEY_MISSING