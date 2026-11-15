// The card search page (index.html): connecting the CU, running the reads and chip checks, and the report.

import { SerialCU, STATUS_SUCCESS } from "../common/cu.js";
import { bindFlashButtons } from "../common/flash-ui.js";
import {
  $,
  log,
  hasWebSerial,
  bindCopyButtons,
  saveJson,
  showSiteCommit,
} from "../../common/page.js";
import * as X from "./identify.js";
import { analyse, t55xxAnswer, traceBlock } from "./lfdemod.js";
import {
  em4x05Answer,
  hitag2Answer,
  frameChecks,
  shapeFits,
  t55ConfigFromProbe,
} from "./framecheck.js";

const IDENTIFY = {
  zip: "firmware/lf-search-aa05875a-ultra-dfu-app.zip",
  name: "experimental aa05875",
};
const STOCK = {
  zip: "../common/firmware/stock-v2.3.0-ultra-dfu-app.zip",
  name: "stock v2.3.0",
};
$("fwname").textContent = IDENTIFY.name.replace("experimental ", "");

let cu = null,
  busy = false,
  long = false; // the firmware has long captures and the chip check
let report = null,
  baseline = null,
  captures = {};

function setState(state) {
  $("app").dataset.state = state;
  $("step-connect").className = state === "connect" ? "current" : "done";
  $("step-test").className = state === "ready" ? "current" : "";
}
const CONTROLS = [
  "baseline",
  "identify",
  "reconnect",
  "flashTest",
  "flashStock",
  "flashFile",
];
function setRunning(on) {
  $("runbox").hidden = !on;
  for (const id of CONTROLS) $(id).disabled = on;
}
function progress(phase, part) {
  $("phase").textContent = phase;
  $("progress").style.width = `${Math.round(100 * part)}%`;
}
async function run(what, fn) {
  if (busy) return;
  busy = true;
  setRunning(true);
  try {
    await fn();
  } catch (e) {
    log(`${what} failed: ${e.message}`);
  } finally {
    busy = false;
    setRunning(false);
  }
}

// Reader mode for the duration of fn, then the mode the CU was in.
async function asReader(fn) {
  const m = await cu.cmd(X.CMD.GET_DEVICE_MODE);
  const was = m.status === STATUS_SUCCESS && m.data[0] === 1;
  await cu.cmd(X.CMD.CHANGE_DEVICE_MODE, X.reqMode(true));
  try {
    return await fn();
  } finally {
    await cu.cmd(X.CMD.CHANGE_DEVICE_MODE, X.reqMode(was));
  }
}

// One long capture: chunk 0 captures, later chunks fetch slices of it, chunk 0xff describes it.
async function fetchCapture(first) {
  if (first.status !== X.STATUS.LF_TAG_OK || !first.data.length)
    return null;
  const parts = [first.data];
  for (let c = 1; c < 0xff; c++) {
    const r = await cu.cmd(X.CMD.LF_SNIFF, X.reqSniff(c));
    if (r.status !== X.STATUS.LF_TAG_OK || !r.data.length) break;
    parts.push(r.data);
  }
  const info = X.parseSniffInfo(
    (await cu.cmd(X.CMD.LF_SNIFF, X.reqSniff(X.SNIFF_INFO_CHUNK))).data,
  );
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) bytes.set(p, (o += p.length) - p.length);
  return { bytes, info };
}
const sniff = async () =>
  fetchCapture(await cu.cmd(X.CMD.LF_SNIFF, X.reqSniff(0), 5));
const probe = async (p) =>
  fetchCapture(await cu.cmd(X.CMD.LF_CHIP_PROBE, X.reqProbe(p), 5));

// ---------------------------------------------------------------- connect and firmware

async function checkFirmware() {
  const fw = await cu.version();
  // The chip check with no probe in it: the experimental firmware rejects it as a bad request, other firmware doesn't
  // know the command.
  const r = await cu.cmd(X.CMD.LF_CHIP_PROBE, new Uint8Array(0));
  long = r.status !== X.STATUS.INVALID_CMD;
  $("fwinfo").textContent =
    `CU on ${fw}: ` +
    (long ? "has long captures and the chip check" : "no long captures");
  $("fwneed").hidden = long;
  log(`connected: ${fw}, long captures ${long ? "yes" : "no"}`);
  return fw;
}
let firmware = "";
const connectCU = () =>
  run("connect", async () => {
    if (!hasWebSerial()) return;
    try {
      const port = await navigator.serial.requestPort();
      await cu?.close();
      cu = new SerialCU();
      await cu.open(port);
    } catch (e) {
      $("connectinfo").textContent = `Couldn't connect: ${e.message}`;
      cu = null;
      throw e;
    }
    firmware = await checkFirmware();
    setState("ready");
  });
$("connect").onclick = connectCU;
$("reconnect").onclick = connectCU;

bindFlashButtons({
  firmware: { test: IDENTIFY, stock: STOCK },
  port: () => cu?.port ?? null,
  release: async () => {
    await cu?.close();
    cu = null;
  },
  busy: () => (busy ? "wait for the current step to finish" : null),
  done: () => setState("connect"),
});

// ---------------------------------------------------------------- the steps

$("baseline").onclick = () =>
  run("empty field", async () => {
    if (!long)
      return log(
        "measuring the empty field needs the experimental firmware",
      );
    progress("Measuring the empty field", 0.2);
    const c = await asReader(sniff);
    if (!c) throw new Error("the CU returned no samples");
    captures.empty = c;
    baseline = analyse(c.bytes);
    $("baselineinfo").textContent =
      baseline.modulation === "none"
        ? `level ${baseline.level}`
        : `level ${baseline.level}, but something is modulating the field: is a card still near?`;
    log(`empty field: level ${baseline.level}, ${baseline.modulation}`);
  });

$("identify").onclick = () =>
  run("search", async () => {
    captures = captures.empty ? { empty: captures.empty } : {};
    const r = {
      firmware,
      baseline: baseline && { level: baseline.level },
      lf: { named: [] },
      hf: null,
    };
    await asReader(async () => {
      const n = X.LF_SCANS.length;
      for (const [i, s] of X.LF_SCANS.entries()) {
        progress(`Trying ${s.name}`, (0.6 * i) / n);
        for (let tries = 0; tries < 2; tries++) {
          const a = await cu.cmd(s.cmd, s.req, 5);
          if (a.status === X.STATUS.LF_TAG_OK) {
            r.lf.named.push({ name: s.name, ...s.parse(a.data) });
            log(`${s.name}: read`);
            break;
          }
          if (a.status === X.STATUS.INVALID_CMD) break; // this firmware has no such read
        }
      }
      if (long) {
        progress("Recording the raw LF signal", 0.65);
        // A card that moves during the recording leaves no clean repeating frame. One more try.
        let c = await sniff();
        if (c && analyse(c.bytes).frameBits == null) {
          log("LF signal: no repeating frame, recording again");
          c = (await sniff()) ?? c;
        }
        if (c) {
          captures.card = c;
          r.lf.signal = analyse(c.bytes);
          r.lf.checks = frameChecks(r.lf.signal);
          r.lf.fits = shapeFits(r.lf.signal);
          r.lf.dropped = c.info?.dropped ?? 0;
          if (baseline)
            r.lf.change = +(
              (100 * (r.lf.signal.level - baseline.level)) /
              baseline.level
            ).toFixed(1);
          log(
            `LF signal: ${r.lf.signal.modulation} RF/${r.lf.signal.rate ?? "-"}, frame ${r.lf.signal.frameBits ?? "-"}`,
          );
        }
      }
      if (long && r.lf.signal) {
        // Two T55xx reads with no password. Each only reads: 6 bits on air, where a write needs 32 more.
        progress("Checking for a T55xx", 0.75);
        let t55probe = null;
        const t = await probe(X.PROBE_T55XX_TRACE);
        if (t) {
          captures.chip = t;
          const a = t55xxAnswer(t.bytes, r.lf.signal);
          t55probe = a.probe;
          r.lf.chip = a.answer;
          r.lf.chipBlock = a.block ?? null;
          log(`chip check: ${a.answer}`);
        }
        if (r.lf.chip !== "yes") {
          // Not a T55xx: the EM4x05 read of word 0, as the Proxmark's lf search sends it. 13 bits on air;
          // a write, protect or disable needs a 45-bit data field after the command.
          progress("Checking for an EM4x05", 0.8);
          const e = await probe(X.PROBE_EM4X05_WORD0);
          if (e) {
            captures.em4x05 = e;
            r.lf.em4x05 = em4x05Answer(analyse(e.bytes));
            log(`EM4x05 check: ${r.lf.em4x05?.chip ?? "no answer"}`);
          }
          // Neither chip answered: the Hitag 2 start command, the one the Proxmark's `lf search` sends.
          // A tag can miss one, so it goes out twice before the page gives up.
          if (!r.lf.em4x05) {
            progress("Checking for a Hitag", 0.82);
            for (let tries = 0; tries < 2 && !r.lf.hitag2; tries++) {
              const h = await probe(X.PROBE_HITAG2_START);
              if (!h) break; // this firmware has no Hitag check
              captures[`hitag${tries}`] = h;
              r.lf.hitag2 = hitag2Answer(h.bytes);
            }
            if (r.lf.hitag2 !== undefined)
              log(`Hitag check: ${r.lf.hitag2 ? "answered" : "no answer"}`);
          }
        }
        if (r.lf.chip === "yes") {
          progress("Reading the T55xx configuration", 0.8);
          const c = await probe(X.PROBE_T55XX_CONFIG);
          if (c) {
            captures.config = c;
            r.lf.config = t55ConfigFromProbe(
              analyse(c.bytes),
              r.lf.signal,
            );
            // the configuration says how the tag modulates, which settles how to read the trace block
            if (r.lf.config)
              r.lf.chipBlock = traceBlock(t55probe, r.lf.config);
            log(
              `T55xx configuration: ${r.lf.config?.word ?? "not read"}`,
            );
          }
        }
      }
      progress("Checking HF", 0.85);
      const h = await cu.cmd(X.CMD.HF14A_SCAN, undefined, 5);
      r.hf = {
        cards:
          h.status === X.STATUS.HF_TAG_OK ? X.parseHf14a(h.data) : [],
      };
      for (const card of r.hf.cards) {
        if (!X.isClassic(card.sak)) continue;
        const p = await cu.cmd(X.CMD.MF1_DETECT_PRNG, undefined, 5);
        if (p.status === X.STATUS.HF_TAG_OK) card.prng = p.data[0];
      }
      log(`HF: ${r.hf.cards.length} card(s)`);
    });
    report = r;
    showReport();
    $("identifyinfo").textContent = "done: the report is below";
  });

// ---------------------------------------------------------------- the report

function showReport() {
  $("safe").textContent = X.safeMarkdown(report);
  $("private").textContent = X.fullMarkdown(report)
    .split("**Private details**")[1]
    .trim();
  $("resultbox").hidden = false;
}
$("copyFull").onclick = async () => {
  if (
    !confirm(
      "The full report can contain your card's credential. Copy it anyway?",
    )
  )
    return;
  await navigator.clipboard.writeText(X.fullMarkdown(report));
  $("copyFull").textContent = "Copied";
  setTimeout(
    () => ($("copyFull").textContent = "Copy the full report"),
    1500,
  );
};
$("download").onclick = () => {
  if (
    !confirm(
      "The raw signal can contain your card's credential. Download it anyway?",
    )
  )
    return;
  const raw = {};
  for (const [k, c] of Object.entries(captures)) {
    let s = "";
    for (const b of c.bytes) s += String.fromCharCode(b);
    raw[k] = { info: c.info, samples16be: btoa(s) };
  }
  saveJson(`cu-search-${Date.now()}.json`, { report, captures: raw });
};

bindCopyButtons();
setState("connect");
showSiteCommit($("siteversion"));
