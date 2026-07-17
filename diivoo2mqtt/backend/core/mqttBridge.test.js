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

test('MQTT discovery uses a custom channel name without changing its identity', () => {
    const published = [];
    const bridge = Object.create(MqttBridge.prototype);
    Object.assign(bridge, {
        discoveryPrefix: 'homeassistant',
        strings: {
            valve: 'Valve {ch}',
            valve_remaining: 'Valve {ch} Remaining Time',
            valve_source: 'Valve {ch} Source',
            valve_rain_delay: 'Valve {ch} Rain Delay',
            valve_rain_delay_until: 'Valve {ch} Rain Delay Until',
        },
        discoveredValves: new Set(),
        _publish: (topic, payload, options) => published.push({ topic, payload, options }),
    });

    bridge.publishAutoDiscovery({
        valveId: 123,
        model: 'WT-13W',
        alias: 'Garden',
        channels: {
            1: { displayName: 'Tomatoes' },
        },
    });

    const switchConfig = published.find(
        (entry) => entry.topic === 'homeassistant/switch/123_ch1/config'
    );
    assert.ok(switchConfig);

    const config = JSON.parse(switchConfig.payload);
    assert.equal(config.name, 'Tomatoes');
    assert.equal(config.unique_id, 'diivoo_123_valve_1');
    assert.equal(config.command_topic, 'diivoo/123/valve/1/set');
});

test('MQTT discovery retains the translated fallback for unnamed channels', () => {
    const published = [];
    const bridge = Object.create(MqttBridge.prototype);
    Object.assign(bridge, {
        discoveryPrefix: 'homeassistant',
        strings: {
            valve: 'Valve {ch}',
            valve_remaining: 'Valve {ch} Remaining Time',
            valve_source: 'Valve {ch} Source',
            valve_rain_delay: 'Valve {ch} Rain Delay',
            valve_rain_delay_until: 'Valve {ch} Rain Delay Until',
        },
        discoveredValves: new Set(),
        _publish: (topic, payload, options) => published.push({ topic, payload, options }),
    });

    bridge.publishAutoDiscovery({
        valveId: 123,
        model: 'WT-13W',
        alias: null,
        channels: {
            1: { displayName: '' },
        },
    });

    const switchConfig = published.find(
        (entry) => entry.topic === 'homeassistant/switch/123_ch1/config'
    );
    assert.equal(JSON.parse(switchConfig.payload).name, 'Valve 1');
});
