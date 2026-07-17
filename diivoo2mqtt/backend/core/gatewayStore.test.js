const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const GatewayStore = require('./gatewayStore');

test('persists all gateways atomically before save returns', (t) => {
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
        ['diivoo-gw-aabbccddeeff', {
            id: 'diivoo-gw-aabbccddeeff',
            ip: '10.0.0.136',
            port: 8080,
        }],
    ]));

    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), [
        {
            id: 'manual-10-0-0-135',
            ip: '10.0.0.135',
            port: 8080,
            alias: null,
        },
        {
            id: 'diivoo-gw-aabbccddeeff',
            ip: '10.0.0.136',
            port: 8080,
            alias: null,
        },
    ]);
    assert.equal(fs.existsSync(`${filePath}.tmp`), false);
});

test('deduplicates stored gateways by ID and ignores invalid entries', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diivoo-gateways-'));
    const filePath = path.join(dir, 'gateways.json');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    fs.writeFileSync(filePath, JSON.stringify([
        { id: 'gw-aabbccddeeff', ip: '10.0.0.10', port: 8080 },
        { id: '', ip: '10.0.0.11', port: 8080 },
        { id: 'gw-invalid', ip: '', port: 8080 },
        { id: 'gw-aabbccddeeff', ip: '10.0.0.12', port: 8080 },
        { id: 'gw-bad-port', ip: '10.0.0.13', port: 70000 },
    ]));

    const store = new GatewayStore(filePath);
    assert.deepEqual(store.load(), [
        { id: 'gw-aabbccddeeff', ip: '10.0.0.12', port: 8080, alias: null },
    ]);
});

test('persists and restores a gateway alias', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diivoo-gateways-'));
    const filePath = path.join(dir, 'gateways.json');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const store = new GatewayStore(filePath);
    store.save(new Map([['gw-aabbccddeeff', {
        id: 'gw-aabbccddeeff',
        ip: '10.0.0.10',
        port: 8080,
        alias: 'Parents gateway',
    }]]));

    assert.deepEqual(store.load(), [{
        id: 'gw-aabbccddeeff',
        ip: '10.0.0.10',
        port: 8080,
        alias: 'Parents gateway',
    }]);
});
