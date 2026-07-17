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

test('action response matcher accepts only acknowledgements with matching sequence and state', () => {
    const device = createDevice();
    const runningPayload = new Array(13).fill(0);
    runningPayload[1] = 0x21;

    assert.equal(device._matchesActionResponse({
        cmd: 0xA1,
        seq: 0x03,
        payload: runningPayload,
    }, 0x03, 1, true), true);

    assert.equal(device._matchesActionResponse({
        cmd: 0xA1,
        seq: 0x04,
        payload: runningPayload,
    }, 0x03, 1, true), false);

    const stoppedPayload = [...runningPayload];
    stoppedPayload[1] = 0x20;
    assert.equal(device._matchesActionResponse({
        cmd: 0xA1,
        seq: 0x03,
        payload: stoppedPayload,
    }, 0x03, 1, true), false);
});

test('does not resolve an action when its ACK reports the wrong state', () => {
    const device = createDevice();
    device.sendPostActionAck = async () => {};
    let resolved = false;
    device.pendingRequests.set(0x03, {
        channelIndex: 1,
        actionText: 'AN',
        expectedRunning: true,
        resolve: () => { resolved = true; },
    });

    const payload = new Array(13).fill(0);
    payload[1] = 0x20;
    device.handleActionAck(0x03, payload, 'gw-test');

    assert.equal(resolved, false);
    assert.ok(device.pendingRequests.has(0x03));
});

test('action response matcher ignores status reports for another channel or state', () => {
    const device = createDevice();
    device.initChannels(2);

    const statusPayload = new Array(15).fill(0);
    statusPayload[2] = 1;
    statusPayload[3] = 0x21;

    assert.equal(device._matchesActionResponse({
        cmd: 0x02,
        seq: 0x20,
        payload: statusPayload,
    }, 0x03, 1, true), true);

    const wrongChannel = [...statusPayload];
    wrongChannel[2] = 2;
    assert.equal(device._matchesActionResponse({
        cmd: 0x02,
        seq: 0x21,
        payload: wrongChannel,
    }, 0x03, 1, true), false);

    const wrongState = [...statusPayload];
    wrongState[3] = 0x20;
    assert.equal(device._matchesActionResponse({
        cmd: 0x02,
        seq: 0x22,
        payload: wrongState,
    }, 0x03, 1, true), false);
});
