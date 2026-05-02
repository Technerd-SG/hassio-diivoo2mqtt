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
            return JSON.parse(data);
        } catch (err) {
            console.error(`[GatewayStore] Fehler beim Laden der Gateways aus ${this.filePath}:`, err.message);
            return [];
        }
    }

    save(gatewaysMap) {
        try {
            const serialized = Array.from(gatewaysMap.values())
                .filter(gw => gw.id.startsWith('manual-')) // Nur manuell hinzugefügte Gateways speichern
                .map(gw => {
                    return {
                        id: gw.id,
                        ip: gw.ip,
                        port: gw.port
                    };
                });

            fs.writeFile(this.filePath, JSON.stringify(serialized, null, 2), 'utf8', (err) => {
                if (err) console.error(`[GatewayStore] Fehler beim Speichern der Gateways nach ${this.filePath}:`, err.message);
            });
        } catch (err) {
            console.error(`[GatewayStore] Fehler beim Serialisieren der Gateways:`, err.message);
        }
    }
}

module.exports = GatewayStore;
