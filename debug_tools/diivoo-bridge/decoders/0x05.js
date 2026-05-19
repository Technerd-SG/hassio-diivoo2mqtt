module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0x05 = Parameter request from valve to hub
   *
   * Observed context:
   * - sent by the valve to retrieve channel-specific parameters from the hub
   * - often occurs as a response to CMD 0x20 (wake-up / ping?)
   * - the hub replies with CMD 0x85
   *
   * Current reverse-engineering state:
   * ------------------------------------
   * Payload length is typically 2 bytes:
   *
   * [0] Parameter group / namespace
   * [1] Channel / valve index
   *
   * Observed:
   * - 0x06 = irrigation settings / duration / interval / rain delay?
   * - payload[1] appears to be a direct channel / zone index
   *   (e.g. 0x01 = channel 1, 0x02 = channel 2)
   * Preamble Unknown but probably short because valve -> hub doesnt need to wake up hub!!
   */

  const results = [];

  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  const categoryMap = {
    0x06: 'Irrigation settings / duration / interval / rain delay?',
  };

  results.push({ label: 'Type', value: 'Parameter request (valve -> hub)' });

  if (payload.length < 2) {
    results.push({
      label: 'Note',
      value: `Payload shorter than expected (${payload.length} bytes)`
    });
    results.push({
      label: 'Raw Payload',
      value: bytesToSpacedHex(payload)
    });
    return results;
  }

  const category = payload[0];
  const channelIndex = payload[1];
  const categoryText = categoryMap[category] || `Unknown (${toHex(category)})`;

  results.push({
    label: 'Parameter Group',
    value: `${category} (${toHex(category)})`
  });

  results.push({
    label: 'Parameter Group?',
    value: categoryText
  });

  results.push({
    label: 'Channel / Valve Index',
    value: `${channelIndex} (${toHex(channelIndex)})`
  });

  if (category === 0x06) {
    results.push({
      label: 'Action',
      value: `Requesting irrigation settings for channel/zone ${channelIndex}`
    });
  }

  if (payload.length > 2) {
    results.push({
      label: 'Extra Bytes?',
      value: bytesToSpacedHex(payload.slice(2))
    });
  }

  return results;
};
