// node selftest.mjs: the log parser and the report against a synthetic log in the firmware's layout.
import * as P from "./probe.js";

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

check(P.LOG_SIZE === 5084, `log size ${P.LOG_SIZE} matches sizeof(fp_store_t) in the firmware map (0x13dc)`);
check(P.REC_SIZE === 326, `record size ${P.REC_SIZE} is 326`);

// ---------------------------------------------------------------- a synthetic log
const buf = new Uint8Array(P.LOG_SIZE);
const v = new DataView(buf.buffer);
v.setUint32(0, 0x31425046, true);
v.setUint8(4, 1);
v.setUint8(5, 1);
v.setUint8(6, P.MOD.HIGH);
v.setUint16(8, 326, true);
v.setUint16(10, 3, true); // wake
v.setUint16(12, 2, true); // two rounds
v.setUint16(14, 1, true); // one LF field
v.setUint16(16, 3, true); // three HF fields

function cap(o, { mode, rate, p50, p90, line = 0, snr = 0 }) {
  v.setUint8(o, mode);
  v.setUint8(o + 1, rate);
  v.setUint16(o + 2, 2048, true);
  v.setInt16(o + 8, p50, true);
  v.setInt16(o + 10, p90, true);
  v.setUint32(o + 16, Math.round(line * 1000), true);
  v.setInt16(o + 20, Math.round(snr * 10), true);
}
function rec(i, { carrier, dips }) {
  const o = 20 + i * 326;
  v.setUint16(o, 3, true);
  v.setUint16(o + 2, 1, true);
  v.setUint32(o + 4, 1000 * i + 200, true);
  v.setUint8(o + 8, i);
  v.setUint32(o + 10, Math.round(carrier * 1000), true);
  v.setInt16(o + 14, 312, true);
  v.setUint8(o + 16, 1);
  v.setUint8(o + 17, dips.length);
  v.setUint16(o + 18, dips.length, true);
  cap(o + 20, { mode: 0, rate: 20, p50: 16000, p90: 16200 });
  cap(o + 42, { mode: 1, rate: 100, p50: 8000, p90: 8100, line: 25000 + (carrier - 125000), snr: 30 });
  cap(o + 64, { mode: 2, rate: 20, p50: 8000, p90: 9000, line: 4983.5, snr: 31.2 });
  dips.forEach((d, k) => {
    const p = o + 86 + 6 * k;
    v.setUint16(p, d[0], true);
    v.setUint16(p + 2, d[1], true);
    v.setUint16(p + 4, d[2], true);
  });
}
// Round 0: a Hitag 2 start, 11000, with the timing measured from a Proxmark's `lf cmdread`: 6 gaps of 75 µs, 230 µs
// for a 1 and 180 µs for a 0 (samples at 100 kHz = 10 µs). Round 1: nothing.
const t = [0, 230, 460, 640, 820, 1000].map((us) => 1000 + us / 10);
rec(0, { carrier: 124983.5, dips: t.map((s) => [s, 8, 4000]) });
rec(1, { carrier: 124983.5, dips: [] });
// LF field
const fo = 20 + 12 * 326;
v.setUint16(fo, 3, true);
v.setUint32(fo + 2, 150, true);
v.setUint32(fo + 6, 5200, true);
// HF fields: three short bursts with REQA polls
const hb = fo + 32 * 10;
for (let i = 0; i < 3; i++) {
  const o = hb + i * 26;
  v.setUint16(o, 3, true);
  v.setUint32(o + 2, 10000 + 250 * i, true);
  v.setUint32(o + 6, 5, true);
  v.setUint16(o + 10, 2, true);
  v.setUint16(o + 12, 2, true);
}

const log = P.parseLog(buf);
check(!log.error, `parses (${log.error ?? "no error"})`);
check(log.rounds.length === 2 && log.hfFields.length === 3 && log.lfFields.length === 1, "ring counts");
const d0 = P.describeRound(log.rounds[0]);
check(Math.abs(d0.carrier.ppm - -132) < 1, `carrier ppm ${d0.carrier.ppm.toFixed(1)} ≈ -132`);
const b = d0.dips.bursts[0];
check(b && b.gaps === 6, `one burst of six gaps (${b?.gaps})`);
check(b?.bits === "11000", `bits ${b?.bits} = 11000`);
check(b?.family === "Hitag (1, 2, S)", `family ${b?.family}`);
check(b?.command === "Hitag 2 / S start (START_AUTH)", `command ${b?.command}`);
const lf = P.lfVerdict(log.rounds);
check(/talks first/.test(lf.talk), "LF verdict: reader talks first");
const hf = P.hfVerdict(log.hfFields);
check(/14443-A/.test(hf.text) && /low-power/.test(hf.text), "HF verdict: 14443-A polling in short bursts");
const r = { firmware: "test", log };
const safe = P.safeMarkdown(r);
check(!/11000/.test(safe), "the safe report leaves the bits out");
check(/11000/.test(P.privateMarkdown(r)), "the private details hold the bits");
check(P.parseLog(new Uint8Array(P.LOG_SIZE)).error != null, "an empty log is an error, not a report");
console.log("\n" + safe + "\n\n" + P.privateMarkdown(r));
process.exit(failed ? 1 : 0);
