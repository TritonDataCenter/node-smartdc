/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 */
var util = require('util');
var path = require('path');
var fs = require('fs');
var pkg = require('../package.json');
var auth = require('smartdc-auth');

var bunyan = require('bunyan');
var smartdc = require('../lib/cloudapi'),
    CloudAPI = smartdc.CloudAPI;


var SSH_KEY_ID_RE = /^[0-9a-f]{2}(?:\:[0-9a-f]{2}){15}$/i;
var URL_RE = '^https?\://.+';


/**
 * Print a CLI error for the given error object.
 *
 * @param error {Error} The error to print
 * @param options {Object} Optional:
 *      - `command` {String} The CLI command name. Else a guess is made.
 */
function printErr(err) {
    var code = (err.body && err.body.code ? err.body.code : err.code);
    // if there's no message, it's not certain there will be syscall, but
    // worth a try, since that's a common class of error
    var msg = (err.body && err.body.message ? err.body.message : err.syscall);
    var cmd = path.basename(process.argv[1]);

    if (err.body && err.body.errors) {
        var details = err.body.errors.map(function (e) {
            return e.field + ': ' + e.message;
        }).join(', ');
    }

    console.error('%s: error%s: %s%s',
        cmd,
        (code ? util.format(' (%s)', code) : ''),
        msg,
        (details ? util.format(' (%s)', details) : ''));
}


/**
 * We want to support the passing of multiple types of arrays to command args.
 * This here churns through the various possibilities (same flag multiple times,
 * passing in CSV, JSON) and returns a proper array.
 *
 * @param obj {Object} Array containing command-line args from the same flag
 */
function argToArray(obj) {
    if (!obj || obj.length !== 1)
        return obj;

    obj = obj[0];

    try {
        return JSON.parse(obj);
    } catch (e) {}

    return obj.split(',');
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
        } else {
            printErr(err);
        }

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

    if (opts.debug || opts.verbose) {
        process.env.DEBUG = 1;
        opts.logLevel = 'trace';
    }

    if (typeof (opts.keyId) === 'undefined') {
        return callback(new Error(
            'Either --key or (env) SDC_KEY_ID must be specified'));
    }

    if (!opts.keyId.match(SSH_KEY_ID_RE)) {
        return callback(new Error(
            '--keyId or (env) SDC_KEY_ID must be a valid SSH key ID'));
    }

    if (!opts.account) {
        return callback(new Error(
            'Either --account or (env) SDC_ACCOUNT must be specified'));
    }

    var halves = opts.account.split('/');
    if (halves.length === 2) {
        opts.account = halves[0];

        if (!opts.user) {
            opts.user = halves[1];
        }

        console.warn('Warning: The given --account or SDC_ACCOUNT ' +
                     'appears to be an account/user combination. Please ' +
                     'split between --account and --user (or SDC_ACCOUNT ' +
                     'and SDC_USER) to avoid unexpected behaviours');
    }

    if (!opts.url) {
        return callback(new Error(
            'Either --url or (env) SDC_URL must be specified'));
    }

    if (!opts.url.match(URL_RE)) {
        return callback(new Error(
            '--url or (env) SDC_URL must be a valid URL'));
    }

    var identity = (opts.user) ?
        util.format('%s/users/%s', opts.account, opts.user):
        opts.account;

    opts.sign = auth.cliSigner({
        keyId: opts.keyId,
        user: identity
    });

    if (opts.role) {
        opts.asRole = opts.role;
        delete opts.role;
    }

    this.__defineGetter__('cloudapi', function () {
        if (self._cloudapi === undefined) {
            self._cloudapi = new CloudAPI(opts);
        }
        return (self._cloudapi);
    });

    return callback();
}

var KV_RE = new RegExp('^([^=]+)=(.*)$');

function parseMetadata(metas, fromFiles) {
    var i;
    var m;
    var out = {};

    if (!metas) {
        return (out);
    }

    for (i = 0; i < metas.length; i++) {
        if (!(m = KV_RE.exec(metas[i]))) {
            var example = fromFiles ? 'foo=filename.txt' : 'foo=bar';
            console.error(metas[i] + ' is invalid metadata; try ' + example);
            process.exit(1);
        }

        if (fromFiles) {
            try {
                out[m[1]] = fs.readFileSync(m[2], 'utf-8');
            } catch (ex) {
                console.error('could not load metadata from: %s: %s',
                    m[1], ex.message);
                process.exit(1);
            }
        } else {
            out[m[1]] = m[2];
        }
    }

    return (out);
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
        help: 'equivalent to --verbose'
    },
    {
        names: ['account', 'a'],
        type: 'string',
        help: 'account name',
        env: 'SDC_ACCOUNT'
    },
    {
        names: ['user', 'A'],
        type: 'string',
        help: 'account sub-user login',
        env: 'SDC_USER'
    },
    {
        names: ['url', 'u'],
        type: 'string',
        help: 'url for SmartDataCenter API',
        env: 'SDC_URL'
    },
    {
        names: ['verbose', 'v'],
        type: 'bool',
        help: 'display additional internal details during request'
    },

    {
        names: ['keyId', 'k'],
        type: 'string',
        help: 'your ssh key fingerprint',
        env: 'SDC_KEY_ID'
    },
    {
        names: ['role'],
        type: 'string',
        help: 'non-default roles to make request with'
    }
];

module.exports = {
    printErr: printErr,
    argToArray: argToArray,
    commonCb: commonCb,
    checkRequiredOptions: checkRequiredOptions,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    parseMetadata: parseMetadata
};
