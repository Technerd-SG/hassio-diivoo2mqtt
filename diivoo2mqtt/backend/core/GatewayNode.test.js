const test = require('node:test');
const assert = require('node:assert/strict');
const GatewayNode = require('./GatewayNode');

function createBareGateway() {
    const events = [];
    const node = Object.create(GatewayNode.prototype);
    Object.assign(node, {
        id: 'test-gateway',
        client: { destroyed: false, writable: true, write() {} },
        hub: {
            emit: (...args) => events.push(args),
            processIncomingRadioPacket() {},
        },
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

function createRxLine({ senderId = 0x01020304, seq = 1, cmd, payload = [] }) {
    const bytes = new Array(12 + payload.length).fill(0);
    bytes[5] = senderId & 0xFF;
    bytes[6] = (senderId >> 8) & 0xFF;
    bytes[7] = (senderId >> 16) & 0xFF;
    bytes[8] = (senderId >> 24) & 0xFF;
    bytes[9] = seq;
    bytes[10] = cmd;
    bytes[11] = payload.length;
    bytes.splice(12, payload.length, ...payload);
    const hex = bytes.map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `RX:4:0:-50:${hex}`;
}

test('parses gateway MAC from current firmware VERSION response', () => {
    const { node } = createBareGateway();

    const info = node._parseVersionLine('VERSION:tcp_gateway_WG03:0.1.11:AA:BB:CC:DD:EE:FF');

    assert.equal(info.model, 'tcp_gateway_WG03');
    assert.equal(info.version, '0.1.11');
    assert.equal(info.mac, 'AABBCCDDEEFF');
    assert.equal(info.canonicalId, 'gw-aabbccddeeff');
});

test('publishes VERSION with the canonical gateway ID after identification', () => {
    const { node, events } = createBareGateway();
    node.hub.identifyGateway = (gateway, versionInfo) => {
        assert.equal(versionInfo.canonicalId, 'gw-aabbccddeeff');
        gateway.id = versionInfo.canonicalId;
    };

    node._processLine('VERSION:tcp_gateway_WG03:0.1.11:AABBCCDDEEFF');

    assert.equal(node.id, 'gw-aabbccddeeff');
    assert.equal(node.lastVersion.gatewayId, 'gw-aabbccddeeff');
    assert.equal(events[0][0], 'gatewayVersion');
    assert.equal(events[0][1].gatewayId, 'gw-aabbccddeeff');
});

test('tracks gateway button state for the web UI', () => {
    const { node, events } = createBareGateway();

    node._processLine('BTN:PRESSED');
    assert.equal(node.buttonPressed, true);
    assert.equal(events[0][0], 'gatewayButton');
    assert.equal(events[1][0], 'gatewayStateUpdate');

    node._processLine('BTN:RELEASED');
    assert.equal(node.buttonPressed, false);
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

test('OTA probe prefers the configured LAN host over the Docker socket address', async () => {
    const { node } = createBareGateway();
    const writes = [];
    node.isConnected = true;
    node.client.localAddress = '172.30.33.10';
    node.client.write = (value) => writes.push(value);

    const probe = node.probeAddonIp(8099, '10.0.0.10');
    assert.deepEqual(writes, ['PING_URL:http://10.0.0.10:8099/api/health\n']);

    node._processLine('ACK:PING_OK');
    assert.equal(await probe, '10.0.0.10');
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

test('waits past unrelated target-device traffic until the response matcher accepts a packet', async () => {
    const { node } = createBareGateway();
    const waiting = node._waitForInbound(
        0x01020304,
        100,
        null,
        (inbound) => inbound.cmd === 0xA1 && inbound.seq === 7
    );

    node._processLine(createRxLine({ cmd: 0x02, seq: 6, payload: new Array(15).fill(0) }));
    assert.ok(node.pendingInboundWait, 'unrelated packet must not stop retries');

    node._processLine(createRxLine({ cmd: 0xA1, seq: 7, payload: new Array(13).fill(0) }));
    const inbound = await waiting;

    assert.equal(inbound.cmd, 0xA1);
    assert.equal(inbound.seq, 7);
    assert.equal(inbound.payload.length, 13);
    assert.equal(node.pendingInboundWait, null);
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
