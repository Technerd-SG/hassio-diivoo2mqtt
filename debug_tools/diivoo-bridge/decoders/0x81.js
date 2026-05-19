module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0x81 = Hub response to Hello / Resume / Bind-Restore
   *
   * Current reverse-engineering state:
   * ------------------------------------
   * Strongly supported:
   * - payload[1]  = device address in the gateway / app
   * - payload[2]  = channel code set / confirmed by the hub
   * - actual channel = payload[2] - 1
   * - payload[3]  = 0xE0 (const so far)
   * - payload[4]  = 0x01 (const so far)
   * - payload[5..8] = 32-bit Tuya date/time
   * - payload[9]  = day of week index
   *
   * Plausible hypothesis:
   * - payload[10] = context byte / day token
   *   likely correlates with the context byte from 0x82
   *   (especially t0 of the long 0x82 variant)
   *
   * Observed in March logs:
   * - long 0x82: 82 07 00 02 ...
   * - short 0x82: 82 02 00 02
   *   -> both 0x82 variants apparently share the same context value 0x02
   *
   * Open:
   * - exact semantics of payload[0]
   * - exact semantics of payload[10]
   * Preamble Short: 0x81: Pairing response / bind-restore:short
   */

  const results = [];

  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  if (payload.length < 11) {
    results.push({ label: 'Action', value: 'Hub responds (0x81, incomplete)' });
    results.push({ label: 'Raw Payload', value: bytesToSpacedHex(payload) });
    return results;
  }

  const subtypeByte = payload[0];
  const deviceAddress = payload[1];

  const channel = utils.decodeChannelCode
    ? utils.decodeChannelCode(payload[2])
    : {
        channelCode: payload[2],
        actualChannel: payload[2] > 0 ? payload[2] - 1 : null,
        text: payload[2] > 0
          ? `${payload[2] - 1} (derived: channel code - 1)`
          : 'Invalid / not derivable'
      };

  const magicA = payload[3];
  const magicB = payload[4];

  const tuyaRaw = utils.decodeLittleEndianFromArray(payload, 5, 4);
  const tuyaBytes = payload.slice(5, 9);

  const eventDate = utils.decodeTuya32BitDate
    ? utils.decodeTuya32BitDate(tuyaRaw)
    : null;

  const dowByte = payload[9];
  const timeByte0 = payload[10];

  let dowText = dowNames[dowByte] ?? '??';
  let dowMatches = null;

  if (eventDate && eventDate.year && eventDate.month && eventDate.day) {
    const jsDow = new Date(Date.UTC(eventDate.year, eventDate.month - 1, eventDate.day)).getUTCDay();
    dowMatches = jsDow === dowByte;
  }

  results.push({ label: 'Action', value: 'Hub responds to Hello / Resume / Bind-Restore' });

  results.push({
    label: 'Subtype Byte?',
    value: `${subtypeByte} (${toHex(subtypeByte)})`
  });

  results.push({
    label: 'Device Address',
    value: `${deviceAddress} (${toHex(deviceAddress)})`
  });

  results.push({
    label: 'Channel Code',
    value: `${channel.channelCode} (${toHex(channel.channelCode)})`
  });

  results.push({
    label: 'Assigned Channel',
    value: channel.text
  });

  results.push({
    label: 'Magic A',
    value: `${toHex(magicA)}${magicA === 0xE0 ? ' (const)' : ' (deviating?)'}`
  });

  results.push({
    label: 'Magic B',
    value: `${toHex(magicB)}${magicB === 0x01 ? ' (const)' : ' (deviating?)'}`
  });

  results.push({
    label: 'Tuya32 DateTime RAW',
    value: bytesToSpacedHex(tuyaBytes)
  });

  results.push({
    label: 'Tuya32 DateTime LE32',
    value: `${tuyaRaw} (0x${tuyaRaw.toString(16).toUpperCase().padStart(8, '0')})`
  });

  if (eventDate) {
    results.push({
      label: 'Date / Time',
      value: eventDate.text
    });
  }

  results.push({
    label: 'Day of Week Index',
    value: `${dowByte} (${toHex(dowByte)}) -> ${dowText}`
  });

  results.push({
    label: 'Day matches date?',
    value:
      dowMatches === null
        ? 'not checkable'
        : dowMatches
          ? 'yes'
          : 'no'
  });

  results.push({
    label: 'Context Byte / Day Token?',
    value: `${timeByte0} (${toHex(timeByte0)})`
  });

  results.push({
    label: 'Relation to 0x82?',
    value: 'likely correlates with the context byte of the 0x82 time block; relationship to the short form is plausible but not yet conclusively proven'
  });

  return results;
};
