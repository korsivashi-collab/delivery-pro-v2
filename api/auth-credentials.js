'use strict';
const { AuthError, getServices, createAuthCore, prepareRequest, sendError } = require('../server/auth-core.cjs');

function createHandler(getCore = () => createAuthCore(getServices())) {
    return async (req, res) => {
        try {
            prepareRequest(req, res, ['action', 'role', 'accountRef', 'uid', 'currentSecret', 'newSecret']);
            const header = req.headers?.authorization;
            if (typeof header !== 'string' || !/^Bearer [^\s]+$/.test(header)) throw new AuthError();
            const input = req.body;
            const fields = input.action === 'changeOwnSecret' ? ['action', 'currentSecret', 'newSecret'] :
                input.action === 'issue' ? ['action', 'role', 'accountRef'] : ['action', 'uid', 'accountRef'];
            if (Object.keys(input).some(field => !fields.includes(field))) throw new AuthError(400, 'INVALID_REQUEST');
            if (input.action === 'rotate' && ((input.uid !== undefined) === (input.accountRef !== undefined))) throw new AuthError(400, 'INVALID_REQUEST');
            const core = getCore();
            const actor = await core.verifyMaster(header.slice(7));
            return res.status(200).json(await core.credentials(actor, input));
        } catch (error) { return sendError(res, error); }
    };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
