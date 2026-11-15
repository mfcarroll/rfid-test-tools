// node selftest.mjs: the trace parser, the session grouping and verdicts, and the privacy split of the report,
// against a synthetic trace in the firmware's layout (lf_ia_trace_rec_t).
import * as P from "./interactive.js";

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

check(P.REC_SIZE === 276, `record size ${P.REC_SIZE} matches sizeof(lf_ia_trace_rec_t)`);

// Pack bits first-sent-first into a 16-byte field, as the firmware does.
function packBits(str) {
  const b = new Uint8Array(16);
  for (let i = 0; i < str.length; i++) if (str[i] === "1") b[i >> 3] |= 1 << (7 - (i & 7));
  return b;
}

// Build one 276-byte record.
function rec({ type = P.TR.COMMAND, verdict = 1, decode = 0, flags = 0, tUs = 0, nBits = 0, bits = "", txBits = "", tReady = 0, tDue = 0, tTx = 0, boot = 1, session = 1, tSession = 0, nGaps = 0 }) {
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
function reply(recs, { total = recs.length, keep = P.TRACE_KEEP, boot = 1 } = {}) {
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
  rec({ nBits: 5, bits: "11000", txBits: "1111100000000100000001000000011000001", tUs: 4000, tReady: 694, tDue: 1920, tTx: 1921, boot: 2, session: 1, tSession: 100 }),
  rec({ nBits: 32, bits: PWD, txBits: "1111100000011000000111000001111000100", tUs: 33000, tReady: 598, tDue: 1920, tTx: 1921, boot: 2, session: 1, tSession: 100 }),
  rec({ nBits: 10, bits: "1100000111", txBits: "1".repeat(37), tUs: 58000, tReady: 575, tDue: 1920, tTx: 1921, boot: 2, session: 1, tSession: 100 }),
  rec({ type: P.TR.FIELD_OFF, verdict: 0, tUs: 70000, boot: 2, session: 1, tSession: 100 }),
  // boot 3: crypto reader (START_AUTH answered, then a 64-bit command the module ignores)
  rec({ nBits: 5, bits: "11000", txBits: "1".repeat(37), tUs: 4000, tReady: 600, tDue: 1920, tTx: 1921, boot: 3, session: 2, tSession: 100 }),
  rec({ nBits: 64, bits: "0".repeat(64), verdict: 0, tUs: 33000, boot: 3, session: 2, tSession: 100 }),
  rec({ type: P.TR.FIELD_OFF, verdict: 0, tUs: 50000, boot: 3, session: 2, tSession: 100 }),
  // boot 4: START_AUTH, answered, but nothing follows
  rec({ nBits: 5, bits: "11000", txBits: "1".repeat(37), tUs: 4000, tReady: 600, tDue: 1920, tTx: 1921, boot: 4, session: 3, tSession: 100 }),
  rec({ type: P.TR.FIELD_OFF, verdict: 0, tUs: 40000, boot: 4, session: 3, tSession: 100 }),
];

const parsed = P.parseTraceReply(reply(recs, { total: 9, boot: 5 }));
check(parsed.n === 9 && parsed.recs.length === 9, `parsed ${parsed.n} records`);
check(parsed.boot === 5, `current boot ${parsed.boot}`);
check(parsed.recs[1].bits === PWD, "the 32-bit command decodes to the sent password bits");
check(parsed.recs[1].tReadyUs - parsed.recs[1].tUs === 598, "ready time is relative-able");

const ss = P.sessions(parsed.recs);
check(ss.length === 3, `three field sessions (${ss.length})`);
check(ss[0].commands.length === 3 && ss[0].off, "session 1 has three commands and a field-off");

const v1 = P.sessionVerdict(ss[0]);
check(v1.passwordAnswered && v1.reads === 1, "session 1: password authenticated, one page read");
const v2 = P.sessionVerdict(ss[1]);
check(v2.sawCrypto, "session 2: crypto mode seen");
const v3 = P.sessionVerdict(ss[2]);
check(v3.startAnswered && !v3.sawPassword, "session 3: START_AUTH answered, no password");

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

check(!safe.includes(PWD), "the safe report does NOT contain the reader's password bits");
check(!safe.includes("1111100000011000"), "the safe report does NOT contain answer bits");
check(priv.includes(PWD), "the private details DO contain the reader's password bits");
check(safe.includes("UID 11223344"), "the safe report names the emulated UID");
check(safe.includes("crypto mode"), "the safe report flags the crypto-mode reader");
check(safe.includes("password mode") && safe.includes("served its pages"), "the safe report states the password-mode success");

// ---------------------------------------------------------------- config decode and UID helpers

check(P.describeConfig(P.PLACEHOLDER_PAGES).mode === "password", "placeholder config is password mode");
check(P.describeConfig(P.PLACEHOLDER_PAGES).coding === "Hitag 2", "placeholder config coding is Hitag 2");
check(P.parseUid("0x01020304") === "01020304" && P.parseUid("zz") === null, "UID parsing");
check(P.uidOf(P.pagesWithUid("DEADBEEF")) === "DEADBEEF", "UID round-trips into the pages");

// overwritten-stretch note
const many = P.safeMarkdown({ ...r, total: 40, recs: parsed.recs });
check(many.includes("overwritten"), "the safe report notes overwritten records when some rolled off");

// ---------------------------------------------------------------- the editable fields

check(P.parseHex("0A0B0C0D", 4) !== null && P.parseHex("0a0b", 4) === null, "parseHex enforces the byte count");
check(P.parseHex("06", 1)[0] === 0x06 && P.parseHex("zz", 1) === null, "parseHex reads one byte, rejects junk");

const fields = { p0: "AABBCCDD", p1: "11223344", p2: "22222222", config: "06", tagpw: "556677", p4: "04040404", p5: "05050505", p6: "06060606", p7: "07070707" };
const built = P.pagesFromFields(fields);
check(built.length === 32, "pagesFromFields returns 32 bytes");
check(P.uidOf(built) === "AABBCCDD", "pagesFromFields writes page 0 (UID)");
check(built[4] === 0x11 && built[7] === 0x44, "pagesFromFields writes page 1 (reader password)");
check(built[8] === 0x22 && built[11] === 0x22, "pagesFromFields writes page 2");
check(built[12] === 0x06, "pagesFromFields writes the config byte");
check(built[13] === 0x55 && built[15] === 0x77, "pagesFromFields writes the tag password after the config byte");
check(built[28] === 0x07 && built[31] === 0x07, "pagesFromFields writes page 7");
check(P.pagesFromFields({ ...fields, p0: "xyz" }) === null, "pagesFromFields rejects an invalid field");

const round = P.fieldsFromPages(built);
check(
  round.p0 === "AABBCCDD" && round.p1 === "11223344" && round.p2 === "22222222" && round.config === "06" && round.tagpw === "556677" && round.p7 === "07070707",
  "fieldsFromPages round-trips every page",
);

check(P.HITAG2_PAGE_NAMES.length === 8, "a name for each of the eight pages");
check(P.HITAG2_PAGE_NAMES[1] === "Reader password" && P.HITAG2_PAGE_NAMES[2].includes("crypto"), "page names read in order");

// ---------------------------------------------------------------- reading a physical tag

// A HITAG2_SCAN reply: four UID bytes.
check(P.parseHitag2Scan(Uint8Array.of(0xde, 0xad, 0xbe, 0xef)) === "DEADBEEF", "parseHitag2Scan reads the UID");
check(P.parseHitag2Scan(Uint8Array.of(1, 2)) === null, "parseHitag2Scan rejects a short reply");

// A HITAG2_READ reply: 32 page bytes, then a 1-byte mask. Here pages 0,1,3 read (mask 0b00001011), the rest not.
const readData = new Uint8Array(33);
for (let i = 0; i < 32; i++) readData[i] = i + 1;
readData[32] = 0b00001011;
const read = P.parseHitag2Read(readData);
check(read.count === 3 && read.mask === 0x0b, "parseHitag2Read counts the pages read");
check(read.pages[0] !== null && read.pages[2] === null && read.pages[3] !== null, "parseHitag2Read marks unread pages null");
check(P.parseHitag2Read(new Uint8Array(10)) === null, "parseHitag2Read rejects a short reply");

const folded = P.pagesFromRead(read);
check(folded[0] === 1 && folded[13] === 14, "pagesFromRead keeps the read pages");
check(folded[8] === P.PLACEHOLDER_PAGES[8], "pagesFromRead fills an unread page from the base");

// A real tag read into the fields must not leak into the safe report: its password lives on page 1, private only.
const realPw = "A1B2C3D4";
const realPages = P.pagesFromFields({ p0: "01020304", p1: realPw, p2: "22222222", config: "06", tagpw: "0E0F10", p4: "04040404", p5: "05050505", p6: "06060606", p7: "07070707" });
const realReport = { ...r, emu: realPages };
check(!P.safeMarkdown(realReport).includes(realPw), "a read-in tag's password does NOT reach the safe report");
check(P.privateMarkdown(realReport).toLowerCase().includes(realPw.toLowerCase()), "a read-in tag's pages ARE in the private details");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
