/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Config methods for the CloudAPI object
 */

var paths = require('./paths');
var sprintf = require('util').format;
var validate = require('./validate');


// --- Exports


/**
 * Retrieves a user's config object.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, conf).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function getConfig(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }

    account = validate.account(account);
    validate.callback(callback);

    return self._request(sprintf(paths.config, account), null, function (req) {
        return self._get(req, callback, noCache);
    });
}


/**
 * Updates a user's config object.
 *
 * Returns the updated config object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options update params to be passed to the API.
 * @param {Function} callback of the form f(err, conf).
 * @throws {TypeError} on bad input.
 */
function updateConfig(account, options, callback) {
    var self = this;

    if (typeof (options) === 'function') {
        callback = options;
        options = account;
        account = this.account;
    }

    account = validate.account(account);
    validate.options(options);
    validate.callback(callback);

    return self._request(sprintf(paths.config, account), options,
            function (req) {
        return self._put(req, callback);
    });
}



module.exports = {
    getConfig: getConfig,
    updateConfig: updateConfig
};
