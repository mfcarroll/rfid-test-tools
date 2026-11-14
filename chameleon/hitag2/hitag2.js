// Chameleon Ultra Hitag 2 emulation test: command IDs, the exchange trace, and the safe/private report.
// No DOM in here. The firmware is exp/lf-interactive.

export const STATUS = { SUCCESS: 0x68, INVALID_CMD: 0x67 };

export const CMD = {
  VERSION: 1017,
  SET_MODE: 1001,
  GET_MODE: 1002,
  SET_ACTIVE: 1003,
  SET_TYPE: 1004,
  SET_DEFAULT: 1005,
  SET_ENABLE: 1006,
  GET_ACTIVE: 1018,
  GET_SLOT_INFO: 1019,
  SAVE: 1009,
  H2_SET: 5040,
  H2_GET: 5041,
  TRACE_READ: 3180,
  TRACE_CLEAR: 3181,
};

export const TAG_TYPE_HITAG2 = 470;
export const SENSE_LF = 1;
const REC_SIZE = 268;

// Request helpers. The firmware reads a slot index as one byte, a set-enable as three, a tag type as a big-endian
// u16 after the slot, and a trace offset as a big-endian u16.
export const reqSlot = (fw) => new Uint8Array([fw]);
export const reqType = (fw, t) => new Uint8Array([fw, t >> 8, t & 0xff]);
export const reqEnable = (fw, sense, on) => new Uint8Array([fw, sense, on ? 1 : 0]);
export const reqMode = (reader) => new Uint8Array([reader ? 1 : 0]);
export const reqU16be = (n) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);

// The eight pages as 32 bytes, page 0 first. uid and pwd are 4-byte Uint8Arrays; the rest is the made-up test tag.
export function defaultPages(uid, pwd) {
  const p = new Uint8Array([
    0x01, 0x02, 0x03, 0x04, 0x0a, 0x0b, 0x0c, 0x0d, 0x02, 0x02, 0x02, 0x02, 0x06, 0x0e, 0x0f, 0x10,
    0x04, 0x04, 0x04, 0x04, 0x05, 0x05, 0x05, 0x05, 0x06, 0x06, 0x06, 0x06, 0x07, 0x07, 0x07, 0x07,
  ]);
  if (uid) p.set(uid, 0);
  if (pwd) p.set(pwd, 4);
  return p;
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// Parses "01020304" to a 4-byte array, or throws. name is for the message.
export function parseHex4(s, name) {
  const t = s.trim().replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]{8}$/.test(t)) throw new Error(`${name} must be 8 hex digits`);
  return Uint8Array.from(t.match(/../g), (h) => parseInt(h, 16));
}

// ---------------------------------------------------------------- the trace

const VERDICT = { 0: "ignored", 1: "answered", 2: "ended the exchange" };
const DECODE = { 0: "ok", 1: "one interval class", 2: "too few gaps", 3: "too many gaps" };
// Record flags, matching lf_ia_trace.h.
const F_LATE = 1,
  F_FIELD_BACK = 8;

function bitsStr(bytes, n) {
  n = Math.min(n, 8 * bytes.length);
  let s = "";
  for (let i = 0; i < n; i++) s += (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return s;
}

// Splits a trace-read reply into its header and raw 268-byte records.
export function parseTraceChunk(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const total = dv.getUint32(0, true);
  const size = dv.getUint16(4, true);
  const n = dv.getUint8(6);
  const recs = [];
  for (let i = 0; i < n; i++) recs.push(data.slice(7 + i * size, 7 + (i + 1) * size));
  return { total, size, n, recs };
}

export function parseRec(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const r = {
    type: dv.getUint8(0),
    verdict: dv.getUint8(1),
    decode: dv.getUint8(2),
    flags: dv.getUint8(3),
    t_us: dv.getUint32(4, true),
    t_detect: dv.getUint32(8, true),
    t_ready: dv.getUint32(12, true),
    t_due: dv.getUint32(16, true),
    t_tx: dv.getUint32(20, true),
    t_tx_end: dv.getUint32(24, true),
    n_gaps: dv.getUint16(28, true),
    n_bits: dv.getUint16(30, true),
    n_tx_bits: dv.getUint16(32, true),
    n_runs: dv.getUint16(34, true),
    split: dv.getUint32(36, true),
    level: dv.getUint16(40, true),
    n_noise: dv.getUint16(42, true),
  };
  r.bits = bitsStr(bytes.subarray(44, 60), r.n_bits);
  r.txBits = bitsStr(bytes.subarray(60, 76), r.n_tx_bits);
  r.late = (r.flags & F_LATE) !== 0;
  r.fieldBack = (r.flags & F_FIELD_BACK) !== 0;
  return r;
}

// A reader command's role, from its decoded length. Hitag 2 frames are 5, 10, 32 or 64 bits.
export function commandRole(rec) {
  if (rec.decode !== 0) return "undecoded";
  if (rec.n_bits === 5) return "START_AUTH";
  if (rec.n_bits === 10) return "read";
  if (rec.n_bits === 32) return "password";
  if (rec.n_bits === 64) return "crypto";
  return "other";
}

// ---------------------------------------------------------------- the report

// Walks the records and counts what the reader did. The password's bits never enter this summary.
export function classify(recs) {
  const c = {
    records: recs.length,
    fields: 0,
    commands: 0,
    startAuth: 0,
    uidRead: 0,
    password: 0,
    passwordMatched: 0,
    crypto: 0,
    reads: 0,
    undecoded: 0,
    late: 0,
  };
  for (const r of recs) {
    if (r.type === 1) c.fields++;
    if (r.type !== 3) continue;
    c.commands++;
    if (r.late) c.late++;
    const role = commandRole(r);
    if (role === "START_AUTH") {
      c.startAuth++;
      if (r.verdict === 1) c.uidRead++;
    } else if (role === "password") {
      c.password++;
      if (r.verdict === 1) c.passwordMatched++;
    } else if (role === "crypto") {
      c.crypto++;
    } else if (role === "read") {
      if (r.verdict === 1) c.reads++;
    } else if (role === "undecoded") {
      c.undecoded++;
    }
  }
  return c;
}

// The one-line verdict the safe report leads with.
export function headline(c, uid) {
  if (c.fields === 0) return "No reader field seen. Hold the CU to the reader and read the trace again.";
  if (c.startAuth === 0)
    return "A field appeared, but no Hitag 2 START_AUTH. This may not be a Hitag 2 reader, or the CU was not coupled to it.";
  if (c.uidRead === 0)
    return `The reader sent START_AUTH but did not read back the UID ${uid}. The uplink did not reach it: adjust the CU's position.`;
  if (c.reads > 0)
    return `The reader read the UID ${uid}, authenticated, and read pages. Password-mode emulation works end to end against this reader.`;
  if (c.crypto > 0)
    return `The reader read the UID ${uid}, then sent a crypto-mode command. This is a Hitag 2 crypto reader, which this emulation does not answer.`;
  if (c.password > 0 && c.passwordMatched === 0)
    return `The reader read the UID ${uid} and sent a password that did not match the emulated one. The uplink works, and this is a password-mode reader. Set the reader's own password to read further.`;
  return `The reader read the UID ${uid}. The interactive uplink works against this reader.`;
}

export function safeMarkdown(report) {
  const { firmware, uid, counts } = report;
  const lines = [
    "# Chameleon Ultra — Hitag 2 emulation test",
    "",
    `Firmware: ${firmware}`,
    `Emulated UID: ${uid}`,
    "",
    `Reader fields seen: ${counts.fields}`,
    `UID requests (START_AUTH): ${counts.startAuth}, UID read back: ${counts.uidRead}`,
    `Password-mode commands (32-bit): ${counts.password}` +
      (counts.password ? `, matched the emulated password: ${counts.passwordMatched ? "yes" : "no"}` : ""),
    `Crypto-mode commands (64-bit): ${counts.crypto}`,
    `Page reads (10-bit): ${counts.reads}`,
    `Answers sent late: ${counts.late}`,
  ];
  if (counts.undecoded) lines.push(`Commands the CU could not decode: ${counts.undecoded}`);
  lines.push("", headline(counts, uid));
  return lines.join("\n");
}

// The per-command detail, with the reader's decoded bits. A password-mode command's bits ARE the reader's password,
// so this stays out of the safe report.
export function privateMarkdown(report) {
  const lines = ["**Private details**", "", "A reader's command bits can be its password. Do not post these."];
  for (const r of report.recs) {
    if (r.type === 1) {
      lines.push(`${(r.t_us / 1e6).toFixed(6)} s  field on`);
    } else if (r.type === 2) {
      lines.push(`${(r.t_us / 1e6).toFixed(6)} s  field off${r.fieldBack ? " (came back)" : ""}`);
    } else if (r.type === 3) {
      const role = commandRole(r);
      let line = `${(r.t_us / 1e6).toFixed(6)} s  ${role}, ${r.n_gaps} gaps`;
      line += r.decode === 0 ? `, bits ${r.bits}` : `, decode ${DECODE[r.decode] ?? r.decode}`;
      line += `, ${VERDICT[r.verdict] ?? r.verdict}`;
      lines.push(line);
      if (r.verdict === 1)
        lines.push(
          `          answer ${r.txBits}, ready ${r.t_ready - r.t_us} us after the command, sent ${r.t_tx - r.t_us} us (due ${r.t_due - r.t_us})${r.late ? " LATE" : ""}`,
        );
    }
  }
  return lines.join("\n");
}
