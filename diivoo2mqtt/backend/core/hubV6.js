// Datei: hubV5.js
const net = require('net');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const ValveDevice = require('./ValveDeviceV4');
const utils = require('./utils');
const EventEmitter = require('events');
const DeviceStore = require('./deviceStore');
const MDnsScanner = require('./mdnsScanner');
const OtaManager = require('./otaManager');
const GatewayStore = require('./gatewayStore');

const DIAGNOSTIC_LOG_LIMIT = 50;
const DIAGNOSTIC_LOG_COMMANDS = new Set([0x01, 0x05, 0x06, 0x85, 0x86]);

/*
// --- KONFIGURATION ---
const HUB_CONFIG = {
    id: 16926055,
    features: Object.freeze({
        idleTxChannel: 4,
        idleRxChannel: 0,
        idleProfile: 'short',
        defaultTuneDelayMs: 15,
        defaultInboundWaitMs: 220,
        defaultActionWaitMs: 350,
        defaultActionMaxAttempts: 2,
        defaultActionRetryDelayMs: 120,
    })
};

const GATEWAYS_CONFIG = [
    { id: 'gw1', ip: '10.0.0.123', port: 8080 },
    // { id: 'gw2', ip: '10.0.0.124', port: 8080 },
];
*/

// --- MULTI-GATEWAY KLASSE ---
const GatewayNode = require('./GatewayNode');

// --- HAUPT HUB KLASSE ---
class SmartHub extends EventEmitter {
    constructor(hubConfig, gatewaysConfig) {
        super();

        this.config = hubConfig;               // Speichern
        this.gatewayConfigs = gatewaysConfig;

        this.gateways = new Map();

        // Starte mDNS Scanner
        this.mdnsScanner = new MDnsScanner();
        this.mdnsScanner.on('gatewayFound', (gwInfo) => this._addDynamicGateway(gwInfo));
        this.mdnsScanner.start();

        // Starte OTA Manager
        this.otaManager = new OtaManager(this);
        this.otaManager.start();

        this.pairingMode = false;
        this.unknownDevicesLogs = []; // Speichert unbekannte Join-Pakete für Diagnose-Export
        this.pairingCounter = 0x18FC0000;

        this.gatewayApi = {
            routePacket: this.routePacket.bind(this),
            isPairingModeEnabled: () => this.pairingMode,
            nextPairingCounter: () => {
                this.pairingCounter = (this.pairingCounter + 1) >>> 0;
                return this.pairingCounter;
            },
            allocateDeviceAddress: this.allocateDeviceAddress.bind(this),
            allocateChannelCode: this.allocateChannelCode.bind(this)
        };

        this.deviceStore = new DeviceStore();
        this.gatewayStore = new GatewayStore();
        this.unknownDevicesLogs = this._loadDiagnosticLogs();

        this._diagnosticLogsDirty = false;
        this._diagnosticLogsInterval = setInterval(() => this._flushDiagnosticLogs(), 60000);
        this._diagnosticLogsInterval.unref();

        const flushSync = () => this._flushDiagnosticLogsSync();
        process.on('SIGTERM', flushSync);
        process.on('SIGINT', flushSync);

        this.devices = new Map();

        this._loadDevices();
        this._loadGateways();

        this._initGateways();
        this._initCLI();

        this.on('gatewayConnection', this._handleGatewayConnection.bind(this));
        this.on('gatewayVersion', () => this.emit('gatewayStateUpdate'));

        // Starte den Watchdog (alle 10 Minuten)
        setInterval(() => this._checkDeviceWatchdog(), 10 * 60 * 1000);
    }

    _loadDevices() {
        const savedDevices = this.deviceStore.load();
        for (const data of savedDevices) {
            const device = new ValveDevice(data.valveId, this.config.id, this.gatewayApi, {
                isBound: data.isBound,
                model: data.model,
                channelCount: data.channelCount,
                deviceAddress: data.deviceAddress,
                channelCode: data.channelCode,
                hardwareId: data.hardwareId,
                lastBatteryText: data.lastBatteryText
            });
            // Wie von dir vorgeschlagen: Wir verwerfen das alte lastSeen beim Starten!
            // Da wir nicht wissen, was während der Offline-Zeit des Hubs passiert ist (und das Ventil
            // evtl. in den Tiefschlaf gegangen ist), setzen wir es auf 0.
            // Das triggert beim ersten Connect sofort den Watchdog-Timeout -> setzt das Ventil auf Offline -> Ping-Loop startet!
            device.lastSeen = 0;

            if (data.channels) {
                device.channels = data.channels;

                // rainDelayDate wird als ISO-String gespeichert (JSON kann kein Date),
                // daher müssen wir es beim Laden wieder in ein Date-Objekt konvertieren.
                for (const chKey of Object.keys(device.channels)) {
                    const ch = device.channels[chKey];
                    if (ch?.settings?.rainDelayDate && !(ch.settings.rainDelayDate instanceof Date)) {
                        const parsed = new Date(ch.settings.rainDelayDate);
                        ch.settings.rainDelayDate = Number.isNaN(parsed.getTime()) ? null : parsed;
                    }
                }
            }

            // Event-Listener anhängen
            device.on('stateUpdate', (updateData) => {
                console.log(`\n🌍 [DIGITAL TWIN] Update for valve ${updateData.valveId} due to ${updateData.reason}:`);
                console.log(JSON.stringify(updateData.state, null, 2));
                this.emit('deviceUpdate', updateData);
                this.deviceStore.save(this.devices);
            });

            this.devices.set(data.valveId, device);
        }
        if (savedDevices.length > 0) {
            console.log(`[SmartHub] ${savedDevices.length} saved valve(s) restored.`);
        }
    }

    _loadDiagnosticLogs() {
        if (!this.deviceStore || !this.deviceStore.filePath) return [];
        const filePath = this.deviceStore.filePath.replace('devices.json', 'diagnostic-logs.json');
        try {
            const fs = require('fs');
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf8')) || [];
            }
        } catch (e) {
            console.error("[SmartHub] Error loading diagnostic logs:", e.message);
        }
        return [];
    }

    _flushDiagnosticLogs() {
        if (!this._diagnosticLogsDirty || !this.deviceStore || !this.deviceStore.filePath) return;
        this._diagnosticLogsDirty = false;
        const filePath = this.deviceStore.filePath.replace('devices.json', 'diagnostic-logs.json');
        try {
            const fs = require('fs');
            fs.writeFile(filePath, JSON.stringify(this.unknownDevicesLogs, null, 2), 'utf8', (err) => {
                if (err) console.error("[SmartHub] Fehler beim Speichern der Diagnose-Logs:", err.message);
            });
        } catch (e) {
            console.error("[SmartHub] Fehler beim Speichern der Diagnose-Logs:", e.message);
        }
    }

    _flushDiagnosticLogsSync() {
        if (!this._diagnosticLogsDirty || !this.deviceStore || !this.deviceStore.filePath) return;
        this._diagnosticLogsDirty = false;
        const filePath = this.deviceStore.filePath.replace('devices.json', 'diagnostic-logs.json');
        try {
            const fs = require('fs');
            fs.writeFileSync(filePath, JSON.stringify(this.unknownDevicesLogs, null, 2), 'utf8');
        } catch (e) {}
    }

    _saveDiagnosticLogs() {
        this._diagnosticLogsDirty = true;
    }

    _captureDiagnosticPacket({ gatewayId, rssi, valveId, cmd, hexPayload, rawBytes, payload, joinInfo = null }) {
        if (!DIAGNOSTIC_LOG_COMMANDS.has(cmd)) return;

        this.unknownDevicesLogs.push({
            timestamp: new Date().toISOString(),
            gatewayId,
            rssi,
            valveId,
            cmd: utils.toHex(cmd),
            hexPayload,
            rawBytes: Array.from(rawBytes),
            joinInfo: joinInfo || (cmd === 0x01 ? utils.parseJoinPacket(payload) : null)
        });

        // Keep only the newest diagnostic packets.
        if (this.unknownDevicesLogs.length > DIAGNOSTIC_LOG_LIMIT) {
            this.unknownDevicesLogs.splice(0, this.unknownDevicesLogs.length - DIAGNOSTIC_LOG_LIMIT);
        }

        this.emit('diagnosticLogsUpdate');
        this._saveDiagnosticLogs();
    }

    _captureDiagnosticTxPacket(hex, gatewayId) {
        const bytes = [];
        for (let i = 0; i < hex.length; i += 2) {
            bytes.push(parseInt(hex.slice(i, i + 2), 16));
        }

        if (bytes.length < 12) return;

        const valveId = utils.decodeLittleEndian(bytes, 1, 4);
        const cmd = bytes[10];
        const payloadLen = bytes[11];
        const payload = bytes.slice(12, 12 + payloadLen);
        const device = this.devices.get(valveId);

        if (!(device?.model === 'Unbekanntes Modell' || device?.model === 'Unknown')) return;

        this._captureDiagnosticPacket({
            gatewayId,
            rssi: null,
            valveId,
            cmd,
            hexPayload: hex,
            rawBytes: bytes,
            payload
        });
    }

    /**
     * Returns a grouped summary of diagnostic logs for the frontend.
     * One entry per unique valveId with the total packet count.
     */
    getDiagnosticSummary() {
        const grouped = new Map();
        for (const log of this.unknownDevicesLogs) {
            const key = String(log.valveId);
            if (!grouped.has(key)) {
                grouped.set(key, {
                    valveId: key,
                    packetCount: 1,
                    timestamp: log.timestamp,
                    gatewayId: log.gatewayId,
                    rssi: log.rssi,
                });
            } else {
                const entry = grouped.get(key);
                entry.packetCount++;
                entry.timestamp = log.timestamp; // neuester Zeitstempel
            }
        }
        return Array.from(grouped.values());
    }

    async _handleGatewayConnection(ev) {
        this.emit('gatewayStateUpdate');
        if (ev.connected) {
            console.log(`[SmartHub] Gateway ${ev.gatewayId} connected. Running initial watchdog check...`);
            // Ruft den Watchdog direkt auf. Da lastSeen oft älter als 5h ist,
            // werden die Pings direkt hier getriggert!
            await this._checkDeviceWatchdog();
        } else {
            this._checkAllGatewaysStatus();
        }
    }

    _checkAllGatewaysStatus() {
        let anyConnected = false;
        for (const gw of this.gateways.values()) {
            if (gw.isConnected) {
                anyConnected = true;
                break;
            }
        }

        if (!anyConnected) {
            console.log('[SmartHub] 🔴 No gateway online. Marking all valves as offline.');
            for (const device of this.devices.values()) {
                if (device.isOnline) {
                    device.lastSeen = 0;
                    device._notifyStateChange('All gateways offline');
                }
            }
        }
    }

    async _checkDeviceWatchdog() {
        const now = Date.now();
        const pingTimeoutMs = 5 * 60 * 60 * 1000; // 5 Stunden
        const offlineThresholdMs = 12 * 60 * 60 * 1000; // 12 Stunden

        for (const device of this.devices.values()) {
            if (!device.isBound) continue;

            const timeSinceLastSeen = device.lastSeen ? (now - device.lastSeen) : Infinity;

            if (timeSinceLastSeen > pingTimeoutMs) {
                console.log(`[SmartHub] Watchdog: ping required for valve ${device.valveId} (last contact: ${timeSinceLastSeen === Infinity ? 'never' : Math.floor(timeSinceLastSeen / 1000 / 60) + ' min'}).`);

                // Bevor wir pingen, setzen wir das Gerät optional auf offline, falls es sehr alt ist
                if (timeSinceLastSeen > offlineThresholdMs) {
                    device._notifyStateChange('Watchdog offline limit reached');
                }

                try {
                    await device.executeWakeUpPing(2, 1000);
                } catch (err) {
                    console.error(`[SmartHub] Watchdog ping error for valve ${device.valveId}:`, err.message);
                }
            }
        }
    }

    async shutdown() {
        console.log('[SmartHub] Shutting down...');
        if (this.mdnsScanner) {
            this.mdnsScanner.stop();
        }
        if (this.otaManager) {
            this.otaManager.stop();
        }
        for (const device of this.devices.values()) {
            if (device.isBound) {
                this.deviceStore.save(this.devices);
            }
        }
    }

    _loadGateways() {
        const savedGateways = this.gatewayStore.load();
        for (const gwInfo of savedGateways) {
            this._addDynamicGateway(gwInfo);
        }
        if (savedGateways.length > 0) {
            console.log(`[SmartHub] ${savedGateways.length} manually saved gateway(s) restored.`);
        }
    }

    _initGateways() {
        // Initiale Config-Gateways anlegen
        for (const gwConf of this.gatewayConfigs) {
            const node = new GatewayNode(gwConf, this);
            this.gateways.set(node.id, node);
        }
    }

    _addDynamicGateway(gwInfo) {
        // Falls wir schon ein Gateway mit dieser IP oder ID haben, ignorieren
        for (const existingNode of this.gateways.values()) {
            if (existingNode.ip === gwInfo.ip) {
                // Wenn die IP existiert, aber unter anderer ID, aktualisieren wir evtl. nix,
                // da das Gateway schon läuft.
                return;
            }
        }

        if (this.gateways.has(gwInfo.id)) return;

        console.log(`[SmartHub] Adding gateway dynamically: ${gwInfo.id} (${gwInfo.ip}:${gwInfo.port})`);

        const node = new GatewayNode({
            id: gwInfo.id,
            ip: gwInfo.ip,
            port: gwInfo.port
        }, this);

        this.gateways.set(node.id, node);

        // Notify frontend that a new gateway was added
        this.emit('gatewayStateUpdate');

        // Save manual gateways
        if (gwInfo.id.startsWith('manual-')) {
            this.gatewayStore.save(this.gateways);
        }
    }

    _removeDynamicGateway(gatewayId) {
        if (!gatewayId.startsWith('manual-')) return;

        const node = this.gateways.get(gatewayId);
        if (node) {
            console.log(`[SmartHub] Removing manual gateway: ${gatewayId}`);

            node.destroy();

            this.gateways.delete(gatewayId);
            this.emit('gatewayStateUpdate');
            this.gatewayStore.save(this.gateways);

            this._checkAllGatewaysStatus();
        }
    }

    removeDevice(valveId) {
        const id = Number(valveId);
        if (this.devices.has(id)) {
            console.log(`[SmartHub] Removing device ${id}`);

            // Optional cleanup if necessary
            // this.devices.get(id).destroy();

            this.devices.delete(id);
            this.deviceStore.save(this.devices);
            console.log(`[SmartHub] Device ${id} removed and store updated.`);
        }
    }

    async routePacket(hex, txChannel, rxChannel, candidates, options = {}) {
        const preferred = options.preferredGatewayId ? this.gateways.get(options.preferredGatewayId) : null;
        const candidateGws = candidates.map(id => this.gateways.get(id)).filter(Boolean);
        const allGateways = Array.from(this.gateways.values());

        const selectedGw =
            (preferred?.isConnected ? preferred : null) ||
            candidateGws.find(gw => gw.isConnected && !gw.isBusy) ||
            candidateGws.find(gw => gw.isConnected) ||
            allGateways.find(gw => gw.isConnected && !gw.isBusy) ||
            allGateways.find(gw => gw.isConnected);

        if (!selectedGw) {
            throw new Error('Routing failed: no gateway is currently online!');
        }

        const txProfile = options.txProfile || 'short';


        const isRefreshTrigger = options.refreshTrigger === true;

        if (isRefreshTrigger) {
            this._captureDiagnosticTxPacket(hex, selectedGw.id);
            return selectedGw.sendRefreshTransaction(hex, txChannel, options.targetValveId, options);
        }

        const isTransactional = !!options.expectReply && Number.isInteger(options.targetValveId);

        if (isTransactional) {
            this._captureDiagnosticTxPacket(hex, selectedGw.id);
            return selectedGw.sendActionTransaction(hex, txChannel, options.targetValveId, options);
        }

        this._captureDiagnosticTxPacket(hex, selectedGw.id);
        return selectedGw.sendQueued(hex, txChannel, rxChannel, txProfile);
    }

    _getGatewayOrThrow(gatewayId) {
        const gw = this.gateways.get(gatewayId);
        if (!gw) {
            throw new Error(`Gateway '${gatewayId}' nicht gefunden.`);
        }
        return gw;
    }

    setGatewayLed(gatewayId, on) {
        return this._getGatewayOrThrow(gatewayId).setLed(!!on);
    }

    startGatewayPortal(gatewayId) {
        return this._getGatewayOrThrow(gatewayId).startPortal();
    }

    clearGatewayWifi(gatewayId) {
        return this._getGatewayOrThrow(gatewayId).clearWifi();
    }

    getGatewayVersion(gatewayId) {
        return this._getGatewayOrThrow(gatewayId).getVersion();
    }

    sendGatewayOta(gatewayId, url) {
        return this._getGatewayOrThrow(gatewayId).sendOta(url);
    }

    getGateway(gatewayId) {
        return this.gateways.get(gatewayId) || null;
    }

    processIncomingRadioPacket(gatewayId, rssi, hexPayload) {
        // Hex String ordentlich loggen für Debugging (optional, wie in V3)
        // console.log(`[RX ${gatewayId}] ${hexPayload}`); 

        const bytes = [];
        for (let i = 0; i < hexPayload.length; i += 2) {
            bytes.push(parseInt(hexPayload.slice(i, i + 2), 16));
        }

        if (bytes.length < 12) return;

        const senderId = utils.decodeLittleEndian(bytes, 5, 4);
        const seq = bytes[9];
        const cmd = bytes[10];
        const payloadLen = bytes[11];
        const payload = bytes.slice(12, 12 + payloadLen);

        if (senderId === this.config.id) return;

        let device = this.devices.get(senderId);
        let diagnosticPacketCaptured = false;

        if (!device) {
            if (cmd === 0x01) {
                const joinInfo = utils.parseJoinPacket(payload);

                if (joinInfo?.model === 'Unbekanntes Modell' || joinInfo?.model === 'Unknown') {
                    this._captureDiagnosticPacket({
                        gatewayId,
                        rssi,
                        valveId: senderId,
                        cmd,
                        hexPayload,
                        rawBytes: bytes,
                        payload,
                        joinInfo
                    });
                    diagnosticPacketCaptured = true;
                }

                if (!this.pairingMode) return;

                console.log(`\n[+] NEW DEVICE DETECTED: ID ${senderId}`);

                device = new ValveDevice(senderId, this.config.id, this.gatewayApi, {
                    isBound: false,
                    model: joinInfo.model,
                    channelCount: joinInfo.channelCount,
                });

                // NEU: Hänge den Event-Listener an den Zwilling!
                device.on('stateUpdate', (updateData) => {
                    // Hier kannst du das JSON weiterverteilen (WebSockets, MQTT, etc.)
                    console.log(`\n🌍 [DIGITAL TWIN] Update for valve ${updateData.valveId} due to ${updateData.reason}:`);
                    console.log(JSON.stringify(updateData.state, null, 2));
                    this.emit('deviceUpdate', updateData);
                    this.deviceStore.save(this.devices);
                });

                this.devices.set(senderId, device);
                this.deviceStore.save(this.devices); // Sofort nach dem Anlernen speichern
            } else {
                return;
            }
        }

        // Unbekannte Modelle komplett protokollieren für Diagnostic Export
        if (!diagnosticPacketCaptured && (device.model === 'Unbekanntes Modell' || device.model === 'Unknown')) {
            this._captureDiagnosticPacket({
                gatewayId,
                rssi,
                valveId: senderId,
                cmd,
                hexPayload,
                rawBytes: bytes,
                payload
            });
        }

        device.handleIncomingPacket(seq, cmd, payload, hexPayload, gatewayId, rssi);
    }

    allocateDeviceAddress() {
        const used = new Set(Array.from(this.devices.values()).map(d => d.deviceAddress).filter(Number.isInteger));
        let addr = 1;
        while (used.has(addr)) addr++;
        return addr;
    }

    allocateChannelCode(targetDevice, proposedChannelCode) {
        const used = new Set(Array.from(this.devices.values()).map(d => d.channelCode).filter(Number.isInteger));
        const preferred = [0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10];

        const desiredCode = preferred.find(code => !used.has(code));

        if (!Number.isInteger(desiredCode)) {
            if (Number.isInteger(proposedChannelCode) && proposedChannelCode > 0 && !used.has(proposedChannelCode)) {
                return proposedChannelCode;
            }
            return 0x06; // Fallback
        }
        return desiredCode;
    }

    _initCLI() {
        const isInteractiveCli = Boolean(process.stdin.isTTY && process.stdout.isTTY);

        if (!isInteractiveCli) {
            console.log('[CLI] No interactive TTY detected, CLI disabled');
            return;
        }

        const rlCli = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: 'hub> '
        });

        let cliClosed = false;

        const safePrompt = () => {
            if (cliClosed) return;

            try {
                rlCli.prompt();
            } catch (err) {
                if (err?.code !== 'ERR_USE_AFTER_CLOSE') {
                    console.error('[CLI] Prompt failed:', err);
                }
            }
        };

        rlCli.on('close', () => {
            cliClosed = true;
            console.log('[CLI] Readline closed');
        });

        setTimeout(safePrompt, 1000);

        rlCli.on('line', (line) => {
            const args = line.trim().split(/\s+/);
            const cmd = (args[0] || '').toLowerCase();
            const deviceList = Array.from(this.devices.values());

            if (cmd === 'list' || cmd === 'lsit') {
                console.log('\n=== CONNECTED VALVES ===');
                if (deviceList.length === 0) console.log('  [!] No valves found yet.');

                deviceList.forEach((dev) => {
                    console.log(` [Addr: ${dev.deviceAddress}] ID: ${dev.valveId} | Online: ${dev.isOnline ? 'Yes' : 'No'} | RF channel: ${dev.channelCode - 1}`);
                    for (let ch = 1; ch <= dev.channelCount; ch++) {
                        const info = dev.channels[ch];
                        if (info) {
                            console.log(`    └─ Valve ${ch}: ${info.status} | Remaining: ${info.remaining}s`);
                        }
                    }
                });
                console.log('========================\n');
                safePrompt();
                return;
            }

            if (cmd === 'pair') {
                const mode = (args[1] || '').toLowerCase();
                if (mode === 'on') {
                    this.pairingMode = true;
                    console.log('[+] Pairing mode ACTIVE');
                } else if (mode === 'off') {
                    this.pairingMode = false;
                    console.log('[+] Pairing mode OFF');
                } else {
                    console.log(`Pairing mode: ${this.pairingMode ? 'ON' : 'OFF'}`);
                }
                safePrompt();
                return;
            }

            if (cmd === 'on' || cmd === 'off') {
                const targetAddr = parseInt(args[1], 10);
                const valveIndex = parseInt(args[2], 10);
                const seconds = parseInt(args[3], 10) || 600;

                const targetDevice = deviceList.find(d => d.deviceAddress === targetAddr);

                if (!targetDevice) {
                    console.log(`[!] No device with address ${targetAddr} found.`);
                    safePrompt();
                    return;
                }

                console.log(`[+] Sending command to device ${targetDevice.valveId} (Addr: ${targetAddr}), channel ${valveIndex}...`);
                const action = cmd === 'on'
                    ? targetDevice.valve(valveIndex).on(seconds)
                    : targetDevice.valve(valveIndex).off();

                action.then(res => {
                    console.log(`\n[OK] Valve reports: ${res.status} (${res.remainingSeconds}s remaining)`);
                    safePrompt();
                }).catch(err => {
                    console.log(`\n[ERROR] ${err.message}`);
                    safePrompt();
                });

                return;
            }

            if (cmd !== '') {
                console.log('\n--- COMMANDS ---');
                console.log(' list                     -> List all devices');
                console.log(' pair [on|off]            -> Pairing mode');
                console.log(' on <addr> <valve> [s]    -> Turn valve on (e.g. on 1 1 600)');
                console.log(' off <addr> <valve>       -> Turn valve off (e.g. off 1 1)');
                console.log('----------------\n');
            }

            safePrompt();
        });
    }
}

// Hub starten
//const myHub = new SmartHub();
module.exports = SmartHub;
