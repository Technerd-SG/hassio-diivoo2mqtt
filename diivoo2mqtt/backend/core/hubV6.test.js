const test = require('node:test');
const assert = require('node:assert/strict');
const SmartHub = require('./hubV6');

function createBareHub(nodes = []) {
    const events = [];
    const saves = [];
    const hub = Object.create(SmartHub.prototype);
    Object.assign(hub, {
        gateways: new Map(nodes.map((node) => [node.id, node])),
        gatewayIdentityMigrations: [],
        gatewayStore: {
            save: (gateways) => saves.push(Array.from(gateways.keys())),
        },
        emit: (event, payload) => events.push({ event, payload }),
    });
    return { hub, events, saves };
}

function createNode(id, ip = '10.0.0.10') {
    return {
        id,
        ip,
        port: 8080,
        isDestroyed: false,
        radioQueue: { name: `gateway-${id}-radio` },
        destroy() {
            this.isDestroyed = true;
        },
    };
}

test('re-keys a provisional gateway to its canonical MAC identity', () => {
    const node = createNode('manual-10-0-0-10');
    const { hub, events, saves } = createBareHub([node]);

    const id = hub.identifyGateway(node, { canonicalId: 'gw-aabbccddeeff' });

    assert.equal(id, 'gw-aabbccddeeff');
    assert.equal(node.id, 'gw-aabbccddeeff');
    assert.equal(node.radioQueue.name, 'gateway-gw-aabbccddeeff-radio');
    assert.equal(hub.gateways.has('manual-10-0-0-10'), false);
    assert.equal(hub.gateways.get('gw-aabbccddeeff'), node);
    assert.deepEqual(saves, [['gw-aabbccddeeff']]);
    assert.equal(events[0].event, 'gatewayIdentified');
    assert.equal(events[0].payload.previousGatewayId, 'manual-10-0-0-10');
    assert.equal(events[0].payload.gatewayId, 'gw-aabbccddeeff');
});

test('replaces a stale canonical gateway when the same MAC appears at a new IP', () => {
    const stale = createNode('gw-aabbccddeeff', '10.0.0.10');
    const replacement = createNode('diivoo-gw-aabbccddeeff', '10.0.0.20');
    const { hub } = createBareHub([stale, replacement]);

    hub.identifyGateway(replacement, { canonicalId: 'gw-aabbccddeeff' });

    assert.equal(stale.isDestroyed, true);
    assert.equal(hub.gateways.size, 1);
    assert.equal(hub.gateways.get('gw-aabbccddeeff'), replacement);
    assert.equal(replacement.ip, '10.0.0.20');
});

test('preserves a stored alias while replacing a stale gateway after an IP change', () => {
    const stale = createNode('gw-aabbccddeeff', '10.0.0.10');
    stale.alias = 'Parents gateway';
    const replacement = createNode('diivoo-gw-aabbccddeeff', '10.0.0.20');
    const { hub } = createBareHub([stale, replacement]);

    hub.identifyGateway(replacement, { canonicalId: 'gw-aabbccddeeff' });

    assert.equal(replacement.alias, 'Parents gateway');
});

test('renames a gateway without changing its stable identity', () => {
    const node = createNode('gw-aabbccddeeff');
    const { hub, events, saves } = createBareHub([node]);

    assert.equal(hub.renameGateway(node.id, '  Parents gateway  '), true);

    assert.equal(node.id, 'gw-aabbccddeeff');
    assert.equal(node.alias, 'Parents gateway');
    assert.deepEqual(saves, [['gw-aabbccddeeff']]);
    assert.equal(events[0].event, 'gatewayRenamed');
    assert.deepEqual(events[0].payload, {
        gatewayId: 'gw-aabbccddeeff',
        alias: 'Parents gateway',
    });
    assert.equal(events[1].event, 'gatewayStateUpdate');
});

test('updates the gateway LED state only after the command succeeds', async () => {
    const node = createNode('gw-aabbccddeeff');
    node.setLed = async (on) => ({ acknowledged: on });
    const { hub, events } = createBareHub([node]);

    const result = await hub.setGatewayLed(node.id, true);

    assert.deepEqual(result, { acknowledged: true });
    assert.equal(node.ledState, 'ON');
    assert.equal(events[0].event, 'gatewayStateUpdate');
});

test('keeps the provisional identity for firmware without a MAC', () => {
    const node = createNode('manual-10-0-0-10');
    const { hub, events, saves } = createBareHub([node]);

    const id = hub.identifyGateway(node, { canonicalId: null });

    assert.equal(id, 'manual-10-0-0-10');
    assert.equal(hub.gateways.get(id), node);
    assert.deepEqual(events, []);
    assert.deepEqual(saves, []);
});
