// virtual_gateway.js
//
// Reads the serial debug output from the original DIIVOO gateway and exposes
// it over TCP in the same style as the ESP32 bridge.
//
// Goal:
// - g_pRxBuffer -> RX:<HEX>
// - g_pTxBuffer -> TXLOG:<HEX>
//
// Optional:
// - Fake ACK for TUNE: and TX: commands from the app so that existing tools
//   and parsers do not hang waiting for a response.
//
// Requirements:
//   npm install serialport @serialport/parser-readline
//

const fs = require('fs');
const net = require('net');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// --- CONFIGURATION ---
//const SERIAL_PORT = '/dev/ttyACM0';
const SERIAL_PORT = '/dev/ttyUSB0';
//const SERIAL_PORT = 'COM5';
const BAUD_RATE = 460800;

const TCP_HOST = '0.0.0.0';
const TCP_PORT = 4515;

const LOG_TO_FILE = true;
const LOG_FILE = './virtual_gateway_raw.log';

// When true, the virtual gateway ACKs TUNE/TX commands from the app without
// actually transmitting anything over RF.
const FAKE_ACK_FOR_APP_COMMANDS = true;

// When true, TX buffers from the original gateway are also forwarded to TCP
// clients so the bridge can decode packets sent by the original hub as well.
const FORWARD_ORIGINAL_TX = true;

// --- STATE ---
const tcpClients = new Set();
let logStream = null;

// --- LOGFILE ---
if (LOG_TO_FILE) {
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  logStream.write(`\n\n===== START ${new Date().toISOString()} =====\n`);
}

// --- HELPER FUNCTIONS ---
function ts() {
  return new Date().toISOString();
}

function normalizeHexArray(hexValues) {
  return hexValues
    .map(h => String(h).trim())
    .filter(Boolean)
    .map(h => h.padStart(2, '0').toUpperCase());
}

function hexArrayToCompactString(hexValues) {
  return normalizeHexArray(hexValues).join('');
}

function broadcastLine(line) {
  const payload = `${line}\n`;
  for (const client of tcpClients) {
    if (!client.destroyed) {
      client.write(payload);
    }
  }
}

function consoleLog(msg) {
  console.log(msg);
  if (logStream) {
    logStream.write(`[${ts()}] ${msg}\n`);
  }
}

function processRxData(hexValues) {
  const hex = hexArrayToCompactString(hexValues);
  consoleLog(`[SERIAL][RX] ${hex}`);
  broadcastLine(`ORIG_RX:${hex}`);
}

function processTxData(hexValues) {
  const hex = hexArrayToCompactString(hexValues);
  consoleLog(`[SERIAL][TX] ${hex}`);

  if (FORWARD_ORIGINAL_TX) {
    // Use a separate prefix so the app can distinguish original gateway TX packets.
    // If the app ignores unknown prefixes this will not interfere.
    broadcastLine(`ORIG_TX:${hex}`);
  }
}

function handleAppCommand(socket, line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  consoleLog(`[APP->VGW] ${trimmed}`);

  if (!FAKE_ACK_FOR_APP_COMMANDS) {
    socket.write(`ERR:VIRTUAL_GATEWAY_READ_ONLY\n`);
    return;
  }

  if (trimmed.startsWith('TUNE:')) {
    socket.write(`ACK:TUNED\n`);
    return;
  }

  if (trimmed.startsWith('TX:')) {
    // Optional: you could log the requested TX packet here.
    socket.write(`ACK:TX_OK\n`);
    return;
  }

  socket.write(`ERR:UNKNOWN_COMMAND\n`);
}

// --- SERIAL SETUP ---
consoleLog(`Opening serial port ${SERIAL_PORT} @ ${BAUD_RATE}...`);

const port = new SerialPort(
  {
    path: SERIAL_PORT,
    baudRate: BAUD_RATE,
  },
  (err) => {
    if (err) {
      console.error(`Error opening ${SERIAL_PORT}: ${err.message}`);
      process.exit(1);
    }
  }
);

// Optionally log raw data
port.on('data', (chunk) => {
  if (logStream) {
    logStream.write(chunk);
  }
});

// Line parser
const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

parser.on('data', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  // RX from original gateway
  if (trimmed.includes('g_pRxBuffer:')) {
    const match = trimmed.match(/g_pRxBuffer:((?:[0-9a-fA-F]{2},?)+),,g_nRxLength/);
    if (match && match[1]) {
      const hexValues = match[1].split(',').filter(Boolean);
      processRxData(hexValues);
    }
    return;
  }

  // TX from original gateway
  if (trimmed.includes('g_pTxBuffer:')) {
    const match = trimmed.match(/g_pTxBuffer:((?:[0-9a-fA-F]{2},?)+),,g_nTxLength/);
    if (match && match[1]) {
      const hexValues = match[1].split(',').filter(Boolean);
      processTxData(hexValues);
    }
    return;
  }

  // Optionally forward other debug lines to TCP clients
  // If you want this, enable the line below:
  // broadcastLine(`DBG:${trimmed}`);
});

port.on('open', () => {
  consoleLog(`Serial connection on ${SERIAL_PORT} opened.`);
});

port.on('error', (err) => {
  console.error(`[SERIAL] Error: ${err.message}`);
});

port.on('close', () => {
  consoleLog(`Serial connection closed.`);
  if (logStream) logStream.end();
});

// --- TCP SERVER ---
const server = net.createServer((socket) => {
  tcpClients.add(socket);

  consoleLog(`[TCP] Client connected: ${socket.remoteAddress}:${socket.remotePort}`);
  socket.write(`ACK:CONNECTED_VIRTUAL_GATEWAY\n`);

  let tcpBuffer = '';

  socket.on('data', (data) => {
    tcpBuffer += data.toString('utf8');

    while (true) {
      const idx = tcpBuffer.indexOf('\n');
      if (idx === -1) break;

      const line = tcpBuffer.slice(0, idx);
      tcpBuffer = tcpBuffer.slice(idx + 1);

      handleAppCommand(socket, line);
    }
  });

  socket.on('close', () => {
    tcpClients.delete(socket);
    consoleLog(`[TCP] Client disconnected: ${socket.remoteAddress}:${socket.remotePort}`);
  });

  socket.on('error', (err) => {
    tcpClients.delete(socket);
    consoleLog(`[TCP] Error: ${err.message}`);
  });
});

server.listen(TCP_PORT, TCP_HOST, () => {
  consoleLog(`[TCP] Virtual gateway listening on ${TCP_HOST}:${TCP_PORT}`);
});
