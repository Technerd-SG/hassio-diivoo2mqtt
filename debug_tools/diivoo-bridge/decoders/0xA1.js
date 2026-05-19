module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0xA1 = Valve -> hub, ACK + status
   *
   * Observed context:
   * - direct valve response to CMD 0x21
   * - sequence typically matches the preceding 0x21 control command
   *
   * Current reverse-engineering state:
   * ------------------------------------
   * Payload length is typically 13 bytes:
   *
   * [0]      ACK / result byte
   * [1]      Status / start source
   * [2..7]   unknown status / flag block
   * [8..9]   remaining time in seconds (LE16)
   * [10]     unknown field (often 0xAD)
   * [11..12] target duration in seconds (LE16)
   *
   * Strongly supported:
   * - payload[1] uses the same status / source semantics as 0x02
   * - payload[1..12] very likely corresponds in content
   *   to the status body from 0x02 payload[3..14]
   * Preamble Unknown but probably short because valve -> hub doesnt need to wake up hub!!
   */

  const results = [];

  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  if (payload.length < 13) {
    results.push({ label: 'Type', value: 'Action-ACK + compact status (incomplete)' });
    results.push({ label: 'Raw Payload', value: bytesToSpacedHex(payload) });
    return results;
  }

  const ackByte = payload[0];

  const state = utils.decodeStatusSourceByte
    ? utils.decodeStatusSourceByte(payload[1])
    : {
        stateByte: payload[1],
        stateText: `Unknown (${toHex(payload[1])})`,
        isRunning: (payload[1] & 0x01) === 0x01,
        sourceCode: (payload[1] >> 4) & 0x0F,
        sourceText: 'Unknown'
      };

  const stateCoreRaw = payload.slice(2, 8);
  const remainingSeconds = utils.decodeLittleEndianFromArray(payload, 8, 2);
  const durationMarker = payload[10];
  const targetSeconds = utils.decodeLittleEndianFromArray(payload, 11, 2);

  results.push({ label: 'Type', value: 'Action-ACK + compact status' });

  results.push({
    label: 'ACK / Result Byte',
    value: `${ackByte} (${toHex(ackByte)})`
  });

  results.push({
    label: 'Status',
    value: state.stateText
  });

  results.push({
    label: 'Status Byte',
    value: toHex(state.stateByte)
  });

  results.push({
    label: 'Active',
    value: state.isRunning ? 'YES' : 'NO'
  });

  results.push({
    label: 'Source / Mode Nibble',
    value: `${state.sourceCode} (${toHex(state.sourceCode)})`
  });

  results.push({
    label: 'Start Source?',
    value: state.sourceText
  });

  results.push({
    label: 'State Core RAW [2..7]',
    value: bytesToSpacedHex(stateCoreRaw)
  });

  results.push({
    label: 'Remaining Time',
    value: `${remainingSeconds} seconds`
  });

  results.push({
    label: 'Duration Marker [10]',
    value: `${durationMarker} (${toHex(durationMarker)})${durationMarker === 0xAD ? ' -> AD marker' : ''}`
  });

  results.push({
    label: 'Target Duration',
    value: `${targetSeconds} seconds`
  });

  results.push({
    label: 'Relation to 0x02',
    value: 'structurally corresponds to the status body from 0x02 payload[3..14]'
  });

  if (payload.length > 13) {
    results.push({
      label: 'Extra Bytes?',
      value: bytesToSpacedHex(payload.slice(13))
    });
  }

  return results;
};
