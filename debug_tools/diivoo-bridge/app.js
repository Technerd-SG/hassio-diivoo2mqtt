const net = require('net');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// --- DECODER REGISTRY ---
const decoders = {};
const decodersPath = path.join(__dirname, 'decoders');

if (fs.existsSync(decodersPath)) {
  const files = fs.readdirSync(decodersPath).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const cmdHex = file.replace('.js', '').toLowerCase(); // Turns "0x21.js" -> "0x21"
    decoders[cmdHex] = require(path.join(decodersPath, file));
  }
  console.log(`[+] ${Object.keys(decoders).length} payload decoder(s) loaded.`);
} else {
  console.log('[!] Folder "decoders" not found. Create it for modular parsing.');
}

// --- CONFIGURATION ---
//const ESP32_IP = '10.0.0.123'; // <-- YOUR IP HERE
const ESP32_IP = '127.0.0.1'; // <-- YOUR IP HERE
//const ESP32_PORT = 8080;
const ESP32_PORT = 4515;

// Global state
let seqCounter = 0x01;
let currentTx = 0;
let currentRx = 1; // 1 = we simulate valve, listening to hub
let tcpLineBuffer = '';

// --- PROTOCOL DICTIONARIES ---

// What the valve sends to the hub
const STATUS_RX = {
  0x01: 'Pairing request / Join-Request',
  0x02: 'Status report',
  0x04: 'Delayed report / event report',
  0x05: 'Parameter request',
  0x06: 'Schedule request',
  0x20: 'Parameter update?',   // still uncertain / not yet clearly proven
  0xA0: 'ACK (simple)?',       // not yet well proven
  0xA1: 'ACK + Status',
};

// What the hub sends to the valve
const STATUS_TX = {
  0x20: 'Wake-Up Ping',
  0x21: 'Action / control command',
  0x81: 'Pairing response / Bind-Restore',
  0x82: 'ACK / Time-Sync',
  0x84: 'ACK event report',
  0x85: 'Parameter response',
  0x86: 'Schedule response',
};

const VALVE_STATE = {
  0x00: 'Off',
  0x11: 'On (issued_device)',
  0x21: 'On (issued_base)',
  0x41: 'On (issued_irrigation_plan)',
};

const MODES = ['EVERY_DAY', 'ODD_DATES', 'EVEN_DATES', 'CUSTOM_DAYS'];
const DAY_BITS = {
  SUN: 1,
  MON: 2,
  TUE: 4,
  WED: 8,
  THU: 16,
  FRI: 32,
  SAT: 64,
};

// --- HELPER FUNCTIONS ---
const utils = require('./utils');

function toHex(byte) {
  return `0x${Number(byte).toString(16).padStart(2, '0').toUpperCase()}`;
}

function bytesToHex(bytes) {
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function decodeId(bytes, startIndex) {
  const idBytes = bytes.slice(startIndex, startIndex + 4).reverse();
  const hexStr = idBytes.map(b => b.toString(16).padStart(2, '0')).join('');
  return parseInt(hexStr, 16);
}

function decodeLittleEndian(bytes, startIndex, len) {
  const part = bytes.slice(startIndex, startIndex + len).reverse();
  const hexStr = part.map(b => b.toString(16).padStart(2, '0')).join('');
  return parseInt(hexStr, 16);
}

function decodeLittleEndianFromArray(byteArray) {
  const reversed = [...byteArray].reverse();
  const hexStr = reversed.map(b => b.toString(16).padStart(2, '0')).join('');
  return parseInt(hexStr, 16);
}

function secondsToHHMMSS(seconds) {
  const total = Number(seconds);
  if (Number.isNaN(total) || total < 0) return '00:00:00';

  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
/*
//is done by rf chip can be removed later!
function verifyChecksum(bytes) {
  if (bytes.length < 4) return { valid: false, msg: 'Too short' };

  const actual = bytes[bytes.length - 1];
  let sum = 0;
  for (let i = 0; i < bytes.length - 1; i++) sum += bytes[i];

  const algoTx = (sum - 0x24) & 0xff;
  const algoRx = sum & 0xff;

  if (actual === algoTx) return { valid: true, algorithm: 'TX', msg: `MATCH (TX-Algo ${toHex(algoTx)})` };
  if (actual === algoRx) return { valid: true, algorithm: 'RX', msg: `MATCH (RX-Algo ${toHex(algoRx)})` };

  return {
    valid: false,
    algorithm: null,
    msg: `MISMATCH! Got: ${toHex(actual)} | TX: ${toHex(algoTx)} | RX: ${toHex(algoRx)}`,
  };
}
*/

//is done by rf chip can be removed later!
function verifyChecksum(bytes) {
  // CURRENTLY DISABLED: old formula was wrong.
  // Ignoring the last byte for now.
  const actual = bytes[bytes.length - 1];
  return { 
    valid: true, 
    algorithm: 'IGNORE', 
    msg: `Ignored (actual value: ${toHex(actual)})` 
  };
}
/*
//is done by rf chip can be removed later!
function addTxChecksum(bytes) {
  const copy = [...bytes];
  let sum = 0;
  for (let i = 0; i < copy.length - 1; i++) sum += copy[i];
  copy[copy.length - 1] = (sum - 0x24) & 0xff;
  return copy;
}
*/

//is done by rf chip can be removed later!
function addTxChecksum(bytes) {
  // CURRENTLY DISABLED: nothing to calculate, nothing to overwrite.
  // Return the array exactly as received.
  return [...bytes];
}

function decodeTimeIrrigationTimer(low, high) {
  const hour = ((high - 0x48) << 2) | (low >> 6);
  const minute = low & 0x3f;
  return { hour, minute, text: `${hour}:${minute}` };
}

function encodeTimeIrrigationTimer(hour, minute) {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('Hour 0-23, minute 0-59 allowed');
  }
  const high = 0x48 + (hour >> 2);
  const low = ((hour & 0x03) << 6) | minute;
  return { low, high };
}

function decodeIrrigationProgram(status, low, high) {
  const modeCode = (high - 0x48) >> 3;
  const hour = (((high - 0x48) & 0x07) << 2) | (low >> 6);
  const minute = low & 0x3f;
  const enabled = !!(status & 0x80);

  const days = enabled && modeCode === 3
    ? Object.keys(DAY_BITS).filter(d => status & DAY_BITS[d])
    : enabled
      ? ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
      : [];

  return {
    enabled,
    modeCode,
    mode: MODES[modeCode] || 'UNKNOWN',
    hour,
    minute,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    days,
  };
}

function encodeIrrigationProgram({ hour, minute, mode = 'EVERY_DAY', enabled = true, days = [] }) {
  const modeCode = typeof mode === 'number' ? mode : MODES.indexOf(mode);
  if (modeCode < 0 || modeCode > 3) throw new Error('Invalid mode');
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error('Invalid time');

  const low = ((hour & 0x03) << 6) | minute;
  const high = 0x48 + (hour >> 2) + (modeCode << 3);

  let status = enabled ? 0x80 : 0x00;
  if (enabled && modeCode === 3) {
    days.forEach(d => {
      status |= DAY_BITS[String(d).toUpperCase()] ?? 0;
    });
  }

  return [status, low, high];
}

function setEnable(bytes, onOff) {
  const [status, low, high] = bytes;
  return [onOff ? (status | 0x80) : (status & 0x7f), low, high];
}

function decodeIdlePacketTime(bytes, start = 0) {
  if (bytes.length < start + 6) {
    throw new Error(`Slice at offset ${start} contains fewer than 6 bytes`);
  }

  const slice = bytes.slice(start, start + 6);
  const [b0, b1, b2, b3, b4, b5] = slice;

  void b0;
  void b4;

  const second = b1 & 0x3f;
  const minute = ((b2 & 0x0f) << 2) | (b1 >> 6);
  const hour = ((b3 & 0x01) << 4) | (b2 >> 4);

  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dowIndex = b5 & 0x07;
  const dow = dowNames[dowIndex] ?? '??';

  return {
    hour,
    minute,
    second,
    dowIndex,
    dow,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`,
  };
}

function encodeIdlePacketTime(hour, minute, second, dow) {
  hour = parseInt(hour, 10);
  minute = parseInt(minute, 10);
  second = parseInt(second, 10);
  dow = parseInt(dow, 10);

  if (![hour, minute, second, dow].every(Number.isInteger)) {
    throw new Error('Time fields must be integers');
  }
  if (hour < 0 || hour > 23) throw new Error('hour 0-23');
  if (minute < 0 || minute > 59) throw new Error('minute 0-59');
  if (second < 0 || second > 59) throw new Error('second 0-59');
  if (dow < 0 || dow > 6) throw new Error('dow 0-6');

  const b0 = 0x00;
  const b1 = ((minute & 0x03) << 6) | (second & 0x3f);
  const b2 = ((hour & 0x0f) << 4) | (minute >> 2);
  const b3 = (hour >> 4) & 0x01;
  const b4 = 0x15;
  const b5 = dow & 0x07;

  return Uint8Array.from([b0, b1, b2, b3, b4, b5]);
}

function extractPacketMeta(bytes, isFromHub) {
  const hubId = decodeId(bytes, isFromHub ? 5 : 1);
  const valveId = decodeId(bytes, isFromHub ? 1 : 5);
  const seq = bytes[9];
  const statusByte = bytes[10];
  const statusText = isFromHub
    ? (STATUS_TX[statusByte] || 'Unknown')
    : (STATUS_RX[statusByte] || 'Unknown');

  return { hubId, valveId, seq, statusByte, statusText };
}

function decodeStatusReport(bytes) {
  return {
    valve: bytes[14],
    valveStateByte: bytes[15],
    valveStateText: VALVE_STATE[bytes[15]] || 'Unknown',
    remainingTimeSeconds: decodeLittleEndian(bytes, 22, 2),
    remainingTime: secondsToHHMMSS(decodeLittleEndian(bytes, 22, 2)),
    startTimeSeconds: decodeLittleEndian(bytes, 25, 2),
    startTime: secondsToHHMMSS(decodeLittleEndian(bytes, 25, 2)),
  };
}

function decodeTxIdlePacket(bytes) {
  return {
    subtype: bytes[11],
    subtypeText: bytes[11] === 0x07 ? 'Idle Packet' : bytes[11] === 0x02 ? 'ACK Packet' : 'Unknown',
    time: decodeIdlePacketTime(bytes, 13),
  };
}

function decodeTxIrrigationPlanPacket(bytes) {
  return {
    program: decodeIrrigationProgram(bytes[13], bytes[14], bytes[15]),
    waterDurationSeconds: decodeLittleEndian(bytes, 16, 2),
    waterDuration: secondsToHHMMSS(decodeLittleEndian(bytes, 16, 2)),
  };
}

function buildManualWateringPacket(hubId, valveId, seconds) {
  // 1. Header & IDs
  const header = [0x51];
  
  // Convert IDs to little endian (4 bytes)
  const vIdBytes = [
    valveId & 0xff,
    (valveId >> 8) & 0xff,
    (valveId >> 16) & 0xff,
    (valveId >> 24) & 0xff
  ];
  const hIdBytes = [
    hubId & 0xff,
    (hubId >> 8) & 0xff,
    (hubId >> 16) & 0xff,
    (hubId >> 24) & 0xff
  ];

  // 2. Increment sequence
  const currentSeq = seqCounter;
  seqCounter = (seqCounter + 1) & 0xff;

  // 3. Command & Base Payload
  // 0x21 = action, 0x05 = payload length
  const cmdBase = [currentSeq, 0x21, 0x05, 0x01, 0x02];

  let actionBytes = [];
  if (seconds > 0) {
    // ON: status 0x01, duration in little endian (2 bytes)
    actionBytes = [
      0x01,
      seconds & 0xff,
      (seconds >> 8) & 0xff
    ];
  } else {
    // OFF: status 0x00, payload is shorter (length 0x03)
    cmdBase[2] = 0x03; // Adjust length byte to 3
    actionBytes = [0x00];
  }

  // Append padding to reach a good packet length
  // (Filling with zeros, the system appears to ignore/not need it)
  const padding = new Array(16).fill(0x00);

  // Assemble everything
  const packet = [...header, ...vIdBytes, ...hIdBytes, ...cmdBase, ...actionBytes, ...padding];
  
  // Without checksum for now (or with disabled addTxChecksum)
  return addTxChecksum(packet); 
}

function prettyPrintPacket(bytes, direction) {
  console.log('\n================ PACKET ANALYSIS ================');
  console.log(`DIRECTION: ${direction}`);
  console.log(`RAW (${bytes.length} bytes): ${bytesToHex(bytes)}\n`);

  if (bytes.length < 12) {
    console.log('[!] Packet too short. Cannot parse.');
    return;
  }

  const getHex = (start, end) =>
    bytes.slice(start, end).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

  const id1 = decodeLittleEndian(bytes, 1, 4);
  const id2 = decodeLittleEndian(bytes, 5, 4);
  const cmd = bytes[10];
  const payloadLen = bytes[11];

  let cmdName = 'Unknown command';
  if (direction === 'hub->valve') cmdName = STATUS_TX[cmd] || cmdName;
  else if (direction === 'valve->hub') cmdName = STATUS_RX[cmd] || cmdName;
  else cmdName = STATUS_RX[cmd] || STATUS_TX[cmd] || cmdName;

  console.log(`[00]    ${getHex(0, 1).padEnd(14)} -> Header`);
  console.log(`[01-04] ${getHex(1, 5).padEnd(14)} -> Target ID   (${id1})`);
  console.log(`[05-08] ${getHex(5, 9).padEnd(14)} -> Sender ID   (${id2})`);
  console.log(`[09]    ${getHex(9, 10).padEnd(14)} -> Sequence    (${toHex(bytes[9])})`);
  console.log(`[10]    ${getHex(10, 11).padEnd(14)} -> Command     (${toHex(cmd)} - ${cmdName})`);
  console.log(`[11]    ${getHex(11, 12).padEnd(14)} -> Payload Len (${payloadLen} Bytes)`);

  const payloadEnd = 12 + payloadLen;
  if (payloadLen > 0 && bytes.length >= payloadEnd) {
    const payloadBytes = bytes.slice(12, payloadEnd);
    console.log(`[12-${String(payloadEnd - 1).padStart(2, '0')}] ${getHex(12, payloadEnd).padEnd(14)} -> PAYLOAD`);

    // --- MODULAR PAYLOAD PARSING ---
    const decoderKey = toHex(cmd).toLowerCase(); // e.g. "0x21"
    
    if (decoders[decoderKey]) {
      try {
        // Calls the module and returns an array of {label, value}
        const decodedData = decoders[decoderKey](payloadBytes, utils);
        decodedData.forEach(item => {
          console.log(`        ├─ ${item.label.padEnd(12)}: ${item.value}`);
        });
      } catch (err) {
        console.log(`        └─ [!] Error in decoder ${decoderKey}.js: ${err.message}`);
      }
    } else {
      console.log(`        └─ (No decoder for ${toHex(cmd)} available)`);
    }
  }

  if (bytes.length > payloadEnd) {
    console.log(`[${payloadEnd}-${bytes.length - 1}] ...            -> PADDING / CRC / UNKNOWN`);
    console.log(`        └─ RAW: ${getHex(payloadEnd, bytes.length)}`);
  }
  console.log('===============================================\n');
}

function parseIncomingPacket(hexPayload, direction = 'unknown') {
  if (!/^[0-9a-fA-F]+$/.test(hexPayload) || hexPayload.length % 2 !== 0) {
    console.log(`[!] Invalid hex payload: ${hexPayload}`);
    return;
  }

  const bytes = [];
  for (let i = 0; i < hexPayload.length; i += 2) {
    bytes.push(parseInt(hexPayload.slice(i, i + 2), 16));
  }

  prettyPrintPacket(bytes, direction);
}

function sendPacket(bytes, label = 'TX') {
  const finalBytes = addTxChecksum(bytes);
  const finalHex = bytesToHex(finalBytes);
  console.log(`[${label}] ${finalHex}`);
  client.write(`TX:${finalHex}\n`);
  return finalBytes;
}

function buildPingPacket() {
  const packet = [
    0x51, 0x00, 0x00, 0x00, 0x00,
    0x52, 0x12, 0x00, 0x26,
    seqCounter,
    0x82, // Hub -> valve: Idle / Poll / ACK
    0x07, 0x0F,
    0xFF, 0x26, 0x10, 0x01, 0x07, 0x02,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];

  const out = addTxChecksum(packet);
  seqCounter = (seqCounter + 0x03) & 0xff;
  return out;
}

function printHelp() {
  console.log('Commands:');
  console.log(`  tune <tx> <rx>                       Set channels (currently: TX=${currentTx}, RX=${currentRx})`);
  //tune 0 1 -> send to gateway receive from gateway | tune 1 0 -> send to valve receive from valve
  console.log('  ping                                 Send Idle/Poll packet (auto-checksum)');
  console.log('  raw <hex>                            Send hex and recalculate TX checksum');
  console.log('  parse <hex>                          Parse a hex packet locally without sending');
  console.log('  idle-time <hh> <mm> <ss> <dow>       Encode 6-byte idle time telegram');
  console.log('  plan <hh> <mm> <mode> <on|off> [days...]');
  console.log('                                       Encode 3-byte irrigation program');
  console.log('                                       mode: EVERY_DAY | ODD_DATES | EVEN_DATES | CUSTOM_DAYS');
  console.log('                                       days for CUSTOM_DAYS e.g.: MON WED FRI');
  console.log('  seq                                  Show current sequence counter');
  console.log('  help                                 This help');
}

// --- TCP CLIENT SETUP ---
const client = new net.Socket();

client.connect(ESP32_PORT, ESP32_IP, () => {
  console.log(`[+] Connected to ESP32 bridge at ${ESP32_IP}:${ESP32_PORT}`);
  console.log('[+] Type "help" for commands.\n');
  rl.prompt();
});

client.on('data', (data) => {
  tcpLineBuffer += data.toString('utf8');

  while (true) {
    const newlineIndex = tcpLineBuffer.indexOf('\n');
    if (newlineIndex === -1) break;

    const line = tcpLineBuffer.slice(0, newlineIndex).trim();
    tcpLineBuffer = tcpLineBuffer.slice(newlineIndex + 1);

    if (!line) continue;

    if (line.startsWith('RX:')) {
      const parts = line.split(':');
      const hexPayload = parts[2] || parts[1] || '';
      parseIncomingPacket(hexPayload.trim(), 'valve->hub');
      
    } else if (line.startsWith('ORIG_RX:')) {
      const hexPayload = line.split(':')[1] || '';
      console.log('\n[ORIGINAL GATEWAY RX]');
      parseIncomingPacket(hexPayload.trim(), 'valve->hub');

    } else if (line.startsWith('ORIG_TX:')) {
      const hexPayload = line.split(':')[1] || '';
      console.log('\n[ORIGINAL GATEWAY TX]');
      parseIncomingPacket(hexPayload.trim(), 'hub->valve');

    } else if (
      line.startsWith('ACK:') ||
      line.startsWith('ERR:') ||
      line.startsWith('TUNE:')
    ) {
      console.log(`[ESP32] ${line}`);

    } else {
      console.log(`[ESP32] ${line}`);
    }
  }

  rl.prompt();
});

client.on('close', () => {
  console.log('[!] Connection closed.');
  process.exit();
});

client.on('error', (err) => console.error(`[!] TCP error: ${err.message}`));

// --- CLI (CONSOLE) ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'diivoo> ',
});

rl.on('line', (line) => {
  const rawInput = line.trim();
  const args = rawInput.split(/\s+/);
  const cmd = (args[0] || '').toLowerCase();

  try {
    switch (cmd) {
      case 'help':
        printHelp();
        break;

      case 'tune':
        if (args.length === 3) {
          currentTx = parseInt(args[1], 10);
          currentRx = parseInt(args[2], 10);
          client.write(`TUNE:${currentTx}:${currentRx}\n`);
          console.log(`[TX] TUNE:${currentTx}:${currentRx}`);
        } else {
          console.log('Usage: tune <tx> <rx>');
        }
        break;

      case 'ping': {
        const packet = buildPingPacket();
        console.log(`[TX] Sending ping/idle (sequence ${toHex(packet[9])})`);
        client.write(`TX:${bytesToHex(packet)}\n`);
        break;
      }

      case 'raw': {
        if (!args[1]) {
          console.log('Usage: raw <hex>');
          break;
        }
        const hex = args[1].replace(/\s+/g, '');
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
          console.log('[!] Invalid hex string');
          break;
        }

        const bytes = [];
        for (let i = 0; i < hex.length; i += 2) {
          bytes.push(parseInt(hex.slice(i, i + 2), 16));
        }

        const finalBytes = addTxChecksum(bytes);
        const finalHex = bytesToHex(finalBytes);
        console.log(`[TX] Sending packet with auto-checksum: ${finalHex}`);
        client.write(`TX:${finalHex}\n`);
        break;
      }

      case 'parse': {
        if (!args[1]) {
          console.log('Usage: parse <hex>');
          break;
        }
        parseIncomingPacket(args[1]);
        break;
      }

      case 'idle-time': {
        if (args.length !== 5) {
          console.log('Usage: idle-time <hh> <mm> <ss> <dow>');
          break;
        }
        const pkt = encodeIdlePacketTime(args[1], args[2], args[3], args[4]);
        console.log(`Idle-Time Bytes: ${bytesToHex(Array.from(pkt))}`);
        break;
      }

      case 'plan': {
        if (args.length < 5) {
          console.log('Usage: plan <hh> <mm> <mode> <on|off> [days...]');
          break;
        }

        const hour = parseInt(args[1], 10);
        const minute = parseInt(args[2], 10);
        const mode = args[3].toUpperCase();
        const enabled = args[4].toLowerCase() === 'on';
        const days = args.slice(5).map(d => d.toUpperCase());

        const encoded = encodeIrrigationProgram({ hour, minute, mode, enabled, days });
        console.log(`Plan Bytes: ${bytesToHex(encoded)} -> ${JSON.stringify(decodeIrrigationProgram(...encoded))}`);
        break;
      }

      case 'water': {
        if (!args[1]) {
          console.log('Usage: water <seconds> (0 = OFF)');
          break;
        }
        const seconds = parseInt(args[1], 10);
        
        // WARNING: Adjust these IDs from your logs!
        // You can also pass them as parameters later.
        const HUB_ID = 16926055;
        const VALVE_ID = 637538898; 

        const packet = buildManualWateringPacket(HUB_ID, VALVE_ID, seconds);
        const hex = bytesToHex(packet);
        
        console.log(`[TX] Sending manual watering command (${seconds}s): ${hex}`);
        client.write(`TX:${hex}\n`);
        break;
      }

      case 'seq':
        console.log(`Current sequence counter: ${toHex(seqCounter)}`);
        break;

      case '':
        break;

      default:
        console.log(`Unknown command: ${cmd}`);
        printHelp();
        break;
    }
  } catch (err) {
    console.log(`[!] Error: ${err.message}`);
  }

  rl.prompt();
});
