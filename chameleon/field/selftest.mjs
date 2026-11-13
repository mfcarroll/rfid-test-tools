// node selftest.mjs: the log parser and the report against a synthetic log in the firmware's layout.
import * as P from "./probe.js";

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

check(P.LOG_SIZE === 8884, `log size ${P.LOG_SIZE} matches sizeof(fp_store_t) in log version 5`);
check(P.REC_SIZE === 636, `record size ${P.REC_SIZE} is 636`);
check(P.logSize(4) === 6496 && P.recSizeOf(4) === 437, "a version 4 log is 6496 bytes with 437-byte records (firmware a5c8e8c5)");
{
  // A version 3 log (firmware 132414dc, before the auth summary): the page still reads it.
  const h3 = new Uint8Array(P.HEADER);
  const v3 = new DataView(h3.buffer);
  v3.setUint32(0, 0x31425046, true);
  v3.setUint8(4, 3);
  v3.setUint16(8, 432, true);
  const p3 = P.parseHeader(h3);
  check(!p3.error && p3.logSize === 6436, `a version 3 header reads, log ${p3.logSize ?? p3.error}`);
}
const REC = P.REC_SIZE;

// ---------------------------------------------------------------- a synthetic log
const buf = new Uint8Array(P.LOG_SIZE);
const v = new DataView(buf.buffer);
v.setUint32(0, 0x31425046, true);
v.setUint8(4, 5);
v.setUint8(5, 1);
v.setUint8(6, P.MOD.HIGH);
v.setUint16(8, REC, true);
v.setUint16(10, 3, true); // wake
v.setUint16(12, 5, true); // five rounds
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
function rec(i, { carrier, dips, how = 1, flags = 0, carrierN = 0, timing = null, auth = null, level = null }) {
  const o = P.HEADER + i * REC;
  v.setUint16(o, 3, true);
  v.setUint16(o + 2, 1, true);
  v.setUint32(o + 4, 1000 * i + 200, true);
  v.setUint8(o + 8, i);
  v.setUint32(o + 10, Math.round(carrier * 1000), true);
  v.setInt16(o + 14, 312, true);
  v.setUint8(o + 9, flags);
  v.setUint8(o + 16, how);
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
  const t = o + 20 + 66 + 240;
  v.setUint16(t, carrierN, true);
  if (timing) {
    v.setInt16(t + 2, timing.low ?? 20, true);
    v.setInt16(t + 4, timing.high ?? 9000, true);
    v.setUint8(t + 6, timing.firstOn ? 1 : 0);
    v.setUint8(t + 7, timing.runs.length);
    v.setUint16(t + 8, timing.runs.length, true);
    timing.runs.forEach((ms, k) => v.setUint16(t + 10 + 2 * k, ms, true));
  }
  // Log version 5: the full level, the off level and the level dips, after the auth summary.
  const lo = o + REC - 7 - 32 * 6;
  v.setInt16(lo, level?.full ?? timing?.high ?? 0, true);
  v.setInt16(lo + 2, 200, true);
  if (level) {
    v.setUint8(lo + 4, level.dips.length);
    v.setUint16(lo + 5, level.dips.length, true);
    level.dips.forEach((d, k) => {
      v.setUint16(lo + 7 + 6 * k, d[0], true);
      v.setUint16(lo + 9 + 6 * k, d[1], true);
      v.setUint16(lo + 11 + 6 * k, d[2], true);
    });
  }
  if (auth) {
    const ao = lo - 5; // the auth-mode summary comes before the level fields
    v.setUint8(ao, auth.mode);
    v.setUint8(ao + 1, auth.startGaps ?? 0);
    v.setUint8(ao + 2, auth.gaps ?? 0);
    v.setUint16(ao + 3, auth.span ?? 0, true);
  }
}
// Round 0: a Hitag 2 start, 11000, with the timing measured from a Proxmark's `lf cmdread`: 6 gaps of 75 µs, 230 µs
// for a 1 and 180 µs for a 0 (samples at 100 kHz = 10 µs). Round 1: nothing.
const t = [0, 230, 460, 640, 820, 1000].map((us) => 1000 + us / 10);
// The carrier every round reports: the PM3 as CU2 measured it on the 2026-11-06 bench, -132 ppm. A CU reads the
// carrier against its own crystal, so another CU sees the same reader differently (CU1 reads this PM3 at -140 ppm).
const CARRIER_HZ = 124983.5;
const CARRIER_PPM = -132;
rec(0, { carrier: CARRIER_HZ, dips: t.map((s) => [s, 8, 4000]) });
// Round 1: a pulsing field like HS's door readers: the carrier from a 40 ms on-stretch, on ~60 ms every ~200 ms.
rec(1, {
  carrier: CARRIER_HZ,
  dips: [],
  how: 4,
  flags: 0x10,
  carrierN: 4000,
  timing: { firstOn: false, runs: [90, 60, 140, 61, 139, 59, 141, 60, 30] },
});
// Round 2: a password-mode Hitag 2 install. START_AUTH (6 gaps), then after the UID reply the reader's PWD command
// is 32 bits: the firmware measured 33 gaps over 650 envelope samples (6.5 ms). This is the 5 → 32 → 32 pattern.
rec(2, { carrier: CARRIER_HZ, dips: t.map((s) => [s, 8, 4000]), auth: { mode: 1, startGaps: 6, gaps: 33, span: 650 } });
// Round 3: a crypto-mode install. The reader's AUTH command is 64 bits: 65 gaps over 1290 samples (12.9 ms), which
// overflows the 40 stored dips, so the firmware's summary carries it. This is the 5 → 32 → 64 pattern.
rec(3, { carrier: CARRIER_HZ, dips: t.map((s) => [s, 8, 4000]), auth: { mode: 2, startGaps: 6, gaps: 65, span: 1290 } });
// Round 4: a reader whose field stays on and dips, like a door reader at 1200 counts dipping to 840 every 76 ms. The
// level capture never reaches the off level, so the runs are one on stretch. The dips are 7 ms, 360 counts deep.
rec(4, {
  carrier: CARRIER_HZ,
  dips: [],
  timing: { firstOn: true, low: 840, high: 1210, runs: [1792] },
  level: { full: 1200, dips: Array.from({ length: 23 }, (_, k) => [49 + 76 * k, 7, 360]) },
});
// LF field
const fo = P.HEADER + 12 * REC;
v.setUint16(fo, 3, true);
v.setUint32(fo + 2, 150, true);
v.setUint32(fo + 6, 5200, true);
v.setUint16(fo + 10, 4, true); // drops
// HF fields: three short bursts with REQA polls
const hb = fo + 32 * 12;
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
check(log.rounds.length === 5 && log.hfFields.length === 3 && log.lfFields.length === 1, "ring counts");
const d0 = P.describeRound(log.rounds[0]);
check(Math.abs(d0.carrier.ppm - CARRIER_PPM) < 1, `carrier ppm ${d0.carrier.ppm.toFixed(1)} ≈ ${CARRIER_PPM}`);
const b = d0.dips.bursts[0];
check(b && b.gaps === 6, `one burst of six gaps (${b?.gaps})`);
check(b?.bits === "11000", `bits ${b?.bits} = 11000`);
check(b?.family === "Hitag (1, 2, S)", `family ${b?.family}`);
check(b?.command === "Hitag 2 / S start (START_AUTH)", `command ${b?.command}`);
const lf = P.lfVerdict(log.rounds);
check(/talks first/.test(lf.talk), "LF verdict: reader talks first");
const d1 = P.describeRound(log.rounds[1]);
check(d1.carrier?.sure && d1.carrier.gatedMs === 40, `a gated carrier is sure, from 40 ms (${d1.carrier?.gatedMs})`);
check(lf.pulse?.onMs === 60 && lf.pulse?.offMs === 140 && lf.pulse?.count === 4, `pulse on ${lf.pulse?.onMs} off ${lf.pulse?.offMs} ×${lf.pulse?.count}`);
// Hitag 2 authentication mode (log v4): the firmware classifies the reader's command after the UID reply.
const a2 = P.authOf(log.rounds[2]);
check(a2?.mode === "password" && a2?.gaps === 33 && a2?.bits === 32, `round 2 password, 33 gaps, 32-bit (${a2?.mode}/${a2?.gaps})`);
const a3 = P.authOf(log.rounds[3]);
check(a3?.mode === "crypto" && a3?.gaps === 65 && a3?.bits === 64, `round 3 crypto, 65 gaps, 64-bit (${a3?.mode}/${a3?.gaps})`);
const av = P.authVerdict(log.rounds);
check(av.counts?.password === 1 && av.counts?.crypto === 1, `authVerdict counts password ${av.counts?.password} crypto ${av.counts?.crypto}`);
check(log.lfFields[0].drops === 4, "the field's drops parse");
// A round taken after the field has gone: the firmware's scan anchors START_AUTH in the noise envelope.
const quiet = { ...log.rounds[0], authMode: 0, authStartGaps: 6, caps: log.rounds[0].caps.map((c) => ({ ...c, p50: 64, p90: 80 })) };
check(P.authVerdict([quiet]).sawStart === false, "a round with no field doesn't count as a START_AUTH");
check(P.authOf({ ...log.rounds[2], caps: quiet.caps }) === null, "a round with no field gives no auth verdict");
const short = { ...log.rounds[0], timing: { low: 40, high: 16290, total: 2, runs: [{ on: true, ms: 258 }, { on: false, ms: 1534 }] } };
check(P.lfVerdict([short]).steady === 0, "a field that ends during the capture isn't steady");
check(P.describeTiming({ total: 2, runs: [{ on: true, ms: 1057 }, { on: false, ms: 735 }] }).edge, "a field that ends during the capture is an edge, not a pulse");
// Dips and offs (log version 5): round 1 goes off, round 4 only dips.
const l1 = P.levelOf(log.rounds[1]);
check(!l1.estimate && !l1.timing.steady && l1.dipsTotal === 0, "a field that goes off is off, with no dips");
const l4 = P.levelOf(log.rounds[4]);
check(!l4.estimate && l4.timing.steady && l4.dipsTotal === 23, `a field that dips is never off, 23 dips (${l4.dipsTotal})`);
check(lf.dips?.pct === 70 && lf.dips?.ms === 7 && lf.dips?.everyMs === 76, `dips to ${lf.dips?.pct} % for ${lf.dips?.ms} ms every ${lf.dips?.everyMs} ms`);
check(P.lfVerdict([log.rounds[4]]).talk.includes("stays on"), "a field that only dips stays on in the verdict");
// Short offs: a PM3 off for 4 ms every 76 ms read on a bench CU as drops 4 ms wide to 42 % of a 2660 level. An off
// that short falls about that far, so it is not called a dip.
const shortOff = {
  ...log.rounds[4],
  timingFull: 2660,
  levelDipsTotal: 23,
  levelDips: Array.from({ length: 23 }, (_, k) => ({ start: 61 + 76 * k, ms: 4, depth: 1540, open: false })),
};
const so = P.lfVerdict([shortOff]);
check(so.shortOffs?.count === 23 && !so.dips && /switches off/.test(so.talk), `4 ms drops to 42 % are short offs (${so.shortOffs?.count})`);
check(/Short offs for about 4 ms every 76 ms/.test(P.safeMarkdown({ firmware: "t", log: { ...log, rounds: [shortOff] } })), "the report names them short offs");

// A version 4 log (firmware a5c8e8c5) from a door reader that dips: its runs split at 35 % of the swing say off, but
// the lowest 1 ms mean, 848, never got near the no-field level. The page re-reads it as dips, an estimate.
const doorRuns = [64, ...Array.from({ length: 22 }, () => [4, 72]).flat(), 4, 57];
const v4 = new Uint8Array(P.logSize(4));
const w = new DataView(v4.buffer);
w.setUint32(0, 0x31425046, true);
w.setUint8(4, 4);
w.setUint8(6, P.MOD.HIGH);
w.setUint16(8, 437, true);
w.setUint16(12, 1, true);
{
  const o = P.HEADER;
  w.setUint16(o, 5, true);
  w.setUint16(o + 2, 1, true);
  w.setUint8(o + 9, 0x10);
  w.setUint8(o + 20 + 1, 20);
  w.setInt16(o + 20 + 10, 1216, true); // level p90: a field
  w.setUint8(o + 42, P.MOD.HIGH);
  w.setUint8(o + 42 + 1, 100);
  w.setInt16(o + 42 + 10, 357, true); // the loaded envelope's p90
  // Its envelope gaps: the reader's dips, 10.28 ms each, 76 ms apart, down to the no-field level with the load on.
  w.setUint8(o + 17, 2);
  w.setUint16(o + 18, 2, true);
  [[525, 1028, 281], [8104, 1027, 281]].forEach(([a, wd, dp], k) => {
    w.setUint16(o + 86 + 6 * k, a, true);
    w.setUint16(o + 88 + 6 * k, wd, true);
    w.setUint16(o + 90 + 6 * k, dp, true);
  });
  const t = o + 20 + 66 + 240;
  w.setInt16(t + 2, 848, true);
  w.setInt16(t + 4, 1208, true);
  w.setUint8(t + 6, 1);
  w.setUint8(t + 7, doorRuns.length);
  w.setUint16(t + 8, doorRuns.length, true);
  doorRuns.forEach((ms, k) => w.setUint16(t + 10 + 2 * k, ms, true));
}
const old = P.parseLog(v4);
check(!old.error && old.rounds.length === 1, `a version 4 log parses (${old.error ?? "ok"})`);
const lo4 = P.levelOf(old.rounds[0]);
check(lo4.estimate && lo4.timing.steady && lo4.dipsTotal === 23, `version 4 dips re-read: never off, ${lo4.dipsTotal} dips, estimate`);
const lf4 = P.lfVerdict(old.rounds);
check(!lf4.pulse && lf4.dips?.estimate && lf4.dips.deepestPct === 70 && lf4.dips.everyMs === 76 && Math.abs(lf4.dips.gapMs - 10.3) < 0.05,
  `version 4 verdict: no pulse, dips every ${lf4.dips?.everyMs} ms to ${lf4.dips?.deepestPct} %, ${lf4.dips?.gapMs} ms in the envelope`);
// The same runs with 4 ms envelope gaps and a level down to 60 %: as deep as a 4 ms off, so they stay offs.
const pm3gaps = { ...old.rounds[0], timing: { ...old.rounds[0].timing, low: 725 }, dips: [{ start: 525, width: 407, depth: 300, open: false }] };
const lg = P.levelOf(pm3gaps);
check(lg.shortOffRuns && !lg.timing.steady, "version 4 drops as deep as offs of their envelope length stay offs");
const safe4 = P.safeMarkdown({ firmware: "v4 test", log: old });
check(/Field dips \(estimate\) every 76 ms.*the deepest to 70 % of full.*about 10.3 ms in the loaded envelope/.test(safe4), "the version 4 report gives the dips as an estimate, with the envelope's length");
check(!/pulses its field|Field timing: on about/.test(safe4), "the version 4 report no longer calls the dips a pulsing field");
// A version 4 log whose lowest mean did reach the off level keeps its on and off runs, as an estimate.
const pm3v4 = { ...old.rounds[0], timing: { low: 90, high: 1200, total: 5, runs: [30, 62, 88, 62, 88].map((ms, i) => ({ on: i % 2 === 1, ms })) } };
const lp = P.levelOf(pm3v4);
check(lp.estimate && lp.reachedOff && !lp.timing.steady && lp.timing.offMs === 88, "a version 4 field that went off stays off");

// The envelope shows commands only with the load on and above the no-field level. With the tone, or a weak field
// whose loaded envelope sits at 75 counts, noise read as commands on the bench.
const r0 = log.rounds[0];
const toned = { ...r0, caps: r0.caps.map((c, i) => (i === 1 ? { ...c, mode: P.MOD.TONE } : c)) };
check(!P.envelopeReadable(toned) && P.analyseDips(toned).bursts.length === 0, "a tone-mode envelope isn't read for commands");
const weak = { ...r0, caps: r0.caps.map((c, i) => (i === 1 ? { ...c, p90: 75 } : c)) };
check(!P.envelopeReadable(weak) && /couldn't look for a reader's command gaps/.test(P.lfVerdict([weak]).talk), "an envelope at the no-field level isn't read, and the verdict says so");
check(/Hitag/.test(P.lfVerdict([r0]).talk), "a loaded envelope above the no-field level still reads the Hitag start");
// Older firmware placed the carrier from the envelope's line in any mode: the tone's line read as 115.6 kHz.
const toneCarrier = { ...toned, carrierHz: 115625, carrierHow: 2 };
check(P.describeRound(toneCarrier).carrier === null, "an envelope-line carrier from a tone-mode capture is dropped");
check(P.describeRound(r0).carrier != null, "a two-rate carrier still stands");
check(P.lfVerdict([toneCarrier]).carrierDropped === true, "the verdict says why that carrier is missing");
check(P.authOf({ ...log.rounds[3], caps: toned.caps }) === null, "no Hitag auth verdict from a tone-mode envelope");

const hf = P.hfVerdict(log.hfFields);
check(/14443-A/.test(hf.text) && /low-power/.test(hf.text), "HF verdict: 14443-A polling in short bursts");
const r = { firmware: "test", log };
const safe = P.safeMarkdown(r);
check(/Field timing: on about 60 ms \(59–61\), off about 140 ms \(139–141\), from 4 whole pulse/.test(safe), "the safe report gives the field's timing");
check(/Drops below the CU's fixed comparator level while the field lasted: 4\./.test(safe), "the safe report gives the drops");
check(!/11000/.test(safe), "the safe report leaves the bits out");
check(/11000/.test(P.privateMarkdown(r)), "the private details hold the bits");
check(/authentication mode: \*\*password\*\* — after the fob's UID the reader's command is about 32 bits/.test(safe), "the safe report names the Hitag auth mode and frame length");
check(!/33 gaps|65 gaps/.test(safe), "the safe report leaves the raw gap count out");
check(/65 gaps over 1290 envelope samples.*after a START_AUTH of 6 gaps/.test(P.privateMarkdown(r)), "the private details hold the raw gap count");
check(P.parseLog(new Uint8Array(P.LOG_SIZE)).error != null, "an unreadable log is an error, not a report");
check(!/reset/.test(safe), "no crash line without a crash");
// A crash by a firmware error, and a dropped reply
v.setUint8(7, 1);
v.setUint16(18, 3, true);
v.setUint32(20, 3, true);
v.setUint32(24, 2531, true);
v.setUint16(28, 2, true);
v.setUint16(32, 1, true);
v.setUint16(34, 17, true);
const h = P.parseHeader(buf.subarray(0, P.HEADER));
check(!h.error && h.crash.count === 1 && h.crash.kind === "a firmware error" && h.usb.dropped === 1, "header alone parses the crash and USB record");
check(/1 reset\(s\) by a crash, the last by a firmware error in wake 2/.test(P.headerLine(h)), `header line: ${P.headerLine(h)}`);
const safe2 = P.safeMarkdown({ firmware: "test", log: P.parseLog(buf) });
check(/reset 1 time\(s\).*firmware error \(error 0x3, at 0x9e3\), in wake 2/.test(safe2), "the safe report names the crash");
check(/dropped 1 USB/.test(safe2), "the safe report names the dropped reply");
console.log("\n" + safe + "\n\n" + P.privateMarkdown(r));
process.exit(failed ? 1 : 0);
