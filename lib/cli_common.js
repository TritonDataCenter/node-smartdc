// Copyright 2012 Joyent, Inc.  All rights reserved.

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var url = require('url');

var httpSignature = require('http-signature');
var nopt = require('nopt');
var restify = require('restify');
var SSHAgentClient = require('ssh-agent');

var CloudAPI = require('../lib/index').CloudAPI;


path.name = 'path';
url.name = 'url';



///--- Globals

var getFingerprint = httpSignature.sshKeyFingerprint;

///--- Internal Functions

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


function loadKeyFromAgent(parsed, callback) {
    assert.ok(parsed);
    assert.ok(callback);

    try {
        var agent = new SSHAgentClient();
        return agent.requestIdentities(function (err, keys) {
            if (err || !keys || !keys.length) {
                if (parsed.debug) {
                    console.log('No ssh-agent identities found');
                }
                return callback(null);
            }

            var p = parsed.identity.split('/');
            for (var i = 0; i < keys.length; i++) {
                if (keys[i].type !== 'ssh-rsa')
                    continue;
                var comment = keys[i].comment.split('/');
                if (p[p.length - 1] === comment[comment.length - 1]) {
                    if (parsed.debug) {
                        console.log('Using ssh-agent identity: ' +
                            keys[i].comment);
                    }
                    parsed.signingKey = keys[i];
                    parsed.sshAgent = agent;
                    return callback(parsed);
                }
            }

            if (parsed.debug) {
                console.log('No ssh-agent identity suitable: %j', keys);
            }
            return callback(null);
        });
    } catch (e) {
        console.log('Unable to load ssh-agent identities: ' + e);
        return callback(null);
    }
}


function loadSigningKey(parsed, callback) {
    assert.ok(parsed);
    assert.ok(callback);

    return fs.readFile(parsed.identity, 'ascii', function (err, file) {
        if (err) {
            console.error(err.message);
            process.exit(2);
        }
        parsed.signingKey = file;

        if (parsed.keyId)
            return callback(parsed);

        return fs.readFile(parsed.identity + '.pub', 'ascii',
            function (err2, f) {
                if (err2) {
                    console.error(err2.message);
                    process.exit(2);
                }
                try {
                    parsed.keyId = getFingerprint(f);
                } catch (e) {
                    console.error('Unable to take fingerprint of public key: '
                        + e.stack);
                    process.exit(2);
                }

                return callback(parsed);
            });

    });
}



///--- Exported API

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
        process.exit(0);
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

        if (!parsed.identity) {
            if (process.env.SDC_CLI_IDENTITY) {
                parsed.identity = process.env.SDC_CLI_IDENTITY;
            } else {
                parsed.identity = process.env.HOME + '/.ssh/id_rsa';
            }
        }

        if (!parsed.keyId && process.env.SDC_CLI_KEY_ID)
            parsed.keyId = process.env.SDC_CLI_KEY_ID;

        if (!parsed.account) {
            parsed.account = process.env.SDC_CLI_ACCOUNT;
        }

        if (!parsed.account) {
            usage(usageStr, 1,
                'Either -a or (env) SDC_CLI_ACCOUNT must be specified');
        }

        if (!parsed.url) {
            parsed.url = process.env.SDC_CLI_URL;
        }

        if (!parsed.url) {
            usage(usageStr, 1,
                'Either -u or (env) SDC_CLI_URL must be specified');
        }


        return loadKeyFromAgent(parsed, function (_parsed) {

            if (_parsed) {
                if (typeof (parsed.keyId) === 'undefined') {
                    usage(usageStr, 1,
                        'Either -k or (env) SDC_CLI_KEY_ID must be specified');
                }
                if (parsed.debug) {
                    console.log('Found private key in SSH-Agent: %s',
                        parsed.keyId);
                }
                return callback(_parsed);
            }

            return loadSigningKey(parsed, function (_parsed2) {
                if (!_parsed2) {
                    console.error('Unable to load a private key' +
                        ' for signing (not found)');
                    process.exit(2);
                }

                if (parsed.debug) {
                    console.log('Using private key from: %s', parsed.identity);
                }
                return callback(_parsed2);
            });
        });
    },


    newClient: function (parsed) {
        assert.ok(parsed);
        assert.ok(parsed.keyId);
        assert.ok(parsed.signingKey);

        try {
            return new CloudAPI({
                url: parsed.url,
                account: parsed.account,
                noCache: true,
                logLevel: 'fatal',
                key: parsed.signingKey,
                keyId: '/' + parsed.account + '/keys/' + parsed.keyId,
                sshAgent: parsed.sshAgent
            });
        } catch (e) {
            console.error(e.message);
            return process.exit(1);
        }
    },


    loadKey: function (key) {
        try {
            return fs.readFileSync(key, 'ascii');
        } catch (e) {
            console.error('Unable to load key ' + key + ': ' + e);
            return process.exit(2);
        }
    }

};
