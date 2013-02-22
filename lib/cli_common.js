// Copyright (c) 2013, Joyent, Inc. All rights reserved.

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var url = require('url');

var httpSignature = require('http-signature');
var nopt = require('nopt');
var restify = require('restify');
var SSHAgentClient = require('ssh-agent');

var smartdc = require('../lib/index');
var CloudAPI = smartdc.CloudAPI;


path.name = 'path';
url.name = 'url';



// --- Internal Functions

function usage(str, code, message) {
    assert.ok(str);

    var writer = console.log;
    if (code)
        writer = console.error;

    if (message)
        writer(message);
    writer(path.basename(process.argv[1]) + ' ' + str);
    process.exit(code || 0);
}


function buildUsageString(options) {
    assert.ok(options);

    var str = '';
    for (var k in options) {
        if (options.hasOwnProperty(k)) {
            var o = options[k].name ? options[k].name.toLowerCase() : '';
            str += '[--' + k + ' ' + o + '] ';
        }
    }
    return str;
}


// --- Exported API

module.exports = {

    /**
     * Common callback for all CLI operations.
     *
     * @param {Error} err optional error object.
     * @param {Object} obj optional response object.
     */
    callback: function (err, obj) {
        if (err) {
            console.error(err.message);
            process.exit(3);
        }

        if (obj)
        console.log(JSON.stringify(obj, null, 2));
    },


    usage: usage,


    buildUsageString: buildUsageString,


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

        try {
            return new CloudAPI({
                url: parsed.url,
                account: parsed.account,
                noCache: true,
                logLevel: 'fatal',
                sign: parsed.sign
            });
        } catch (e) {
            console.error(e.message);
            return process.exit(1);
        }
    }
};
