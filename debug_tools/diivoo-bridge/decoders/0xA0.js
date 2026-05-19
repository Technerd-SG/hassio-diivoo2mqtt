module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0xA0 = ACK / short acknowledge?
   *
   * Observed context:
   * - seen as valve -> hub so far
   * - occurs directly after a preceding hub command
   * - plausibly mirrors the sequence of the triggering packet
   *
   * Strongly supported:
   * - 0xA0 follows 0x20 in captures
   * - payload so far is 1 byte: 0x00
   * - plausible as a simple reception confirmation before subsequent 0x05 / 0x06 requests
   *
   * Therefore:
   * - conservative ACK display
   * - always output length and full payload
   * Preamble Unknown
   */

  const results = [];

  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  results.push({
    label: 'Type',
    value: 'ACK / short acknowledge?'
  });

  results.push({
    label: 'Note',
    value: 'plausible as direct confirmation of a preceding hub command'
  });

  results.push({
    label: 'Payload Length',
    value: `${payload.length} byte(s)`
  });

  if (payload.length === 0) {
    results.push({
      label: 'Interpretation',
      value: 'Empty payload'
    });
    return results;
  }

  if (payload.length >= 1) {
    results.push({
      label: 'ACK Byte?',
      value: `${payload[0]} (${toHex(payload[0])})`
    });
  }

  if (payload.length >= 2) {
    results.push({
      label: 'Byte[1]?',
      value: `${payload[1]} (${toHex(payload[1])})`
    });
  }

  if (payload.length >= 3) {
    results.push({
      label: 'Byte[2..]?',
      value: bytesToSpacedHex(payload.slice(2))
    });
  }

  results.push({
    label: 'Raw Payload',
    value: bytesToSpacedHex(payload)
  });

  return results;
};
