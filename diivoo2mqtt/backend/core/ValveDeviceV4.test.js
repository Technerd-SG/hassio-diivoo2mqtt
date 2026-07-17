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

test('marks a device unreachable after command failure and restores it on the next packet', () => {
    const device = createDevice();
    const updates = [];
    device.on('stateUpdate', (update) => updates.push(update));
    device.lastSeen = Date.now() - 1000;

    device._markCommandFailure(new Error('simulated command timeout'));

    assert.equal(device.isOnline, false);
    assert.equal(updates.at(-1).reason, 'COMMAND_UNREACHABLE');
    assert.equal(updates.at(-1).state.isOnline, false);

    device.handleIncomingPacket(1, 0xA0, [], 'A0', 'gw-test', -50);

    assert.equal(device.isOnline, true);
    assert.equal(device.lastCommandFailureAt, 0);
    assert.equal(updates.at(-1).reason, 'COMMAND_REACHABLE');
    assert.equal(updates.at(-1).state.isOnline, true);
});

test('queue contention alone does not mark a device unreachable', () => {
    const device = createDevice();

    assert.equal(device._shouldMarkCommandFailure({ code: 'ACQUIRE_TIMEOUT' }), false);
    assert.equal(device._shouldMarkCommandFailure({ code: 'QUEUE_OVERFLOW' }), false);
    assert.equal(device._shouldMarkCommandFailure({ code: 'EXECUTION_TIMEOUT' }), true);
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

test('serializes config refresh triggers for the same device', async () => {
    const device = createDevice();
    const states = [];
    device.on('configSyncState', (state) => states.push(state));
    let active = 0;
    let maxActive = 0;
    let calls = 0;

    device.sendPingTrigger = async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        device._markConfigPullActivity(0x05);
        active--;
        return [{ cmd: 0x05 }];
    };

    await Promise.all([
        device.queueConfigRefresh('first', { quietMs: 1, maxWaitMs: 100 }),
        device.queueConfigRefresh('second', { quietMs: 1, maxWaitMs: 100 }),
    ]);

    assert.equal(calls, 2);
    assert.equal(maxActive, 1);
    assert.equal(device.activeConfigRefresh, null);
    assert.equal(states.filter(state => state.status === 'notifying').length, 2);
    assert.equal(states.filter(state => state.status === 'pulling').length, 2);
    assert.equal(states.filter(state => state.status === 'idle').length, 2);
    assert.ok(states.every(state => state.confirmed === false));
});

test('continues the config refresh queue after a failed trigger', async () => {
    const device = createDevice();
    const states = [];
    device.on('configSyncState', (state) => states.push(state));
    let calls = 0;

    device.sendPingTrigger = async () => {
        calls++;
        if (calls === 1) throw new Error('simulated refresh failure');
        return [];
    };

    await assert.rejects(
        device.queueConfigRefresh('first', { quietMs: 0, maxWaitMs: 50 }),
        /simulated refresh failure/
    );
    await device.queueConfigRefresh('second', { quietMs: 0, maxWaitMs: 50 });

    assert.equal(calls, 2);
    assert.equal(states.filter(state => state.status === 'failed').length, 1);
    assert.equal(states.at(-1).status, 'no_response');
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
