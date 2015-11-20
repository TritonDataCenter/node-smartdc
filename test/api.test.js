/*
 * Copyright (c) 2015, Joyent, Inc. All rights reserved.
 */

var test = require('tap').test;
var util = require('util');
var uuid = require('node-uuid');
var fs = require('fs');
var exec = require('child_process').exec;
var smartdc = require('../lib');
var sdc;

var PACKAGE, IMAGE, MACHINE, NETWORK, NIC;

var TAG_KEY = 'smartdc_role';
var TAG_VAL = 'unitTest';

var TAG_TWO_KEY = 'smartdc_type';
var TAG_TWO_VAL = 'none';

var TAG_THREE_KEY = 'smartdc_whatever';
var TAG_THREE_VAL = 'whateverElse';

var META_KEY = 'foo';
var META_VAL = 'bar';

var META_CREDS = {
    'root': 'secret',
    'admin': 'secret'
};

var META_CREDS_TWO = {
    'root': 'secret',
    'admin': 'secret',
    'jill': 'secret'
};


test('setup', function (t) {
    var f = process.env.SSH_KEY || process.env.HOME + '/.ssh/id_rsa';
    var cmd = 'ssh-keygen -l -f ' +
                f + ' ' +
                '| awk \'{print $2}\'';
    var url = process.env.SDC_URL || 'http://localhost:8080';
    var user = process.env.SDC_ACCOUNT || 'test';

    fs.readFile(f, 'utf8', function (err, key) {
        t.ifError(err);

        exec(cmd, function (err2, stdout, stderr) {
            t.ifError(err2);

            sdc = smartdc.createClient({
                connectTimeout: 1000,
                logLevel: (process.env.LOG_LEVEL || 'info'),
                retry: false,
                sign: smartdc.cliSigner({
                    keyId: stdout.replace('\n', ''),
                    user: user
                }),
                url: url,
                account: user,
                noCache: true,
                rejectUnauthorized: false
            });

            t.end();
        });
    });
});


// --- SSH keys tests:
function checkKey(t, key) {
    t.ok(key);
    t.ok(key.name);
    t.ok(key.fingerprint);
    t.ok(key.key);
}


test('List keys', function (t) {
    sdc.listKeys(function (err, keys) {
        t.ifError(err);
        t.ok(keys.length);
        keys.forEach(function (key) {
            checkKey(t, key);
        });
        t.end();
    }, true);
});


test('Create Key', function (t) {
    var fname = __dirname + '/.ssh/test_id_rsa.pub';
    fs.readFile(fname, 'utf8', function (err, k) {
        t.ifError(err);
        sdc.createKey({
            key: k,
            name: 'test_id_rsa'
        }, function (err2, key) {
            t.ifError(err2);
            checkKey(t, key);
            t.end();
        });

    });
});


test('Get key', function (t) {
    sdc.getKey('test_id_rsa', function (err, key) {
        t.ifError(err);
        checkKey(t, key);
        t.end();
    }, true);
});


test('Delete key', function (t) {
    sdc.deleteKey('test_id_rsa', function (err) {
        t.ifError(err);
        t.end();
    }, true);
});



// Packages:
test('list packages', function (t) {
    sdc.listPackages(function (err, pkgs) {
        t.ifError(err);
        t.ok(pkgs);
        t.ok(Array.isArray(pkgs));
        var packages = pkgs.filter(function (p) {
            return (p['default'] === 'true');
        });
        PACKAGE = packages[0];
        // If there isn't a default package, use first one:
        if (!PACKAGE) {
            PACKAGE = pkgs[0];
        }
        if (!PACKAGE) {
            console.error('Exiting because cannot find test package.');
            process.exit(1);
        }
        t.end();
    }, true);
});


test('get package', function (t) {
    sdc.getPackage(PACKAGE.id, function (err, pkg) {
        t.ifError(err);
        t.ok(pkg);
        t.ok(pkg.name);
        t.ok(pkg.disk);
        t.ok(pkg.memory);
        t.ok(pkg.id);
        t.end();
    }, true);
});


test('list images', function (t) {
    sdc.listImages(function (err, images) {
        t.ifError(err);
        t.ok(images);
        t.ok(Array.isArray(images));

        // Let's pick an image we'll use for testing.
        var candidateImageNames = {
            'base-64-lts': true,
            'base-64': true,
            'minimal-64': true,
            'base-32-lts': true,
            'base-32': true,
            'minimal-32': true,
            'base': true
        };
        for (var i = 0; i < images.length; i++) {
            if (candidateImageNames[images[i].name]) {
                IMAGE = images[i];
                break;
            }
        }
        if (!IMAGE) {
            console.error('Exiting because cannot find test image.');
            process.exit(1);
        }

        t.end();
    }, true);
});


test('get image', function (t) {
    t.ok(IMAGE);

    sdc.getImage(IMAGE.id, function (err, ds) {
        t.ifError(err);
        t.ok(ds);
        t.ok(ds.name);
        t.ok(ds.version);
        t.ok(ds.os);
        t.ok(ds.id);
        t.end();
    }, true);
});


test('list networks', function (t) {
    sdc.listNetworks(function (err, networks) {
        t.ifError(err);
        t.ok(Array.isArray(networks));

        NETWORK = networks[0];
        t.ok(NETWORK);
        t.ok(NETWORK.id);
        t.ok(NETWORK.name);
        t.ok(typeof (NETWORK.public) === 'boolean');

        t.end();
    });
});


test('get network', function (t) {
    sdc.getNetwork(NETWORK.id, function (err, network) {
        t.ifError(err);

        t.ok(network);
        t.ok(network.id);
        t.ok(network.name);
        t.ok(typeof (network.public) === 'boolean');

        t.end();
    });
});


// Datacenters:
test('list datacenters', function (t) {
    sdc.listDatacenters(function (err, datacenters) {
        t.ifError(err);
        t.ok(datacenters);
        t.ok(Array.isArray(Object.keys(datacenters)));
        t.end();
    }, true);
});

// Machines:
function checkMachine(t, m) {
    t.ok(m, 'checkMachine ok');
    t.ok(m.id, 'checkMachine id ok');
    t.ok(m.name, 'checkMachine name ok');
    t.ok(m.type, 'checkMachine type ok');
    t.ok(m.state, 'checkMachine state ok');
    t.ok(m.image, 'checkMachine image ok');
    t.ok(m.ips, 'checkMachine ips ok');
    t.ok(m.memory, 'checkMachine memory ok');
    t.ok(m.metadata, 'checkMachine metadata ok');
    t.ok(m['package'], 'checkMachine package ok');
    t.ok(typeof (m.disk) !== 'undefined');
    t.ok(typeof (m.created) !== 'undefined');
    t.ok(typeof (m.updated) !== 'undefined');
}


var COUNT;
test('start machines list/count', function (t) {
    return sdc.countMachines(function (err, count, done) {
        t.ifError(err);
        COUNT = count;
        t.ok(done);
        return sdc.listMachines(function (err1, machines, done1) {
            t.ifError(err1);
            t.ok(Array.isArray(machines));
            t.equal(COUNT, machines.length);
            t.ok(done1);
            t.end();
        });
    });
});


function checkMachineAction(id, action, time, cb) {
    return sdc.getMachineAudit(id, function (err, actions) {
        if (err) {
            return cb(err);
        }

        var acts = actions.filter(function (a) {
            return (a.action === action && (new Date(a.time) > time));
        });

        if (acts.length === 0) {
            return cb(null, false);
        }

        var act = acts[0];
        if (act.success !== 'yes') {
            return cb(action + ' failed');
        }
        return cb(null, true);

    }, true);
}


function waitForAction(id, action, time, cb) {
    if (process.env.VERBOSE) {
        console.log('Waiting for machine \'%s\' %s to complete',
                id, action);
    }

    return checkMachineAction(id, action, time, function (err, ready) {
        if (err) {
            return cb(err);
        }

        if (!ready) {
            return setTimeout(function () {
                waitForAction(id, action, time, cb);
            }, (process.env.POLL_INTERVAL || 2500));
        }
        return cb(null);
    });
}


var NOW = new Date();

// Machine creation there we go!:
test('create machine', {
    timeout: 600000
}, function (t) {
    var opts = {
        image: IMAGE.id,
        name: 'a' + uuid.v4().substr(0, 7)
    };

    opts['package'] = PACKAGE.id;
    opts['metadata.' + META_KEY] = META_VAL;
    opts['tag.' + TAG_KEY] = TAG_VAL;
    opts['metadata.credentials'] = META_CREDS;

    sdc.createMachine(opts, function (err, machine) {
        if (err) {
            t.ifError(err);
            console.error('Exiting because machine creation failed.');
            process.exit(1);
        }
        waitForAction(machine.id, 'provision', NOW, function (err1) {
            if (err1) {
                t.ifError(err1);
                console.error('Exiting because machine provisioning failed');
                process.exit(1);
            }
            MACHINE = machine;
            t.end();
        });
    });
});


test('get machine', function (t) {
    sdc.getMachine(MACHINE.id, function (err, machine) {
        t.ifError(err);
        checkMachine(t, machine);
        t.ok(!machine.metadata.credentials);
        MACHINE = machine;
        t.test('get machine with credentials', function (t1) {
            sdc.getMachine(MACHINE.id, true, function (err1, machine1) {
                t1.ifError(err1);
                t1.ok(machine1.metadata.credentials);
                t1.end();
            }, true);
        });
        t.end();
    }, true);
});


test('machines list/count', function (t) {
    return sdc.countMachines(function (err, count, done) {
        t.ifError(err);
        t.equal(COUNT + 1, count);
        t.ok(done);
        return sdc.listMachines(function (err1, machines, done1) {
            t.ifError(err1);
            t.ok(Array.isArray(machines));
            t.equal(COUNT + 1, machines.length);
            t.ok(done1);
            t.end();
        });
    });
});


test('stop machine', {
    timeout: 180000
}, function (t) {
    sdc.stopMachine(MACHINE.id, function (err) {
        t.ifError(err);
        waitForAction(MACHINE.id, 'stop', NOW, function (err1) {
            t.ifError(err1);
            t.end();
        });
    });
});


test('start machine', {
    timeout: 180000
}, function (t) {
    sdc.startMachine(MACHINE.id, function (err) {
        t.ifError(err);
        waitForAction(MACHINE.id, 'start', NOW, function (err1) {
            t.ifError(err1);
            t.end();
        });
    });
});


test('list machine metadata', function (t) {
    sdc.listMachineMetadata(MACHINE.id, function (err, metadata) {
        t.ifError(err);
        t.ok(Object.keys(metadata).length > 1);
        t.equal(metadata[META_KEY], META_VAL);
        t.end();
    });
});


test('get machine metadata', function (t) {
    sdc.getMachineMetadataV2(MACHINE.id, META_KEY, function (err, metadata) {
        t.ifError(err);
        t.equal(metadata, META_VAL);
        t.end();
    });
});


test('update machine metadata', function (t) {
    var newMeta = {
        baz: 'quux'
    };

    sdc.updateMachineMetadata(MACHINE.id, newMeta, function (err, metadata) {
        t.ifError(err);
        t.ok(Object.keys(metadata).length > 2);
        t.equal(metadata.baz, 'quux');

        waitForAction(MACHINE.id, 'set_metadata', NOW, function (err1) {
            t.ifError(err1);

            sdc.getMachineMetadataV2(MACHINE.id, 'baz', function (err2, val) {
                t.ifError(err2);
                t.equal(val, 'quux');
                t.end();
            });
        });
    });
});


test('delete machine metadata', function (t) {
    sdc.deleteMachineMetadata(MACHINE.id, 'baz', function (err) {
        t.ifError(err);

        waitForAction(MACHINE.id, 'remove_metadata', NOW, function (err1) {
            t.ifError(err1);

            sdc.getMachineMetadataV2(MACHINE.id, 'baz', function (err2) {
                t.equal(err2.statusCode, 404);
                t.end();
            });
        });
    });
});


test('get machine tag', function (t) {
    sdc.getMachineTag(MACHINE.id, TAG_KEY, function (err, val) {
        t.ifError(err);
        t.equal(TAG_VAL, val);
        t.end();
    });
});


test('add machine tags', function (t) {
    var ID = MACHINE.id;
    var tags = {};
    tags[TAG_TWO_KEY] = TAG_TWO_VAL;
    tags[TAG_THREE_KEY] = TAG_THREE_VAL;
    sdc.addMachineTags(ID, tags, function (err) {
        t.ifError(err);
        waitForAction(ID, 'set_tags', NOW, function (er1) {
            t.ifError(er1);
            t.end();
        });
    });
});


test('list machine tags', function (t) {
    sdc.listMachineTags(MACHINE.id, function (err, tgs) {
        t.ifError(err);
        var tagNames = Object.keys(tgs);
        [TAG_KEY, TAG_TWO_KEY, TAG_THREE_KEY].forEach(function (name) {
            t.ok(tagNames.indexOf(name) !== -1);
        });
        t.end();
    });
});


test('delete machine tag', function (t) {
    sdc.deleteMachineTag(MACHINE.id, TAG_KEY, function (err) {
        t.ifError(err);
        waitForAction(MACHINE.id, 'remove_tags', NOW, function (er1) {
            t.ifError(er1);
            t.end();
        });
    });
});


test('replace machine tags', function (t) {
    var tags = {};
    tags[TAG_KEY] = TAG_VAL;
    sdc.replaceMachineTags(MACHINE.id, tags, function (err) {
        t.ifError(err);
        waitForAction(MACHINE.id, 'replace_tags', (new Date()), function (er1) {
            t.ifError(er1);
            t.end();
        });
    });
});



test('delete machine tags', function (t) {
    sdc.deleteMachineTags(MACHINE.id, function (err) {
        t.ifError(err);
        waitForAction(MACHINE.id, 'remove_tags', (new Date()), function (er1) {
            t.ifError(er1);
            t.end();
        });
    });
});



test('list machine nics', function (t) {
    sdc.listNics(MACHINE.id, function (err, nics) {
        t.ifError(err);

        t.ok(Array.isArray(nics));

        NIC = nics[0];
        t.ok(NIC);
        t.ok(NIC.mac);
        t.ok(NIC.ip);
        t.ok(NIC.netmask);
        t.ok(NIC.gateway);
        t.ok(NIC.state);
        t.ok(typeof (NIC.primary) === 'boolean');

        t.end();
    });
});


test('get machine nic', function (t) {
    sdc.getNic(MACHINE.id, NIC.mac, function (err, nic) {
        t.ifError(err);

        t.ok(typeof (nic) === 'object');
        t.ok(nic.mac);
        t.ok(nic.ip);
        t.ok(nic.netmask);
        t.ok(nic.gateway);
        t.ok(nic.state);
        t.ok(typeof (nic.primary) === 'boolean');

        t.end();
    });
});


test('remove machine nic', function (t) {
    sdc.deleteNic(MACHINE.id, NIC.mac, function (err) {
        t.ifError(err);

        waitForAction(MACHINE.id, 'remove_nics', NOW, function (err2) {
            t.ifError(err2);
            t.end();
        });
    });
});



test('add machine nic', function (t) {
    sdc.createNic({ machine: MACHINE.id, network: NETWORK.id }, function (err) {
        t.ifError(err);

        waitForAction(MACHINE.id, 'add_nics', NOW, function (err2) {
            t.ifError(err2);
            t.end();
        });
    });
});


// Note: Big chance for this test to be waiting for too long for a
// simple rename operation. Or maybe not.
test('rename machine', {
    timeout: 180000
}, function (t) {
    var name = 'b' + uuid.v4().substr(0, 7);
    sdc.renameMachine(MACHINE.id, {
        name: name
    }, function (err) {
        t.ifError(err);
        waitForAction(MACHINE.id, 'rename', NOW, function (err1) {
            t.ifError(err1);
            sdc.getMachine(MACHINE.id, function (er3, machine) {
                t.ifError(er3);
                t.equal(machine.name, name);
                MACHINE = machine;
                t.end();
            }, true);
        });
    });
});


test('reboot machine', {
    timeout: 180000
}, function (t) {
    sdc.rebootMachine(MACHINE.id, function (err) {
        t.ifError(err);
        waitForAction(MACHINE.id, 'reboot', NOW, function (err1) {
            t.ifError(err1);
            t.end();
        });
    });
});


test('delete machine', {
    timeout: 180000
}, function (t) {
    sdc.deleteMachine(MACHINE.id, function (err) {
        t.ifError(err);
        waitForAction(MACHINE.id, 'destroy', NOW, function (err1) {
            t.ifError(err1);
            t.end();
        });
    });
});


test('machine audit', function (t) {
    sdc.getMachineAudit(MACHINE.id, function (err, actions) {
        t.ifError(err);
        t.ok(Array.isArray(actions));
        t.ok(actions.length);
        var f = actions.reverse()[0];
        t.ok(f.success);
        t.ok(f.time);
        t.ok(f.action);
        t.ok(f.caller);
        t.ok(f.caller.type);
        t.equal(f.caller.type, 'signature');
        t.ok(f.caller.ip);
        t.ok(f.caller.keyId);
        t.end();
    }, true);
});


test('teardown', function (t) {
    sdc.client.close();
    t.end();
});
