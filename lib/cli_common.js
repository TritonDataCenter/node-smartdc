// Copyright 2011 Joyent, Inc.  All rights reserved.

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var url = require('url');

var nopt = require('nopt');
var restify = require('restify');
var SSHAgentClient = require('ssh-agent');

var CloudAPI = require('../lib/index').CloudAPI;


path.name = 'path';
url.name = 'url';



///--- Globals

var log = restify.log;


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
    agent.requestIdentities(function(err, keys) {
      if (err || !keys || !keys.length) {
        log.debug('No ssh-agent identities found');
        return callback(null);
      }

      var path = parsed.identity.split('/');
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].type !== 'ssh-rsa')
          continue;

        var comment = keys[i].comment.split('/');
        if (path[path.length - 1] === comment[comment.length - 1]) {
          log.debug('Using ssh-agent identity: ' + keys[i].comment);
          parsed.signingKey = keys[i];
          parsed.sshAgent = agent;
          return callback(parsed);
        }

      }

      log.debug('No ssh-agent identity suitable: %o', keys);
      return callback(null);
    });
  } catch (e) {
    log.debug('Unable to load ssh-agent identities: ' + e);
    return callback(null);
  }
}


function loadSigningKey(parsed, callback) {
  assert.ok(parsed);
  assert.ok(callback);

  fs.readFile(parsed.identity, 'ascii', function(err, file) {
    if (err) {
      console.error(err.message);
      process.exit(2);
    }
    parsed.signingKey = file;
    return callback(parsed);
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
  callback: function(err, obj) {
    if (err) {
      console.error(err.message);
      process.exit(3);
    }

    if (obj)
      console.log(JSON.stringify(obj, null, 2));
  },


  usage: usage,


  buildUsageString: buildUsageString,


  parseArguments: function(options, shortOptions, callback, usageStr) {
    assert.ok(options);
    assert.ok(shortOptions);
    assert.ok(callback);

    if (!usageStr)
      usageStr = buildUsageString(options);

    var parsed = nopt(options, shortOptions, process.argv, 2);
    if (parsed.help)
      usage(usageStr);

    if (parsed.debug)
      restify.log.level(restify.LogLevel.Trace);

    if (!parsed.identity)
      parsed.identity = process.env.HOME + '/.ssh/id_rsa';

    if (!parsed.keyId) {
      if (process.env.SDC_CLI_KEY_ID) {
        parsed.keyId = process.env.SDC_CLI_KEY_ID;
      } else {
        parsed.keyId = 'id_rsa';
      }
    }

    if (!parsed.account)
      parsed.account = process.env.SDC_CLI_ACCOUNT;
    if (!parsed.account) {
      usage(usageStr, 1,
            'Either -a or (env) SDC_CLI_ACCOUNT must be specified');
    }

    if (!parsed.url)
      parsed.url = process.env.SDC_CLI_URL;
    if (!parsed.url) {
      usage(usageStr, 1,
            'Either -a or (env) SDC_CLI_URL must be specified');
    }


    return loadKeyFromAgent(parsed, function(_parsed) {

      if (_parsed) {
        log.debug('Found private key in SSH-Agent: %s', parsed.keyId);
        return callback(_parsed);
      }

      return loadSigningKey(parsed, function(_parsed) {
        if (!_parsed) {
          console.error('Unable to load a private key for signing (not found)');
          process.exit(2);
        }

        log.debug('Using private key from: %s', parsed.identity);
        return callback(_parsed);
      });
    });
  },


  newClient: function(parsed) {
    assert.ok(parsed);
    assert.ok(parsed.keyId);
    assert.ok(parsed.signingKey);

    try {
      return new CloudAPI({
        url: parsed.url,
        account: parsed.account,
        noCache: true,
        logLevel: restify.log.level(),
        key: parsed.signingKey,
        keyId: '/' + parsed.account + '/keys/' + parsed.keyId,
        sshAgent: parsed.sshAgent
      });
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  },


  loadKey: function(key) {
    try {
      return fs.readFileSync(key, 'ascii');
    } catch (e) {
      console.error('Unable to load key ' + key + ': ' + e);
      process.exit(2);
    }
  }

};
