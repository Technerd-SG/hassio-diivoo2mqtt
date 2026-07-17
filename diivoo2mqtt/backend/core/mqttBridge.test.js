const test = require('node:test');
const assert = require('node:assert/strict');
const MqttBridge = require('../interfaces/mqttBridge');

function createBridge(defaultDuration = 600) {
    const calls = [];
    const published = [];
    const stateRepublishes = [];
    const device = {
        channels: {
            1: { settings: { durationSeconds: defaultDuration } },
        },
        valve(channelId) {
            assert.equal(channelId, 1);
            return {
                on: async (seconds) => {
                    calls.push({ action: 'on', seconds });
                    return {
                        via: 'action-ack-0xA1',
                        gatewayId: 'gw-test',
                        status: 'AN',
                        isRunning: true,
                        remainingSeconds: seconds,
                    };
                },
                off: async () => {
                    calls.push({ action: 'off' });
                    return {
                        via: 'status-report-0x02',
                        gatewayId: 'gw-test',
                        status: 'AUS',
                        isRunning: false,
                        remainingSeconds: 0,
                    };
                },
            };
        },
        getLiveState: () => ({ valveId: 123, channels: { 1: { isRunning: false } } }),
    };

    const bridge = Object.create(MqttBridge.prototype);
    bridge.hub = { devices: new Map([[123, device]]) };
    bridge._publish = (topic, payload, options) => published.push({ topic, payload, options });
    bridge.publishDeviceState = (update) => stateRepublishes.push(update);

    return { bridge, calls, device, published, stateRepublishes };
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

test('publishes a verified MQTT command result after the valve confirms execution', async () => {
    const { bridge, published } = createBridge(900);

    await bridge.handleIncomingMessage('diivoo/123/valve/1/set', Buffer.from('ON'));

    const commandResult = published.find(
        (entry) => entry.topic === 'diivoo/123/valve/1/command_result'
    );
    assert.ok(commandResult);
    assert.deepEqual(commandResult.options, { retain: false });
    assert.deepEqual(
        { ...JSON.parse(commandResult.payload), ts: 0 },
        {
            valveId: 123,
            channelId: 1,
            ts: 0,
            ok: true,
            requestedState: 'ON',
            verification: 'action-ack-0xA1',
            gatewayId: 'gw-test',
            status: 'AN',
            isRunning: true,
            remainingSeconds: 900,
        }
    );
});

test('publishes failure and restores confirmed state when the valve does not respond', async () => {
    const { bridge, device, published, stateRepublishes } = createBridge(900);
    device.valve = () => ({
        on: async () => { throw new Error('No response from valve'); },
        off: async () => { throw new Error('No response from valve'); },
    });

    await bridge.handleIncomingMessage('diivoo/123/valve/1/set', Buffer.from('ON'));

    const commandResult = published.find(
        (entry) => entry.topic === 'diivoo/123/valve/1/command_result'
    );
    const payload = JSON.parse(commandResult.payload);
    assert.equal(payload.ok, false);
    assert.equal(payload.requestedState, 'ON');
    assert.equal(payload.error, 'No response from valve');
    assert.equal(stateRepublishes.length, 1);
    assert.equal(stateRepublishes[0].valveId, 123);
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

test('gateway alias updates the Home Assistant device name without changing identity', () => {
    const published = [];
    const gateway = {
        id: 'gw-aabbccddeeff',
        alias: 'Parents gateway',
        ledState: 'OFF',
        buttonPressed: false,
    };
    const bridge = Object.create(MqttBridge.prototype);
    Object.assign(bridge, {
        discoveryPrefix: 'homeassistant',
        strings: {},
        hub: {
            getGateway: () => gateway,
            gateways: new Map([[gateway.id, gateway]]),
        },
        gatewayStates: new Map([[gateway.id, {
            connected: true,
            ledState: 'OFF',
            buttonPressed: false,
            version: '0.1.11',
            model: 'tcp_gateway_WG03',
            mac: 'AABBCCDDEEFF',
            lastUpdateTs: Date.now(),
        }]]),
        discoveredGateways: new Set(),
        _publish: (topic, payload, options) => published.push({ topic, payload, options }),
    });

    bridge.publishGatewayAutoDiscovery(gateway.id);

    const ledConfig = published.find(
        (entry) => entry.topic === 'homeassistant/light/gateway_gw-aabbccddeeff_led/config'
    );
    const config = JSON.parse(ledConfig.payload);
    assert.equal(config.device.name, 'Parents gateway');
    assert.deepEqual(config.device.identifiers, ['diivoo_gateway_aabbccddeeff']);
    assert.equal(config.unique_id, 'diivoo_gateway_gw-aabbccddeeff_led');
});

test('gateway identity migration clears provisional retained topics and preserves state', () => {
    const published = [];
    const bridge = Object.create(MqttBridge.prototype);
    Object.assign(bridge, {
        discoveryPrefix: 'homeassistant',
        hub: {
            gatewayIdentityMigrations: [{
                previousGatewayId: 'manual-10-0-0-10',
                gatewayId: 'gw-aabbccddeeff',
            }],
        },
        gatewayStates: new Map([['manual-10-0-0-10', { connected: false, version: '0.1.11' }]]),
        discoveredGateways: new Set(['manual-10-0-0-10']),
        _publish: (topic, payload, options) => published.push({ topic, payload, options }),
    });

    bridge.handleGatewayIdentified({
        previousGatewayId: 'manual-10-0-0-10',
        gatewayId: 'gw-aabbccddeeff',
    });

    assert.equal(bridge.gatewayStates.has('manual-10-0-0-10'), false);
    assert.equal(bridge.gatewayStates.get('gw-aabbccddeeff').version, '0.1.11');
    assert.equal(bridge.discoveredGateways.has('manual-10-0-0-10'), false);
    assert.deepEqual(bridge.hub.gatewayIdentityMigrations, []);
    assert.ok(published.some((entry) =>
        entry.topic === 'homeassistant/light/gateway_manual-10-0-0-10_led/config' &&
        entry.payload === '' &&
        entry.options?.retain === true
    ));
    assert.ok(published.some((entry) =>
        entry.topic === 'diivoo/gateway/manual-10-0-0-10/state' && entry.payload === ''
    ));
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
