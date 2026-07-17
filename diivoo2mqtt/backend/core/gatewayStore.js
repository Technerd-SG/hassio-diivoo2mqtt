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
            if (!Array.isArray(parsed)) {
                throw new Error('Gateway store must contain an array.');
            }

            const gatewaysById = new Map();
            for (const gateway of parsed) {
                const id = typeof gateway?.id === 'string' ? gateway.id.trim() : '';
                const ip = typeof gateway?.ip === 'string' ? gateway.ip.trim() : '';
                const port = Number(gateway?.port);
                if (!id || !ip || !Number.isInteger(port) || port < 1 || port > 65535) {
                    console.warn('[GatewayStore] Ignoring invalid stored gateway entry.');
                    continue;
                }

                const rawAlias = typeof gateway.alias === 'string' ? gateway.alias.trim() : '';
                const alias = rawAlias ? rawAlias.slice(0, 80) : null;
                gatewaysById.set(id, { id, ip, port, alias });
            }

            return Array.from(gatewaysById.values());
        } catch (err) {
            console.error(`[GatewayStore] Error loading gateways from ${this.filePath}:`, err.message);
            return [];
        }
    }

    save(gatewaysMap) {
        try {
            const serialized = Array.from(gatewaysMap.values())
                .filter(gw => !gw.isDestroyed)
                .map(gw => ({
                    id: gw.id,
                    ip: gw.ip,
                    port: gw.port,
                    alias: gw.alias || null,
                }));

            const tempPath = `${this.filePath}.tmp`;
            fs.writeFileSync(tempPath, JSON.stringify(serialized, null, 2), 'utf8');
            fs.renameSync(tempPath, this.filePath);
        } catch (err) {
            try {
                fs.unlinkSync(`${this.filePath}.tmp`);
            } catch (_) { }
            console.error(`[GatewayStore] Error saving gateways:`, err.message);
        }
    }
}

module.exports = GatewayStore;
