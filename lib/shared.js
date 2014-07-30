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
        opts.logLevel = 'trace';
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

    return callback(false);
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
        help: 'enable debug/verbose mode (default: disabled)'
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
    commonCb: commonCb,
    checkRequiredOptions: checkRequiredOptions,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    parseMetadata: parseMetadata
};
