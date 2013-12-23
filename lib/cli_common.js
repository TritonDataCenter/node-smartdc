// Copyright (c) 2013, Joyent, Inc. All rights reserved.

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var url = require('url');
var format = require('util').format;

var nopt = require('nopt');

var smartdc = require('../lib/index');
var CloudAPI = smartdc.CloudAPI;


path.name = 'path';
url.name = 'url';

// --- Globals

var DeprecatedOptions = {
    dataset: true
};

var MasterOptions = {
    // generic
    account: 'account name (i.e. customer)',
    debug: 'enable debug/verbose mode (default: 0)',
    help: 'print out this usage',
    keyId: 'the fingerprint of your ssh key (use ssh-keygen -l to determine)',
    url: 'url for SmartDataCenter API (i.e. https://someaddress.com)',
    name: 'the name of the entity',
    // tags
    tag: 'key=value pair',
    // firewall
    enabled: 'enable entity',
    rule: 'firewall rule',
    // instruments
    clone: 'an existing instrumentation (i.e. it\'s id number)',
    decomposition:
        'an array of arrays for breaking down the data (default: none)',
    'module': 'the CA module (i.e. syscall)',
    predicate: 'JSON string to filter data (default: none)',
    stat: 'the CA stat (i.e. syscalls)',
    value: 'value of stat (i.e. syscalls)',
    // instance
    metadata: 'metadata associated with this instance',
    networks: 'the network UUIDS to be attached to this instance',
    'package': 'the instance type (UUID) to use for this instance',
    'script': 'the user-script to run upon creation',
    credentials: 'include generated credentials for instance (default:false)',
    limit: 'return N instances (default: 1000, max allowable)',
    memory: 'filter instances by memory size (MB) (default: none)',
    offset: 'return the next N instances from this starting point (default: 0)',
    state:
        'the state of the instance (i.e. running, stopped ...) (default: all)',
    'type': 'filter by type (virtualmachine or smartmachine) (default: all)',
    tombstone:
        'include instances destroyed in the last N minutes (default: none)',
    image: 'the machine image id (UUID)',
    // snapshot
    snapshot: 'snapshot name',
    // account
    address: 'street address',
    city: 'city',
    company: 'company name (if no company, put \'none\')',
    country: 'country',
    email: 'email address',
    phone: 'full phone number (include country code if outside US)',
    'postal-code': 'postal code',
    surname: 'last name/surname',
    'enable-firewall': 'Enable or not instance firewall (default: false)'
};

// --- Internal Functions

function usage(str, code, message) {
    assert.ok(str);

    var writer = console.log;
    if (code) {
        writer = console.error;
    }

    if (message) {
        writer(message);
    }
    writer(path.basename(process.argv[1]) + ' ' + str);
    process.exit(code || 0);
}


function buildUsageString(options) {
    assert.ok(options);
    var str = '';
    Object.keys(options).forEach(function (k) {
        if (!DeprecatedOptions[k]) {
            var type = options[k];
            if (Array.isArray(type) && type.length > 0) {
                type = type[0];
            }
            var o = type.name ? type.name.toLowerCase() : '';
            str += '[--' + k + ' ' + o + '] ';
        }
    });
    return str;
}

function buildDetailedUsageString(options, override) {
    assert.ok(options);
    if (override) {
        Object.keys(override).forEach(function (k) {
            MasterOptions[k] = override[k];
        });
    }

    var str = '\n\n';
    Object.keys(options).forEach(function (k) {
        if (MasterOptions[k] !== undefined) {
            str += '\t' + k + ' - ' + MasterOptions[k] + '\n';
        }
    });
    return str;
}

// --- Exported API

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
        (code ? format(' (%s)', code) : ''),
        message);
}

module.exports = {

    printErr: printErr,

    /**
     * Common callback for all CLI operations.
     *
     * @param {Error} err optional error object.
     * @param {Object} obj optional response object.
     */
    callback: function (err, obj) {
        if (err) {
            if (err.statusCode === 410) {
                console.error('Object is Gone (410)');
                process.exit(3);
            }
            printErr(err);
            process.exit(3);
        }

        if (obj)
            console.log(JSON.stringify(obj, null, 2));
        process.exit(0);
    },


    usage: usage,


    buildUsageString: buildUsageString,


    buildDetailedUsageString: buildDetailedUsageString,


    parseArguments: function (options, shortOptions, callback, usageStr) {
        assert.ok(options);
        assert.ok(shortOptions);
        assert.ok(callback);

        if (!usageStr)
            usageStr = buildUsageString(options);

        var parsed = nopt(options, shortOptions, process.argv, 2);

        if (parsed.help)
            usage(usageStr);

        if (!parsed.keyId && process.env.SDC_KEY_ID) {
            parsed.keyId = process.env.SDC_KEY_ID;
        }

        if (typeof (parsed.keyId) === 'undefined') {
            usage(usageStr, 1,
                'Either -k or (env) SDC_KEY_ID must be specified');
        }

        if (!parsed.account) {
            parsed.account = process.env.SDC_ACCOUNT;
        }

        if (!parsed.account) {
            usage(usageStr, 1,
                'Either -a or (env) SDC_ACCOUNT must be specified');
        }

        if (!parsed.url) {
            parsed.url = process.env.SDC_URL;
        }

        if (!parsed.url) {
            usage(usageStr, 1,
                'Either -u or (env) SDC_URL must be specified');
        }

        parsed.sign = smartdc.cliSigner({
            keyId: parsed.keyId,
            user: parsed.account
        });

        return callback(parsed);
    },


    newClient: function (parsed) {
        assert.ok(parsed);
        assert.ok(parsed.url);
        assert.ok(parsed.account);
        assert.ok(parsed.sign);

        var logLevel = parsed.debug ? 'trace' : 'fatal';
        try {
            return new CloudAPI({
                url: parsed.url,
                account: parsed.account,
                noCache: true,
                logLevel: logLevel,
                sign: parsed.sign
            });
        } catch (e) {
            console.error(e.message);
            return process.exit(1);
        }
    },

    getMeta: function (str) {
        var res = [];
        var pos = str.indexOf('=');
        if (pos > 0) {
            res.push(str.substring(0, pos));
            res.push(str.substring(pos + 1, str.length));
        }
        return (res);
    }
};
