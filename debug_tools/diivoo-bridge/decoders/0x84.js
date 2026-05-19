module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0x84 = Hub -> valve, ACK on event report
   *
   * Observed context:
   * - sent as an acknowledgement from the hub after the valve sends CMD 0x04
   *   (delayed report / event report)
   *
   * Current reverse-engineering state:
   * ------------------------------------
   * Strongly supported:
   * - 0x84 is the direct ACK response from the hub to CMD 0x04
   * - standard form observed so far: payload length 1
   * - payload[0] is 0x00 so far
   *
   * Still open:
   * - whether other variants with length != 1 exist
   * - whether payload[0] is only ACK or could also be a result / error code
   * Preamble Short: 0x84: ACK on delayed report / event report:short
   */

  const results = [];

  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  results.push({ label: 'Type', value: 'ACK on delayed report / event report' });

  results.push({
    label: 'Relation to 0x04',
    value: 'direct confirmation from hub for CMD 0x04'
  });

  results.push({
    label: 'Payload Length',
    value: `${payload.length} byte(s)`
  });

  if (payload.length === 0) {
    results.push({
      label: 'Interpretation',
      value: 'ACK without payload? not documented as standard form yet'
    });

    results.push({
      label: 'Raw Payload',
      value: '(empty)'
    });

    return results;
  }

  if (payload.length === 1) {
    results.push({
      label: 'ACK / Result Byte',
      value: `${payload[0]} (${toHex(payload[0])})`
    });

    results.push({
      label: 'Interpretation',
      value: payload[0] === 0x00
        ? 'Standard ACK without additional data'
        : 'ACK with non-standard result code?'
    });

    results.push({
      label: 'Raw Payload',
      value: bytesToSpacedHex(payload)
    });

    return results;
  }

  if (payload.length === 2) {
    results.push({
      label: 'Byte[0]',
      value: `${payload[0]} (${toHex(payload[0])})`
    });

    results.push({
      label: 'Byte[1]',
      value: `${payload[1]} (${toHex(payload[1])})`
    });

    results.push({
      label: 'Interpretation',
      value: 'short ACK variant with additional status / context byte?'
    });

    results.push({
      label: 'Raw Payload',
      value: bytesToSpacedHex(payload)
    });

    return results;
  }

  results.push({
    label: 'Interpretation',
    value: 'ACK with unknown additional structure'
  });

  results.push({
    label: 'Raw Payload',
    value: bytesToSpacedHex(payload)
  });

  return results;
};
