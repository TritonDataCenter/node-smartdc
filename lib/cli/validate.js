/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Shared validation functions
 */

var util = require('util');



/**
 * Accepts an account object or string, and validates that it's actually a
 * string. Returns the account string.
 */
function validateAccount(account) {
    if (typeof (account) === 'object') {
        account = account.login;
    }

    if (typeof (account) !== 'string') {
        throw new TypeError('account (string) required');
    }

    return account;
}


/**
 * Validates that callback is a function.
 */
function validateCallback(callback) {
    if (typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
}


/**
 * Validates that network is a string.
 */
function validateNetwork(network) {
    if (typeof (network) !== 'string') {
        throw new TypeError('network (string) required');
    }
}


/**
 * Validates that options is an object with the correct options
 */
function validateNetworkOptions(options) {
    var opts = {};

    validateOptions(options);
    if (options.hasOwnProperty('vlan_id')) {
        opts.vlan_id = validateVlanId(options.vlan_id);
    }

    ['gateway', 'provision_end_ip', 'provision_start_ip', 'subnet',
     'description', 'name'].forEach(function (p) {
        if (options.hasOwnProperty(p)) {
            if (typeof (options[p]) !== 'string') {
                throw new TypeError('options.' + p + ' (string) required');
            }
            opts[p] = options[p];
        }
    });

    if (options.hasOwnProperty('resolvers')) {
        opts.resolvers = validateResolvers(options.resolvers);
    }

    return opts;
}


/**
 * Validates that options is an object.
 */
function validateOptions(options) {
    if (typeof (options) !== 'object') {
        throw new TypeError('options (object) required');
    }
}


/**
 * Validates that resolvers is either an object or an array of strings
 */
function validateResolvers(resolvers) {
    var res = [];

    if (typeof (resolvers) !== 'string' && !util.isArray(resolvers)) {
        throw new TypeError('resolvers (array of strings) required');
    }

    if (typeof (resolvers) === 'string') {
        res = resolvers.split(',');
    } else {
        res = resolvers;
    }

    res.forEach(function (r) {
        if (typeof (r) !== 'string') {
            throw new TypeError('resolvers (array of strings) required');
        }
    });

    return res;
}


/**
 * Validates that vlanId is a number, or string that can be turned into a
 * number.  Returns the ID as a number.
 */
function validateVlanId(vlanId) {
    var num = Number(vlanId);

    if (isNaN(num)) {
        throw new TypeError('vlan_id (number) required');
    }

    return num;
}


/**
 * Validates that options is an object with the correct options
 */
function validateVlanOptions(options) {
    var opts = {};

    validateOptions(options);
    if (options.hasOwnProperty('vlan_id')) {
        opts.vlan_id = validateVlanId(options.vlan_id);
    }

    if (options.hasOwnProperty('name')) {
        opts.name = options.name;
    }

    if (options.hasOwnProperty('description')) {
        opts.description = options.description;
    }

    return opts;
}



module.exports = {
    account: validateAccount,
    callback: validateCallback,
    network: validateNetwork,
    networkOptions: validateNetworkOptions,
    options: validateOptions,
    vlanId: validateVlanId,
    vlanOptions: validateVlanOptions
};
