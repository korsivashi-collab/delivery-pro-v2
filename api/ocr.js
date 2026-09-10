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

        const apiKey = process.env.GOOGLE_VISION_API_KEY;

        if (!apiKey || apiKey === 'undefined' || apiKey.trim() === '') {
            return res.status(500).json({ 
                error: 'Vercel 환경 변수(GOOGLE_VISION_API_KEY)를 찾을 수 없습니다.' 
            });
        }

        const googleRes = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey.trim()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requests: [{ image: { content: imageContent }, features: [{ type: "TEXT_DETECTION" }] }]
            })
        });

        const data = await googleRes.json();
        
        if (data.error) {
            return res.status(500).json({ error: `구글 거부 원인: ${data.error.message}` });
        }

        return res.status(200).json(data);
        
    } catch (error) {
        return res.status(500).json({ error: '서버 처리 중 오류가 발생했습니다.' });
    }
};