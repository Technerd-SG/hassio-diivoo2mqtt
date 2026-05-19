module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0x06 = Schedule request from valve to hub
   *
   * Observed context:
   * - the valve requests programmed watering schedules for a zone
   * - the hub responds with CMD 0x86
   * - if 0x86 indicates more data, the valve requests further pages via payload[2]
   *
   * Current reverse-engineering state:
   * ------------------------------------
   * Payload length is typically 3 bytes:
   *
   * [0] Request / namespace byte
   * [1] Channel / valve index
   * [2] Page index / pagination
   *
   * Observed:
   * - payload[0] = 0x06 for schedule requests
   * - payload[1] appears to be a direct channel / zone index
   *   (0x01 = zone 1, 0x02 = zone 2, ...)
   * - payload[2] = page index
   *   (0x00 = first page, 0x01 = second page, ...)
   * Preamble Unknown but probably short because valve -> hub doesnt need to wake up hub!!
   */

  const results = [];

  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  results.push({ label: 'Type', value: 'Schedule request (valve -> hub)' });

  if (payload.length < 3) {
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

  const requestNamespace = payload[0];
  const channelIndex = payload[1];
  const pageIndex = payload[2];

  results.push({
    label: 'Request / Namespace Byte',
    value: `${requestNamespace} (${toHex(requestNamespace)})`
  });

  results.push({
    label: 'Channel / Valve Index',
    value: `${channelIndex} (${toHex(channelIndex)})`
  });

  results.push({
    label: 'Page Index',
    value: `${pageIndex} (${toHex(pageIndex)})`
  });

  if (requestNamespace === 0x06) {
    results.push({
      label: 'Action',
      value: `Requesting watering schedules for channel/zone ${channelIndex} (page ${pageIndex})`
    });
  }

  if (payload.length > 3) {
    results.push({
      label: 'Extra Bytes?',
      value: bytesToSpacedHex(payload.slice(3))
    });
  }

  return results;
};
