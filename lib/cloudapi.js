// Copyright 2012 Joyent, Inc.  All rights reserved.

var assert = require('assert');
var crypto = require('crypto');
var qs = require('querystring');

var util = require('util');
var sprintf = util.format;

var createCache = require('lru-cache');
var restify = require('restify');
var bunyan = require('bunyan');

///--- Globals

var log = bunyan.createLogger({
    level: 'info',
    name: 'SmartDC',
    stream: process.stderr,
    serializers: restify.bunyan.serializers
});
var RestCodes = restify.RestCodes;

var SIGNATURE = 'Signature keyId="%s",algorithm="%s" %s';

var ROOT = '/%s';
var KEYS = ROOT + '/keys';
var KEY = KEYS + '/%s';
var PACKAGES = ROOT + '/packages';
var PACKAGE = PACKAGES + '/%s';
var DATASETS = ROOT + '/datasets';
var DATASET = DATASETS + '/%s';
var DATACENTERS = ROOT + '/datacenters';
var MACHINES = ROOT + '/machines';
var MACHINE = MACHINES + '/%s';
var METADATA = MACHINE + '/metadata';
var METADATA_KEY = MACHINE + '/metadata/%s';
var SNAPSHOTS = MACHINE + '/snapshots';
var SNAPSHOT = SNAPSHOTS + '/%s';
var TAGS = MACHINE + '/tags';
var TAG = TAGS + '/%s';
var ANALYTICS = ROOT + '/analytics';
var INSTS = ANALYTICS + '/instrumentations';
var INST = INSTS + '/%s';
var INST_RAW = INST + '/value/raw';
var INST_HMAP = INST + '/value/heatmap/image';
var INST_HMAP_DETAILS = INST + '/value/heatmap/details';
var USAGE = ROOT + '/usage/%s';
var MACHINE_USAGE = MACHINE + '/usage/%s';



///--- Internal Helpers

function _clone(object) {
    assert.ok(object);

    var clone = {};

    var keys = Object.getOwnPropertyNames(object);
    keys.forEach(function (k) {
        var property = Object.getOwnPropertyDescriptor(object, k);
        Object.defineProperty(clone, k, property);
    });

    return clone;
}


function _encodeURI(path) {
    assert.ok(path);

    var ret = '';
    var str = '';
    var esc = false;

    function append() {
        if (str.length)
            ret += '/' + qs.escape(str);
        str = '';
        return ret;
    }

    for (var i = 0; i < path.length; i++) {
        if (!esc) {
            switch (path[i]) {
            case '\\':
                esc = true;
                break;
            case '/':
                append();
                break;
            default:
                str += path[i];
                break;
            }
        } else {
            str += path[i];
            esc = false;
        }
    }

    return append();
}

///--- Exported CloudAPI Client

/**
 * Constructor.
 *
 * Note that in options you can pass in any parameters that the restify
 * RestClient constructor takes (for example retry/backoff settings).
 *
 * In order to create a client, you either have to specify username and
 * password, in which case HTTP Basic Authentication will be used, or
 * preferably keyId and key, in which case HTTP Signature Authentication will
 * be used (much more secure).
 *
 * @param {Object} options object (required):
 *        - {String} url (required) CloudAPI location.
 *        - {String} account (optional) the login name to use (default my).
 *        - {Number} logLevel (optional) an enum value for the logging level.
 *        - {String} version (optional) api version (default ~6.5).
 *        - {String} username (optional) login name.
 *        - {String} password (optional) login password.
 *        - {String} keyId (optional) SSH key id in cloudapi to sign with.
 *        - {String} key (optional) SSH key (PEM) that goes with `keyId`.
 *        - {Boolean} noCache (optional) disable client caching (default false).
 *        - {Boolean} cacheSize (optional) number of cache entries (default 1k).
 *        - {Boolean} cacheExpiry (optional) entry age in seconds (default 60).
 * @throws {TypeError} on bad input.
 * @constructor
 */
function CloudAPI(options) {
    if (!options) throw new TypeError('options required');
    if (!options.url) throw new TypeError('options.url required');
    if (!(options.username && options.password) &&
      !(options.keyId && options.key))
        throw new TypeError('Either username/password or ' +
                'keyId/key are required');

    if (options.logLevel)
        log.level(options.logLevel);
    if (!options.version)
        options.version = '~6.5';
    this.account = options.account || 'my';

    options.contentType = 'application/json';

    options.retryCallback = function checkFor500(code) {
        return (code === 500);
    };

    this.client = restify.createJsonClient(options);

    this.options = _clone(options);

    // Try to use RSA Signing over BasicAuth
    if (options.key) {
        this.keyId = options.keyId;
        this.key = options.key;
        this.sshAgent = options.sshAgent;
    } else {
        this.basicAuth = true;
    }

    // Initialize the cache
    if (!options.noCache) {
        this.cacheSize = options.cacheSize || 1000;
        this.cacheExpiry = (options.cacheExpiry || 60) * 1000;
        this.cache = createCache(this.cacheSize);
    }

    // Secret ENV var to not provision (testing)
    if (process.env.SDC_TESTING) {
        log.warn('SDC_TESTING env var set: provisioning will *not* happen');
        this.__no_op = true;
    }
}


/**
 * Looks up your account record.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, account).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getAccount = function (account, callback, noCache) {
    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var self = this;
    return this._request(sprintf(ROOT, account), null, function (req) {
        return self._get(req, callback, noCache);
    });

};
CloudAPI.prototype.GetAccount = CloudAPI.prototype.getAccount;


/**
 * Creates an SSH key on your account.
 *
 * Returns a JS object (the created key). Note that options can actually
 * be just the key PEM, if you don't care about names.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options object containing:
 *                   - {String} name (optional) name for your ssh key.
 *                   - {String} key SSH public key.
 * @param {Function} callback of the form f(err, key).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.createKey = function (account, options, callback) {
    if (typeof (options) === 'function') {
        callback = options;
        options = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (!options ||
      (typeof (options) !== 'string' && typeof (options) !== 'object'))
        throw new TypeError('options (object) required');
    if (typeof (account) === 'object')
        account = account.login;

    if (typeof (options) === 'string') {
        options = {
            key: options
        };
    }

    var self = this;
    return this._request(sprintf(KEYS, account), options, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.CreateKey = CloudAPI.prototype.createKey;


/**
 * Lists all SSH keys on file for your account.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, keys).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.listKeys = function (account, callback, noCache) {
    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var self = this;
    this._request(sprintf(KEYS, account), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.ListKeys = CloudAPI.prototype.listKeys;


/**
 * Retrieves an SSH key from your account.
 *
 * Returns a JS object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} key can be either the string name of the key, or the object
 *                 returned from create/get.
 * @param {Function} callback of the form f(err, key).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getKey = function (account, key, callback, noCache) {
    if (typeof (key) === 'function') {
        callback = key;
        key = account;
        account = this.account;
    }
    if (!key || (typeof (key) !== 'object' && typeof (key) !== 'string'))
        throw new TypeError('key (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (key) === 'object' ? key.name : key);

    var self = this;
    this._request(sprintf(KEY, account, name), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.GetKey = CloudAPI.prototype.getKey;


/**
 * Deletes an SSH key from your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} key can be either the string name of the key, or the object
 *                 returned from create/get.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.deleteKey = function (account, key, callback) {
    if (typeof (key) === 'function') {
        callback = key;
        key = account;
        account = this.account;
    }

    if (!key || (typeof (key) !== 'object' && typeof (key) !== 'string'))
        throw new TypeError('key (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (key) === 'object' ? key.name : key);

    var self = this;
    return this._request(sprintf(KEY, account, name), null, function (req) {
        return self._del(req, callback);
    });
};
CloudAPI.prototype.DeleteKey = CloudAPI.prototype.deleteKey;


/**
 * Lists all packages available to your account.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, packages).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.listPackages = function (account, callback, noCache) {
    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var self = this;
    return this._request(sprintf(PACKAGES, account), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.ListPackages = CloudAPI.prototype.listPackages;


/**
 * Retrieves a single package available to your account.
 *
 * Returns a JS object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} pkg can be either the string name of the package, or an
 *                 object returned from listPackages.
 * @param {Function} callback of the form f(err, package).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getPackage = function (account, pkg, callback, noCache) {
    if (typeof (pkg) === 'function') {
        callback = pkg;
        pkg = account;
        account = this.account;
    }
    if (!pkg || (typeof (pkg) !== 'object' && typeof (pkg) !== 'string'))
        throw new TypeError('key (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (pkg) === 'object' ? pkg.name : pkg);

    var self = this;
    return this._request(sprintf(PACKAGE, account, name), null,
            function (req) {
                return self._get(req, callback, noCache);
            });
};
CloudAPI.prototype.GetPackage = CloudAPI.prototype.getPackage;


/**
 * Lists all datasets available to your account.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, datasets).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.listDatasets = function (account, callback, noCache) {
    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var self = this;
    return this._request(sprintf(DATASETS, account), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.ListDatasets = CloudAPI.prototype.listDatasets;


/**
 * Retrieves a single dataset available to your account.
 *
 * Returns a JS object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} dataset can be either the string name of the dataset, or an
 *                 object returned from listDatasets.
 * @param {Function} callback of the form f(err, package).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getDataset = function (account,
                                          dataset,
                                          callback,
                                          noCache) {
    if (typeof (dataset) === 'function') {
        callback = dataset;
        dataset = account;
        account = this.account;
    }
    if (!dataset ||
      (typeof (dataset) !== 'object' && typeof (dataset) !== 'string'))
        throw new TypeError('dataset (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (dataset) === 'object' ? dataset.id : dataset);

    var self = this;
    return this._request(sprintf(DATASET, account, name), null,
            function (req) {
                return self._get(req, callback, noCache);
            });
};
CloudAPI.prototype.GetDataset = CloudAPI.prototype.getDataset;


/**
 * Lists all datacenters available to your account.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, datacenters).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.listDatacenters = function (account, callback, noCache) {
    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var self = this;
    this._request(sprintf(DATACENTERS, account), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.ListDatacenters = CloudAPI.prototype.listDatacenters;


/**
 * Creates a new CloudAPI client connected to the specified datacenter.
 *
 * Returns a JS object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} datacenter can be either the string name of the datacenter,
 *                 or an object returned from listDatacenters.
 * @param {Function} callback of the form f(err, package).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.createClientForDatacenter = function (account,
                                                         datacenter,
                                                         callback,
                                                         noCache) {
    if (typeof (datacenter) === 'function') {
        callback = datacenter;
        datacenter = account;
        account = this.account;
    }
    if (typeof (datacenter) !== 'string')
        throw new TypeError('datacenter (string) required');
    if (!callback || typeof (callback) !== 'function')
       throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var self = this;
    return this.listDatacenters(account, function (err, datacenters) {
        if (err)
            return callback(self._error(err));

        if (!datacenters[datacenter]) {
            var e = new Error();
            e.name = 'CloudApiError';
            e.code = RestCodes.ResourceNotFound;
            e.message = 'datacenter ' + datacenter + ' not found';
            return callback(e);
        }

        var opts = _clone(self.options);
        opts.url = datacenters[datacenter];
        return callback(null, new CloudAPI(opts));
    });
};
CloudAPI.prototype.CreateClientForDatacenter =
    CloudAPI.prototype.createClientForDatacenter;


/**
 * Provisions a new smartmachine or virtualmachine.
 *
 * Returns a JS object (the created machine). Note that the options
 * object parameters like dataset/package can actually be the JS objects
 * returned from the respective APIs.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options (optional) object containing:
 *                   - {String} name (optional) name for your machine.
 *                   - {String} dataset (optional) dataset to provision.
 *                   - {String} package (optional) package to provision.
 * @param {Function} callback of the form f(err, machine).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.createMachine = function (account, options, callback) {
    if (typeof (account) === 'function') {
        callback = account;
        options = {};
        account = this.account;
    }
    if (typeof (options) === 'function') {
        callback = options;
        options = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (options) !== 'object')
        throw new TypeError('options must be an object');
    if (options.name && typeof (options.name) !== 'string')
        throw new TypeError('options.name must be a string');
    if (typeof (account) === 'object')
        account = account.login;

    if (options.dataset) {
        switch (typeof (options.dataset)) {
        case 'string':
            // noop
            break;
        case 'object':
            options.dataset = options.dataset.id;
            break;
        default:
            throw new TypeError('options.dataset must be a string or object');
        }
    }

    if (options['package']) {
        switch (typeof (options['package'])) {
        case 'string':
            // noop
            break;
        case 'object':
            options['package'] = options['package'].id;
            break;
        default:
            throw new TypeError('options.package must be a string or object');
        }
    }

    // Undocumented flag to skip the actual call (testing only)
    if (this.__no_op)
        return callback(null, {});

    var self = this;
    return this._request(sprintf(MACHINES, account), options, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.CreateMachine = CloudAPI.prototype.createMachine;


/**
 * Counts all machines running under your account.
 *
 * This API call takes all the same options as ListMachines.  However,
 * instead of returning a set of machine objects, it returns the count
 * of machines that would be returned.
 *
 * achine listings are both potentially large and
 * volatile, so this API explicitly does no caching.
 *
 * Returns an integer, and a boolean that indicates whether there
 * are more records (i.e., you got paginated).  If there are, call this
 * again with offset=count.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options (optional) sets filtration/pagination:
 *                 - {String} name (optional) machines with this name.
 *                 - {String} dataset (optional) machines with this dataset.
 *                 - {String} package (optional) machines with this package.
 *                 - {String} type (optional) smartmachine or virtualmachine.
 *                 - {String} state (optional) machines in this state.
 *                 - {Number} memory (optional) machines with this memory.
 *                 - {Number} offset (optional) pagination starting point.
 *                 - {Number} limit (optional) cap on the number to return.
 * @param {Function} callback of the form f(err, machines, moreRecords).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.countMachines = function (account, options, callback) {
    if (typeof (account) === 'function') {
        callback = account;
        options = {};
        account = this.account;
    }
    if (typeof (options) === 'function') {
        callback = options;
        options = account;
        account = this.account;
    }
    if (typeof (options) !== 'object')
        throw new TypeError('options must be an object');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var self = this;
    return this._request(sprintf(MACHINES, account), null, function (req) {
        req.query = options;
        req.cacheTTL = (15 * 1000);
        return self.client.head(req, function (err, headers) {
            if (err)
                return callback(self._error(err));

            var done = true;
            if (headers['x-resource-count'] && headers['x-query-limit'])
                done = (parseInt(headers['x-resource-count'], 10) <
                parseInt(headers['x-query-limit'], 10) + req.query.offset);

            var count = +headers['x-resource-count'];

            log.debug('CloudAPI._head(%s) -> err=%o, count=%d, done=%s',
                req.path, err, count, done);
            return callback(err, count, done);
        });
    });
};
CloudAPI.prototype.CountMachines = CloudAPI.prototype.countMachines;


/**
 * Lists all machines running under your account.
 *
 * This API call does a 'deep list', so you shouldn't need to go
 * back over the wan on each id.  Also, note that this API supports
 * filters and pagination; use the options object.  If you don't set
 * them you'll get whatever the server has set for pagination/limits.
 *
 * Also, note that machine listings are both potentially large and
 * volatile, so this API explicitly does no caching.
 *
 * Returns an array of objects, and a boolean that indicates whether there
 * are more records (i.e., you got paginated).  If there are, call this
 * again with offset=machines.length.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options (optional) sets filtration/pagination:
 *                 - {String} name (optional) machines with this name.
 *                 - {String} dataset (optional) machines with this dataset.
 *                 - {String} package (optional) machines with this package.
 *                 - {String} type (optional) smartmachine or virtualmachine.
 *                 - {String} state (optional) machines in this state.
 *                 - {Number} memory (optional) machines with this memory.
 *                 - {Number} offset (optional) pagination starting point.
 *                 - {Number} limit (optional) cap on the number to return.
 * @param {Object} tags (optional) k/v hash of tags.
 * @param {Function} callback of the form f(err, machines, moreRecords).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.listMachines = function (account, options, tags, callback) {
    if (typeof (account) === 'function') {
        callback = account;
        tags = {};
        options = {};
        account = this.account;
    }
    if (typeof (options) === 'function') {
        callback = options;
        tags = {};
        options = account;
        account = this.account;
    }
    if (typeof (tags) === 'function') {
        callback = tags;
        if (typeof (account) === 'object') {
            tags = options;
            options = account;
            account = this.account;
        } else {
            tags = {};
            options = account;
            account = this.account;
        }
    }
    if (typeof (options) !== 'object')
        throw new TypeError('options must be an object');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    for (var k in tags) {
        if (tags.hasOwnProperty(k)) {
            options['tag.' + k] = tags[k];
        }
    }

    var self = this;
    return this._request(sprintf(MACHINES, account), null, function (req) {
        req.query = options;
        return self.client.get(req, function (err, request, res, obj) {
            if (err) {
                log.error({err: err},
                    util.format('CloudAPI._get(%s)', req.path));
                return callback(self._error(err));
            }

            var done = true;
            if (typeof (req.query.offset) === 'undefined') {
                req.query.offset = 0;
            }
            if (res.headers['x-resource-count'] &&
                        res.headers['x-query-limit'])
                done = (parseInt(res.headers['x-resource-count'], 10) <
                parseInt(res.headers['x-query-limit'], 10) + req.query.offset);

            log.debug('CloudAPI._get(%s) -> err=%o, obj=%o, done=%s',
                            req.path, err, obj, done);
            return callback(err, obj, done);
        });
    });
};
CloudAPI.prototype.ListMachines = CloudAPI.prototype.listMachines;


/**
 * Gets a single machine under your account.
 *
 * Also, note that machine listings are fairly volatile, so this API
 * explicitly sets the cache TTL to 15s. You can bypass caching altogether
 * with the `noCache` param.
 *
 * Returns a JS object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err, machine).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getMachine = function (account,
                                          machine,
                                          getCredentials,
                                          callback,
                                          noCache) {
    if (typeof (machine) === 'function') {
        callback = machine;
        getCredentials = false;
        machine = account;
        account = this.account;
    }
    if (typeof (getCredentials) === 'function') {
        callback = getCredentials;
        getCredentials = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (typeof (getCredentials) !== 'boolean')
        throw new TypeError('getCredentials must be a boolean');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (machine) === 'object' ? machine.id : machine);

    var self = this;
    var path = sprintf(MACHINE, account, name);
    return this._request(path, null, function (req) {
        req.cacheTTL = (15 * 1000);
        if (getCredentials)
            req.path += '?credentials=true';
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.GetMachine = CloudAPI.prototype.getMachine;


/**
 * Reboots a machine under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.rebootMachine = function (account, machine, callback) {
    if (typeof (machine) === 'function') {
        callback = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return this._updateMachine(account, machine, 'reboot', callback);
};
CloudAPI.prototype.RebootMachine = CloudAPI.prototype.rebootMachine;


/**
 * Shuts down a machine under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.stopMachine = function (account, machine, callback) {
    if (typeof (machine) === 'function') {
        callback = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return this._updateMachine(account, machine, 'stop', callback);
};
CloudAPI.prototype.StopMachine = CloudAPI.prototype.stopMachine;


/**
 * Boots up a machine under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.startMachine = function (account, machine, callback) {
    if (typeof (machine) === 'function') {
        callback = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return this._updateMachine(account, machine, 'start', callback);
};
CloudAPI.prototype.StartMachine = CloudAPI.prototype.startMachine;


/**
 * Resizes a machine under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.resizeMachine = function (account,
                                             machine,
                                             options,
                                             callback) {
    if (typeof (options) === 'function') {
        callback = options;
        options = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!options || typeof (options) !== 'object')
        throw new TypeError('options (object) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return this._updateMachine(account, machine, 'resize', options, callback);
};
CloudAPI.prototype.ResizeMachine = CloudAPI.prototype.resizeMachine;


/**
 * Deletes a machine under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.deleteMachine = function (account, machine, callback) {
    if (typeof (machine) === 'function') {
        callback = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (machine) === 'object' ? machine.id : machine);
    var self = this;
    return this._request(sprintf(MACHINE, account, name), null,
            function (req) {
                return self._del(req, callback);
            });
};
CloudAPI.prototype.DeleteMachine = CloudAPI.prototype.deleteMachine;


/**
 * Creates a new snapshots for a given machine.
 *
 * Note that the machine must be a smartmachine for snapshots to work.
 * This API explicitly disables caching.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.createMachineSnapshot = function (account,
                                                     machine,
                                                     options,
                                                     callback) {
    if (typeof (options) === 'function') {
        callback = options;
        options = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!options || typeof (options) !== 'object')
        throw new TypeError('options (object) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var m = (typeof (machine) === 'object' ? machine.id : machine);

    var self = this;
    return this._request(sprintf(SNAPSHOTS, account, m), options,
            function (req) {
                return self._post(req, callback);
            });
};
CloudAPI.prototype.CreateMachineSnapshot =
    CloudAPI.prototype.createMachineSnapshot;


/**
 * Lists all snapshots for a given machine.
 *
 * Note that the machine must be a smartmachine for snapshots to work.
 * This API explicitly disables caching.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.listMachineSnapshots = function (account,
                                                    machine,
                                                    callback) {
    if (typeof (machine) === 'function') {
        callback = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var m = (typeof (machine) === 'object' ? machine.id : machine);

    var self = this;
    return this._request(sprintf(SNAPSHOTS, account, m), null, function (req) {
        return self._get(req, callback, true);
    });
};
CloudAPI.prototype.ListMachineSnapshots =
    CloudAPI.prototype.listMachineSnapshots;


/**
 * Gets a single snapshot for a given machine.
 *
 * Note that the machine must be a smartmachine for snapshots to work.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {String} snapshot either the name, or can be the object returned in
 *                 list or create.
 * @param {Function} callback of the form f(err).
 * @param {Boolean} noCache disable caching of this result.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getMachineSnapshot = function (account,
                                                  machine,
                                                  snapshot,
                                                  callback,
                                                  noCache) {
    if (typeof (snapshot) === 'function') {
        callback = snapshot;
        snapshot = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!snapshot ||
      (typeof (snapshot) !== 'object' && typeof (snapshot) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var a = (typeof (account) === 'object' ? account.login : account);
    var m = (typeof (machine) === 'object' ? machine.id : machine);
    var s = (typeof (snapshot) === 'object' ? snapshot.name : snapshot);

    var self = this;
    return this._request(sprintf(SNAPSHOT, a, m, s), null, function (req) {
        return self._get(req, callback, noCache);
    });

};
CloudAPI.prototype.GetMachineSnapshot = CloudAPI.prototype.getMachineSnapshot;


/**
 * Boots a machine from a snapshot.
 *
 * Note that the machine must be a smartmachine for snapshots to work.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {String} snapshot either the name, or can be the object returned in
 *                 list or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.startMachineFromSnapshot = function (account,
                                                        machine,
                                                        snapshot,
                                                        callback) {

    if (typeof (snapshot) === 'function') {
        callback = snapshot;
        snapshot = machine;
        machine = account;
        account = this.account;
    }

    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!snapshot ||
      (typeof (snapshot) !== 'object' && typeof (snapshot) !== 'string'))
        throw new TypeError('snapshot (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');

    var a = (typeof (account) === 'object' ? account.login : account);
    var m = (typeof (machine) === 'object' ? machine.id : machine);
    var s = (typeof (snapshot) === 'object' ? snapshot.name : snapshot);

    var self = this;
    return this._request(sprintf(SNAPSHOT, a, m, s), null, function (req) {
        req.expect = 202;
        return self._post(req, callback);
    });

};
CloudAPI.prototype.StartMachineFromSnapshot =
    CloudAPI.prototype.startMachineFromSnapshot;


/**
 * Deletes a machine snapshot.
 *
 * Note that the machine must be a smartmachine for snapshots to work.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {String} snapshot either the name, or can be the object returned in
 *                 list or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.deleteMachineSnapshot = function (account,
                                                     machine,
                                                     snapshot,
                                                     callback) {
    if (typeof (snapshot) === 'function') {
        callback = snapshot;
        snapshot = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!snapshot ||
      (typeof (snapshot) !== 'object' && typeof (snapshot) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var a = (typeof (account) === 'object' ? account.login : account);
    var m = (typeof (machine) === 'object' ? machine.id : machine);
    var s = (typeof (snapshot) === 'object' ? snapshot.name : snapshot);

    var self = this;
    return this._request(sprintf(SNAPSHOT, a, m, s), null, function (req) {
        return self._del(req, callback);
    });

};
CloudAPI.prototype.DeleteMachineSnapshot =
    CloudAPI.prototype.deleteMachineSnapshot;



/**
 * Adds the set of tags to the machine.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Object} tags tags dictionary.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.addMachineTags = function (account,
                                              machine,
                                              tags,
                                              callback) {
    if (typeof (tags) === 'function') {
        callback = tags;
        tags = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!tags || typeof (tags) !== 'object')
        throw new TypeError('tags (object) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var m = (typeof (machine) === 'object' ? machine.id : machine);

    var self = this;
    return this._request(sprintf(TAGS, account, m), tags, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.AddMachineTags = CloudAPI.prototype.addMachineTags;


/**
 * Gets the set of tags from a machine
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.listMachineTags = function (account, machine, callback) {
    if (typeof (machine) === 'function') {
        callback = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var m = (typeof (machine) === 'object' ? machine.id : machine);

    var self = this;
    return this._request(sprintf(TAGS, account, m), null, function (req) {
        return self._get(req, callback);
    });
};
CloudAPI.prototype.ListMachineTags = CloudAPI.prototype.listMachineTags;


/**
 * Retrieves a single tag from a machine.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {String} tag a tag name to get.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getMachineTag = function (account, machine, tag, callback) {
    if (typeof (tag) === 'function') {
        callback = tag;
        tag = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!tag || typeof (tag) !== 'string')
        throw new TypeError('tag (string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var m = (typeof (machine) === 'object' ? machine.id : machine);

    var self = this;
    return this._request(sprintf(TAG, account, m, tag), null, function (req) {
        req.headers.Accept = 'text/plain';
        return self._get(req, callback);
    });
};
CloudAPI.prototype.GetMachineTag = CloudAPI.prototype.getMachineTag;


/**
 * Deletes ALL tags from a machine
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.deleteMachineTags = function (account, machine, callback) {
    if (typeof (machine) === 'function') {
        callback = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var m = (typeof (machine) === 'object' ? machine.id : machine);

    var self = this;
    return this._request(sprintf(TAGS, account, m), null, function (req) {
        return self._del(req, callback);
    });
};
CloudAPI.prototype.DeleteMachineTags = CloudAPI.prototype.deleteMachineTags;


/**
 * Deletes a single tag from a machine.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {String} tag a tag name to purge.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.deleteMachineTag = function (account,
                                                machine,
                                                tag,
                                                callback) {
    if (typeof (tag) === 'function') {
        callback = tag;
        tag = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!tag || typeof (tag) !== 'string')
        throw new TypeError('tag (string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var m = (typeof (machine) === 'object' ? machine.id : machine);

    var self = this;
    return this._request(sprintf(TAG, account, m, tag), null, function (req) {
        return self._del(req, callback);
    });
};
CloudAPI.prototype.DeleteMachineTag = CloudAPI.prototype.deleteMachineTag;


/**
 * Retrieves metadata from a machine.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Boolean} getCredentials whether or not to return passwords
 *                  (default is false).
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getMachineMetadata = function (account,
                                                  machine,
                                                  getCredentials,
                                                  callback) {
    if (typeof (machine) === 'function') {
        callback = machine;
        getCredentials = false;
        machine = account;
        account = this.account;
    }
    if (typeof (getCredentials) === 'function') {
        callback = getCredentials;
        getCredentials = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (typeof (getCredentials) !== 'boolean')
        throw new TypeError('getCredentials must be a boolean');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var m = (typeof (machine) === 'object' ? machine.id : machine);

    var self = this;
    var path = sprintf(METADATA, account, m);
    return this._request(path, null, function (req) {
        if (getCredentials)
            req.path += '?credentials=true';
        return self._get(req, callback);
    });
};
CloudAPI.prototype.GetMachineMetadata = CloudAPI.prototype.getMachineMetadata;


/**
 * Updates the metadata on a machine.  Creates key/value pairs if they don't
 * exist, and replaces values for a key if they do not.
 *
 * Note this method will only partially replace the metadata. That is, if you
 * have machine metadata like:
 *
 * {
 *   "foo": "bar",
 *   "pet": "dog"
 * }
 *
 * And you only pass in pet=cat, the resulting metadata will be:
 *
 * {
 *   "foo": "bar",
 *   "pet": "cat"
 * }
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Object} metadata new metadata elements to write.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.updateMachineMetadata = function (account,
                                                     machine,
                                                     metadata,
                                                     callback) {
    if (typeof (metadata) === 'function') {
        callback = metadata;
        metadata = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var m = (typeof (machine) === 'object' ? machine.id : machine);

    var self = this;
    return this._request(sprintf(METADATA, account, m), metadata,
            function (req) {
                return self._post(req, function (err, obj) {
                    callback(err, obj);
                });
            });
};
CloudAPI.prototype.UpdateMachineMetadata =
    CloudAPI.prototype.updateMachineMetadata;


/**
 * Deletes individual metadata keys from a machine.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {String} key metadata key to purge.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.deleteMachineMetadata = function (account,
                                                     machine,
                                                     key,
                                                     callback) {
    if (typeof (key) === 'function') {
        callback = key;
        key = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var m = (typeof (machine) === 'object' ? machine.id : machine);

    var self = this;
    var path;
    if (key === '*') {
        path = sprintf(METADATA, account, m);
    } else {
        path = sprintf(METADATA_KEY, account, m, key);
    }
    return this._request(path, null, function (req) {
        return self._del(req, function (err, obj) {
            callback(err, obj);
        });
    });
};
CloudAPI.prototype.DeleteMachineMetadata =
    CloudAPI.prototype.deleteMachineMetadata;


/**
 * Dumps the "metrics" used in all requets to /analytics.
 *
 * Returns a big object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, metrics).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.describeAnalytics = function (account, callback, noCache) {
    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var self = this;
    return this._request(sprintf(ANALYTICS, account), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.DescribeAnalytics = CloudAPI.prototype.describeAnalytics;
CloudAPI.prototype.getMetrics = CloudAPI.prototype.describeAnalytics;
CloudAPI.prototype.GetMetrics = CloudAPI.prototype.describeAnalytics;


/**
 * Creates an instrumentation under your account.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options instrumentation options. (see CA docs).
 * @param {Function} callback of the form f(err, instrumentation).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.createInst = function (account, options, callback, noCache) {
    if (typeof (options) === 'function') {
        callback = options;
        options = account;
        account = this.account;
    }
    if (!options || typeof (options) !== 'object')
        throw new TypeError('options (object) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var self = this;
    return this._request(sprintf(INSTS, account), options, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.createInstrumentation = CloudAPI.prototype.createInst;
CloudAPI.prototype.CreateInstrumentation = CloudAPI.prototype.createInst;


/**
 * Lists instrumentations under your account.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, schema).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.listInsts = function (account, callback, noCache) {
    if (typeof (account) === 'function') {
        noCache = callback;
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var self = this;
    return this._request(sprintf(INSTS, account), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.listInstrumentations = CloudAPI.prototype.listInsts;
CloudAPI.prototype.ListInstrumentations = CloudAPI.prototype.listInsts;


/**
 * Gets an instrumentation under your account.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Number} inst either the id, or can be the object returned
 *                 in list or create.
 * @param {Function} callback of the form f(err, instrumentation).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getInst = function (account, inst, callback, noCache) {
    if (typeof (inst) === 'function') {
        noCache = callback;
        callback = inst;
        inst = account;
        account = this.account;
    }

    if (!inst || (typeof (inst) !== 'object' && typeof (inst) !== 'number'))
        throw new TypeError('inst (object|number) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (inst) === 'object' ? inst.id : inst);
    var self = this;
    return this._request(sprintf(INST, account, name), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.getInstrumentation = CloudAPI.prototype.getInst;
CloudAPI.prototype.GetInstrumentation = CloudAPI.prototype.getInst;


/**
 * Gets an instrumentation raw value under your account.
 *
 * This call is not cachable.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Number} inst either the id, or can be the object returned
 *                 in list or create.
 * @param {Function} callback of the form f(err, instrumentation).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getInstValue = function (account, inst, callback) {
    if (typeof (inst) === 'function') {
        callback = inst;
        inst = account;
        account = this.account;
    }
    if (typeof (inst) !== 'object' && typeof (inst) !== 'number')
        throw new TypeError('inst (object|number) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (inst) === 'object' ? inst.id : inst);
    var self = this;
    return this._request(sprintf(INST_RAW, account, name), null,
            function (req) {
                return self._get(req, callback, true);
            });
};
CloudAPI.prototype.getInstrumentationValue = CloudAPI.prototype.getInstValue;
CloudAPI.prototype.GetInstrumentationValue = CloudAPI.prototype.getInstValue;


/**
 * Gets an instrumentation heatmap image under your account.
 *
 * This call is not cachable.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Number} inst either the id, or can be the object returned
 *                 in list or create.
 * @param {Object} options object, from command line.
 * @param {Function} callback of the form f(err, instrumentation).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getInstHmap = function (account, inst, options, callback) {
    if (typeof (options) === 'function') {
        callback = options;
        options = inst;
        inst = account;
        account = this.account;
    }

    if (!inst || (typeof (inst) !== 'object' && typeof (inst) !== 'number'))
        throw new TypeError('inst (object|number) required');
    if (!options || typeof (options) !== 'object')
        throw new TypeError('options (object) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (inst) === 'object' ? inst.id : inst);
    var self = this;

    this._request(sprintf(INST_HMAP, account, name), null, function (req) {
        req.query = options;
        return self._get(req, callback, true);
    });
};
CloudAPI.prototype.getInstrumentationHeatmap = CloudAPI.prototype.getInstHmap;
CloudAPI.prototype.GetInstrumentationHeatmap = CloudAPI.prototype.getInstHmap;


/**
 * Gets an instrumentation heatmap image details.
 *
 * This call is not cachable.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Number} inst either the id, or can be the object returned
 *                 in list or create.
 * @param {Object} options with x and y, as {Number}. Required.
 * @param {Function} callback of the form f(err, instrumentation).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getInstHmapDetails = function (account,
                                                  inst,
                                                  options,
                                                  callback) {
    if (typeof (options) === 'function') {
        callback = options;
        options = inst;
        inst = account;
        account = this.account;
    }
    if (!inst || (typeof (inst) !== 'object' && typeof (inst) !== 'number'))
        throw new TypeError('inst (object|number) required');
    if (!options || typeof (options) !== 'object')
        throw new TypeError('options (object) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (inst) === 'object' ? inst.id : inst);
    var self = this;
    return this._request(sprintf(INST_HMAP_DETAILS, account, name), null,
                       function (req) {
                           req.query = options;
                           return self._get(req, callback, true);
                       });
};
CloudAPI.prototype.getInstrumentationHeatmapDetails =
    CloudAPI.prototype.getInstHmapDetails;
CloudAPI.prototype.GetInstrumentationHeatmapDetails =
    CloudAPI.prototype.getInstHmapDetails;


/**
 * Deletes an instrumentation under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Number} inst either the id, or can be the object returned
 *                 in list or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.delInst = function (account, inst, callback) {
    if (typeof (inst) === 'function') {
        callback = inst;
        inst = account;
        account = this.account;
    }
    if (!inst || (typeof (inst) !== 'object' && typeof (inst) !== 'number'))
        throw new TypeError('inst (object|number) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (inst) === 'object' ? inst.id + '' : inst);
    var self = this;
    return this._request(sprintf(INST, account, name), null, function (req) {
        return self._del(req, callback);
    });
};
CloudAPI.prototype.deleteInstrumentation = CloudAPI.prototype.delInst;
CloudAPI.prototype.DeleteInstrumentation = CloudAPI.prototype.delInst;


/**
 * Gets a usage object of all machines in cloud within a period
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} period The yyyy-mm period in which to get usage.
 * @param {Function} callback
 * @param {Boolean} noCache (optional) Flag to skip the cache
 */
CloudAPI.prototype.getUsage = function (account,
                                        period,
                                        callback,
                                        noCache) {
    if (typeof (period) === 'function') {
        callback = period;
        period = account;
        account = this.account;
    }

    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (!period || typeof (period) !== 'string' ||
        !period.match(/^[0-9]{4}-[0-9]{1,2}$/))
        throw new TypeError('period (string, YYYY-MM) required');

    if (typeof (account) === 'object')
        account = account.login;

    var self = this;
    var path = sprintf(USAGE, account, period);
    return this._request(path, null, function (req) {
        return self._get(req, callback, noCache);
    });
};



/**
 * Gets a usage object of a given machine within period
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine the uuid of the machine, or an object from create
 *                         or list.
 * @param {String} period The yyyy-mm period in which to get usage.
 * @param {Function} callback
 * @param {Boolean} noCache (optional) Flag to skip the cache
 */
CloudAPI.prototype.getMachineUsage = function (account,
                                               machine,
                                               period,
                                               callback,
                                               noCache) {
    if (typeof (period) === 'function') {
        callback = period;
        period = machine;
        machine = account;
        account = this.account;
    }

    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (!period || typeof (period) !== 'string' ||
        !period.match(/^[0-9]{4}-[0-9]{1,2}$/))
        throw new TypeError('period (string, YYYY-MM) required');

    if (typeof (account) === 'object')
        account = account.login;

    if (typeof (machine) === 'object')
        machine = machine.id;

    var self = this;
    var path = sprintf(MACHINE_USAGE, account, machine, period);
    return this._request(path, null, function (req) {
        return self._get(req, callback, noCache);
    });
};




///--- Private Functions

CloudAPI.prototype._updateMachine = function (account,
                                              machine,
                                              action,
                                              params,
                                              callback) {
    assert.ok(account);
    assert.ok(machine);
    assert.ok(action);
    assert.ok(params);
    if (typeof (params) === 'function') {
        callback = params;
        params = {};
    }
    assert.ok(callback);

    params.action = action;

    var name = (typeof (machine) === 'object' ? machine.id : machine);
    var self = this;
    return this._request(sprintf(MACHINE, account, name), null, function (req) {
        req.expect = 202;
        req.query = params;
        return self._post(req, callback);
    });
};


CloudAPI.prototype._error = function (err) {
    assert.ok(err);

    function _newError(code, message) {
        var e = new Error();
        e.name = 'CloudApiError';
        e.code = code;
        e.message = message;
        return e;
    }

    if (err.details && err.httpCode >= 500) {
        if (err.details.code && err.details.message) {
            return _newError(err.details.code, err.details.message);
        } else if (err.details.object && err.details.object.code) {
            return _newError(err.details.object.code,
                                err.details.object.message);
        } else if (err.details.body || typeof (err.details) === 'string') {
            try {
                var response = JSON.parse(err.details.body || err.details);
                if (response && response.code && response.message)
                    return _newError(response.code, response.message);
            } catch (e) {
                log.warn('Invalid JSON for err=%o => %o', err, e);
            }
        }
    }

    return err;
};


CloudAPI.prototype._get = function (req, callback, noCache) {
    assert.ok(req);
    assert.ok(callback);

    var self = this;

    // Check the cache first
    if (!noCache) {
        var cached = this._cacheGet(req.path, req.cacheTTL);
        if (cached) {
            if (cached instanceof Error)
                return callback(cached);

            return callback(null, cached);
        }
    }

    // Issue HTTP request
    return this.client.get(req, function (err, request, res, obj) {
        if (err) {
            err = self._error(err);
            log.error({err: err}, util.format('CloudAPI._get(%s)', req.path));
        }

        if (obj) {
            self._cachePut(req.path, obj);
            log.debug(obj, util.format('CloudAPI._get(%s)', req.path));
        }

        return callback(err, obj);
    });
};


CloudAPI.prototype._post = function (req, callback) {
    assert.ok(req);
    assert.ok(callback);

    var self = this,
        body = req.body || {};
    delete req.body;

    // Issue HTTP request
    return this.client.post(req, body, function (err, request, res, obj) {
        if (err) {
            err = self._error(err);
            log.error({err: err}, util.format('CloudAPI._get(%s)', req.path));
        } else {
            log.debug(obj, util.format('CloudAPI._post(%s)', req.path));
        }
        return callback(err, obj);
    });
};


CloudAPI.prototype._del = function (req, callback) {
    assert.ok(req);
    assert.ok(callback);

    var self = this;

    // Issue HTTP request
    return this.client.del(req, function (err, request, res, obj) {
        if (err) {
            err = self._error(err);
        } else {
            self._cachePut(req.path, null);
        }

        log.debug('CloudAPI._del(%s) -> err=%o', req.path, err);
        return callback(err);
    });
};


CloudAPI.prototype._request = function (path, body, callback) {
    assert.ok(path);
    assert.ok(body !== undefined);
    assert.ok(callback);

    var self = this;
    var now = new Date().toUTCString();


    var obj = {
        path: _encodeURI(path),
        headers: {
            Date: now,
            'x-api-version': '~6.5'
        }
    };
    if (body)
        obj.body = body;

    if (this.basicAuth) {
        self.client.basicAuth(self.options.username, self.options.password);
    } else {
        if (!this.sshAgent) {
            var alg = / DSA /.test(this.key) ? 'DSA-SHA1' : 'RSA-SHA256';
            var signer = crypto.createSign(alg);
            signer.update(now);
            obj.headers.Authorization = sprintf(SIGNATURE,
                                          this.keyId,
                                          alg.toLowerCase(),
                                          signer.sign(this.key, 'base64'));
        } else {
            return this.sshAgent.sign(this.key, new Buffer(now),
                    function (err, sig) {
                        if (!err && sig) {
                            var algo = /DSA/i.test(self.key) ?
                                        'dsa-sha1' : 'rsa-sha1';
                            obj.headers.Authorization = sprintf(SIGNATURE,
                                                              self.keyId,
                                                              algo,
                                                              sig.signature);
                        }

                        return callback(obj);
                    });
        }
    }

    return callback(obj);
};


CloudAPI.prototype._cachePut = function (key, value) {
    assert.ok(key);

    if (!this.cache)
        return false;

    if (value === null) {
        // Do a purge
        log.debug('CloudAPI._cachePut(%s): purging', key);
        return this.cache.set(key, null);
    }

    var obj = {
        value: value,
        ctime: new Date().getTime()
    };
    log.debug('CloudAPI._cachePut(%s): writing %o', key, obj);
    this.cache.set(key, obj);
    return true;
};


CloudAPI.prototype._cacheGet = function (key, expiry) {
    assert.ok(key);

    if (!this.cache)
        return null;

    var maxAge = expiry || this.cacheExpiry;

    var obj = this.cache.get(key);
    if (obj) {
        assert.ok(obj.ctime);
        assert.ok(obj.value);
        var now = new Date().getTime();
        if ((now - obj.ctime) <= maxAge) {
            log.debug('CloudAPI._cacheGet(%s): cache hit => %o', key, obj);
            return obj.value;
        }
    }

    log.debug('CloudAPI._cacheGet(%s): cache miss', key);
    return null;
};



// --- Exports

module.exports = {

    CloudAPI: CloudAPI,

    createClient: function (options) {
        return new CloudAPI(options);
    }

};
