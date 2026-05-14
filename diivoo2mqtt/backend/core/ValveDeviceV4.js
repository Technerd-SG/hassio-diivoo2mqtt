// Datei: ValveDeviceV4.js
const utils = require('./utils');
const EventEmitter = require('events');

class ValveDevice extends EventEmitter {
    static globalPairingCounter = 0x18FC0000; //TODO: maybe bs might be a timestamp

    static TX_PROFILES = Object.freeze({
        SHORT: 'short',
        LONG: 'long',
    });

    static nextGlobalPairingCounter() {
        ValveDevice.globalPairingCounter = (ValveDevice.globalPairingCounter + 1) >>> 0;
        return ValveDevice.globalPairingCounter;
    }

    constructor(valveId, hubId, gatewayServer, options = {}) {
        super();

        this.valveId = valveId;
        this.hubId = hubId;
        this.gateway = gatewayServer;

        this.state = 'OFFLINE';
        this.lastSeen = null;
        this.lastRxSeq = null;
        this.lastRawHex = null;

        this.commandSeq = 0x02;
        this.actionSeq = 0x03;
        this.timeSyncFlagBase = options.timeSyncFlagBase ?? 0xFC;

        // Gateway-/Duplikat-Tracking
        this.recentRxPackets = new Map();
        this.gatewayStats = new Map();

        // Promise-Registry
        this.pendingRequests = new Map(); // Map<seq, {...}>
        this.commandLocks = new Set();

        // Bindung / Routing
        this.isBound = options.isBound ?? false;
        this.deviceAddress = options.deviceAddress ?? null;
        this.channelCode = options.channelCode ?? null;

        // Join-/Bootstrap-Fallback
        this.pendingJoinBootstrap = null

        // Metadaten
        this.model = options.model ?? 'WT-13W';
        this.hardwareId = options.hardwareId ?? null;
        this.channelCount = 0;
        this.lastJoinProposal = null;
        this.lastStatusField1 = null;
        this.lastBatteryText = options.lastBatteryText ?? 'Unbekannt';

        this.trys_refresh_trigger = 0;

        // Kanalstatus
        this.channels = {};
        const initialChannelCount = options.channelCount ?? 4;
        if (initialChannelCount > 0) {
            this.initChannels(initialChannelCount);
        }
    }

    get isOnline() {
        if (!this.lastSeen) return false;
        const offlineThresholdMs = 12 * 60 * 60 * 1000;
        return (Date.now() - this.lastSeen) < offlineThresholdMs;
    }

    valve(index) {
        return {
            on: (seconds = 600) =>
                this._executeCommandWithPromise(index, 'AN', [
                    index,
                    0x02,
                    0x01,
                    seconds & 0xFF,
                    (seconds >> 8) & 0xFF
                ]),
            off: () =>
                this._executeCommandWithPromise(index, 'AUS', [
                    index,
                    0x02,
                    0x00
                ]),
            getStatus: () => this.channels[index] || null,
            addSchedule: (plan) => {
                if (!this.channels[index]) return false;
                this.channels[index].schedules.push(plan);
                return true;
            }
        };
    }

    _executeCommandWithPromise(channelIndex, actionText, payload) {
        const lockKey = `${channelIndex}-${actionText}`;

        return new Promise((resolve, reject) => {
            if (!this.channels[channelIndex]) {
                return reject(new Error(`Kanal ${channelIndex} existiert nicht.`));
            }

            if (this.commandLocks.has(lockKey)) {
                return reject(new Error(`Blockiert: Befehl '${actionText}' wird bereits gesendet!`));
            }

            this.commandLocks.add(lockKey);

            const seq = this.nextActionSeq();

            const cleanup = () => {
                this.commandLocks.delete(lockKey);
                this.pendingRequests.delete(seq);
            };

            const txPolicy = this.getTxPolicy(0x21, {
                reason: 'user-action',
                channelIndex,
                actionText,
                payload,
            });

            const timeoutMs = Number.isInteger(txPolicy.timeoutMs) ? txPolicy.timeoutMs : 8000;

            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error(`Timeout: No response (0xA1 or 0x02) from device for action ${actionText}`));
            }, timeoutMs);

            this.pendingRequests.set(seq, {
                channelIndex,
                actionText,
                expectedRunning: actionText === 'AN',
                resolve: (resultData) => {
                    clearTimeout(timeout);
                    cleanup();
                    resolve(resultData);
                }
            });

            this.sendHubPacket(
                seq,
                0x21,
                payload,
                `Befehl ${actionText}`,
                this.getDownlinkChannel(),
                this.getDownlinkChannel()
            ).catch(err => {
                clearTimeout(timeout);
                cleanup();
                reject(err);
            });
        });
    }

    initChannels(count) {
        this.channelCount = count;
        this.channels = {};

        for (let i = 1; i <= count; i++) {
            this.channels[i] = {
                status: 'AUS',
                isRunning: false,
                remaining: 0,
                runtime: 0,
                sourceByte: 0x00,
                lastSyncTime: null,
                settings: {
                    durationSeconds: 600,
                    intervalOnSeconds: 10,
                    intervalOffSeconds: 30,
                    rainDelayDate: null,
                },
                schedules: []
            };
        }
    }

    handleIncomingPacket(seq, cmd, payload, rawHex = '', gatewayId = 'default_gw', rssi = -100) {
        const now = Date.now();
        this.lastSeen = now;
        this.lastRxSeq = seq;
        this.lastRawHex = rawHex;

        this.gatewayStats.set(gatewayId, { rssi, lastSeen: now });

        for (const [key, timestamp] of this.recentRxPackets.entries()) {
            if (now - timestamp > 5000) {
                this.recentRxPackets.delete(key);
            }
        }

        const packetKey = rawHex
            ? rawHex.toUpperCase()
            : `${utils.toHex(seq)}-${utils.toHex(cmd)}-${payload.map(b => utils.toHex(b)).join('')}`;

        if (this.recentRxPackets.has(packetKey)) {
            return;
        }
        this.recentRxPackets.set(packetKey, now);

        console.log(
            `\n[Device ${this.valveId}] Processing CMD ${utils.toHex(cmd)} (Seq: ${utils.toHex(seq)}) via ${gatewayId} (RSSI: ${rssi}dBm)`
        );

        switch (cmd) {
            case 0x01:
                this.handleJoinAnnounce(seq, payload);
                break;
            case 0x02:
                this.state = 'READY';
                this.handleStatusReport(seq, payload);
                break;
            case 0x04:
                this.handleEventReport(seq, payload);
                break;
            case 0x05:
                console.log(`[Device ${this.valveId}] Parameter request received.`);
                this.handleParameterRequest(seq, payload);
                break;
            case 0x06:
                console.log(`[Device ${this.valveId}] Schedule request received.`);
                this.handleScheduleRequest(seq, payload);
                break;
            case 0xA0:
                console.log(`[Device ${this.valveId}] Simple ACK (0xA0) received`);
                break;
            case 0xA1:
                this.handleActionAck(seq, payload, gatewayId);
                break;
            default:
                console.log(`[Device ${this.valveId}] Ignoring CMD ${utils.toHex(cmd)}`);
                break;
        }
    }

    handleActionAck(seq, payload, gatewayId = null) {
        if (!payload || payload.length < 13) {
            console.log(`[Device ${this.valveId}] Action-ACK (0xA1) too short.`);
            return;
        }

        // payload[0] ist das ACK-Resultat, payload[1] ist das uns bekannte Status-Byte!
        const state = utils.decodeStatusSourceByte(payload[1]);

        // Analog zu 0x02: Restzeit und Zieldauer auslesen
        const remainingSeconds = utils.decodeLittleEndianFromArray(payload, 8, 2);
        const targetSeconds = utils.decodeLittleEndianFromArray(payload, 11, 2);

        console.log(
            `[Device ${this.valveId}] ✅ ACTION-ACK (0xA1) | Status: ${state.stateText} | Remaining: ${remainingSeconds}s`
        );

        const pending = this.pendingRequests.get(seq);
        if (pending) {
            const ch = this.channels[pending.channelIndex];
            if (ch) {
                const now = Date.now();

                ch.status = state.stateText;
                ch.isRunning = state.isRunning;
                ch.remaining = remainingSeconds;
                ch.runtime = targetSeconds;
                ch.sourceByte = state.stateByte;
                ch.sourceText = state.sourceText;
                ch.lastSyncTime = now;
            }

            pending.resolve({
                channelIndex: pending.channelIndex,
                status: state.stateText,
                isRunning: state.isRunning,
                remainingSeconds,
                targetSeconds,
                via: 'action-ack-0xA1'
            });
        }

        this._notifyStateChange('ACTION_ACK_0xA1');

        // WICHTIG: Das Ventil erwartet ein finales 0x82 ACK vom Hub zurück!
        this.sendPostActionAck(gatewayId).catch(err => {
            console.error(`[Device ${this.valveId}] Follow-up ACK 0x82 after action failed: ${err.message}`);
        });
    }

    handleJoinAnnounce(seq, payload) {
        // Nutze deine saubere utils-Funktion zum Parsen
        const joinInfo = utils.parseJoinPacket(payload);

        if (!joinInfo) {
            console.log(`[Device ${this.valveId}] Join request too short or invalid.`);
            return;
        }

        this.lastJoinProposal = joinInfo.suggestedChannelCode;
        this.hardwareId = joinInfo.hardwareId;
        this.model = joinInfo.model;

        // Neue Erkenntnisse speichern (praktisch fürs Debugging im CLI)
        this.firmwareVersion = joinInfo.firmwareByte;
        this.hardwareRevision = joinInfo.revisionByte;

        // Initiiere die richtige Anzahl an Kanälen basierend auf der Hardware-ID
        if (this.channelCount !== joinInfo.channelCount || Object.keys(this.channels).length === 0) {
            this.initChannels(joinInfo.channelCount);
        }

        console.log(
            `[Device ${this.valveId}] Hello/Join received | Model: ${this.model} (FW: v${this.firmwareVersion}) | ` +
            `Channel proposal=${joinInfo.suggestedChannelCode} (channel ${Math.max(0, joinInfo.suggestedChannelCode - 1)})`
        );

        this.processJoinRouting(seq, joinInfo.suggestedChannelCode).catch(err => {
            console.error(`[Device ${this.valveId}] Join routing failed: ${err.message}`);
        });
    }

    handleStatusReport(seq, payload) {
        if (!payload || payload.length < 15) {
            console.log(`[Device ${this.valveId}] Status report too short.`);
            return;
        }

        const channelCode = payload[0];

        if (!Number.isInteger(this.channelCode)) {
            this.channelCode = channelCode;
        }

        const actualChannel = channelCode > 0 ? channelCode - 1 : null;

        // 1. Nutze utils für das Meta-Byte (Batterie & Event)
        const meta = utils.decodeStatusMetaByte(payload[1]);
        this.lastBatteryText = meta.batteryText;
        this.lastStatusField1 = meta.metaByte;

        const rawValveIndex = payload[2];
        const valveIndex = this.normalizeValveIndex(rawValveIndex);

        // 2. Nutze utils für den Status (AN/AUS, Startquelle)
        const state = utils.decodeStatusSourceByte(payload[3]);

        const remainingSeconds = utils.decodeLittleEndianFromArray(payload, 10, 2);
        const runtimeSeconds = utils.decodeLittleEndianFromArray(payload, 13, 2);

        console.log(
            `[Device ${this.valveId}] Status | Channel code=${channelCode} (channel ${actualChannel}) | Valve=${rawValveIndex}` +
            `${valveIndex !== null && valveIndex !== rawValveIndex ? ` -> mapped=${valveIndex}` : ''} | ` +
            `${state.stateText} | Remaining=${remainingSeconds}s | Runtime=${runtimeSeconds}s | Battery=${meta.batteryText}`
        );

        if (valveIndex !== null) {
            if (!this.channels[valveIndex]) {
                this.initChannels(Math.max(this.channelCount || 1, valveIndex));
            }

            const now = Date.now();

            this.channels[valveIndex].status = state.stateText;
            this.channels[valveIndex].isRunning = state.isRunning;
            this.channels[valveIndex].remaining = remainingSeconds;
            this.channels[valveIndex].runtime = runtimeSeconds;
            this.channels[valveIndex].sourceByte = state.stateByte;
            this.channels[valveIndex].sourceText = state.sourceText;
            this.channels[valveIndex].lastSyncTime = now;
        } else {
            console.warn(`[Device ${this.valveId}] Status report with unknown valve index ${rawValveIndex}`);
        }

        // Promises für laufende Aktionen (z.B. user klickt "AN" im CLI) auflösen
        if (valveIndex !== null) {
            for (const [, pending] of this.pendingRequests.entries()) {
                if (pending.channelIndex !== valveIndex) continue;
                if (pending.expectedRunning !== state.isRunning) continue;

                pending.resolve({
                    channelIndex: valveIndex,
                    status: state.stateText,
                    isRunning: state.isRunning,
                    remainingSeconds,
                    targetSeconds: runtimeSeconds,
                    via: 'status-report-0x02'
                });
                break;
            }
        }

        this._notifyStateChange('STATUS_REPORT_0x02');

        // 3. WICHTIG: Dynamische Time-Sync Antwort basierend auf dem echten Event-Code!
        if (meta.eventCode === 6) {
            console.log(`[Device ${this.valveId}] ⏱️ Valve requesting time sync!`);
            this.sendTimeSyncReply(seq).catch(err => console.warn(`[Device ${this.valveId}] Time sync send error: ${err.message}`));
        } else {
            this.sendShortAck(seq).catch(err => console.warn(`[Device ${this.valveId}] ACK send error: ${err.message}`)); // Nutzt unsere neue sendShortAck Methode
        }
    }

    handleEventReport(seq, payload) {
        if (!payload || payload.length < 14) {
            console.log(`[Device ${this.valveId}] Event report (0x04) too short.`);
            return;
        }

        const channelCode = payload[0];
        const rawValveIndex = payload[1];
        const valveIndex = this.normalizeValveIndex(rawValveIndex);
        const eventCode = payload[2];

        // 1. Tuya-Zeitstempel dekodieren
        const t4Raw = utils.decodeLittleEndianFromArray(payload, 3, 4);
        const eventDate = utils.decodeTuya32BitDate(t4Raw);

        // 2. Quelle und Zustand dekodieren
        const state = utils.decodeStatusSourceByte(payload[7]);

        // 3. Sensordaten (Verbrauch & Dauer)
        const waterConsumption = utils.decodeLittleEndianFromArray(payload, 8, 4);
        const elapsedSeconds = utils.decodeLittleEndianFromArray(payload, 12, 2);

        console.log(
            `\n[Device ${this.valveId}] ⚡ EVENT REPORT (0x04) | Valve: ${valveIndex} | Event code: ${utils.toHex(eventCode)}`
        );
        console.log(`    ├─ Timestamp  : ${eventDate ? eventDate.text : 'Invalid'}`);
        console.log(`    ├─ Last state : ${state.stateText} (source: ${state.sourceText})`);
        console.log(`    ├─ Runtime    : ${elapsedSeconds}s`);
        console.log(`    └─ Consumption: ${waterConsumption} ml\n`);

        if (valveIndex !== null && this.channels[valveIndex]) {
            // Historien-Daten im Kanal speichern
            this.channels[valveIndex].lastWaterConsumption = waterConsumption;
            this.channels[valveIndex].lastElapsedSeconds = elapsedSeconds;
            this.channels[valveIndex].lastEventDate = eventDate ? eventDate.text : null;

            // Wenn es ein Stop-Event ist, stellen wir sicher, dass das Ventil intern als AUS markiert ist
            if (eventCode === 0x01) {
                this.channels[valveIndex].status = 'AUS';
                this.channels[valveIndex].isRunning = false;
                this.channels[valveIndex].remaining = 0;
            }
        } else {
            console.warn(`[Device ${this.valveId}] Event for unknown valve: ${rawValveIndex}`);
        }

        this.sendEventAck(seq).catch(err => console.warn(`[Device ${this.valveId}] Event ACK send error: ${err.message}`));
    }

    handleParameterRequest(seq, payload) {
        // Falls das Ventil im payload[1] verrät, für welchen Kanal es Parameter will, 
        // könnten wir das hier auslesen. Wenn nicht, senden wir Standardmäßig für Kanal 1.
        const channelIndex = payload.length > 1 ? this.normalizeValveIndex(payload[1]) || 1 : 1;

        console.log(`\n[Device ${this.valveId}] ⚙️ PARAMETER REQUEST (0x05) for channel ${channelIndex}`);
        this.sendParameterResponse(seq, channelIndex)?.catch(err => console.warn(`[Device ${this.valveId}] Parameter response send error: ${err.message}`));
    }

    handleScheduleRequest(seq, payload) {
        const rawChannelIndex = payload[1];
        const pageRequested = payload[2]; // Welche Seite will das Ventil?
        const valveIndex = this.normalizeValveIndex(rawChannelIndex);

        const schedules = this.channels[valveIndex]?.schedules || [];

        // DYNAMISCH: Wie viele Pläne passen in ein Paket? 
        // Wir nehmen 2, um bei 32-Byte-Frames (inkl. Header) sicher zu gehen.
        const PLANS_PER_PAGE = 2;
        const totalPages = Math.ceil(schedules.length / PLANS_PER_PAGE);

        // Falls keine Pläne da sind oder Seite außerhalb des Bereichs
        if (schedules.length === 0 || pageRequested >= totalPages) {
            console.log("SEND EMTY WATERING SCHEDULE")
            return this.sendEmptyPlanResponse(seq).catch(err => console.warn(`[Device ${this.valveId}] Empty schedule response error: ${err.message}`));
        }

        // Die Pläne für die aktuelle Seite extrahieren
        const start = pageRequested * PLANS_PER_PAGE;
        const end = start + PLANS_PER_PAGE;
        const currentPlans = schedules.slice(start, end);

        // Protokoll-Logik: Wie viele Seiten folgen noch nach dieser?
        const pagesRemaining = (totalPages - 1) - pageRequested;

        // Payload bauen: [PagingByte, Plan1(7B), Plan2(7B), ...]
        const outPayload = [pagesRemaining];
        currentPlans.forEach(plan => {
            const normalizedPlan = utils.normalizeSchedulePlan(plan);
            outPayload.push(...utils.encodePlanBlock(normalizedPlan));
        });

        console.log(`[Device ${this.valveId}] Sending page ${pageRequested}/${totalPages - 1}. ${pagesRemaining} packet(s) following.`);

        console.log('Schedules raw:', schedules);
        console.log('Current plans:', currentPlans);
        console.log('Encoded 0x86 payload:', outPayload.map(utils.toHex).join(' '));

        return this.sendHubPacket(
            seq,
            0x86,
            outPayload,
            `Plans: Pg ${pageRequested}, Rem ${pagesRemaining}`,
            this.getDownlinkChannel(),
            this.getDefaultListenChannel()
        ).catch(err => console.warn(`[Device ${this.valveId}] Schedule response send error: ${err.message}`));
    }

    _uniqueTxChannels(channels) {
        return [...new Set(
            channels.filter(ch => Number.isInteger(ch) && ch >= 0)
        )];
    }

    async sendJoinResponseRedundant(seq, joinParams, txChannels, delayMs = 70) {
        const uniqueChannels = this._uniqueTxChannels(txChannels);

        for (let i = 0; i < uniqueChannels.length; i++) {
            await this.sendJoinResponse(seq, joinParams, uniqueChannels[i], 0);

            if (i < uniqueChannels.length - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }

    processJoinRouting(seq, proposedChannelCode) {
        if (!this.isBound) {
            if (!this.isPairingModeEnabled()) {
                console.log(`[Device ${this.valveId}] Device unknown, gateway not in pairing mode -> no response.`);
                return Promise.resolve();
            }

            if (!Number.isInteger(this.deviceAddress)) {
                this.deviceAddress = this.allocateDeviceAddress();
            }

            if (!Number.isInteger(this.channelCode)) {
                this.channelCode = this.allocateChannelCode(proposedChannelCode);
            }

            this.isBound = true;
            this.state = 'PAIRING';

            console.log(
                `[Device ${this.valveId}] Pairing new device | ` +
                `Address=${this.deviceAddress}, channel code=${this.channelCode}, channel=${this.channelCode - 1}`
            );

            // 1) auf Kanal 4 für echtes Pairing
            // 2) danach auf dem neu zugewiesenen Zielkanal
            return this.sendJoinResponseRedundant(seq, {
                subtype: 0x0A,
                statusByte: 0x01,
                deviceAddress: this.deviceAddress,
                channelCode: this.channelCode,
            }, [
                4,
                this.getDownlinkChannel()
            ]).catch(err => console.warn(`[Device ${this.valveId}] Join response send error: ${err.message}`));
        }

        if (!Number.isInteger(this.deviceAddress)) {
            this.deviceAddress = this.allocateDeviceAddress();
        }

        if (!Number.isInteger(this.channelCode)) {
            this.channelCode = proposedChannelCode;
        }

        const proposedTxChannel = utils.decodeChannelCode(proposedChannelCode).actualChannel;
        const knownTxChannel = this.getDownlinkChannel();
        const needsRestore = proposedChannelCode !== this.channelCode;

        this.state = needsRestore ? 'RESTORE' : 'READY';

        if (needsRestore) {
            console.log(
                `[Device ${this.valveId}] Known device with different channel proposal | ` +
                `Proposed=${proposedChannelCode}, expected=${this.channelCode} -> redundant restore response`
            );
        } else {
            console.log(
                `[Device ${this.valveId}] Known device rejoin | ` +
                `channel proposal=${proposedChannelCode} -> redundant confirmation`
            );
        }

        // 1) Kanal 4 für echten Pairing-Modus
        // 2) vorgeschlagener Kanal
        // 3) bekannter gespeicherter Kanal
        return this.sendJoinResponseRedundant(seq, {
            subtype: 0x00,
            statusByte: 0x02,
            deviceAddress: this.deviceAddress,
            channelCode: this.channelCode,
        }, [
            4,
            proposedTxChannel,
            knownTxChannel
        ]).catch(err => console.warn(`[Device ${this.valveId}] Join-Rejoin Sende-Fehler: ${err.message}`));
    }

    // Device-seitige Funk-Policy
    // Hier gehört die Entscheidung hin, ob short/long gesendet wird.
    getTxPolicy(cmd, context = {}) {
        switch (cmd) {
            case 0x20:
                return {
                    txProfile: ValveDevice.TX_PROFILES.LONG,
                    expectReply: false,
                    waitMs: 0,
                    maxAttempts: 1,
                    retryDelayMs: 0,
                    fallbackToLegacySpam: false,
                    timeoutMs: 3000,
                    refreshTrigger: true,
                    listenWindowMs: 1800,
                };

            case 0x21:
                return {
                    txProfile: ValveDevice.TX_PROFILES.LONG,
                    expectReply: true,
                    waitMs: 350,
                    maxAttempts: 2,
                    retryDelayMs: 120,
                    fallbackToLegacySpam: true,
                    timeoutMs: 8000,
                };

            case 0x81:
            case 0x82:
            case 0x84:
            case 0x85:
            case 0x86:
            default:
                return {
                    txProfile: ValveDevice.TX_PROFILES.SHORT,
                    expectReply: false,
                    waitMs: 220,
                    maxAttempts: 1,
                    retryDelayMs: 0,
                    fallbackToLegacySpam: false,
                    timeoutMs: 4000,
                };
        }
    }

    sendAck(seq) {
        const payload = [0x00, 0x02];
        return this.sendHubPacket(seq, 0x82, payload, 'ACK (0x82)', this.getDownlinkChannel(), 0);
    }

    sendShortAck(seq, contextByte = null) {
        // Nutzt das übergebene Byte, oder das zuletzt gespeicherte, oder Fallback 0x02
        const cb = contextByte ?? this.lastContextByte ?? 0x02;

        // Kurzes ACK ist exakt 2 Bytes lang: [0x00, ContextByte]
        const payload = [0x00, cb];

        return this.sendHubPacket(
            seq,
            0x82,
            payload,
            'Kurzes ACK (0x82)',
            this.getDownlinkChannel(),
            this.getDefaultListenChannel()
        );
    }

    sendPostActionAck(preferredGatewayId = null) {
        const seq = this.nextCommandSeq();
        const payload = [0x00, 0x02];

        return this.sendHubPacket(
            seq,
            0x82,
            payload,
            'ACK nach Action-ACK (0x82)',
            this.getDownlinkChannel(),
            this.getDefaultListenChannel(),
            { preferredGatewayId }
        );
    }

    sendTimeSyncReply(seq, date = new Date(), contextByte = null) {
        const payload = this.encodeTimeSyncPayload(date, contextByte);

        return this.sendHubPacket(
            seq,
            0x82,
            payload,
            'ACK + Zeit-Sync (0x82)',
            this.getDownlinkChannel(),
            this.getDefaultListenChannel()
        );
    }

    sendLongAck(seq, date = new Date()) {
        return this.sendTimeSyncReply(seq, date);
    }

    sendEventAck(seq) {
        const payload = [0x00];
        return this.sendHubPacket(seq, 0x84, payload, 'Event-ACK (0x84)', this.getDownlinkChannel(), this.getDefaultListenChannel());
    }

    sendJoinResponse(seq, { subtype, statusByte, deviceAddress, channelCode }, txChannel = 4, rxChannel = 0) {
        const now = new Date();
        const tuya32Bytes = utils.encodeTuya32BitDate(now);
        const dowIndex = now.getDay();
        const contextByte = statusByte;

        const payload = [
            subtype,
            deviceAddress & 0xFF,
            channelCode & 0xFF,
            0xE0,
            0x01,
            ...tuya32Bytes,
            dowIndex & 0xFF,
            contextByte & 0xFF,
        ];

        const label =
            subtype === 0x0A
                ? 'Join-Antwort / neue Zuweisung (0x81)'
                : 'Join-Antwort / Restore bekannter Bindung (0x81)';

        return this.sendHubPacket(seq, 0x81, payload, label, txChannel, rxChannel);
    }

    sendParameterResponse(seq, channelIndex = 1) {
        // Hole die echten Einstellungen aus dem Speicher des Hubs
        const ch = this.channels[channelIndex];
        if (!ch) {
            console.error(`[!] Parameter response failed: channel ${channelIndex} does not exist.`);
            return;
        }

        const settings = ch.settings;
        const dur = settings.durationSeconds || 600;
        const intOn = settings.intervalOnSeconds || 10;
        const intOff = settings.intervalOffSeconds || 30;
        const rainDelayDate = settings.rainDelayDate; // Muss ein JS-Date-Objekt sein (oder null)

        // Tuya 32-Bit-Datum berechnen (wenn Rain Delay aktiv ist)
        let rainDelayBytes = [0x00, 0x00, 0x00, 0x00];
        if (rainDelayDate instanceof Date && rainDelayDate.getTime() > Date.now()) {
            rainDelayBytes = utils.encodeTuya32BitDate(rainDelayDate);
        }

        const payload = [
            0x00,                           // [0] Sub-Index
            dur & 0xFF, (dur >> 8) & 0xFF,  // [1..2] Dauer (LE16)
            intOn & 0xFF, (intOn >> 8) & 0xFF, // [3..4] Intervall ON (LE16)
            intOff & 0xFF, (intOff >> 8) & 0xFF, // [5..6] Intervall OFF (LE16)
            0x00, 0x00,                     // [7..8] Reserviert
            ...rainDelayBytes,              // [9..12] Rain Delay (Tuya LE32)
            0x00, 0x00                      // [13..14] Reserviert
        ];

        console.log(`    └─ Sending parameters (0x85) | Duration: ${dur}s | IntON: ${intOn}s | IntOFF: ${intOff}s | RainDelay: ${rainDelayDate ? rainDelayDate.toLocaleString() : 'OFF'}`);

        return this.sendHubPacket(
            seq,
            0x85,
            payload,
            `Parameter-Antwort (0x85)`,
            this.getDownlinkChannel(),
            this.getDefaultListenChannel()
        );
    }

    sendEmptyPlanResponse(seq) {
        const payload = [0x00];
        return this.sendHubPacket(seq, 0x86, payload, 'Empty schedule (0x86)', this.getDownlinkChannel(), this.getDefaultListenChannel());
    }

    async sendRefreshTrigger(correlationToken = null) {
        const seq = this.nextCommandSeq();
        const token = correlationToken ?? seq;
        const payload = [token & 0xFF, 0x01]; // Changed from 0x00 to 0x01 to match sendPingTrigger

        console.log(
            `[Device ${this.valveId}] 🔔 Sending wake/refresh trigger (0x20) | token=${utils.toHex(token)}`
        );

        const result = await this.sendHubPacket(
            seq,
            0x20,
            payload,
            'Wake/Refresh Trigger (0x20)',
            this.getDownlinkChannel(),
            this.getDefaultListenChannel(),
            {
                txProfile: ValveDevice.TX_PROFILES.LONG,
                refreshTrigger: true,
                listenWindowMs: 1800,
            }
        );

        if (Array.isArray(result) && result.length > 0) {
            this.trys_refresh_trigger = 0;
            for (const inbound of result) {
                console.log(
                    `[Device ${this.valveId}] ↩ Refresh follow-up packet | cmd=${utils.toHex(inbound.cmd)} seq=${utils.toHex(inbound.seq)}`
                );
            }
        } else {
            console.log(
                `[Device ${this.valveId}] ↩ No follow-up packets after refresh trigger`
            );

            if (this.trys_refresh_trigger < 4) {
                this.trys_refresh_trigger++;
                console.log(
                    `[Device ${this.valveId}] Retransmit ${this.trys_refresh_trigger} of 3`
                );
                return await this.sendRefreshTrigger(correlationToken);
            } else {
                this.trys_refresh_trigger = 0;
            }
        }

        return result;
    }

    async sendPingTrigger(correlationToken = null, maxRetransmits = 2) {
        const token = correlationToken ?? this.nextCommandSeq();

        for (let attempt = 0; attempt <= maxRetransmits; attempt++) {
            const seq = this.nextCommandSeq();
            const payload = [token & 0xff, 0x01];

            if (attempt === 0) {
                console.log(
                    `[Device ${this.valveId}] 📡 Sending targeted ping trigger (0x20) | token=${utils.toHex(token)}`
                );
            } else {
                console.log(
                    `[Device ${this.valveId}] 📡 Retransmit Ping ${attempt} of ${maxRetransmits} | token=${utils.toHex(token)}`
                );
            }

            const result = await this.sendHubPacket(
                seq,
                0x20,
                payload,
                'Wake-Up Ping (0x20)',
                this.getDownlinkChannel(),
                this.getDefaultListenChannel(),
                {
                    txProfile: ValveDevice.TX_PROFILES.LONG,
                    refreshTrigger: true,
                    listenWindowMs: 1800,
                }
            );

            if (Array.isArray(result) && result.length > 0) {
                for (const inbound of result) {
                    console.log(
                        `[Device ${this.valveId}] ↩ Ping follow-up packet | cmd=${utils.toHex(inbound.cmd)} seq=${utils.toHex(inbound.seq)}`
                    );
                }
                return result;
            }

            console.log(
                `[Device ${this.valveId}] ↩ No follow-up packets after ping trigger`
            );
        }

        return [];
    }

    async executeWakeUpPing(attempts = 5, intervalMs = 1000) {
        if (!this.isBound || !Number.isInteger(this.deviceAddress)) {
            console.log(
                `[Device ${this.valveId}] Skipping startup ping, device not fully paired.`
            );
            return false;
        }

        console.log(
            `[Device ${this.valveId}] 🚀 Starting targeted wake-up ping (0x20)...`
        );

        for (let i = 1; i <= attempts; i++) {
            console.log(
                `[Device ${this.valveId}] Wake-up ping attempt ${i}/${attempts}`
            );

            try {
                let followUps = [];
                // Versuche zuerst 0x20
                if (i <= 3) {
                    followUps = await this.sendPingTrigger(0x04, 1);
                } else {
                    // Fallback auf Legacy Broadcast Ping (0x82) wie im alten Code
                    console.log(`[Device ${this.valveId}] 📡 Falling back to legacy TimeSync ping (0x82)`);
                    const payload = [0x0F, 0xFF, 0x26, 0x10, 0x01, 0x07, 0x02];
                    followUps = await this.sendHubPacket(
                        this.nextCommandSeq(),
                        0x82,
                        payload,
                        'Legacy Broadcast Ping (0x82)',
                        this.getDownlinkChannel(),
                        this.getDefaultListenChannel(),
                        {
                            txProfile: ValveDevice.TX_PROFILES.LONG,
                            refreshTrigger: true,
                            listenWindowMs: 2500,
                            forceTargetId: 0x00000000
                        }
                    );
                }

                if (Array.isArray(followUps) && followUps.length > 0) {
                    console.log(
                        `[Device ${this.valveId}] ✅ Successfully woken up! Response received.`
                    );
                    return true;
                }
            } catch (err) {
                console.warn(
                    `[Device ${this.valveId}] Wake-up ping error: ${err.message}`
                );
            }

            if (i < attempts) {
                await new Promise((resolve) => setTimeout(resolve, intervalMs));
            }
        }

        console.log(
            `[Device ${this.valveId}] ❌ Valve did not respond after ${attempts} wake-up ping(s).`
        );
        return false;
    }

    sendTimeSync(date = new Date()) {
        if (!this.isBound || !Number.isInteger(this.channelCode)) {
            console.log(`[Device ${this.valveId}] No time sync: device is not fully bound.`);
            return;
        }

        const seq = this.nextCommandSeq();
        const payload = this.encodeTimeSyncPayload(date);

        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        const ss = String(date.getSeconds()).padStart(2, '0');

        return this.sendHubPacket(
            seq,
            0x82,
            payload,
            `Zeit-Sync ${hh}:${mm}:${ss}`,
            this.getDownlinkChannel(),
            0
        );
    }

    encodeTimeSyncPayload(date = new Date(), contextByte = null) {
        // Wiederverwenden des Kontext-Bytes
        const cb = contextByte ?? this.lastContextByte ?? 0x02;

        // Extra Flags für t5 (oft 0x03 beobachtet)
        const extraFlags = 0x03;

        // Ruft deine neue Funktion aus utils.js auf!
        const timeBlock = utils.encodeTimeBlock6(date, cb, extraFlags);

        // 7-Byte Payload zusammenbauen:
        return [
            0x00,           // [0] ACK-/Status-Byte (immer 0x00)
            timeBlock[0],   // [1] t0 (Context Byte)
            timeBlock[1],   // [2] t1 (Sekunden/Minuten-Bits)
            timeBlock[2],   // [3] t2 (Minuten/Stunden-Bits)
            timeBlock[3],   // [4] t3 (Stunden/Tage/Monats-Bits)
            timeBlock[4],   // [5] t4 (Monats/Jahres-Bits)
            timeBlock[5]    // [6] t5 (Wochentag + Extra Flags)
        ];
    }

    getDownlinkChannel() {
        if (!Number.isInteger(this.channelCode) || this.channelCode <= 0) {
            return 4;
        }
        return this.channelCode - 1;
    }

    nextCommandSeq() {
        const seq = this.commandSeq;
        this.commandSeq = (this.commandSeq + 1) & 0xFF;
        return seq;
    }

    nextActionSeq() {
        const seq = this.actionSeq;
        this.actionSeq = (this.actionSeq + 1) & 0xFF;
        return seq;
    }

    getBestGateways() {
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000;

        return Array.from(this.gatewayStats.entries())
            .filter(([, data]) => (now - data.lastSeen) < maxAge)
            .sort((a, b) => b[1].rssi - a[1].rssi)
            .map(entry => entry[0]);
    }

    sendHubPacket(seq, cmd, payload, label, txChannel = null, rxChannel = 0, options = {}) {
        const packetBytes = utils.buildPacket(this.valveId, this.hubId, seq, cmd, payload);

        while (packetBytes.length < 32) {
            packetBytes.push(0x00);
        }

        if (packetBytes.length > 32) {
            return Promise.reject(
                new Error(`Packet too long for radio frame: ${packetBytes.length} bytes (max 32)`)
            );
        }

        const hexString = utils.bytesToHex(packetBytes);
        const effectiveTxChannel =
            Number.isInteger(txChannel) ? txChannel : this.getDownlinkChannel();

        const candidates = this.getBestGateways();
        const txPolicy = {
            ...this.getTxPolicy(cmd, {
                seq,
                payload,
                label,
                txChannel: effectiveTxChannel,
                rxChannel,
            }),
            ...options,
        };

        console.log(
            `[Device ${this.valveId}] TX seq=${utils.toHex(seq)} | cmd=${utils.toHex(cmd)} | txChannel=${effectiveTxChannel}, RX=${rxChannel}, profile=${txPolicy.txProfile}: ${hexString} | Gateways: [${candidates.join(', ')}]`
        );

        if (typeof this.gateway?.routePacket === 'function') {
            return this.gateway.routePacket(
                hexString,
                effectiveTxChannel,
                rxChannel,
                candidates,
                {
                    targetValveId: this.valveId,
                    preferredGatewayId: txPolicy.preferredGatewayId ?? null,
                    txProfile: txPolicy.txProfile ?? ValveDevice.TX_PROFILES.SHORT,
                    expectReply: !!txPolicy.expectReply,
                    waitMs: txPolicy.waitMs,
                    maxAttempts: txPolicy.maxAttempts,
                    retryDelayMs: txPolicy.retryDelayMs,
                    fallbackToLegacySpam: !!txPolicy.fallbackToLegacySpam,
                    refreshTrigger: !!txPolicy.refreshTrigger,
                    listenWindowMs: txPolicy.listenWindowMs,
                }
            );
        }

        if (typeof this.gateway?.sendOnChannels === 'function') {
            return this.gateway.sendOnChannels(
                hexString,
                effectiveTxChannel,
                rxChannel,
                candidates
            );
        }

        if (typeof this.gateway?.send === 'function') {
            this.gateway.send(hexString);
            return Promise.resolve();
        }

        return Promise.reject(new Error('No valid send function found!'));
    }

    isPairingModeEnabled() {
        if (typeof this.gateway?.isPairingModeEnabled === 'function') {
            return !!this.gateway.isPairingModeEnabled();
        }
        if (typeof this.gateway?.pairingMode === 'boolean') {
            return this.gateway.pairingMode;
        }
        return false;
    }

    allocateDeviceAddress() {
        if (typeof this.gateway?.allocateDeviceAddress === 'function') {
            return this.gateway.allocateDeviceAddress(this);
        }
        return 1;
    }

    allocateChannelCode(proposedChannelCode) {
        if (typeof this.gateway?.allocateChannelCode === 'function') {
            return this.gateway.allocateChannelCode(this, proposedChannelCode);
        }
        return proposedChannelCode;
    }

    nextPairingCounter() {
        if (typeof this.gateway?.nextPairingCounter === 'function') {
            return this.gateway.nextPairingCounter(this);
        }
        return ValveDevice.nextGlobalPairingCounter();
    }

    normalizeValveIndex(rawValveIndex) {
        if (Number.isInteger(rawValveIndex) && rawValveIndex >= 1 && rawValveIndex <= this.channelCount) {
            return rawValveIndex;
        }

        if (rawValveIndex === 0 && this.channelCount === 1) {
            return 1;
        }

        return null;
    }

    getDefaultListenChannel() {
        return 0;
    }

    getLiveState() {
        const now = Date.now();
        const liveChannels = {};

        for (let i = 1; i <= this.channelCount; i++) {
            const ch = this.channels[i];
            if (!ch) continue;

            let currentRemaining = ch.remaining;

            if (ch.isRunning && ch.lastSyncTime) {
                const elapsedSeconds = Math.floor((now - ch.lastSyncTime) / 1000);
                currentRemaining = Math.max(0, ch.remaining - elapsedSeconds);
            }

            const liveIsRunning = ch.isRunning && currentRemaining > 0;
            const liveStatus = liveIsRunning ? ch.status : 'AUS';

            liveChannels[i] = {
                status: liveStatus,
                isRunning: liveIsRunning,
                remainingLive: currentRemaining,
                targetRuntime: ch.runtime,
                source: ch.sourceText,
                lastSync: ch.lastSyncTime ? new Date(ch.lastSyncTime).toISOString() : null
            };
        }

        const gatewaysInfo = {};
        for (const [gwId, stats] of this.gatewayStats.entries()) {
            gatewaysInfo[gwId] = {
                lastSeen: stats.lastSeen,
                rssi: stats.rssi
            };
        }

        let batteryPercent = 0;
        if (this.lastBatteryText.includes('4 Balken')) batteryPercent = 100;
        else if (this.lastBatteryText.includes('3 Balken')) batteryPercent = 75;
        else if (this.lastBatteryText.includes('2 Balken')) batteryPercent = 50;
        else if (this.lastBatteryText.includes('1 Balken')) batteryPercent = 25;

        return {
            valveId: this.valveId,
            model: this.model,
            battery: this.lastBatteryText,
            batteryPercent,
            isOnline: this.isOnline,
            gateways: gatewaysInfo,
            channels: liveChannels
        };
    }

    _notifyStateChange(triggerReason) {
        const liveState = this.getLiveState();

        // Node.js Event auslösen
        this.emit('stateUpdate', {
            valveId: this.valveId,
            reason: triggerReason,
            state: liveState
        });
    }
}

module.exports = ValveDevice;