// Copyright (c) 2013, Joyent, Inc. All rights reserved.

var cloudapi = require('./cloudapi');
var auth = require('smartdc-auth');

module.exports = {
    CloudAPI: cloudapi.CloudAPI,
    createClient: cloudapi.createClient,
    cliSigner: auth.cliSigner,
    privateKeySigner: auth.privateKeySigner,
    sshAgentSigner: auth.sshAgentSigner,
    signUrl: auth.signUrl,
    loadSSHKey: auth.loadSSHKey
};
