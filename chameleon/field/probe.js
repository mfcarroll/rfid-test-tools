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
// The Hitag 2 reader-side authentication mode (fp_lf_rec_t.auth_mode / FP_AUTH_*): the length of the reader's command
// after the tag's UID reply. The firmware reads the frame's length only; it classifies the install, not any secret.
export const AUTH_MODE = ["none", "password", "crypto", "ambiguous"];
export const LOG_VERSION = 5;

const NOMINAL_HZ = 125000;
// ADC counts: below this at p90, LF_RSSI saw no field (FP_FIELD_MIN). With no field, the 1 ms means of two CUs read 40
// to 115. Log version 5's off level is the larger of this and a tenth of the field's full level.
const FIELD_LEVEL = 200;

// ---------------------------------------------------------------- requests

export const reqMode = (on, envMode) =>
  envMode == null ? Uint8Array.of(on ? 1 : 0) : Uint8Array.of(on ? 1 : 0, envMode);
// The log from a byte offset, at most max bytes (the firmware sends up to 4000 if max is left out).
export const reqLog = (offset, max) =>
  max == null
    ? Uint8Array.of(offset >> 8, offset & 0xff)
    : Uint8Array.of(offset >> 8, offset & 0xff, max >> 8, max & 0xff);
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
  RUNS = 48,
  LEVEL_DIPS = 32,
  LF_FIELDS = 32,
  HF_FIELDS = 32;
export const HEADER = 36;
const CAP = 22,
  TIMING = 20 + 3 * CAP + DIPS * 6 + 2, // after carrier_n
  AUTH = TIMING + 8 + RUNS * 2, // after runs[]: the Hitag auth-mode summary (log v4)
  LEVEL = AUTH + 5, // after the auth summary: the timing capture's full level and dips (log v5)
  REC = LEVEL + 7 + LEVEL_DIPS * 6,
  LF_FIELD = 12,
  HF_FIELD = 26;
// Log versions 3 (firmware 132414dc) and 4 (a5c8e8c5) are the same layout without the newer fields at the end of a
// record, so the page still reads a CU that a tester flashed before version 5 came out. Their timing runs split the
// field at fractions of its swing, not at an absolute level. levelOf re-reads them.
const REC_OF = { 3: AUTH, 4: LEVEL, 5: REC };
export const recSizeOf = (version) => REC_OF[version];
export const logSize = (version) => HEADER + LF_RECS * REC_OF[version] + LF_FIELDS * LF_FIELD + HF_FIELDS * HF_FIELD;
export const LOG_SIZE = logSize(LOG_VERSION);
export const REC_SIZE = REC;
const MAGIC = 0x31425046;

const FLAGS = { manual: 0x01, ended: 0x02, railed: 0x04, ambiguous: 0x08, switched: 0x10 };
export const CARRIER_HOW = [
  "none",
  "the load tone at two sample rates",
  "the envelope's line",
  "the load tone, assumed nearest 125 kHz",
  "the envelope's line over its longest stretch with the field on",
];
const SURE = [2, 4]; // the envelope's line, whole or gated: the only ones matched to a known carrier on the bench

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
export function parseRec(v, o = 0, version = LOG_VERSION) {
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
    switched: (flags & FLAGS.switched) !== 0,
    carrierHz: v.getUint32(o + 10, true) / 1000,
    carrierSnr: v.getInt16(o + 14, true) / 10,
    carrierHow: v.getUint8(o + 16),
    dipsTotal: v.getUint16(o + 18, true),
    caps: [0, 1, 2].map((i) => parseCap(v, o + 20 + i * CAP)),
    dips,
    carrierN: v.getUint16(o + TIMING - 2, true),
    timing: parseTiming(v, o + TIMING),
    ...(version >= 4
      ? {
          authMode: v.getUint8(o + AUTH),
          authStartGaps: v.getUint8(o + AUTH + 1),
          authGaps: v.getUint8(o + AUTH + 2),
          authSpan: v.getUint16(o + AUTH + 3, true),
        }
      : { authMode: 0, authStartGaps: 0, authGaps: 0, authSpan: 0 }),
    version,
    ...(version >= 5 ? parseLevel(v, o + LEVEL) : {}),
  };
}

// Log version 5: the timing capture's full level, its off level, and its dips (start and width in ms, depth in counts
// below the full level).
function parseLevel(v, o) {
  const n = Math.min(v.getUint8(o + 4), LEVEL_DIPS);
  const dips = [];
  for (let i = 0; i < n; i++) {
    const p = o + 7 + 6 * i;
    const depth = v.getUint16(p + 4, true);
    dips.push({ start: v.getUint16(p, true), ms: v.getUint16(p + 2, true), depth: depth & 0x7fff, open: (depth & 0x8000) !== 0 });
  }
  return { timingFull: v.getInt16(o, true), timingOffAt: v.getInt16(o + 2, true), levelDipsTotal: v.getUint16(o + 5, true), levelDips: dips };
}

// The timing capture (1.79 s, LF_MOD off, 1 ms means): the field's stretches, alternately on and off.
function parseTiming(v, o) {
  const n = Math.min(v.getUint8(o + 5), RUNS);
  const firstOn = v.getUint8(o + 4) === 1;
  const runs = [];
  for (let i = 0; i < n; i++) runs.push({ on: (i % 2 === 0) === firstOn, ms: v.getUint16(o + 8 + 2 * i, true) });
  return { low: v.getInt16(o, true), high: v.getInt16(o + 2, true), total: v.getUint16(o + 6, true), runs };
}

// What the timing capture says: a steady field, or a pulsing one with its on and off times. The first and last
// stretches are cut by the capture's ends, so only the ones between count.
export function describeTiming(t) {
  if (!t || !t.total) return null;
  if (t.total === 1) return t.runs[0]?.on ? { steady: true } : null;
  // One switch is a field that came or went during the capture, not a pulse.
  if (t.total === 2) return { steady: false, edge: true, on: [], off: [], onMs: null, offMs: null };
  const inner = t.runs.slice(1, t.total === t.runs.length ? -1 : undefined);
  const on = inner.filter((r) => r.on).map((r) => r.ms);
  const off = inner.filter((r) => !r.on).map((r) => r.ms);
  return { steady: false, on, off, onMs: median(on), offMs: median(off), cut: t.total > t.runs.length };
}

// A short off looks like a dip in the timing capture. With the load off, the CU's level falls with a time constant
// of about 4.5 ms when the field goes off, and comes back within a ms when it returns. On a bench CU under a PM3,
// offs of 2, 4 and 8 ms read as dips 2, 4 and 8 ms wide, down to 72, 43 and 14 % of the full level. With the field at
// the ADC's rail, the fall shows later: 4 and 8 ms went to 63 and 25 %. So an off of t ms leaves at most e^(-t/10) of
// the full level. A drop that stays well above that for its length is a dip.
export const offLikeAt = (ms) => Math.exp(-ms / 10) + 0.05;
const offLike = (frac, ms) => (frac == null || ms == null ? null : frac <= offLikeAt(ms));

// The loaded envelope (the load on, 10 µs samples) times a gap to within 0.1 ms. A bench CU timed PM3 offs of 2 to
// 32 ms. Its depth can't separate a dip from an off. A door reader's dips to 70 % took it to the no-field level.
// Returns the median length in ms of the gaps at least 1 ms long that the capture holds whole, or null.
function envelopeGapMs(rec) {
  if (!envelopeReadable(rec)) return null;
  const env = rec.caps[1];
  const usPer = env.rateKhz ? 1000 / env.rateKhz : 10;
  const w = rec.dips.filter((d) => !d.open && d.start > 0 && d.width * usPer >= 1000 && d.depth >= 0.5 * env.p90);
  return w.length ? median(w.map((d) => (d.width * usPer) / 1000)) : null;
}

// What the timing capture says about the field's level: where it went off and where it only dipped. Each dip holds:
//   frac      its lowest 1 ms mean, as a fraction of the full level
//   ms        its length
//   open      whether the capture's start or end cut it
//   shortOff  whether it is as deep as an off of that length reads (null: not known)
//
// Log version 5 records the dips. Versions 3 and 4 split the field at 35 % of its swing, so a door reader's dips to
// 70 % read as off. For those this re-reads the runs: if the lowest 1 ms mean stayed above the no-field level, every
// off run was a drop that didn't go off, and only the deepest one's level is known. Its length comes from the
// loaded envelope's gaps. The result is an estimate.
export function levelOf(rec) {
  const t = rec.timing;
  if (!t || !t.total) return null;
  if (rec.version >= 5) {
    const full = rec.timingFull;
    const dips = rec.levelDips.map((d) => {
      const frac = full ? (full - d.depth) / full : null;
      return { start: d.start, ms: d.ms, frac, open: d.open, shortOff: offLike(frac, d.ms) };
    });
    return { estimate: false, full, offAt: rec.timingOffAt, timing: describeTiming(t), dips, dipsTotal: rec.levelDipsTotal };
  }
  const old = { estimate: true, full: t.high, offAt: FIELD_LEVEL, version: rec.version ?? 4 };
  if (t.low < FIELD_LEVEL) return { ...old, timing: describeTiming(t), dips: [], dipsTotal: 0, reachedOff: true };
  const deepest = t.high ? t.low / t.high : null;
  const gapMs = envelopeGapMs(rec);
  const shortOff = offLike(deepest, gapMs);
  const dips = [];
  const whole = t.total === t.runs.length;
  let at = 0;
  t.runs.forEach((r, i) => {
    if (!r.on) dips.push({ start: at, ms: r.ms, frac: null, open: i === 0 || (whole && i === t.runs.length - 1), shortOff });
    at += r.ms;
  });
  // A drop as deep as an off of its length may be one: then the old runs stand.
  if (shortOff) return { ...old, timing: describeTiming(t), dips: [], dipsTotal: 0, deepest, gapMs, shortOffRuns: true };
  const offRuns = t.runs[0]?.on ? Math.floor(t.total / 2) : Math.ceil(t.total / 2);
  return { ...old, timing: { steady: true }, dips, dipsTotal: offRuns, deepest, gapMs };
}

// levelOf for every round of a log. An old log's round whose loaded envelope held no whole gap can't be judged on
// its own. When every round that could be judged reads as short offs, it does too.
export function levelsOf(rounds) {
  const ls = rounds.map(levelOf);
  const open = (l) => l?.estimate && !l.reachedOff && l.gapMs == null;
  const known = ls.filter((l) => l?.estimate && !l.reachedOff && l.gapMs != null);
  if (!known.length || !known.every((l) => l.shortOffRuns)) return ls;
  return ls.map((l, i) =>
    open(l) ? { ...l, timing: describeTiming(rounds[i].timing), dips: [], dipsTotal: 0, shortOffRuns: true } : l,
  );
}

// The dips across rounds: their depth, length and spacing. kind picks the dips that can't be offs ("dip", which takes
// the ones not known either way too) or the ones as deep as an off of their length ("short-off"). Intervals are
// between the starts of dips in one capture.
export function dipSummary(levels, kind = "dip") {
  const pick = (d) => (kind === "short-off" ? d.shortOff === true : d.shortOff !== true);
  const with_ = levels.filter((l) => l && l.dips.some(pick));
  if (!with_.length) return null;
  const all = with_.flatMap((l) => l.dips.filter(pick));
  const whole = all.filter((d) => !d.open);
  const every = with_.flatMap((l) => {
    const starts = l.dips.filter((d) => pick(d) && !(d.open && d.start === 0)).map((d) => d.start);
    return starts.slice(1).map((x, i) => x - starts[i]);
  });
  const pct = whole.map((d) => d.frac).filter((x) => x != null).map((x) => Math.round(x * 100));
  const deepest = with_.map((l) => l.deepest).filter((x) => x != null);
  const gap = with_.map((l) => l.gapMs).filter((x) => x != null);
  const ms = whole.map((d) => d.ms);
  if (!whole.length && !with_.some((l) => l.estimate)) return null; // only drops cut by the capture's ends
  return {
    kind,
    count: with_.reduce((n, l) => n + (l.estimate ? l.dipsTotal : l.dips.filter((d) => pick(d) && !d.open).length), 0),
    pct: median(pct),
    pctRange: range(pct),
    deepestPct: deepest.length ? Math.round(Math.min(...deepest) * 100) : null,
    gapMs: gap.length ? median(gap) : null,
    ms: median(ms),
    msRange: range(ms),
    everyMs: median(every),
    everyRange: range(every),
    estimate: with_.some((l) => l.estimate),
    versions: [...new Set(with_.filter((l) => l.estimate).map((l) => l.version))],
  };
}

// The oldest first of the last min(count, max) entries of a ring.
function ring(count, max, read) {
  const out = [];
  for (let i = Math.max(0, count - max); i < count; i++) out.push(read(i % max));
  return out;
}

const CRASH_KINDS = ["none", "the watchdog", "a lockup", "a firmware error"];

// The log's header on its own: the page reads it first, so a reset or an empty log shows before the rest arrives.
export function parseHeader(bytes) {
  if (bytes.length < HEADER) return { error: `the log's header is ${bytes.length} bytes, expected ${HEADER}` };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== MAGIC) return { error: "the log is empty or unreadable (no valid header)" };
  const version = v.getUint8(4);
  const recSize = v.getUint16(8, true);
  if (REC_OF[version] === undefined || recSize !== REC_OF[version])
    return { error: `log version ${version}, record ${recSize} bytes: this page reads versions 3 to ${LOG_VERSION}` };
  return {
    version,
    recSize,
    logSize: logSize(version),
    on: v.getUint8(5) === 1,
    envMode: v.getUint8(6),
    wake: v.getUint16(10, true),
    counts: { lfRecs: v.getUint16(12, true), lfFields: v.getUint16(14, true), hfFields: v.getUint16(16, true) },
    crash: {
      count: v.getUint8(7),
      kind: CRASH_KINDS[v.getUint16(18, true)] ?? `kind ${v.getUint16(18, true)}`,
      err: v.getUint32(20, true),
      where: v.getUint32(24, true),
      wake: v.getUint16(28, true),
    },
    bootReason: v.getUint16(30, true),
    usb: { dropped: v.getUint16(32, true), err: v.getUint16(34, true) },
  };
}

// One line for the page's event log.
export function headerLine(h) {
  const c = h.counts;
  let t = `probe ${h.on ? "on" : "off"}, wake ${h.wake}, ${c.lfFields} LF field(s), ${c.lfRecs} LF round(s), ${c.hfFields} HF field(s)`;
  if (h.crash.count) t += `; ${h.crash.count} reset(s) by a crash, the last by ${h.crash.kind} in wake ${h.crash.wake}`;
  if (h.usb.dropped) t += `; ${h.usb.dropped} USB repl(ies) dropped, last error ${h.usb.err}`;
  return t;
}

export function parseLog(bytes) {
  const h = parseHeader(bytes);
  if (h.error) return h;
  if (bytes.length < h.logSize) return { error: `the log is ${bytes.length} bytes, expected ${h.logSize}` };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { lfRecs, lfFields, hfFields } = h.counts;
  const lfBase = HEADER,
    fieldBase = lfBase + LF_RECS * h.recSize,
    hfBase = fieldBase + LF_FIELDS * LF_FIELD;
  const dur = (x) => (x === 0xffffffff ? null : x);
  return {
    ...h,
    rounds: ring(lfRecs, LF_RECS, (i) => parseRec(v, lfBase + i * h.recSize, h.version)),
    lfFields: ring(lfFields, LF_FIELDS, (i) => {
      const o = fieldBase + i * LF_FIELD;
      return {
        wake: v.getUint16(o, true),
        tMs: v.getUint32(o + 2, true),
        durMs: dur(v.getUint32(o + 6, true)),
        drops: v.getUint16(o + 10, true),
      };
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

const range = (a) => (a.length ? [Math.min(...a), Math.max(...a)] : null);
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
// Whether the envelope capture can show a reader's gaps: only with the load on (the default), and only if the
// envelope stands above the no-field level. With the load off the detector holds through short gaps. With the tone,
// or at the no-field level, noise passes the depth test below and read as commands on the bench.
export const envelopeReadable = (rec) => rec.caps[1].mode === MOD.HIGH && rec.caps[1].p90 >= FIELD_LEVEL;

export function analyseDips(rec) {
  const env = rec.caps[1];
  const usPer = env.rateKhz ? 1000 / env.rateKhz : 10;
  if (!envelopeReadable(rec)) return { usPer, long: [], bursts: [], open: false, readable: false };
  const ds = rec.dips.map((d) => ({ ...d, startUs: d.start * usPer, widthUs: d.width * usPer }));
  // A long gap with the load on can be a dip or an off. On a door reader, dips to 70 % (with the load off) took the
  // loaded envelope down to the no-field level. levelOf tells them apart.
  const long = ds.filter((d) => d.widthUs >= 2000);
  // A command's gap takes the envelope most of the way down. The firmware also keeps dips of an eighth of the level,
  // and on HS's door readers those were ripple 13 % deep that read as a burst of commands.
  const short = ds.filter((d) => d.widthUs < 2000 && d.depth >= 0.3 * env.p90);
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
  return { usPer, long, bursts: out, open: ds.some((d) => d.open), readable: true };
}

export function describeRound(rec) {
  const level = rec.caps[0];
  const env = rec.caps[1];
  const field = level.p90 >= FIELD_LEVEL || env.p90 >= FIELD_LEVEL;
  const dips = analyseDips(rec);
  const levels = levelOf(rec);
  // The envelope's line is the carrier's ripple only with the load on. Older firmware took it in any mode: the tone's
  // own line read as a 115.6 kHz carrier, and the load off gave about 102 kHz.
  const envLine = rec.carrierHow === 2 || rec.carrierHow === 4;
  const carrierOk = rec.carrierHz && !(envLine && env.mode !== MOD.HIGH);
  return {
    field,
    level: level.p50,
    // The level capture's p90 can be at the rail while its p50 is near zero: the field was on for part of it.
    railed: rec.railed && level.p50 >= 16000,
    carrierDropped: Boolean(rec.carrierHz) && !carrierOk,
    envMode: env.mode,
    carrier: carrierOk
      ? {
          hz: rec.carrierHz,
          ppm: ((rec.carrierHz - NOMINAL_HZ) / NOMINAL_HZ) * 1e6,
          snr: rec.carrierSnr,
          how: CARRIER_HOW[rec.carrierHow] ?? "?",
          class: carrierClass(rec.carrierHz),
          ambiguous: rec.ambiguous,
          // Only the envelope's line has matched a known carrier on the bench. The load tone's fallback gave a
          // carrier 4860 ppm off on a Proxmark3's switching field; firmware from log version 3 uses it only for a
          // steady field.
          sure: SURE.includes(rec.carrierHow),
          // The load tone at two rates, on a field that stayed on: since log version 3 the firmware uses it only
          // for a steady field. With the envelope's load off or the tone, it is the only carrier (124.982 kHz on a
          // bench CU under a PM3, the same as the envelope's line with the load on).
          tone: rec.carrierHow === 1 && !rec.switched && !rec.ambiguous,
          gatedMs: rec.carrierHow === 4 ? rec.carrierN / 100 : null,
        }
      : null,
    dips,
    dipsTotal: rec.dipsTotal,
    levels,
    timing: levels?.timing ?? null,
  };
}

// The Hitag 2 authentication-mode summary the firmware measured for one round (fp_hitag_scan), or null if it
// classified nothing. bits is the frame's length as a class (32 or 64 bits), for the safe report; gaps is the raw
// count, for the private details. ms is the command's span. A round with no field gives null: its envelope is noise,
// and the firmware's scan anchors START_AUTH in it.
export function authOf(rec) {
  if (!rec.authMode || !describeRound(rec).field || !envelopeReadable(rec)) return null;
  const env = rec.caps[1];
  const usPer = env.rateKhz ? 1000 / env.rateKhz : 10;
  return {
    modeId: rec.authMode,
    mode: AUTH_MODE[rec.authMode] ?? `mode ${rec.authMode}`,
    gaps: rec.authGaps,
    startGaps: rec.authStartGaps,
    span: rec.authSpan,
    ms: (rec.authSpan * usPer) / 1000,
    bits: rec.authMode === 1 ? 32 : rec.authMode === 2 ? 64 : rec.authGaps,
  };
}

// The Hitag 2 auth mode across the rounds. A transaction is caught in at most one round; a decisive verdict
// (password or crypto) is preferred over ambiguous, and an anchored one (START_AUTH seen) over not.
export function authVerdict(all) {
  const rounds = all.filter((rec) => describeRound(rec).field && envelopeReadable(rec));
  const got = rounds.map((rec) => authOf(rec)).filter(Boolean);
  if (!got.length) return { mode: null, sawStart: rounds.some((r) => r.authStartGaps > 0) };
  const rank = { 1: 2, 2: 2, 3: 1 };
  const best = [...got].sort((a, b) => rank[b.modeId] - rank[a.modeId] || b.startGaps - a.startGaps)[0];
  const counts = { password: 0, crypto: 0, ambiguous: 0 };
  for (const a of got) counts[a.mode] = (counts[a.mode] ?? 0) + 1;
  return { ...best, counts, n: got.length, sawStart: true };
}

// The overall verdict for the LF side, from every round that saw a field.
export function lfVerdict(rounds) {
  const seen = rounds.map(describeRound).filter((d) => d.field);
  if (!seen.length) return { field: false, text: "No LF field measured." };
  const carriers = seen.map((d) => d.carrier).filter(Boolean);
  const bySnr = (a, b) => b.snr - a.snr;
  const best = carriers.filter((c) => c.sure).sort(bySnr)[0] ?? carriers.filter((c) => c.tone).sort(bySnr)[0] ?? null;
  const bursts = seen.flatMap((d) => d.dips.bursts);
  const commands = bursts.filter((b) => b.gaps >= 3);
  const levels = levelsOf(rounds).filter(Boolean);
  const timings = levels.map((l) => l.timing).filter(Boolean);
  const pulsing = timings.filter((t) => !t.steady && !t.edge);
  const dips = dipSummary(levels, "dip");
  const shortOffs = dipSummary(levels, "short-off");
  let pulse = null;
  if (pulsing.length) {
    const on = pulsing.flatMap((t) => t.on),
      off = pulsing.flatMap((t) => t.off);
    pulse = {
      onMs: median(on),
      offMs: median(off),
      onRange: range(on),
      offRange: range(off),
      count: on.length,
      estimate: levels.some((l) => l.estimate && !l.timing.steady),
    };
  }
  // Old logs whose drops are as deep as offs of their length: the runs stand, as an estimate.
  const shortOffRuns = levels.some((l) => l.shortOffRuns);
  let talk;
  if (commands.length) {
    const fam = commands.map((b) => b.family).find(Boolean);
    const cmd = commands.map((b) => b.command).find(Boolean);
    talk =
      "The reader sends commands (short gaps in its field), so it talks first: a tag has to be asked before it answers." +
      (fam ? ` The timing fits ${fam}.` : "") +
      (cmd ? ` One burst matches the ${cmd}.` : "");
  } else if (!seen.some((d) => d.dips.readable)) {
    // No round's envelope could show gaps, so the page can't say whether the reader sends commands.
    const field =
      pulsing.length || shortOffs
        ? "The field switches off for milliseconds at a time."
        : dips
          ? "The field stays on, but its level dips regularly (below)."
          : "The field stays on.";
    talk = `${field} The CU couldn't look for a reader's command gaps: its envelope capture had the load off or the tone, or the field was too weak for it.`;
  } else if (pulsing.length || shortOffs) {
    talk = "The field switches off for milliseconds at a time, with no command-like gaps: a reader that pulses its field.";
  } else if (dips) {
    talk = "The field stays on, with no command-like gaps, but its level dips regularly (below).";
  } else {
    talk =
      "The field is a steady carrier with no gaps: the reader waits for a tag to talk first (EM4100, HID Prox, Indala, Paradox and most 125 kHz access cards).";
  }
  // An edge (the field came or went once) is neither steady nor pulsing.
  const steady = timings.filter((t) => t.steady).length;
  // With the envelope's load off or the tone, only the load tone places a carrier, and only on a steady field.
  const carrierDropped = !best && seen.some((d) => d.carrierDropped || d.envMode !== MOD.HIGH);
  return { field: true, best, talk, commands: commands.length, pulse, dips, shortOffs, shortOffRuns, steady, carrierDropped };
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

// The Hitag 2 auth-mode line for the safe report: the verdict and the command's length (no raw gap count).
const AUTH_WHY = {
  password: "32 bits (PWD), a static password sent in the clear",
  crypto: "64 bits (AUTH), the Hitag 2 cipher and its 48-bit key",
  ambiguous: "a length between the 32-bit (password) and 64-bit (crypto) commands",
};
function authLineSafe(av) {
  const len = `about ${av.bits} bits (~${av.ms.toFixed(0)} ms)`;
  return (
    `Hitag 2 authentication mode: **${av.mode}** — after the fob's UID the reader's command is ${len}: ${AUTH_WHY[av.mode]}. ` +
    "This reads the command's length only and recovers no secret."
  );
}

// The safe report's line for the dips (kind "dip") or the short offs (kind "short-off"): "to N % for X ms every
// Y ms", and why the page calls them what it does.
function dipLine(ds) {
  const rg = (x, u = "") => (x && x[0] !== x[1] ? ` (${x[0]}–${x[1]}${u})` : "");
  const len = ds.ms != null ? ` for about ${ds.ms} ms${rg(ds.msRange)}` : "";
  const every = ds.everyMs != null ? ` every ${ds.everyMs} ms${rg(ds.everyRange)}` : "";
  const to = ds.pct != null ? ` to about ${ds.pct} % of full${rg(ds.pctRange, " %")}` : "";
  if (ds.kind === "short-off")
    return (
      `Short offs${len}${every}, from ${ds.count} drop(s) in 1.8 s captures. ` +
      `The level fell${to}, as far as it falls when the field is off that briefly, so the field most likely switched off. ` +
      "A dip as deep and as short would read the same."
    );
  if (ds.estimate) {
    const v = ds.versions.join(" and ");
    const deep = ds.deepestPct != null ? `, the deepest to ${ds.deepestPct} % of full` : "";
    const gap = ds.gapMs != null ? ` Each lasts about ${ds.gapMs.toFixed(1)} ms in the loaded envelope, and an off that long would take the level below ${Math.round(offLikeAt(ds.gapMs) * 100)} %.` : "";
    return (
      `Field dips (estimate)${every}${deep}, from ${ds.count} dip(s) in 1.8 s captures. The field stayed on throughout.${gap} ` +
      `Log version ${v} called these stretches off. The page re-read them from the lowest and highest levels stored.`
    );
  }
  return `Field dips${to}${len}${every}, from ${ds.count} dip(s) in 1.8 s captures. The field stays on through them. An off that long would take the level further down.`;
}

export function safeMarkdown(r) {
  const L = [];
  L.push("**Chameleon Ultra field probe report** (safe to share)", "");
  L.push(`- Firmware: ${r.firmware}`);
  L.push(`- Log: ${r.log.counts.lfFields} LF field(s), ${r.log.counts.lfRecs} LF round(s), ${r.log.counts.hfFields} HF field(s); envelope LF_MOD ${MOD_NAMES[r.log.envMode] ?? r.log.envMode}`);
  const cr = r.log.crash;
  if (cr?.count) {
    const err = cr.kind === CRASH_KINDS[3] ? ` (error 0x${cr.err.toString(16)}, at 0x${cr.where.toString(16)})` : "";
    L.push(`- ⚠ The CU reset ${cr.count} time(s) during the run. The last reset was by ${cr.kind}${err}, in wake ${cr.wake}.`);
  }
  if (r.log.usb?.dropped) L.push(`- ⚠ The CU dropped ${r.log.usb.dropped} USB repl(ies), the last with error ${r.log.usb.err}.`);
  L.push("", "**LF (125 kHz band)**");
  const lf = lfVerdict(r.log.rounds);
  if (!lf.field) L.push(`- ${lf.text}`);
  else {
    if (lf.best)
      L.push(
        `- Carrier: ${kHz(lf.best.hz)} (${sgn(lf.best.ppm)} ppm from 125 kHz on the CU's clock, SNR ${lf.best.snr.toFixed(1)} dB, placed by ${lf.best.how}${lf.best.ambiguous ? ", ambiguous" : ""}): ${lf.best.class}`,
      );
    else if (lf.carrierDropped)
      L.push(
        "- Carrier: not measured. The envelope was captured with the load off or the tone, and only the load on shows the carrier there. The load tone places it instead, but only on a field that stays on.",
      );
    else
      L.push(
        "- Carrier: not measured: the field never stayed on for 20 ms in a measurement, or its line was too weak.",
      );
    L.push(`- ${lf.talk}`);
    if (lf.pulse) {
      const rg = (x) => (x && x[0] !== x[1] ? ` (${x[0]}–${x[1]})` : "");
      const on = lf.pulse.onMs != null ? `on about ${lf.pulse.onMs} ms${rg(lf.pulse.onRange)}` : "on for less than the capture";
      const off = lf.pulse.offMs != null ? `off about ${lf.pulse.offMs} ms${rg(lf.pulse.offRange)}` : null;
      // Log versions 3 and 4 timed the stretches at 35 % of the swing. The page checked that they were offs.
      const est = !lf.pulse.estimate
        ? ""
        : lf.shortOffRuns
          ? " Estimate: this CU's firmware timed these at 35 % of the swing. They are as deep as offs of their length in the loaded envelope, so the page keeps them as offs."
          : " Estimate: this CU's firmware timed these at 35 % of the swing. The level reached the no-field level, so the field does go off.";
      L.push(`- Field timing: ${[on, off].filter(Boolean).join(", ")}, from ${lf.pulse.count} whole pulse(s) in 1.8 s captures.${est}`);
    } else if (lf.steady && !lf.shortOffs) L.push("- Field timing: on for the whole 1.8 s capture, never down to the no-field level.");
    if (lf.shortOffs) L.push(`- ${dipLine(lf.shortOffs)}`);
    if (lf.dips) L.push(`- ${dipLine(lf.dips)}`);
    const av = authVerdict(r.log.rounds);
    if (av.mode) L.push(`- ${authLineSafe(av)}`);
    else if (av.sawStart)
      L.push(
        "- A Hitag 2 START_AUTH was seen, but the fob's authentication command wasn't captured (the transaction may not have fallen in a measurement window), so the mode is unknown.",
      );
  }
  const roundLevels = levelsOf(r.log.rounds);
  for (const [ri, rec] of r.log.rounds.entries()) {
    const d = { ...describeRound(rec), levels: roundLevels[ri] };
    d.timing = d.levels?.timing ?? null;
    const where = rec.manual ? "measured by command" : `field ${rec.field} round ${rec.round}`;
    const parts = [
      `wake ${rec.wake} +${(rec.tMs / 1000).toFixed(1)} s, ${where}`,
      d.field ? `level ${d.level}${d.railed ? " (railed)" : ""}` : "no field",
    ];
    if (d.carrier)
      parts.push(
        `carrier ${kHz(d.carrier.hz)} ${d.carrier.snr.toFixed(0)} dB${d.carrier.gatedMs ? ` (from ${d.carrier.gatedMs.toFixed(0)} ms with the field on)` : ""}${d.carrier.sure ? "" : d.carrier.tone ? " (from the load tone)" : " (uncertain: the field switched)"}`,
      );
    if (d.field) parts.push(d.dips.readable ? `${rec.dipsTotal} envelope dip(s)` : "envelope not read");
    // A reader that repeats a command gives the same burst several times: one entry each, with a count.
    // The gap width varies by a sample or so between repeats, so it stays out of the comparison.
    const seen = new Map();
    // With no field, the dips are noise.
    for (const b of d.field ? d.dips.bursts.filter((b) => b.gaps >= 2) : []) {
      const key = `${b.gaps}|${b.shortUs}|${b.longUs}|${b.family}|${b.command}`;
      const e = seen.get(key) ?? { b, count: 0 };
      e.count++;
      seen.set(key, e);
    }
    for (const { b, count } of seen.values()) {
      const text = `burst of ${b.gaps} gaps ~${b.gapUs?.toFixed(0)} µs, intervals ${b.shortUs?.toFixed(0) ?? "-"}/${b.longUs?.toFixed(0) ?? "-"} µs${b.family ? ` (${b.family})` : ""}${b.command ? `: ${b.command}` : ""}`;
      parts.push(count > 1 ? `${count} × ${text}` : text);
    }
    if (d.field && d.dips.long.length) parts.push(`${d.dips.long.length} gap(s) ≥ 2 ms with the load on`);
    if (rec.ended) parts.push("field gone by the end");
    const lv = d.levels;
    if (d.timing?.steady) parts.push(`timing: never off${lv?.estimate ? " (re-read)" : ""}`);
    else if (d.timing) {
      const seq = rec.timing.runs.map((x) => `${x.on ? "on" : "off"} ${x.ms}`).join(", ");
      const how = lv?.estimate ? ", split at 35 % of the swing" : "";
      parts.push(`timing (ms${how}): ${seq}${d.timing.cut ? ", …" : ""}`);
    }
    for (const kind of ["short-off", "dip"]) {
      const one = lv && dipSummary([lv], kind);
      if (!one) continue;
      const to = one.pct != null ? ` to ${one.pct} %` : one.deepestPct != null ? `, the deepest to ${one.deepestPct} %` : "";
      const what = kind === "dip" ? "level dip(s)" : "short off(s)";
      parts.push(`${one.count} ${what}${to}${one.ms != null ? `, ${one.ms} ms` : ""}${one.everyMs != null ? ` every ${one.everyMs} ms` : ""}`);
    }
    L.push(`  - ${parts.join("; ")}`);
  }
  if (r.log.lfFields.length) {
    const durs = r.log.lfFields.map((f) => (f.durMs == null ? "ongoing" : `${f.durMs} ms`));
    L.push(`- LF field durations (a measurement holds a field open for about 2.5 s): ${durs.join(", ")}`);
    if (r.log.lfFields.some((f) => f.drops))
      L.push(
        `- Drops below the CU's fixed comparator level while the field lasted: ${r.log.lfFields.map((f) => f.drops).join(", ")}. A drop is a dip or an off, and the timing above says which. The last may be the field's end.`,
      );
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
    if (!d.field) continue; // with no field, the dips are noise
    const bits = d.dips.bursts.filter((b) => b.bits).map((b) => b.bits);
    if (bits.length) L.push(`- wake ${rec.wake} +${(rec.tMs / 1000).toFixed(1)} s: command bits, from the intervals between gaps: ${bits.join(" ")}`);
  }
  for (const rec of r.log.rounds) {
    const a = authOf(rec);
    if (!a) continue;
    L.push(
      `- wake ${rec.wake} +${(rec.tMs / 1000).toFixed(1)} s: Hitag 2 auth frame (${a.mode}), ${a.gaps} gaps over ${a.span} envelope samples (~${a.ms.toFixed(1)} ms)` +
        (a.startGaps ? `, after a START_AUTH of ${a.startGaps} gaps` : " (no START_AUTH anchor in the capture)"),
    );
  }
  for (const f of r.log.hfFields)
    if (f.other)
      L.push(`- HF wake ${f.wake} +${(f.tMs / 1000).toFixed(1)} s: last non-poll frame ${f.otherBits} bits, starts ${f.otherData.map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  if (L.length === 2) L.push("- none");
  return L.join("\n");
}
