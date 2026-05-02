const net = require('net');
const readline = require('readline');
const { RadioJobQueue } = require('./RadioJobQueue');
const utils = require('./utils');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class GatewayNode {
    constructor(config, hubInstance) {
        this.id = config.id;
        this.ip = config.ip;
        this.port = config.port;
        this.hub = hubInstance;

        this.client = null;
        this.rl = null;

        this.pendingTune = null;
        this.pendingTx = null;
        this.pendingControl = null;
        this.pendingInboundWait = null;

        this.lastSeenAt = 0;
        this.heartbeatInterval = null;
        this.pendingHeartbeat = null;
        this.lastDisconnectReason = 'unknown';

        this.isConnected = false;
        this.isDestroyed = false;

        this.currentRadio = {
            txChannel: 4,
            rxChannel: 0,
            txProfile: 'short',
        };

        this.lastVersion = null;

        this.radioQueue = new RadioJobQueue({
            name: `gateway-${this.id}-radio`,
            maxQueueSize: 100,
        });

        this._initSocket();
    }

    _initSocket() {
        if (this.rl) {
            this.rl.removeAllListeners();
            this.rl.close();
            this.rl = null;
        }
        if (this.client) {
            this.client.removeAllListeners();
            this.client.destroy();
            this.client = null;
        }

        this.client = new net.Socket();

        this._setConnectionState(false, 'initializing');

        this.client.connect(this.port, this.ip, async () => {
            this.lastSeenAt = Date.now();
            this.lastDisconnectReason = 'tcp-connected';

            console.log(`[+] Gateway '${this.id}' TCP verbunden (${this.ip}:${this.port}), initialisiere Radio...`);

            try {
                await this._configureRadio(
                    this.hub.config.features.idleTxChannel,
                    this.hub.config.features.idleRxChannel,
                    this.hub.config.features.idleProfile
                );
                console.log(
                    `[+] Gateway '${this.id}' initial auf TX=${this.hub.config.features.idleTxChannel} / RX=${this.hub.config.features.idleRxChannel} gesetzt`
                );
            } catch (err) {
                console.error(`[!] Initial-TUNE für Gateway '${this.id}' fehlgeschlagen: ${err.message}`);
            }

            this._setConnectionState(true, 'tcp-connected');
            this._startHeartbeatMonitor();

            console.log(`[+] Gateway '${this.id}' ist bereit.`);

            this.getVersion().catch(() => { });
        });

        this.rl = readline.createInterface({
            input: this.client,
            crlfDelay: Infinity,
        });

        this.rl.on('line', (line) => {
            const cleanLine = line.trim();
            if (cleanLine) this._processLine(cleanLine);
        });

        this.rl.on('error', (err) => {
            console.error(`[!] Readline Fehler Gateway '${this.id}': ${err.message}`);
        });

        this.client.on('error', (err) => {
            console.error(`[!] TCP Fehler Gateway '${this.id}': ${err.message}`);
        });

        this.client.on('close', () => {
            this._stopHeartbeatMonitor();
            this.currentRadio = { txChannel: 4, rxChannel: 0, txProfile: 'short' };

            this._setConnectionState(false, 'tcp-closed');

            if (this.isDestroyed) {
                console.log(`[!] Verbindung zu Gateway '${this.id}' getrennt (manuell entfernt).`);
                return;
            }

            console.log(`[!] Verbindung zu Gateway '${this.id}' getrennt. Verbinde neu in 5s...`);

            if (this.pendingHeartbeat) {
                clearTimeout(this.pendingHeartbeat.timeout);
                this.pendingHeartbeat = null;
            }

            this.hub.emit('gatewayConnection', {
                gatewayId: this.id,
                connected: false,
                ts: Date.now(),
            });

            this._rejectPendingIo(new Error('Verbindungsabbruch'));

            setTimeout(() => this._initSocket(), 5000);
        });
    }

    destroy() {
        this.isDestroyed = true;
        this._stopHeartbeatMonitor();

        if (this.pendingHeartbeat) {
            clearTimeout(this.pendingHeartbeat.timeout);
            this.pendingHeartbeat = null;
        }

        if (this.client) {
            try {
                this.client.destroy();
            } catch (_) { }
        }

        if (this.rl) {
            try {
                this.rl.close();
            } catch (_) { }
        }
    }

    _rejectPendingIo(err) {
        if (this.pendingTune) {
            this.pendingTune.reject(err);
            this.pendingTune = null;
        }
        if (this.pendingTx) {
            this.pendingTx.reject(err);
            this.pendingTx = null;
        }
        if (this.pendingControl) {
            this.pendingControl.reject(err);
            this.pendingControl = null;
        }
        if (this.pendingInboundWait) {
            clearTimeout(this.pendingInboundWait.timeout);
            if (this.pendingInboundWait.signal && this.pendingInboundWait.abortHandler) {
                this.pendingInboundWait.signal.removeEventListener('abort', this.pendingInboundWait.abortHandler);
            }
            this.pendingInboundWait.resolve(null);
            this.pendingInboundWait = null;
        }
    }

    _processLine(line) {
        this.lastSeenAt = Date.now();

        if (this.pendingHeartbeat) {
            clearTimeout(this.pendingHeartbeat.timeout);
            this.pendingHeartbeat = null;
        }

        if (line === 'ACK:TUNED') {
            if (this.pendingTune) this.pendingTune.resolve();
            return;
        }

        if (line === 'ACK:TX_OK' || line === 'ACK:TX_DONE') {
            if (this.pendingTx) this.pendingTx.resolve();
            return;
        }

        if (line.startsWith('ACK:OTA_') || line.startsWith('ERR:OTA_')) {
            this.hub.emit('gatewayOtaStatus', {
                gatewayId: this.id,
                status: line,
                ts: Date.now(),
            });
            return;
        }

        if (line.startsWith('ERR:')) {
            const err = new Error(line);

            if (line.startsWith('ERR:TUNE') && this.pendingTune) {
                this.pendingTune.reject(err);
            } else if (
                (
                    line.startsWith('ERR:TX') ||
                    line === 'ERR:BAD_HEX' ||
                    line === 'ERR:BAD_HEX_LENGTH' ||
                    line === 'ERR:BAD_PACKET_LENGTH' ||
                    line === 'ERR:EMPTY_TX' ||
                    line === 'ERR:HEX_PARSE'
                ) &&
                this.pendingTx
            ) {
                this.pendingTx.reject(err);
            } else if (this.pendingControl) {
                this.pendingControl.reject(err);
            } else {
                console.warn(`[Gateway ${this.id}] Unbehandelte ERR-Nachricht: ${line}`);
            }

            return;
        }

        if (line === 'BTN:PRESSED' || line === 'BTN:RELEASED') {
            const pressed = line === 'BTN:PRESSED';
            this.hub.emit('gatewayButton', {
                gatewayId: this.id,
                pressed,
                event: pressed ? 'pressed' : 'released',
                raw: line,
                ts: Date.now(),
            });
            return;
        }

        if (line.startsWith('VERSION:')) {
            const versionInfo = this._parseVersionLine(line);
            this.lastVersion = versionInfo;

            this.hub.emit('gatewayVersion', versionInfo);

            if (this.pendingControl && this.pendingControl.match(line)) {
                this.pendingControl.resolve(versionInfo);
            }
            return;
        }

        if (this.pendingControl && this.pendingControl.match(line)) {
            this.pendingControl.resolve(line);
            return;
        }

        if (!line.startsWith('RX:')) return;

        const parts = line.split(':');
        if (parts.length < 5) return;

        const rssiDbm = parseInt(parts[3], 10);
        const hexPayload = parts[4].trim();
        if (!hexPayload) return;

        if (this.pendingInboundWait) {
            try {
                const bytes = [];
                for (let i = 0; i < hexPayload.length; i += 2) {
                    bytes.push(parseInt(hexPayload.slice(i, i + 2), 16));
                }

                if (bytes.length >= 12) {
                    const senderId = utils.decodeLittleEndian(bytes, 5, 4);
                    const seq = bytes[9];
                    const cmd = bytes[10];

                    const matchesSender =
                        !this.pendingInboundWait.targetValveId ||
                        senderId === this.pendingInboundWait.targetValveId;

                    if (matchesSender) {
                        const waiter = this.pendingInboundWait;
                        clearTimeout(waiter.timeout);
                        if (waiter.signal && waiter.abortHandler) {
                            waiter.signal.removeEventListener('abort', waiter.abortHandler);
                        }
                        this.pendingInboundWait = null;
                        waiter.resolve({ senderId, seq, cmd, hexPayload });
                    }
                }
            } catch (_) { }
        }

        this.hub.processIncomingRadioPacket(this.id, rssiDbm, hexPayload);
    }

    _needsRadioConfig(txChannel, rxChannel, txProfile) {
        return (
            this.currentRadio.txChannel !== txChannel ||
            this.currentRadio.rxChannel !== rxChannel ||
            this.currentRadio.txProfile !== txProfile
        );
    }

    _parseVersionLine(line) {
        const parts = line.split(':');
        const model = parts[1] || null;
        const version = parts.length > 2 ? parts.slice(2).join(':') : null;

        return {
            gatewayId: this.id,
            model,
            version,
            raw: line,
            ts: Date.now(),
        };
    }

    _sendControl(command, options = {}) {
        const {
            timeoutMs = 1500,
            match = null,
            transform = null,
        } = options;

        return new Promise((resolve, reject) => {
            if (!this.isConnected) {
                return reject(new Error(`Gateway '${this.id}' ist offline.`));
            }

            if (typeof match !== 'function') {
                this.client.write(`${command}\n`);
                return resolve({ ok: true, command });
            }

            if (this.pendingControl) {
                return reject(new Error(`Control-Befehl läuft bereits auf Gateway '${this.id}'.`));
            }

            const timeout = setTimeout(() => {
                if (this.pendingControl) {
                    this.pendingControl = null;
                    reject(new Error(`Control Timeout (${this.id}): ${command}`));
                }
            }, timeoutMs);

            this.pendingControl = {
                command,
                match,
                transform,
                resolve: (value) => {
                    clearTimeout(timeout);
                    const out = typeof transform === 'function' ? transform(value) : value;
                    this.pendingControl = null;
                    resolve(out);
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    this.pendingControl = null;
                    reject(err);
                },
            };

            this.client.write(`${command}\n`);
        });
    }

    setLed(isOn) {
        const expectedAck = isOn ? 'ACK:LED_ON' : 'ACK:LED_OFF';
        return this._sendControl(`LED:${isOn ? 'ON' : 'OFF'}`, {
            match: (line) => line === expectedAck,
        });
    }

    startPortal() {
        return this._sendControl('PORTAL', {
            match: (line) => line === 'ACK:PORTAL_STARTING',
        });
    }

    clearWifi() {
        return this._sendControl('CLEARWIFI', {
            match: (line) => line === 'ACK:WIFI_CLEARED',
        });
    }

    getVersion() {
        return this._sendControl('VERSION', {
            timeoutMs: 2000,
            match: (line) => line.startsWith('VERSION:'),
        });
    }

    sendOta(url) {
        return this._sendControl(`OTA:${url}`, {
            timeoutMs: 2000,
            match: (line) =>
                line === 'ACK:OTA_STARTING' ||
                line === 'ACK:OTA_OK',
        });
    }

    _configureRadio(txChannel, rxChannel = 0, txProfile = 'short') {
        return new Promise((resolve, reject) => {
            if (!this.isConnected && this.client) {
                return reject(new Error(`Gateway '${this.id}' ist offline.`));
            }
            if (this.pendingTune) return reject(new Error('TUNE läuft bereits.'));

            const timeout = setTimeout(() => {
                if (this.pendingTune) {
                    this.pendingTune = null;
                    reject(new Error(`TUNE Timeout (${this.id})`));
                }
            }, 1500);

            this.pendingTune = {
                resolve: () => {
                    clearTimeout(timeout);
                    this.currentRadio = { txChannel, rxChannel, txProfile };
                    this.pendingTune = null;
                    resolve();
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    this.pendingTune = null;
                    reject(err);
                },
            };

            this.client.write(`TUNE:${txChannel}:${rxChannel}:${txProfile}\n`);
        });
    }

    _txDirect(hexString, txTimeoutMs = 1500) {
        return new Promise((resolve, reject) => {
            if (!this.isConnected || !this.client) {
                return reject(new Error(`Gateway '${this.id}' ist offline.`));
            }
            if (this.pendingTx) return reject(new Error('TX läuft bereits.'));

            const timeout = setTimeout(() => {
                if (this.pendingTx) {
                    this.pendingTx = null;
                    reject(new Error(`TX Timeout (${this.id})`));
                }
            }, txTimeoutMs);

            this.pendingTx = {
                resolve: () => {
                    clearTimeout(timeout);
                    this.pendingTx = null;
                    resolve();
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    this.pendingTx = null;
                    reject(err);
                },
            };

            this.client.write(`TX:${hexString}\n`);
        });
    }

    _waitForInbound(targetValveId, waitMs = this.hub.config.features.defaultInboundWaitMs, signal = null) {
        return new Promise((resolve, reject) => {
            if (this.pendingInboundWait) {
                clearTimeout(this.pendingInboundWait.timeout);
                if (this.pendingInboundWait.signal && this.pendingInboundWait.abortHandler) {
                    this.pendingInboundWait.signal.removeEventListener('abort', this.pendingInboundWait.abortHandler);
                }
                this.pendingInboundWait = null;
            }

            let finished = false;

            const finishResolve = (value) => {
                if (finished) return;
                finished = true;
                if (signal && abortHandler) {
                    signal.removeEventListener('abort', abortHandler);
                }
                if (this.pendingInboundWait && this.pendingInboundWait.timeout === timeout) {
                    this.pendingInboundWait = null;
                }
                clearTimeout(timeout);
                resolve(value);
            };

            const finishReject = (err) => {
                if (finished) return;
                finished = true;
                if (signal && abortHandler) {
                    signal.removeEventListener('abort', abortHandler);
                }
                if (this.pendingInboundWait && this.pendingInboundWait.timeout === timeout) {
                    this.pendingInboundWait = null;
                }
                clearTimeout(timeout);
                reject(err);
            };

            const timeout = setTimeout(() => {
                finishResolve(null);
            }, waitMs);

            let abortHandler = null;
            if (signal) {
                if (signal.aborted) {
                    clearTimeout(timeout);
                    return reject(signal.reason || new Error('Aborted'));
                }
                abortHandler = () => {
                    finishReject(signal.reason || new Error('Aborted'));
                };
                signal.addEventListener('abort', abortHandler, { once: true });
            }

            this.pendingInboundWait = {
                targetValveId,
                resolve: finishResolve,
                reject: finishReject,
                timeout,
                signal,
                abortHandler,
            };
        });
    }

    async _ensureRadio(txChannel, rxChannel, txProfile) {
        if (this._needsRadioConfig(txChannel, rxChannel, txProfile)) {
            await this._configureRadio(txChannel, rxChannel, txProfile);
            await sleep(this.hub.config.features.defaultTuneDelayMs);
        }
    }

    async _retuneToIdle() {
        await this._ensureRadio(
            this.hub.config.features.idleTxChannel,
            this.hub.config.features.idleRxChannel,
            this.hub.config.features.idleProfile
        );
    }

    async _legacySpamFallback(hexString, txChannel, targetValveId, options = {}) {
        const {
            attempts = 12,
            waitMs = 180,
            retryDelayMs = 35,
            txProfile = 'short',
            signal = null,
        } = options;

        await this._ensureRadio(txChannel, txChannel, txProfile);

        let inbound = null;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            if (signal?.aborted) {
                throw signal.reason || new Error('Aborted');
            }

            await this._txDirect(hexString);
            inbound = await this._waitForInbound(targetValveId, waitMs, signal);

            if (inbound) break;

            if (attempt < attempts) {
                await sleep(retryDelayMs);
            }
        }

        return inbound;
    }

    sendQueued(hexString, txChannel, rxChannel = 0, txProfile = 'short') {
        return this.radioQueue.enqueue(async () => {
            if (!this.isConnected) {
                throw new Error(`Gateway '${this.id}' ist offline.`);
            }

            await this._ensureRadio(txChannel, rxChannel, txProfile);
            await this._txDirect(hexString);
        }, {
            id: `send-${Date.now()}-${txChannel}-${rxChannel}`,
            priority: 1,
            acquireTimeoutMs: 2000,
            executionTimeoutMs: 2500,
        });
    }

    sendActionTransaction(hexString, txChannel, targetValveId, options = {}) {
        const txProfile = options.txProfile || 'long';
        const waitMs = Number.isInteger(options.waitMs)
            ? options.waitMs
            : this.hub.config.features.defaultActionWaitMs;
        const maxAttempts = Number.isInteger(options.maxAttempts)
            ? options.maxAttempts
            : this.hub.config.features.defaultActionMaxAttempts;
        const retryDelayMs = Number.isInteger(options.retryDelayMs)
            ? options.retryDelayMs
            : this.hub.config.features.defaultActionRetryDelayMs;
        const fallbackToLegacySpam = !!options.fallbackToLegacySpam;

        return this.radioQueue.enqueue(async ({ signal }) => {
            if (!this.isConnected) {
                throw new Error(`Gateway '${this.id}' ist offline.`);
            }

            await this._ensureRadio(txChannel, txChannel, txProfile);

            try {
                const txTimeoutMs = txProfile === 'long' ? 4000 : 1500;
                let inbound = null;

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    if (signal.aborted) {
                        throw signal.reason || new Error('Aborted');
                    }

                    await this._txDirect(hexString, txTimeoutMs);
                    inbound = await this._waitForInbound(targetValveId, waitMs, signal);

                    if (inbound) break;

                    if (attempt < maxAttempts) {
                        await sleep(retryDelayMs);
                    }
                }

                if (!inbound && fallbackToLegacySpam) {
                    inbound = await this._legacySpamFallback(hexString, txChannel, targetValveId, {
                        attempts: 12,
                        waitMs: 180,
                        retryDelayMs: 35,
                        txProfile: 'short',
                        signal,
                    });
                }

                return inbound;
            } finally {
                try {
                    await this._retuneToIdle();
                } catch (retuneErr) {
                    console.error(`[Gateway ${this.id}] Retune nach Action fehlgeschlagen: ${retuneErr.message}`);
                }
            }
        }, {
            id: `action-${targetValveId}-${Date.now()}`,
            priority: 10,
            acquireTimeoutMs: 2500,
            executionTimeoutMs: 5500,
        });
    }

    sendRefreshTransaction(hexString, txChannel, targetValveId, options = {}) {
        const txProfile = options.txProfile || 'long';
        const listenWindowMs = Number.isInteger(options.listenWindowMs)
            ? options.listenWindowMs
            : 1800;

        return this.radioQueue.enqueue(async ({ signal }) => {
            if (!this.isConnected) {
                throw new Error(`Gateway '${this.id}' ist offline.`);
            }

            // WICHTIG: Setze rxChannel auf 0, damit der ESP32 nach dem Senden
            // in C++ sofort und ohne Verzögerung auf Kanal 0 lauscht!
            await this._ensureRadio(txChannel, 0, txProfile);

            try {
                const txTimeoutMs = txProfile === 'long' ? 4000 : 1500;
                await this._txDirect(hexString, txTimeoutMs);

                // Kein _retuneToIdle() mehr hier! Der ESP32 ist bereits auf RX 0.
                // Das spart 20-50ms TCP-Verzögerung, in der die Antwort verloren gehen könnte.

                const deadline = Date.now() + listenWindowMs;
                const followUps = [];

                while (Date.now() < deadline) {
                    if (signal.aborted) {
                        throw signal.reason || new Error('Aborted');
                    }

                    const remainingMs = deadline - Date.now();
                    const inbound = await this._waitForInbound(
                        targetValveId,
                        Math.min(remainingMs, 400),
                        signal
                    );

                    if (!inbound) continue;

                    followUps.push(inbound);

                    if (inbound.cmd === 0x05 || inbound.cmd === 0x06) {
                        break;
                    }
                }

                return followUps;
            } finally {
                try {
                    if (this._needsRadioConfig(
                        this.hub.config.features.idleTxChannel,
                        this.hub.config.features.idleRxChannel,
                        this.hub.config.features.idleProfile
                    )) {
                        /*
                        console.warn(
                            `[Gateway ${this.id}] ⚠️ Safety-Net: War noch auf TX=${this.currentRadio.txChannel}/RX=${this.currentRadio.rxChannel}/${this.currentRadio.txProfile} -> Retune auf idle`
                        );
                        await this._retuneToIdle();
                        */
                    }
                } catch (retuneErr) {
                    console.error(`[Gateway ${this.id}] Safety-Net Retune fehlgeschlagen: ${retuneErr.message}`);
                }
            }
        }, {
            id: `refresh-${targetValveId}-${Date.now()}`,
            priority: 7,
            acquireTimeoutMs: 3000,
            executionTimeoutMs: listenWindowMs + 5000,
        });
    }

    _setConnectionState(connected, reason = 'unknown') {
        const changed = this.isConnected !== connected;
        this.isConnected = connected;

        if (!changed) return;

        this.hub.emit('gatewayConnection', {
            gatewayId: this.id,
            connected,
            reason,
            ts: Date.now(),
        });
    }

    _startHeartbeatMonitor() {
        this._stopHeartbeatMonitor();

        this.heartbeatInterval = setInterval(() => {
            this._checkHeartbeat().catch(err => {
                console.error(`[Gateway ${this.id}] Heartbeat-Fehler: ${err.message}`);
            });
        }, 30000);
    }

    _stopHeartbeatMonitor() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    async _checkHeartbeat() {
        if (!this.isConnected || !this.client) return;
        if (this.pendingHeartbeat) return;
        if (this.pendingControl || this.pendingTune || this.pendingTx) return;
        if (this.radioQueue.isBusy || this.radioQueue.waiting > 0) return;

        if (this._needsRadioConfig(
            this.hub.config.features.idleTxChannel,
            this.hub.config.features.idleRxChannel,
            this.hub.config.features.idleProfile
        )) {
            console.warn(
                `[Gateway ${this.id}] ⚠️ Heartbeat: Gateway idle aber auf falschem Kanal ` +
                `(TX=${this.currentRadio.txChannel}/RX=${this.currentRadio.rxChannel}/${this.currentRadio.txProfile}) -> Retune auf idle`
            );
            try {
                await this._retuneToIdle();
            } catch (err) {
                console.error(`[Gateway ${this.id}] Heartbeat Idle-Retune fehlgeschlagen: ${err.message}`);
            }
        }

        const idleMs = Date.now() - this.lastSeenAt;
        if (idleMs < 30000) return;

        console.log(`[Gateway ${this.id}] Seit ${idleMs}ms keine Daten empfangen -> Heartbeat via VERSION`);

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.warn(`[Gateway ${this.id}] Heartbeat Timeout -> Socket wird getrennt`);
                this.pendingHeartbeat = null;

                try {
                    this.client.destroy();
                } catch (_) { }

                resolve();
            }, 8000);

            this.pendingHeartbeat = { timeout };

            this.client.write('VERSION\n', (err) => {
                if (err) {
                    clearTimeout(timeout);
                    this.pendingHeartbeat = null;
                    try {
                        this.client.destroy();
                    } catch (_) { }
                    return resolve();
                }
            });
        });
    }

    get isBusy() {
        return this.radioQueue.isBusy || this.radioQueue.waiting > 0;
    }
}

module.exports = GatewayNode;