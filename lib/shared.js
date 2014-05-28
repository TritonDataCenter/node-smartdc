/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 */
var util = require('util');
var path = require('path');

var pkg = require('../package.json');
var auth = require('smartdc-auth');

var bunyan = require('bunyan');
var name = 'sdc';
var log = bunyan.createLogger({
    name: name,
    serializers: bunyan.stdSerializers,
    stream: process.stderr,
    level: 'warn'
});
var smartdc = require('../lib/cloudapi'),
    CloudAPI = smartdc.CloudAPI;

/**
 * Print a CLI error for the given error object.
 *
 * @param error {Error} The error to print
 * @param options {Object} Optional:
 *      - `command` {String} The CLI command name. Else a guess is made.
 */
function printErr(err) {
    var code = (err.body ? err.body.code : err.code);
    var message = (err.body ? err.body.message : message);
    var cmd = path.basename(process.argv[1]);
    console.error('%s: error%s: %s',
        cmd,
        (code ? util.format(' (%s)', code) : ''),
        message);
}


/**
 * Common callback for all CLI operations.
 *
 * @param {Error} err optional error object.
 * @param {Object} obj optional response object.
 */
function commonCb(err, obj, headers) {
    if (err) {
        if (err.statusCode === 410) {
            console.error('Object is Gone (410)');
            process.exit(3);
        }
        printErr(err);
        process.exit(3);
    }

    if (obj) {
        console.log(JSON.stringify(obj, null, 2));
    }

    process.exit(0);
}

function checkRequiredOptions(opts, args, callback) {
    var self = this;

    if (opts.version) {
        console.log(this.name, pkg.version);
        return callback(false);
    }

    this.opts = opts;

    if (opts.debug) {
        process.env.DEBUG = 1;
        log.level('trace');
        log.src = true;
    }

    if (typeof (opts.keyId) === 'undefined') {
        return callback(new Error(
            'Either -k or (env) SDC_KEY_ID must be specified'));
    }

    if (!opts.account) {
        return callback(new Error(
            'Either -a or (env) SDC_ACCOUNT must be specified'));
    }

    if (!opts.url) {
        return callback(new Error(
            'Either -u or (env) SDC_URL must be specified'));
    }

    opts.log = log;

    var identity = (opts.subuser) ?
        util.format('%s/users/%s', opts.account, opts.subuser):
        opts.account;

    opts.sign = auth.cliSigner({
        keyId: opts.keyId,
        user: identity
    });

    this.__defineGetter__('cloudapi', function () {
        if (self._cloudapi === undefined) {
            self._cloudapi = new CloudAPI(opts);
        }
        return (self._cloudapi);
    });

    return callback(false);
}

var DEFAULT_OPTIONS = [
    {
        names: ['help', 'h', '?'],
        type: 'bool',
        help: 'Print help and exit.'
    }, {
        name: 'version',
        type: 'bool',
        help: 'Print version and exit.'
    }, {
        names: ['debug', 'd'],
        type: 'bool',
        help: 'enable debug/verbose mode (default: disabled)'
    },
    {
        names: ['account', 'a'],
        type: 'string',
        help: 'account name. Environment: SDC_ACCOUNT=ARG',
        env: 'SDC_ACCOUNT'
    },
    {
        names: ['subuser', 'A'],
        type: 'string',
        help: 'account sub-user login. Environment: SDC_USER=ARG',
        env: 'SDC_USER'
    },
    {
        names: ['url', 'u'],
        type: 'string',
        help: 'url for SmartDataCenter API. Environment: SDC_URL=ARG',
        env: 'SDC_URL'
    },
    {
        names: ['keyId', 'k'],
        type: 'string',
        help: 'your ssh key fingerprint. Environment: SDC_KEY_ID=ARG',
        env: 'SDC_KEY_ID'
    }
];

module.exports = {
    printErr: printErr,
    commonCb: commonCb,
    checkRequiredOptions: checkRequiredOptions,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS
};
