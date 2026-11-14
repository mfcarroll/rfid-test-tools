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

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
