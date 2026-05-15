const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

class WebServer {
    constructor(hub, config) {
        this.hub = hub;
        this.app = express();
        this.server = http.createServer(this.app);

        this.otaDir = config.otaDir || path.join(__dirname, '../ota');
        this.otaBaseUrl = (config.otaBaseUrl || process.env.OTA_BASE_URL || '').replace(/\/+$/, '');

        const isDev = process.env.NODE_ENV !== 'production';

        this.io = new Server(this.server, isDev ? {
            cors: {
                origin: 'http://localhost:5173',
                methods: ['GET', 'POST']
            }
        } : {});

        this.app.get('/api/health', (_req, res) => {
            res.json({ ok: true });
        });

        this.app.get('/api/runtime-config', (req, res) => {
            res.json({
                ingressPath: req.header('x-ingress-path') || ''
            });
        });

        // OTA binary ausliefern
        this.app.get('/api/ota/:filename', (req, res) => {
            const filename = path.basename(req.params.filename);
            const filePath = path.join(this.otaDir, filename);

            if (!fs.existsSync(filePath)) {
                return res.status(404).json({
                    ok: false,
                    error: `OTA-Datei nicht gefunden: ${filename}`
                });
            }

            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-store');
            res.sendFile(filePath);
        });

        // --- DIAGNOSTIC LOGS ENDPOINTS ---
        this.app.get('/api/diagnostic/unknown-devices', (req, res) => {
            res.json({ summary: this.hub.getDiagnosticSummary() });
        });

        this.app.get('/api/diagnostic/download-join-log/:valveId', (req, res) => {
            const valveId = req.params.valveId.toString();
            const logs = this.hub.unknownDevicesLogs || [];

            const deviceLogs = logs.filter(l => l.valveId.toString() === valveId);
            if (deviceLogs.length === 0) {
                return res.status(404).json({ error: 'Kein Join-Log für dieses Gerät gefunden.' });
            }

            // Erstelle einen Download-String mit allen relevanten Informationen
            const downloadContent = {
                valveId: valveId,
                note: 'Dieses Join-Log wurde automatisch generiert. Es enthält alle aufgezeichneten Pakete für dieses unbekannte Gerät.',
                packets: deviceLogs.map(logEntry => ({
                    timestamp: logEntry.timestamp,
                    gatewayId: logEntry.gatewayId,
                    rssi: logEntry.rssi,
                    cmd: logEntry.cmd,
                    hexPayload: logEntry.hexPayload,
                    rawBytes: logEntry.rawBytes,
                    joinInfo: logEntry.joinInfo,
                    decoded: {
                        payloadLen: logEntry.rawBytes?.[11] || null,
                        cmdByte: logEntry.rawBytes?.[10] || null,
                        seq: logEntry.rawBytes?.[9] || null
                    }
                }))
            };

            const filename = `join-log-valve-${valveId}-${new Date().toISOString().split('T')[0]}.json`;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.json(downloadContent);
        });

        this.app.use(express.static(path.join(__dirname, '../public')));

        this.app.get('/{*splat}', (req, res, next) => {
            if (req.path.startsWith('/socket.io')) return next();
            res.sendFile(path.join(__dirname, '../public/index.html'));
        });
        const broadcastDiagnosticSummary = () => {
            this.io.emit('diagnosticLogs', this.hub.getDiagnosticSummary());
        };

        this.io.on('connection', (socket) => {
            console.log('[Web] Neuer Client verbunden');

            // Initialen Zustand senden
            const allStates = Array.from(this.hub.devices.values()).map((device) => device.getLiveState());
            socket.emit('initialState', allStates);
            socket.emit('pairingState', { enabled: !!this.hub.pairingMode });
            socket.emit('diagnosticLogs', this.hub.getDiagnosticSummary());

            // Aktuellen Config-Zustand pro Kanal direkt mitsenden
            for (const device of this.hub.devices.values()) {
                for (let channelId = 1; channelId <= (device.channelCount || 0); channelId++) {
                    socket.emit('channelConfigState', {
                        valveId: device.valveId,
                        channelId,
                        config: this._serializeChannelConfig(device, channelId)
                    });
                }
            }

            // Gateways Status mitsenden
            const gws = [];
            for (const gw of this.hub.gateways.values()) {
                gws.push({
                    id: gw.id,
                    ip: gw.ip,
                    port: gw.port,
                    isConnected: gw.isConnected,
                    version: gw.lastVersion?.version || null,
                    model: gw.lastVersion?.model || null,
                    lastSeenAt: gw.lastSeenAt,
                    otaUpdate: this.hub.otaManager ? this.hub.otaManager.getUpdateInfo(gw.id) : null
                });
            }
            socket.emit('gatewaysState', gws);

            socket.on('app:ping', (payload, ack) => {
                if (typeof ack === 'function') {
                    ack({
                        ok: true,
                        ts: Date.now(),
                    })
                }
            })

            socket.on('getPairingMode', () => {
                socket.emit('pairingState', { enabled: !!this.hub.pairingMode });
            });

            socket.on('setPairingMode', ({ enabled }) => {
                this.hub.pairingMode = !!enabled;
                this.io.emit('pairingState', { enabled: !!this.hub.pairingMode });
            });

            // --- Gateway & OTA Events ---
            socket.on('getGateways', () => {
                const gws = [];
                for (const gw of this.hub.gateways.values()) {
                    gws.push({
                        id: gw.id,
                        ip: gw.ip,
                        port: gw.port,
                        isConnected: gw.isConnected,
                        version: gw.lastVersion?.version || null,
                        model: gw.lastVersion?.model || null,
                        lastSeenAt: gw.lastSeenAt,
                        otaUpdate: this.hub.otaManager ? this.hub.otaManager.getUpdateInfo(gw.id) : null
                    });
                }
                socket.emit('gatewaysState', gws);
            });



            socket.on('triggerOtaUpdate', ({ gatewayId }) => {
                if (this.hub.otaManager) {
                    const os = require('os');
                    let addonIp = '127.0.0.1';
                    const interfaces = os.networkInterfaces();
                    for (const name of Object.keys(interfaces)) {
                        for (const net of interfaces[name]) {
                            if (net.family === 'IPv4' && !net.internal) {
                                addonIp = net.address;
                                break;
                            }
                        }
                    }

                    const port = process.env.WEB_PORT || 8099;

                    this.hub.otaManager.triggerUpdate(gatewayId, addonIp, port).catch(err => {
                        console.error(`[Web] OTA Fehler: ${err.message}`);
                    });
                }
            });

            // --- Diagnostic Export ---
            socket.on('getDiagnosticLogs', () => {
                socket.emit('diagnosticLogs', this.hub.getDiagnosticSummary());
            });

            socket.on('addManualGateway', ({ ip }) => {
                if (this.hub) {
                    this.hub._addDynamicGateway({
                        id: `manual-${ip.replace(/\./g, '-')}`,
                        ip: ip,
                        port: 8080
                    });
                }
            });

            socket.on('removeManualGateway', ({ id }) => {
                if (this.hub && typeof this.hub._removeDynamicGateway === 'function') {
                    this.hub._removeDynamicGateway(id);
                }
            });

            socket.on('heartbeat', (data, callback) => {
                if (typeof callback === 'function') {
                    callback();
                }
            });

            socket.on('removeDevice', ({ valveId }) => {
                if (this.hub && typeof this.hub.removeDevice === 'function') {
                    this.hub.removeDevice(valveId);
                    
                    // Broadcast updated list
                    const allStates = Array.from(this.hub.devices.values()).map((device) => device.getLiveState());
                    this.io.emit('initialState', allStates);
                }
            });

            socket.on('setValve', async ({ valveId, channelId, state, duration }) => {
                const device = this.hub.devices.get(Number(valveId));
                if (!device) {
                    return socket.emit('commandResult', {
                        ok: false,
                        valveId,
                        channelId,
                        error: 'Gerät nicht gefunden'
                    });
                }

                try {
                    let result = null;

                    if (state === 'ON') {
                        const seconds = Math.max(1, Number(duration) || 600);
                        result = await device.valve(Number(channelId)).on(seconds);
                    } else if (state === 'OFF') {
                        result = await device.valve(Number(channelId)).off();
                    } else {
                        throw new Error('Ungültiger Schaltzustand');
                    }

                    socket.emit('commandResult', {
                        ok: true,
                        valveId,
                        channelId,
                        state,
                        result
                    });
                } catch (err) {
                    socket.emit('commandResult', {
                        ok: false,
                        valveId,
                        channelId,
                        state,
                        error: err.message
                    });
                }
            });

            socket.on('saveChannelConfig', async ({ valveId, channelId, config }) => {
                const device = this.hub.devices.get(Number(valveId));
                if (!device) {
                    return socket.emit('commandResult', {
                        ok: false,
                        valveId,
                        channelId,
                        error: 'Gerät nicht gefunden'
                    });
                }

                try {
                    console.log('[Web] saveChannelConfig empfangen', {
                        valveId,
                        channelId,
                        config
                    });

                    this._applyChannelConfig(device, Number(channelId), config || {});

                    console.log('[Web] saveChannelConfig angewendet', {
                        valveId,
                        channelId,
                        serialized: this._serializeChannelConfig(device, Number(channelId))
                    });

                    await this._triggerDeviceRefresh(device, Number(channelId), 'channel-config');

                    console.log('[Web] saveChannelConfig refresh abgeschlossen', {
                        valveId,
                        channelId
                    });

                    const payload = {
                        valveId: device.valveId,
                        channelId: Number(channelId),
                        config: this._serializeChannelConfig(device, Number(channelId))
                    };

                    this.io.emit('channelConfigState', payload);

                    socket.emit('commandResult', {
                        ok: true,
                        valveId,
                        channelId,
                        action: 'saveChannelConfig'
                    });
                } catch (err) {
                    console.error('[Web] saveChannelConfig Fehler', err);
                    socket.emit('commandResult', {
                        ok: false,
                        valveId,
                        channelId,
                        action: 'saveChannelConfig',
                        error: err.message
                    });
                }
            });

            socket.on('saveSchedules', async ({ valveId, channelId, schedules }) => {
                const device = this.hub.devices.get(Number(valveId));
                if (!device) {
                    return socket.emit('commandResult', {
                        ok: false,
                        valveId,
                        channelId,
                        error: 'Gerät nicht gefunden'
                    });
                }

                try {
                    const channel = this._getChannelOrThrow(device, Number(channelId));

                    const normalizedSchedules = Array.isArray(schedules)
                        ? schedules.map((item) => this._normalizeSchedule(item || {}))
                        : [];

                    channel.schedules = normalizedSchedules;

                    await this._triggerDeviceRefresh(device, Number(channelId), 'schedules-save');

                    this.io.emit('channelConfigState', {
                        valveId: device.valveId,
                        channelId: Number(channelId),
                        config: this._serializeChannelConfig(device, Number(channelId))
                    });

                    socket.emit('commandResult', {
                        ok: true,
                        valveId,
                        channelId,
                        action: 'saveSchedules',
                        count: normalizedSchedules.length
                    });
                } catch (err) {
                    socket.emit('commandResult', {
                        ok: false,
                        valveId,
                        channelId,
                        action: 'saveSchedules',
                        error: err.message
                    });
                }
            });

            socket.on('saveSchedule', async ({ valveId, channelId, schedule }) => {
                const device = this.hub.devices.get(Number(valveId));
                if (!device) {
                    return socket.emit('commandResult', {
                        ok: false,
                        valveId,
                        channelId,
                        error: 'Gerät nicht gefunden'
                    });
                }

                try {
                    const normalizedSchedule = this._normalizeSchedule(schedule || {});
                    const channel = this._getChannelOrThrow(device, Number(channelId));

                    if (!Array.isArray(channel.schedules)) {
                        channel.schedules = [];
                    }

                    const existingIndex = channel.schedules.findIndex((item) => item.id === normalizedSchedule.id);
                    if (existingIndex >= 0) {
                        channel.schedules[existingIndex] = normalizedSchedule;
                    } else {
                        channel.schedules.push(normalizedSchedule);
                    }

                    await this._triggerDeviceRefresh(device, Number(channelId), 'schedule-save');

                    this.io.emit('channelConfigState', {
                        valveId: device.valveId,
                        channelId: Number(channelId),
                        config: this._serializeChannelConfig(device, Number(channelId))
                    });

                    socket.emit('commandResult', {
                        ok: true,
                        valveId,
                        channelId,
                        action: 'saveSchedule',
                        scheduleId: normalizedSchedule.id
                    });
                } catch (err) {
                    socket.emit('commandResult', {
                        ok: false,
                        valveId,
                        channelId,
                        action: 'saveSchedule',
                        error: err.message
                    });
                }
            });

            socket.on('deleteSchedule', async ({ valveId, channelId, scheduleId }) => {
                const device = this.hub.devices.get(Number(valveId));
                if (!device) {
                    return socket.emit('commandResult', {
                        ok: false,
                        valveId,
                        channelId,
                        error: 'Gerät nicht gefunden'
                    });
                }

                try {
                    const channel = this._getChannelOrThrow(device, Number(channelId));
                    const before = Array.isArray(channel.schedules) ? channel.schedules.length : 0;
                    channel.schedules = (channel.schedules || []).filter((item) => item.id !== scheduleId);
                    const after = channel.schedules.length;

                    await this._triggerDeviceRefresh(device, Number(channelId), 'schedule-delete');

                    this.io.emit('channelConfigState', {
                        valveId: device.valveId,
                        channelId: Number(channelId),
                        config: this._serializeChannelConfig(device, Number(channelId))
                    });

                    socket.emit('commandResult', {
                        ok: true,
                        valveId,
                        channelId,
                        action: 'deleteSchedule',
                        removed: before !== after,
                        scheduleId
                    });
                } catch (err) {
                    socket.emit('commandResult', {
                        ok: false,
                        valveId,
                        channelId,
                        action: 'deleteSchedule',
                        error: err.message
                    });
                }
            });

            socket.on('gatewayOta', async ({ gatewayId, filename, url }) => {
                try {
                    if (!gatewayId) {
                        throw new Error('gatewayId fehlt');
                    }

                    const finalUrl = url || this._buildOtaUrl(socket, filename);

                    await this.hub.sendGatewayOta(gatewayId, finalUrl);

                    socket.emit('commandResult', {
                        ok: true,
                        action: 'gatewayOta',
                        gatewayId,
                        url: finalUrl
                    });
                } catch (err) {
                    socket.emit('commandResult', {
                        ok: false,
                        action: 'gatewayOta',
                        gatewayId,
                        error: err.message
                    });
                }
            });
            socket.on('getRawDevicesJson', (payload, ack) => {
                if (typeof ack !== 'function') return;
                try {
                    const filePath = this.hub.deviceStore.filePath;
                    if (fs.existsSync(filePath)) {
                        const raw = fs.readFileSync(filePath, 'utf8');
                        ack({ ok: true, data: raw });
                    } else {
                        ack({ ok: false, error: 'Datei existiert noch nicht' });
                    }
                } catch (err) {
                    ack({ ok: false, error: err.message });
                }
            });

            socket.on('saveRawDevicesJson', (payload, ack) => {
                if (typeof ack !== 'function') return;
                try {
                    const { rawJson } = payload;
                    if (!rawJson) throw new Error('Kein JSON übergeben');

                    // Validierung: Versuche es zu parsen
                    JSON.parse(rawJson);

                    // Speichern
                    fs.writeFileSync(this.hub.deviceStore.filePath, rawJson, 'utf8');
                    
                    ack({ ok: true });

                    console.log('[Web] devices.json manuell aktualisiert. Starte System neu...');
                    setTimeout(() => {
                        process.exit(0);
                    }, 500);
                } catch (err) {
                    console.error('[Web] Fehler beim manuellen Speichern der devices.json:', err.message);
                    ack({ ok: false, error: err.message });
                }
            });
        });

        // Wenn der Hub ein Live-Update feuert, direkt an alle Clients pushen
        this.hub.on('deviceUpdate', (updateData) => {
            this.io.emit('deviceUpdate', updateData.state);
        });

        this.hub.on('gatewayStateUpdate', () => {
            const gws = [];
            for (const gw of this.hub.gateways.values()) {
                gws.push({
                    id: gw.id,
                    ip: gw.ip,
                    port: gw.port,
                    isConnected: gw.isConnected,
                    version: gw.lastVersion?.version || null,
                    model: gw.lastVersion?.model || null,
                    lastSeenAt: gw.lastSeenAt,
                    otaUpdate: this.hub.otaManager ? this.hub.otaManager.getUpdateInfo(gw.id) : null
                });
            }
            this.io.emit('gatewaysState', gws);
        });

        this.hub.on('diagnosticLogsUpdate', broadcastDiagnosticSummary);

        this.server.listen(config.port, '0.0.0.0', () => {
            console.log(`[Web] Frontend läuft auf Port ${config.port}`);
        });
    }

    _getChannelOrThrow(device, channelId) {
        const channel = device?.channels?.[channelId];
        if (!channel) {
            throw new Error(`Kanal ${channelId} existiert nicht.`);
        }

        if (!channel.settings) {
            channel.settings = {
                durationSeconds: 600,
                intervalOnSeconds: 10,
                intervalOffSeconds: 30,
                rainDelayDate: null,
            };
        }

        if (!Array.isArray(channel.schedules)) {
            channel.schedules = [];
        }

        return channel;
    }

    _serializeChannelConfig(device, channelId) {
        const channel = this._getChannelOrThrow(device, channelId);
        const durationSeconds = Math.max(1, Number(channel.settings.durationSeconds) || 600);

        return {
            defaultOpenSeconds: durationSeconds,
            defaultOpenMinutes: Math.max(1, Math.round(durationSeconds / 60)),
            intervalOnSeconds: Math.max(1, Number(channel.settings.intervalOnSeconds) || 10),
            intervalOffSeconds: Math.max(1, Number(channel.settings.intervalOffSeconds) || 30),
            rainStopUntil: channel.settings.rainDelayDate instanceof Date
                ? `${channel.settings.rainDelayDate.getFullYear()}-${String(channel.settings.rainDelayDate.getMonth() + 1).padStart(2, '0')}-${String(channel.settings.rainDelayDate.getDate()).padStart(2, '0')}T${String(channel.settings.rainDelayDate.getHours()).padStart(2, '0')}:${String(channel.settings.rainDelayDate.getMinutes()).padStart(2, '0')}`
                : '',
            schedules: (channel.schedules || []).map((item) => ({ ...item }))
        };
    }

    _applyChannelConfig(device, channelId, config) {
        const channel = this._getChannelOrThrow(device, channelId);

        if (config.defaultOpenSeconds != null || config.defaultOpenMinutes != null) {
            const seconds = config.defaultOpenSeconds != null
                ? Number(config.defaultOpenSeconds)
                : Math.round(Number(config.defaultOpenMinutes) * 60);

            if (!Number.isFinite(seconds) || seconds < 1) {
                throw new Error('Ungültige Standard-Öffnungszeit');
            }

            channel.settings.durationSeconds = Math.min(24 * 60 * 60, Math.round(seconds));
        }

        if (config.intervalOnSeconds != null) {
            const value = Number(config.intervalOnSeconds);
            if (!Number.isFinite(value) || value < 1 || value > 3600) {
                throw new Error('Ungültige Brumisations-Laufzeit');
            }
            channel.settings.intervalOnSeconds = Math.round(value);
        }

        if (config.intervalOffSeconds != null) {
            const value = Number(config.intervalOffSeconds);
            if (!Number.isFinite(value) || value < 1 || value > 3600) {
                throw new Error('Ungültiges Brumisations-Intervall');
            }
            channel.settings.intervalOffSeconds = Math.round(value);
        }

        if (config.rainStopUntil != null) {
            if (!config.rainStopUntil) {
                channel.settings.rainDelayDate = null;
            } else {
                const date = new Date(config.rainStopUntil);
                if (Number.isNaN(date.getTime())) {
                    throw new Error('Ungültiges Datum für Regenstopp');
                }
                channel.settings.rainDelayDate = date;
            }
        }
    }

    async _triggerDeviceRefresh(device, channelId, reason = 'config-change') {
        if (!device || typeof device.sendPingTrigger !== 'function') {
            return;
        }
        console.log(`[Web] Sending config-refresh ping (0x20/03) to valve ${device.valveId} due to ${reason}`);
        const followUps = await device.sendPingTrigger(null, 2, 0x03);
        if (Array.isArray(followUps) && followUps.length > 0) {
            console.log(`[Web] Config refresh triggered on valve ${device.valveId} — device is pulling updated config.`);
        } else {
            console.warn(`[Web] No response to config-refresh ping from valve ${device.valveId}.`);
        }
    }

    _normalizeSchedule(schedule) {
        const mode = schedule.mode === 'mist' ? 'mist' : 'normal';
        const startTime = typeof schedule.startTime === 'string' && /^\d{2}:\d{2}$/.test(schedule.startTime)
            ? schedule.startTime
            : '06:00';

        const durationMinutes = Math.max(1, Math.min(1440, Number(schedule.durationMinutes) || 10));
        const repeat = ['daily', 'odd', 'even', 'custom'].includes(schedule.repeat)
            ? schedule.repeat
            : 'daily';

        let weekdays = [];
        if (repeat === 'custom') {
            weekdays = Array.isArray(schedule.weekdays)
                ? Array.from(new Set(schedule.weekdays.map(Number).filter((day) => day >= 1 && day <= 7))).sort((a, b) => a - b)
                : [];

            if (weekdays.length === 0) {
                throw new Error('Für benutzerdefinierte Wiederholung muss mindestens ein Wochentag gewählt sein.');
            }
        }

        const normalized = {
            id: schedule.id || `plan-${Date.now()}`,
            mode,
            startTime,
            durationMinutes,
            repeat,
            weekdays,
        };

        if (mode === 'mist') {
            const mistOnSeconds = Math.max(1, Math.min(3600, Number(schedule.mistOnSeconds) || 10));
            const mistOffSeconds = Math.max(1, Math.min(3600, Number(schedule.mistOffSeconds) || 30));
            normalized.mistOnSeconds = mistOnSeconds;
            normalized.mistOffSeconds = mistOffSeconds;
        }

        return normalized;
    }

    _inferBaseUrl(socket) {
        const headers = socket?.handshake?.headers || {};
        const proto = (headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
        const host = (headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();

        if (!host) {
            throw new Error('Host für OTA-URL konnte nicht ermittelt werden.');
        }

        return `${proto}://${host}`;
    }

    _buildOtaUrl(socket, filename) {
        const cleanFilename = path.basename(filename);
        const baseUrl = this.otaBaseUrl || this._inferBaseUrl(socket);
        return `${baseUrl}/api/ota/${encodeURIComponent(cleanFilename)}`;
    }

    close() {
        return new Promise((resolve) => {
            try {
                if (this.io) {
                    this.io.close();
                }

                if (this.server) {
                    this.server.close(() => resolve());
                } else {
                    resolve();
                }
            } catch (err) {
                console.error('[Web] Fehler beim Stoppen des Webservers:', err.message);
                resolve();
            }
        });
    }
}

module.exports = WebServer;
