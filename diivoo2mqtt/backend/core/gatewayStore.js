const fs = require('fs');
const path = require('path');

class GatewayStore {
    constructor(filePath) {
        if (filePath) {
            this.filePath = filePath;
        } else if (fs.existsSync('/data')) {
            // Home Assistant Add-on persistentes Verzeichnis
            this.filePath = '/data/gateways.json';
        } else {
            // Lokale Entwicklung
            this.filePath = path.join(__dirname, '..', 'data', 'gateways.json');
        }

        // Stellen sicher, dass das Verzeichnis existiert
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    load() {
        if (!fs.existsSync(this.filePath)) {
            return [];
        }

        try {
            const data = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(data);
            // Deduplicate by id — last entry wins if the file has been corrupted with duplicates
            const seen = new Map();
            for (const gw of parsed) {
                if (gw.id) seen.set(gw.id, gw);
            }
            return Array.from(seen.values());
        } catch (err) {
            console.error(`[GatewayStore] Error loading gateways from ${this.filePath}:`, err.message);
            return [];
        }
    }

    save(gatewaysMap) {
        try {
            const serialized = Array.from(gatewaysMap.values())
                .map(gw => ({
                    id: gw.id,
                    ip: gw.ip,
                    port: gw.port
                }));

            fs.writeFile(this.filePath, JSON.stringify(serialized, null, 2), 'utf8', (err) => {
                if (err) console.error(`[GatewayStore] Error saving gateways to ${this.filePath}:`, err.message);
            });
        } catch (err) {
            console.error(`[GatewayStore] Error serialising gateways:`, err.message);
        }
    }
}

module.exports = GatewayStore;
