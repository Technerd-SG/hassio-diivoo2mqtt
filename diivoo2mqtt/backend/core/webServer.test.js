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

test('rejects channel display names longer than 80 characters', () => {
    const server = createContext();
    const device = createDevice();

    assert.throws(
        () => server._applyChannelConfig(device, 1, { displayName: 'x'.repeat(81) }),
        /at most 80 characters/
    );
});
