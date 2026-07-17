const test = require('node:test');
const assert = require('node:assert/strict');
const ValveDevice = require('./ValveDeviceV4');

function createDevice() {
    return new ValveDevice(123, 456, { send: () => {} }, { channelCount: 1 });
}

test('new channels have an empty display name', () => {
    const device = createDevice();

    assert.equal(device.channels[1].displayName, '');
    assert.equal(device.getLiveState().channels[1].displayName, '');
});

test('channel display names are exposed in live state', () => {
    const device = createDevice();
    device.channels[1].displayName = 'Tomatoes';

    assert.equal(device.getLiveState().channels[1].displayName, 'Tomatoes');
});
