# node-smartdc Changelog

## 7.1.2

- #47: Deprecated '-e|--dataset' option to `sdc-listmachines` and
  `sdc-createmachine` in favor of '-i|--image'.

- #46: Fix '-d|--debug' option to actually include more logging. Example usage:

        sdc-listmachines -d 2>&1 | bunyan

- Improve printing of errors on the CLI. E.g.:

        $ sdc-createmachine -e asdf
        sdc-createmachine: error (InvalidArgument): asdf is not a valid image

  Before:

        $ sdc-createmachine -e asdf
        asdf is not a valid image


## 7.1.1

???


## 7.1.0

- [PUBAPI-660] Added `sdc-createimagefrommachine`, `sdc-deleteimage`,
  `sdc-updateimage`.

- [PUBAPI-675] Allow filtering of `sdc-listimages` by `public`, `state` and
  `type`.

- #34: Change `sdc-listimages` and `sdc-getimage` to use the appropriate
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

