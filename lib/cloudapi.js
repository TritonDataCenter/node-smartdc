/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 */

var assert = require('assert-plus');
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
    level: 'info',
    name: 'smartdc',
    stream: process.stderr,
    serializers: restify.bunyan.serializers
});

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


function signRequest(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.headers, 'options.headers');
    assert.func(cb, 'callback');

    if (!opts.sign) {
        return (cb(null));
    }

    assert.func(opts.sign, 'options.sign');

    opts.sign(opts.headers.date, function (err, obj) {
        if (err) {
            return (cb(err));
        }

        if (obj === null) {
            return (cb(null));
        }

        opts.headers.authorization = sprintf(SIGNATURE,
                                             obj.user,
                                             obj.keyId,
                                             obj.algorithm,
                                             obj.signature);

        return (cb(null));
    });

    return (null);
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
        options.version = '~7.2';

    this.account = options.account || 'my';
    this.sign = options.sign;

    options.contentType = 'application/json';

    options.retryCallback = function checkFor500(code) {
        return (code === 500);
    };

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
CloudAPI.prototype.updateAccount = function (account, opts, callback, noCache) {
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

    var self = this;
    return this._request(sprintf(ROOT, account), opts, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.UpdateAccount = CloudAPI.prototype.updateAccount;


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
        noCache = callback;
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var self = this;
    this._request(sprintf(KEYS, account), null, function (req) {
        if (noCache) {
            req.query = {sync: noCache};
        }
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

    var self = this;
    this._request(sprintf(KEY, account, name), null, function (req) {
        if (noCache) {
            req.query = {sync: noCache};
        }
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
CloudAPI.prototype.listImages = function (account, options, callback, noCache) {
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

    var self = this;
    return this._request(sprintf(IMAGES, account), null, function (req) {
        req.query = options;
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.ListImages = CloudAPI.prototype.listImages;


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
CloudAPI.prototype.getImage = function (account,
                                          image,
                                          callback,
                                          noCache) {
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

    var self = this;
    return this._request(sprintf(IMAGE, account, name), null,
            function (req) {
                return self._get(req, callback, noCache);
            });
};
CloudAPI.prototype.GetImage = CloudAPI.prototype.getImage;

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
CloudAPI.prototype.createImageFromMachine = function (account,
                                                        options,
                                                        callback) {
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

    var self = this;
    return this._request(sprintf(IMAGES, account), options, function (req) {
        return self._post(req, callback);
    });

};
CloudAPI.prototype.CreateImageFromMachine =
    CloudAPI.prototype.createImageFromMachine;


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
CloudAPI.prototype.updateImage = function (account, image, params, callback) {
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

    var self = this;
    return this._request(sprintf(IMAGE, account, name), null, function (req) {
        req.query = { action: 'update' };
        req.body = params;
        return self._post(req, callback);
    });

};
CloudAPI.prototype.updateImage = CloudAPI.prototype.updateImage;


CloudAPI.prototype.deleteImage = function (account,
                                            image,
                                            callback) {
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

    var id = (typeof (image) === 'object' ? image.id : image);

    var self = this;
    return this._request(sprintf(IMAGE, account, id), null, function (req) {
        return self._del(req, callback);
    });
};

CloudAPI.prototype.DeleteImage = CloudAPI.prototype.deleteImage;


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
CloudAPI.prototype.exportImage = function (account,
                                          image,
                                          mantaPath,
                                          callback,
                                          noCache) {
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

    var self = this;
    return this._request(sprintf(IMAGE, account, name), null, function (req) {
        req.query = { action: 'export', manta_path: mantaPath };
        return self._post(req, callback, noCache);
    });
};
CloudAPI.prototype.exportImage = CloudAPI.prototype.exportImage;


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
 * @param {Function} callback of the form f(err, client).
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
            var e = new restify.ResourceNotFoundError(
                'datacenter ' + datacenter + ' not found');
            e.name = 'CloudApiError';
            return callback(e);
        }

        var opts = clone(self.options);
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

    if (tags === '*') {
        options.tags = '*';
    } else {
        for (var k in tags) {
            if (tags.hasOwnProperty(k)) {
                options['tag.' + k] = tags[k];
            }
        }
    }

    var self = this;
    return this._request(sprintf(MACHINES, account), null, function (req) {
        req.query = options;
        return self.client.get(req, function (err, request, res, obj) {
            if (err) {
                log.error({err: err},
                    sprintf('CloudAPI._get(%s)', req.path));
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
 * Renames a machine under your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.renameMachine = function (account,
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

    return this._updateMachine(account, machine, 'rename', options, callback);
};
CloudAPI.prototype.RenameMachine = CloudAPI.prototype.renameMachine;


/**
 * Enables machine firewall.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.enableFirewall = function (account,
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

    return this._updateMachine(account, machine,
            'enable_firewall', {}, callback);
};
CloudAPI.prototype.EnableFirewall = CloudAPI.prototype.enableFirewall;


/**
 * Disables Machine firewall
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.disableFirewall = function (account,
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

    return this._updateMachine(account, machine,
        'disable_firewall', {}, callback);
};
CloudAPI.prototype.DisableFirewall = CloudAPI.prototype.disableFirewall;


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
 * Overwrites the set of tags to the machine.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Object} tags tags dictionary.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.replaceMachineTags = function (account,
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
        return self._put(req, callback);
    });
};
CloudAPI.prototype.ReplaceMachineTags = CloudAPI.prototype.replaceMachineTags;


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
CloudAPI.prototype.listMachineTags =
function (account, machine, callback, noCache) {
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
        return self._get(req, callback, noCache);
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
 * @param {Boolean} noCache disable caching of this result.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getMachineTag =
function (account, machine, tag, callback, noCache) {
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
        return self._get(req, callback, noCache);
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
 * @param {Boolean} noCache disable caching of this result.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getMachineMetadata = function (account,
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

    var m = (typeof (machine) === 'object' ? machine.id : machine);

    var self = this;
    var path = sprintf(METADATA, account, m);
    return this._request(path, null, function (req) {
        if (getCredentials)
            req.path += '?credentials=true';
        return self._get(req, callback, noCache);
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
 * @param {Object} options instrumentation options. (see CA docs).
 * @param {Function} callback of the form f(err, instrumentation).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getInstValue = function (account, inst, options, callback) {
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
    var self = this;
    return this._request(sprintf(INST_RAW, account, name), null,
            function (req) {
                req.query = options;
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
 * Get actions audit for a given machine.
 *
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine either the id, or can be the object returned in list
 *                 or create.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.getMachineAudit = function (account,
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
    return this._request(sprintf(AUDIT, account, m), null, function (req) {
        return self._get(req, callback, true);
    });
};
CloudAPI.prototype.GetMachineAudit =
    CloudAPI.prototype.getMachineAudit;



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
CloudAPI.prototype.createFwRule = function (account, options, callback) {
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

    var self = this;
    return this._request(sprintf(FWRULES, account), options, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.CreateFwRule = CloudAPI.prototype.createFwRule;
CloudAPI.prototype.CreateFirewallRule = CloudAPI.prototype.createFwRule;

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
CloudAPI.prototype.listFwRules = function (account, callback, noCache) {
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

    var self = this;
    this._request(sprintf(FWRULES, account), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.ListFwRules = CloudAPI.prototype.listFwRules;
CloudAPI.prototype.ListFirewallRules = CloudAPI.prototype.listFwRules;

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
CloudAPI.prototype.getFwRule = function (account, fwrule, callback, noCache) {
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

    var id = (typeof (fwrule) === 'object' ? fwrule.id : fwrule);

    var self = this;
    this._request(sprintf(FWRULE, account, id), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.GetFwRule = CloudAPI.prototype.getFwRule;
CloudAPI.prototype.GetFirewallRule = CloudAPI.prototype.getFwRule;

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
CloudAPI.prototype.updateFwRule = function (account, fwrule, opts, callback) {
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

    var id = (typeof (fwrule) === 'object' ? fwrule.id : fwrule);
    var self = this;
    return this._request(sprintf(FWRULE, account, id), opts, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.UpdateFwRule = CloudAPI.prototype.updateFwRule;
CloudAPI.prototype.UpdateFirewallRule = CloudAPI.prototype.updateFwRule;


/**
 * Enables a Firewall Rule.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} fwrule can be either the string id of the fwrule,
 *                 or the object returned from create/get.
 * @param {Function} callback of the form f(err, fwrule).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.enableFwRule = function (account, fwrule, callback) {
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

    var id = (typeof (fwrule) === 'object' ? fwrule.id : fwrule);

    var self = this;
    var p = sprintf(FWRULE, account, id) + '/enable';
    this._request(p, null, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.EnableFwRule = CloudAPI.prototype.enableFwRule;
CloudAPI.prototype.EnableFirewallRule = CloudAPI.prototype.enableFwRule;


/**
 * Disables a Firewall Rule.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} fwrule can be either the string id of the fwrule,
 *                 or the object returned from create/get.
 * @param {Function} callback of the form f(err, fwrule).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.disableFwRule = function (account, fwrule, callback) {
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

    var id = (typeof (fwrule) === 'object' ? fwrule.id : fwrule);

    var self = this;
    var p = sprintf(FWRULE, account, id) + '/disable';
    this._request(p, null, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.DisableFwRule = CloudAPI.prototype.disableFwRule;
CloudAPI.prototype.DisableFirewallRule = CloudAPI.prototype.disableFwRule;


/**
 * Deletes Firewall Rule.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} fwrule can be either the string id of the fwrule,
 *                 or the object returned from create/get.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.deleteFwRule = function (account, fwrule, callback) {
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

    var id = (typeof (fwrule) === 'object' ? fwrule.id : fwrule);

    var self = this;
    return this._request(sprintf(FWRULE, account, id), null, function (req) {
        return self._del(req, callback);
    });
};
CloudAPI.prototype.DeleteFirewallRule = CloudAPI.prototype.deleteFwRule;
CloudAPI.prototype.DeleteFwRule = CloudAPI.prototype.deleteFwRule;


/**
 * Lists all the Firewall Rules affecting the given machine.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} machine the uuid of the machine, or an object from create
 *                         or list or get machine.
 * @param {Function} cb of the form f(err, fwrules).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.listMachineRules = function (account, machine, cb, noCache) {
    if (typeof (machine) === 'function') {
        cb = machine;
        machine = account;
        account = this.account;
    }
    if (!cb || typeof (cb) !== 'function') {
        throw new TypeError('cb (function) required');
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
    var self = this;
    var p = sprintf(MACHINE, account, machine) + '/fwrules';
    this._request(p, null, function (req) {
        return self._get(req, cb, noCache);
    });
};
CloudAPI.prototype.ListMachineRules = CloudAPI.prototype.listMachineRules;


/**
 * Lists all the Machines affected by the given firewall rule.
 *
 * Returns an array of objects.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} fwrule the uuid of the fwrule, or an object from create
 *                         or list or get fwrule.
 * @param {Function} cb of the form f(err, machines).
 * @param {Boolean} noCache optional flag to force skipping the cache.
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.listRuleMachines = function (account, fwrule, cb, noCache) {
    if (typeof (fwrule) === 'function') {
        cb = fwrule;
        fwrule = account;
        account = this.account;
    }
    if (!cb || typeof (cb) !== 'function') {
        throw new TypeError('cb (function) required');
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
    var self = this;
    var p = sprintf(FWRULE, account, fwrule) + '/machines';
    this._request(p, null, function (req) {
        return self._get(req, cb, noCache);
    });
};
CloudAPI.prototype.ListRuleMachines = CloudAPI.prototype.listRuleMachines;


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
CloudAPI.prototype.listNetworks = function (account, callback, noCache) {
    if (typeof (account) === 'function') {
        callback = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (function) required');
    if (typeof (account) === 'object')
        account = account.login;

    var self = this;
    return this._request(sprintf(NETWORKS, account), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.ListNetworks = CloudAPI.prototype.listNetworks;


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
CloudAPI.prototype.getNetwork = function (account, net, callback, noCache) {
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

    var id = (typeof (net) === 'object' ? net.id : net);

    var self = this;
    return this._request(sprintf(NETWORK, account, id), null,
            function (req) {
                return self._get(req, callback, noCache);
            });
};
CloudAPI.prototype.GetNetwork = CloudAPI.prototype.getNetwork;


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
CloudAPI.prototype.getUser = function (account, user, callback, noCache) {
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

    if (typeof (user) === 'object') {
        user = user.id;
    }

    var self = this;
    return this._request(sprintf(USER, account, user), null, function (req) {
        return self._get(req, callback, noCache);
    });

};
CloudAPI.prototype.GetUser = CloudAPI.prototype.getUser;


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
CloudAPI.prototype.updateUser = function (account, opts, callback, noCache) {
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

    var self = this;
    var p = sprintf(USER, account, opts.id);
    return this._request(p, opts, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.UpdateUser = CloudAPI.prototype.updateUser;


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
CloudAPI.prototype.changeUserPassword = function (account, opts, cb, noCache) {
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

    var self = this;
    var p = sprintf(USER, account, opts.id) + '/change_password';
    return this._request(p, opts, function (req) {
        return self._post(req, cb);
    });
};
CloudAPI.prototype.ChangeUserPassword = CloudAPI.prototype.changeUserPassword;


/**
 * Creates a User on your account.
 *
 * Returns a JS object (the created user).
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options object containing:
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
CloudAPI.prototype.createUser = function (account, options, callback) {
    if (typeof (options) === 'function') {
        callback = options;
        options = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (!options || typeof (options) !== 'object') {
        throw new TypeError('options (object) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }


    var self = this;
    return this._request(sprintf(USERS, account), options, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.CreateUser = CloudAPI.prototype.createUser;


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
CloudAPI.prototype.listUsers = function (account, callback, noCache) {
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
    this._request(sprintf(USERS, account), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.ListUsers = CloudAPI.prototype.listUsers;


/**
 * Deletes a User from your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} user can be either the string id of the user, or the object
 *                 returned from create/get.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.deleteUser = function (account, user, callback) {
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

    var self = this;
    return this._request(sprintf(USER, account, id), null, function (req) {
        return self._del(req, callback);
    });
};
CloudAPI.prototype.DeleteUser = CloudAPI.prototype.deleteUser;


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
CloudAPI.prototype.uploadUserKey = function (account, user, options, callback) {
    if (typeof (options) === 'function') {
        callback = options;
        options = user;
        user = account;
        account = this.account;
    }

    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }

    if (!options ||
      (typeof (options) !== 'string' && typeof (options) !== 'object')) {
        throw new TypeError('options (object) required');
    }

    if (typeof (user) === 'object') {
        user = user.id;
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }

    if (typeof (options) === 'string') {
        options = {
            key: options
        };
    }

    var self = this;
    var p = sprintf(SUB_KEYS, account, user);
    return this._request(p, options, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.UploadUserKey = CloudAPI.prototype.uploadUserKey;


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
CloudAPI.prototype.listUserKeys = function (account, user, callback, noCache) {
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

    var self = this;
    var p = sprintf(SUB_KEYS, account, user);
    this._request(p, null, function (req) {
        if (noCache) {
            req.query = {sync: noCache};
        }
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.ListUserKeys = CloudAPI.prototype.listUserKeys;


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
CloudAPI.prototype.getUserKey =
function (account, user, key, callback, noCache) {
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

    var self = this;
    var p = sprintf(SUB_KEY, account, user, name);
    this._request(p, null, function (req) {
        if (noCache) {
            req.query = {sync: noCache};
        }
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.GetUserKey = CloudAPI.prototype.getUserKey;


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
CloudAPI.prototype.deleteUserKey = function (account, user, key, callback) {
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

    var self = this;
    var p = sprintf(SUB_KEY, account, user, name);
    return this._request(p, null, function (req) {
        return self._del(req, callback);
    });
};
CloudAPI.prototype.DeleteUserKey = CloudAPI.prototype.deleteUserKey;


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
CloudAPI.prototype.getPolicy = function (account, policy, callback, noCache) {
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

    var self = this;
    return this._request(sprintf(POLICY, account, policy), null,
            function (req) {
        return self._get(req, callback, noCache);
    });

};
CloudAPI.prototype.GetPolicy = CloudAPI.prototype.getPolicy;


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
CloudAPI.prototype.updatePolicy = function (account, opts, callback, noCache) {
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

    var self = this;
    var p = sprintf(POLICY, account, opts.id);
    return this._request(p, opts, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.UpdatePolicy = CloudAPI.prototype.updatePolicy;


/**
 * Creates a Policy on your account.
 *
 * Returns a JS object (the created user).
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options object containing:
 *                   - {String} name (optional) for the policy.
 *                   - {String} rules (optional) for the policy.
 *                   - {String} description (optional) for the policy.
 * @param {Function} callback of the form f(err, policy).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.createPolicy = function (account, options, callback) {
    if (typeof (options) === 'function') {
        callback = options;
        options = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (!options || typeof (options) !== 'object') {
        throw new TypeError('options (object) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }


    var self = this;
    return this._request(sprintf(POLICIES, account), options, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.CreatePolicy = CloudAPI.prototype.createPolicy;


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
CloudAPI.prototype.listPolicies = function (account, callback, noCache) {
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
    this._request(sprintf(POLICIES, account), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.ListPolicies = CloudAPI.prototype.listPolicies;


/**
 * Deletes a Policy from your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} policy can be either the string id of the policy,
 *                 or the object returned from create/get.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.deletePolicy = function (account, policy, callback) {
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

    var id = (typeof (policy) === 'object' ? policy.id : policy);

    var self = this;
    return this._request(sprintf(POLICY, account, id), null, function (req) {
        return self._del(req, callback);
    });
};
CloudAPI.prototype.DeletePolicy = CloudAPI.prototype.deletePolicy;


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
CloudAPI.prototype.getRole = function (account, role, callback, noCache) {
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

    var self = this;
    return this._request(sprintf(ROLE, account, role), null, function (req) {
        return self._get(req, callback, noCache);
    });

};
CloudAPI.prototype.GetRole = CloudAPI.prototype.getRole;


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
CloudAPI.prototype.updateRole = function (account, opts, callback, noCache) {
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

    var self = this;
    return this._request(sprintf(ROLE, account, opts.id), opts, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.UpdateRole = CloudAPI.prototype.updateRole;


/**
 * Creates a Role on your account.
 *
 * Returns a JS object (the created role).
 *
 * @param {String} account (optional) the login name of the account.
 * @param {Object} options object containing:
 *                   - {String} name (optional) name for your role.
 *                   - {Object} members (optional) for the role.
 *                   - {Object} default_members (optional) for the role.
 *                   - {Object} policies (optional) for the role.
 * @param {Function} callback of the form f(err, role).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.createRole = function (account, options, callback) {
    if (typeof (options) === 'function') {
        callback = options;
        options = account;
        account = this.account;
    }
    if (!callback || typeof (callback) !== 'function') {
        throw new TypeError('callback (function) required');
    }
    if (!options || typeof (options) !== 'object') {
        throw new TypeError('options (object) required');
    }
    if (typeof (account) === 'object') {
        account = account.login;
    }


    var self = this;
    return this._request(sprintf(ROLES, account), options, function (req) {
        return self._post(req, callback);
    });
};
CloudAPI.prototype.CreateRole = CloudAPI.prototype.createRole;


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
CloudAPI.prototype.listRoles = function (account, callback, noCache) {
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
    this._request(sprintf(ROLES, account), null, function (req) {
        return self._get(req, callback, noCache);
    });
};
CloudAPI.prototype.ListRoles = CloudAPI.prototype.listRoles;


/**
 * Deletes a Role from your account.
 *
 * @param {String} account (optional) the login name of the account.
 * @param {String} role can be either the string id of the role, or the object
 *                 returned from create/get.
 * @param {Function} callback of the form f(err).
 * @throws {TypeError} on bad input.
 */
CloudAPI.prototype.deleteRole = function (account, role, callback) {
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

    var id = (typeof (role) === 'object' ? role.id : role);

    var self = this;
    return this._request(sprintf(ROLE, account, id), null, function (req) {
        return self._del(req, callback);
    });
};
CloudAPI.prototype.DeleteRole = CloudAPI.prototype.deleteRole;

// --- Private Functions

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
                log.warn({err: err, exception: e}, 'Invalid JSON for err');
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
            console.log('Getting %s from cache', req.path);
            if (cached instanceof Error)
                return callback(cached);

            return callback(null, cached);
        }
    }

    // Issue HTTP request
    return this.client.get(req, function (err, request, res, obj) {
        if (err) {
            err = self._error(err);
            log.error({err: err}, sprintf('CloudAPI._get(%s)', req.path));
        } else if (obj) {
            self._cachePut(req.path, obj);
            log.debug({obj: obj}, sprintf('CloudAPI._get(%s)', req.path));
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
            log.error({err: err}, sprintf('CloudAPI._post(%s)', req.path));
        } else {
            log.debug({obj: obj}, sprintf('CloudAPI._post(%s)', req.path));
        }
        return callback(err, obj);
    });
};


CloudAPI.prototype._put = function (req, callback) {
    assert.ok(req);
    assert.ok(callback);

    var self = this,
        body = req.body || {};
    delete req.body;

    // Issue HTTP request
    return this.client.put(req, body, function (err, request, res, obj) {
        if (err) {
            err = self._error(err);
            log.error({err: err}, sprintf('CloudAPI._put(%s)', req.path));
        } else {
            log.debug({obj: obj}, sprintf('CloudAPI._put(%s)', req.path));
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
            log.debug({err: err}, 'CloudAPI._del(%s) -> err', req.path);
        } else {
            self._cachePut(req.path, null);
            log.debug('CloudAPI._del(%s)', req.path);
        }

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
            date: now,
            'api-version': '~7.1'
        }
    };

    if (this.token !== undefined) {
        obj.headers['X-Auth-Token'] = this.token;
    }

    if (body) {
        obj.body = body;
    }

    signRequest({
        headers: obj.headers,
        sign: self.sign
    }, function onSignRequest(err) {
        if (err) {
            throw (err);
        }

        return callback(obj);
    });
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
    log.debug({obj: obj}, 'CloudAPI._cachePut(%s)', key);
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
            log.debug({obj: obj}, 'CloudAPI._cacheGet(%s): cache hit', key);
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
