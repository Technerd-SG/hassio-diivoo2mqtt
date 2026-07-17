const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OtaManager = require('./otaManager');

test('uses a channel-specific firmware manifest when configured', () => {
    const previous = process.env.FIRMWARE_VERSIONS_URL;
    process.env.FIRMWARE_VERSIONS_URL = 'https://example.invalid/nightly/versions.json';

    try {
        const manager = new OtaManager({ gateways: new Map() });
        assert.equal(manager.versionsUrl, 'https://example.invalid/nightly/versions.json');
    } finally {
        if (previous == null) delete process.env.FIRMWARE_VERSIONS_URL;
        else process.env.FIRMWARE_VERSIONS_URL = previous;
    }
});

function createManager({ address = '192.0.2.10', webPort = 3456 } = {}) {
    const otaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diivoo-ota-'));
    const sentUrls = [];
    const gateway = {
        id: 'gw-test',
        isConnected: true,
        lastVersion: { model: 'tcp_gateway_WG03', version: '0.1.10' },
        probeAddonIp: async (port) => {
            assert.equal(port, webPort);
            return address;
        },
        sendOta: async (url) => sentUrls.push(url),
    };

    const manager = Object.create(OtaManager.prototype);
    Object.assign(manager, {
        hub: {
            config: { webPort },
            gateways: new Map([[gateway.id, gateway]]),
        },
        otaDir,
        latestVersions: {
            tcp_gateway_WG03: {
                version: '0.1.11',
                binUrl: 'https://example.invalid/firmware.bin',
            },
        },
        downloadedBins: new Map(),
    });

    fs.writeFileSync(path.join(otaDir, 'tcp_gateway_WG03_0.1.11.bin'), 'firmware');
    return { manager, gateway, sentUrls, otaDir };
}

test('OTA uses the configured web server port and API route', async (t) => {
    const { manager, sentUrls, otaDir } = createManager();
    t.after(() => fs.rmSync(otaDir, { recursive: true, force: true }));

    await manager.triggerUpdate('gw-test');

    assert.deepEqual(sentUrls, [
        'http://192.0.2.10:3456/api/ota/tcp_gateway_WG03_0.1.11.bin',
    ]);
});

test('OTA wraps IPv6 addresses in URL brackets', async (t) => {
    const { manager, sentUrls, otaDir } = createManager({ address: '2001:db8::10' });
    t.after(() => fs.rmSync(otaDir, { recursive: true, force: true }));

    await manager.triggerUpdate('gw-test');

    assert.deepEqual(sentUrls, [
        'http://[2001:db8::10]:3456/api/ota/tcp_gateway_WG03_0.1.11.bin',
    ]);
});
