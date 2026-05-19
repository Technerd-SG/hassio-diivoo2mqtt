module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0x02 = Status report from irrigation timer
   *
   * Current reverse-engineering state:
   * ------------------------------------
   * Confirmed / strongly supported:
   * - payload[0] = channel code of the device
   *   actual channel = payload[0] - 1
   *
   * - payload[1] = meta byte: battery status + event type
   *   bits 3..4 = battery code
   *   bits 0..2 = event code
   *
   *   Observed:
   *   Battery code:
   *   1 = battery OK (app shows 4 bars)
   *   2 = battery low (app shows 1 bar)
   *
   *   Event code:
   *   3 = normal status report / boot?
   *   6 = status report requesting hub time sync
   *
   * - payload[2] = valve / port index
   *
   * - payload[3] = status / start source
   *   Observed so far:
   *   0x00 = OFF
   *   0x11 = ON (started locally on device)
   *   0x21 = ON (started via app / hub)
   *   0x41 = ON (presumably started by schedule)
   *
   *   Strong hypothesis:
   *   - bit 0 = active
   *   - upper nibble = start source
   *
   * - payload[10..11] = remaining time in seconds (little endian)
   * - payload[13..14] = target duration in seconds (little endian)
   *
   * Open:
   * - payload[4] and payload[9] appear to be marker / flag bytes
   * - payload[5..8] could be a LE32 value
   * - payload[12] is often 0xAD
   * Preamble Unknown but probably short because valve -> hub doesnt need to wake up hub!!
   */

  const results = [];
  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  if (payload.length < 15) {
    results.push({ label: 'Action', value: 'Device reports status (incomplete)' });
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

  const meta = utils.decodeStatusMetaByte
    ? utils.decodeStatusMetaByte(payload[1])
    : {
        metaByte: payload[1],
        batteryCode: (payload[1] >> 3) & 0x03,
        batteryText: 'Unknown',
        eventCode: payload[1] & 0x07,
        eventText: 'Unknown'
      };

  const state = utils.decodeStatusSourceByte
    ? utils.decodeStatusSourceByte(payload[3])
    : {
        stateByte: payload[3],
        stateText: `Unknown (${toHex(payload[3])})`,
        isRunning: (payload[3] & 0x01) === 0x01,
        sourceCode: (payload[3] >> 4) & 0x0F,
        sourceText: 'Unknown'
      };

  const valveIndex = payload[2];
  const stateCoreRaw = payload.slice(4, 10);
  const remainingSeconds = utils.decodeLittleEndianFromArray(payload, 10, 2);
  const durationMarker = payload[12];
  const targetSeconds = utils.decodeLittleEndianFromArray(payload, 13, 2);

  results.push({ label: 'Action', value: 'Device reports status' });
  results.push({ label: 'Channel Code', value: `${channel.channelCode} (${toHex(channel.channelCode)})` });
  results.push({ label: 'Current Channel', value: channel.text });

  results.push({ label: 'Battery', value: meta.batteryText });
  results.push({ label: 'Battery Code', value: `${meta.batteryCode} (${toHex(meta.batteryCode)})` });

  results.push({ label: 'Event Type', value: meta.eventText });
  results.push({ label: 'Event Code', value: `${meta.eventCode} (${toHex(meta.eventCode)})` });
  results.push({ label: 'Raw Meta Byte', value: toHex(meta.metaByte) });

  results.push({ label: 'Valve Index', value: `${valveIndex} (${toHex(valveIndex)})` });

  results.push({ label: 'Status', value: state.stateText });
  results.push({ label: 'Status Byte', value: toHex(state.stateByte) });
  results.push({ label: 'Active', value: state.isRunning ? 'YES' : 'NO' });
  results.push({ label: 'Source / Mode Nibble', value: `${state.sourceCode} (${toHex(state.sourceCode)})` });
  results.push({ label: 'Start Source?', value: state.sourceText });

  results.push({
    label: 'State Core RAW [4..9]',
    value: bytesToSpacedHex(stateCoreRaw)
  });

  results.push({
    label: 'Remaining Time',
    value: `${remainingSeconds} seconds`
  });

  results.push({
    label: 'Duration Marker [12]',
    value: `${durationMarker} (${toHex(durationMarker)})${durationMarker === 0xAD ? ' -> AD marker' : ''}`
  });

  results.push({
    label: 'Target Duration',
    value: `${targetSeconds} seconds`
  });

  return results;
};
