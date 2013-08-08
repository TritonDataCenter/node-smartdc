# node-smartdc Changelog

## smartdc 7.0.1 (not yet released)

- [issue #34] Change `sdc-listimages` and `sdc-getimage` to use the appropriate
  `/:account/images` CloudAPI endpoints.
- Added `sdc-enablemachinefirewall` and `sdc-disablemachinefirewall`
- Added `-f | --enable-firewall` option to `sdc-createmachine`

## smartdc 7.0.0

- Improved docs and usage strings

## smartdc 7.0.0-rc3

- Added `sdc-listnetworks` and `sdc-getnetwork`.

## smartdc 7.0.0-rc2

- Added "--networks|-w" argument to sdc-createmachine
- Update README with upgrade section

## smartdc 7.0.0-rc1

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

