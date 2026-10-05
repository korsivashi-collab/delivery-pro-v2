'use strict';
const { AuthError, getServices, createAuthCore, prepareRequest, sendError } = require('../server/auth-core.cjs');

function createHandler(getCore = () => createAuthCore(getServices())) {
    return async (req, res) => {
        let credentialCallStarted = false;
        try {
            prepareRequest(req, res, ['action', 'role', 'accountRef', 'uid', 'currentSecret', 'newSecret']);
            const header = req.headers?.authorization;
            if (typeof header !== 'string' || !/^Bearer [^\s]+$/.test(header)) throw new AuthError();
            const input = req.body;
            const fields = input.action === 'inspectOwnMaster' ? ['action'] : input.action === 'changeOwnSecret' ? ['action', 'currentSecret', 'newSecret'] :
                input.action === 'issue' ? ['action', 'role', 'accountRef'] : ['action', 'uid', 'accountRef'];
            if (Object.keys(input).some(field => !fields.includes(field))) throw new AuthError(400, 'INVALID_REQUEST');
            if (input.action === 'rotate' && ((input.uid !== undefined) === (input.accountRef !== undefined))) throw new AuthError(400, 'INVALID_REQUEST');
            const core = getCore();
            if (input.action === 'inspectOwnMaster') return res.status(200).json(await core.inspectOwnMaster(header.slice(7)));
            const actor = await core.verifyMaster(header.slice(7));
            credentialCallStarted = true;
            return res.status(200).json(await core.credentials(actor, input));
        } catch (error) {
            if (req.body?.action !== 'changeOwnSecret') return sendError(res, error);
            const known = error instanceof AuthError;
            // After a possible commit, an HTTP failure is not a safe retry.
            const notChanged = !credentialCallStarted || error.changeOutcome === 'notChanged' ||
                (known && error.code === 'INVALID_SECRET');
            return res.status(known ? error.status : 503).json({ error: known ? error.code : 'AUTH_UNAVAILABLE',
                changeOutcome: notChanged ? 'notChanged' : 'unknown' });
        }
    };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
