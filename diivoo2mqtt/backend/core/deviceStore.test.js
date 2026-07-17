const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DeviceStore = require('./deviceStore');

test('loads Forgejo envelope format and remembers its hub ID', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diivoo-store-'));
    const filePath = path.join(dir, 'devices.json');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    fs.writeFileSync(filePath, JSON.stringify({
        hubId: 16926055,
        devices: [{ valveId: 123, displayName: 'Garden' }],
    }));

    const store = new DeviceStore(filePath);
    clearInterval(store.saveInterval);

    assert.deepEqual(store.load(), [{ valveId: 123, displayName: 'Garden' }]);
    assert.equal(store.loadedHubId, 16926055);
});

test('preserves the Forgejo envelope when serializing imported devices', () => {
    const store = Object.create(DeviceStore.prototype);
    Object.assign(store, {
        loadedHubId: 16926055,
        isDirty: false,
        latestSerialized: null,
    });
    const device = {
        valveId: 123,
        model: 'WT-13W',
        alias: 'Garden',
        hardwareId: 4134,
        channelCount: 4,
        isBound: true,
        deviceAddress: 1,
        channelCode: 8,
        channels: {},
        lastBatteryText: 'OK',
        lastSeen: 0,
    };

    store.save(new Map([[device.valveId, device]]));

    assert.equal(store.latestSerialized.hubId, 16926055);
    assert.equal(store.latestSerialized.devices[0].alias, 'Garden');
    assert.equal(store.isDirty, true);
});

test('keeps pending data dirty when an asynchronous write fails', async () => {
    const store = Object.create(DeviceStore.prototype);
    Object.assign(store, {
        filePath: '/does-not-matter/devices.json',
        isDirty: true,
        latestSerialized: [{ valveId: 123 }],
    });

    const originalWriteFile = fs.writeFile;
    fs.writeFile = (_path, _data, _encoding, callback) => {
        queueMicrotask(() => callback(new Error('simulated write failure')));
    };

    try {
        store._flush();
        assert.equal(store.isDirty, false);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(store.isDirty, true);
    } finally {
        fs.writeFile = originalWriteFile;
    }
});
