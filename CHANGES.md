# node-smartdc Changelog

## 8.0.1

- PUBAPI-1214 updated `sshpk-agent` dependency, to fix some bad-state bugs that
  cause the ssh-agent support to malfunction under load.

## 8.0.0

- PUBAPI-1161, PUBAPI-1180 - `brand` and `docker` attributes added to machine
objects, and the meaning of `type` on image objects has changed; these changes
improve the detail about the kind of machines and images available. The 6.5
API was slated for removal two years ago, so now removed; `sdc-listdatasets` and
`sdc-getdataset` have been removed (please use `sdc-listimages` and
`sdc-getimage` instead), and `getDataset()` and `listDatasets()` have been
removed (please use `getImage()` and `listImages()` instead). An `--api-version`
flag and `SDC_API_VERSION` environment variable has been added to all commands,
to allow API versions 7.0.0, 7.1.0, 7.2.0, 7.3.0 and 8.0.0 to be invoked.
sdc-listmachine now supports filtering with --brand.

## 7.6.2

- PUBAPI-1166 use smartdc-auth and http-signature instead of sprintf for
  generating Authorization headers

## 7.6.1

- #72 `sdc-fabric` doesn't honor command line flags.


## 7.6.0

- #73 revive CHANGES.md changelog

- #71 Fix data truncation (at 64k) from node-smartdc commands when piped to
  another command, when using node 4.1. E.g. `sdc-listimages | cat` would
  truncate.

- #70 Update dep to get newer dtrace-provider to fix build against node 4.x


## 7.5.x

- PUBAPI-1155, PUBAPI-1146: Updates to smartdc-auth@2.x to support `SDC_KEY_ID`
  being a fingerprint format other than the old `ssh-keygen` MD5 default.
  Recent `ssh-keygen` (e.g. as on Linuces for a while, and on Mac OS X El
  Capitan) changed the default fingerprint format from `ssh-keygen -l ...` to
  SHA1.
- TOOLS-1214 Large number of keys in ssh-agent leads to failure.


## 7.4.0

- TOOLS-1027 `sdc-fabric` support added. See
  <https://docs.joyent.com/public-cloud/network/sdn>.
  Implementation detail: `sdc-fabric` uses CloudAPI API version 7.3. Other
  commands continue to use API version 7.2 to function with older pre-fabrics
  CloudAPIs.


## 7.3.1

- PUBAPI-1053: Bumped dependencies to work with node v0.12.0


## 7.3.0

- PUBAPI-858: Updated to support RBAC. See
  <https://docs.joyent.com/public-cloud/rbac>.  Account sub-users can use the
  CLI now. New commands include: sdc-chmod, sdc-info, sdc-policy, sdc-role, and
  sdc-user.


## 7.2.1

- Add 'sdc-updateimage' for updating attributes on a custom image.

- issue#49: Add '--version' to all `sdc-\*` CLI tools.


## 7.2.0

- issue#43: Allow '-M|--metadata-file' option to `sdc-createmachine` and
  `sdc-updatemachinemetadata`.  Accepts a parameter of the form `"key=filename"`.
  Example usage:

        $ sdc-updatemachinemetadata \
            --metadata-file passwd_file=/etc/passwd \
            ${uuid}

## 7.1.2

- issue#47: Deprecated '-e|--dataset' option to `sdc-listmachines` and
  `sdc-createmachine` in favor of '-i|--image'.

- issue#46: Fix '-d|--debug' option to actually include more logging. Example usage:

        sdc-listmachines -d 2>&1 | bunyan

- Improve printing of errors on the CLI. E.g.:

        $ sdc-createmachine -e asdf
        sdc-createmachine: error (InvalidArgument): asdf is not a valid image

  Before:

        $ sdc-createmachine -e asdf
        asdf is not a valid image


## 7.1.0

- [PUBAPI-660] Added `sdc-createimagefrommachine`, `sdc-deleteimage`,
  `sdc-updateimage`.

- [PUBAPI-675] Allow filtering of `sdc-listimages` by `public`, `state` and
  `type`.

- issue#34: Change `sdc-listimages` and `sdc-getimage` to use the appropriate
  `/:account/images` CloudAPI endpoints.


## 7.0.1

- Added `sdc-enablemachinefirewall` and `sdc-disablemachinefirewall`
- Added `-f | --enable-firewall` option to `sdc-createmachine`

## 7.0.0

- Improved docs and usage strings

## 7.0.0-rc3

- Added `sdc-listnetworks` and `sdc-getnetwork`.

## 7.0.0-rc2

- Added "--networks|-w" argument to sdc-createmachine
- Update README with upgrade section

## 7.0.0-rc1

- New version to support SDC 7.0 new features.
- Added `/images` resource
- Added `/fwrules` resource
- Added machine `/audit`
- Added get/update account
- Added tests for everything
- Added token authentication
- Removed the `_CLI_` part from SDC env vars
- Removed basicAuth and `sdc-setup` due to PCI compliance
- Retrieve all machines tagged when `tags=*`
- Allow to upload DSA keys to Cloud API, but disallow using them with node-smartdc
- `PUT /tags` to `ReplaceMachineTags` exposed.
- Added Rename Machine
- Short option `-?`, valid for all the `sdc-*` commands
- Normalized arguments: when machine is required, is always last, not named, argument.
- Handle `noCache` option for machine metadata/tags

