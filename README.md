node-smartdc is a node.js client library and set of CLI tools for using with
the [Joyent SmartDataCenter API](http://apidocs.joyent.com/cloudapi/), for
example the [Joyent Compute
Service](http://www.joyent.com/products/compute-service).

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md)
and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

(Note: Current releases and the #master branch of this are for SmartDataCenter
(SDC) version 7.  It is not 100% backward compatible with SDC 6.5. For 100%
compatility with SDC 6.5, you must install a "6.5.x" version of this module.)


# Installation

To use the CLI tools (a number of `sdc-*` commands) you may want to install
globally:

    npm install -g smartdc

The CLI commands typical work with JSON content. We suggest you also install
the [`json` tool](https://github.com/trentm/json) for working with JSON on the
command line. The examples below use `json` heavily.

    npm install -g json


# CLI Setup and Authentication

There are CLI commands corresponding to almost every action available in the
SmartDataCenter API; see the [Joyent CloudAPI
documentation](http://apidocs.joyent.com/cloudapi/) for complete information.
Each command takes `--url`, `--account`, and `--keyId` flags to provide the
API endpoint URL and your credentials. However you'll probably want to set
the environment variable equivalents:

* `SDC_URL` (`--url | -u`): URL of the CloudAPI endpoint. E.g.
  "https://us-east-1.api.joyent.com".
* `SDC_ACCOUNT` (`--account | -a`): Login name/username. E.g. "bob".
* `SDC_KEY_ID` (`--keyId | -k`): The fingerprint of an SSH public key that has
  been added to the account set in `SDC_ACCOUNT`. This is used for signing
  requests. If you use an SSH agent, the fingerprint is shown in `ssh-add -l`
  output. You can calculate the fingerprint like this:

        ssh-keygen -l -f ~/.ssh/id_rsa.pub | awk '{print $2}' | tr -d '\n'

  Your matching SSH *private* key must be beside the ".pub" public key file
  in your "~/.ssh" dir.

  If your client is connecting to a CloudAPI service that is using a self-signed
  SSL certificate, you may need to set `SDC_TESTING=1` in your client environent.
  (Otherwise you'll get `DEPTH_ZERO_SELF_SIGNED_CERT` error).

## Authenticating as account user

Starting with version 7.3, [Role Based Access Control](https://docs.joyent.com/public-cloud/rbac)
lets you provide limited access to to your Joyent Cloud account and Manta
storage to other members of your organization.

In order to authenticate as a member of a given organization, `SDC_ACCOUNT`
will remain set to the login associated with the organization, and we'll use
the `SDC_USER` environment variable to identify ourselves as a member of such
organization. We can also use the `--A | --user` command line argument with
any of the `sdc-*` commands if we just want to operate as an account user for
just that command.

Remember that if the environment variable `SDC_USER` is set, `sdc-*` binaries
will remain trying to operate as the given user. If you've set this variable and
want to switch back to operate as the account owner, you should
`unset SDC_USER`.


The SmartDataCenter Cloud API uses
[http-signature](https://github.com/joyent/node-http-signature) ([IETF draft
spec](http://tools.ietf.org/id/draft-cavage-http-signatures-00.txt)) for
authentication. All requests to the API are signed using your RSA private key.
The server uses your (previously uploaded) public key to verify the signed
request. This avoids ever sending a password.

Once you have set the environment variables, check that it is working by
listing available images for provisioning:

    $ sdc-listimages
    [
      {
        "id": "753ceee6-5372-11e3-8f4e-f79c1154e596",
        "name": "base",
        "version": "13.3.0",
        "os": "smartos",
        "requirements": {},
        "type": "smartmachine",
        "description": "A 32-bit SmartOS image with just essential packages installed. Ideal for users who are comfortable with setting up their own environment and tools.",
        "owner": "9dce1460-0c4c-4417-ab8b-25ca478c5a78",
        "homepage": "http://wiki.joyent.com/jpc2/SmartMachine+Base",
        "published_at": "2013-11-22T12:34:40Z",
        "public": true,
        "state": "active"
      },
    ...


# CLI Usage

There are many many `sdc-*` commands. Typically one for each endpoint in
[the API](http://apidocs.joyent.com/cloudapi/). A common one is for provisioning
a new machine (aka VM). Let's provision a new "base" (SmartOS) machine. First
find the id of the "base" image (version 13.3.0):

    $ IMAGE=$(sdc-listimages | json -c 'this.name=="base" && this.version=="13.3.0"' 0.id)
    $ PACKAGE=$(sdc-listpackages | json -c 'this.name=="t4-standard-1G"' 0.id)
    $ sdc-createmachine --image $IMAGE --package $PACKAGE --name mymachine1
    $ sdc-getmachine f8f995da-086f-e8f5-c062-992139432c4f
    {
      "id": "f8f995da-086f-e8f5-c062-992139432c4f",
      "name": "mymachine1",
      "type": "smartmachine",
      "state": "provisioning",
      "image": "753ceee6-5372-11e3-8f4e-f79c1154e596",
      ...
    }

Then you can poll until the state of the machine goes to "running":

    $ sdc-getmachine f8f995da-086f-e8f5-c062-992139432c4f | json state
    provisioning
    ...
    $ sdc-getmachine f8f995da-086f-e8f5-c062-992139432c4f | json state
    running

At that point, you can ssh into the machine; try this:

    $ IP=$(sdc-getmachine f8f995da-086f-e8f5-c062-992139432c4f | json primaryIp)
    $ ssh root@$IP
    ...
       __        .                   .
     _|  |_      | .-. .  . .-. :--. |-
    |_    _|     ;|   ||  |(.-' |  | |
      |__|   `--'  `-' `;-| `-' '  ' `-'
                       /  ; Instance (base 13.3.0)
                       `-'  http://wiki.joyent.com/jpc2/SmartMachine+Base

    [root@f8f995da-086f-e8f5-c062-992139432c4f ~]#


Once you've played around and are done, you can delete this machine.

    $ sdc-deletemachine f8f995da-086f-e8f5-c062-992139432c4f
    ...
    $ sdc-getmachine f8f995da-086f-e8f5-c062-992139432c4f
    Object is Gone (410)

There's a lot more you can do, like manage snapshots, keys, tags,
etc. For the *Joyent* cloud, you can read more at <https://docs.joyent.com>.


# Programmatic Usage

    var fs = require('fs');
    var smartdc = require('smartdc');

    var client = smartdc.createClient({
        sign: smartdc.privateKeySigner({
            key: fs.readFileSync(process.env.HOME + '/.ssh/id_rsa', 'utf8'),
            keyId: process.env.SDC_KEY_ID,
            user: process.env.SDC_ACCOUNT
        }),
        user: process.env.SDC_ACCOUNT,
        url: process.env.SDC_URL
    });

    client.listMachines(function(err, machines) {
        if (err) {
            console.log('Unable to list machines: ' + err);
            return;
        }

        machines.forEach(function(m) {
            console.log('Machine: ' + JSON.stringify(m, null, 2));
        });
    });



# Upgrading from 6.5 to 7.0

* The environment variables changed from 6.5 to 7 (the `CLI_` string was
  dropped):
    * `SDC_CLI_ACCOUNT` ==> `SDC_ACCOUNT`
    * `SDC_CLI_URL` ==> `SDC_URL`
    * `SDC_CLI_KEY_ID` ==> `SDC_KEY_ID`
* The `SDC_CLI_IDENTITY` environment variable is no longer used. See above
  on how to determine your public key fingerprint for `SDC_KEY_ID`.
* The `sdc-setup` command was removed.

Note that in 6.5, `SDC_CLI_KEY_ID` was the *name* of the SSH key as specified in
your Joyent Cloud account. In 7.0, `SDC_KEY_ID` is the *fingerprint* of your
SSH public key.


# License

MIT. See the "LICENSE" file.


# Development

## Contributing

A few basic rules and guidelines:

- Read the [Joyent Engineering Guidelines on tickets/issues and commit
  comments](https://github.com/joyent/eng/blob/master/docs/index.md#commit-comments-and-jira-tickets).
  List GitHub issues and/or Joyent JIRA tickets in commit messages and ensure
  thought processes are included in the issues or commit messages.

- You typically want to bump the package.json version for all but trivial
  changes.

- Update CHANGES.md (the change log) for any additions.

- Run and pass `make check`.

- Run and pass `make test` (caveat: I'm not sure it is passing *right now*.)
  Be aware that this module is meant to work with older node versions
  and on a number of platforms (smartos, linux, mac, windows).

## Bugs

Please report issues to <https://github.com/joyent/node-smartdc/issues>.


## Running the test suite

Note that *this will run API calls against the SmartDataCenter setup per
the `SDC_*` environment variables*.  Please, make sure it is okay to try to
create new machines using the configured DC and account before running the
test suite.

    make test

You may want to add a test user to your SDC setup. A sample user, with
sample ssh keys can be found at `test/user.ldif` and `test/.ssh`. Once you've
added this user, you can run your tests using:

    SDC_URL=http://127.0.0.1:8080 \
        SDC_ACCOUNT=test \
        SDC_KEY_ID=id_rsa \
        HOME="$(pwd)/test" \
        VERBOSE=1 \
        make test
