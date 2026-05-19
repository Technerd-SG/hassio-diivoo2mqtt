module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0x85 = Hub -> valve
   *
   * Observed context:
   * - hub response to CMD 0x05
   * - carries channel-specific parameters / duration and interval values
   *
   * Current reverse-engineering state:
   * ------------------------------------
   * Payload length is typically 15 bytes:
   *
   * [0]      Sub-index / subtype (usually 0x00)
   * [1..2]   Watering duration in seconds (LE16)
   * [3..4]   Interval ON in seconds (LE16)
   * [5..6]   Interval OFF in seconds (LE16)
   * [7..8]   reserved / padding?
   * [9..12]  Rain delay as Tuya 32-bit date (LE32), 0 = off
   * [13..14] reserved / padding?
   * Preamble Short: 0x85: Parameter response (hub -> valve):short
   */

  const results = [];

  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  const hex16 = (value) => `0x${Number(value).toString(16).toUpperCase().padStart(4, '0')}`;
  const hex32 = (value) => `0x${Number(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

  const formatSeconds = (seconds) => {
    if (utils.secondsToHHMMSS) return utils.secondsToHHMMSS(seconds);

    const s = Number(seconds) || 0;
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  };

  results.push({ label: 'Type', value: 'Parameter response (hub -> valve)' });

  if (payload.length < 15) {
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

  const subIndex = payload[0];

  const durationSeconds = utils.decodeLittleEndianFromArray(payload, 1, 2);
  const intervalOnSeconds = utils.decodeLittleEndianFromArray(payload, 3, 2);
  const intervalOffSeconds = utils.decodeLittleEndianFromArray(payload, 5, 2);

  const reserved7to8 = payload.slice(7, 9);

  const rainDelayRaw = utils.decodeLittleEndianFromArray(payload, 9, 4);
  const rainDelayDecoded = rainDelayRaw !== 0 && utils.decodeTuya32BitDate
    ? utils.decodeTuya32BitDate(rainDelayRaw)
    : null;

  const reserved13to14 = payload.slice(13, 15);

  results.push({
    label: 'Sub-Index',
    value: `${subIndex} (${toHex(subIndex)})`
  });

  results.push({
    label: 'Watering Duration',
    value: `${durationSeconds} s (${formatSeconds(durationSeconds)}, ${hex16(durationSeconds)})`
  });

  results.push({
    label: 'Interval ON',
    value: `${intervalOnSeconds} s (${formatSeconds(intervalOnSeconds)}, ${hex16(intervalOnSeconds)})`
  });

  results.push({
    label: 'Interval OFF',
    value: `${intervalOffSeconds} s (${formatSeconds(intervalOffSeconds)}, ${hex16(intervalOffSeconds)})`
  });

  results.push({
    label: 'Reserved [7..8]?',
    value: bytesToSpacedHex(reserved7to8)
  });

  if (rainDelayRaw === 0) {
    results.push({
      label: 'Rain Delay',
      value: `OFF (${hex32(rainDelayRaw)})`
    });
  } else {
    results.push({
      label: 'Rain Delay RAW',
      value: `${rainDelayRaw} (${hex32(rainDelayRaw)})`
    });

    results.push({
      label: 'Rain Delay',
      value: rainDelayDecoded
        ? `Active until ${rainDelayDecoded.text}`
        : 'active but not decodable'
    });
  }

  results.push({
    label: 'Reserved [13..14]?',
    value: bytesToSpacedHex(reserved13to14)
  });

  if (payload.length > 15) {
    results.push({
      label: 'Extra Bytes?',
      value: bytesToSpacedHex(payload.slice(15))
    });
  }

  return results;
};
