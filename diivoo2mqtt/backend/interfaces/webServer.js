const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const MAX_PROTOCOL_DURATION_SECONDS = 0xFFFF;
const MAX_PROTOCOL_DURATION_MINUTES = Math.floor(MAX_PROTOCOL_DURATION_SECONDS / 60);

class WebServer {
    constructor(hub, config) {
        this.hub = hub;
        this.app = express();
        this.server = http.createServer(this.app);

        this.port = config.port;
        this.otaDir = config.otaDir || this.hub.otaManager?.otaDir || path.join(__dirname, '../public/ota');
        this.otaBaseUrl = (config.otaBaseUrl || process.env.OTA_BASE_URL || '').replace(/\/+$/, '');

        const isDev = process.env.NODE_ENV !== 'production';

        this.io = new Server(this.server, isDev ? {
            cors: {
                origin: 'http://localhost:5173',
                methods: ['GET', 'POST']
            }
        } : {});

        this.app.get('/health', (_req, res) => {
            res.json({ status: 'ok', timestamp: Date.now() });
        });

        this.app.get('/api/health', (_req, res) => {
            res.json({ status: 'ok', timestamp: Date.now() });
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
                    error: `OTA file not found: ${filename}`
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

        this.app.delete('/api/diagnostic/unknown-devices/:valveId', (req, res) => {
            const valveId = req.params.valveId.toString();
            this.hub.dismissDiagnosticLog(valveId);
            res.json({ ok: true });
        });

        this.app.get('/api/diagnostic/download-join-log/:valveId', (req, res) => {
            const valveId = req.params.valveId.toString();
            const logs = this.hub.unknownDevicesLogs || [];

            const deviceLogs = logs.filter(l => l.valveId.toString() === valveId);
            if (deviceLogs.length === 0) {
                return res.status(404).json({ error: 'No join log found for this device.' });
            }

            // Erstelle einen Download-String mit allen relevanten Informationen
            const downloadContent = {
                valveId: valveId,
                note: 'This join log was automatically generated. It contains all recorded packets for this unknown device.',
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
            console.log('[Web] New client connected');

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
            socket.emit(
                'gatewaysState',
                Array.from(this.hub.gateways.values()).map((gateway) => this._serializeGateway(gateway))
            );

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
                socket.emit(
                    'gatewaysState',
                    Array.from(this.hub.gateways.values()).map((gateway) => this._serializeGateway(gateway))
                );
            });



            socket.on('triggerOtaUpdate', ({ gatewayId }) => {
                if (this.hub.otaManager) {
                    this.hub.otaManager.triggerUpdate(gatewayId).catch(err => {
                        console.error(`[Web] OTA error: ${err.message}`);
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

            const removeGateway = ({ id }) => {
                if (this.hub && typeof this.hub._removeDynamicGateway === 'function') {
                    this.hub._removeDynamicGateway(id);
                }
            };
            socket.on('removeGateway', removeGateway);
            socket.on('removeManualGateway', removeGateway); // Backward compatibility for older frontends.

            socket.on('renameGateway', ({ gatewayId, alias }, ack) => {
                try {
                    const ok = this.hub.renameGateway(gatewayId, alias);
                    const result = ok
                        ? { ok: true, gatewayId, alias: this.hub.getGateway(gatewayId)?.alias || null }
                        : { ok: false, gatewayId, error: 'Gateway not found' };
                    if (typeof ack === 'function') ack(result);
                } catch (err) {
                    if (typeof ack === 'function') ack({ ok: false, gatewayId, error: err.message });
                }
            });

            socket.on('gatewaySetLed', async ({ gatewayId, state }, ack) => {
                try {
                    const normalizedState = String(state || '').toUpperCase();
                    if (!['ON', 'OFF'].includes(normalizedState)) throw new Error('Invalid LED state');
                    await this.hub.setGatewayLed(gatewayId, normalizedState === 'ON');
                    if (typeof ack === 'function') ack({ ok: true, gatewayId, state: normalizedState });
                } catch (err) {
                    console.error(`[Web] LED command failed (${gatewayId}): ${err.message}`);
                    if (typeof ack === 'function') ack({ ok: false, gatewayId, error: err.message });
                }
            });

            socket.on('gatewayPortal', async ({ gatewayId }, ack) => {
                try {
                    await this.hub.startGatewayPortal(gatewayId);
                    if (typeof ack === 'function') ack({ ok: true, gatewayId });
                } catch (err) {
                    console.error(`[Web] Portal command failed (${gatewayId}): ${err.message}`);
                    if (typeof ack === 'function') ack({ ok: false, gatewayId, error: err.message });
                }
            });

            socket.on('gatewayClearWifi', async ({ gatewayId }, ack) => {
                try {
                    await this.hub.clearGatewayWifi(gatewayId);
                    if (typeof ack === 'function') ack({ ok: true, gatewayId });
                } catch (err) {
                    console.error(`[Web] Clear WiFi command failed (${gatewayId}): ${err.message}`);
                    if (typeof ack === 'function') ack({ ok: false, gatewayId, error: err.message });
                }
            });

            socket.on('gatewayRefreshVersion', async ({ gatewayId }, ack) => {
                try {
                    const version = await this.hub.getGatewayVersion(gatewayId);
                    console.log(
                        `[Web] Gateway ${gatewayId} firmware version refreshed: ${version?.version || 'unknown'}`
                    );
                    if (typeof ack === 'function') ack({ ok: true, gatewayId, version });
                } catch (err) {
                    console.error(`[Web] Version refresh failed (${gatewayId}): ${err.message}`);
                    if (typeof ack === 'function') ack({ ok: false, gatewayId, error: err.message });
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

            socket.on('renameDevice', ({ valveId, alias }) => {
                if (!this.hub || typeof this.hub.renameDevice !== 'function') return;
                const ok = this.hub.renameDevice(valveId, alias);
                if (ok) {
                    const allStates = Array.from(this.hub.devices.values()).map((device) => device.getLiveState());
                    this.io.emit('initialState', allStates);
                }
                socket.emit('commandResult', { ok, valveId, action: 'renameDevice' });
            });

            socket.on('setValve', async ({ valveId, channelId, state, duration }) => {
                const device = this.hub.devices.get(Number(valveId));
                if (!device) {
                    return socket.emit('commandResult', {
                        ok: false,
                        valveId,
                        channelId,
                        error: 'Device not found'
                    });
                }

                try {
                    let result = null;

                    if (state === 'ON') {
                        const channel = this._getChannelOrThrow(device, Number(channelId));
                        const requestedDuration = Number(duration);
                        const defaultDuration = Number(channel.settings.durationSeconds);
                        const seconds = Number.isFinite(requestedDuration) && requestedDuration > 0
                            ? Math.min(MAX_PROTOCOL_DURATION_SECONDS, Math.round(requestedDuration))
                            : Math.min(
                                MAX_PROTOCOL_DURATION_SECONDS,
                                Math.max(1, Number.isFinite(defaultDuration) ? Math.round(defaultDuration) : 600)
                            );
                        result = await device.valve(Number(channelId)).on(seconds);
                    } else if (state === 'OFF') {
                        result = await device.valve(Number(channelId)).off();
                    } else {
                        throw new Error('Invalid valve state');
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
                        error: 'Device not found'
                    });
                }

                try {
                    console.log('[Web] saveChannelConfig received', {
                        valveId,
                        channelId,
                        config
                    });

                    this._applyChannelConfig(device, Number(channelId), config || {});

                    device._notifyStateChange('channel-config-updated');

                    console.log('[Web] saveChannelConfig applied', {
                        valveId,
                        channelId,
                        serialized: this._serializeChannelConfig(device, Number(channelId))
                    });

                    await this._triggerDeviceRefresh(device, Number(channelId), 'channel-config');

                    console.log('[Web] saveChannelConfig refresh complete', {
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
                    console.error('[Web] saveChannelConfig error', err);
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
                        error: 'Device not found'
                    });
                }

                try {
                    const channel = this._getChannelOrThrow(device, Number(channelId));

                    const normalizedSchedules = Array.isArray(schedules)
                        ? schedules.map((item) => this._normalizeSchedule(item || {}))
                        : [];

                    channel.schedules = normalizedSchedules;
                    this.hub.deviceStore.save(this.hub.devices);

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
                        error: 'Device not found'
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
                    this.hub.deviceStore.save(this.hub.devices);

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
                        error: 'Device not found'
                    });
                }

                try {
                    const channel = this._getChannelOrThrow(device, Number(channelId));
                    const before = Array.isArray(channel.schedules) ? channel.schedules.length : 0;
                    channel.schedules = (channel.schedules || []).filter((item) => item.id !== scheduleId);
                    const after = channel.schedules.length;
                    this.hub.deviceStore.save(this.hub.devices);

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
                        throw new Error('gatewayId missing');
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
                        ack({ ok: false, error: 'File does not exist yet' });
                    }
                } catch (err) {
                    ack({ ok: false, error: err.message });
                }
            });

            socket.on('saveRawDevicesJson', (payload, ack) => {
                if (typeof ack !== 'function') return;
                try {
                    const { rawJson } = payload;
                    if (!rawJson) throw new Error('No JSON provided');

                    const parsed = JSON.parse(rawJson);
                    const devices = Array.isArray(parsed) ? parsed : parsed?.devices;
                    if (!Array.isArray(devices)) {
                        throw new Error('Expected a device array or an object containing a devices array');
                    }
                    if (parsed && !Array.isArray(parsed) && parsed.hubId != null) {
                        const hubId = Number(parsed.hubId);
                        if (!Number.isInteger(hubId) || hubId < 0 || hubId > 0xFFFFFFFF) {
                            throw new Error('Invalid hubId');
                        }
                    }

                    // Speichern
                    fs.writeFileSync(this.hub.deviceStore.filePath, rawJson, 'utf8');
                    
                    ack({ ok: true });

                    console.log('[Web] devices.json updated manually. Restarting system...');
                    setTimeout(() => {
                        process.exit(0);
                    }, 500);
                } catch (err) {
                    console.error('[Web] Error saving devices.json manually:', err.message);
                    ack({ ok: false, error: err.message });
                }
            });
        });

        // Wenn der Hub ein Live-Update feuert, direkt an alle Clients pushen
        this.hub.on('deviceUpdate', (updateData) => {
            this.io.emit('deviceUpdate', updateData.state);
        });

        this.hub.on('configSyncState', (state) => {
            this.io.emit('configSyncState', state);
        });

        this.hub.on('gatewayStateUpdate', () => {
            this.io.emit(
                'gatewaysState',
                Array.from(this.hub.gateways.values()).map((gateway) => this._serializeGateway(gateway))
            );
        });

        this.hub.on('diagnosticLogsUpdate', broadcastDiagnosticSummary);

        this.server.listen(this.port, '0.0.0.0', () => {
            console.log(`[Web] Frontend running on port ${this.port}`);
        });
    }

    _serializeGateway(gateway) {
        return {
            id: gateway.id,
            alias: gateway.alias || null,
            ip: gateway.ip,
            port: gateway.port,
            isConnected: gateway.isConnected,
            ledState: gateway.ledState || 'OFF',
            buttonPressed: !!gateway.buttonPressed,
            version: gateway.lastVersion?.version || null,
            model: gateway.lastVersion?.model || null,
            mac: gateway.lastVersion?.mac || null,
            lastSeenAt: gateway.lastSeenAt,
            otaUpdate: this.hub.otaManager ? this.hub.otaManager.getUpdateInfo(gateway.id) : null,
        };
    }

    _getChannelOrThrow(device, channelId) {
        const channel = device?.channels?.[channelId];
        if (!channel) {
            throw new Error(`Channel ${channelId} does not exist.`);
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
        const rawDurationSeconds = Number(channel.settings.durationSeconds);
        const durationSeconds = Math.min(
            MAX_PROTOCOL_DURATION_SECONDS,
            Math.max(1, Number.isFinite(rawDurationSeconds) ? Math.round(rawDurationSeconds) : 600)
        );

        return {
            displayName: typeof channel.displayName === 'string' ? channel.displayName : '',
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

        if (Object.prototype.hasOwnProperty.call(config, 'displayName')) {
            const displayName = config.displayName == null ? '' : String(config.displayName).trim();
            if (displayName.length > 80) {
                throw new Error('Valve name must be at most 80 characters.');
            }
            channel.displayName = displayName;
        }

        if (config.defaultOpenSeconds != null || config.defaultOpenMinutes != null) {
            const seconds = config.defaultOpenSeconds != null
                ? Number(config.defaultOpenSeconds)
                : Math.round(Number(config.defaultOpenMinutes) * 60);

            if (!Number.isFinite(seconds) || seconds < 1) {
                throw new Error('Invalid default open duration');
            }

            channel.settings.durationSeconds = Math.min(MAX_PROTOCOL_DURATION_SECONDS, Math.round(seconds));
        }

        if (config.intervalOnSeconds != null) {
            const value = Number(config.intervalOnSeconds);
            if (!Number.isFinite(value) || value < 1 || value > 3600) {
                throw new Error('Invalid misting on-time');
            }
            channel.settings.intervalOnSeconds = Math.round(value);
        }

        if (config.intervalOffSeconds != null) {
            const value = Number(config.intervalOffSeconds);
            if (!Number.isFinite(value) || value < 1 || value > 3600) {
                throw new Error('Invalid misting off-interval');
            }
            channel.settings.intervalOffSeconds = Math.round(value);
        }

        if (config.rainStopUntil != null) {
            if (!config.rainStopUntil) {
                channel.settings.rainDelayDate = null;
            } else {
                const date = new Date(config.rainStopUntil);
                if (Number.isNaN(date.getTime())) {
                    throw new Error('Invalid date for rain stop');
                }
                channel.settings.rainDelayDate = date;
            }
        }
    }

    async _triggerDeviceRefresh(device, channelId, reason = 'config-change') {
        if (!device) return;

        console.log(`[Web] Queueing config-refresh ping (0x20/03) for valve ${device.valveId}, channel ${channelId} due to ${reason}`);
        const followUps = typeof device.queueConfigRefresh === 'function'
            ? await device.queueConfigRefresh(reason)
            : await device.sendPingTrigger(null, 2, 0x03);
        if (Array.isArray(followUps) && followUps.length > 0) {
            console.log(`[Web] Config refresh triggered on valve ${device.valveId} - device is pulling updated config.`);
        } else {
            console.warn(`[Web] No response to config-refresh ping from valve ${device.valveId}.`);
        }
    }

    _normalizeSchedule(schedule) {
        const mode = schedule.mode === 'mist' ? 'mist' : 'normal';
        const startMatch = typeof schedule.startTime === 'string'
            ? schedule.startTime.match(/^(\d{2}):(\d{2})$/)
            : null;
        const startTime = startMatch && Number(startMatch[1]) <= 23 && Number(startMatch[2]) <= 59
            ? schedule.startTime
            : '06:00';

        const rawDurationMinutes = Number(schedule.durationMinutes);
        const durationMinutes = Math.max(
            1,
            Math.min(
                MAX_PROTOCOL_DURATION_MINUTES,
                Number.isFinite(rawDurationMinutes) ? Math.round(rawDurationMinutes) : 10
            )
        );
        const repeat = ['daily', 'odd', 'even', 'custom'].includes(schedule.repeat)
            ? schedule.repeat
            : 'daily';

        let weekdays = [];
        if (repeat === 'custom') {
            weekdays = Array.isArray(schedule.weekdays)
                ? Array.from(new Set(schedule.weekdays.map(Number).filter((day) => day >= 1 && day <= 7))).sort((a, b) => a - b)
                : [];

            if (weekdays.length === 0) {
                throw new Error('At least one weekday must be selected for a custom repeat schedule.');
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
            throw new Error('Could not determine host for OTA URL.');
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
                console.error('[Web] Error stopping web server:', err.message);
                resolve();
            }
        });
    }
}

module.exports = WebServer;
