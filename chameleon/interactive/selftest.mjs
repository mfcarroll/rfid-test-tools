// node selftest.mjs: the trace parser, the session grouping and verdicts, and the privacy split of the report,
// against a synthetic trace in the firmware's layout (lf_ia_trace_rec_t).
import * as P from "./interactive.js";

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

check(
  P.REC_SIZE === 276,
  `record size ${P.REC_SIZE} matches sizeof(lf_ia_trace_rec_t)`,
);

// Pack bits first-sent-first into a 16-byte field, as the firmware does.
function packBits(str) {
  const b = new Uint8Array(16);
  for (let i = 0; i < str.length; i++)
    if (str[i] === "1") b[i >> 3] |= 1 << (7 - (i & 7));
  return b;
}

// Build one 276-byte record.
function rec({
  type = P.TR.COMMAND,
  verdict = 1,
  decode = 0,
  flags = 0,
  tUs = 0,
  nBits = 0,
  bits = "",
  txBits = "",
  tReady = 0,
  tDue = 0,
  tTx = 0,
  boot = 1,
  session = 1,
  tSession = 0,
  nGaps = 0,
}) {
  const b = new Uint8Array(P.REC_SIZE);
  const v = new DataView(b.buffer);
  b[0] = type;
  b[1] = verdict;
  b[2] = decode;
  b[3] = flags;
  // tReady/tDue/tTx are given as offsets from the command's end, as the device's absolute times appear once reduced.
  v.setUint32(4, tUs, true);
  v.setUint32(12, tReady ? tUs + tReady : 0, true);
  v.setUint32(16, tDue ? tUs + tDue : 0, true);
  v.setUint32(20, tTx ? tUs + tTx : 0, true);
  v.setUint16(28, nGaps || (nBits ? nBits + 1 : 0), true);
  v.setUint16(30, nBits, true);
  v.setUint16(32, txBits.length, true);
  b.set(packBits(bits), 44);
  b.set(packBits(txBits), 60);
  v.setUint16(268, boot, true);
  v.setUint16(270, session, true);
  v.setUint32(272, tSession, true);
  return b;
}

// A trace-read reply: 10-byte header, then records.
function reply(
  recs,
  { total = recs.length, keep = P.TRACE_KEEP, boot = 1 } = {},
) {
  const d = new Uint8Array(10 + recs.length * P.REC_SIZE);
  const v = new DataView(d.buffer);
  v.setUint32(0, total, true);
  v.setUint16(4, P.REC_SIZE, true);
  d[6] = recs.length;
  d[7] = keep;
  v.setUint16(8, boot, true);
  recs.forEach((r, i) => d.set(r, 10 + i * P.REC_SIZE));
  return d;
}

// ---------------------------------------------------------------- a full password-mode read (boot 2), then a crypto
// reader (boot 3) and a START_AUTH-only session (boot 4)

const PWD = "10100101010011001110111100010001"; // a recognisable 32-bit reader password
const UID = "00010000001000000011000000000100"; // 01020304 as a 32-bit answer payload, SOF omitted for the test
const recs = [
  rec({
    nBits: 5,
    bits: "11000",
    txBits: "1111100000000100000001000000011000001",
    tUs: 4000,
    tReady: 694,
    tDue: 1920,
    tTx: 1921,
    boot: 2,
    session: 1,
    tSession: 100,
  }),
  rec({
    nBits: 32,
    bits: PWD,
    txBits: "1111100000011000000111000001111000100",
    tUs: 33000,
    tReady: 598,
    tDue: 1920,
    tTx: 1921,
    boot: 2,
    session: 1,
    tSession: 100,
  }),
  rec({
    nBits: 10,
    bits: "1100000111",
    txBits: "1".repeat(37),
    tUs: 58000,
    tReady: 575,
    tDue: 1920,
    tTx: 1921,
    boot: 2,
    session: 1,
    tSession: 100,
  }),
  rec({
    type: P.TR.FIELD_OFF,
    verdict: 0,
    tUs: 70000,
    boot: 2,
    session: 1,
    tSession: 100,
  }),
  // boot 3: crypto reader (START_AUTH answered, then a 64-bit command the module ignores)
  rec({
    nBits: 5,
    bits: "11000",
    txBits: "1".repeat(37),
    tUs: 4000,
    tReady: 600,
    tDue: 1920,
    tTx: 1921,
    boot: 3,
    session: 2,
    tSession: 100,
  }),
  rec({
    nBits: 64,
    bits: "0".repeat(64),
    verdict: 0,
    tUs: 33000,
    boot: 3,
    session: 2,
    tSession: 100,
  }),
  rec({
    type: P.TR.FIELD_OFF,
    verdict: 0,
    tUs: 50000,
    boot: 3,
    session: 2,
    tSession: 100,
  }),
  // boot 4: START_AUTH, answered, but nothing follows
  rec({
    nBits: 5,
    bits: "11000",
    txBits: "1".repeat(37),
    tUs: 4000,
    tReady: 600,
    tDue: 1920,
    tTx: 1921,
    boot: 4,
    session: 3,
    tSession: 100,
  }),
  rec({
    type: P.TR.FIELD_OFF,
    verdict: 0,
    tUs: 40000,
    boot: 4,
    session: 3,
    tSession: 100,
  }),
];

const parsed = P.parseTraceReply(reply(recs, { total: 9, boot: 5 }));
check(parsed.n === 9 && parsed.recs.length === 9, `parsed ${parsed.n} records`);
check(parsed.boot === 5, `current boot ${parsed.boot}`);
check(
  parsed.recs[1].bits === PWD,
  "the 32-bit command decodes to the sent password bits",
);
check(
  parsed.recs[1].tReadyUs - parsed.recs[1].tUs === 598,
  "ready time is relative-able",
);

const ss = P.sessions(parsed.recs);
check(ss.length === 3, `three field sessions (${ss.length})`);
check(
  ss[0].commands.length === 3 && ss[0].off,
  "session 1 has three commands and a field-off",
);

const v1 = P.sessionVerdict(ss[0]);
check(
  v1.passwordAnswered && v1.reads === 1,
  "session 1: password authenticated, one page read",
);
const v2 = P.sessionVerdict(ss[1]);
check(v2.sawCrypto, "session 2: crypto mode seen");
const v3 = P.sessionVerdict(ss[2]);
check(
  v3.startAnswered && !v3.sawPassword,
  "session 3: START_AUTH answered, no password",
);

// ---------------------------------------------------------------- the privacy split

const r = {
  firmware: "v2.3.0-27-g0d433f7",
  emu: P.pagesWithUid("11223344"),
  counters: { sessions: 6, commands: 9, responses: 7, late: 0 },
  boot: 5,
  total: 9,
  keep: 8,
  recs: parsed.recs,
};
const safe = P.safeMarkdown(r);
const priv = P.privateMarkdown(r);

check(
  !safe.includes(PWD),
  "the safe report does NOT contain the reader's password bits",
);
check(
  !safe.includes("1111100000011000"),
  "the safe report does NOT contain answer bits",
);
check(
  priv.includes(PWD),
  "the private details DO contain the reader's password bits",
);
check(safe.includes("UID 11223344"), "the safe report names the emulated UID");
check(
  safe.includes("crypto mode"),
  "the safe report flags the crypto-mode reader",
);
check(
  safe.includes("password mode") && safe.includes("served its pages"),
  "the safe report states the password-mode success",
);

// ---------------------------------------------------------------- config decode and UID helpers

check(
  P.describeConfig(P.PLACEHOLDER_PAGES).mode === "password",
  "placeholder config is password mode",
);
check(
  P.describeConfig(P.PLACEHOLDER_PAGES).coding === "Hitag 2",
  "placeholder config coding is Hitag 2",
);
check(
  P.parseUid("0x01020304") === "01020304" && P.parseUid("zz") === null,
  "UID parsing",
);
check(
  P.uidOf(P.pagesWithUid("DEADBEEF")) === "DEADBEEF",
  "UID round-trips into the pages",
);

// overwritten-stretch note
const many = P.safeMarkdown({ ...r, total: 40, recs: parsed.recs });
check(
  many.includes("overwritten"),
  "the safe report notes overwritten records when some rolled off",
);

// ---------------------------------------------------------------- the editable fields

check(
  P.parseHex("0A0B0C0D", 4) !== null && P.parseHex("0a0b", 4) === null,
  "parseHex enforces the byte count",
);
check(
  P.parseHex("06", 1)[0] === 0x06 && P.parseHex("zz", 1) === null,
  "parseHex reads one byte, rejects junk",
);

const fields = {
  p0: "AABBCCDD",
  p1: "11223344",
  p2: "22222222",
  config: "06",
  tagpw: "556677",
  p4: "04040404",
  p5: "05050505",
  p6: "06060606",
  p7: "07070707",
};
const built = P.pagesFromFields(fields);
check(built.length === 32, "pagesFromFields returns 32 bytes");
check(P.uidOf(built) === "AABBCCDD", "pagesFromFields writes page 0 (UID)");
check(
  built[4] === 0x11 && built[7] === 0x44,
  "pagesFromFields writes page 1 (reader password)",
);
check(built[8] === 0x22 && built[11] === 0x22, "pagesFromFields writes page 2");
check(built[12] === 0x06, "pagesFromFields writes the config byte");
check(
  built[13] === 0x55 && built[15] === 0x77,
  "pagesFromFields writes the tag password after the config byte",
);
check(
  built[28] === 0x07 && built[31] === 0x07,
  "pagesFromFields writes page 7",
);
check(
  P.pagesFromFields({ ...fields, p0: "xyz" }) === null,
  "pagesFromFields rejects an invalid field",
);

const round = P.fieldsFromPages(built);
check(
  round.p0 === "AABBCCDD" &&
    round.p1 === "11223344" &&
    round.p2 === "22222222" &&
    round.config === "06" &&
    round.tagpw === "556677" &&
    round.p7 === "07070707",
  "fieldsFromPages round-trips every page",
);

check(P.HITAG2_PAGE_NAMES.length === 8, "a name for each of the eight pages");
check(
  P.HITAG2_PAGE_NAMES[1] === "Reader password" &&
    P.HITAG2_PAGE_NAMES[2].includes("crypto"),
  "page names read in order",
);

// ---------------------------------------------------------------- reading a physical tag

// A HITAG2_SCAN reply: four UID bytes.
check(
  P.parseHitag2Scan(Uint8Array.of(0xde, 0xad, 0xbe, 0xef)) === "DEADBEEF",
  "parseHitag2Scan reads the UID",
);
check(
  P.parseHitag2Scan(Uint8Array.of(1, 2)) === null,
  "parseHitag2Scan rejects a short reply",
);

// A HITAG2_READ reply: 32 page bytes, then a 1-byte mask. Here pages 0,1,3 read (mask 0b00001011), the rest not.
const readData = new Uint8Array(33);
for (let i = 0; i < 32; i++) readData[i] = i + 1;
readData[32] = 0b00001011;
const read = P.parseHitag2Read(readData);
check(
  read.count === 3 && read.mask === 0x0b,
  "parseHitag2Read counts the pages read",
);
check(
  read.pages[0] !== null && read.pages[2] === null && read.pages[3] !== null,
  "parseHitag2Read marks unread pages null",
);
check(
  P.parseHitag2Read(new Uint8Array(10)) === null,
  "parseHitag2Read rejects a short reply",
);

const folded = P.pagesFromRead(read);
check(
  folded[0] === 1 && folded[13] === 14,
  "pagesFromRead keeps the read pages",
);
check(
  folded[8] === P.PLACEHOLDER_PAGES[8],
  "pagesFromRead fills an unread page from the base",
);
// Page 3 was read (byte 12 = 0x0D here), so a read surfaces the tag's real config, not a forced 06.
check(
  P.fieldsFromPages(folded).config === "0D",
  "fieldsFromPages surfaces the tag's real config byte",
);
check(
  P.describeConfig(folded).byte === 0x0d,
  "describeConfig reads the real config byte",
);

// A real tag read into the fields must not leak into the safe report: its password lives on page 1, private only.
const realPw = "A1B2C3D4";
const realPages = P.pagesFromFields({
  p0: "01020304",
  p1: realPw,
  p2: "22222222",
  config: "06",
  tagpw: "0E0F10",
  p4: "04040404",
  p5: "05050505",
  p6: "06060606",
  p7: "07070707",
});
const realReport = { ...r, emu: realPages };
check(
  !P.safeMarkdown(realReport).includes(realPw),
  "a read-in tag's password does NOT reach the safe report",
);
check(
  P.privateMarkdown(realReport).toLowerCase().includes(realPw.toLowerCase()),
  "a read-in tag's pages ARE in the private details",
);

// ---------------------------------------------------------------- recovering the reader password

check(
  P.bitsToHex("01010101011001100111011110001001") === "55667789",
  "bitsToHex groups 8 bits MSB-first",
);
check(P.bitsToHex("11000") === null, "bitsToHex rejects a non-byte length");

const PW_BITS = "01010101011001100111011110001001"; // 0x55667789
const recovParsed = P.parseTraceReply(
  reply(
    [
      rec({
        nBits: 5,
        bits: "11000",
        txBits: "1".repeat(37),
        tUs: 4000,
        boot: 2,
        session: 1,
      }),
      rec({
        nBits: 32,
        bits: PW_BITS,
        verdict: 0,
        tUs: 20000,
        boot: 2,
        session: 1,
      }),
      rec({
        nBits: 32,
        bits: PW_BITS,
        verdict: 0,
        tUs: 40000,
        boot: 2,
        session: 1,
      }),
      rec({
        nBits: 32,
        bits: PW_BITS,
        verdict: 0,
        tUs: 60000,
        boot: 2,
        session: 1,
      }),
    ],
    { boot: 2 },
  ),
).recs;
const rp = P.recoverPassword(recovParsed);
check(
  rp && rp.hex === "55667789" && rp.count === 3,
  "recoverPassword finds the repeated password",
);
check(
  P.recoverPassword(recovParsed.slice(0, 2)) === null,
  "recoverPassword needs at least two that match",
);

const recovReport = {
  firmware: "x",
  counters: { sessions: 1, commands: 4, responses: 0, late: 0 },
  boot: 2,
  total: 4,
  keep: 8,
  recs: recovParsed,
};
check(
  P.safeMarkdown(recovReport).includes("Reader password: recovered") &&
    !P.safeMarkdown(recovReport).includes("55667789"),
  "safe report notes the recovery but hides the value",
);
check(
  P.privateMarkdown(recovReport).includes("55667789"),
  "private details give the recovered password hex",
);

// ---------------------------------------------------------------- the exp/lf-hitag-modes 290-byte record (timing)

check(P.REC_SIZES.has(290), "the 290-byte timing record is a known size");
check(
  P.modeFlags(0) === "baseline" &&
    P.modeFlags(0b111) === "scale+alt-delay+every-second",
  "modeFlags names the mode bits",
);

// Build one 290-byte record: a 276-byte base with the 14 timing bytes appended.
function recTiming(base, timing) {
  const b = new Uint8Array(290);
  b.set(base, 0);
  const v = new DataView(b.buffer);
  v.setUint32(276, Math.round(timing.fcUsedHz * 10), true);
  v.setUint32(280, Math.round(timing.fcMeasuredHz * 10), true);
  v.setInt16(284, Math.round(timing.measSnrDb * 10), true);
  b[286] = timing.measStatus;
  b[287] = timing.mode;
  b[288] = timing.slot;
  b[289] = Math.round(timing.measUs / 32);
  return b;
}
function replyTiming(recs, boot = 2) {
  const d = new Uint8Array(10 + recs.length * 290);
  const v = new DataView(d.buffer);
  v.setUint32(0, recs.length, true);
  v.setUint16(4, 290, true);
  d[6] = recs.length;
  d[7] = P.TRACE_KEEP;
  v.setUint16(8, boot, true);
  recs.forEach((r, i) => d.set(r, 10 + i * 290));
  return d;
}

const tCmd = recTiming(
  rec({
    nBits: 5,
    bits: "11000",
    txBits: "1".repeat(37),
    tUs: 4000,
    boot: 2,
    session: 1,
    tSession: 100,
  }),
  {
    fcUsedHz: 125300,
    fcMeasuredHz: 125300,
    measSnrDb: 22.4,
    measStatus: 0,
    mode: 0b101,
    slot: 3,
    measUs: 1024,
  },
);
const tOff = recTiming(
  rec({
    type: P.TR.FIELD_OFF,
    verdict: 0,
    tUs: 50000,
    boot: 2,
    session: 1,
    tSession: 100,
  }),
  {
    fcUsedHz: 125300,
    fcMeasuredHz: 125300,
    measSnrDb: 22.4,
    measStatus: 0,
    mode: 0b101,
    slot: 3,
    measUs: 1024,
  },
);
const tParsed = P.parseTraceReply(replyTiming([tCmd, tOff]));
check(
  tParsed.size === 290 && tParsed.recs.length === 2,
  "parses a 290-byte reply",
);
const tim = tParsed.recs[0].timing;
check(
  tim && tim.slot === 3 && tim.mode === 0b101,
  "timing carries the slot and mode",
);
check(
  tim &&
    Math.round(tim.fcMeasuredHz) === 125300 &&
    Math.abs(tim.measSnrDb - 22.4) < 0.05,
  "timing carries the measured carrier and SNR",
);
// The 294-byte record carries where the field was last seen. Field gone in bit 3 of the answer.
{
  const w = new Uint8Array(294);
  w.set(tCmd.slice(0, 290));
  const wv = new DataView(w.buffer);
  wv.setUint32(20, 100000, true); // t_tx_us
  wv.setUint32(24, 100000 + 37 * 256, true); // t_tx_end_us
  wv.setUint16(32, 37, true); // n_tx_bits
  const base = P.parseRecord(w, 0, 290);
  const bitUs = 256;
  wv.setUint32(290, Math.round(base.tTxUs + 3.5 * bitUs), true);
  const r = P.parseRecord(w, 0, 294);
  check(
    P.REC_SIZES.has(294),
    "the 294-byte field-watch record is a known size",
  );
  check(
    r.tFieldSeenUs === Math.round(base.tTxUs + 3.5 * bitUs) &&
      /in bit 3 of/.test(P.fieldSeenText(r)),
    `field watch: ${P.fieldSeenText(r)}`,
  );
  wv.setUint32(290, base.tTxEndUs, true);
  check(
    /still on/.test(P.fieldSeenText(P.parseRecord(w, 0, 294))),
    "field still on at the answer's end",
  );
  check(
    P.fieldSeenText(base) === null,
    "a 290-byte record says nothing about the field",
  );
  check(P.modeFlags(8) === "rest-loaded", "mode 8 is rest-loaded");
}
// The base 276-byte record parses with no timing attached.
check(
  P.parseRecord(tCmd.slice(0, 276), 0, 276).timing === undefined,
  "a 276-byte record has no timing field",
);
const tReport = {
  firmware: "v2.3.0-49-g361e7f9",
  counters: { sessions: 1, commands: 1, responses: 1, late: 0 },
  boot: 2,
  total: 2,
  keep: 8,
  recs: tParsed.recs,
};
check(
  P.safeMarkdown(tReport).includes("slot 3") &&
    P.safeMarkdown(tReport).includes("scale+every-second"),
  "the safe report names the slot and mode from the timing fields",
);
check(
  P.privateMarkdown(tReport).includes("125300 Hz"),
  "the private report shows the measured carrier",
);

// ---------------------------------------------------------------- the tag's answer timing (LF_RDR_LAST / CAPTURE)

// Build an LF_RDR_LAST reply: n_bits u16, 32 bytes of bits, first u16, idle/load/threshold i16, n_runs u16, runs u16.
function lastReply({
  nBits = 5,
  first = 30,
  idle = 4138,
  load = 14152,
  threshold = 9000,
  runs = [],
}) {
  const d = new Uint8Array(44 + runs.length * 2);
  const v = new DataView(d.buffer);
  v.setUint16(0, nBits, true);
  d.set(packBits("11000"), 2); // a recognisable answer; bitsStr reads nBits of it
  v.setUint16(34, first, true);
  v.setInt16(36, idle, true);
  v.setInt16(38, load, true);
  v.setInt16(40, threshold, true);
  v.setUint16(42, runs.length, true);
  runs.forEach((r, i) =>
    v.setUint16(44 + i * 2, (r.load ? 0x8000 : 0) | (r.fc & 0x7fff), true),
  );
  return d;
}

const lastT = P.parseLastReply(
  lastReply({
    runs: [
      { load: true, fc: 32 },
      { load: false, fc: 16 },
      { load: true, fc: 8 },
    ],
  }),
);
check(lastT.nBits === 5 && lastT.bits === "11000", "parseLastReply reads bits");
check(lastT.delayUs === 240, "delay is first * 8 µs");
check(
  lastT.idle === 4138 && lastT.load === 14152 && lastT.depth === 10014,
  "levels and depth (|load - idle|)",
);
check(
  lastT.nRuns === 3 &&
    lastT.runs[0].load === true &&
    lastT.runs[0].us === 256 &&
    lastT.runs[1].load === false &&
    lastT.runs[1].us === 128,
  "runs decode load flag and length to µs",
);
check(lastT.totalUs === 448, "total is the sum of the runs' µs");
check(
  P.parseLastReply(new Uint8Array(20)) === null,
  "parseLastReply rejects a short reply",
);

// The reported run count can exceed the runs present (the reply caps at 400); the parser stops at the buffer.
const capped = lastReply({
  runs: Array.from({ length: 400 }, () => ({ load: true, fc: 1 })),
});
new DataView(capped.buffer).setUint16(42, 500, true); // claim 500, only 400 present
const cappedT = P.parseLastReply(capped);
check(
  cappedT.nRuns === 500 && cappedT.runs.length === 400,
  "parser stops at the runs present",
);

// LF_RDR_CAPTURE reply: total u16, count u16, then i16 samples.
const capBuf = new Uint8Array(4 + 3 * 2);
const capV = new DataView(capBuf.buffer);
capV.setUint16(0, 200, true);
capV.setUint16(2, 3, true);
[100, -50, 4138].forEach((s, i) => capV.setInt16(4 + i * 2, s, true));
const cap = P.parseCapture(capBuf);
check(
  cap.total === 200 && cap.count === 3 && cap.samples[1] === -50,
  "parseCapture reads the envelope samples",
);

// HITAG2_READER_LINK reply: a 20-byte lf_rdr_link_t.
const linkBuf = new Uint8Array(20);
const linkV = new DataView(linkBuf.buffer);
linkV.setUint16(0, 64, true); // gap_us
linkV.setUint16(2, 128, true); // bit0_us
linkV.setUint16(15, 2048, true); // capture_n
linkV.setInt16(17, 5000, true); // min_depth
linkBuf[19] = 50; // slice_pct
const link = P.parseReaderLink(linkBuf);
check(
  link.gapUs === 64 &&
    link.bit0Us === 128 &&
    link.captureN === 2048 &&
    link.minDepth === 5000 &&
    link.slicePct === 50,
  "parseReaderLink reads the link fields",
);

// ---------------------------------------------------------------- the whole exchange (LF_RDR_TRACE_READ)

check(
  P.exchangeLabel(5, 0x18) === "START_AUTH" &&
    P.exchangeLabel(32, 0) === "password" &&
    P.exchangeLabel(10, (3 << 8) | (5 << 5) | (~5 & 7)) === "read page 5",
  "exchangeLabel names START_AUTH, password and a page read",
);

// Build one trace record (LF_RDR_TRACE_REC_SIZE bytes): n_tx u8, tx 4 bytes (first-bit-first), power-up u16, flags u8,
// n_bits u16, first u16, idle/load/threshold i16, n_runs u16, then TRACE_RUNS runs u16.
function traceRec({
  nTx = 5,
  tx = 0x18,
  powerUp = 0,
  clean = 1,
  nBits = 0,
  first = 30,
  idle = 4138,
  load = 14152,
  threshold = 9000,
  runs = [],
}) {
  const d = new Uint8Array(P.TRACE_REC_SIZE);
  const v = new DataView(d.buffer);
  d[0] = nTx;
  for (let i = 0; i < nTx && i < 32; i++)
    if ((tx >> (nTx - 1 - i)) & 1) d[1 + (i >> 3)] |= 1 << (7 - (i & 7));
  v.setUint16(5, powerUp, true);
  d[7] = clean;
  v.setUint16(8, nBits, true);
  v.setUint16(10, first, true);
  v.setInt16(12, idle, true);
  v.setInt16(14, load, true);
  v.setInt16(16, threshold, true);
  v.setUint16(18, runs.length, true);
  runs.forEach((r, i) =>
    v.setUint16(20 + i * 2, (r.load ? 0x8000 : 0) | (r.fc & 0x7fff), true),
  );
  return d;
}

const startRec = traceRec({ nTx: 5, tx: 0x18, powerUp: 2968, nBits: 0 });
const pageRec = traceRec({
  nTx: 10,
  tx: (3 << 8) | (2 << 5) | (~2 & 7),
  nBits: 38,
  first: 189,
  runs: [
    { load: true, fc: 20 },
    { load: false, fc: 13 },
  ],
});
const recParsed = P.parseTraceRecord(pageRec);
check(
  recParsed.cmd === "read page 2" && recParsed.nTx === 10,
  "parseTraceRecord decodes the command",
);
check(
  recParsed.nBits === 38 &&
    recParsed.answered === true &&
    recParsed.delayUs === 189 * 8 &&
    recParsed.depth === 10014 &&
    recParsed.runs[0].us === 160 &&
    recParsed.totalUs === 264,
  "parseTraceRecord reads the answer and runs",
);
check(
  P.parseTraceRecord(startRec).answered === false &&
    P.parseTraceRecord(startRec).powerUpUs === 2968,
  "a no-answer record is marked not answered and keeps its power-up",
);

// LF_RDR_TRACE_READ reply: total u16, size u16, count u8, then the records.
function traceReply(recs, total = recs.length) {
  const d = new Uint8Array(5 + recs.length * P.TRACE_REC_SIZE);
  const v = new DataView(d.buffer);
  v.setUint16(0, total, true);
  v.setUint16(2, P.TRACE_REC_SIZE, true);
  d[4] = recs.length;
  recs.forEach((r, i) => d.set(r, 5 + i * P.TRACE_REC_SIZE));
  return d;
}
const reply2 = P.parseReaderTraceReply(traceReply([startRec, pageRec]));
check(
  reply2.total === 2 &&
    reply2.size === P.TRACE_REC_SIZE &&
    reply2.recs.length === 2 &&
    reply2.recs[1].cmd === "read page 2",
  "parseReaderTraceReply reads the header and records",
);

const txns = reply2.recs;
const exLog = P.exchangeLogText(txns);
check(
  exLog.includes("#0 START_AUTH: no answer") &&
    exLog.includes("#1 read page 2: 38 bit(s)") &&
    exLog.includes("L160") &&
    exLog.includes("power-up 2968 µs"),
  "exchangeLogText lists every command with its runs",
);

const exRec = P.buildExchangeRecord(
  { firmware: "v2.3.0-52-g25fdc86", action: "read", uid: "024E0220" },
  txns,
  cap,
  link,
);
check(
  exRec.action === "read" &&
    exRec.uid === "024E0220" &&
    exRec.transactions.length === 2 &&
    exRec.transactions[1].depth === 10014 &&
    exRec.lastEnvelope.samples.length === 3 &&
    exRec.link.minDepth === 5000,
  "buildExchangeRecord keeps every transaction, the last envelope and the link",
);

// The safe timing summary: no UID, no command value, no runs. A made-up exchange: START_AUTH, the password 0x4D494B52,
// a page read and an unknown 12-bit command, each answered with 16- and 32-period runs.
{
  const runs = [17, 15, 33, 31, 17, 15, 16].map((fc, i) => ({
    load: i % 2 === 0,
    fc,
    us: fc * 8,
  }));
  const tx = (nTx, v, delayUs) => ({
    nTx,
    tx: v,
    cmd: P.exchangeLabel(nTx, v),
    clean: true,
    nBits: 37,
    answered: true,
    delayUs,
    idle: 4300,
    load: 14300,
    threshold: 9300,
    depth: 10000,
    nRuns: runs.length,
    totalUs: 1152,
    runs,
  });
  const rec = P.buildExchangeRecord(
    { firmware: "v2.3.0-90-gd50aac6", action: "read", uid: "A1B2C3D4" },
    [
      tx(5, 0x18, 1264),
      tx(32, 0x4d494b52, 1296),
      tx(10, (3 << 8) | (5 << 5) | (~5 & 7), 1288),
      tx(12, 0xabc, 1296),
    ],
    { total: 3, samples: [1, 2, 3] },
    { ...link, stopUs: 288 },
  );
  rec.startAuth = {
    thisRead: { again: 0, skipped: 1, unclear: 0 },
    total: { again: 0, skipped: 1, unclear: 0 },
    verdict: "every-second",
  };
  const safe = P.safeTimingMarkdown(rec);
  check(
    !/a1b2c3d4|4d494b52|abc\b|0x/i.test(safe) &&
      !/L1\d\d|·1\d\d/.test(safe) &&
      safe.includes("12-bit command") &&
      safe.includes("read page 5"),
    "the safe timing summary has no UID, command value or runs",
  );
  check(
    safe.includes("START_AUTH 194 (1)") &&
      safe.includes("password 198 (1)") &&
      safe.includes("page reads 197 (1)") &&
      safe.includes("| 1 | password | 37 bit | 1296 | 198 |"),
    "the safe timing summary counts periods from the stop gap: (delay + stop time) / 8",
  );
  check(
    safe.includes("loaded 16.75, not loaded 15.25") &&
      safe.includes("(every-second)"),
    "the safe timing summary gives half-bits and the START_AUTH verdict",
  );
}

// ---------------------------------------------------------------- the flash log

// Frame a payload as a log entry: header word, payload padded to words, trailer with the CRC (lf_ia_trace.c).
function entry(type, payload) {
  const words = 2 + Math.ceil(payload.length / 4);
  const b = new Uint8Array(words * 4);
  b.set([0xa1, type, words, 0], 0);
  b.set(payload, 4);
  const c = P.crc16(b, b.length - 4);
  b.set([c & 0xff, c >> 8, words, 0], b.length - 4);
  return b;
}
function le(n, ...vals) {
  const b = new Uint8Array(n.reduce((a, x) => a + x, 0));
  const v = new DataView(b.buffer);
  let o = 0;
  n.forEach((size, i) => {
    if (size === 1) v.setUint8(o, vals[i]);
    else if (size === 2) v.setUint16(o, vals[i], true);
    else v.setUint32(o, vals[i], true);
    o += size;
  });
  return b;
}
const cat = (...a) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) out.set(x, (o += x.length) - x.length);
  return out;
};
const packN = (str) => packBits(str).slice(0, Math.ceil(str.length / 8));
// A command entry: the 34 fixed bytes, then bits, sent bits, and gaps if given.
function logCmd({
  session,
  t,
  bits,
  answered,
  decode = 0,
  tx = "",
  gaps = null,
  maxGap = 60,
}) {
  const flags = 0x08 | (answered ? 0x20 : 0) | (gaps ? 0x10 : 0);
  const fixed = le(
    [2, 1, 1, 4, 2, 2, 2, 2, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2],
    session,
    flags,
    (answered ? 1 : 0) | (decode << 4),
    t,
    400,
    answered ? 600 : 0,
    answered ? 1568 : 0,
    answered ? 2 : 0,
    answered ? 9472 : 0,
    answered ? 9450 : 0xffff,
    gaps ? gaps.length : bits.length + 1,
    bits.length,
    tx.length,
    200,
    1500,
    0,
    maxGap,
    0,
  );
  const g = gaps
    ? cat(...gaps.map(([s0, w]) => le([2, 2], s0, w)))
    : new Uint8Array(0);
  return entry(3, cat(fixed, packN(bits), packN(tx), g));
}
const logHeader = (boot, session, tOn, slot, mode) =>
  entry(1, le([2, 2, 4, 1, 1, 2], boot, session, tOn, slot, mode, 0));
const logOff = (session, t, n) =>
  entry(
    2,
    le(
      [2, 1, 1, 4, 2, 2, 4, 1, 1, 2],
      session,
      0,
      0,
      t,
      1400,
      120,
      1250123,
      20,
      2,
      n,
    ),
  );

const SA = "11000";
const READ0 = "1100000111";
const UIDA = "11111" + "0".repeat(32);
const stream = cat(
  // Slot 1, mode 1: START_AUTH, password, read: accepted after the first START_AUTH.
  logHeader(3, 7, 1000, 1, 1),
  logCmd({
    session: 7,
    t: 6000,
    bits: SA,
    answered: true,
    tx: UIDA,
    gaps: [
      [0, 50],
      [240, 50],
      [480, 50],
      [640, 50],
      [800, 50],
      [960, 50],
    ],
  }),
  logCmd({ session: 7, t: 16000, bits: PWD, answered: true, tx: UIDA }),
  logCmd({ session: 7, t: 30000, bits: READ0, answered: true, tx: UIDA }),
  logOff(7, 50000, 3),
  // Slot 2, mode 5: the password answered for the second START_AUTH, which the CU left unanswered; then a reset gap.
  logHeader(3, 8, 60000, 2, 5),
  logCmd({ session: 8, t: 66000, bits: SA, answered: true, tx: UIDA }),
  logCmd({ session: 8, t: 76000, bits: SA, answered: false }),
  logCmd({ session: 8, t: 86000, bits: PWD, answered: true, tx: UIDA }),
  logCmd({ session: 8, t: 99000, bits: READ0, answered: true, tx: UIDA }),
  logCmd({
    session: 8,
    t: 120000,
    bits: "",
    answered: false,
    decode: 2,
    gaps: [[0, 292]],
    maxGap: 292,
  }),
  logOff(8, 140000, 5),
  // A damaged entry, then slot 2 again with no command.
  Uint8Array.of(0xa1, 3, 9, 0, 1, 2, 3, 4),
  logHeader(4, 9, 500, 2, 5),
  logOff(9, 900, 0),
);
const L = P.parseLogStream(stream);
check(
  L.bad === 1 && L.orphans === 0,
  `the damaged entry is skipped once (${L.bad})`,
);
const lss = P.sessions(L.recs);
check(lss.length === 3, `three presentations from the log (${lss.length})`);
check(lss[0].commands[1].bits === PWD, "a logged password decodes to its bits");
check(
  lss[0].commands[0].gaps.length === 6 && lss[0].commands[1].gaps.length === 0,
  "gaps come back only where the log kept them",
);
check(
  lss[0].commands[0].tTxUs - lss[0].commands[0].tDueUs === 2 &&
    lss[0].commands[0].tFieldSeenUs === 6000 + 9450,
  "answer times are rebuilt from the deltas",
);
check(
  lss[0].off.timing.fcMeasuredHz === 125012.3 &&
    lss[0].commands[0].timing.slot === 1,
  "the field-off's measurement and the header's slot reach every record",
);
const o1 = P.presentationOutcome(lss[0]);
const o2 = P.presentationOutcome(lss[1]);
const o3 = P.presentationOutcome(lss[2]);
check(
  o1.outcome === "accepted" && o1.afterStart.n === 1 && o1.acceptMs === 29,
  "slot 1 accepted after START_AUTH 1",
);
check(
  o2.afterStart.n === 2 && !o2.afterStart.answered && o2.resets === 1,
  "slot 2 accepted after START_AUTH 2, which went unanswered; one field reset",
);
check(
  o3.outcome === "no command",
  "a presentation with no command still shows",
);
check(
  o1.delayUs.length === 3 && o1.delayUs.every((d) => d === 1568),
  "each answered command gives the answer delay in use",
);
const bySlot = P.outcomeTable(
  lss,
  (s) => `slot ${(s.off ?? s.commands[0]).timing.slot}`,
);
check(
  bySlot.length === 2 &&
    bySlot[1].presentations === 2 &&
    bySlot[1].counts["no command"] === 1,
  "the per-slot table counts each presentation",
);
const timingBySlot = P.outcomeTable(
  lss,
  (s) => `slot ${(s.off ?? s.commands[0]).timing.slot}`,
);
check(
  timingBySlot[0].delayUs === 1568,
  "the per-slot table gives the median answer delay",
);
const lr = {
  firmware: "v2.3.0-74-gc514d78",
  emu: P.pagesWithUid("11223344"),
  counters: { sessions: 9, commands: 8, responses: 7, late: 0 },
  boot: 4,
  total: L.recs.length,
  keep: 0,
  recs: L.recs,
  log: {
    state: 2,
    saved: 1024,
    capacity: 196592,
    pending: 0,
    bad: L.bad,
    dropped: 0,
    filling: false,
  },
};
const lsafe = P.safeMarkdown(lr);
check(
  lsafe.includes("**Per slot**") &&
    lsafe.includes("**Per mode**") &&
    lsafe.includes("5 scale+every-second"),
  "the safe report has the per-slot and per-mode tables",
);
check(
  lsafe.includes("skipped for a bad checksum"),
  "the safe report says an entry was skipped",
);
check(
  lsafe.includes("**Timing per slot") &&
    lsafe.includes("**Timing per mode**") &&
    lsafe.includes("| slot 1 | 1 | 5.0 | 29.0 | 1.0 |") &&
    lsafe.includes("gap to gap 160 µs for a 0 and 240 µs for a 1") &&
    lsafe.includes("carrier 125.012 kHz"),
  "the safe report carries the timing tables and the reader's timing",
);
check(
  !lsafe.includes(PWD) && !lsafe.includes(READ0),
  "the safe report holds no logged command bits",
);
check(
  P.privateMarkdown(lr).includes(PWD),
  "the private details hold the logged password",
);

// Two firmware builds in one log: each presentation names its build, and the report splits the tables by build.
const fwEntry = (v) =>
  entry(5, new TextEncoder().encode(v + "\0".repeat(4 - (v.length % 4))));
const two = P.parseLogStream(
  cat(
    fwEntry("v2.3.0-74-gc514d78"),
    logHeader(1, 1, 1000, 3, 1),
    logOff(1, 2000, 0),
    fwEntry("v2.3.0-75-gabcdef0"),
    logHeader(1, 2, 1000, 3, 1),
    logOff(2, 2000, 0),
  ),
);
check(
  two.firmwares.length === 2 &&
    two.recs[0].firmware === "v2.3.0-74-gc514d78" &&
    two.recs[1].firmware === "v2.3.0-75-gabcdef0",
  "each presentation carries the firmware that made it",
);
const twoSafe = P.safeMarkdown({
  firmware: "v2.3.0-75-gabcdef0",
  counters: { sessions: 2, commands: 0, responses: 0, late: 0 },
  boot: 1,
  total: two.recs.length,
  keep: 0,
  recs: two.recs,
  log: {
    state: 2,
    saved: 100,
    capacity: 196592,
    pending: 0,
    bad: 0,
    dropped: 0,
    firmwares: two.firmwares,
  },
});
check(
  twoSafe.includes("spans 2 firmware builds") &&
    twoSafe.includes("| v2.3.0-74-gc514d78 slot 3 |"),
  "the safe report warns of two builds and splits the tables by build",
);

// The field gap test: does the tag start over after a field gap?
{
  const g = P.RESET_PROBE_GAPS_US;
  const req = P.reqResetProbe([0, 290, 20000], 2968, 2);
  check(
    req.length === 10 &&
      req[0] === 0x98 &&
      req[1] === 0x0b &&
      req[2] === 2 &&
      req[3] === 3 &&
      req[6] === 0x22 &&
      req[7] === 0x01 &&
      req[8] === 0x20 &&
      req[9] === 0x4e,
    "the field gap test request is the wait, rounds, count and gaps, little-endian",
  );
  const rows = P.parseResetProbe(
    Uint8Array.of(2, 0, 2, 1, 2, 2),
    [0, 290, 20000],
  );
  check(
    rows.length === 3 &&
      rows[1].gapUs === 290 &&
      rows[1].started === 2 &&
      rows[1].answered === 1,
    "the field gap test reply gives each gap's tries and answers",
  );
  check(
    P.parseResetProbe(Uint8Array.of(2, 0), [0, 290]) === null,
    "a short reply is refused",
  );
  const sum = P.addResetProbe(P.addResetProbe(null, rows), rows);
  check(
    sum[2].started === 4 && sum[2].answered === 4,
    "replies add up per gap",
  );
  const mk = (a) =>
    g.map((gapUs, i) => ({ gapUs, started: 8, answered: a[i] }));
  const resets = P.resetProbeVerdict(mk([0, 0, 0, 0, 8, 8, 8, 8]));
  check(
    resets.kind === "starts-over" &&
      resets.startsOverFromUs === 400 &&
      resets.carriesOnToUs === 290,
    "silent up to 290 µs and answering from 400 µs: starts over from 400, carries on to 290",
  );
  const keeps = P.resetProbeVerdict(mk([0, 0, 0, 0, 0, 0, 0, 8]));
  check(
    keeps.kind === "carries-on" && keeps.carriesOnToUs === 1000,
    "only the longest gap makes it start over: the tag carries on",
  );
  check(
    P.resetProbeVerdict(mk([8, 8, 8, 8, 8, 8, 8, 8])).kind === "every",
    "a tag that answers every START_AUTH can't tell",
  );
  check(
    P.resetProbeVerdict(mk([0, 0, 0, 0, 8, 8, 8, 2])).kind === "unknown",
    "too few answers after the longest gap asks for a steadier tag",
  );
  check(
    P.resetProbeVerdict(mk([3, 0, 0, 0, 8, 8, 8, 8])).kind === "unknown",
    "mixed answers with no gap ask for another run",
  );
  const mixed = P.resetProbeVerdict(mk([0, 0, 0, 0, 4, 8, 8, 8]));
  check(
    mixed.startsOverFromUs === 600 &&
      mixed.carriesOnToUs === 290 &&
      mixed.text.includes("mixed"),
    "a half-answered gap between carrying on and starting over is called mixed",
  );
  check(
    P.resetProbeVerdict(g.map((gapUs) => ({ gapUs, started: 0, answered: 0 })))
      .kind === "unknown",
    "no tag says so",
  );
}

// START_AUTH: every one, or every second one. sa(n, up) is a START_AUTH whose answer decoded n bits; up starts a
// power-up.
{
  const sa = (n, up = 0) => ({ cmd: "START_AUTH", nBits: n, powerUpUs: up });
  const pw = { cmd: "password", nBits: 37, powerUpUs: 0 };
  const every = P.startAuthPattern([sa(37, 2968), sa(37)]);
  check(
    every.again === 1 && every.skipped === 0,
    "two answers in a row count once as answered again",
  );
  check(
    P.startAuthVerdict(every).kind === "every",
    "two in a row means every START_AUTH",
  );
  const second = P.startAuthPattern([sa(37, 2968), sa(0), sa(37)]);
  check(
    second.skipped === 1 && second.again === 0,
    "an answer, a miss, an answer counts one skip",
  );
  const v1 = P.startAuthVerdict(second);
  check(
    v1.kind === "every-second" && v1.text.includes("to be sure"),
    "one skip looks like every second one, and asks for more reads",
  );
  check(
    !P.startAuthVerdict({ again: 0, skipped: 3, unclear: 0 }).text.includes(
      "to be sure",
    ),
    "three skips need no more reads",
  );
  check(
    P.startAuthVerdict({ again: 2, skipped: 1, unclear: 0 }).kind === "every",
    "any two in a row outweighs skips, which a lost answer explains",
  );
  const firstMissed = P.startAuthPattern([sa(0, 2968), sa(37), sa(37)]);
  check(
    firstMissed.again === 1 && firstMissed.skipped === 0,
    "a miss before the first answer after power-up doesn't count",
  );
  const read = P.startAuthPattern([sa(37, 2968), pw, sa(37, 2968), pw]);
  check(
    read.again + read.skipped + read.unclear === 0 &&
      P.startAuthVerdict(read).kind === "unknown",
    "a page read (one START_AUTH per power-up) tells nothing",
  );
  const reset = P.startAuthPattern([sa(37, 2968), sa(0, 2968)]);
  check(
    reset.skipped === 0,
    "a START_AUTH after a power-up isn't compared with the one before it",
  );
  const part = P.startAuthPattern([sa(37, 2968), sa(12)]);
  check(
    part.unclear === 1 && part.again + part.skipped === 0,
    "a partly decoded answer counts as unclear",
  );
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
