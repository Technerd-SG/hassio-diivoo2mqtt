module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0x20 = Hub -> valve
   *
   * Observed / suspected variants:
   * ----------------------------------
   * 1) 2-byte variant
   *    Plausible as trigger / wake / refresh initiator.
   *    After this, 0x05 and 0x06 are commonly seen in captures.
   *
   *    - payload[0] = correlation token?
   *    - payload[1] = padding / const byte?
   *
   * 2) 3-byte variant
   *    Plausible as runtime channel setup / listening channel command.
   *
   *    - payload[0] = param / subtype byte?
   *    - payload[1] = sub value?
   *    - payload[2] = channel code
   *
   * Open:
   * - whether the 3-byte variant is truly a channel setup in all cases
   * - whether payload[0] of the 2-byte variant is actually an echo / seq token
   * Preamble Long: 0x20: Trigger / update initiation:long
   */
  const results = [];

  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  if (payload.length === 3) {
    const paramId = payload[0];
    const subValue = payload[1];

    const channel = utils.decodeChannelCode
      ? utils.decodeChannelCode(payload[2])
      : {
          channelCode: payload[2],
          actualChannel: payload[2] > 0 ? payload[2] - 1 : null,
          text: payload[2] > 0
            ? `${payload[2] - 1} (derived: channel code - 1)`
            : 'Invalid / not derivable'
        };

    results.push({ label: 'Type', value: '3-byte variant / channel setup candidate' });

    results.push({
      label: 'Param ID?',
      value: `${paramId} (${toHex(paramId)})`
    });

    results.push({
      label: 'Sub Value?',
      value: `${subValue} (${toHex(subValue)})`
    });

    results.push({
      label: 'Channel Code',
      value: `${channel.channelCode} (${toHex(channel.channelCode)})`
    });

    results.push({
      label: 'Target Channel?',
      value: channel.text
    });

    results.push({
      label: 'Interpretation',
      value: 'plausible as runtime channel setup / listening channel, but not yet conclusively proven'
    });

    results.push({
      label: 'Raw Payload',
      value: bytesToSpacedHex(payload)
    });

    return results;
  }

  if (payload.length === 2) {
    const token = payload[0];
    const byte1 = payload[1];

    results.push({ label: 'Type', value: 'Trigger / update initiation' });

    results.push({
      label: 'Correlation Token?',
      value: `${token} (${toHex(token)})`
    });

    results.push({
      label: 'Byte[1] / Padding?',
      value: `${byte1} (${toHex(byte1)})`
    });

    results.push({
      label: 'Interpretation',
      value: 'plausible as wake / refresh trigger; 0x05 / 0x06 commonly follow'
    });

    results.push({
      label: 'Raw Payload',
      value: bytesToSpacedHex(payload)
    });

    return results;
  }

  results.push({
    label: 'Note',
    value: `Unknown 0x20 format (${payload.length} bytes)`
  });

  results.push({
    label: 'Raw Payload',
    value: bytesToSpacedHex(payload)
  });

  return results;
};
