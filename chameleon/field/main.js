// The field measurement page (index.html): connecting the CU, setting up a measurement, and reading its log.

import { bindFlashButtons, showFirmware } from "../common/flash-ui.js";
import { openCU, watchDisconnect, cuConnectCard } from "../common/session.js";
import {
  $,
  log,
  showState,
  setDisabled,
  oneAtATime,
  bindCopyButtons,
  saveJson,
  showFooter,
} from "../../common/page.js";
import * as P from "./measure.js";

cuConnectCard();

const MEASURE_FW = {
  zip: "firmware/field-measure-e67be65e-ultra-dfu-app.zip",
  name: "experimental cbb0b5c6",
};
const STOCK = {
  zip: "../common/firmware/stock-v2.3.0-ultra-dfu-app.zip",
  name: "stock v2.3.0",
};
MEASURE_FW.label = `Flash the experimental firmware (${MEASURE_FW.name.replace("experimental ", "")})`;

let cu = null,
  has = false, // the firmware has field measurement
  measuring = null, // whether measurement is on, once the page has read it
  measureVersion = null, // its log version, for a measurement's record
  firmware = "",
  report = null,
  rawLog = null,
  lastCapture = null;

const setState = (state) =>
  showState(state, {
    connect: ["current"],
    ready: ["done", "current"],
  });
const CONTROLS = [
  "measureOn",
  "measureOff",
  "measure",
  "readlog",
  "clearlog",
  "setenv",
  "capture",
  "reconnect",
  "flashTest",
  "flashStock",
  "flashFile",
];
const { run, isBusy } = oneAtATime((on) => {
  setDisabled(CONTROLS, on);
  if (!on) syncMeasureButtons();
});
// Once the page knows the mode, the measuring button that would change nothing is disabled.
function syncMeasureButtons() {
  if (measuring === null || isBusy()) return;
  $("measureOn").disabled = measuring;
  $("measureOff").disabled = !measuring;
}
const need = () => {
  if (!has) throw new Error("this firmware has no field measurement");
};

// ---------------------------------------------------------------- connect and firmware
function showMode(m) {
  measuring = m.on;
  syncMeasureButtons();
  $("modeinfo").textContent = m.on
    ? "Measurement is on: the CU won't emulate."
    : "Measurement is off: the CU emulates as usual.";
  $("modeinfo").className = m.on ? "note warn" : "note";
  $("envmode").value = String(m.envMode);
}
async function checkFirmware() {
  measuring = null;
  const fw = await cu.version();
  const r = await cu.cmd(P.CMD.MEASURE_MODE);
  has = r.status === P.STATUS.SUCCESS;
  const m = has ? P.parseMode(r.data) : null;
  // A tester's CU on older measurement firmware still reads: the page knows every log version from 3 on.
  if (m && P.recSizeOf(m.version) !== m.recSize) {
    has = false;
    log(
      `the log is version ${m.version}, record ${m.recSize} bytes. This page reads versions 3 to ${P.LOG_VERSION}`,
    );
  }
  if (has) measureVersion = m.version;
  showFirmware(
    has
      ? `Firmware ${fw}, with field measurement.`
      : `Firmware ${fw} has no field measurement.`,
    !has,
  );
  $("fwneed").hidden = has;
  if (m && has) showMode(m);
  log(`connected: ${fw}, field measurement ${has ? "yes" : "no"}`);
  if (has) {
    try {
      await readHeader();
    } catch (e) {
      log(`reading the log's header failed: ${e.message}`);
    }
  }
  return fw;
}
const connectCU = () =>
  run("connect", async () => {
    cu = await openCU(cu);
    if (!cu) return;
    firmware = await checkFirmware();
    setState("ready");
  });
$("connect").onclick = connectCU;
$("reconnect").onclick = connectCU;
watchDisconnect(
  () => cu,
  () => {
    cu = null;
    setState("connect");
  },
);
bindFlashButtons({
  firmware: { test: MEASURE_FW, stock: STOCK },
  port: () => cu?.port ?? null,
  release: async () => {
    await cu?.close();
    cu = null;
  },
  busy: () => (isBusy() ? "wait for the current step to finish" : null),
  done: () => setState("connect"),
});

// Field measurement works in tag mode only.
async function tagMode() {
  const m = await cu.cmd(P.CMD.GET_DEVICE_MODE, undefined, 8);
  if (m.data[0] !== 0) await cu.cmd(P.CMD.CHANGE_DEVICE_MODE, P.reqMode(false));
}
async function setMeasure(on, envMode) {
  need();
  await tagMode();
  const r = await cu.cmd(P.CMD.MEASURE_MODE, P.reqMode(on, envMode), 8);
  if (r.status !== P.STATUS.SUCCESS)
    throw new Error(`status 0x${r.status.toString(16)}`);
  const m = P.parseMode(r.data);
  showMode(m);
  log(
    `measurement ${m.on ? "on" : "off"}, envelope load ${P.MOD_NAMES[m.envMode]}`,
  );
  return m;
}
$("measureOn").onclick = () => run("measurement on", () => setMeasure(true));
$("measureOff").onclick = () => run("measurement off", () => setMeasure(false));
$("setenv").onclick = () =>
  run("envelope mode", async () => {
    const r = P.parseMode(
      (await cu.cmd(P.CMD.MEASURE_MODE, undefined, 8)).data,
    );
    await setMeasure(r.on, Number($("envmode").value));
  });

// ---------------------------------------------------------------- measuring and the log
// One piece of the log, asked for twice before giving up.
async function logPiece(offset, max) {
  for (let tries = 1; ; tries++) {
    try {
      const r = await cu.cmd(P.CMD.MEASURE_LOG, P.reqLog(offset, max), 8);
      if (r.status !== P.STATUS.SUCCESS)
        throw new Error(`status 0x${r.status.toString(16)}`);
      return r.data;
    } catch (e) {
      log(
        `reading the log at byte ${offset}: ${e.message}${tries < 2 ? ", trying again" : ""}`,
      );
      if (tries >= 2)
        throw new Error(`the log stopped at byte ${offset} of ${P.LOG_SIZE}`);
    }
  }
}
// The header first, logged on its own, then the rest in 512-byte pieces.
async function readHeader() {
  const h = P.parseHeader(await logPiece(0, P.HEADER));
  log(h.error ? `log header: ${h.error}` : `log: ${P.headerLine(h)}`);
  return h;
}
// size: the header's log size, since the log's size depends on its version.
async function readLog(size = P.LOG_SIZE) {
  const bytes = new Uint8Array(size);
  let got = 0;
  while (got < size) {
    const d = await logPiece(got, Math.min(512, size - got));
    if (!d.length) break;
    bytes.set(d, got);
    got += d.length;
  }
  return bytes.subarray(0, got);
}
function showReport() {
  $("safe").textContent = P.safeMarkdown(report);
  $("private").textContent = P.privateMarkdown(report)
    .split("**Private details**")[1]
    .trim();
  $("resultbox").hidden = false;
}
async function loadReport() {
  const h = await readHeader();
  const bytes = await readLog(h.logSize);
  const parsed = P.parseLog(bytes);
  if (parsed.error) throw new Error(parsed.error);
  rawLog = bytes;
  report = { firmware, log: parsed };
  showReport();
  const c = parsed.counts;
  $("loginfo").textContent =
    `${c.lfFields} LF field(s), ${c.lfRecs} LF measurement(s), ${c.hfFields} HF field(s)`;
  log(`log read: ${$("loginfo").textContent}`);
}
$("readlog").onclick = () =>
  run("reading the log", async () => (need(), await loadReport()));
$("clearlog").onclick = () =>
  run("clearing the log", async () => {
    need();
    if (!confirm("Clear the CU's measurement log?")) return;
    await cu.cmd(P.CMD.MEASURE_CLEAR);
    $("resultbox").hidden = true;
    $("loginfo").textContent = "cleared";
    log("log cleared");
  });
$("measure").onclick = () =>
  run("measuring", async () => {
    need();
    await tagMode();
    const m = P.parseMode(
      (await cu.cmd(P.CMD.MEASURE_MODE, undefined, 8)).data,
    );
    if (!m.on) await setMeasure(true);
    $("measureinfo").textContent = "measuring…";
    const r = await cu.cmd(P.CMD.MEASURE_NOW, undefined, 10);
    if (r.status !== P.STATUS.SUCCESS)
      throw new Error(`status 0x${r.status.toString(16)}`);
    const rec = P.parseRec(
      new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength),
      0,
      measureVersion,
    );
    const d = P.describeRound(rec);
    $("measureinfo").textContent = d.field
      ? `field, ${d.carrier ? (d.carrier.hz / 1000).toFixed(3) + " kHz" : "no carrier line"}, ${rec.dipsTotal} dip(s)`
      : "no field";
    await loadReport();
  });

// ---------------------------------------------------------------- raw captures
function plot(samples) {
  const c = $("capplot");
  c.hidden = false;
  const w = (c.width = c.clientWidth * devicePixelRatio);
  const h = (c.height = c.clientHeight * devicePixelRatio);
  const g = c.getContext("2d");
  g.clearRect(0, 0, w, h);
  let mn = Infinity,
    mx = -Infinity;
  for (const s of samples) ((mn = Math.min(mn, s)), (mx = Math.max(mx, s)));
  const span = mx - mn || 1;
  g.strokeStyle = getComputedStyle(document.body).getPropertyValue("--accent");
  g.beginPath();
  // one column per pixel: its minimum to its maximum, so a gap a sample wide still shows
  const per = samples.length / w;
  for (let x = 0; x < w; x++) {
    let lo = Infinity,
      hi = -Infinity;
    for (
      let i = Math.floor(x * per);
      i < Math.floor((x + 1) * per) && i < samples.length;
      i++
    )
      ((lo = Math.min(lo, samples[i])), (hi = Math.max(hi, samples[i])));
    if (lo === Infinity) continue;
    g.moveTo(x, h - ((lo - mn) / span) * h);
    g.lineTo(x, h - ((hi - mn) / span) * h + 1);
  }
  g.stroke();
}
$("capture").onclick = () =>
  run("capture", async () => {
    need();
    await tagMode();
    const m = P.parseMode(
      (await cu.cmd(P.CMD.MEASURE_MODE, undefined, 8)).data,
    );
    if (!m.on) await setMeasure(true);
    const req = {
      mod: Number($("capmod").value),
      rateKhz: Number($("caprate").value),
      n: Number($("capn").value),
    };
    const r = await cu.cmd(P.CMD.MEASURE_CAPTURE, P.reqCapture(req), 10);
    if (r.status !== P.STATUS.SUCCESS)
      throw new Error(`status 0x${r.status.toString(16)}`);
    const parts = [];
    for (let c = 0; c < 0xff; c++) {
      const d = await cu.cmd(
        P.CMD.MEASURE_CAPTURE_READ,
        P.reqCaptureRead(c),
        8,
      );
      if (!d.data.length) break;
      parts.push(d.data);
    }
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) bytes.set(p, (o += p.length) - p.length);
    const samples = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    lastCapture = { ...req, samples: Array.from(samples) };
    plot(samples);
    $("capdownload").disabled = false;
    $("capinfo").textContent =
      `${samples.length} samples at ${req.rateKhz} kHz, load ${P.MOD_NAMES[req.mod]}`;
    log(`capture: ${$("capinfo").textContent}`);
  });
$("capdownload").onclick = () => {
  if (!confirm("A raw capture can include sensitive info. Download it anyway?"))
    return;
  saveJson(`cu-field-capture-${Date.now()}.json`, {
    firmware,
    ...lastCapture,
  });
};

$("download").onclick = () => {
  if (!confirm("The log can include sensitive info. Download it anyway?"))
    return;
  let s = "";
  for (const b of rawLog) s += String.fromCharCode(b);
  saveJson(`cu-field-log-${Date.now()}.json`, {
    report,
    logBytes: btoa(s),
  });
};
bindCopyButtons();
setState("connect");
showFooter();
