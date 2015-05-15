/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * REST paths
 */



// --- Exports



module.exports = {
    config: '/%s/config',
    fabricNetwork: '/%s/fabrics/default/vlans/%d/networks/%s',
    fabricNetworks: '/%s/fabrics/default/vlans/%d/networks',
    network: '%s/networks/%s',
    networks: '%s/networks',
    vlan: '/%s/fabrics/default/vlans/%d',
    vlans: '/%s/fabrics/default/vlans'
};
