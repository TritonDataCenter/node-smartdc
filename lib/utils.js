// Copyright 2011 Joyent, Inc.  All rights reserved.

var sprintf = require('sprintf').sprintf;

module.exports = {

  /**
   * Constructs a new HTTP Authorization header with the 'Basic' scheme.
   *
   * HTTP defines basic auth to be nothing but:
   *  Authorization: Basic Base64(<user>:<pass>)
   *
   * So that's what this gives back (the value for an Authorization header).
   *
   * @param {String} username duh.
   * @param {String} password another duh.
   * @return {String} value for an HTTP Authorization header.
   */
  basicAuth: function(username, password) {
    if (!username) throw new TypeError('username required');
    if (!password) throw new TypeError('password required');

    var buffer = new Buffer(username + ':' + password, 'utf8');
    return 'Basic ' + buffer.toString('base64');
  }

};
