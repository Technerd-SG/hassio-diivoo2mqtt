const test = require('node:test');
const assert = require('node:assert/strict');
const GatewayNode = require('./GatewayNode');

function createBareGateway() {
    const events = [];
    const node = Object.create(GatewayNode.prototype);
    Object.assign(node, {
        id: 'test-gateway',
        client: { destroyed: false, writable: true, write() {} },
        hub: { emit: (...args) => events.push(args) },
        isConnected: false,
        pendingHeartbeat: null,
        pendingTune: null,
        pendingTx: null,
        pendingControl: null,
        pendingInboundWait: null,
        currentRadio: { txChannel: 4, rxChannel: 0, txProfile: 'short' },
        lastSeenAt: 0,
    });
    return { node, events };
}

test('parses gateway MAC from current firmware VERSION response', () => {
    const { node } = createBareGateway();

    const info = node._parseVersionLine('VERSION:tcp_gateway_WG03:0.1.11:AA:BB:CC:DD:EE:FF');

    assert.equal(info.model, 'tcp_gateway_WG03');
    assert.equal(info.version, '0.1.11');
    assert.equal(info.mac, 'AABBCCDDEEFF');
    assert.equal(info.canonicalId, 'gw-aabbccddeeff');
});

test('allows initial radio tuning once the TCP socket is writable', async () => {
    const { node } = createBareGateway();
    const writes = [];
    node.client.write = (value) => writes.push(value);

    const tuning = node._configureRadio(4, 0, 'short');
    assert.deepEqual(writes, ['TUNE:4:0:short\n']);

    node._processLine('ACK:TUNED');
    await tuning;

    assert.deepEqual(node.currentRadio, { txChannel: 4, rxChannel: 0, txProfile: 'short' });
});

test('OTA start acknowledgement resolves the pending control command', () => {
    const { node, events } = createBareGateway();
    let resolvedWith = null;
    node.pendingControl = {
        match: (line) => line === 'ACK:OTA_START',
        resolve: (line) => {
            resolvedWith = line;
            node.pendingControl = null;
        },
        reject: assert.fail,
    };

    node._processLine('ACK:OTA_START');

    assert.equal(resolvedWith, 'ACK:OTA_START');
    assert.equal(events[0][0], 'gatewayOtaStatus');
    assert.equal(events[0][1].gatewayId, 'test-gateway');
    assert.equal(events[0][1].status, 'ACK:OTA_START');
    assert.equal(typeof events[0][1].ts, 'number');
});

test('OTA no-updates acknowledgement resolves a matching pending command', () => {
    const { node, events } = createBareGateway();
    let resolvedWith = null;
    node.pendingControl = {
        match: (line) => line === 'ACK:OTA_NO_UPDATES',
        resolve: (line) => {
            resolvedWith = line;
            node.pendingControl = null;
        },
        reject: assert.fail,
    };

    node._processLine('ACK:OTA_NO_UPDATES');

    assert.equal(resolvedWith, 'ACK:OTA_NO_UPDATES');
    assert.equal(events[0][0], 'gatewayOtaStatus');
});
