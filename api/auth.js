'use strict';
const { AuthError, getServices, createAuthCore, prepareRequest, sendError } = require('../server/auth-core.cjs');

function createHandler(getCore = (diagnostics = false) => createAuthCore(getServices(process.env, undefined, diagnostics)), beforeLogin = async () => {}) {
    return async (req, res) => {
        try {
            prepareRequest(req, res, ['secret', 'action', 'phone', 'deviceId']);
            if (req.body.action === 'startTrial') {
                if (Object.keys(req.body).length !== 3 || !Object.hasOwn(req.body, 'phone') || !Object.hasOwn(req.body, 'deviceId')) throw new AuthError(400, 'INVALID_REQUEST');
                // Reuse the admission hook without exposing phone/deviceId or secrets.
                await beforeLogin({ remoteAddress: req.socket?.remoteAddress });
                return res.status(200).json(await getCore().startTrial(req.body));
            }
            if (Object.keys(req.body).some(field => !['secret', 'action'].includes(field))) throw new AuthError(400, 'INVALID_REQUEST');
            if (req.body.action === 'session' && Object.keys(req.body).length === 1) {
                const header = req.headers?.authorization;
                if (typeof header !== 'string' || !/^Bearer [^\s]+$/.test(header)) {
                    throw new AuthError();
                }
                // Preserve response-status and core/token validation order.
                const response = res.status(200);
                const core = getCore(true);
                const result = await core.session(header.slice(7));
                return response.json(result);
            }
            if (req.body.action !== undefined) throw new AuthError(400, 'INVALID_REQUEST');
            // Reserved integration point for a future distributed rate limiter.
            // No in-memory limiter; never pass the secret to limiter/logging services.
            await beforeLogin({ remoteAddress: req.socket?.remoteAddress });
            const result = await getCore().login(req.body.secret);
            return res.status(200).json(result);
        } catch (error) {
            return sendError(res, error);
        }
    };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
