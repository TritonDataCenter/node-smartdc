// Copyright 2012 Joyent, Inc.  All rights reserved.

var cloudapi = require('./cloudapi');

module.exports = {

    CloudAPI: cloudapi.CloudAPI,

    createClient: cloudapi.createClient

};
