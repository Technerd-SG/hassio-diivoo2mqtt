// backend/index.js
['log', 'warn', 'error'].forEach((method) => {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const ts = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        orig(`[${ts}]`, ...args);
    };
});

const SmartHub = require('./core/hubV6');
const MqttBridge = require('./interfaces/mqttBridge');
const WebServer = require('./interfaces/webServer');

console.log("Starting Diivoo Custom Hub...");

const myHubConfig = {
    id: 16926055,
    features: {
        idleTxChannel: 4,
        idleRxChannel: 0,
        idleProfile: 'short',
        defaultTuneDelayMs: 15,
        defaultInboundWaitMs: 220,
        defaultActionWaitMs: 350,
        defaultActionMaxAttempts: 2,
        defaultActionRetryDelayMs: 120,
    }
};

const myGateways = [];

const hub = new SmartHub(myHubConfig, myGateways);

const mqttBridge = new MqttBridge(hub, {
    brokerUrl: process.env.MQTT_BROKER || 'mqtt://127.0.0.1:1883',
    username: process.env.MQTT_USER || '',
    password: process.env.MQTT_PASSWORD || '',
    language: process.env.MQTT_LANG || 'en'
});

const webServer = new WebServer(hub, {
    port: Number(process.env.WEB_PORT || 8099)
});

let isShuttingDown = false;

async function shutdown(signal) {
    if (isShuttingDown) {
        console.log(`Signal ${signal} received, shutdown already in progress...`);
        return;
    }

    isShuttingDown = true;
    console.log(`Signal ${signal} received. Shutting down...`);

    const forceExitTimer = setTimeout(() => {
        console.error('Shutdown timeout reached, forcing exit.');
        process.exit(1);
    }, 5000);

    try {
        if (typeof hub.shutdown === 'function') {
            await hub.shutdown();
        }

        if (webServer && typeof webServer.close === 'function') {
            await webServer.close();
        }

        if (mqttBridge?.client) {
            await new Promise((resolve) => {
                mqttBridge.client.end(true, {}, resolve);
            });
        }

        clearTimeout(forceExitTimer);
        process.exit(0);
    } catch (err) {
        clearTimeout(forceExitTimer);
        console.error('Error during shutdown:', err);
        process.exit(1);
    }
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));