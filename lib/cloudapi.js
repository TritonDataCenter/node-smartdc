/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var cli = require('./cli');
var crypto = require('crypto');
var qs = require('querystring');
var util = require('util');
var sprintf = util.format;
var os = require('os');
var createCache = require('lru-cache');
var restify = require('restify');
var bunyan = require('bunyan');
var clone = require('clone');
var auth = require('smartdc-auth');


// --- Globals


var log = bunyan.createLogger({
    level: 'fatal',
    name: 'smartdc',
    stream: process.stderr,
    serializers: restify.bunyan.serializers
});

var API_VERSION = '~7.2';
var VERSION = require('../package.json').version;
var RESTIFY_VERSION = 'unknown';
try {
    RESTIFY_VERSION = require('../node_modules/restify/package.json').version;
} catch (e) {}

var SIGNATURE = 'Signature keyId="/%s/keys/%s",algorithm="%s" %s';

var ROOT = '/%s';
var KEYS = ROOT + '/keys';
var KEY = KEYS + '/%s';
var PACKAGES = ROOT + '/packages';
var PACKAGE = PACKAGES + '/%s';
var DATASETS = ROOT + '/datasets';
var DATASET = DATASETS + '/%s';
var IMAGES = ROOT + '/images';
var IMAGE = IMAGES + '/%s';
var DATACENTERS = ROOT + '/datacenters';
var MACHINES = ROOT + '/machines';
var MACHINE = MACHINES + '/%s';
var METADATA = MACHINE + '/metadata';
var NICS = MACHINE + '/nics';
var NIC = NICS + '/%s';
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
var AUDIT = MACHINE + '/audit';
var FWRULES = ROOT + '/fwrules';
var FWRULE = FWRULES + '/%s';
var NETWORKS = ROOT + '/networks';
var NETWORK = NETWORKS + '/%s';
var USERS = ROOT + '/users';
var USER = USERS + '/%s';
var POLICIES = ROOT + '/policies';
var POLICY = POLICIES + '/%s';
var ROLES = ROOT + '/roles';
var ROLE = ROLES + '/%s';
var SUB_KEYS = USER + '/keys';
var SUB_KEY = SUB_KEYS + '/%s';


// --- Internal Helpers


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


function _signRequest(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.headers, 'options.headers');
    assert.func(cb, 'callback');

    if (!opts.sign) {
        return (cb(null));
    }

    assert.func(opts.sign, 'options.sign');

    opts.sign(opts.headers.date, function signedCb(err, obj) {
        if (err) {
            return (cb(err));
        }

        if (obj === null) {
            return (cb(null));
        }

        var ident = obj.user;
        if (obj.subuser !== undefined)
            ident = sprintf('%s/users/%s', obj.user, obj.subuser);

        opts.headers.authorization = sprintf(SIGNATURE,
                                             ident,
                                             obj.keyId,
                                             obj.algorithm,
                                             obj.signature);

        return (cb(null));
    });

    return (null);
}


function _addToQuery(req, obj) {
    var query = req.query;
    if (typeof (obj) !== 'undefined') {
        assert.object(obj, 'req.options');
        Object.keys(obj).forEach(function (key) {
            query[key] = obj[key];
        });
    }
}


// --- Exported CloudAPI Client


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
 *        - {String} version (optional) api version (default ~7.0).
 *        - {Function} sign (required) callback function to use for signing
 *          (authenticated requests)
 *        - {Boolean} noCache (optional) disable client caching (default false).
 *        - {Boolean} cacheSize (optional) number of cache entries (default 1k).
 *        - {Boolean} cacheExpiry (optional) entry age in seconds (default 60).
 *        - {String} userAgent (optional)
 *        ...
 * @throws {TypeError} on bad input.
 * @constructor
 */
function CloudAPI(options) {
    assert.object(options, 'options');
    assert.string(options.url, 'options.url');
    assert.func(options.sign, 'options.sign');
    assert.optionalString(options.account, 'options.account');

    if (options.logLevel)
        log.level(options.logLevel);
    options.log = log;
    if (!options.version)
        options.version = API_VERSION;

    this.account = options.account || 'my';
    this.sign = options.sign;

    options.contentType = 'application/json';

    options.retryCallback = function checkFor500(code) {
        return (code === 500);
    };

    if (options.asRole) {
        this.asRole = options.asRole;
    }

    if (!options.userAgent) {
        options.userAgent = 'restify/' + RESTIFY_VERSION + ' (' + os.arch() +
            '-' + os.platform() +
            '; v8/' + process.versions.v8 + '; ' +
            'OpenSSL/' + process.versions.openssl + ') ' +
            'node/' + process.versions.node +
            '; node-smartdc/' + VERSION;
    }

    this.token = options.token;

    if (process.env.SDC_TESTING) {
        options.rejectUnauthorized = false;
    }

    this.client = restify.createJsonClient(options);
    this.options = clone(options);

    // Initialize the cache
    if (!options.noCache) {
        this.cacheSize = options.cacheSize || 1000;
        this.cacheExpiry = (options.cacheExpiry || 60) * 1000;
        this.cache = createCache(this.cacheSize);
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
function getAccount(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return self._request(sprintf(ROOT, account), null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getAccount = getAccount;
CloudAPI.prototype.GetAccount = getAccount;


/**
 * Modifies your account record.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} opts (object) account object.
 * @param {Function} callback of the form f(err, account).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function updateAccount(account, opts, callback, noCache) {
    var self = this;

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = account;
        account = this.account;
    }
    if (!opts || typeof (opts) !== 'object')
        throw new TypeError('opts (object) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return self._request(sprintf(ROOT, account), opts, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.updateAccount = updateAccount;
CloudAPI.prototype.UpdateAccount = updateAccount;


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
function createKey(account, options, callback) {
    var self = this;

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

    return self._request(sprintf(KEYS, account), options, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.createKey = createKey;
CloudAPI.prototype.CreateKey = createKey;


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
function listKeys(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        noCache = callback;
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return self._request(sprintf(KEYS, account), null, function reqCb(req) {
        if (noCache)
            _addToQuery(req, { sync: noCache });

        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listKeys = listKeys;
CloudAPI.prototype.ListKeys = listKeys;


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
function getKey(account, key, callback, noCache) {
    var self = this;

    if (typeof (key) === 'function') {
        noCache = callback;
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
    var path = sprintf(KEY, account, name);

    return self._request(path, null, function reqCb(req) {
        if (noCache)
            _addToQuery(req, { sync: noCache });

        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getKey = getKey;
CloudAPI.prototype.GetKey = getKey;


/**
 * Deletes an SSH key from your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} key can be either the string name of the key, or the object
 *                 returned from create/get.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function deleteKey(account, key, callback) {
    var self = this;

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
    var path = sprintf(KEY, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._del(req, callback);
    });
}
CloudAPI.prototype.deleteKey = deleteKey;
CloudAPI.prototype.DeleteKey = deleteKey;


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
function listPackages(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return self._request(sprintf(PACKAGES, account), null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listPackages = listPackages;
CloudAPI.prototype.ListPackages = listPackages;


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
function getPackage(account, pkg, callback, noCache) {
    var self = this;

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
    var path = sprintf(PACKAGE, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getPackage = getPackage;
CloudAPI.prototype.GetPackage = getPackage;


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
function listDatasets(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return self._request(sprintf(DATASETS, account), null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listDatasets = listDatasets;
CloudAPI.prototype.ListDatasets = listDatasets;


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
function getDataset(account, dataset, callback, noCache) {
    var self = this;

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
    var path = sprintf(DATASET, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getDataset = getDataset;
CloudAPI.prototype.GetDataset = getDataset;


/**
 * Lists all images available to your account.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options (optional) additional filter for images:
 *                   - {String} public (optional) filter public/private images.
 *                   - {String} state (optional) filter by state.
 *                   - {String} type (optional) filter by type.
 * @param {Function} callback of the form f(err, images).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function listImages(account, options, callback, noCache) {
    var self = this;

    // Dev Note: This optional `account`, `options` and `noCache` before
    // and after handling is insanity. Time for a refactor with bwcompat
    // breakage.
    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    } else if (typeof (options) === 'function') {
        callback = options;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    // Backward compat: account is optional, callback is not last arg
    if (typeof (account) === 'object') {
        if (account.login) {
            account = account.login;
        } else {
            options = account;
            account = this.account;
        }
    }
    // console.log(
    //    'listImages: account=%j, options=%j, callback=%s, noCache=%j',
    //    account, options, util.inspect(callback), noCache);

    return self._request(sprintf(IMAGES, account), null, function reqCb(req) {
        _addToQuery(req, options);
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listImages = listImages;
CloudAPI.prototype.ListImages = listImages;


/**
 * Retrieves a single image available to your account.
 *
 * Returns a JS object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} image can be either the string name of the image, or an
 *                 object returned from listImages.
 * @param {Function} callback of the form f(err, image).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function getImage(account, image, callback, noCache) {
    var self = this;

    if (typeof (image) === 'function') {
        callback = image;
        image = account;
        account = this.account;
    }
    if (!image ||
      (typeof (image) !== 'object' && typeof (image) !== 'string'))
        throw new TypeError('image (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (image) === 'object' ? image.id : image);
    var path = sprintf(IMAGE, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getImage = getImage;
CloudAPI.prototype.GetImage = getImage;


/**
 * Creates an image from a machine
 *
 * Returns a JS object
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options object containing:
 *                   - {UUID} machine The prepared and stopped machine UUID
 *                      from which the image is to be created.
 *                   - {String} name The name for your new image
 *                   - {String} version The version of the custom image,
 *                      e.g. "1.0.0". See the IMGAPI docs for details.
 *                   - {String} description The image description.
 * @param {Function} callback of the form f(err, machine).
 * @throws {TypeError} on bad input.
 */
function createImageFromMachine(account, options, callback) {
    var self = this;

    if (typeof (options) === 'function') {
        callback = options;
        options = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (!options ||
      (typeof (options) !== 'object'))
        throw new TypeError('options (object) required');
    if (typeof (account) === 'object')
        account = account.login;
    if (options['machine'] && options['name'] && options['version']) {
        switch (typeof (options['machine'])) {
        case 'string':
            // noop
            break;
        case 'object':
            options['machine'] = options['machine'].id;
            break;
        default:
            throw new TypeError('options.machine  must be a string or object');
        }
    } else {
        throw new TypeError('options missing machine, name, or version field');
    }

    var path = sprintf(IMAGES, account);

    return self._request(path, options, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.createImageFromMachine = createImageFromMachine;
CloudAPI.prototype.CreateImageFromMachine = createImageFromMachine;


/**
 * Updates an image
 *
 * Returns a JS object
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} image can be either the string name of the image, or an
 *                 object returned from listImages.
 * @param {Object} params object containing any optional image attribute to
 *                 be udpated:
 *                   - {String} name Name of the image
 *                   - {String} version Version of the image,
 *                   - {String} description The image description.
 *                   - {String} homepage The image homepage.
 *                   - {String} eula The image EULA.
 *                   - {Array} acl The image ACL.
 *                   - {Object} tags The image tags.
 * @param {Function} callback of the form f(err, machine).
 * @throws {TypeError} on bad input.
 */
function updateImage(account, image, params, callback) {
    var self = this;

    if (typeof (params) === 'function') {
        callback = params;
        params = image;
        image = account;
        account = this.account;
    }
    if (!image || (typeof (image) !== 'object' && typeof (image) !== 'string'))
        throw new TypeError('image (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (!params || (typeof (params) !== 'object'))
        throw new TypeError('params (object) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (image) === 'object' ? image.id : image);
    var path = sprintf(IMAGE, account, name);

    return self._request(path, null, function reqCb(req) {
        _addToQuery(req, { action: 'update' });
        req.body = params;
        return self._post(req, callback);
    });

}
CloudAPI.prototype.updateImage = updateImage;
CloudAPI.prototype.UpdateImage = updateImage;


/**
 * Removes an image available to your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} image can be either the string name of the image, or an
 *                 object returned from listImages.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function deleteImage(account, image, callback) {
    var self = this;

    if (typeof (image) === 'function') {
        callback = image;
        image = account;
        account = this.account;
    }
    if (!image || (typeof (image) !== 'object' && typeof (image) !== 'string'))
        throw new TypeError('image (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (image) === 'object' ? image.id : image);
    var path = sprintf(IMAGE, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._del(req, callback);
    });
}
CloudAPI.prototype.deleteImage = deleteImage;
CloudAPI.prototype.DeleteImage = deleteImage;


/**
 * Exports an Image to the specified Manta path.
 *
 * Returns a JS object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} image can be either the string name of the image, or an
 *                 object returned from listImages.
 * @param {String} mantaPath is a path prefix that must resolve to a location
 *                 that is owned by the user account. If mantaPath is a
 *                 directory, then the image file and manifest are saved with
 *                 NAME-VER.zfs[.EXT] and NAME-VER.imgmanifest as filename
 *                 formats. If the basename of mantaPath is not a directory,
 *                 then "MANTA_PATH.imgmanifest" and "MANTA_PATH.zfs[.EXT]"
 *                 are filename formats.
 * @param {Function} callback of the form f(err, obj).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function exportImage(account, image, mantaPath, callback, noCache) {
    var self = this;

    if (typeof (mantaPath) === 'function') {
        callback = mantaPath;
        mantaPath = image;
        image = account;
        account = this.account;
    }
    if (!image ||
      (typeof (image) !== 'object' && typeof (image) !== 'string'))
        throw new TypeError('image (object|string) required');
    if (!mantaPath || typeof (mantaPath) !== 'string')
        throw new TypeError('mantaPath (string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (image) === 'object' ? image.id : image);
    var path = sprintf(IMAGE, account, name);

    return self._request(path, null, function reqCb(req) {
        _addToQuery(req, { action: 'export', manta_path: mantaPath });
        return self._post(req, callback, noCache);
    });
}
CloudAPI.prototype.exportImage = exportImage;
CloudAPI.prototype.ExportImage = exportImage;


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
function listDatacenters(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var path = sprintf(DATACENTERS, account);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listDatacenters = listDatacenters;
CloudAPI.prototype.ListDatacenters = listDatacenters;


/**
 * Creates a new CloudAPI client connected to the specified datacenter.
 *
 * Returns a JS object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} datacenter can be either the string name of the datacenter,
 *                 or an object returned from listDatacenters.
 * @param {Function} callback of the form f(err, client).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function createClientForDatacenter(account, datacenter, callback, noCache) {
    var self = this;

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

    return self.listDatacenters(account, function listCb(err, datacenters) {
        if (err)
            return callback(self._error(err));

        if (!datacenters[datacenter]) {
            var e = new restify.ResourceNotFoundError(
                'datacenter ' + datacenter + ' not found');
            e.name = 'CloudApiError';
            return callback(e);
        }

        var opts = clone(self.options);
        opts.url = datacenters[datacenter];

        return callback(null, new CloudAPI(opts));
    });
}
CloudAPI.prototype.createClientForDatacenter = createClientForDatacenter;
CloudAPI.prototype.CreateClientForDatacenter = createClientForDatacenter;


/**
 * Provisions a new smartmachine or virtualmachine.
 *
 * Returns a JS object (the created machine). Note that the options
 * object parameters like image/package can actually be the JS objects
 * returned from the respective APIs.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options (optional) object containing:
 *                   - {String} name (optional) name for your machine.
 *                   - {String} image (optional) image to provision.
 *                   - {String} package (optional) package to provision.
 *                   ...
 * @param {Function} callback of the form f(err, machine).
 * @throws {TypeError} on bad input.
 */
function createMachine(account, options, callback) {
    var self = this;

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

    if (!options.image && options.dataset) {
        options.image = options.dataset;
        delete options.dataset;
    }
    if (options.image) {
        switch (typeof (options.image)) {
        case 'string':
            // noop
            break;
        case 'object':
            options.image = options.image.id;
            break;
        default:
            throw new TypeError('options.image must be a string or object');
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

    var path = sprintf(MACHINES, account);

    return self._request(path, options, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.createMachine = createMachine;
CloudAPI.prototype.CreateMachine = createMachine;


/**
 * Counts all machines running under your account.
 *
 * This API call takes all the same options as ListMachines.  However,
 * instead of returning a set of machine objects, it returns the count
 * of machines that would be returned.
 *
 * Machine listings are both potentially large and volatile, so this API
 * explicitly does no caching.
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
function countMachines(account, options, callback) {
    var self = this;

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

    return self._request(sprintf(MACHINES, account), null, function reqCb(req) {
        _addToQuery(req, options);
        req.cacheTTL = (15 * 1000);

        return self.client.head(req, function (err, request, res) {
            if (err) {
                return callback(self._error(err));
            }
            var headers = res.headers;
            var done = true;
            var count = parseInt(headers['x-resource-count'], 10);

            log.debug('CloudAPI._head(%s) -> err=%o, count=%d, done=%s',
                req.path, err, count, done);
            return callback(err, count, done);
        });
    });
}
CloudAPI.prototype.countMachines = countMachines;
CloudAPI.prototype.CountMachines = countMachines;


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
 *                 - {String} image (optional) machines with this dataset.
 *                   `dataset` is a deprecated alternative for this option.
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
function listMachines(account, options, tags, callback) {
    var self = this;

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

    if (tags === '*') {
        options.tags = '*';
    } else {
        for (var k in tags) {
            if (tags.hasOwnProperty(k)) {
                options['tag.' + k] = tags[k];
            }
        }
    }

    return self._request(sprintf(MACHINES, account), null, function reqCb(req) {
        _addToQuery(req, options);

        return self.client.get(req, function getCb(err, request, res, obj) {
            if (err) {
                log.error({err: err}, sprintf('CloudAPI._get(%s)', req.path));
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

            log.debug({err: err, obj: obj, done: done}, 'CloudAPI._get(%s)',
                req.path);
            return callback(err, obj, done);
        });
    });
}
CloudAPI.prototype.listMachines = listMachines;
CloudAPI.prototype.ListMachines = listMachines;


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
function getMachine(account, machine, getCredentials, callback, noCache) {
    var self = this;

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
    var path = sprintf(MACHINE, account, name);

    return self._request(path, null, function reqCb(req) {
        req.cacheTTL = (15 * 1000);
        if (getCredentials)
            req.path += '?credentials=true';
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getMachine = getMachine;
CloudAPI.prototype.GetMachine = getMachine;


/**
 * Reboots a machine under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function rebootMachine(account, machine, callback) {
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
}
CloudAPI.prototype.rebootMachine = rebootMachine;
CloudAPI.prototype.RebootMachine = rebootMachine;


/**
 * Shuts down a machine under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function stopMachine(account, machine, callback) {
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
}
CloudAPI.prototype.stopMachine = stopMachine;
CloudAPI.prototype.StopMachine = stopMachine;


/**
 * Boots up a machine under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function startMachine(account, machine, callback) {
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
}
CloudAPI.prototype.startMachine = startMachine;
CloudAPI.prototype.StartMachine = startMachine;


/**
 * Resizes a machine under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function resizeMachine(account, machine, options, callback) {
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
}
CloudAPI.prototype.resizeMachine = resizeMachine;
CloudAPI.prototype.ResizeMachine = resizeMachine;


/**
 * Renames a machine under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function renameMachine(account, machine, options, callback) {
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

    return this._updateMachine(account, machine, 'rename', options, callback);
}
CloudAPI.prototype.renameMachine = renameMachine;
CloudAPI.prototype.RenameMachine = renameMachine;


/**
 * Enables machine firewall.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function enableFirewall(account, machine, callback) {
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

    return this._updateMachine(account, machine,
            'enable_firewall', {}, callback);
}
CloudAPI.prototype.enableFirewall = enableFirewall;
CloudAPI.prototype.EnableFirewall = enableFirewall;


/**
 * Disables Machine firewall
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function disableFirewall(account, machine, callback) {
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

    return this._updateMachine(account, machine,
        'disable_firewall', {}, callback);
}
CloudAPI.prototype.disableFirewall = disableFirewall;
CloudAPI.prototype.DisableFirewall = disableFirewall;


/**
 * Deletes a machine under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function deleteMachine(account, machine, callback) {
    var self = this;

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
    var path = sprintf(MACHINE, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._del(req, callback);
    });
}
CloudAPI.prototype.deleteMachine = deleteMachine;
CloudAPI.prototype.DeleteMachine = deleteMachine;


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
function createMachineSnapshot(account, machine, options, callback) {
    var self = this;

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

    var name = (typeof (machine) === 'object' ? machine.id : machine);
    var path = sprintf(SNAPSHOTS, account, name);

    return self._request(path, options, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.createMachineSnapshot = createMachineSnapshot;
CloudAPI.prototype.CreateMachineSnapshot = createMachineSnapshot;


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
function listMachineSnapshots(account, machine, callback) {
    var self = this;

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
    var path = sprintf(SNAPSHOTS, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, true);
    });
}
CloudAPI.prototype.listMachineSnapshots = listMachineSnapshots;
CloudAPI.prototype.ListMachineSnapshots = listMachineSnapshots;


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
function getMachineSnapshot(account, machine, snapshot, callback, noCache) {
    var self = this;

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

    return self._request(sprintf(SNAPSHOT, a, m, s), null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getMachineSnapshot = getMachineSnapshot;
CloudAPI.prototype.GetMachineSnapshot = getMachineSnapshot;


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
function startMachineFromSnapshot(account, machine, snapshot, callback) {
    var self = this;

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

    return self._request(sprintf(SNAPSHOT, a, m, s), null, function reqCb(req) {
        req.expect = 202;
        return self._post(req, callback);
    });
}
CloudAPI.prototype.startMachineFromSnapshot = startMachineFromSnapshot;
CloudAPI.prototype.StartMachineFromSnapshot = startMachineFromSnapshot;


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
function deleteMachineSnapshot(account, machine, snapshot, callback) {
    var self = this;

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

    return self._request(sprintf(SNAPSHOT, a, m, s), null, function reqCb(req) {
        return self._del(req, callback);
    });
}
CloudAPI.prototype.deleteMachineSnapshot = deleteMachineSnapshot;
CloudAPI.prototype.DeleteMachineSnapshot = deleteMachineSnapshot;


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
function addMachineTags(account, machine, tags, callback) {
    var self = this;

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

    var name = (typeof (machine) === 'object' ? machine.id : machine);
    var path = sprintf(TAGS, account, name);

    return self._request(path, tags, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.addMachineTags = addMachineTags;
CloudAPI.prototype.AddMachineTags = addMachineTags;


/**
 * Overwrites the set of tags to the machine.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Object} tags tags dictionary.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function replaceMachineTags(account, machine, tags, callback) {
    var self = this;

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

    var name = (typeof (machine) === 'object' ? machine.id : machine);
    var path = sprintf(TAGS, account, name);

    return self._request(path, tags, function reqCb(req) {
        return self._put(req, callback);
    });
}
CloudAPI.prototype.replaceMachineTags = replaceMachineTags;
CloudAPI.prototype.ReplaceMachineTags = replaceMachineTags;


/**
 * Gets the set of tags from a machine
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @param {Boolean} noCache disable caching of this result.
 * @throws {TypeError} on bad input.
 */
function listMachineTags(account, machine, callback, noCache) {
    var self = this;

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
    var path = sprintf(TAGS, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listMachineTags = listMachineTags;
CloudAPI.prototype.ListMachineTags = listMachineTags;


/**
 * Retrieves a single tag from a machine.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {String} tag a tag name to get.
 * @param {Function} callback of the form f(err).
 * @param {Boolean} noCache disable caching of this result.
 * @throws {TypeError} on bad input.
 */
function getMachineTag(account, machine, tag, callback, noCache) {
    var self = this;

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

    var name = (typeof (machine) === 'object' ? machine.id : machine);
    var path = sprintf(TAG, account, name, tag);

    return self._request(path, null, function reqCb(req) {
        req.headers.Accept = 'text/plain';
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getMachineTag = getMachineTag;
CloudAPI.prototype.GetMachineTag = getMachineTag;


/**
 * Deletes ALL tags from a machine
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function deleteMachineTags(account, machine, callback) {
    var self = this;

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
    var path = sprintf(TAGS, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._del(req, callback);
    });
}
CloudAPI.prototype.deleteMachineTags = deleteMachineTags;
CloudAPI.prototype.DeleteMachineTags = deleteMachineTags;


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
function deleteMachineTag(account, machine, tag, callback) {
    var self = this;

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

    var name = (typeof (machine) === 'object' ? machine.id : machine);
    var path = sprintf(TAG, account, name, tag);

    return self._request(path, null, function reqCb(req) {
        return self._del(req, callback);
    });
}
CloudAPI.prototype.deleteMachineTag = deleteMachineTag;
CloudAPI.prototype.DeleteMachineTag = deleteMachineTag;


/**
 * Retrieves all metadata from a machine.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Boolean} getCredentials whether or not to return passwords
 *                  (default is false).
 * @param {Function} callback of the form f(err).
 * @param {Boolean} noCache disable caching of this result.
 * @throws {TypeError} on bad input.
 */
function listMachineMetadata(account, machine, getCredentials, callback,
                             noCache) {
    var self = this;

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
    var path = sprintf(METADATA, account, name);
    var params = {
        credentials: getCredentials
    };

    return self._request(path, params, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getMachineMetadata = listMachineMetadata;  // deprecated
CloudAPI.prototype.GetMachineMetadata = listMachineMetadata;  // deprecated
CloudAPI.prototype.listMachineMetadata = listMachineMetadata;
CloudAPI.prototype.ListMachineMetadata = listMachineMetadata;



/**
 * Retrieves a piece of metadata from a machine.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @param {Boolean} noCache disable caching of this result.
 * @throws {TypeError} on bad input.
 */
function getMachineMetadata(account, machine, key, callback, noCache) {
    var self = this;

    if (typeof (key) === 'function') {
        callback = key;
        key = machine;
        machine = account;
        account = this.account;
    }
    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string'))
        throw new TypeError('machine (object|string) required');
    if (typeof (key) !== 'string')
        throw new TypeError('string must be a string');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (machine) === 'object' ? machine.id : machine);
    var path = sprintf(METADATA_KEY, account, name, key);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getMachineMetadataV2 = getMachineMetadata;
CloudAPI.prototype.GetMachineMetadataV2 = getMachineMetadata;



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
function updateMachineMetadata(account, machine, metadata, callback) {
    var self = this;

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

    var name = (typeof (machine) === 'object' ? machine.id : machine);
    var path = sprintf(METADATA, account, name);

    return self._request(path, metadata, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.updateMachineMetadata = updateMachineMetadata;
CloudAPI.prototype.UpdateMachineMetadata = updateMachineMetadata;


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
function deleteMachineMetadata(account, machine, key, callback) {
    var self = this;

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

    var path;
    if (key === '*') {
        path = sprintf(METADATA, account, m);
    } else {
        path = sprintf(METADATA_KEY, account, m, key);
    }

    return self._request(path, null, function reqCb(req) {
        return self._del(req, callback);
    });
}
CloudAPI.prototype.deleteMachineMetadata = deleteMachineMetadata;
CloudAPI.prototype.DeleteMachineMetadata = deleteMachineMetadata;


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
function describeAnalytics(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var path = sprintf(ANALYTICS, account);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.describeAnalytics = describeAnalytics;
CloudAPI.prototype.DescribeAnalytics = describeAnalytics;
CloudAPI.prototype.getMetrics = describeAnalytics;
CloudAPI.prototype.GetMetrics = describeAnalytics;


/**
 * Creates an instrumentation under your account.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} opts instrumentation options. (see CA docs).
 * @param {Function} callback of the form f(err, instrumentation).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function createInstrumentation(account, opts, callback, noCache) {
    var self = this;

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = account;
        account = this.account;
    }
    if (typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (!opts || typeof (opts) !== 'object')
        throw new TypeError('opts (object) required');
    if (typeof (account) === 'object')
        account = account.login;

    return self._request(sprintf(INSTS, account), opts, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.createInst = createInstrumentation;
CloudAPI.prototype.createInstrumentation = createInstrumentation;
CloudAPI.prototype.CreateInstrumentation = createInstrumentation;


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
function listInstrumentations(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        noCache = callback;
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return self._request(sprintf(INSTS, account), null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listInsts = listInstrumentations;
CloudAPI.prototype.listInstrumentations = listInstrumentations;
CloudAPI.prototype.ListInstrumentations = listInstrumentations;


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
function getInstrumentation(account, inst, callback, noCache) {
    var self = this;

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
    var path = sprintf(INST, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getInst = getInstrumentation;
CloudAPI.prototype.getInstrumentation = getInstrumentation;
CloudAPI.prototype.GetInstrumentation = getInstrumentation;


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
 * @param {Object} options instrumentation options. (see CA docs).
 * @param {Function} callback of the form f(err, instrumentation).
 * @throws {TypeError} on bad input.
 */
function getInstrumentationValue(account, inst, options, callback) {
    var self = this;

    if (typeof (options) === 'function') {
        callback = options;
        options = inst;
        inst = account;
        account = this.account;
    }
    if (typeof (options) !== 'object')
        throw new TypeError('options (object) required');
    if (typeof (inst) !== 'object' && typeof (inst) !== 'number')
        throw new TypeError('inst (object|number) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (inst) === 'object' ? inst.id : inst);
    var path = sprintf(INST_RAW, account, name);

    return self._request(path, null, function reqCb(req) {
        _addToQuery(req, options);
        return self._get(req, callback, true);
    });
}
CloudAPI.prototype.getInstValue = getInstrumentationValue;
CloudAPI.prototype.getInstrumentationValue = getInstrumentationValue;
CloudAPI.prototype.GetInstrumentationValue = getInstrumentationValue;


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
function getInstrumentationHeatmap(account, inst, options, callback) {
    var self = this;

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
    var path = sprintf(INST_HMAP, account, name);

    return self._request(path, null, function reqCb(req) {
        _addToQuery(req, options);
        return self._get(req, callback, true);
    });
}
CloudAPI.prototype.getInstHmap = getInstrumentationHeatmap;
CloudAPI.prototype.getInstrumentationHeatmap = getInstrumentationHeatmap;
CloudAPI.prototype.GetInstrumentationHeatmap = getInstrumentationHeatmap;


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
function getInstrumentationHeatmapDetails(account, inst, options, callback) {
    var self = this;

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
    var path = sprintf(INST_HMAP_DETAILS, account, name);

    return self._request(path, null, function reqCb(req) {
        _addToQuery(req, options);
        return self._get(req, callback, true);
    });
}
CloudAPI.prototype.getInstHmapDetails = getInstrumentationHeatmapDetails;
CloudAPI.prototype.getInstrumentationHeatmapDetails =
    getInstrumentationHeatmapDetails;
CloudAPI.prototype.GetInstrumentationHeatmapDetails =
    getInstrumentationHeatmapDetails;


/**
 * Deletes an instrumentation under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Number} inst either the id, or can be the object returned
 *                 in list or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function deleteInstrumentation(account, inst, callback) {
    var self = this;

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
    var path = sprintf(INST, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._del(req, callback);
    });
}
CloudAPI.prototype.delInst = deleteInstrumentation;
CloudAPI.prototype.deleteInstrumentation = deleteInstrumentation;
CloudAPI.prototype.DeleteInstrumentation = deleteInstrumentation;


/**
 * Gets a usage object of all machines in cloud within a period
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} period The yyyy-mm period in which to get usage.
 * @param {Function} callback
 * @param {Boolean} noCache (optional) Flag to skip the cache
 */
function getUsage(account, period, callback, noCache) {
    var self = this;

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

    var path = sprintf(USAGE, account, period);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getUsage = getUsage;
CloudAPI.prototype.GetUsage = getUsage;


/**
 * Get actions audit for a given machine.
 *
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function getMachineAudit(account, machine, callback) {
    var self = this;

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
    var path = sprintf(AUDIT, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, true);
    });
}
CloudAPI.prototype.getMachineAudit = getMachineAudit;
CloudAPI.prototype.GetMachineAudit = getMachineAudit;


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
function getMachineUsage(account, machine, period, callback, noCache) {
    var self = this;

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

    var path = sprintf(MACHINE_USAGE, account, machine, period);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getMachineUsage = getMachineUsage;
CloudAPI.prototype.GetMachineUsage = getMachineUsage;


/**
 * Creates a Firewall Rule.
 *
 * Returns a JS object (the created fwrule). Note that options can actually
 * be just the fwrule text, if you don't care about enabling it.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options object containing:
 *                   - {Boolean} enabled (optional) default to false.
 *                   - {String} rule (required) the fwrule text.
 * @param {Function} callback of the form f(err, fwrule).
 * @throws {TypeError} on bad input.
 */
function createFirewallRule(account, options, callback) {
    var self = this;

    if (typeof (options) === 'function') {
        callback = options;
        options = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (!options ||
      (typeof (options) !== 'string' && typeof (options) !== 'object')) {
        throw new TypeError('options (object) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    if (typeof (options) === 'string') {
        options = {
            rule: options
        };
    }

    var path = sprintf(FWRULES, account);

    return self._request(path, options, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.createFwRule = createFirewallRule;
CloudAPI.prototype.CreateFwRule = createFirewallRule;
CloudAPI.prototype.createFirewallRule = createFirewallRule;
CloudAPI.prototype.CreateFirewallRule = createFirewallRule;


/**
 * Lists all your Firewall Rules.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, fwrules).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function listFirewallRules(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    var path = sprintf(FWRULES, account);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listFwRules = listFirewallRules;
CloudAPI.prototype.ListFwRules = listFirewallRules;
CloudAPI.prototype.listFirewallRules = listFirewallRules;
CloudAPI.prototype.ListFirewallRules = listFirewallRules;


/**
 * Retrieves a Firewall Rule.
 *
 * Returns a JS object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} fwrule can be either the string id of the fwrule,
 *                 or the object returned from create/get.
 * @param {Function} callback of the form f(err, fwrule).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function getFirewallRule(account, fwrule, callback, noCache) {
    var self = this;

    if (typeof (fwrule) === 'function') {
        callback = fwrule;
        fwrule = account;
        account = this.account;
    }
    if (!fwrule ||
            (typeof (fwrule) !== 'object' && typeof (fwrule) !== 'string')) {
        throw new TypeError('fwrule (object|string) required');
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    var name = (typeof (fwrule) === 'object' ? fwrule.id : fwrule);
    var path = sprintf(FWRULE, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getFwRule = getFirewallRule;
CloudAPI.prototype.GetFwRule = getFirewallRule;
CloudAPI.prototype.getFirewallRule = getFirewallRule;
CloudAPI.prototype.GetFirewallRule = getFirewallRule;


/**
 * Updates a Firewall Rule.
 *
 * Returns a JS object (the updated fwrule). Note that options can actually
 * be just the fwrule text, if you don't care about enabling it.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} fwrule can be either the string id of the fwrule,
 *                 or the object returned from create/get.
 * @param {Object} opts object containing:
 *                   - {Boolean} enabled (optional) default to false.
 *                   - {String} rule (required) the fwrule text.
 * @param {Function} callback of the form f(err, fwrule).
 * @throws {TypeError} on bad input.
 */
function updateFirewallRule(account, fwrule, opts, callback) {
    var self = this;

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = fwrule;
        fwrule = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (!opts ||
      (typeof (opts) !== 'string' && typeof (opts) !== 'object')) {
        throw new TypeError('opts (object) required');
    }
    if (!fwrule ||
            (typeof (fwrule) !== 'object' && typeof (fwrule) !== 'string')) {
        throw new TypeError('fwrule (object|string) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    if (typeof (opts) === 'string') {
        opts = {
            rule: opts
        };
    }

    var name = (typeof (fwrule) === 'object' ? fwrule.id : fwrule);
    var path = sprintf(FWRULE, account, name);

    return self._request(path, opts, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.updateFwRule = updateFirewallRule;
CloudAPI.prototype.UpdateFwRule = updateFirewallRule;
CloudAPI.prototype.updateFirewallRule = updateFirewallRule;
CloudAPI.prototype.UpdateFirewallRule = updateFirewallRule;


/**
 * Enables a Firewall Rule.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} fwrule can be either the string id of the fwrule,
 *                 or the object returned from create/get.
 * @param {Function} callback of the form f(err, fwrule).
 * @throws {TypeError} on bad input.
 */
function enableFirewallRule(account, fwrule, callback) {
    var self = this;

    if (typeof (fwrule) === 'function') {
        callback = fwrule;
        fwrule = account;
        account = this.account;
    }
    if (!fwrule ||
            (typeof (fwrule) !== 'object' && typeof (fwrule) !== 'string')) {
        throw new TypeError('fwrule (object|string) required');
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    var name = (typeof (fwrule) === 'object' ? fwrule.id : fwrule);
    var path = sprintf(FWRULE, account, name) + '/enable';

    return self._request(path, null, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.enableFwRule = enableFirewallRule;
CloudAPI.prototype.EnableFwRule = enableFirewallRule;
CloudAPI.prototype.enableFirewallRule = enableFirewallRule;
CloudAPI.prototype.EnableFirewallRule = enableFirewallRule;


/**
 * Disables a Firewall Rule.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} fwrule can be either the string id of the fwrule,
 *                 or the object returned from create/get.
 * @param {Function} callback of the form f(err, fwrule).
 * @throws {TypeError} on bad input.
 */
function disableFirewallRule(account, fwrule, callback) {
    var self = this;

    if (typeof (fwrule) === 'function') {
        callback = fwrule;
        fwrule = account;
        account = this.account;
    }
    if (!fwrule ||
            (typeof (fwrule) !== 'object' && typeof (fwrule) !== 'string')) {
        throw new TypeError('fwrule (object|string) required');
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    var name = (typeof (fwrule) === 'object' ? fwrule.id : fwrule);
    var path = sprintf(FWRULE, account, name) + '/disable';

    return self._request(path, null, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.disableFwRule = disableFirewallRule;
CloudAPI.prototype.DisableFwRule = disableFirewallRule;
CloudAPI.prototype.disableFirewallRule = disableFirewallRule;
CloudAPI.prototype.DisableFirewallRule = disableFirewallRule;


/**
 * Deletes Firewall Rule.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} fwrule can be either the string id of the fwrule,
 *                 or the object returned from create/get.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function deleteFirewallRule(account, fwrule, callback) {
    var self = this;

    if (typeof (fwrule) === 'function') {
        callback = fwrule;
        fwrule = account;
        account = this.account;
    }

    if (!fwrule ||
            (typeof (fwrule) !== 'object' && typeof (fwrule) !== 'string')) {
        throw new TypeError('fwrule (object|string) required');
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    var name = (typeof (fwrule) === 'object' ? fwrule.id : fwrule);
    var path = sprintf(FWRULE, account, name);

    return self._request(path, null, function (req) {
        return self._del(req, callback);
    });
}
CloudAPI.prototype.deleteFwRule = deleteFirewallRule;
CloudAPI.prototype.DeleteFwRule = deleteFirewallRule;
CloudAPI.prototype.deleteFirewallRule = deleteFirewallRule;
CloudAPI.prototype.DeleteFirewallRule = deleteFirewallRule;


/**
 * Lists all the Firewall Rules affecting the given machine.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine the uuid of the machine, or an object from create
 *                         or list or get machine.
 * @param {Function} callback of the form f(err, fwrules).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function listMachineRules(account, machine, callback, noCache) {
    var self = this;

    if (typeof (machine) === 'function') {
        callback = machine;
        machine = account;
        account = this.account;
    }

    if (typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (!machine ||
      (typeof (machine) !== 'object' && typeof (machine) !== 'string')) {
        throw new TypeError('machine (object|string) required');
      }

    if (typeof (account) === 'object') {
        account = account.login;
    }
    if (typeof (machine) === 'object') {
        machine = machine.id;
    }

    var path = sprintf(MACHINE, account, machine) + '/fwrules';

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listMachineRules = listMachineRules;
CloudAPI.prototype.ListMachineRules = listMachineRules;


/**
 * Lists all the Machines affected by the given firewall rule.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} fwrule the uuid of the fwrule, or an object from create
 *                         or list or get fwrule.
 * @param {Function} callback of the form f(err, machines).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function listRuleMachines(account, fwrule, callback, noCache) {
    var self = this;

    if (typeof (fwrule) === 'function') {
        callback = fwrule;
        fwrule = account;
        account = this.account;
    }

    if (typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (!fwrule ||
      (typeof (fwrule) !== 'object' && typeof (fwrule) !== 'string')) {
        throw new TypeError('fwrule (object|string) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }
    if (typeof (fwrule) === 'object') {
        fwrule = fwrule.id;
    }

    var path = sprintf(FWRULE, account, fwrule) + '/machines';

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listRuleMachines = listRuleMachines;
CloudAPI.prototype.ListRuleMachines = listRuleMachines;


/**
 * Lists all networks available to your account.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, networkss).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function listNetworks(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return self._request(sprintf(NETWORKS, account), null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listNetworks = listNetworks;
CloudAPI.prototype.ListNetworks = listNetworks;


/**
 * Retrieves a single network available to your account.
 *
 * Returns a JS object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} net can be either the string id of the network, or an
 *                 object returned from listNetworks.
 * @param {Function} callback of the form f(err, network).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function getNetwork(account, net, callback, noCache) {
    var self = this;

    if (typeof (net) === 'function') {
        callback = net;
        net = account;
        account = this.account;
    }
    if (!net || (typeof (net) !== 'object' && typeof (net) !== 'string'))
        throw new TypeError('net (object|string) required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var name = (typeof (net) === 'object' ? net.id : net);
    var path = sprintf(NETWORK, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getNetwork = getNetwork;
CloudAPI.prototype.GetNetwork = getNetwork;


/**
 * Retrieves a User for your account
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} user can be either the string id of the user, or the
 *                 object returned from create/get.
 * @param {Function} callback of the form f(err, user).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function getUser(account, user, callback, noCache) {
    var self = this;

    if (typeof (user) === 'function') {
        callback = user;
        user = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    var options = {};
    if (typeof (user) === 'object') {
        if (user.membership) {
            options.membership = true;
        }
        user = user.id;
    }

    var path = sprintf(USER, account, user);

    return self._request(path, null, function reqCb(req) {
        _addToQuery(req, options);
        return self._get(req, callback, noCache);
    });

}
CloudAPI.prototype.getUser = getUser;
CloudAPI.prototype.GetUser = getUser;


/**
 * Modifies an exising User.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} opts (object) user object containing:
 *                   - {String} id (required) for your user.
 *                   - {String} login (optional) name for your user.
 *                   - {String} email (optional) for the user.
 *                   - {String} companyName (optional) for the user.
 *                   - {String} firstName (optional) for the user.
 *                   - {String} lastName (optional) for the user.
 *                   - {String} address (optional) for the user.
 *                   - {String} postalCode (optional) for the user.
 *                   - {String} city (optional) for the user.
 *                   - {String} state (optional) for the user.
 *                   - {String} country (optional) for the user.
 *                   - {String} phone (optional) for the user.
 * @param {Function} callback of the form f(err, user).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function updateUser(account, opts, callback, noCache) {
    var self = this;

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = account;
        account = this.account;
    }

    if (!opts || typeof (opts) !== 'object') {
        throw new TypeError('opts (object) required');
    }

    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    var path = sprintf(USER, account, opts.id);

    return self._request(path, opts, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.updateUser = updateUser;
CloudAPI.prototype.UpdateUser = updateUser;


/**
 * Change existing user password.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} opts (object) user object containing:
 *                   - {String} id (required) for your user.
 *                   - {String} password for your user.
 *                   - {String} password_confirmation for the user.
 * @param {Function} cb callback of the form f(err, user).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function changeUserPassword(account, opts, cb, noCache) {
    var self = this;

    if (typeof (opts) === 'function') {
        cb = opts;
        opts = account;
        account = this.account;
    }

    if (!opts || typeof (opts) !== 'object') {
        throw new TypeError('opts (object) required');
    }

    if (!cb || typeof (cb) !== 'function') {
        throw new TypeError('cb (function) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    var path = sprintf(USER, account, opts.id) + '/change_password';

    return self._request(path, opts, function reqCb(req) {
        return self._post(req, cb);
    });
}
CloudAPI.prototype.changeUserPassword = changeUserPassword;
CloudAPI.prototype.ChangeUserPassword = changeUserPassword;


/**
 * Creates a User on your account.
 *
 * Returns a JS object (the created user).
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} opts object containing:
 *                   - {String} login name for your user.
 *                   - {String} password for the user.
 *                   - {String} email for the user.
 *                   - {String} companyName (optional) for the user.
 *                   - {String} firstName (optional) for the user.
 *                   - {String} lastName (optional) for the user.
 *                   - {String} address (optional) for the user.
 *                   - {String} postalCode (optional) for the user.
 *                   - {String} city (optional) for the user.
 *                   - {String} state (optional) for the user.
 *                   - {String} country (optional) for the user.
 *                   - {String} phone (optional) for the user.
 * @param {Function} callback of the form f(err, user).
 * @throws {TypeError} on bad input.
 */
function createUser(account, opts, callback) {
    var self = this;

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = account;
        account = this.account;
    }
    if (typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (!opts || typeof (opts) !== 'object') {
        throw new TypeError('options (object) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    return self._request(sprintf(USERS, account), opts, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.createUser = createUser;
CloudAPI.prototype.CreateUser = createUser;


/**
 * Lists all Users for your account.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, users).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function listUsers(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        noCache = callback;
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return self._request(sprintf(USERS, account), null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listUsers = listUsers;
CloudAPI.prototype.ListUsers = listUsers;


/**
 * Deletes a User from your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} user can be either the string id of the user, or the object
 *                 returned from create/get.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function deleteUser(account, user, callback) {
    var self = this;

    if (typeof (user) === 'function') {
        callback = user;
        user = account;
        account = this.account;
    }

    if (!user || (typeof (user) !== 'object' && typeof (user) !== 'string')) {
        throw new TypeError('user (object|string) required');
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    var id = (typeof (user) === 'object' ? user.id : user);

    return self._request(sprintf(USER, account, id), null, function reqCb(req) {
        return self._del(req, callback);
    });
}
CloudAPI.prototype.deleteUser = deleteUser;
CloudAPI.prototype.DeleteUser = deleteUser;


/**
 * Uploads an SSH key for one of the users of the account.
 *
 * Returns a JS object (the created key). Note that options can actually
 * be just the key PEM, if you don't care about names.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} user (optional) the id for the user the key is being
 *      uploaded.
 * @param {Object} options object containing:
 *                   - {String} name (optional) name for your ssh key.
 *                   - {String} key SSH public key.
 * @param {Function} callback of the form f(err, key).
 * @throws {TypeError} on bad input.
 */
function uploadUserKey(account, user, opts, callback) {
    var self = this;

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = user;
        user = account;
        account = this.account;
    }

    if (typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (!opts ||
      (typeof (opts) !== 'string' && typeof (opts) !== 'object')) {
        throw new TypeError('options (object) required');
    }

    if (typeof (user) === 'object') {
        user = user.id;
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    if (typeof (opts) === 'string') {
        opts = {
            key: opts
        };
    }

    var p = sprintf(SUB_KEYS, account, user);

    return self._request(p, opts, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.uploadUserKey = uploadUserKey;
CloudAPI.prototype.UploadUserKey = uploadUserKey;


/**
 * Lists all SSH keys for one of your account users.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} user the id name of the account user.
 * @param {Function} callback of the form f(err, keys).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function listUserKeys(account, user, callback, noCache) {
    var self = this;

    if (typeof (user) === 'function') {
        callback = user;
        user = account;
        account = this.account;
    }

    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    var p = sprintf(SUB_KEYS, account, user);

    return self._request(p, null, function reqCb(req) {
        if (noCache)
            _addToQuery(req, { sync: noCache });

        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listUserKeys = listUserKeys;
CloudAPI.prototype.ListUserKeys = listUserKeys;


/**
 * Retrieves an SSH key from one of your account users.
 *
 * Returns a JS object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} user the id of the user.
 * @param {String} key can be either the string fingerprint of the key,
 *                 or the object returned from create/get.
 * @param {Function} callback of the form f(err, key).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function getUserKey(account, user, key, callback, noCache) {
    var self = this;

    if (typeof (key) === 'function') {
        noCache = callback;
        callback = key;
        key = user;
        user = account;
        account = this.account;
    }

    if (!key || (typeof (key) !== 'object' && typeof (key) !== 'string')) {
        throw new TypeError('key (object|string) required');
    }

    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    if (typeof (user) === 'object') {
        user = user.id;
    }

    var name = (typeof (key) === 'object' ? key.fingerprint : key);
    var path = sprintf(SUB_KEY, account, user, name);

    return self._request(path, null, function reqCb(req) {
        if (noCache)
            _addToQuery(req, { sync: noCache });

        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getUserKey = getUserKey;
CloudAPI.prototype.GetUserKey = getUserKey;


/**
 * Deletes an SSH key for one of your account users.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} user the id of the user.
 * @param {String} key can be either the string fingerprint of the key,
 *                 or the object returned from create/get.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function deleteUserKey(account, user, key, callback) {
    var self = this;

    if (typeof (key) === 'function') {
        callback = key;
        key = user;
        user = account;
        account = this.account;
    }

    if (!key || (typeof (key) !== 'object' && typeof (key) !== 'string')) {
        throw new TypeError('key (object|string) required');
    }

    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    var name = (typeof (key) === 'object' ? key.name : key);

    if (typeof (user) === 'object') {
        user = user.id;
    }

    var path = sprintf(SUB_KEY, account, user, name);

    return self._request(path, null, function reqCb(req) {
        return self._del(req, callback);
    });
}
CloudAPI.prototype.deleteUserKey = deleteUserKey;
CloudAPI.prototype.DeleteUserKey = deleteUserKey;


/**
 * Retrieves a Policy for your account
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} policy can be either the string id of the policy, or the
 *                 object returned from create/get.
 * @param {Function} callback of the form f(err, policy).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function getPolicy(account, policy, callback, noCache) {
    var self = this;

    if (typeof (policy) === 'function') {
        callback = policy;
        policy = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    if (typeof (policy) === 'object') {
        policy = policy.id;
    }

    var path = sprintf(POLICY, account, policy);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });

}
CloudAPI.prototype.getPolicy = getPolicy;
CloudAPI.prototype.GetPolicy = getPolicy;


/**
 * Modifies an exising Policy.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} opts (object) user object containing:
 *                   - {String} id (required) for the policy.
 *                   - {String} name (optional) for the policy.
 *                   - {String} rules (optional) for the policy.
 *                   - {String} description (optional) for the policy.
 * @param {Function} callback of the form f(err, policy).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function updatePolicy(account, opts, callback, noCache) {
    var self = this;

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = account;
        account = this.account;
    }

    if (!opts || typeof (opts) !== 'object') {
        throw new TypeError('opts (object) required');
    }

    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    var path = sprintf(POLICY, account, opts.id);

    return self._request(path, opts, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.updatePolicy = updatePolicy;
CloudAPI.prototype.UpdatePolicy = updatePolicy;


/**
 * Creates a Policy on your account.
 *
 * Returns a JS object (the created user).
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} opts object containing:
 *                   - {String} name (optional) for the policy.
 *                   - {String} rules (optional) for the policy.
 *                   - {String} description (optional) for the policy.
 * @param {Function} callback of the form f(err, policy).
 * @throws {TypeError} on bad input.
 */
function createPolicy(account, opts, callback) {
    var self = this;

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = account;
        account = this.account;
    }
    if (typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (!opts || typeof (opts) !== 'object') {
        throw new TypeError('opts (object) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    var path = sprintf(POLICIES, account);

    return self._request(path, opts, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.createPolicy = createPolicy;
CloudAPI.prototype.CreatePolicy = createPolicy;


/**
 * Lists all Policies for your account.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, policies).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function listPolicies(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        noCache = callback;
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return self._request(sprintf(POLICIES, account), null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listPolicies = listPolicies;
CloudAPI.prototype.ListPolicies = listPolicies;


/**
 * Deletes a Policy from your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} policy can be either the string id of the policy,
 *                 or the object returned from create/get.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function deletePolicy(account, policy, callback) {
    var self = this;

    if (typeof (policy) === 'function') {
        callback = policy;
        policy = account;
        account = this.account;
    }

    if (!policy ||
            (typeof (policy) !== 'object' && typeof (policy) !== 'string')) {
        throw new TypeError('policy (object|string) required');
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    var name = (typeof (policy) === 'object' ? policy.id : policy);
    var path = sprintf(POLICY, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._del(req, callback);
    });
}
CloudAPI.prototype.deletePolicy = deletePolicy;
CloudAPI.prototype.DeletePolicy = deletePolicy;


/**
 * Retrieves a Role for your account
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} role can be either the string id of the role, or the
 *                 object returned from create/get.
 * @param {Function} callback of the form f(err, role).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function getRole(account, role, callback, noCache) {
    var self = this;

    if (typeof (role) === 'function') {
        callback = role;
        role = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    if (typeof (role) === 'object') {
        role = role.id;
    }

    var path = sprintf(ROLE, account, role);

    return self._request(path, null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.getRole = getRole;
CloudAPI.prototype.GetRole = getRole;


/**
 * Modifies an exising Role.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} opts (object) role object containing:
 *                   - {String} id (required) for your role.
 *                   - {String} name (optional) name for your role.
 *                   - {Object} members (optional) for the role.
 *                   - {Object} default_members (optional) for the role.
 *                   - {Object} policies (optional) for the role.
 * @param {Function} callback of the form f(err, user).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function updateRole(account, opts, callback, noCache) {
    var self = this;

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = account;
        account = this.account;
    }

    if (!opts || typeof (opts) !== 'object') {
        throw new TypeError('opts (object) required');
    }

    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    var path = sprintf(ROLE, account, opts.id);

    return self._request(path, opts, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.updateRole = updateRole;
CloudAPI.prototype.UpdateRole = updateRole;


/**
 * Creates a Role on your account.
 *
 * Returns a JS object (the created role).
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} opts object containing:
 *                   - {String} name (optional) name for your role.
 *                   - {Object} members (optional) for the role.
 *                   - {Object} default_members (optional) for the role.
 *                   - {Object} policies (optional) for the role.
 * @param {Function} callback of the form f(err, role).
 * @throws {TypeError} on bad input.
 */
function createRole(account, opts, callback) {
    var self = this;

    if (typeof (opts) === 'function') {
        callback = opts;
        opts = account;
        account = this.account;
    }
    if (typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (!opts || typeof (opts) !== 'object') {
        throw new TypeError('opts (object) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    return self._request(sprintf(ROLES, account), opts, function reqCb(req) {
        return self._post(req, callback);
    });
}
CloudAPI.prototype.createRole = createRole;
CloudAPI.prototype.CreateRole = createRole;


/**
 * Lists all Roles for your account.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Function} callback of the form f(err, roles).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
function listRoles(account, callback, noCache) {
    var self = this;

    if (typeof (account) === 'function') {
        noCache = callback;
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    return self._request(sprintf(ROLES, account), null, function reqCb(req) {
        return self._get(req, callback, noCache);
    });
}
CloudAPI.prototype.listRoles = listRoles;
CloudAPI.prototype.ListRoles = listRoles;


/**
 * Deletes a Role from your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} role can be either the string id of the role, or the object
 *                 returned from create/get.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
function deleteRole(account, role, callback) {
    var self = this;

    if (typeof (role) === 'function') {
        callback = role;
        role = account;
        account = this.account;
    }

    if (!role || (typeof (role) !== 'object' && typeof (role) !== 'string')) {
        throw new TypeError('role (object|string) required');
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    var name = (typeof (role) === 'object' ? role.id : role);
    var path = sprintf(ROLE, account, name);

    return self._request(path, null, function reqCb(req) {
        return self._del(req, callback);
    });
}
CloudAPI.prototype.deleteRole = deleteRole;
CloudAPI.prototype.DeleteRole = deleteRole;


/**
 * Retrieves the collection of role tags for the given resource path.
 *
 * @returns a JSObject, the collection of role tags.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} resource (required) path to the resource to retrieve
 *                 role tags for.
 * @param {Function} callback of the form f(err, roleTags).
 * @throws {TypeError} on bad input.
 */
function getRoleTags(account, resource, cb) {
    var self = this;

    if (typeof (resource) === 'function') {
        cb = resource;
        resource = account;
        account = this.account;
    }

    if (!resource || typeof (resource) !== 'string') {
        throw new TypeError('resource (string) required');
    }

    if (!cb || typeof (cb) !== 'function') {
        throw new TypeError('cb (function) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    var p = resource.split('/');
    if (p[0] !== '') {
        throw new TypeError('resource must begin with a \'/\'');
    }
    p.shift();

    if (p[0] === account || p[0] === 'my') {
        p.shift();
    }

    var validResources = [
        'machines', 'users', 'roles', 'packages',
        'images', 'policies', 'keys', 'datacenters',
        'analytics', 'fwrules', 'networks', 'instrumentations'
    ];

    if (p[0] && validResources.indexOf(p[0]) === -1) {
        throw new TypeError('resource must be one of : ' +
                validResources.join(', '));
    }

    // Either if the user specifies "/:account" or "/my", we always want
    // "/:account here":
    p.unshift(account);
    resource = '/' + p.join('/');

    return self._request(resource, null, function reqCb(req) {
        return self._get(req, function getCb(err, obj, headers) {
            if (err) {
                return cb(err);
            } else {
                var roleTags = (!headers['role-tag']) ? [] :
                    headers['role-tag'].split(',');
                return cb(null, roleTags);
            }
        }, false);
    });

}
CloudAPI.prototype.getRoleTags = getRoleTags;
CloudAPI.prototype.GetRoleTags = getRoleTags;


/**
 * Updates the collection of role tags for the given resource path.
 *
 * @returns a JSObject, the collection of role tags.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} resource (required) path to the resource to retrieve
 *                 role tags for.
 * @param {Object} roleTags (required) Array of role tags.
 * @param {Function} callback of the form f(err, roleTags).
 * @throws {TypeError} on bad input.
 */
function setRoleTags(account, resource, roleTags, cb) {
    var self = this;

    if (typeof (roleTags) === 'function') {
        cb = roleTags;
        roleTags = resource;
        resource = account;
        account = this.account;
    }

    if (!roleTags || typeof (roleTags) !== 'object') {
        throw new TypeError('roleTags (object) required');
    }

    if (!resource || typeof (resource) !== 'string') {
        throw new TypeError('resource (string) required');
    }

    if (!cb || typeof (cb) !== 'function') {
        throw new TypeError('cb (function) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    var p = resource.split('/');
    if (p[0] !== '') {
        throw new TypeError('resource must begin with a \'/\'');
    }
    p.shift();

    if (p[0] === account || p[0] === 'my') {
        p.shift();
    }

    var validResources = [
        'machines', 'users', 'roles', 'packages',
        'images', 'policies', 'keys', 'datacenters',
        'analytics', 'fwrules', 'networks', 'instrumentations'
    ];

    if (p[0] && validResources.indexOf(p[0]) === -1) {
        throw new TypeError('resource must be one of : ' +
                validResources.join(', '));
    }

    // Either if the user specifies "/:account" or "/my", we always want
    // "/:account here":
    p.unshift(account);
    resource = '/' + p.join('/');

    return self._request(resource, {
        'role-tag': roleTags
    }, function reqCb(req) {
        return self._put(req, cb);
    });
}
CloudAPI.prototype.setRoleTags = setRoleTags;
CloudAPI.prototype.SetRoleTags = setRoleTags;


// --- NIC-related functions

/**
 * Retrieves a NIC on one of an account's machines.
 *
 * Returns an object.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine is the UUID of the machine.
 * @param {String} mac is the MAC address of the NIC.
 * @param {Function} callback of the form f(err, nic).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getNic =
function getNic(account, machine, mac, callback, noCache) {
    var self = this;

    if (typeof (mac) === 'function') {
        callback = mac;
        mac = machine;
        machine = account;
        account = this.account;
    }

    if (typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    var path = sprintf(NIC, account, machine, mac.replace(/:/g, ''));

    return self._request(path, null, function (req) {
        return self._get(req, callback, noCache);
    });

};
CloudAPI.prototype.GetNic = CloudAPI.prototype.getNic;


/**
 * Creates a NIC on a machine. Note  that this reboots the machine as part of
 * the process.
 *
 * Returns a JS object (the created nic).
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options object containing:
 *                   - {String} network UUID of network to attach NIC to.
 *                   - {Object} machine to add NIC to.
 * @param {Function} callback of the form f(err, nic).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.createNic =
function createNic(account, options, callback) {
    var self = this;

    if (typeof (options) === 'function') {
        callback = options;
        options = account;
        account = this.account;
    }

    if (typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (typeof (options) !== 'object') {
        throw new TypeError('options (object) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    var machine = options.machine;
    var network = options.network;

    if (typeof (network) !== 'string') {
        throw new TypeError('network (string) required in options');
    }

    if (typeof (machine) !== 'string') {
        throw new TypeError('machine (string) required in options');
    }

    var path = sprintf(NICS, account, machine);

    return self._request(path, options, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.CreateNic = CloudAPI.prototype.createNic;


/**
 * Lists all NICs on a given machine.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine the UUID of the machine.
 * @param {Function} callback of the form f(err, macs).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.listNics =
function listNics(account, machine, callback, noCache) {
    var self = this;

    if (typeof (machine) === 'function') {
        noCache = callback;
        callback = machine;
        machine = account;
        account = this.account;
    }

    if (typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (typeof (machine) !== 'string') {
        throw new TypeError('machine (string) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    var path = sprintf(NICS, account, machine);

    self._request(path, null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.ListNics = CloudAPI.prototype.listNics;


/**
 * Removes a NIC from a machine. Note that this reboots the machine as part of
 * the process.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine is the UUID of the machine.
 * @param {String} mac is the MAC address of the NIC.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.deleteNic =
function deleteNic(account, machine, mac, callback) {
    var self = this;

    if (typeof (mac) === 'function') {
        callback = mac;
        mac = machine;
        machine = account;
        account = this.account;
    }

    if (typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (typeof (mac) !== 'string') {
        throw new TypeError('mac (string) required');
    }

    if (typeof (machine) !== 'string') {
        throw new TypeError('machine (string) required');
    }

    if (typeof (account) === 'object') {
        account = account.login;
    }

    var path = sprintf(NIC, account, machine, mac.replace(/:/g, ''));

    return self._request(path, null, function (req) {
        return self._del(req, callback);
    });
};
CloudAPI.prototype.DeleteNic = CloudAPI.prototype.deleteNic;


// --- Private Functions


CloudAPI.prototype._updateMachine =
function _updateMachine(account, machine, action, params, callback) {
    var self = this;

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
    var path = sprintf(MACHINE, account, name);

    return self._request(path, null, function reqCb(req) {
        req.expect = 202;
        _addToQuery(req, params);
        return self._post(req, callback);
    });
};


CloudAPI.prototype._error =
function _error(err) {
    assert.ok(err);
    // Handle self-signed certificates:
    if (/DEPTH_ZERO_SELF_SIGNED_CERT/.test(String(err))) {
        err.details = {
            code: 'InternalError',
            message: 'DEPTH_ZERO_SELF_SIGNED_CERT'
        };
        err.httpCode = 500;
    }

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
                log.warn({err: err, exception: e}, 'Invalid JSON for err');
            }
        }
    }

    return err;
};


CloudAPI.prototype._get =
function _get(req, callback, noCache) {
    assert.ok(req);
    assert.ok(callback);

    var self = this;

    // Check the cache first
    if (!noCache) {
        var cached = this._cacheGet(req.path, req.cacheTTL);
        if (cached && cached.obj) {
            log.debug('Getting %s from cache', req.path);
            if (cached.obj instanceof Error)
                return callback(cached.obj);

            return callback(null, cached.obj, cached.headers);
        }
    }

    // Issue HTTP request
    return this.client.get(req, function getCb(err, request, res, obj) {
        if (err) {
            err = self._error(err);
            log.error({err: err}, sprintf('CloudAPI._get(%s)', req.path));
        } else if (obj) {
            self._cachePut(req.path, {obj: obj, headers: res && res.headers});
            log.debug({obj: obj}, sprintf('CloudAPI._get(%s)', req.path));
        }

        return callback(err, obj, res && res.headers);
    });
};


CloudAPI.prototype._post =
function _post(req, callback) {
    assert.ok(req);
    assert.ok(callback);

    var self = this,
        body = req.body || {};
    delete req.body;

    // Issue HTTP request
    return this.client.post(req, body, function postCb(err, request, res, obj) {
        if (err) {
            err = self._error(err);
            log.error({err: err}, sprintf('CloudAPI._post(%s)', req.path));
        } else {
            log.debug({obj: obj}, sprintf('CloudAPI._post(%s)', req.path));
        }
        return callback(err, obj);
    });
};


CloudAPI.prototype._put =
function _put(req, callback) {
    assert.ok(req);
    assert.ok(callback);

    var self = this,
        body = req.body || {};
    delete req.body;

    // Issue HTTP request
    return this.client.put(req, body, function putCb(err, request, res, obj) {
        if (err) {
            err = self._error(err);
            log.error({err: err}, sprintf('CloudAPI._put(%s)', req.path));
        } else {
            log.debug({obj: obj}, sprintf('CloudAPI._put(%s)', req.path));
        }
        return callback(err, obj, res && res.headers);
    });
};


CloudAPI.prototype._del =
function _del(req, callback) {
    assert.ok(req);
    assert.ok(callback);

    var self = this;

    // Issue HTTP request
    return this.client.del(req, function delCb(err, request, res, obj) {
        if (err) {
            err = self._error(err);
            log.debug({err: err}, 'CloudAPI._del(%s) -> err', req.path);
        } else {
            self._cachePut(req.path, null);
            log.debug('CloudAPI._del(%s)', req.path);
        }

        return callback(err);
    });
};


CloudAPI.prototype._request =
function _request(path, body, callback) {
    assert.ok(path);
    assert.ok(body !== undefined);
    assert.ok(callback);

    var self = this;
    var now = new Date().toUTCString();

    var obj = {
        path: _encodeURI(path),
        headers: {
            date: now,
            'api-version': this.options.version
        },
        query: {}
    };

    if (this.asRole) {
        obj.query['as-role'] = this.asRole;
    }

    if (this.token !== undefined) {
        obj.headers['X-Auth-Token'] = this.token;
    }

    if (body) {
        obj.body = body;
    }

    _signRequest({
        headers: obj.headers,
        sign: self.sign
    }, function onSignRequest(err) {
        if (err) {
            throw (err);
        }

        return callback(obj);
    });
};


CloudAPI.prototype._cachePut =
function _cachePut(key, value) {
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
    log.debug({obj: obj}, 'CloudAPI._cachePut(%s)', key);
    this.cache.set(key, obj);
    return true;
};


CloudAPI.prototype._cacheGet =
function _cacheGet(key, expiry) {
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
            log.debug({obj: obj}, 'CloudAPI._cacheGet(%s): cache hit', key);
            return obj.value;
        }
    }

    log.debug('CloudAPI._cacheGet(%s): cache miss', key);
    return null;
};


// --- Additional methods from other files


for (var _proto in cli) {
    CloudAPI.prototype[_proto] = cli[_proto];
}


// --- Exports


module.exports = {
    CloudAPI: CloudAPI,

    createClient: function createClient(options) {
        return new CloudAPI(options);
    }
};
