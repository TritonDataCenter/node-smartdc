/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Fabric network methods for the CloudAPI object
 */

var paths = require('./paths');
var sprintf = require('util').format;
var validate = require('./validate');



// --- Exports



/**
 * Creates a fabric network.
 *
 * Returns a JS object (the created network).
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options object to be passed to the API
 * @param {Function} callback of the form f(err, network).
 * @throws {TypeError} on bad input.
 */
function createFabricNetwork(account, options, callback) {
    var self = this;
    var opts;

    if (typeof (options) === 'function') {
        callback = options;
        options = account;
        account = this.account;
    }

    account = validate.account(account);
    opts = validate.networkOptions(options);
    validate.callback(callback);

    return self._request(sprintf(paths.fabricNetworks, account, opts.vlan_id),
            opts, function (req) {
        return self._post(req, callback);
    });
}


/**
 * Deletes a fabric network.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Number} vlanId the ID of the VLAN the network is on.
 * @param {String} network the ID of the network.
 * @param {Function} callback of the form f(err).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function deleteFabricNetwork(account, vlanId, network, callback, noCache) {
    var self = this;

    if (typeof (network) === 'function') {
        noCache = callback;
        callback = network;
        network = vlanId;
        vlanId = account;
        account = this.account;
    }

    account = validate.account(account);
    vlanId = validate.vlanId(vlanId);
    validate.network(network);
    validate.callback(callback);

    return self._request(sprintf(paths.fabricNetwork, account, vlanId,
            network), null, function (req) {
        return self._del(req, callback, noCache);
    });
}


/**
 * Retrieves a fabric network.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} network the ID of the network.
 * @param {Function} callback of the form f(err, network).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function getFabricNetwork(account, network, callback, noCache) {
    var self = this;

    if (typeof (network) === 'function') {
        noCache = callback;
        callback = network;
        network = account;
        account = this.account;
    }

    account = validate.account(account);
    validate.network(network);
    validate.callback(callback);

    return self._request(sprintf(paths.network, account, network), null,
            function (req) {
        return self._get(req, callback, noCache);
    });
}


/**
 * Lists all fabric networks for a given user.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options object containing:
 *   - {Number} vlan_id (optional) VLAN ID to filter on.
 * @param {Function} callback of the form f(err, networks).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function listFabricNetworks(account, options, callback, noCache) {
    var self = this;
    var vlanId;

    if (typeof (options) === 'function') {
        noCache = callback;
        callback = options;
        options = account;
        account = this.account;
    }

    validate.options(options);
    if (options.hasOwnProperty('vlan_id')) {
        vlanId = validate.vlanId(options.vlan_id);
    }

    account = validate.account(account);
    validate.callback(callback);

    if (vlanId !== undefined) {
        return self._request(sprintf(paths.fabricNetworks, account, vlanId), {},
                function (req) {
            return self._get(req, callback, noCache);
        });
    }

    return self._request(sprintf(paths.networks, account), {}, function (req) {
        req.query.fabric = true;
        return self._get(req, callback, noCache);
    });
}



module.exports = {
    createFabricNetwork: createFabricNetwork,
    deleteFabricNetwork: deleteFabricNetwork,
    getFabricNetwork: getFabricNetwork,
    listFabricNetworks: listFabricNetworks
};
