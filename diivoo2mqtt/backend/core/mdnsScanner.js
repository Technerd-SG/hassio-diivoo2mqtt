const mdns = require('multicast-dns')();
const EventEmitter = require('events');

class MDnsScanner extends EventEmitter {
    constructor() {
        super();
        this.knownGateways = new Map(); // ip -> info
        
        mdns.on('response', (response) => {
            this._handleResponse(response);
        });
    }

    start() {
        console.log('[mDNS] Starte Suche nach Diivoo Gateways (_diivoo._tcp.local)...');
        this._query();
        // Regelmäßig nachfragen, falls welche später online kommen
        this.scanInterval = setInterval(() => this._query(), 60000);
    }

    stop() {
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
            this.scanInterval = null;
        }
        mdns.destroy();
    }

    _query() {
        mdns.query({
            questions: [{
                name: '_diivoo._tcp.local',
                type: 'PTR'
            }]
        });
    }

    _handleResponse(response) {
        // Wir suchen nach Antworten, die unseren Service beinhalten
        let hasService = false;
        let serviceName = null;
        let targetHostname = null;
        let ip = null;
        let port = null;

        // 1. Suche nach PTR Record für _diivoo._tcp.local
        for (const answer of response.answers) {
            if (answer.type === 'PTR' && answer.name === '_diivoo._tcp.local') {
                hasService = true;
                serviceName = answer.data; // z.B. diivoo-gw-aabbcc._diivoo._tcp.local
            }
        }

        if (!hasService) return;

        const allRecords = [...response.answers, ...response.additionals];

        // 2. Extrahiere SRV-Record für Port und Target-Hostname
        for (const record of allRecords) {
            if (record.type === 'SRV' && record.name === serviceName) {
                port = record.data.port;
                targetHostname = record.data.target; // z.B. diivoo-gw-aabbcc.local
            }
        }

        // Falls Target-Hostname nicht im SRV-Record war, rate den Hostnamen
        if (!targetHostname && serviceName) {
            targetHostname = serviceName.split('.')[0] + '.local';
        }

        // 3. Extrahiere A-Record für die IP-Adresse
        for (const record of allRecords) {
            if (record.type === 'A' && (record.name === targetHostname || record.name === serviceName || record.name === targetHostname + '.')) {
                ip = record.data;
            }
        }

        if (ip && port && serviceName) {
            // Extrahiere die ID (z.B. "diivoo-gw-aabbcc" -> "gw-aabbcc")
            // Hostname ist meist "diivoo-gw-aabbcc._diivoo._tcp.local" in PTR, 
            // aber wir splitten das sicherheitshalber einfach.
            const shortName = serviceName.split('.')[0]; 

            if (!this.knownGateways.has(ip)) {
                console.log(`[mDNS] Neues Gateway gefunden: ${shortName} unter ${ip}:${port}`);
                const gwInfo = { id: shortName, ip, port };
                this.knownGateways.set(ip, gwInfo);
                this.emit('gatewayFound', gwInfo);
            }
        }
    }
}

module.exports = MDnsScanner;
