const fs = require('fs');
const path = require('path');

class DeviceStore {
    constructor(filePath) {
        if (filePath) {
            this.filePath = filePath;
        } else if (fs.existsSync('/data')) {
            // Home Assistant Add-on persistentes Verzeichnis
            this.filePath = '/data/devices.json';
        } else {
            // Lokale Entwicklung
            this.filePath = path.join(__dirname, '..', 'data', 'devices.json');
        }

        // Stellen sicher, dass das Verzeichnis existiert
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.isDirty = false;
        this.latestSerialized = null;
        this.loadedHubId = null;
        
        // Schreibe höchstens alle 60 Sekunden auf die Festplatte (Schont SD-Karten)
        this.saveInterval = setInterval(() => this._flush(), 60000);
        this.saveInterval.unref();

        // Beim Beenden noch einmal synchron sichern, falls ungespeicherte Daten da sind
        const flushSync = () => this._flushSync();
        process.on('SIGTERM', flushSync);
        process.on('SIGINT', flushSync);
    }

    _flush() {
        if (!this.isDirty || !this.latestSerialized) return;
        this.isDirty = false;
        fs.writeFile(this.filePath, JSON.stringify(this.latestSerialized, null, 2), 'utf8', (err) => {
            if (err) {
                this.isDirty = true;
                console.error(`[DeviceStore] Error saving devices:`, err.message);
            }
        });
    }

    _flushSync() {
        if (!this.isDirty || !this.latestSerialized) return;
        this.isDirty = false;
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.latestSerialized, null, 2), 'utf8');
        } catch (e) {
            this.isDirty = true;
            console.error(`[DeviceStore] Error during sync save:`, e.message);
        }
    }

    load() {
        if (!fs.existsSync(this.filePath)) {
            return [];
        }

        try {
            const data = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(data);

            // Current GitHub releases historically stored a plain device array,
            // while older Forgejo development builds used { hubId, devices }.
            if (Array.isArray(parsed)) {
                return parsed;
            }

            if (parsed && Array.isArray(parsed.devices)) {
                const importedHubId = Number(parsed.hubId);
                this.loadedHubId = Number.isInteger(importedHubId) && importedHubId >= 0
                    ? importedHubId >>> 0
                    : null;
                return parsed.devices;
            }

            throw new Error('Expected a device array or an object containing a devices array');
        } catch (err) {
            console.error(`[DeviceStore] Error loading devices from ${this.filePath}:`, err.message);
            return [];
        }
    }

    save(devicesMap) {
        try {
            const devices = Array.from(devicesMap.values()).map(device => {
                return {
                    valveId: device.valveId,
                    model: device.model,
                    alias: device.alias ?? null,
                    hardwareId: device.hardwareId,
                    channelCount: device.channelCount,
                    isBound: device.isBound,
                    deviceAddress: device.deviceAddress,
                    channelCode: device.channelCode,
                    channels: device.channels,
                    lastBatteryText: device.lastBatteryText,
                    lastSeen: device.lastSeen
                };
            });

            this.latestSerialized = Number.isInteger(this.loadedHubId)
                ? { hubId: this.loadedHubId, devices }
                : devices;
            this.isDirty = true;
        } catch (err) {
            console.error(`[DeviceStore] Error serialising devices:`, err.message);
        }
    }
}

module.exports = DeviceStore;
