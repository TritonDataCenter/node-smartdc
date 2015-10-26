/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Exported `emit` and `exit` methods to replace `process.stdout.write` and
 * `process.exit` such that stdout is flushed on process.exit.
 *
 * Code adapted from joyent/manta-thoth.
 */

var util = require('util');


var writable = true;


function exit(code, asynchronous) {
    var exiting = {};

    /*
     * Unfortunately, node's process.exit() does no flushing of output
     * for us.  And because we have scattered state that we don't want to
     * bother cleaning up to induce a proper exit, to correctly exit we
     * need to not actually exit until stdout is known to be writable
     * (indicating that it has been successfully flushed).
     */
    if (writable)
        process.exit(code);

    setTimeout(function () { exit(code, true); }, 10);

    if (asynchronous)
        return;

    /*
     * If we have been called synchronously, callers are expecting exit()
     * to not return.  To effect this, we throw a bogus exception and
     * then use an installed uncaughtException listener to catch this
     * sentinel and ignore it -- which allows I/O to be asynchronously
     * flushed and process.exit() to be ultimately called.
     */
    process.addListener('uncaughtException', function (err) {
        if (err === exiting)
            return;

        process.stderr.write('uncaught exception: ' +
            util.inspect(err) + '\n');
        process.exit(1);
    });

    throw (exiting);
}

process.stdout.on('drain', function () { writable = true; });

function emit(str) {
    writable = process.stdout.write(str +
        (str[str.length - 1] != '\n' ? '\n' : ''));
}



module.exports = {
    emit: emit,
    exit: exit
};
