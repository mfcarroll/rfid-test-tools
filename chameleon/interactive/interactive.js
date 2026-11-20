// Interactive LF emulation page: the CU's interactive engine, its Hitag 2 slot, and what its exchange trace says
// about a reader. No DOM in here.
//
// The firmware (exp/lf-interactive) runs a listen-and-respond LF tag engine. Its first module is Hitag 2 in password
// mode. While a reader works the CU, the engine records each command it hears and each answer it sends, in a trace
// that survives the CU's sleep, so the CU can be taken to a reader on battery and read here afterwards.
//
// The safe part of a report says whether a reader engaged the emulation and how far the exchange got. The private
// part holds the reader's commands decoded to bits (a Hitag 2 reader's password is one of them) and the answers.

export const CMD = {
  CHANGE_DEVICE_MODE: 1001, // 1 reader, 0 tag
  GET_DEVICE_MODE: 1002,
  SET_ACTIVE_SLOT: 1003,
  SET_SLOT_TAG_TYPE: 1004,
  SET_SLOT_DATA_DEFAULT: 1005,
  SET_SLOT_ENABLE: 1006,
  SLOT_DATA_CONFIG_SAVE: 1009,
  GET_ACTIVE_SLOT: 1018,
  HITAG2_SCAN: 3038, // read a tag's UID (the firmware flips to reader mode for this command). 3036 is #509's.
  HITAG2_READ: 3037, // read a tag's eight pages with a password (reader mode)
  HITAG2_SET_EMU_DATA: 5040,
  HITAG2_GET_EMU_DATA: 5041,
  LF_IA_TRACE_READ: 3180,
  LF_IA_TRACE_CLEAR: 3181,
  LF_IA_TUNING: 3184,
  LF_RDR_CAPTURE: 3186, // the last reader answer's raw envelope samples
  HITAG2_READER_LINK: 3187, // the Hitag 2 reader's link timing, for context in a saved record
  LF_RDR_LAST: 3189, // the last reader answer: bits, envelope levels and load runs
  LF_RDR_TRACE_READ: 3190, // every reader transaction of the last exchange
  LF_RDR_TRACE_CLEAR: 3191, // clear the reader trace before an exchange
};
export const STATUS = {
  MF_ERR_AUTH: 0x06, // the tag rejected the password
  LF_TAG_OK: 0x40, // a reader command read the tag
  LF_TAG_NO_FOUND: 0x41, // no tag, or some pages could not be read
  PAR_ERR: 0x60,
  INVALID_CMD: 0x67,
  SUCCESS: 0x68,
};

export const TAG_TYPE_HITAG2 = 470;
export const SENSE_LF = 1;
export const HITAG2_DATA_SIZE = 32; // eight 32-bit pages
// sizeof(lf_ia_trace_rec_t). The base record ends at t_session_us (276 bytes). The exp/lf-hitag-modes firmware
// appends 14 bytes of per-record timing and carrier-measurement fields (290). The layout below 276 is the same for
// both, and parseRecord reads the extra fields only when the record carries them. From a501f268 on, it also appends
// t_field_seen_us, the last time the CU saw the reader's field while answering (294).
export const REC_SIZE = 276;
export const REC_SIZE_TIMING = 290;
export const REC_SIZE_WATCH = 294;
export const REC_SIZES = new Set([REC_SIZE, REC_SIZE_TIMING, REC_SIZE_WATCH]);
export const TRACE_KEEP = 8; // the first records a clear keeps (LF_IA_TRACE_KEEP), for a note when some roll off

// lf_ia_trace.h
export const TR = { FIELD_OFF: 2, COMMAND: 3 };
export const VERDICT = ["ignored", "answered", "ended"];
export const DECODE = ["ok", "one class", "too few gaps", "overflow"];
// lf_ia_carrier_status_t; 255 when no measurement ran in the session.
export const MEAS = ["ok", "too few samples", "weak"];
// The per-slot mode flags (lf_ia.h, LF_IA_MODE_), as a name. Shared meaning with the Hitag 2 modes page.
export const modeFlags = (m) => {
  const f = [];
  if (m & 1) f.push("scale");
  if (m & 2) f.push("alt-delay"); // a later answer on builds before f559dee3, which later builds ignore
  if (m & 4) f.push("every-second");
  if (m & 8) f.push("rest-loaded");
  return f.length ? f.join("+") : "baseline";
};
export const FLAG = {
  LATE: 1,
  GAPS_DROPPED: 2,
  ENCODE_FAILED: 4,
  FIELD_BACK: 8,
};

// ---------------------------------------------------------------- Hitag 2 pages and config

// A made-up default tag, not a real credential. The page's fields start from this; a tester can change them, or read
// a real tag over them. The config byte (page 3, byte 0) is 0x06: Hitag 2, password mode, the only mode supported.
export const PLACEHOLDER_PAGES = Uint8Array.of(
  0x12,
  0x34,
  0x56,
  0x78, // page 0: UID
  0x4d,
  0x49,
  0x4b,
  0x52, // page 1: reader password (MIKR)
  0x22,
  0x22,
  0x22,
  0x22, // page 2: crypto key high bytes (unused in password mode)
  0x06,
  0xaa,
  0xbb,
  0xcc, // page 3: config byte + tag password
  0x44,
  0x44,
  0x44,
  0x44, // page 4: user
  0x55,
  0x55,
  0x55,
  0x55, // page 5: user
  0x66,
  0x66,
  0x66,
  0x66, // page 6: user
  0x77,
  0x77,
  0x77,
  0x77, // page 7: user
);

// The config byte for Hitag 2 password mode, page 3 byte 0. The page fixes it, since it is the only mode supported.
export const CONFIG_BYTE = "06";

// One label per page, in order. Page 2 holds the crypto key's high bytes, unused in the supported password mode.
export const HITAG2_PAGE_NAMES = [
  "UID",
  "Reader password",
  "Key, high bytes (crypto mode only, not supported yet)",
  "Config + tag password",
  "User",
  "User",
  "User",
  "User",
];

const hex = (b) =>
  [...b].map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join("");

// A hex string of exactly nBytes bytes, as a Uint8Array, or null. Spaces and a 0x prefix are allowed.
export function parseHex(s, nBytes) {
  const t = (s ?? "").trim().replace(/^0x/i, "").replace(/\s+/g, "");
  if (!new RegExp(`^[0-9a-fA-F]{${nBytes * 2}}$`).test(t)) return null;
  const b = new Uint8Array(nBytes);
  for (let i = 0; i < nBytes; i++)
    b[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
  return b;
}

// A UID as 8 hex digits, or null.
export function parseUid(s) {
  const b = parseHex(s, 4);
  return b ? hex(b) : null;
}

export function pagesWithUid(uidHex, base = PLACEHOLDER_PAGES) {
  const p = Uint8Array.from(base);
  for (let i = 0; i < 4; i++)
    p[i] = parseInt(uidHex.slice(i * 2, i * 2 + 2), 16);
  return p;
}

// The page shows every page as a field, in order. Page 3 is split into config (1 byte) and tagpw (3 bytes); the other
// pages (p0..p2, p4..p7) are 4 bytes each. Everything is hex. Returns the 32 page bytes in order, or null if any field
// is not valid hex of the right length.
export function pagesFromFields(f) {
  const out = new Uint8Array(32);
  let o = 0;
  for (const [v, n] of [
    [f.p0, 4],
    [f.p1, 4],
    [f.p2, 4],
    [f.config, 1],
    [f.tagpw, 3],
    [f.p4, 4],
    [f.p5, 4],
    [f.p6, 4],
    [f.p7, 4],
  ]) {
    const b = parseHex(v, n);
    if (!b) return null;
    out.set(b, o);
    o += n;
  }
  return out;
}

// The field values that describe a 32-byte page image, for filling the form after a read.
export function fieldsFromPages(p) {
  return {
    p0: hex(p.slice(0, 4)),
    p1: hex(p.slice(4, 8)),
    p2: hex(p.slice(8, 12)),
    config: hex(p.slice(12, 13)),
    tagpw: hex(p.slice(13, 16)),
    p4: hex(p.slice(16, 20)),
    p5: hex(p.slice(20, 24)),
    p6: hex(p.slice(24, 28)),
    p7: hex(p.slice(28, 32)),
  };
}

export const uidOf = (pages) => hex(pages.slice(0, 4));

// The Hitag 2 configuration byte is page 3's first byte.
export function describeConfig(pages) {
  const c = pages[12];
  const crypto = (c & 0x08) !== 0;
  const coding = [
    "Public mode B, biphase",
    "Public mode A, Manchester",
    "Public mode C, biphase",
    "Hitag 2",
  ][(c & 0x06) >> 1];
  return { byte: c, crypto, mode: crypto ? "crypto" : "password", coding };
}

// ---------------------------------------------------------------- requests

export const reqSetType = (slotFw, type) =>
  Uint8Array.of(slotFw, type >> 8, type & 0xff);
export const reqSetEnable = (slotFw, sense, on) =>
  Uint8Array.of(slotFw, sense, on ? 1 : 0);
export const reqActiveSlot = (slotFw) => Uint8Array.of(slotFw);
export const reqTraceRead = (first) => Uint8Array.of(first >> 8, first & 0xff);

// ---------------------------------------------------------------- reading a physical tag (reader mode)

// HITAG2_READ takes the reader password, 4 bytes.
export const reqHitag2Read = (pwBytes) => Uint8Array.from(pwBytes);

// HITAG2_SCAN reply: the UID, 4 bytes. Returns the UID as 8 hex digits, or null if the reply is short.
export function parseHitag2Scan(d) {
  return d.length >= 4 ? hex(d.slice(0, 4)) : null;
}

// HITAG2_READ reply: 32 page bytes, then a 1-byte mask of which pages were read (bit p set = page p read). Returns
// { count, mask, pages } with pages the 8 four-byte pages (an unread page is null), or null if the reply is short.
export function parseHitag2Read(d) {
  if (d.length < 33) return null;
  const mask = d[32];
  const pages = [];
  for (let p = 0; p < 8; p++)
    pages.push(mask & (1 << p) ? d.slice(p * 4, p * 4 + 4) : null);
  let count = 0;
  for (let p = 0; p < 8; p++) if (mask & (1 << p)) count++;
  return { count, mask, pages };
}

// Fold a HITAG2_READ result into a full 32-byte page image, filling pages that could not be read from base.
export function pagesFromRead(read, base = PLACEHOLDER_PAGES) {
  const p = Uint8Array.from(base);
  for (let i = 0; i < 8; i++) if (read.pages[i]) p.set(read.pages[i], i * 4);
  return p;
}

// ---------------------------------------------------------------- the last reader answer's timing

// In reader mode the CU drives its own field at 125 kHz, so one carrier period is 8 µs.
export const FC_US = 8;

// LF_RDR_LAST / LF_RDR_TRANSACT reply: n_bits u16, 32 bytes of answer bits, env.first u16, idle/load/threshold i16
// each, n_runs u16, then the load runs (u16 each; bit 15 = loaded, bits 0..14 = length in carrier periods). Returns
// the answer decoded for display, or null if the reply is short. The runs are the exact timing of the tag's reply:
// each load/idle segment's length. delayUs is how long after the command the answer's first load began. depth is the
// swing the firmware measured (|load - idle| in ADC counts), which min_depth is checked against.
export function parseLastReply(d) {
  if (d.length < 44) return null;
  const v = new DataView(d.buffer, d.byteOffset);
  const nBits = v.getUint16(0, true);
  const first = v.getUint16(34, true);
  const idle = v.getInt16(36, true);
  const load = v.getInt16(38, true);
  const threshold = v.getInt16(40, true);
  const nRuns = v.getUint16(42, true);
  const runs = [];
  for (let i = 0; i < nRuns && 44 + i * 2 + 2 <= d.length; i++) {
    const r = v.getUint16(44 + i * 2, true);
    const fc = r & 0x7fff;
    runs.push({ load: !!(r & 0x8000), fc, us: fc * FC_US });
  }
  const totalUs = runs.reduce((s, r) => s + r.us, 0);
  return {
    nBits,
    bits: bitsStr(d.subarray(2, 34), nBits),
    delayUs: first * FC_US,
    idle,
    load,
    threshold,
    depth: Math.abs(load - idle),
    nRuns,
    totalUs,
    runs,
  };
}

// LF_RDR_CAPTURE reply: total u16, count u16, then count i16 samples (one per carrier period, 8 µs apart). Returns
// { total, count, samples } for this batch.
export function parseCapture(d) {
  if (d.length < 4) return null;
  const v = new DataView(d.buffer, d.byteOffset);
  const total = v.getUint16(0, true);
  const count = v.getUint16(2, true);
  const samples = [];
  for (let i = 0; i < count && 4 + i * 2 + 2 <= d.length; i++)
    samples.push(v.getInt16(4 + i * 2, true));
  return { total, count, samples };
}

// HITAG2_READER_LINK reply: a 20-byte lf_rdr_link_t (little-endian), kept with a record for context.
export function parseReaderLink(d) {
  if (d.length < 20) return null;
  const v = new DataView(d.buffer, d.byteOffset);
  return {
    gapUs: v.getUint16(0, true),
    bit0Us: v.getUint16(2, true),
    bit1Us: v.getUint16(4, true),
    eofGap: v.getUint8(6),
    stopUs: v.getUint16(7, true),
    coding: v.getUint8(9),
    codingFlags: v.getUint8(10),
    bitFc: v.getUint16(11, true),
    windowUs: v.getUint16(13, true),
    captureN: v.getUint16(15, true),
    minDepth: v.getInt16(17, true),
    slicePct: v.getUint8(19),
  };
}

// ---------------------------------------------------------------- the whole exchange (LF_RDR_TRACE_READ)

// A read runs many reader commands, each its own transaction (lf_hitag2_reader.c): START_AUTH, the password, then each
// page, with retries. The firmware keeps a record per transaction. This reads them back so the page shows the whole
// exchange, each command labelled, instead of only the last answer.

export const TRACE_REC_SIZE = 212; // LF_RDR_TRACE_REC_SIZE: 20-byte header + 96 runs
export const TRACE_RUNS = 96;

// Name a command from its bits (lf_hitag2_reader.c): START_AUTH is 0x18 in 5 bits, the password is 32 bits, and a page
// read is 10 bits, 11 ppp 00 ~ppp, with the page number in the middle.
export function exchangeLabel(nTx, v) {
  if (nTx === 5 && v === 0x18) return "START_AUTH";
  if (nTx === 32) return "password";
  if (nTx === 10 && v >> 8 === 3 && ((v >> 3) & 3) === 0)
    return `read page ${(v >> 5) & 7}`;
  return `${nTx}-bit 0x${v.toString(16)}`;
}

// One trace record (LF_RDR_TRACE_REC_SIZE bytes): command bit count (u8), command bits (4, first-bit-first), power-up
// (u16), flags (u8, bit0 clean), answer bit count (u16), first loaded sample (u16), idle/load/threshold (i16), run
// count (u16), then TRACE_RUNS runs (u16, zero past the count). No decoded answer bits.
export function parseTraceRecord(d, o = 0) {
  const v = new DataView(d.buffer, d.byteOffset + o);
  const nTx = v.getUint8(0);
  let tx = 0;
  for (let i = 0; i < nTx && i < 32; i++)
    if (d[o + 1 + (i >> 3)] & (1 << (7 - (i & 7)))) tx |= 1 << (nTx - 1 - i);
  tx >>>= 0;
  const nRuns = v.getUint16(18, true);
  const runs = [];
  for (let i = 0; i < nRuns && i < TRACE_RUNS; i++) {
    const r = v.getUint16(20 + i * 2, true);
    const fc = r & 0x7fff;
    runs.push({ load: !!(r & 0x8000), fc, us: fc * FC_US });
  }
  const idle = v.getInt16(12, true);
  const load = v.getInt16(14, true);
  return {
    nTx,
    tx,
    cmd: exchangeLabel(nTx, tx),
    powerUpUs: v.getUint16(5, true),
    clean: !!(v.getUint8(7) & 1),
    nBits: v.getUint16(8, true),
    delayUs: v.getUint16(10, true) * FC_US,
    idle,
    load,
    threshold: v.getInt16(16, true),
    depth: Math.abs(load - idle),
    answered: v.getUint16(8, true) > 0,
    nRuns,
    totalUs: runs.reduce((s, r) => s + r.us, 0),
    runs,
  };
}

// LF_RDR_TRACE_READ reply: total u16 (records since the clear), size u16 (record size), count u8, then count records.
export function parseReaderTraceReply(d) {
  if (d.length < 5) return null;
  const v = new DataView(d.buffer, d.byteOffset);
  const total = v.getUint16(0, true);
  const size = v.getUint16(2, true);
  const count = v.getUint8(4);
  const recs = [];
  for (let i = 0; i < count && 5 + (i + 1) * size <= d.length; i++)
    recs.push(parseTraceRecord(d, 5 + i * size));
  return { total, size, count, recs };
}

// The whole exchange as plain text for the log: one block per transaction, every run listed, no decoded answer bits.
export function exchangeLogText(txns) {
  const lines = [`Hitag 2 exchange: ${txns.length} command(s)`];
  txns.forEach((t, i) => {
    lines.push(
      `  #${i} ${t.cmd}: ${t.answered ? `${t.nBits} bit(s)` : "no answer"}, ` +
        `delay ${t.delayUs} µs, depth ${t.depth} (idle ${t.idle}, load ${t.load}, threshold ${t.threshold}), ` +
        `${t.nRuns} runs, total ${t.totalUs} µs` +
        (t.powerUpUs ? `, power-up ${t.powerUpUs} µs` : ""),
    );
    lines.push(
      "    runs (µs, L = loaded): " +
        t.runs.map((r) => `${r.load ? "L" : "·"}${r.us}`).join(" "),
    );
  });
  return lines.join("\n");
}

// A complete record for the downloaded file: every transaction's command and timing, the raw envelope of the last
// transaction, and the reader link. The levels sit beside each transaction, so a tag's swing can be measured without
// rerunning. No decoded answer bits.
export function buildExchangeRecord(
  { firmware, action, uid },
  txns,
  lastEnvelope,
  link,
) {
  return {
    kind: "rfid-test-tools/chameleon/interactive Hitag 2 reader exchange",
    firmware,
    read: new Date().toISOString(),
    action, // "scan" or "read"
    reader: "the CU's own antenna at 125 kHz (8 µs per carrier period)",
    ...(uid ? { uid } : {}),
    transactions: txns,
    lastEnvelope: lastEnvelope
      ? {
          fcUs: FC_US,
          total: lastEnvelope.total,
          samples: lastEnvelope.samples,
        }
      : null,
    link: link ?? null,
  };
}

// ---------------------------------------------------------------- the counters (LF_IA_TUNING reply)

// The reply is the 14-byte tuning struct, then seven u32 counters. The counters live with the trace, so they survive
// sleep until a clear.
export function parseCounters(d) {
  if (d.length < 14 + 28) return null;
  const v = new DataView(d.buffer, d.byteOffset);
  const at = (i) => v.getUint32(14 + i * 4, true);
  return {
    sessions: at(0),
    commands: at(1),
    responses: at(2),
    late: at(3),
    buffers: at(4),
    bufferSlips: at(5),
    maxHandlerUs: at(6),
  };
}

// ---------------------------------------------------------------- the trace

// Bit i of a packed field, first-sent-first (lf_ia_codec.h).
const bitAt = (bytes, i) => (bytes[i >> 3] >> (7 - (i & 7))) & 1;
function bitsStr(bytes, n) {
  let s = "";
  for (let i = 0; i < Math.min(n, bytes.length * 8); i++) s += bitAt(bytes, i);
  return s;
}

export function parseRecord(buf, o = 0, size = REC_SIZE) {
  const v = new DataView(buf.buffer, buf.byteOffset + o);
  const u8 = (i) => v.getUint8(i);
  const u16 = (i) => v.getUint16(i, true);
  const i16 = (i) => v.getInt16(i, true);
  const u32 = (i) => v.getUint32(i, true);
  const nGaps = u16(28);
  const gaps = [];
  for (let i = 0; i < Math.min(nGaps, 48); i++) {
    gaps.push({ startUs: u16(76 + i * 4), widthUs: u16(76 + i * 4 + 2) });
  }
  const nBits = u16(30);
  const nTxBits = u16(32);
  const rec = {
    type: u8(0),
    verdict: u8(1),
    decode: u8(2),
    flags: u8(3),
    tUs: u32(4),
    tDetectUs: u32(8),
    tReadyUs: u32(12),
    tDueUs: u32(16),
    tTxUs: u32(20),
    tTxEndUs: u32(24),
    nGaps,
    nBits,
    nTxBits,
    nRuns: u16(34),
    split: u32(36),
    level: u16(40),
    nNoise: u16(42),
    bits: bitsStr(buf.subarray(o + 44, o + 60), nBits),
    txBits: bitsStr(buf.subarray(o + 60, o + 76), nTxBits),
    gaps,
    boot: u16(268),
    session: u16(270),
    tSessionUs: u32(272),
  };
  // The exp/lf-hitag-modes firmware appends the carrier the answer was timed by, the measurement, and the slot/mode.
  if (size >= REC_SIZE_TIMING) {
    rec.timing = {
      fcUsedHz: u32(276) / 10, // fc_used_dhz, 0.1 Hz
      fcMeasuredHz: u32(280) / 10, // fc_measured_dhz, 0.1 Hz, 0 if none measured
      measSnrDb: i16(284) / 10, // meas_snr_db10
      measStatus: u8(286), // lf_ia_carrier_status_t, 255 if none ran
      mode: u8(287), // the slot's LF_IA_MODE_ flags
      slot: u8(288), // the active slot, 1 to 8
      measUs: u8(289) * 32, // meas_us32, how long the measurement took, in 32 µs units
    };
  }
  // t_field_seen_us: 0 if the CU never saw the field after the command.
  if (size >= REC_SIZE_WATCH) rec.tFieldSeenUs = u32(290);
  return rec;
}

// Where the reader's field was last seen against the answer the CU sent, or null if the record doesn't say.
export function fieldSeenText(c) {
  if (c.tFieldSeenUs === undefined) return null;
  const seen = c.tFieldSeenUs;
  if (!seen) return "field never seen after the command";
  // The watch sees up to about 35 µs before the answer's end (conversion and smoothing lag).
  if (seen >= c.tTxEndUs - 50) return `field still on at the answer's end`;
  if (seen < c.tTxUs)
    return `field gone ${c.tTxUs - seen} µs before the answer started`;
  const bitUs = (c.tTxEndUs - c.tTxUs) / Math.max(c.nTxBits, 1);
  const bit = Math.floor((seen - c.tTxUs) / bitUs);
  return `field gone during the answer: last seen ${seen - c.tTxUs} µs in, in bit ${bit} of ${c.nTxBits}`;
}

// The trace-read reply header: total u32, record size u16, count u8, kept u8, boot u16, then the records.
export function parseTraceReply(d) {
  const v = new DataView(d.buffer, d.byteOffset);
  const total = v.getUint32(0, true);
  const size = v.getUint16(4, true);
  const n = v.getUint8(6);
  const keep = v.getUint8(7);
  const boot = v.getUint16(8, true);
  const recs = [];
  for (let i = 0; i < n; i++) recs.push(parseRecord(d, 10 + i * size, size));
  return { total, size, n, keep, boot, recs };
}

// ---------------------------------------------------------------- what the trace means

// A Hitag 2 reader frame is 5, 10, 32 or 64 bits. Group a session's commands by what the reader was doing.
export function classifyCommand(rec) {
  if (rec.type !== TR.COMMAND) return null;
  const n = rec.nBits;
  if (n === 5) return { kind: "start", label: "START_AUTH (request the UID)" };
  if (n === 32)
    return {
      kind: "password",
      label: "32-bit password command (password mode)",
    };
  if (n === 64)
    return { kind: "crypto", label: "64-bit command (crypto mode)" };
  if (n === 10) return { kind: "read", label: "read a data page" };
  return { kind: "other", label: `${n}-bit frame` };
}

// Split the records into field sessions, each a boot/session pair with its commands and its field-off record.
export function sessions(recs) {
  const out = [];
  let cur = null;
  for (const r of recs) {
    const key = `${r.boot}/${r.session}`;
    if (!cur || cur.key !== key) {
      cur = {
        key,
        boot: r.boot,
        session: r.session,
        tSessionUs: r.tSessionUs,
        commands: [],
        off: null,
      };
      out.push(cur);
    }
    if (r.type === TR.COMMAND) cur.commands.push(r);
    else if (r.type === TR.FIELD_OFF) cur.off = r;
  }
  return out;
}

// A one-line verdict for a session: how far a reader got.
export function sessionVerdict(s) {
  const cmds = s.commands;
  const kinds = cmds.map((c) => classifyCommand(c)?.kind);
  const answered = cmds.filter((c) => c.verdict === 1).length;
  const sawStart = kinds.includes("start");
  const startAnswered = cmds.some(
    (c) => classifyCommand(c)?.kind === "start" && c.verdict === 1,
  );
  const sawPassword = kinds.includes("password");
  const passwordAnswered = cmds.some(
    (c) => classifyCommand(c)?.kind === "password" && c.verdict === 1,
  );
  const sawCrypto = kinds.includes("crypto");
  const reads = cmds.filter((c) => classifyCommand(c)?.kind === "read").length;
  const late = cmds.some((c) => c.flags & FLAG.LATE);
  const failed = cmds.filter((c) => c.decode !== 0).length;

  let verdict;
  if (cmds.length === 0)
    verdict = "a field appeared, but no command was decoded";
  else if (sawCrypto)
    verdict =
      "the reader uses crypto mode, which this emulation does not support";
  else if (passwordAnswered)
    verdict =
      "the reader authenticated in password mode and the CU served its pages";
  else if (sawPassword)
    verdict =
      "the reader sent a password in password mode; the CU's stored password did not match, so it did not answer";
  else if (startAnswered)
    verdict =
      "the reader began a Hitag 2 authentication and the CU answered with its UID, but no password command followed";
  else if (sawStart)
    verdict =
      "the reader sent START_AUTH, but the CU's UID answer was not accepted";
  else
    verdict = "the reader sent commands, but no Hitag 2 START_AUTH among them";

  return {
    verdict,
    sawStart,
    startAnswered,
    sawPassword,
    passwordAnswered,
    sawCrypto,
    reads,
    answered,
    late,
    failed,
  };
}

// A command/answer bit string (first-sent-first) as hex, one byte per 8 bits, MSB first — the order page 1 stores the
// password in (the firmware compares the 32 command bits, first bit = MSB, against page 1 as a big-endian word). Null
// if the length is not a whole number of bytes.
export function bitsToHex(bitStr) {
  if (!bitStr || bitStr.length % 8 !== 0) return null;
  let h = "";
  for (let i = 0; i < bitStr.length; i += 8)
    h += parseInt(bitStr.slice(i, i + 8), 2)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return h;
}

// Recover the reader's password from the trace. A reader whose password the emulated tag does not hold retries
// START_AUTH and its 32-bit password, so the same 32-bit command appears several times. Returns the value seen at
// least `min` times (the most frequent), as { hex, bits, count }, or null — the agreement guards against a mis-decode.
export function recoverPassword(recs, min = 2) {
  const counts = new Map();
  for (const r of recs) {
    if (r.type === TR.COMMAND && r.nBits === 32 && r.decode === 0)
      counts.set(r.bits, (counts.get(r.bits) || 0) + 1);
  }
  let best = null;
  for (const [bits, count] of counts)
    if (count >= min && (!best || count > best.count)) best = { bits, count };
  return best
    ? { hex: bitsToHex(best.bits), bits: best.bits, count: best.count }
    : null;
}

const s3 = (us) => (us / 1e6).toFixed(6);

// ---------------------------------------------------------------- the report

// Safe to share: whether a reader engaged, and how far. No decoded command or answer bits.
export function safeMarkdown(r) {
  const L = [];
  L.push(
    "**Chameleon Ultra interactive LF emulation report** (safe to share)",
    "",
  );
  L.push(`- Firmware: ${r.firmware}`);
  if (r.emu) {
    const c = describeConfig(r.emu);
    L.push(
      `- Emulating: Hitag 2, UID ${uidOf(r.emu)}, config 0x${c.byte.toString(16).padStart(2, "0")} (${c.mode} mode, ${c.coding})`,
    );
  }
  const c = r.counters;
  if (c)
    L.push(
      `- Trace: ${c.sessions} field session(s), ${c.commands} command(s), ${c.responses} answered, ${c.late} late, since the trace was cleared (boot ${r.boot})`,
    );
  const pw = recoverPassword(r.recs);
  if (pw)
    L.push(
      `- Reader password: recovered from ${pw.count} matching attempts (value in the private details)`,
    );
  if (r.total > r.recs.length)
    L.push(
      `- ⚠ ${r.total} records were made and ${r.recs.length} kept: the first ${r.keep} and the latest, with ${r.total - r.recs.length} in between overwritten`,
    );

  const ss = sessions(r.recs);
  if (ss.length === 0) {
    L.push(
      "",
      "No field sessions recorded. Point the CU at the reader and try again.",
    );
    return L.join("\n");
  }
  L.push("", "**What the reader did**");
  for (const s of ss) {
    const v = sessionVerdict(s);
    const t = s.off?.timing ?? s.commands[0]?.timing;
    const slotMode = t ? `, slot ${t.slot}, mode ${modeFlags(t.mode)}` : "";
    L.push(`- Boot ${s.boot}, session ${s.session}${slotMode}: ${v.verdict}.`);
    const extra = [];
    extra.push(`${s.commands.length} command(s), ${v.answered} answered`);
    if (v.reads) extra.push(`${v.reads} page read(s)`);
    if (v.late) extra.push("⚠ an answer was late");
    if (v.failed) extra.push(`${v.failed} not decoded`);
    L.push(`  (${extra.join("; ")})`);
  }
  return L.join("\n");
}

// Private: the reader's commands and the CU's answers, decoded to bits, with timings. A Hitag 2 reader's password is
// among these bits. Don't post it.
export function privateMarkdown(r) {
  const L = [];
  L.push("**Interactive LF trace — private details**", "");
  L.push(
    "A reader's commands decoded to bits (a Hitag 2 reader's password is one of them) and the CU's answers. Don't post this publicly.",
    "",
  );
  const pw = recoverPassword(r.recs);
  if (pw)
    L.push(
      `**Recovered reader password: ${pw.hex}** (${pw.bits}, from ${pw.count} matching attempts). Put it in page 1 to authenticate.`,
      "",
    );
  if (r.emu)
    L.push(
      "```",
      `emulated Hitag 2 pages: ${[...r.emu].map((x) => x.toString(16).padStart(2, "0")).join("")}`,
      "```",
      "",
    );
  const ss = sessions(r.recs);
  for (const s of ss) {
    const t = s.off?.timing ?? s.commands[s.commands.length - 1]?.timing;
    const head = t ? `, slot ${t.slot}, mode ${modeFlags(t.mode)}` : "";
    L.push(
      `### Boot ${s.boot}, session ${s.session}${head} — field on at ${s3(s.tSessionUs)} s`,
    );
    if (t) {
      const meas =
        t.measStatus === 255
          ? "no measurement ran"
          : `measured ${Math.round(t.fcMeasuredHz)} Hz (${MEAS[t.measStatus] ?? t.measStatus}, SNR ${t.measSnrDb.toFixed(1)} dB, took ${t.measUs} µs)`;
      L.push(
        `- timed the answer at ${Math.round(t.fcUsedHz)} Hz; ${t.fcMeasuredHz ? meas : "no carrier measured"}`,
      );
    }
    for (const c of s.commands) {
      const cl = classifyCommand(c);
      const parts = [
        `${s3(c.tUs)} s`,
        `${c.nGaps} gaps`,
        `${c.nBits} bits`,
        cl ? cl.label : "",
      ];
      if (c.decode !== 0) parts.push(`decode: ${DECODE[c.decode] ?? c.decode}`);
      else {
        const h = bitsToHex(c.bits);
        parts.push(`bits ${c.bits}${h ? ` (0x${h})` : ""}`);
      }
      parts.push(VERDICT[c.verdict] ?? c.verdict);
      L.push(`- ${parts.filter(Boolean).join(", ")}`);
      if (c.verdict === 1) {
        const flags = [];
        if (c.flags & FLAG.LATE) flags.push("LATE");
        if (c.flags & FLAG.ENCODE_FAILED) flags.push("encode failed");
        L.push(
          `  answer ${c.nTxBits} bits ${c.txBits}, ready ${c.tReadyUs - c.tUs} µs after the command, sent at ${c.tTxUs - c.tUs} µs (due ${c.tDueUs - c.tUs})${flags.length ? " " + flags.join(" ") : ""}`,
        );
        const seen = fieldSeenText(c);
        if (seen) L.push(`  ${seen}`);
      }
    }
    if (s.off)
      L.push(
        `- ${s3(s.off.tUs)} s field off${s.off.flags & FLAG.FIELD_BACK ? " (came back)" : ""}`,
      );
    L.push("");
  }
  return L.join("\n").trimEnd();
}
