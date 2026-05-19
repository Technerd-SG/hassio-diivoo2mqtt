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
            if (err) console.error(`[DeviceStore] Error saving devices:`, err.message);
        });
    }

    _flushSync() {
        if (!this.isDirty || !this.latestSerialized) return;
        this.isDirty = false;
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.latestSerialized, null, 2), 'utf8');
        } catch (e) {
            console.error(`[DeviceStore] Error during sync save:`, e.message);
        }
    }

    load() {
        if (!fs.existsSync(this.filePath)) {
            return [];
        }

        try {
            const data = fs.readFileSync(this.filePath, 'utf8');
            return JSON.parse(data);
        } catch (err) {
            console.error(`[DeviceStore] Error loading devices from ${this.filePath}:`, err.message);
            return [];
        }
    }

    save(devicesMap) {
        try {
            this.latestSerialized = Array.from(devicesMap.values()).map(device => {
                return {
                    valveId: device.valveId,
                    model: device.model,
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
            this.isDirty = true;
        } catch (err) {
            console.error(`[DeviceStore] Error serialising devices:`, err.message);
        }
    }
}

module.exports = DeviceStore;
