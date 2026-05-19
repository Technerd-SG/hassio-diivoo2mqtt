module.exports = (payload, utils) => {
  /*
   * Decoder for CMD 0x86 = Hub -> valve, schedule response
   *
   * Observed context:
   * - hub response to CMD 0x06
   * - carries watering schedules / plan slots
   * - when more pages are indicated, the valve requests them via follow-up 0x06
   *
   * Observed variants:
   * ----------------------
   * 1) Schedule response with one or more 7-byte plan blocks
   *    [pageInfo, ...planBlocks]
   *
   * 2) Empty / deleted schedule response
   *    Payload length 1
   *    [0x00]
   *
   * Current reverse-engineering state:
   * ------------------------------------
   * payload[0] = pagination value / remaining pages?
   *
   * Each plan block has 7 bytes:
   * [0]    Status / day mask (B0)
   * [1]    Time Low (B1)
   * [2]    Time High (B2)
   * [3..4] Target duration in seconds (LE16)
   * [5..6] Reserved / padding
   *
   * Water-Time structure from B0/B1/B2:
   * - enabled = bit 7 in B0
   * - day bits in B0 (only meaningful for CUSTOM_DAYS)
   * - minute = B1 & 0x3F
   * - hour   = (((B2 - 0x48) & 0x07) << 2) | (B1 >> 6)
   * - modeCode = (B2 - 0x48) >> 3
   *
   * Current reverse-engineering state:
   * ------------------------------------
   * payload[0] = page index / pagination flag (how many pages follow?)
   * * Each plan block consists of 7 bytes:
   * Offset + 0 = Status / day mask (B0)
   * Offset + 1 = Time Low (B1)
   * Offset + 2 = Time High (B2)
   * Offset + 3..4 = Watering duration in seconds (little endian)
   * Offset + 5..6 = Padding / reserved (usually 00 00)
   *
   * Detailed decoding of the 3-byte "Water-Time" structure (B0, B1, B2):
   * ------------------------------------------------------------------
   * ┌───── B0 (Status) ───┐   ┌───── B1 (Time Lo) ─┐   ┌───── B2 (Time Hi) ─┐
   * 7 6 5 4 3 2 1 0           7 6 5 4 3 2 1 0          7 6 5 4 3 2 1 0
   * │ │ │ │ │ │ │ │           │ │ │ │ │ │ │ │          │ │ │ │ │ │ │ │
   * │ │ │ │ │ │ │ └── Sun     │ │ │ │ │ │ │ └─ Min 0   │ │ │ └┴┴┴┴┴┴ Hour (bit 2-4)
   * │ │ │ │ │ │ └───── Mon    │ │ │ │ │ │ └─── Min 1   │ │ │
   * │ │ │ │ │ └────── Tue     │ │ │ │ │ └───── Min 2   │ └┴┴──────── Mode (00-11)
   * │ │ │ │ └─────── Wed      │ │ │ │ └─────── Min 3   │               00 = EVERY_DAY
   * │ │ │ └──────── Thu       │ │ │ └───────── Min 4   │               01 = ODD_DATES
   * │ │ └──────── Fri         │ │ └─────────── Min 5   │               10 = EVEN_DATES
   * │ └────────── Sat         │ └───────────── Hour 0  │               11 = CUSTOM_DAYS
   * └──── ENABLE (1=Active)   └─────────────── Hour 1  │                8 = INTERVAL_MODE
   * └──────────── Const "010" (0x48)
   * Legend:
   * - Day bits (Sun…Sat) are only evaluated when mode = 11 (CUSTOM_DAYS).
   *   For mode 00-10 B0 is simply 0x80 (on) or 0x00 (off).
   * Preamble Short: 0x86: Schedule response (hub -> valve):short
   * Important observation:
   * ---------------------
   * modeCode appears to be a bit field:
   *
   * - baseMode   = modeCode & 0x03
   * - isInterval = (modeCode & 0x08) !== 0
   *
   * Observed so far:
   * 0  = EVERY_DAY
   * 1  = ODD_DATES
   * 2  = EVEN_DATES
   * 3  = CUSTOM_DAYS
   * 8  = INTERVAL + EVERY_DAY
   * 9  = INTERVAL + ODD_DATES
   * 10 = INTERVAL + EVEN_DATES
   * 11 = INTERVAL + CUSTOM_DAYS
   *
   * This allows combining interval / mist mode and base mode.
   * Example:
   * - modeCode 11 = INTERVAL + CUSTOM_DAYS
   * - status / day byte 0xAB = ENABLE + Sun + Mon + Wed + Fri
   *
   * Preamble Short: 0x86: Schedule response (hub -> valve):short
   */

  const results = [];

  const toHex = utils.toHex;
  const bytesToSpacedHex = utils.bytesToSpacedHex
    ? utils.bytesToSpacedHex
    : (arr) => arr.map(toHex).join(' ');

  const formatSeconds = (seconds) => {
    if (utils.secondsToHHMMSS) return utils.secondsToHHMMSS(seconds);

    const s = Number(seconds) || 0;
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  };

  const BASE_MODE_MAP = {
    0: 'EVERY_DAY',
    1: 'ODD_DATES',
    2: 'EVEN_DATES',
    3: 'CUSTOM_DAYS',
  };

  const DAY_DEFS = [
    { bit: 0x01, short: 'Sun' },
    { bit: 0x02, short: 'Mon' },
    { bit: 0x04, short: 'Tue' },
    { bit: 0x08, short: 'Wed' },
    { bit: 0x10, short: 'Thu' },
    { bit: 0x20, short: 'Fri' },
    { bit: 0x40, short: 'Sat' },
  ];

  function decodePlanBlock(block) {
    const statusByte = block[0];
    const low = block[1];
    const high = block[2];

    const highAdjusted = high - 0x48;
    const enabled = (statusByte & 0x80) !== 0;

    const modeCode = highAdjusted >> 3;
    const baseMode = modeCode & 0x03;
    const isInterval = (modeCode & 0x08) !== 0;

    const baseModeText = BASE_MODE_MAP[baseMode] || `Unknown (${baseMode})`;

    let modeText = baseModeText;
    if (isInterval) {
      modeText = `INTERVAL_MODE + ${baseModeText}`;
    }

    const minute = low & 0x3F;
    const hour = ((highAdjusted & 0x07) << 2) | (low >> 6);

    const activeDays = DAY_DEFS
      .filter(d => (statusByte & d.bit) !== 0)
      .map(d => d.short);

    const durationSeconds = utils.decodeLittleEndianFromArray(block, 3, 2);
    const reserved = block.slice(5, 7);

    return {
      statusByte,
      low,
      high,
      highAdjusted,
      enabled,
      modeCode,
      baseMode,
      baseModeText,
      isInterval,
      modeText,
      hour,
      minute,
      activeDays,
      durationSeconds,
      reserved,
      raw: block,
    };
  }

  results.push({ label: 'Type', value: 'Schedule response (hub -> valve)' });

  if (payload.length === 1 && payload[0] === 0x00) {
    results.push({
      label: 'Status',
      value: 'Plan slot is EMPTY / DELETED'
    });
    return results;
  }

  if (payload.length < 2) {
    results.push({
      label: 'Note',
      value: `Payload too short or unknown (${payload.length} byte(s))`
    });
    results.push({
      label: 'Raw Payload',
      value: bytesToSpacedHex(payload)
    });
    return results;
  }

  const pageInfo = payload[0];
  const dataBytes = payload.slice(1);
  const numPlans = Math.floor(dataBytes.length / 7);
  const trailingBytes = dataBytes.length % 7;

  results.push({
    label: 'Pagination Value',
    value: `${pageInfo} (${toHex(pageInfo)})`
  });

  results.push({
    label: 'More Pages?',
    value: `${pageInfo} more page(s) follow?`
  });

  results.push({
    label: 'Contained Plan Blocks',
    value: `${numPlans}`
  });

  if (trailingBytes > 0) {
    results.push({
      label: 'Anomaly',
      value: `${trailingBytes} trailing byte(s) outside full 7-byte plan blocks`
    });
  }

  for (let i = 0; i < numPlans; i++) {
    const offset = 1 + (i * 7);
    const block = payload.slice(offset, offset + 7);
    const plan = decodePlanBlock(block);

    results.push({
      label: `--- Plan ${i + 1}`,
      value: '------------------------'
    });

    results.push({
      label: '  Raw Block',
      value: bytesToSpacedHex(plan.raw)
    });

    results.push({
      label: '  Enabled',
      value: plan.enabled ? 'YES' : 'NO'
    });

    results.push({
      label: '  Status / Day Byte',
      value: `${plan.statusByte} (${toHex(plan.statusByte)})`
    });

    results.push({
      label: '  Mode',
      value: plan.modeText
    });

    results.push({
      label: '  Mode Code',
      value: `${plan.modeCode}`
    });

    results.push({
      label: '  Base Mode',
      value: `${plan.baseMode} (${plan.baseModeText})`
    });

    results.push({
      label: '  Interval Mode?',
      value: plan.isInterval ? 'YES' : 'NO'
    });

    results.push({
      label: '  Start Time',
      value: `${String(plan.hour).padStart(2, '0')}:${String(plan.minute).padStart(2, '0')}`
    });

    if (plan.baseMode === 3) {
      results.push({
        label: '  Days',
        value: plan.activeDays.length > 0 ? plan.activeDays.join(', ') : 'None'
      });
    } else if (plan.baseMode === 0) {
      results.push({
        label: '  Days',
        value: 'Every day'
      });
    } else if (plan.baseMode === 1) {
      results.push({
        label: '  Days',
        value: 'Odd calendar days'
      });
    } else if (plan.baseMode === 2) {
      results.push({
        label: '  Days',
        value: 'Even calendar days'
      });
    }

    results.push({
      label: '  Target Duration',
      value: `${plan.durationSeconds} s (${formatSeconds(plan.durationSeconds)})`
    });

    results.push({
      label: '  Reserved [5..6]?',
      value: bytesToSpacedHex(plan.reserved)
    });
  }

  if (trailingBytes > 0) {
    results.push({
      label: 'Trailing Bytes?',
      value: bytesToSpacedHex(payload.slice(payload.length - trailingBytes))
    });
  }

  return results;
};
