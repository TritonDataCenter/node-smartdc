/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Fabric VLAN methods for the CloudAPI object
 */

var paths = require('./paths');
var sprintf = require('util').format;
var validate = require('./validate');



// --- Exports



/**
 * Creates a fabric VLAN.
 *
 * Returns a JS object (the created VLAN).
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options object containing:
 *   - {Number} vlan_id (required) VLAN ID
 *   - {String} name (required) name
 *   - {String} description (optional) description
 * @param {Function} callback of the form f(err, vlan).
 * @throws {TypeError} on bad input.
 */
function createFabricVlan(account, options, callback) {
    var self = this;
    var opts;

    if (typeof (options) === 'function') {
        callback = options;
        options = account;
        account = this.account;
    }

    account = validate.account(account);
    opts = validate.vlanOptions(options);
    validate.callback(callback);

    return self._request(sprintf(paths.vlans, account), opts, function (req) {
        return self._post(req, callback);
    });
}


/**
 * Deletes a fabric VLAN.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Number} vlanId the ID of the VLAN.
 * @param {Function} callback of the form f(err, vlan).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function deleteFabricVlan(account, vlanId, callback, noCache) {
    var self = this;

    if (typeof (vlanId) === 'function') {
        noCache = callback;
        callback = vlanId;
        vlanId = account;
        account = this.account;
    }

    account = validate.account(account);
    vlanId = validate.vlanId(vlanId);
    validate.callback(callback);

    return self._request(sprintf(paths.vlan, account, vlanId), null,
            function (req) {
        return self._del(req, callback, noCache);
    });
}


/**
 * Retrieves a fabric VLAN.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Number} vlanId the ID of the VLAN.
 * @param {Function} callback of the form f(err, vlan).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function getFabricVlan(account, vlanId, callback, noCache) {
    var self = this;

    if (typeof (vlanId) === 'function') {
        noCache = callback;
        callback = vlanId;
        vlanId = account;
        account = this.account;
    }

    account = validate.account(account);
    vlanId = validate.vlanId(vlanId);
    validate.callback(callback);

    return self._request(sprintf(paths.vlan, account, vlanId), null,
            function (req) {
        return self._get(req, callback, noCache);
    });
}


/**
 * Lists all fabric VLANs for a given user.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, vlans).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function listFabricVlans(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        noCache = callback;
        callback = account;
        account = this.account;
    }

    account = validate.account(account);
    validate.callback(callback);

    self._request(sprintf(paths.vlans, account), null, function (req) {
        return self._get(req, callback, noCache);
    });
}


/**
 * Updates a fabric VLAN.
 *
 * Returns a JS object (the updated VLAN).
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Number} vlanID ID of the VLAN to update.
 * @param {Object} options object containing:
 *   - {String} name (optional) name
 *   - {String} description (optional) description
 * @param {Function} callback of the form f(err, vlan).
 * @throws {TypeError} on bad input.
 */
function updateFabricVlan(account, vlanId, options, callback, noCache) {
    var self = this;
    var opts;

    if (typeof (options) === 'function') {
        noCache = callback;
        callback = options;
        options = vlanId;
        vlanId = account;
        account = this.account;
    }

    account = validate.account(account);
    vlanId = validate.vlanId(vlanId);
    opts = validate.vlanOptions(options);
    validate.callback(callback);

    return self._request(sprintf(paths.vlan, account, vlanId), opts,
            function (req) {
        return self._put(req, callback);
    });
}



module.exports = {
    createFabricVlan: createFabricVlan,
    deleteFabricVlan: deleteFabricVlan,
    getFabricVlan: getFabricVlan,
    listFabricVlans: listFabricVlans,
    updateFabricVlan: updateFabricVlan
};
