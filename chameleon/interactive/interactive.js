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
export const REC_SIZE = 276; // sizeof(lf_ia_trace_rec_t)
export const TRACE_KEEP = 8; // the first records a clear keeps (LF_IA_TRACE_KEEP), for a note when some roll off

// lf_ia_trace.h
export const TR = { FIELD_OFF: 2, COMMAND: 3 };
export const VERDICT = ["ignored", "answered", "ended"];
export const DECODE = ["ok", "one class", "too few gaps", "overflow"];
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

export function parseRecord(buf, o = 0) {
  const v = new DataView(buf.buffer, buf.byteOffset + o);
  const u8 = (i) => v.getUint8(i);
  const u16 = (i) => v.getUint16(i, true);
  const u32 = (i) => v.getUint32(i, true);
  const nGaps = u16(28);
  const gaps = [];
  for (let i = 0; i < Math.min(nGaps, 48); i++) {
    gaps.push({ startUs: u16(76 + i * 4), widthUs: u16(76 + i * 4 + 2) });
  }
  const nBits = u16(30);
  const nTxBits = u16(32);
  return {
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
  for (let i = 0; i < n; i++) recs.push(parseRecord(d, 10 + i * size));
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
    L.push(`- Boot ${s.boot}, session ${s.session}: ${v.verdict}.`);
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
    L.push(
      `### Boot ${s.boot}, session ${s.session} — field on at ${s3(s.tSessionUs)} s`,
    );
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
