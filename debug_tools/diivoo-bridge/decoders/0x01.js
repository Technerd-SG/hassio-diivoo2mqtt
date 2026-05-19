module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0x01 = Hello / Join-Announce from valve
   *
   * Current reverse-engineering state:
   * ------------------------------------
   * This packet occurs not only on fresh pairing but also on startup
   * of an already known/paired valve.
   *
   * Strong hypotheses:
   * - Header target ID = 0x00000000 => Broadcast / hub search
   * - payload[0] = suggested / currently used RF channel code
   * - actual RF channel = payload[0] - 1
   * - payload[1..6] = Device signature block
   *
   * Device signature block:
   * - payload[1]    = marker / const byte (observed 0xFF so far)
   * - payload[2..3] = hardware / model ID (little endian)
   * - payload[4]    = device category
   * - payload[5]    = protocol / HW revision
   * - payload[6]    = firmware version / build revision
   *
   * Observed:
   * - 06 FF 26 10 01 07 02
   *   -> RF channel code 6 (= RF channel 5)
   *   -> Model ID 0x1026
   *   -> Category 0x01
   *   -> Revision 0x07
   *   -> Firmware 0x02
   *
   * - 05 FF 1F 0D 01 07 67
   *   -> RF channel code 5 (= RF channel 4)
   *   -> Model ID 0x0D1F
   *   -> Category 0x01
   *   -> Revision 0x07
   *   -> Firmware 0x67
   *   -> observed on WT-07W (1-zone / 1-output)
   *
   * Relationship with 0x81:
   * - The hub responds with 0x81 and can confirm or override the suggested channel.
   * Preamble Unknown but probably short because valve -> hub doesnt need to wake up hub!!
   */

  const results = [];

  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  if (payload.length < 7) {
    results.push({
      label: 'Action',
      value: 'Valve announces itself (0x01 Hello / Join-Announce, incomplete)'
    });
    results.push({ label: 'Raw Payload', value: bytesToSpacedHex(payload) });
    return results;
  }

  const channel = utils.decodeChannelCode
    ? utils.decodeChannelCode(payload[0])
    : {
        channelCode: payload[0],
        actualChannel: payload[0] > 0 ? payload[0] - 1 : null,
        text: payload[0] > 0
          ? `${payload[0] - 1} (derived: RF channel code - 1)`
          : 'Invalid / not derivable'
      };

  const markerByte = payload[1];
  const hardwareId = (payload[3] << 8) | payload[2];
  const categoryByte = payload[4];
  const revisionByte = payload[5];
  const firmwareByte = payload[6];

  const signatureBytes = payload.slice(1, 7);

  const MODEL_MAP = {
    0x1026: 'Diivoo WT-13W 4-zone (Cloud Model 272)',
    0x0D1F: 'Diivoo WT-07W 1-zone / 1-output',
  };

  const CATEGORY_MAP = {
    0x01: 'Irrigation (Cloud Type 38)',
  };

  const modelText = MODEL_MAP[hardwareId] || 'Unknown model';
  const categoryText = CATEGORY_MAP[categoryByte] || 'Unknown';

  results.push({
    label: 'Action',
    value: 'Valve announces itself (Hello / Join-Announce)'
  });

  results.push({
    label: 'RF Channel Code',
    value: `${channel.channelCode} (${toHex(channel.channelCode)})`
  });

  results.push({
    label: 'Derived RF Channel',
    value: channel.text
  });

  results.push({
    label: 'Marker / Const Byte',
    value: `${markerByte} (${toHex(markerByte)})${markerByte === 0xFF ? ' (const so far)' : ' (deviating?)'}`
  });

  results.push({
    label: 'Hardware / Model ID',
    value: `0x${hardwareId.toString(16).padStart(4, '0').toUpperCase()} -> ${modelText}`
  });

  results.push({
    label: 'Device Category',
    value: `${categoryByte} (${toHex(categoryByte)}) -> ${categoryText}`
  });

  results.push({
    label: 'Protocol / HW Revision',
    value: `${revisionByte} (${toHex(revisionByte)})`
  });

  results.push({
    label: 'Firmware Version / Build',
    value: `v${firmwareByte} (${toHex(firmwareByte)})`
  });

  results.push({
    label: 'Device Signature Block',
    value: bytesToSpacedHex(signatureBytes)
  });

  if (payload.length > 7) {
    results.push({
      label: 'Extra Bytes?',
      value: bytesToSpacedHex(payload.slice(7))
    });
  }

  return results;
};
