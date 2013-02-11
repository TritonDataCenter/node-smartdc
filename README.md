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
complete information, but to get started, you can set environment variables for
the following flags so that you don't have to type them for each request:

* `SDC_CLI_URL` || `--url | -u`: URL of the CloudAPI endpoint.
* `SDC_CLI_ACCOUNT` || `--account | -a`: Login name (account).
* `SDC_CLI_KEY_ID` || `--keyId | -k`: Fingerprint of the key to use for signing.

Faster way to get your key fingerprint is:

    ssh-keygen -l -f ~/.ssh/id_rsa.pub | awk '{print $2}' | tr -d '\n'

where you obviously replace `~/.ssh/id_rsa.pub` with the path to your the
public key you wan to use for signing requests.

All of the CLI commands use your RSA private key for signing requests to the API,
rather than sending your password to the Joyent API.  Once you've set the environment
variables, you can provision a machine, and check it's status.  For example,
here's how you can create a new machine and tag it as a 'test' machine, then
you can grab the status a few times until it's `running`.

Note this assumes you've also got [jsontool](https://github.com/trentm/json)
installed:

    IMAGE=`./bin/sdc-listimages | json 0.id`
    sdc-createmachine -e $IMAGE -n demo -t group=test
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

    var client = smartdc.createClient({
        sign: smartdc.privateKeySigner({
            key: fs.readFileSync(process.env.HOME + '/.ssh/id_rsa', 'utf8'),
            keyId: process.env.SDC_CLI_KEY_ID,
            user: process.env.SDC_CLI_ACCOUNT
        }),
        user: process.env.SDC_CLI_ACCOUNT,
        url: process.env.SDC_CLI_URL
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

## Running the test suite

Note that *this will execute tests against the Smart DC setup set into
ENV variable SDC_CLI_URL*. Please, make sure it's OK to try to create new
machines into such Smart DC setup before running this test suite.

Running the test suite is as simple as:

    make test

You may want to add a test user to your Smart DC setup. A sample user, with
sample ssh keys can be found at `test/user.ldif` and `test/.ssh`. Once you've
added this user, you can run your tests using:

    SDC_CLI_URL=http://127.0.0.1:8080 \
    SDC_CLI_ACCOUNT=test \
    SDC_CLI_KEY_ID=id_rsa \
    HOME="$(pwd)/test" \
    make test
