const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const EventEmitter = require('events');

class OtaManager extends EventEmitter {
    constructor(hub) {
        super();
        this.hub = hub;
        this.otaDir = path.join(__dirname, '..', 'public', 'ota');
        this.versionsUrl = 'https://raw.githubusercontent.com/Technerd-SG/hassio-diivoo2mqtt/main/firmware/versions.json';
        this.latestVersions = {}; // model -> { version, binUrl }
        this.downloadedBins = new Map(); // model -> localPath

        if (!fs.existsSync(this.otaDir)) {
            fs.mkdirSync(this.otaDir, { recursive: true });
        }
    }

    start() {
        // Initialer Check
        this.checkForUpdates();
        // Stündlicher Check
        this.checkInterval = setInterval(() => this.checkForUpdates(), 60 * 60 * 1000);
    }

    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    async checkForUpdates() {
        console.log('[OTA] Checking for firmware updates at:', this.versionsUrl);
        try {
            // Zuerst die aktuelle Version von allen verbundenen Gateways frisch abfragen
            for (const gw of this.hub.gateways.values()) {
                if (gw.isConnected) {
                    await gw.getVersion().catch(() => { });
                }
            }

            const versionsData = await this._fetchJson(this.versionsUrl);
            if (!versionsData || typeof versionsData !== 'object') {
                throw new Error('Invalid versions.json format');
            }

            let updatesFound = false;

            for (const [model, info] of Object.entries(versionsData)) {
                this.latestVersions[model] = info;

                // Prüfen ob es ein Gateway gibt, das upgedatet werden muss
                for (const gw of this.hub.gateways.values()) {
                    if (gw.lastVersion && gw.lastVersion.model === model) {
                        if (this.isVersionNewer(gw.lastVersion.version, info.version)) {
                            console.log(`[OTA] Update found for gateway ${gw.id}: ${gw.lastVersion.version} -> ${info.version}`);
                            updatesFound = true;
                            this.emit('updateAvailable', {
                                gatewayId: gw.id,
                                model: model,
                                oldVersion: gw.lastVersion.version,
                                newVersion: info.version
                            });
                        }
                    }
                }
            }

            if (updatesFound) {
                // Herunterladen der Binaries vorsorglich starten
                for (const [model, info] of Object.entries(this.latestVersions)) {
                    await this._downloadBin(model, info.binUrl);
                }
            }

        } catch (err) {
            console.error('[OTA] Error checking for updates:', err.message);
        }
    }

    isVersionNewer(current, latest) {
        // Simple string comparison z.B. "0.1.6" < "0.1.7"
        if (!current || !latest) return false;

        const currParts = current.split('.').map(Number);
        const latestParts = latest.split('.').map(Number);

        for (let i = 0; i < Math.max(currParts.length, latestParts.length); i++) {
            const c = currParts[i] || 0;
            const l = latestParts[i] || 0;
            if (l > c) return true;
            if (l < c) return false;
        }
        return false;
    }

    getUpdateInfo(gatewayId) {
        const gw = this.hub.gateways.get(gatewayId);
        if (!gw || !gw.lastVersion) return null;

        const latest = this.latestVersions[gw.lastVersion.model];
        if (!latest) return null;

        if (this.isVersionNewer(gw.lastVersion.version, latest.version)) {
            return {
                model: gw.lastVersion.model,
                currentVersion: gw.lastVersion.version,
                latestVersion: latest.version,
                hasUpdate: true
            };
        }
        return null;
    }

    evaluateGatewayVersion(gatewayId) {
        const info = this.getUpdateInfo(gatewayId);
        if (info && info.hasUpdate) {
            console.log(`[OTA] Update found for gateway ${gatewayId}: ${info.currentVersion} -> ${info.latestVersion}`);
            // Herunterladen der Binaries vorsorglich starten
            const latest = this.latestVersions[info.model];
            if (latest) {
                this._downloadBin(info.model, latest.binUrl).catch(() => { });
            }
            this.emit('updateAvailable', {
                gatewayId: gatewayId,
                model: info.model,
                oldVersion: info.currentVersion,
                newVersion: info.latestVersion
            });
        }
    }

    async triggerUpdate(gatewayId, _, localServerPort) {
        const gw = this.hub.gateways.get(gatewayId);
        if (!gw || !gw.isConnected) throw new Error('Gateway not found or not connected');
        if (!gw.lastVersion) throw new Error('Gateway version not yet known — please wait a moment');

        const latest = this.latestVersions[gw.lastVersion.model];
        if (!latest) throw new Error('No update available for this model');

        const localFileName = `${gw.lastVersion.model}_${latest.version}.bin`;
        const localPath = path.join(this.otaDir, localFileName);

        if (!fs.existsSync(localPath)) {
            await this._downloadBin(gw.lastVersion.model, latest.binUrl);
        }

        // Lass den ESP32 aktiv die erreichbare IP herausfinden
        const port = localServerPort || process.env.WEB_PORT || 8099;
        console.log(`[OTA] Sending IP probe to gateway ${gatewayId}...`);
        const addonIp = await gw.probeAddonIp(port);

        const otaUrl = `http://${addonIp}:${port}/ota/${localFileName}`;
        console.log(`[OTA] Sending update command to gateway ${gatewayId}: ${otaUrl}`);

        if (gw.isConnected) {
            gw.otaPendingVersion = latest.version; // Merken, auf welche Version wir updaten
            gw.sendOta(otaUrl);
            return true;
        } else {
            throw new Error('Gateway is not connected');
        }
    }

    _fetchJson(url) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            client.get(url, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return this._fetchJson(res.headers.location).then(resolve).catch(reject);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', reject);
        });
    }

    _downloadBin(model, url) {
        return new Promise((resolve, reject) => {
            const version = this.latestVersions[model].version;
            const fileName = `${model}_${version}.bin`;
            const dest = path.join(this.otaDir, fileName);

            if (fs.existsSync(dest)) {
                this.downloadedBins.set(model, dest);
                return resolve(dest);
            }

            console.log(`[OTA] Downloading firmware: ${url}`);

            const client = url.startsWith('https') ? https : http;
            const request = client.get(url, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return this._downloadBin(model, res.headers.location).then(resolve).catch(reject);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }

                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => {
                    file.close(() => {
                        this.downloadedBins.set(model, dest);
                        resolve(dest);
                    });
                });
            }).on('error', (err) => {
                fs.unlink(dest, () => { });
                reject(err);
            });
        });
    }
}

module.exports = OtaManager;
