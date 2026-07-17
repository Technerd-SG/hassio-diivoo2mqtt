const test = require('node:test');
const assert = require('node:assert/strict');
const MqttBridge = require('../interfaces/mqttBridge');

function createBridge(defaultDuration = 600) {
    const calls = [];
    const device = {
        channels: {
            1: { settings: { durationSeconds: defaultDuration } },
        },
        valve(channelId) {
            assert.equal(channelId, 1);
            return {
                on: async (seconds) => calls.push({ action: 'on', seconds }),
                off: async () => calls.push({ action: 'off' }),
            };
        },
    };

    const bridge = Object.create(MqttBridge.prototype);
    bridge.hub = { devices: new Map([[123, device]]) };

    return { bridge, calls };
}

test('MQTT ON uses the channel-specific default duration', async () => {
    const { bridge, calls } = createBridge(900);

    await bridge.handleIncomingMessage('diivoo/123/valve/1/set', Buffer.from('ON'));

    assert.deepEqual(calls, [{ action: 'on', seconds: 900 }]);
});

test('MQTT JSON duration overrides the channel default', async () => {
    const { bridge, calls } = createBridge(900);

    await bridge.handleIncomingMessage(
        'diivoo/123/valve/1/set',
        Buffer.from(JSON.stringify({ state: 'ON', duration: 300 }))
    );

    assert.deepEqual(calls, [{ action: 'on', seconds: 300 }]);
});

test('MQTT durations are validated and limited to the 16-bit protocol field', async () => {
    const { bridge, calls } = createBridge(900);

    await bridge.handleIncomingMessage(
        'diivoo/123/valve/1/set',
        Buffer.from(JSON.stringify({ state: 'ON', duration: 100000 }))
    );
    await bridge.handleIncomingMessage(
        'diivoo/123/valve/1/set',
        Buffer.from(JSON.stringify({ state: 'ON', duration: -1 }))
    );

    assert.deepEqual(calls, [
        { action: 'on', seconds: 65535 },
        { action: 'on', seconds: 900 },
    ]);
});
