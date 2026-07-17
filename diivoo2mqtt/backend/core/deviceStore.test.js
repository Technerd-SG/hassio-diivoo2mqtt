const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const DeviceStore = require('./deviceStore');

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
