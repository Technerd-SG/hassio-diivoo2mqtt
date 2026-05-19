module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0x82 = Hub -> valve
   *
   * Observed variants:
   * ----------------------
   * 1) Short ACK
   *    Payload length 2
   *    Example:
   *    00 19 or 00 1B
   *
   * 2) ACK + time sync
   *    Payload length 7
   *    Example:
   *    00 1B 14 08 10 19 03
   *
   * Current reverse-engineering state:
   * ------------------------------------
   * - payload[0] = ACK / status byte?
   *   always 0x00 so far
   *
   * - For 2-byte payload:
   *   payload[1] = session / context token
   *   currently believed to mirror the last byte
   *   of the preceding 0x81 pairing response.
   *
   * - For 7-byte payload:
   *   payload[1..6] = 6-byte time block
   *
   *   Currently strongly supported layout:
   *   second =  t1 & 0x3F
   *   minute = ((t2 & 0x0F) << 2) | (t1 >> 6)
   *   hour   = ((t3 & 0x01) << 4) | (t2 >> 4)
   *   day    = (t3 >> 1) & 0x1F
   *   month  = ((t4 & 0x03) << 2) | (t3 >> 6)
   *   year   = 2020 + (t4 >> 2)   // hypothesis, fits so far
   *   dow    = t5 & 0x07
   *
   * Still open:
   * - t0
   * - upper 5 bits of t5
   * Preamble Short: 0x82: Short ACK:short
   */

  const results = [];

  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  if (payload.length < 2) {
    results.push({ label: 'Type', value: '0x82 packet (incomplete)' });
    results.push({ label: 'Raw Payload', value: bytesToSpacedHex(payload) });
    return results;
  }

  const ackByte = payload[0];

  if (payload.length === 2) {
    results.push({ label: 'Type', value: 'Short ACK' });
    results.push({
      label: 'ACK / Status Byte',
      value: `${ackByte} (${toHex(ackByte)})`
    });
    results.push({
      label: 'Context / Subtype Byte?',
      value: `${payload[1]} (${toHex(payload[1])})`
    });
    results.push({
      label: 'Note',
      value: 'Meaning still open; also observed as 0x02 in newer logs, so not to be assumed as a day token'
    });
    return results;
  }

  if (payload.length >= 7) {
    const timeBytes = payload.slice(1, 7);
    const decoded = utils.decodeTimeBlock6
      ? utils.decodeTimeBlock6(timeBytes)
      : null;

    results.push({ label: 'Type', value: 'ACK + full time block' });
    results.push({
      label: 'ACK / Status Byte',
      value: `${ackByte} (${toHex(ackByte)})`
    });

    if (decoded && decoded.valid) {
      results.push({ label: 'Date / Time', value: decoded.text });
      results.push({ label: 'Day', value: `${decoded.day}` });
      results.push({ label: 'Month', value: `${decoded.month}` });
      results.push({ label: 'Year', value: `${decoded.year}` });
      results.push({
        label: 'Day of Week Index',
        value: `${decoded.dowIndex} (${toHex(decoded.dowIndex)})`
      });

      const jsDow = new Date(Date.UTC(decoded.year, decoded.month - 1, decoded.day)).getUTCDay();
      results.push({
        label: 'Day matches date?',
        value: jsDow === decoded.dowIndex ? 'yes' : 'no'
      });

      results.push({
        label: 'Time Block Byte0 / Context?',
        value: `${decoded.t0} (${toHex(decoded.t0)})`
      });

      results.push({
        label: 'Time Block Flags (t5 >> 3)?',
        value: `${decoded.t5 >> 3} (${toHex(decoded.t5 >> 3)})`
      });
    }

    results.push({
      label: 'Time Bytes',
      value: bytesToSpacedHex(timeBytes)
    });

    if (payload.length > 7) {
      results.push({
        label: 'Extra Bytes?',
        value: bytesToSpacedHex(payload.slice(7))
      });
    }

    return results;
  }

  results.push({ label: 'Type', value: '0x82 packet (unknown variant)' });
  results.push({
    label: 'ACK / Status Byte',
    value: `${ackByte} (${toHex(ackByte)})`
  });
  results.push({ label: 'Raw Payload', value: bytesToSpacedHex(payload) });

  return results;
};
