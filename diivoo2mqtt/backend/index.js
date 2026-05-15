// backend/index.js
const SmartHub = require('./core/hubV6');
const MqttBridge = require('./interfaces/mqttBridge');
const WebServer = require('./interfaces/webServer');

console.log("Starte Diivoo Custom Hub...");

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
        console.log(`Signal ${signal} empfangen, Shutdown läuft bereits...`);
        return;
    }

    isShuttingDown = true;
    console.log(`Empfangenes Signal: ${signal}. Fahre System herunter...`);

    const forceExitTimer = setTimeout(() => {
        console.error('Shutdown Timeout erreicht, beende Prozess hart.');
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
        console.error('Fehler beim Shutdown:', err);
        process.exit(1);
    }
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));