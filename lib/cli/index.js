/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Exports all of the CloudAPI methods broken out into separate files
 */

[
    require('./config'),
    require('./fabric-nets'),
    require('./fabric-vlans')
].forEach(function (mod) {
    for (var e in mod) {
        module.exports[e] = mod[e];
    }
});
