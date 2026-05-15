// Datei: utils.js

function toHex(byte) {
  return `0x${Number(byte).toString(16).padStart(2, '0').toUpperCase()}`;
}

function bytesToHex(bytes) {
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function bytesToSpacedHex(bytes) {
  return bytes.map(b => toHex(b)).join(' ');
}

function decodeLittleEndian(bytes, startIndex, len) {
  const part = bytes.slice(startIndex, startIndex + len).reverse();
  const hexStr = part.map(b => b.toString(16).padStart(2, '0')).join('');
  return parseInt(hexStr, 16);
}

function decodeLittleEndianFromArray(bytes, startIndex, len) {
  return decodeLittleEndian(bytes, startIndex, len);
}

function buildPacket(targetId, senderId, seq, cmd, payloadBytes, padTo32 = false) {
  const header = [0x51];
  const targetBytes = [
    targetId & 0xff, (targetId >>> 8) & 0xff, (targetId >>> 16) & 0xff, (targetId >>> 24) & 0xff
  ];
  const senderBytes = [
    senderId & 0xff, (senderId >>> 8) & 0xff, (senderId >>> 16) & 0xff, (senderId >>> 24) & 0xff
  ];
  const meta = [seq, cmd, payloadBytes.length];
  let packet = [...header, ...targetBytes, ...senderBytes, ...meta, ...payloadBytes];

  if (padTo32) {
    while (packet.length < 32) packet.push(0x00);
  }
  return packet;
}

function decodeTuya32BitDate(rawValue) {
  const year = 2020 + ((rawValue >> 26) & 0x3F);
  const month = (rawValue >> 22) & 0x0F;
  const day = (rawValue >> 17) & 0x1F;
  const hour = (rawValue >> 12) & 0x1F;
  const minute = (rawValue >> 6) & 0x3F;
  const second = rawValue & 0x3F;
  const pad = (num) => String(num).padStart(2, '0');
  return { year, month, day, hour, minute, second, text: `${pad(day)}.${pad(month)}.${year} ${pad(hour)}:${pad(minute)}:${pad(second)}` };
}

function encodeTuya32BitDate(date) {
  const year = date.getFullYear() - 2020;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = date.getHours();
  const min = date.getMinutes();
  const sec = date.getSeconds();

  const tuya32 = ((year & 0x3F) << 26) | ((month & 0x0F) << 22) | ((day & 0x1F) << 17) | ((hour & 0x1F) << 12) | ((min & 0x3F) << 6) | (sec & 0x3F);
  const unsignedTuya = tuya32 >>> 0;
  return [ unsignedTuya & 0xFF, (unsignedTuya >>> 8) & 0xFF, (unsignedTuya >>> 16) & 0xFF, (unsignedTuya >>> 24) & 0xFF ];
}

function decodeChannelCode(channelCode) {
  return { channelCode, actualChannel: channelCode > 0 ? channelCode - 1 : null, text: channelCode > 0 ? `${channelCode - 1}` : 'Invalid' };
}

function decodeStatusSourceByte(stateByte) {
  const stateMap = { 0x00: 'OFF', 0x11: 'ON (local)', 0x12: 'MIST (local)', 0x20: 'OFF (hub)', 0x21: 'ON (hub)', 0x22: 'MIST (hub)', 0x41: 'ON (schedule)', 0x42: 'MIST (schedule)' };
  const sourceMap = { 0x0: 'none / OFF', 0x1: 'local', 0x2: 'app/hub', 0x4: 'schedule' };
  const isRunning = (stateByte & 0x03) !== 0;
  const sourceCode = (stateByte >> 4) & 0x0F;
  return { stateByte, stateText: stateMap[stateByte] || `Unknown (${toHex(stateByte)})`, isRunning, sourceCode, sourceText: sourceMap[sourceCode] || `Unknown` };
}

function decodeStatusMetaByte(metaByte) {
  const batteryCode = (metaByte >> 3) & 0x03;
  const eventCode = metaByte & 0x07;
  const batteryMap = { 0: 'Unknown (0)', 1: 'OK (4 bars)', 2: 'Low (1 bar)', 3: 'Unknown (3)' };
  return { metaByte, batteryCode, batteryText: batteryMap[batteryCode] || 'Invalid', eventCode, eventText: eventCode === 6 ? 'Time-sync requested' : 'Normal report' };
}

function decodeTimeBlock6(bytes6) {
  const dowNames = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  if (!bytes6 || bytes6.length < 6) return { valid: false };
  const [t0, t1, t2, t3, t4, t5] = bytes6;
  const second = t1 & 0x3F;
  const minute = ((t2 & 0x0F) << 2) | (t1 >> 6);
  const hour = ((t3 & 0x01) << 4) | (t2 >> 4);
  const day = (t3 >> 1) & 0x1F;
  const month = ((t4 & 0x03) << 2) | (t3 >> 6);
  const year = 2020 + (t4 >> 2);
  const dowIndex = t5 & 0x07;
  const pad = (num) => String(num).padStart(2, '0');
  return { valid: true, t0, t1, t2, t3, t4, t5, year, month, day, hour, minute, second, dowIndex, dow: dowNames[dowIndex], text: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}` };
}

function encodeTimeBlock6(date = new Date(), contextByte = 0x02, extraFlagsT5 = 0x03) {
  const year = date.getFullYear() - 2020;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = date.getHours();
  const minute = date.getMinutes();
  const second = date.getSeconds();
  const dowIndex = date.getDay();
  const t0 = contextByte & 0xFF;
  const t1 = (second & 0x3F) | ((minute & 0x03) << 6);
  const t2 = ((minute >> 2) & 0x0F) | ((hour & 0x0F) << 4);
  const t3 = ((hour >> 4) & 0x01) | ((day & 0x1F) << 1) | ((month & 0x03) << 6);
  const t4 = ((month >> 2) & 0x03) | ((year & 0x3F) << 2);
  const t5 = (dowIndex & 0x07) | ((extraFlagsT5 & 0x1F) << 3);
  return [t0, t1, t2, t3, t4, t5];
}

const SHORT_DAY_TO_BIT = { 'So': 0x01, 'Mo': 0x02, 'Di': 0x04, 'Mi': 0x08, 'Do': 0x10, 'Fr': 0x20, 'Sa': 0x40 };
function encodePlanBlock(plan) {
  let statusByte = plan.enabled ? 0x80 : 0x00;
  if ((plan.modeCode & 0x03) === 3 && Array.isArray(plan.activeDays)) {
      plan.activeDays.forEach(day => { if (SHORT_DAY_TO_BIT[day]) statusByte |= SHORT_DAY_TO_BIT[day]; });
  }
  const minute = plan.minute & 0x3F;
  const b1 = minute | ((plan.hour & 0x03) << 6);
  const b2 = 0x48 + ((plan.hour >> 2) & 0x07) + ((plan.modeCode & 0x0F) << 3);
  return [statusByte, b1, b2, plan.durationSeconds & 0xFF, (plan.durationSeconds >> 8) & 0xFF, 0x00, 0x00];
}

function normalizeSchedulePlan(plan) {
  const [hourStr = '0', minuteStr = '0'] = String(plan.startTime || '00:00').split(':');
  const hour = Number.parseInt(hourStr, 10) || 0;
  const minute = Number.parseInt(minuteStr, 10) || 0;

  // Base-Mode aus repeat ableiten (Bits 0-1)
  let modeCode = 0;
  switch (plan.repeat) {
    case 'daily':
      modeCode = 0;
      break;
    case 'odd':
      modeCode = 1;
      break;
    case 'even':
      modeCode = 2;
      break;
    case 'custom':
      modeCode = 3;
      break;
    default:
      modeCode = 0;
      break;
  }

  // Interval/Mist-Flag setzen (Bit 3 = 0x08)
  if (plan.mode === 'mist') {
    modeCode |= 0x08;
  }

  return {
    enabled: plan.enabled !== false,
    modeCode,
    hour,
    minute,
    durationSeconds: (Number.parseInt(plan.durationMinutes, 10) || 0) * 60,
    activeDays: Array.isArray(plan.weekdays) ? plan.weekdays : [],
  };
}

function parseJoinPacket(payload) {
  if (payload.length < 7) {
      return null; // Paket zu kurz, ungültig
  }

  const suggestedChannelCode = payload[0];
  const markerByte = payload[1];
  const hardwareId = (payload[3] << 8) | payload[2]; // Little Endian
  const categoryByte = payload[4];
  const revisionByte = payload[5];
  const firmwareByte = payload[6];

  let model = 'Unbekanntes Modell';
  let channelCount = 1; // Fallback auf 1 Kanal

  if (hardwareId === 0x1026) {
      model = 'WT-13W';
      channelCount = 4;
  } else if (hardwareId === 0x0D1F) {
      model = 'WT-07W';
      channelCount = 1;
  } else if (hardwareId === 0x0E20) {
      model = 'WT-09W';
      channelCount = 2;
  } else if (hardwareId === 0x0F25) {
      model = 'WT-11W(1)';
      channelCount = 3;
  }

  return {
      suggestedChannelCode,
      markerByte,
      hardwareId,
      model,
      channelCount,
      categoryByte,
      revisionByte,
      firmwareByte
  };
}

module.exports = {
  toHex, bytesToHex, bytesToSpacedHex, decodeLittleEndian, decodeLittleEndianFromArray, buildPacket,
  decodeTuya32BitDate, encodeTuya32BitDate, decodeChannelCode, decodeStatusSourceByte, decodeStatusMetaByte,
  decodeTimeBlock6, encodeTimeBlock6, encodePlanBlock, parseJoinPacket, normalizeSchedulePlan
};
