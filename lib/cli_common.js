// Copyright (c) 2013, Joyent, Inc. All rights reserved.

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var url = require('url');
var format = require('util').format;

var nopt = require('nopt');

var flushingexit = require('./flushingexit');
var smartdc = require('../lib/index');
var CloudAPI = smartdc.CloudAPI;


path.name = 'path';
url.name = 'url';

// --- Globals

var KV_RE = new RegExp('^([^=]+)=(.*)$');
var SSH_HEX_KEY_ID_RE = /^(MD5:)?[0-9a-f]{2}(?:\:[0-9a-f]{2}){15}$/i;
/*JSSTYLED*/
var SSH_BASE64_KEY_ID_RE = /^[A-Z0-9]+:[-A-Za-z0-9+\/=]+$/;
var URL_RE = '^https?\://.+';

var MasterOptions = {
    // generic
    account: 'account name (i.e. customer)',
    debug: 'equivalent to --verbose',
    help: 'print out this usage',
    keyId: 'the fingerprint of your ssh key (use ssh-keygen -l to determine)',
    url: 'url for SmartDataCenter API (i.e. https://someaddress.com)',
    name: 'the name of the entity',
    version: 'print the version number of this tool',
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
    'metadata-file':
        'metadata (loaded from a file) associated with this instance',
    metadataId: 'name of a piece of metadata associated with this instance',
    networks: 'the network UUIDS to be attached to this instance',
    'package': 'the instance type (UUID) to use for this instance',
    'script': 'the user-script to run upon creation',
    credentials: 'include generated credentials for instance (default: false)',
    limit: 'return N instances (default: 1000, max allowable)',
    memory: 'filter instances by memory size (MB) (default: none)',
    offset: 'return the next N instances from this starting point (default: 0)',
    state:
        'the state of the instance (i.e. running, stopped ...) (default: all)',
    type: 'filter by type (default: all)',
    tombstone:
        'include destroyed and failed instances on record (default: false)',
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
    'enable-firewall': 'Enable or not instance firewall (default: false)',
    user: 'account sub-user login (when a sub-user is using CLI)',
    role: 'non-default roles to make request with',
    verbose: 'display additional internal details during request',
    near: 'CSV of existing machine UUIDs to try to place new machine near',
    far: 'CSV of existing machine UUIDs to try to place new machine far from',
    'strict-locality': 'Whether near/far locality is a hint or a requirement',
    'api-version': 'Specify which version of the API should be used',
    brand: 'filter by brand (default: all) (API v8.0+)'
};

// --- Internal Functions

function usage(str, code, message) {
    assert.ok(str);

    var writer = flushingexit.emit;
    if (code) {
        writer = console.error;
    }

    if (message) {
        writer(message);
    }
    writer(path.basename(process.argv[1]) + ' ' + str);
    flushingexit.exit(code || 0);
}


function buildUsageString(options) {
    assert.ok(options);
    var str = '';

    Object.keys(options).forEach(function (k) {
        var type = options[k];
        if (Array.isArray(type) && type.length > 0) {
            type = type[0];
        }
        var o = type.name ? type.name.toLowerCase() : '';
        str += '[--' + k + ' ' + o + '] ';
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
    var code = (err.body && err.body.code ? err.body.code : err.code);
    // if there's no message, it's not certain there will be syscall, but
    // worth a try, since that's a common class of error
    var msg = (err.body && err.body.message ? err.body.message :
            (err.message ? err.message : err.syscall));
    var cmd = path.basename(process.argv[1]);
    var details;

    if (err.body && err.body.errors) {
        details = err.body.errors.map(function (e) {
            return e.code + ', ' + e.field + ': ' + e.message;
        }).join(', ');
    }

    console.error('%s: error%s: %s%s',
        cmd,
        (code ? format(' (%s)', code) : ''),
        msg,
        (details ? format(' (%s)', details) : ''));
}

function parseMetadata(metas, fromFiles) {
    var i;
    var m;
    var out = {};

    if (!metas)
        return (out);

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
            var val = m[2];

            // Convert string representation of booleans to boolean values.
            // This is problematic if the user wanted an actual "true" or
            // "false" string.
            if (val === 'true')
                val = true;
            if (val === 'false')
                val = false;

            out[m[1]] = val;
        }
    }

    return (out);
}

function mergeObjects(a, b) {
    var out = {};
    var k;

    for (k in a) {
        if (a.hasOwnProperty(k))
            out[k] = a[k];
    }
    for (k in b) {
        if (b.hasOwnProperty(k))
            out[k] = b[k];
    }

    return (out);
}

module.exports = {

    printErr: printErr,

    emit: flushingexit.emit,
    exit: flushingexit.exit,

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
            } else {
                printErr(err);
            }

            process.exit(3);
        }

        if (obj)
            flushingexit.emit(JSON.stringify(obj, null, 2));
        flushingexit.exit(0);
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

        if (parsed.version) {
            try {
                console.log('smartdc %s', require('../package.json').version);
                return process.exit(0);
            } catch (ex) {
                console.error('error reading version: %s', ex.message);
                return process.exit(1);
            }
        }

        if (!parsed.keyId && process.env.SDC_KEY_ID) {
            parsed.keyId = process.env.SDC_KEY_ID;
        }

        if (typeof (parsed.keyId) === 'undefined') {
            usage(usageStr, 1,
                'Either --keyId or (env) SDC_KEY_ID must be specified');
        }

        if (!parsed.keyId.match(SSH_HEX_KEY_ID_RE) &&
          !parsed.keyId.match(SSH_BASE64_KEY_ID_RE)) {
            usage(usageStr, 1,
                '--keyId or (env) SDC_KEY_ID must be a valid SSH key ID');
        }

        if (!parsed.account) {
            parsed.account = process.env.SDC_ACCOUNT;
        }

        if (!parsed.account) {
            usage(usageStr, 1,
                'Either --account or (env) SDC_ACCOUNT must be specified');
        }

        var halves = parsed.account.split('/');
        if (halves.length === 2) {
            parsed.account = halves[0];

            if (!parsed.user && !process.env.SDC_USER) {
                parsed.user = halves[1];
            }

            console.warn('Warning: The given --account or SDC_ACCOUNT ' +
                         'appears to be an account/user combination. Please ' +
                         'split between --account and --user (or SDC_ACCOUNT ' +
                         'and SDC_USER) to avoid unexpected behaviours');
        }

        if (!parsed['api-version']) {
            parsed['api-version'] = process.env.SDC_API_VERSION;
        }

        if (!parsed.url) {
            parsed.url = process.env.SDC_URL;
        }

        if (!parsed.url) {
            usage(usageStr, 1,
                'Either --url or (env) SDC_URL must be specified');
        }

        if (!parsed.url.match(URL_RE)) {
            usage(usageStr, 1,
                '--url or (env) SDC_URL must be a valid URL');
        }

        if (!parsed.user && process.env.SDC_USER) {
            parsed.user = process.env.SDC_USER;
        }

        parsed.sign = smartdc.cliSigner({
            keyId: parsed.keyId,
            user: parsed.account,
            subuser: parsed.user
        });

        return callback(parsed);
    },


    newClient: function (parsed) {
        assert.ok(parsed);
        assert.ok(parsed.url);
        assert.ok(parsed.account);
        assert.ok(parsed.sign);

        var logLevel = parsed.debug || parsed.verbose ? 'trace' : 'fatal';
        try {
            return new CloudAPI({
                url: parsed.url,
                account: parsed.account,
                noCache: true,
                logLevel: logLevel,
                sign: parsed.sign,
                asRole: parsed.role,
                version: parsed['api-version'] || parsed.api_version
            });
        } catch (e) {
            console.error(e.message);
            return process.exit(1);
        }
    },

    parseMetadata: parseMetadata,

    mergeObjects: mergeObjects
};
