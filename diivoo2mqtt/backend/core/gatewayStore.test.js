const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const GatewayStore = require('./gatewayStore');

test('persists a manually added gateway before save returns', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diivoo-gateways-'));
    const filePath = path.join(dir, 'gateways.json');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const store = new GatewayStore(filePath);
    store.save(new Map([
        ['manual-10-0-0-135', {
            id: 'manual-10-0-0-135',
            ip: '10.0.0.135',
            port: 8080,
        }],
    ]));

    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), [
        {
            id: 'manual-10-0-0-135',
            ip: '10.0.0.135',
            port: 8080,
        },
    ]);
    assert.equal(fs.existsSync(`${filePath}.tmp`), false);
});
