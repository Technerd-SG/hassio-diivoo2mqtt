const test = require('node:test');
const assert = require('node:assert/strict');
const WebServer = require('../interfaces/webServer');

function createContext() {
    return Object.create(WebServer.prototype);
}

function createDevice(displayName = '') {
    return {
        channels: {
            1: {
                displayName,
                settings: {
                    durationSeconds: 600,
                    intervalOnSeconds: 10,
                    intervalOffSeconds: 30,
                    rainDelayDate: null,
                },
                schedules: [],
            },
        },
    };
}

test('serializes gateway aliases and live controls for the web UI', () => {
    const server = createContext();
    server.hub = { otaManager: null };

    assert.deepEqual(server._serializeGateway({
        id: 'gw-aabbccddeeff',
        alias: 'Parents gateway',
        ip: '10.0.0.10',
        port: 8080,
        isConnected: true,
        ledState: 'ON',
        buttonPressed: true,
        lastVersion: {
            version: '0.1.11',
            model: 'tcp_gateway_WG03',
            mac: 'AABBCCDDEEFF',
        },
        lastSeenAt: 123,
    }), {
        id: 'gw-aabbccddeeff',
        alias: 'Parents gateway',
        ip: '10.0.0.10',
        port: 8080,
        isConnected: true,
        ledState: 'ON',
        buttonPressed: true,
        version: '0.1.11',
        model: 'tcp_gateway_WG03',
        mac: 'AABBCCDDEEFF',
        lastSeenAt: 123,
        otaUpdate: null,
    });
});

test('serializes and updates a channel display name', () => {
    const server = createContext();
    const device = createDevice('Old name');

    assert.equal(server._serializeChannelConfig(device, 1).displayName, 'Old name');

    server._applyChannelConfig(device, 1, { displayName: '  Tomatoes  ' });

    assert.equal(device.channels[1].displayName, 'Tomatoes');
    assert.equal(server._serializeChannelConfig(device, 1).displayName, 'Tomatoes');
});

test('allows clearing a channel display name', () => {
    const server = createContext();
    const device = createDevice('Tomatoes');

    server._applyChannelConfig(device, 1, { displayName: '   ' });

    assert.equal(device.channels[1].displayName, '');
});

test('queues config refreshes through the device serializer', async () => {
    const server = createContext();
    const calls = [];
    const device = {
        valveId: 123,
        queueConfigRefresh: async (reason) => {
            calls.push(reason);
            return [{ cmd: 0x05 }];
        },
    };

    await server._triggerDeviceRefresh(device, 1, 'schedule-save');

    assert.deepEqual(calls, ['schedule-save']);
});

test('rejects channel display names longer than 80 characters', () => {
    const server = createContext();
    const device = createDevice();

    assert.throws(
        () => server._applyChannelConfig(device, 1, { displayName: 'x'.repeat(81) }),
        /at most 80 characters/
    );
});
