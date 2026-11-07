// Field probe page: the CU's probe commands, its log, and what the log says about a reader's field. No DOM in here.
//
// The firmware (exp/field-probe) stops emulating while the probe is on. When a reader's LF field appears it measures
// the field in up to three rounds, and when an HF field appears it counts the ISO 14443-A frames the reader sends.
// The log survives the CU's sleep, so the CU can be taken to a reader on battery and read here afterwards.
//
// The safe part of a report says what kind of field it is. The private part holds the reader's commands decoded to
// bits and the first bytes of unknown HF frames: a reader can send a password in a command.

export const CMD = {
  CHANGE_DEVICE_MODE: 1001, // 1 reader, 0 tag
  GET_DEVICE_MODE: 1002,
  PROBE_MODE: 3160,
  PROBE_LOG: 3161,
  PROBE_CLEAR: 3162,
  PROBE_MEASURE: 3163,
  PROBE_CAPTURE: 3164,
  PROBE_CAPTURE_READ: 3165,
};
export const STATUS = {
  LF_TAG_OK: 0x40,
  DEVICE_MODE_ERROR: 0x66,
  INVALID_CMD: 0x67,
  SUCCESS: 0x68,
};
export const MOD = { LOW: 0, HIGH: 1, TONE: 2 };
export const MOD_NAMES = ["off", "on (constant load)", "tone (fc/8)"];
export const LOG_VERSION = 1;

const NOMINAL_HZ = 125000;
const FIELD_LEVEL = 200; // ADC counts: below this at p90, LF_RSSI saw no field

// ---------------------------------------------------------------- requests

export const reqMode = (on, envMode) =>
  envMode == null ? Uint8Array.of(on ? 1 : 0) : Uint8Array.of(on ? 1 : 0, envMode);
export const reqLog = (offset) => Uint8Array.of(offset >> 8, offset & 0xff);
export const reqCapture = ({ mod, rateKhz, n, ain = 0, gain = 6 }) =>
  Uint8Array.of(mod, rateKhz, n >> 8, n & 0xff, ain, gain);
export const reqCaptureRead = (chunk) => Uint8Array.of(chunk);

// The mode reply: on, envelope mode, log version, record size, log size.
export function parseMode(d) {
  if (d.length < 7) return null;
  return {
    on: d[0] === 1,
    envMode: d[1],
    version: d[2],
    recSize: (d[3] << 8) | d[4],
    logSize: (d[5] << 8) | d[6],
  };
}

// ---------------------------------------------------------------- the log (packed, little-endian; field_probe.h)

const LF_RECS = 12,
  DIPS = 40,
  LF_FIELDS = 32,
  HF_FIELDS = 32;
const HEADER = 20,
  CAP = 22,
  REC = 20 + 3 * CAP + DIPS * 6,
  LF_FIELD = 10,
  HF_FIELD = 26;
export const LOG_SIZE = HEADER + LF_RECS * REC + LF_FIELDS * LF_FIELD + HF_FIELDS * HF_FIELD;
export const REC_SIZE = REC;
const MAGIC = 0x31425046;

const FLAGS = { manual: 0x01, ended: 0x02, railed: 0x04, ambiguous: 0x08 };
export const CARRIER_HOW = [
  "none",
  "the load tone at two sample rates",
  "the envelope's line",
  "the load tone, assumed nearest 125 kHz",
];

function parseCap(v, o) {
  return {
    mode: v.getUint8(o),
    rateKhz: v.getUint8(o + 1),
    n: v.getUint16(o + 2, true),
    min: v.getInt16(o + 4, true),
    p10: v.getInt16(o + 6, true),
    p50: v.getInt16(o + 8, true),
    p90: v.getInt16(o + 10, true),
    max: v.getInt16(o + 12, true),
    noise: v.getUint16(o + 14, true),
    lineHz: v.getUint32(o + 16, true) / 1000,
    lineSnr: v.getInt16(o + 20, true) / 10,
  };
}

// One LF measurement round (fp_lf_rec_t), at byte o of v.
export function parseRec(v, o = 0) {
  const flags = v.getUint8(o + 9);
  const nDips = v.getUint8(o + 17);
  const dips = [];
  for (let i = 0; i < Math.min(nDips, DIPS); i++) {
    const p = o + 20 + 3 * CAP + 6 * i;
    const depth = v.getUint16(p + 4, true);
    dips.push({
      start: v.getUint16(p, true),
      width: v.getUint16(p + 2, true),
      depth: depth & 0x7fff,
      open: (depth & 0x8000) !== 0,
    });
  }
  return {
    wake: v.getUint16(o, true),
    field: v.getUint16(o + 2, true),
    tMs: v.getUint32(o + 4, true),
    round: v.getUint8(o + 8),
    manual: (flags & FLAGS.manual) !== 0,
    ended: (flags & FLAGS.ended) !== 0,
    railed: (flags & FLAGS.railed) !== 0,
    ambiguous: (flags & FLAGS.ambiguous) !== 0,
    carrierHz: v.getUint32(o + 10, true) / 1000,
    carrierSnr: v.getInt16(o + 14, true) / 10,
    carrierHow: v.getUint8(o + 16),
    dipsTotal: v.getUint16(o + 18, true),
    caps: [0, 1, 2].map((i) => parseCap(v, o + 20 + i * CAP)),
    dips,
  };
}

// The oldest first of the last min(count, max) entries of a ring.
function ring(count, max, read) {
  const out = [];
  for (let i = Math.max(0, count - max); i < count; i++) out.push(read(i % max));
  return out;
}

export function parseLog(bytes) {
  if (bytes.length < LOG_SIZE) return { error: `the log is ${bytes.length} bytes, expected ${LOG_SIZE}` };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = v.getUint32(0, true);
  const version = v.getUint8(4);
  const recSize = v.getUint16(8, true);
  if (magic !== MAGIC) return { error: "the log is empty or unreadable (no valid header)" };
  if (version !== LOG_VERSION || recSize !== REC)
    return { error: `log version ${version}, record ${recSize} bytes: this page reads version ${LOG_VERSION}` };
  const lfRecs = v.getUint16(12, true),
    lfFields = v.getUint16(14, true),
    hfFields = v.getUint16(16, true);
  const lfBase = HEADER,
    fieldBase = lfBase + LF_RECS * REC,
    hfBase = fieldBase + LF_FIELDS * LF_FIELD;
  const dur = (x) => (x === 0xffffffff ? null : x);
  return {
    on: v.getUint8(5) === 1,
    envMode: v.getUint8(6),
    wake: v.getUint16(10, true),
    counts: { lfRecs, lfFields, hfFields },
    rounds: ring(lfRecs, LF_RECS, (i) => parseRec(v, lfBase + i * REC)),
    lfFields: ring(lfFields, LF_FIELDS, (i) => {
      const o = fieldBase + i * LF_FIELD;
      return { wake: v.getUint16(o, true), tMs: v.getUint32(o + 2, true), durMs: dur(v.getUint32(o + 6, true)) };
    }),
    hfFields: ring(hfFields, HF_FIELDS, (i) => {
      const o = hfBase + i * HF_FIELD;
      const bits = v.getUint16(o + 20, true);
      return {
        wake: v.getUint16(o, true),
        tMs: v.getUint32(o + 2, true),
        durMs: dur(v.getUint32(o + 6, true)),
        frames: v.getUint16(o + 10, true),
        reqa: v.getUint16(o + 12, true),
        wupa: v.getUint16(o + 14, true),
        other: v.getUint16(o + 16, true),
        rxErrors: v.getUint16(o + 18, true),
        otherBits: bits,
        otherData: Array.from(new Uint8Array(bytes.buffer, bytes.byteOffset + o + 22, Math.min(4, (bits + 7) >> 3))),
      };
    }),
  };
}

// ---------------------------------------------------------------- what a round says

export function carrierClass(hz) {
  if (!hz) return null;
  if (Math.abs(hz - 134200) < 2500) return "134.2 kHz: animal ID (FDX-B / HDX)";
  if (Math.abs(hz - NOMINAL_HZ) < 2500) return "125 kHz";
  return `${(hz / 1000).toFixed(1)} kHz: not a usual LF carrier`;
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Command-like timing, as intervals between the starts of consecutive gaps (one bit each, the gap included). Hitag:
// a Proxmark sending `lf cmdread -d 50 -z 116 -o 166` measured 180 and 230 µs on a CU, with gaps of about 75 µs.
// T55xx: the T5577 datasheet's 24 and 56 field clocks for a 0 and a 1. Used only to name a likely family, and only
// when a burst has both a short and a long interval.
const FAMILIES = [
  { name: "Hitag (1, 2, S)", gap: [20, 120], zero: [130, 205], one: [205, 280] },
  { name: "T55xx / EM4x05 style downlink", gap: [50, 400], zero: [120, 260], one: [380, 520] },
];
const HITAG_COMMANDS = [
  { bits: "11000", name: "Hitag 2 / S start (START_AUTH)" },
  { bits: "00110", name: "Hitag 1 / S start" },
  { bits: "11010", name: "Hitag S start" },
];

// The dips of one envelope capture, grouped into bursts of commands and long field-off stretches.
export function analyseDips(rec) {
  const env = rec.caps[1];
  const usPer = env.rateKhz ? 1000 / env.rateKhz : 10;
  const ds = rec.dips.map((d) => ({ ...d, startUs: d.start * usPer, widthUs: d.width * usPer }));
  const fieldOff = ds.filter((d) => d.widthUs >= 2000);
  const short = ds.filter((d) => d.widthUs < 2000);
  const bursts = [];
  for (const d of short) {
    const b = bursts.at(-1);
    if (b && d.startUs - (b.at(-1).startUs + b.at(-1).widthUs) < 3000) b.push(d);
    else bursts.push([d]);
  }
  const out = bursts.map((b) => {
    const intervals = b.slice(1).map((d, i) => d.startUs - b[i].startUs);
    const widths = b.map((d) => d.widthUs);
    let bits = "";
    let lo = null,
      hi = null;
    if (intervals.length) {
      const mn = Math.min(...intervals),
        mx = Math.max(...intervals);
      const two = mx > 1.25 * mn;
      const cut = two ? (mn + mx) / 2 : Infinity;
      bits = intervals.map((x) => (x > cut ? "1" : "0")).join("");
      lo = median(intervals.filter((x) => x <= cut));
      hi = two ? median(intervals.filter((x) => x > cut)) : null;
      if (!two) bits = null; // one interval class: no way to tell 0 from 1
    }
    const gap = median(widths);
    const family = FAMILIES.find(
      (f) =>
        gap >= f.gap[0] &&
        gap <= f.gap[1] &&
        lo != null &&
        hi != null &&
        lo >= f.zero[0] &&
        lo <= f.zero[1] &&
        hi >= f.one[0] &&
        hi <= f.one[1],
    );
    // A reader may end a command with one more gap, or not: then the bits are one short, so match on the prefix.
    const command =
      family?.name.startsWith("Hitag") && bits
        ? HITAG_COMMANDS.find((c) => c.bits.startsWith(bits) && bits.length >= 4)
        : null;
    return { gaps: b.length, gapUs: gap, shortUs: lo, longUs: hi, bits, family: family?.name ?? null, command: command?.name ?? null };
  });
  return { usPer, fieldOff, bursts: out, open: ds.some((d) => d.open) };
}

export function describeRound(rec) {
  const level = rec.caps[0];
  const env = rec.caps[1];
  const field = level.p90 >= FIELD_LEVEL || env.p90 >= FIELD_LEVEL;
  const dips = analyseDips(rec);
  return {
    field,
    level: level.p50,
    // The level capture's p90 can be at the rail while its p50 is near zero: the field was on for part of it.
    railed: rec.railed && level.p50 >= 16000,
    carrier: rec.carrierHz
      ? {
          hz: rec.carrierHz,
          ppm: ((rec.carrierHz - NOMINAL_HZ) / NOMINAL_HZ) * 1e6,
          snr: rec.carrierSnr,
          how: CARRIER_HOW[rec.carrierHow] ?? "?",
          class: carrierClass(rec.carrierHz),
          ambiguous: rec.ambiguous,
          // Only the envelope's line has matched a known carrier on the bench. The load tone's fallback, used when
          // the field switched during the envelope capture, gave a carrier 4860 ppm off on a Proxmark3.
          sure: rec.carrierHow === 2,
        }
      : null,
    dips,
    dipsTotal: rec.dipsTotal,
  };
}

// The overall verdict for the LF side, from every round that saw a field.
export function lfVerdict(rounds) {
  const seen = rounds.map(describeRound).filter((d) => d.field);
  if (!seen.length) return { field: false, text: "No LF field measured." };
  const carriers = seen.map((d) => d.carrier).filter(Boolean);
  const best = carriers.filter((c) => c.sure).sort((a, b) => b.snr - a.snr)[0] ?? null;
  const bursts = seen.flatMap((d) => d.dips.bursts);
  const commands = bursts.filter((b) => b.gaps >= 3);
  const offs = seen.flatMap((d) => d.dips.fieldOff);
  let talk;
  if (commands.length) {
    const fam = commands.map((b) => b.family).find(Boolean);
    const cmd = commands.map((b) => b.command).find(Boolean);
    talk =
      "The reader sends commands (short gaps in its field), so it talks first: a tag has to be asked before it answers." +
      (fam ? ` The timing fits ${fam}.` : "") +
      (cmd ? ` One burst matches the ${cmd}.` : "");
  } else if (offs.length) {
    talk = "The field switches off for milliseconds at a time, with no command-like gaps: a reader that pulses its field.";
  } else {
    talk =
      "The field is a steady carrier with no gaps: the reader waits for a tag to talk first (EM4100, HID Prox, Indala, Paradox and most 125 kHz access cards).";
  }
  return { field: true, best, talk, commands: commands.length, offs: offs.length };
}

// The HF side: the fields the CU saw and the 14443-A frames in them.
export function hfVerdict(fields) {
  if (!fields.length) return { field: false, text: "No HF field seen." };
  const frames = fields.reduce((n, f) => n + f.frames, 0);
  const polls = fields.reduce((n, f) => n + f.reqa + f.wupa, 0);
  const durs = fields.map((f) => f.durMs).filter((x) => x != null);
  const starts = fields.map((f) => [f.wake, f.tMs]);
  const gaps = [];
  for (let i = 1; i < starts.length; i++)
    if (starts[i][0] === starts[i - 1][0]) gaps.push(starts[i][1] - starts[i - 1][1]);
  const medDur = median(durs),
    medGap = median(gaps);
  let text;
  if (polls) text = "The reader polls for ISO 14443-A cards (REQA / WUPA): MIFARE, NTAG, DESFire and similar.";
  else if (frames)
    text = "The reader sends frames, but no 14443-A poll: it may speak another HF protocol the CU can't decode.";
  else
    text =
      "The CU saw the HF field but no 14443-A frame: the reader polls another HF type (ISO 14443-B, ISO 15693, FeliCa, iCLASS), or sends nothing until a card loads its field.";
  // A reader in low-power card detection pulses its field for a few ms at most. A Proxmark3 between read attempts
  // switches it off and on every 30 to 130 ms, which is a reader retrying, not detection.
  if (medDur != null && fields.length >= 3) {
    const timing = `about ${medDur} ms on${medGap ? ` every ${medGap} ms` : ""}`;
    text +=
      medDur < 10
        ? ` Its field comes in short pulses (${timing}), as a reader in low-power card detection does.`
        : ` Its field switches on and off (${timing}).`;
  }
  return { field: true, text, frames, polls, medDur, medGap, count: fields.length };
}

// ---------------------------------------------------------------- reports (markdown)

const kHz = (hz) => `${(hz / 1000).toFixed(3)} kHz`;
const sgn = (x, d = 0) => (x >= 0 ? "+" : "") + x.toFixed(d);

export function safeMarkdown(r) {
  const L = [];
  L.push("**Chameleon Ultra field probe report** (safe to share)", "");
  L.push(`- Firmware: ${r.firmware}`);
  L.push(`- Log: ${r.log.counts.lfFields} LF field(s), ${r.log.counts.lfRecs} LF round(s), ${r.log.counts.hfFields} HF field(s); envelope LF_MOD ${MOD_NAMES[r.log.envMode] ?? r.log.envMode}`);
  L.push("", "**LF (125 kHz band)**");
  const lf = lfVerdict(r.log.rounds);
  if (!lf.field) L.push(`- ${lf.text}`);
  else {
    if (lf.best)
      L.push(
        `- Carrier: ${kHz(lf.best.hz)} (${sgn(lf.best.ppm)} ppm from 125 kHz on the CU's clock, SNR ${lf.best.snr.toFixed(1)} dB, placed by ${lf.best.how}${lf.best.ambiguous ? ", ambiguous" : ""}): ${lf.best.class}`,
      );
    else
      L.push(
        "- Carrier: not measured, because the field switched during every measurement.",
      );
    L.push(`- ${lf.talk}`);
  }
  for (const rec of r.log.rounds) {
    const d = describeRound(rec);
    const where = rec.manual ? "measured by command" : `field ${rec.field} round ${rec.round}`;
    const parts = [
      `wake ${rec.wake} +${(rec.tMs / 1000).toFixed(1)} s, ${where}`,
      d.field ? `level ${d.level}${d.railed ? " (railed)" : ""}` : "no field",
    ];
    if (d.carrier)
      parts.push(`carrier ${kHz(d.carrier.hz)} ${d.carrier.snr.toFixed(0)} dB${d.carrier.sure ? "" : " (uncertain: the field switched)"}`);
    parts.push(`${rec.dipsTotal} dip(s)`);
    // A reader that repeats a command gives the same burst several times: one entry each, with a count.
    // The gap width varies by a sample or so between repeats, so it stays out of the comparison.
    const seen = new Map();
    for (const b of d.dips.bursts.filter((b) => b.gaps >= 2)) {
      const key = `${b.gaps}|${b.shortUs}|${b.longUs}|${b.family}|${b.command}`;
      const e = seen.get(key) ?? { b, count: 0 };
      e.count++;
      seen.set(key, e);
    }
    for (const { b, count } of seen.values()) {
      const text = `burst of ${b.gaps} gaps ~${b.gapUs?.toFixed(0)} µs, intervals ${b.shortUs?.toFixed(0) ?? "-"}/${b.longUs?.toFixed(0) ?? "-"} µs${b.family ? ` (${b.family})` : ""}${b.command ? `: ${b.command}` : ""}`;
      parts.push(count > 1 ? `${count} × ${text}` : text);
    }
    if (d.dips.fieldOff.length) parts.push(`${d.dips.fieldOff.length} field-off stretch(es) ≥ 2 ms`);
    if (rec.ended) parts.push("field gone by the end");
    L.push(`  - ${parts.join("; ")}`);
  }
  if (r.log.lfFields.length) {
    const durs = r.log.lfFields.map((f) => (f.durMs == null ? "ongoing" : `${f.durMs} ms`));
    L.push(`- LF field durations: ${durs.join(", ")}`);
  }
  L.push("", "**HF (13.56 MHz)**");
  const hf = hfVerdict(r.log.hfFields);
  L.push(`- ${hf.text}`);
  if (hf.field)
    L.push(`- ${hf.count} field(s), ${hf.frames} frame(s), ${hf.polls} REQA/WUPA, ${r.log.hfFields.reduce((n, f) => n + f.rxErrors, 0)} with receive errors`);
  return L.join("\n");
}

export function privateMarkdown(r) {
  const L = ["**Private details**", ""];
  for (const rec of r.log.rounds) {
    const d = describeRound(rec);
    const bits = d.dips.bursts.filter((b) => b.bits).map((b) => b.bits);
    if (bits.length) L.push(`- wake ${rec.wake} +${(rec.tMs / 1000).toFixed(1)} s: command bits, from the intervals between gaps: ${bits.join(" ")}`);
  }
  for (const f of r.log.hfFields)
    if (f.other)
      L.push(`- HF wake ${f.wake} +${(f.tMs / 1000).toFixed(1)} s: last non-poll frame ${f.otherBits} bits, starts ${f.otherData.map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  if (L.length === 2) L.push("- none");
  return L.join("\n");
}
