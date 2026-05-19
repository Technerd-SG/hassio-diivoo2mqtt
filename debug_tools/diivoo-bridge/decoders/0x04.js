module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0x04 = Delayed report / event report
   *
   * Observed context:
   * - sent with a delay after a watering run ends or is cancelled
   * - acknowledged by the gateway with CMD 0x84
   *
   * Current reverse-engineering state:
   * ------------------------------------
   * Strongly supported:
   * - payload[0]      = channel code
   *                     actual channel = payload[0] - 1
   * - payload[1]      = valve / port index
   * - payload[2]      = event code
   * - payload[3..6]   = event timestamp as Tuya 32-bit date (LE)
   * - payload[7]      = source / status byte of the finished run
   * - payload[8..11]  = water consumption in ml (LE32)
   * - payload[12..13] = actual duration in seconds (LE16)
   * Preamble Unknown but probably short because valve -> hub doesnt need to wake up hub!!
   */

  const results = [];

  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  const eventCodeMap = {
    0x01: 'Run finished / stop event',
  };

  const sourceStateMap = {
    0x00: 'OFF',
    0x11: 'started locally on device',
    0x20: 'stopped via app / hub?',
    0x21: 'started via app / hub',
    0x41: 'presumably started by schedule',
  };

  if (payload.length < 14) {
    results.push({ label: 'Type', value: 'Delayed report / event report (incomplete)' });
    results.push({ label: 'Raw Payload', value: bytesToSpacedHex(payload) });
    return results;
  }

  const channel = utils.decodeChannelCode
    ? utils.decodeChannelCode(payload[0])
    : {
        channelCode: payload[0],
        actualChannel: payload[0] > 0 ? payload[0] - 1 : null,
        text: payload[0] > 0
          ? `${payload[0] - 1} (derived: channel code - 1)`
          : 'Invalid / not derivable'
      };

  const valveIndex = payload[1];

  const eventCode = payload[2];
  const eventText = eventCodeMap[eventCode] || `Unknown (${toHex(eventCode)})`;

  const t4Raw = utils.decodeLittleEndianFromArray(payload, 3, 4);
  const eventDate = utils.decodeTuya32BitDate
    ? utils.decodeTuya32BitDate(t4Raw)
    : null;

  const sourceStateByte = payload[7];
  const sourceStateText = sourceStateMap[sourceStateByte] || `Unknown (${toHex(sourceStateByte)})`;

  const isRunningBit = (sourceStateByte & 0x01) === 0x01;
  const sourceCode = (sourceStateByte >> 4) & 0x0F;

  const waterConsumption = utils.decodeLittleEndianFromArray(payload, 8, 4);
  const elapsedSeconds = utils.decodeLittleEndianFromArray(payload, 12, 2);

  results.push({ label: 'Type', value: 'Delayed report / event report' });

  results.push({
    label: 'Channel Code',
    value: `${channel.channelCode} (${toHex(channel.channelCode)})`
  });

  results.push({
    label: 'Current Channel',
    value: channel.text
  });

  results.push({
    label: 'Valve Index',
    value: `${valveIndex} (${toHex(valveIndex)})`
  });

  results.push({
    label: 'Event Code',
    value: `${eventText} (${toHex(eventCode)})`
  });

  results.push({
    label: 'Event Timestamp',
    value: eventDate ? eventDate.text : `LE32 ${t4Raw}`
  });

  results.push({
    label: 'Source / Status Byte',
    value: `${sourceStateByte} (${toHex(sourceStateByte)})`
  });

  results.push({
    label: 'Start / Stop Source',
    value: sourceStateText
  });

  results.push({
    label: 'Active bit set?',
    value: isRunningBit ? 'YES' : 'NO'
  });

  results.push({
    label: 'Source Code',
    value: `${sourceCode} (${toHex(sourceCode)})`
  });

  results.push({
    label: 'Water Consumption',
    value: `${waterConsumption} ml`
  });

  results.push({
    label: 'Actual Duration',
    value: `${elapsedSeconds} seconds`
  });

  if (payload.length > 14) {
    results.push({
      label: 'Extra Bytes?',
      value: bytesToSpacedHex(payload.slice(14))
    });
  }

  return results;
};
