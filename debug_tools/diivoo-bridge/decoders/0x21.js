module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0x21 = Hub -> valve, action command
   *
   * Observed variants:
   * ----------------------
   * 1) Turn on with duration
   *    Payload length 5
   *    [port, subCmd, action, durationLo, durationHi]
   *
   *    Example:
   *      01 02 01 58 02
   *      -> Port 1, Sub-CMD 0x02, ON, 600 seconds
   *
   * 2) Turn off / short command
   *    Payload length 3
   *    [port, subCmd, action]
   *
   *    Example:
   *      01 02 00
   *      -> Port 1, Sub-CMD 0x02, OFF
   *
   * Current reverse-engineering state:
   * ------------------------------------
   * - payload[0] = port / valve index
   * - payload[1] = sub-CMD / action type
   *                observed so far: 0x02 = direct valve control?
   * - payload[2] = action
   *                0x00 = OFF
   *                0x01 = ON
   * - payload[3..4] = target duration in seconds (LE16), if present
   * Preamble Long: 0x21: Action command / control command:long
   */

  const results = [];

  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  if (payload.length < 3) {
    results.push({ label: 'Error', value: 'Payload too short for 0x21' });
    results.push({ label: 'Raw Payload', value: bytesToSpacedHex(payload) });
    return results;
  }

  const portIndex = payload[0];
  const subCmd = payload[1];
  const actionByte = payload[2];

  const subCmdMap = {
    0x02: 'direct valve control?',
  };

  const actionMap = {
    0x00: 'OFF',
    0x01: 'ON',
  };

  const subCmdText = subCmdMap[subCmd] || `Unknown (${toHex(subCmd)})`;
  const actionText = actionMap[actionByte] || `Unknown (${toHex(actionByte)})`;

  results.push({ label: 'Type', value: 'Action command / control command' });

  results.push({
    label: 'Port / Valve Index',
    value: `${portIndex} (${toHex(portIndex)})`
  });

  results.push({
    label: 'Sub-CMD',
    value: subCmdText
  });

  results.push({
    label: 'Sub-CMD Byte',
    value: toHex(subCmd)
  });

  results.push({
    label: 'Action',
    value: actionText
  });

  results.push({
    label: 'Action Byte',
    value: toHex(actionByte)
  });

  if (payload.length >= 5) {
    const durationSeconds = utils.decodeLittleEndianFromArray(payload, 3, 2);

    results.push({
      label: 'Target Duration',
      value: `${durationSeconds} seconds`
    });
  } else {
    results.push({
      label: 'Target Duration',
      value: 'not present'
    });
  }

  if (payload.length > 5) {
    results.push({
      label: 'Extra Bytes?',
      value: bytesToSpacedHex(payload.slice(5))
    });
  }

  return results;
};
