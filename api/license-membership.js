'use strict';
const { AuthError, getServices, createMembershipCore, prepareRequest, sendError } = require('../server/auth-core.cjs');

function createHandler(getCore = () => createMembershipCore(getServices())) {
    return async (req, res) => {
        try {
            prepareRequest(req, res, ['action', 'deviceId', 'licenseKey', 'dispatchKey', 'allowed', 'type', 'keyword', 'count', 'expireDate', 'changes', 'licenseKeys', 'routeOwnerId', 'confirmNewOwner']);
            const header = req.headers?.authorization;
            if (typeof header !== 'string' || !/^Bearer [^\s]+$/.test(header)) throw new AuthError();
            return res.status(200).json(await getCore().membership(header.slice(7), req.body));
        } catch (error) { return sendError(res, error); }
    };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
