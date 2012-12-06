node-smartdc is a node.js client library for interacting with the Joyent
SmartDataCenter API.  This package additionally contains a CLI you can use
to write scripts encapsulating most common tasks.

## Installation

You probably want to install this package globally, so the CLI commands are
always in your path.

    npm install smartdc -g

## Usage

### CLI

There are CLI commands corresponding to almost every action available in the
SmartDataCenter API; see the
[Joyent CloudAPI documentation](http://apidocs.joyent.com/sdcapidoc/cloudapi/) for
complete information, but to get started, you'll want to run the following:

    sdc-setup

The `sdc-setup` command will prompt you for your username and password, and
upload your SSH key.  All the rest of the CLI commands use your RSA private
key for signing requests to the API, rather than sending your password to the
Joyent API.  Once you've run `sdc-setup` (and set the environment variables
it indicates), you can provision a machine, and check it's status.  For example,
here's an example that creates a new node.js machine and tags it as a
'test' machine, then you can grab the status a few times until it's `running`.

Note this assumes you've also got [jsontool](https://github.com/trentm/json)
installed:

    sdc-createmachine -e nodejs -n demo -t group=test
    ...
    sdc-listmachines | json 0.state
      provisioning
    sdc-listmachines | json 0.state
      provisioning
    sdc-listmachines | json 0.state
      running

At that point, you can ssh into the machine; try this:

    ssh-add
    ssh -A admin@`./sdc-listmachines | json 0.ips[0]`

Note that we added your keys to the SSH agent, so that you can use the CLI
seamlessly on your new SmartMachine. Once you've played around and are done,
you can dispose of it; shut it down, then poll until it's `stopped`.

    sdc-listmachines | json 0.id | xargs sdc-stopmachine
    sdc-listmachines | json 0.state
      stopped
    sdc-listmachines | json 0.id | xargs sdc-deletemachine

There's a lot more you can do, like manage snapshots, analytics, keys, tags,
etc.

### Programmatic Usage

    var fs = require('fs');
    var smartdc = require('smartdc');

    // Read in the SSH private key
    var home = process.env.HOME;
    var key = fs.readFileSync(home + '/.ssh/id_rsa', 'ascii');

    var client = smartdc.createClient({
      url: 'https://api.no.de',
      key: key,
      keyId: '/<your login here>/keys/id_rsa'
    });

    client.listMachines(function(err, machines) {
      if (err) {
        console.log('Unable to list machines: ' + e);
	return;
      }

      machines.forEach(function(m) {
        console.log('Machine: ' + JSON.stringify(m, null, 2));
      });
    });

Check out the source documentation for JSDocs on the API.

## License

MIT.

## Bugs

See <https://github.com/joyent/node-smartdc/issues>.
