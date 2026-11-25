// The interactive LF emulation page (index.html): connecting the CU, the Hitag 2 test tag, and reading its trace.

import {
  bindFlashButtons,
  buildText,
  showFirmware,
} from "../common/flash-ui.js";
import { openCU, watchDisconnect, cuConnectCard } from "../common/session.js";
import { SerialCU } from "../common/cu.js";
import {
  $,
  log,
  hasWebSerial,
  showState,
  setDisabled,
  oneAtATime,
  bindCopyButtons,
  saveJson,
  showFooter,
} from "../../common/page.js";
import { CMD_GET_SLOT_INFO, lfName, parseSlotInfo } from "../common/slots.js";
import * as P from "./interactive.js";

cuConnectCard();

const TEST_FW = {
  zip: "firmware/lf-hitag-modes-abde82d1-ultra-dfu-app.zip",
  name: "experimental abde82d1",
  version: "v2.3.0-91-gabde82d",
  time: "2026-11-25T00:44:20Z", // the commit time, in UTC
};
const STOCK = {
  zip: "../common/firmware/stock-v2.3.0-ultra-dfu-app.zip",
  name: "stock v2.3.0",
};
TEST_FW.label = `Flash the experimental firmware (${buildText(TEST_FW)})`;
let cu = null,
  has = false, // the firmware has the interactive engine
  hasTiming = false, // the firmware has LF_RDR_LAST (3189), for a single answer's timing
  hasTrace = false, // the firmware has LF_RDR_TRACE_READ (3190), for the whole exchange
  hasLog = false, // the firmware keeps the exchange log in flash (LF_IA_LOG_INFO, 3192), not the 48-record trace
  slotTypes = null, // each slot's LF card type, once read
  firmware = "",
  report = null,
  timing = null, // the last exchange's timing record, for download
  startAuthTally = new Map(); // per tag UID: the START_AUTH counts over this visit's reads (P.startAuthPattern)

// Step 3 (read the trace) is current once a trace has been read.
const setState = (state) =>
  showState(state, {
    connect: ["current"],
    ready: report ? ["done", "done", "current"] : ["done", "current"],
  });
const CONTROLS = [
  "slot",
  "loadslot",
  "setup",
  "scan",
  "readtag",
  "clear",
  "read",
  "reconnect",
  "timingdownload",
  "downloadclear",
  "showenvelope",
  "flashTest",
  "flashStock",
  "flashFile",
];
const { run, isBusy } = oneAtATime((on) => {
  setDisabled(CONTROLS, on);
  if (!on) syncLoadButton();
});
const need = () => {
  if (!has) throw new Error("this firmware has no interactive LF engine");
};

// The slot list: each slot's number and, once the page has read them, its LF card.
function renderSlots() {
  const sel = $("slot"),
    keep = sel.value;
  sel.textContent = "";
  for (let s = 0; s < 8; s++)
    sel.append(
      new Option(
        slotTypes ? `slot ${s + 1}: ${lfName(slotTypes[s])}` : `slot ${s + 1}`,
        String(s),
      ),
    );
  if (keep !== "") sel.value = keep;
  syncLoadButton();
}
async function readSlots() {
  const r = await cu.cmd(CMD_GET_SLOT_INFO);
  slotTypes =
    r.status === P.STATUS.SUCCESS
      ? parseSlotInfo(r.data).map((s) => s.lf)
      : null;
  renderSlots();
}
// Loading a slot into the fields needs a slot that holds a Hitag 2 card.
function syncLoadButton() {
  if (isBusy()) return;
  $("loadslot").disabled =
    !cu || slotTypes?.[Number($("slot").value)] !== P.TAG_TYPE_HITAG2;
}
renderSlots();
$("slot").onchange = syncLoadButton;

// ---------------------------------------------------------------- connect and firmware
async function checkFirmware() {
  const fw = await cu.version();
  // The engine's counters command is the probe: a firmware without it answers "invalid command".
  const r = await cu.cmd(P.CMD.LF_IA_TUNING);
  has = r.status === P.STATUS.SUCCESS;
  // The answer timing is newer than the engine itself: a build without it answers "invalid command". The whole-exchange
  // trace (LF_RDR_TRACE_READ) is newer still; without it the page falls back to the single last answer (LF_RDR_LAST).
  const t = has ? await cu.cmd(P.CMD.LF_RDR_LAST) : null;
  hasTiming = !!t && t.status !== P.STATUS.INVALID_CMD;
  const tr = hasTiming ? await cu.cmd(P.CMD.LF_RDR_TRACE_READ) : null;
  hasTrace = !!tr && tr.status !== P.STATUS.INVALID_CMD;
  const li = has ? await cu.cmd(P.CMD.LF_IA_LOG_INFO) : null;
  hasLog = li?.status === P.STATUS.SUCCESS;
  showFirmware(
    has
      ? `Firmware ${fw}, with the interactive LF engine.`
      : `Firmware ${fw} has no interactive LF engine.`,
    !has,
  );
  $("fwneed").hidden = has;
  log(
    `connected: ${fw}, interactive engine ${has ? "yes" : "no"}` +
      (has
        ? `, answer timing ${hasTrace ? "full exchange" : hasTiming ? "last answer only" : "no"}, ${hasLog ? "flash log" : "48-record trace"}`
        : ""),
  );
  return fw;
}
const connectCU = () =>
  run("connect", async () => {
    cu = await openCU(cu);
    if (!cu) return;
    firmware = await checkFirmware();
    await readSlots();
    if (has) {
      const a = await cu.cmd(P.CMD.GET_ACTIVE_SLOT);
      if (a.status === P.STATUS.SUCCESS) $("slot").value = String(a.data[0]);
    }
    setState("ready");
  });
$("connect").onclick = connectCU;
$("reconnect").onclick = connectCU;
watchDisconnect(
  () => cu,
  () => {
    cu = null;
    hasTiming = false;
    hasTrace = false;
    hasLog = false;
    clearExchange();
    setState("connect");
  },
);

// ---------------------------------------------------------------- the tag's details
// A field's placeholder shows the example tag in grey. Only what's typed or read counts: "Fill blanks with the
// example tag" copies the placeholders in.
const fv = (id) => $(id).value.trim();
// The fields each page fills, page 0 first. Page 3 is the config byte and the tag password.
const PAGE_FIELDS = [
  ["p0"],
  ["p1"],
  ["p2"],
  ["p3config", "p3tagpw"],
  ["p4"],
  ["p5"],
  ["p6"],
  ["p7"],
];
const EDITABLE = PAGE_FIELDS.flat().filter((id) => id !== "p3config");
const readFields = () => ({
  p0: fv("p0"),
  p1: fv("p1"),
  p2: fv("p2"),
  config: $("p3config").value,
  tagpw: fv("p3tagpw"),
  p4: fv("p4"),
  p5: fv("p5"),
  p6: fv("p6"),
  p7: fv("p7"),
});
// Fills the fields of the pages a read got. The fields of pages it didn't get keep what they held.
function fillReadPages(read) {
  const f = P.fieldsFromPages(P.pagesFromRead(read));
  const value = { p3config: f.config, p3tagpw: f.tagpw };
  read.pages.forEach((bytes, i) => {
    if (!bytes) return;
    // Page 3 shows the tag's real config byte, even though it is normally fixed at 06. The emulation ignores it and
    // always runs password mode, so a non-06 value is informational.
    for (const id of PAGE_FIELDS[i]) $(id).value = value[id] ?? f[id];
  });
  updateAscii();
}

// The ASCII column: each page's bytes as printable characters (a non-printable byte shows as a dot), like a
// Proxmark dump. It follows whatever is in the fields, placeholders included.
function hexToAscii(h) {
  h = (h || "").replace(/\s+/g, "");
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) return "";
  let s = "";
  for (let i = 0; i < h.length; i += 2) {
    const c = parseInt(h.slice(i, i + 2), 16);
    s += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : ".";
  }
  return s;
}
function updateAscii() {
  // Only actual field content, never a placeholder: an untouched field's ascii stays blank. Page 3 needs both the
  // config and the tag password typed before it shows.
  const av = (id) => $(id).value.trim();
  const pages = {
    a0: av("p0"),
    a1: av("p1"),
    a2: av("p2"),
    a3: av("p3config") && av("p3tagpw") ? av("p3config") + av("p3tagpw") : "",
    a4: av("p4"),
    a5: av("p5"),
    a6: av("p6"),
    a7: av("p7"),
  };
  for (const id in pages) $(id).textContent = hexToAscii(pages[id]);
}
// Each field holds hex of a fixed length: 8 digits (4 bytes) per page, 2 for the config byte, 6 for the tag
// password. Cap the length and drop any non-hex character as it is typed or pasted.
const HEX_LEN = {
  p0: 8,
  p1: 8,
  p2: 8,
  p3config: 2,
  p3tagpw: 6,
  p4: 8,
  p5: 8,
  p6: 8,
  p7: 8,
};
for (const id in HEX_LEN) {
  const el = $(id);
  el.maxLength = HEX_LEN[id];
  el.addEventListener("input", () => {
    const clean = el.value.replace(/[^0-9a-fA-F]/g, "").slice(0, HEX_LEN[id]);
    if (clean !== el.value) el.value = clean;
    updateAscii();
  });
}
updateAscii();

// Read a physical tag. The reader commands require the device to be in reader mode (the firmware rejects them in
// tag mode with a device-mode error); this puts it in reader mode for the command and back to tag mode after, so
// the slot keeps emulating. The commands themselves get a long timeout (scan 6 s, read 12 s), because the reader
// retries internally — 8 START_AUTH tries, and 6 tries per page over 8 pages — which can run past the 3 s default
// (the CLI uses 5 s and 10 s for the same reason).
async function inReaderMode(fn) {
  await cu.ok(P.CMD.CHANGE_DEVICE_MODE, Uint8Array.of(1));
  try {
    return await fn();
  } finally {
    await cu.cmd(P.CMD.CHANGE_DEVICE_MODE, Uint8Array.of(0));
  }
}

// The read status line, coloured by outcome: "ok" green, "warn" amber, "bad" red, "" neutral.
function setScan(msg, cls = "") {
  $("scaninfo").className = "note" + (cls ? " " + cls : "");
  $("scaninfo").textContent = msg;
}

// ---------------------------------------------------------------- the reader exchange timing
// A scan or read runs many reader commands, each its own transaction. The firmware records each one's command and
// answer timing (LF_RDR_TRACE_*). The page clears the trace before the exchange, then reads it back, shows every
// command, logs the full run detail, and keeps a complete record for download. Older builds with only the single last
// answer (LF_RDR_LAST) fall back to one transaction. Gated on the scan/read result, not on any record's own status:
// with no tag the raw status can still read "tag OK" from the field settling, but a scan/read only succeeds on a real
// answer.

function clearExchange() {
  timing = null;
  $("timingbox").hidden = true;
  $("envelopebox").hidden = true;
  $("envelopebox").textContent = "";
  $("timingsafe").textContent = "";
}

// Clear the reader trace before a scan or read, so it holds exactly that exchange.
async function resetTrace() {
  if (hasTrace) await cu.cmd(P.CMD.LF_RDR_TRACE_CLEAR);
}

// The trace, capture and log read-outs page replies of up to ~4 KB, far larger than the other replies. Web Serial on
// macOS loses bytes of replies that large now and then, and the reply then never completes. A whole reply arrives in
// milliseconds, so over USB a read-out waits USB_READ_TIMEOUT_S before it tries again. Over USB, each read-out also
// asks for pieces of about 1 KB, a size that has arrived whole every time. Bluetooth keeps the longer timeouts and the
// firmware's largest pieces: it hasn't lost bytes of 4 KB replies, and each extra piece costs a round trip of about
// 60 ms. A firmware that takes no piece size for the capture or the reader trace (before v2.3.0-86 on
// exp/lf-hitag-modes) ignores the request's extra bytes.
const USB_READ_TIMEOUT_S = 2;
const USB_LOG_PAGE = 1024; // bytes
const USB_CAPTURE_PAGE = 500; // samples, 1014-byte replies
const USB_TRACE_PAGE = 4; // records, 863-byte replies
const overUsb = () => cu instanceof SerialCU;

// retried() calls send() up to three times, each with the timeout for the link (longS over Bluetooth), and logs each
// failure under what.
async function retried(what, longS, send) {
  const timeoutS = overUsb() ? USB_READ_TIMEOUT_S : longS;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await send(timeoutS);
    } catch (e) {
      lastErr = e;
      log(`${what}: attempt ${attempt} ${e.message}`);
    }
  }
  throw lastErr;
}

// LF_RDR_CAPTURE pages the samples. The request is the offset and the most samples to send (0 for all that fit), both
// big-endian u16.
async function readCapture() {
  const samples = [];
  let total = 0;
  const max = overUsb() ? USB_CAPTURE_PAGE : 0;
  for (;;) {
    const off = samples.length;
    const req = Uint8Array.of(off >> 8, off & 0xff, max >> 8, max & 0xff);
    const r = await retried(`capture read from ${off}`, 6, (t) =>
      cu.cmd(P.CMD.LF_RDR_CAPTURE, req, t),
    );
    if (r.status !== P.STATUS.SUCCESS) break;
    const part = P.parseCapture(r.data);
    if (!part) break;
    total = part.total;
    if (part.count === 0) break;
    samples.push(...part.samples);
    if (samples.length >= total) break;
  }
  return { total, count: samples.length, samples };
}

// Read every reader-transaction record, paging by record index (big-endian u16), then the most records to send (u8, 0
// for all that fit). total can exceed the records held if a long read rolled some off, so stop on an empty batch too.
async function readReaderTrace() {
  const recs = [];
  let total = 0;
  const max = overUsb() ? USB_TRACE_PAGE : 0;
  for (;;) {
    const first = recs.length;
    const req = Uint8Array.of(first >> 8, first & 0xff, max);
    const r = await retried(`reader trace read from ${first}`, 6, (t) =>
      cu.cmd(P.CMD.LF_RDR_TRACE_READ, req, t),
    );
    if (r.status !== P.STATUS.SUCCESS) break;
    const part = P.parseReaderTraceReply(r.data);
    if (!part) break;
    if (part.size !== P.TRACE_REC_SIZE)
      throw new Error(
        `trace record size ${part.size}, this page reads ${P.TRACE_REC_SIZE}: firmware and page differ`,
      );
    total = part.total;
    if (part.count === 0) break;
    recs.push(...part.recs);
    if (recs.length >= total) break;
  }
  return { total, recs };
}

// A square-wave strip of the load runs: a filled bar while the tag loads, a gap while it doesn't, width by duration.
function runsSvg(runs) {
  const total = runs.reduce((s, r) => s + r.us, 0) || 1;
  const W = 600,
    H = 40;
  let x = 0,
    rects = "";
  for (const r of runs) {
    const w = (r.us / total) * W;
    if (r.load)
      rects += `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${H}" fill="currentColor"/>`;
    x += w;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="tag answer load runs">${rects}</svg>`;
}

// The raw envelope as a line, idle at the bottom.
function envelopeSvg(samples) {
  if (samples.length < 2) return "";
  const W = 600,
    H = 120;
  const min = Math.min(...samples),
    max = Math.max(...samples),
    span = max - min || 1;
  const pts = samples
    .map(
      (v, i) =>
        `${((i / (samples.length - 1)) * W).toFixed(1)},${(H - ((v - min) / span) * H).toFixed(1)}`,
    )
    .join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="tag answer envelope"><polyline fill="none" stroke="currentColor" stroke-width="1" points="${pts}"/></svg>`;
}

// One row per transaction; the strip and the envelope below are the last command's answer.
function renderExchange(txns) {
  const answered = txns.filter((t) => t.answered).length;
  $("timinginfo").textContent =
    `${txns.length} command(s), ${answered} answered. The strip and envelope below are the last command's answer.`;
  const tb = $("timingtx");
  tb.textContent = "";
  for (let i = 0; i < txns.length; i++) {
    const t = txns[i];
    const tr = document.createElement("tr");
    const td = (text, cls) => {
      const c = document.createElement("td");
      c.textContent = text;
      if (cls) c.className = cls;
      tr.append(c);
      return c;
    };
    td(String(i));
    td(t.cmd);
    td(t.answered ? `${t.nBits} bit` : "–", t.answered ? "" : "dim");
    td(`${t.delayUs}`);
    td(String(t.depth));
    td(`${t.totalUs}`);
    tb.append(tr);
  }
  const last = txns[txns.length - 1];
  $("timingruns").innerHTML = last ? runsSvg(last.runs) : "";
  $("envelopebox").hidden = true;
  $("envelopebox").textContent = "";
  $("timingbox").hidden = false;
}

async function captureExchange(action, extra) {
  let txns = null;
  if (hasTrace) {
    txns = (await readReaderTrace()).recs;
  } else if (hasTiming) {
    const lr = await cu.cmd(P.CMD.LF_RDR_LAST);
    if (
      lr.status !== P.STATUS.LF_TAG_OK &&
      lr.status !== P.STATUS.LF_TAG_NO_FOUND
    )
      return;
    const last = P.parseLastReply(lr.data);
    if (!last) return;
    txns = [
      {
        ...last,
        cmd: "last answer",
        nTx: 0,
        powerUpUs: 0,
        answered: last.nBits > 0,
      },
    ];
  } else return;
  if (!txns.length) return;
  // The envelope is extra detail. If its read-out fails three times, the exchange still shows, without it.
  const cap = await readCapture().catch((e) => {
    log(`answer envelope not read: ${e.message}`);
    return { total: 0, count: 0, samples: [] };
  });
  const linkR = await cu.cmd(P.CMD.HITAG2_READER_LINK);
  const link =
    linkR.status === P.STATUS.SUCCESS ? P.parseReaderLink(linkR.data) : null;
  timing = P.buildExchangeRecord(
    { firmware, action, ...extra },
    txns,
    cap,
    link,
  );
  renderExchange(txns);
  log(P.exchangeLogText(txns));
  showStartAuth(extra?.uid, txns);
  $("timingsafe").textContent = P.safeTimingMarkdown(timing);
}

// Whether the tag answers every START_AUTH or every second one, added up over this visit's reads of the same tag.
function showStartAuth(uid, txns) {
  const key = uid ?? "unknown";
  const now = P.startAuthPattern(txns);
  const sum = startAuthTally.get(key) ?? { again: 0, skipped: 0, unclear: 0 };
  for (const k of Object.keys(sum)) sum[k] += now[k];
  startAuthTally.set(key, sum);
  const v = P.startAuthVerdict(sum);
  $("sainfo").textContent =
    v.text + (v.kind === "every-second" ? " " + P.RESET_TEST_PROMPT : "");
  $("sainfo").className = "note gap-top" + (v.kind === "unknown" ? "" : " ok");
  $("sainfo").hidden = false;
  if (timing) timing.startAuth = { thisRead: now, total: sum, verdict: v.kind };
  log(
    `START_AUTH after an answer: answered again ${now.again}, ignored ${now.skipped}, partly decoded ` +
      `${now.unclear} (this tag so far: ${sum.again}, ${sum.skipped}, ${sum.unclear}; ${v.kind})`,
  );
}

$("timingdownload").onclick = () => {
  if (!timing) return;
  const t = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  saveJson(`cu-hitag-exchange-${t}.json`, timing);
};
$("showenvelope").onclick = () => {
  if (!timing?.lastEnvelope) return;
  const box = $("envelopebox");
  if (box.hidden) {
    box.innerHTML = envelopeSvg(timing.lastEnvelope.samples);
    box.hidden = false;
  } else {
    box.hidden = true;
    box.textContent = "";
  }
};

$("scan").onclick = () =>
  run("scan", async () => {
    need();
    clearExchange();
    setScan("Hold a tag to the CU…");
    await resetTrace();
    const r = await inReaderMode(() =>
      cu.cmd(P.CMD.HITAG2_SCAN, new Uint8Array(0), 6),
    );
    if (r.status !== P.STATUS.LF_TAG_OK) {
      setScan("No Hitag 2 tag found.", "bad");
      return;
    }
    const uid = P.parseHitag2Scan(r.data);
    $("p0").value = uid;
    updateAscii();
    setScan(
      `Tag UID read: ${uid}. Put the tag's password in page 1 to read the pages, or write it to the slot.`,
      "ok",
    );
    log(`scanned a Hitag 2 tag, UID ${uid}`);
    await captureExchange("scan", { uid });
  });

$("readtag").onclick = () =>
  run("read a tag", async () => {
    need();
    const pw = P.parseHex($("p1").value, 4);
    if (!pw) {
      setScan(
        "Page 1 (the reader password) must be 8 hex digits to read a tag.",
        "bad",
      );
      return;
    }
    clearExchange();
    setScan("Hold a tag to the CU…");
    await resetTrace();
    const r = await inReaderMode(() =>
      cu.cmd(P.CMD.HITAG2_READ, P.reqHitag2Read(pw), 12),
    );
    if (r.status === P.STATUS.MF_ERR_AUTH) {
      setScan("The tag did not accept the password.", "bad");
      return;
    }
    const read =
      (r.status === P.STATUS.LF_TAG_OK ||
        r.status === P.STATUS.LF_TAG_NO_FOUND) &&
      P.parseHitag2Read(r.data);
    if (!read || !read.count) {
      setScan("No Hitag 2 tag found.", "bad");
      return;
    }
    fillReadPages(read);
    const unread = read.pages.flatMap((b, i) => (b ? [] : [i]));
    const cfg = read.pages[3] && P.describeConfig(P.pagesFromRead(read));
    const cfgNote =
      !cfg || cfg.byte === 0x06
        ? ""
        : ` Config is 0x${cfg.byte.toString(16).padStart(2, "0")} (${cfg.mode} mode); the emulation runs password mode regardless.`;
    setScan(
      (unread.length
        ? `Read ${read.count} of 8 pages into the fields. Not read: page${unread.length > 1 ? "s" : ""} ${unread.join(", ")}. Those fields keep what they held.`
        : "Read all 8 pages into the fields.") +
        ` Review, then write it to the slot.${cfgNote}`,
      unread.length ? "warn" : "ok",
    );
    log(
      `read a Hitag 2 tag, ${read.count}/8 pages` +
        (read.pages[0] ? `, UID ${P.uidOf(read.pages[0])}` : ""),
    );
    await captureExchange("read", {
      uid: read.pages[0] ? P.uidOf(read.pages[0]) : undefined,
    });
  });

// How the tag handles a field gap (P.resetProbeVerdict). Each command tries every gap twice, about 2 s with a tag.
const RESET_TEST_CALLS = 4;
let resetTest = null; // the last result, for download

$("resettest").onclick = () =>
  run("field gap test", async () => {
    need();
    $("resetinfo").hidden = true;
    $("resetsave").hidden = true;
    const gaps = P.RESET_PROBE_GAPS_US;
    const req = P.reqResetProbe(
      gaps,
      P.RESET_PROBE_WAIT_US,
      P.RESET_PROBE_ROUNDS,
    );
    /** @type {{ gapUs: number, started: number, answered: number }[] | null} */
    let sum = null;
    const r = await inReaderMode(async () => {
      for (let i = 0; i < RESET_TEST_CALLS; i++) {
        setScan(
          `Hold a tag still on the CU… testing field gaps, ${i + 1} of ${RESET_TEST_CALLS}`,
        );
        const res = await cu.cmd(P.CMD.HITAG2_RESET_PROBE, req, 30);
        if (res.status === P.STATUS.INVALID_CMD) return res;
        const rows = P.parseResetProbe(res.data, gaps);
        if (rows) sum = P.addResetProbe(sum, rows);
        if (i === 0 && res.status !== P.STATUS.LF_TAG_OK) return res;
      }
      return null;
    });
    if (r?.status === P.STATUS.INVALID_CMD) {
      setScan(
        "This firmware has no field gap test. Flash the test firmware above.",
        "bad",
      );
      return;
    }
    if (!sum || !sum.some((x) => x.started)) {
      setScan("No Hitag 2 tag found.", "bad");
      return;
    }
    const v = P.resetProbeVerdict(sum);
    setScan("Field gap test done.", v.kind === "unknown" ? "warn" : "ok");
    $("resetinfo").textContent = v.text;
    $("resetinfo").className =
      "note gap-top" + (v.kind === "unknown" ? "" : " ok");
    $("resetinfo").hidden = false;
    $("resetsave").hidden = false;
    resetTest = {
      firmware,
      time: new Date().toISOString(),
      waitUs: P.RESET_PROBE_WAIT_US,
      rows: sum,
      verdict: v.kind,
      startsOverFromUs: v.startsOverFromUs,
      carriesOnToUs: v.carriesOnToUs,
    };
    log(`field gap test: ${P.resetProbeRowsText(sum)}; ${v.kind}`);
  });

$("resetdownload").onclick = () => {
  if (!resetTest) return;
  const t = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  saveJson(`cu-hitag-field-gap-test-${t}.json`, resetTest);
};

// ---------------------------------------------------------------- write the tag to the slot
// The example tag, made up, into every blank field. The fields show it as placeholders until then.
$("example").onclick = () => {
  for (const id of EDITABLE) if (!fv(id)) $(id).value = $(id).placeholder;
  updateAscii();
  $("setupinfo").textContent = "";
};
$("setup").onclick = () =>
  run("set up", async () => {
    need();
    const blank = EDITABLE.filter((id) => !fv(id));
    if (blank.length) {
      const pages = [
        ...new Set(
          blank.map((id) => PAGE_FIELDS.findIndex((f) => f.includes(id))),
        ),
      ];
      $("setupinfo").textContent =
        `Page${pages.length > 1 ? "s" : ""} ${pages.join(", ")} ${pages.length > 1 ? "are" : "is"} blank. ` +
        "Type them, read a tag, or fill the blanks with the example tag.";
      return;
    }
    const pages = P.pagesFromFields(readFields());
    if (!pages) {
      $("setupinfo").textContent =
        "Each page must be hex: 8 digits, or 6 for the tag password.";
      return;
    }
    const uid = P.uidOf(pages);
    const slotFw = Number($("slot").value);
    await cu.ok(P.CMD.SET_ACTIVE_SLOT, P.reqActiveSlot(slotFw));
    await cu.ok(
      P.CMD.SET_SLOT_TAG_TYPE,
      P.reqSetType(slotFw, P.TAG_TYPE_HITAG2),
    );
    // The default data gives the slot a stored record. Without one, older firmware may skip saving the pages if
    // another slot with the same pages was loaded last. The slot would then read back empty after a reboot.
    await cu.ok(
      P.CMD.SET_SLOT_DATA_DEFAULT,
      P.reqSetType(slotFw, P.TAG_TYPE_HITAG2),
    );
    await cu.ok(P.CMD.HITAG2_SET_EMU_DATA, pages);
    await cu.ok(
      P.CMD.SET_SLOT_ENABLE,
      P.reqSetEnable(slotFw, P.SENSE_LF, true),
    );
    await cu.ok(P.CMD.CHANGE_DEVICE_MODE, Uint8Array.of(0));
    await cu.ok(P.CMD.SLOT_DATA_CONFIG_SAVE);
    $("setupinfo").textContent =
      `Slot ${slotFw + 1}: Hitag 2, UID ${uid}, saved. Clear the trace, then go to the reader.`;
    log(`set up Hitag 2 on slot ${slotFw + 1}, UID ${uid}`);
    await readSlots();
  });

// The CU reads the active slot's card, so loading another slot makes it active for a moment. The slot that was
// active is put back afterwards.
$("loadslot").onclick = () =>
  run("load the slot", async () => {
    need();
    const slot = Number($("slot").value);
    const was = (await cu.ok(P.CMD.GET_ACTIVE_SLOT)).data[0];
    await cu.ok(P.CMD.SET_ACTIVE_SLOT, P.reqActiveSlot(slot));
    let data;
    try {
      data = (await cu.ok(P.CMD.HITAG2_GET_EMU_DATA)).data.slice(
        0,
        P.HITAG2_DATA_SIZE,
      );
    } finally {
      if (was !== slot)
        await cu.ok(P.CMD.SET_ACTIVE_SLOT, P.reqActiveSlot(was));
    }
    if (data.length !== P.HITAG2_DATA_SIZE)
      throw new Error(
        `slot ${slot + 1} sent ${data.length} bytes, expected 32`,
      );
    fillReadPages({
      pages: Array.from({ length: 8 }, (_, i) => data.slice(i * 4, i * 4 + 4)),
    });
    $("setupinfo").textContent =
      `Slot ${slot + 1}'s Hitag 2 card is in the fields, UID ${P.uidOf(data)}.`;
    log(`loaded slot ${slot + 1}'s Hitag 2 card, UID ${P.uidOf(data)}`);
  });

$("clear").onclick = () => run("clear", clearLog);
async function clearLog() {
  need();
  $("resultbox").hidden = true;
  if (!hasLog) {
    await cu.ok(P.CMD.LF_IA_TRACE_CLEAR);
    $("clearinfo").textContent =
      "Trace cleared. Unplug the CU and hold it to the reader.";
    log("trace cleared");
    return;
  }
  // The CU erases the log's flash a page at a time after the clear. Wait for it, so the log saves from the start.
  await cu.ok(P.CMD.LF_IA_LOG_CLEAR);
  const t0 = Date.now();
  let info;
  for (;;) {
    info = P.parseLogInfo((await cu.ok(P.CMD.LF_IA_LOG_INFO)).data);
    if (!info || info.state !== 1 || Date.now() - t0 > 60000) break;
    $("clearinfo").textContent =
      `Erasing the log: ${info.eraseLeft} page(s) to go…`;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  $("clearinfo").textContent =
    info?.state === 2
      ? `Log cleared: ${Math.round(info.capacity / 1024)} KB free. Unplug the CU and take it to the readers.`
      : `Log cleared, but its state is ${P.LOG_STATE[info?.state] ?? "unknown"}. Read the log to check.`;
  log(
    `log cleared in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${P.LOG_STATE[info?.state] ?? "?"}`,
  );
}

// ---------------------------------------------------------------- read the trace
// One trace-read batch is as many records as fit a single frame (~4 KB).
async function readTrace() {
  const recs = [];
  let total = 0,
    keep = P.TRACE_KEEP,
    boot = 0;
  for (;;) {
    const first = recs.length;
    const r = await retried(`trace read from ${first}`, 8, (t) =>
      cu.ok(P.CMD.LF_IA_TRACE_READ, P.reqTraceRead(first), t),
    );
    const part = P.parseTraceReply(r.data);
    if (!P.REC_SIZES.has(part.size))
      throw new Error(
        `trace record size ${part.size}, this page reads ${[...P.REC_SIZES].join(" or ")}: firmware and page differ`,
      );
    ({ total, keep, boot } = part);
    if (part.n === 0) break;
    recs.push(...part.recs);
    if (recs.length >= total) break;
  }
  return { total, keep, boot, recs };
}
// The flash log: its summary, then its stream in pieces, each retried like a trace batch.
async function readLog() {
  const info = P.parseLogInfo((await cu.ok(P.CMD.LF_IA_LOG_INFO)).data);
  if (!info || info.format !== P.LOG_FORMAT)
    throw new Error(
      `log format ${info?.format}, this page reads ${P.LOG_FORMAT}: firmware and page differ`,
    );
  const parts = [];
  let have = 0;
  for (;;) {
    const from = have;
    const r = await retried(`log read from ${from}`, 8, (t) =>
      cu.ok(
        P.CMD.LF_IA_LOG_READ,
        P.reqLogRead(from, overUsb() ? USB_LOG_PAGE : undefined),
        t,
      ),
    );
    const part = P.parseLogReadReply(r.data);
    if (!part.bytes.length) break;
    parts.push(part.bytes.slice());
    have += part.bytes.length;
    if (have >= part.end) break;
  }
  const stream = new Uint8Array(have);
  let o = 0;
  for (const b of parts) stream.set(b, (o += b.length) - b.length);
  const parsed = P.parseLogStream(stream);
  return {
    total: parsed.recs.length,
    keep: 0,
    boot: info.boot,
    recs: parsed.recs,
    counters: info.counters,
    log: {
      ...info,
      bad: parsed.bad,
      orphans: parsed.orphans,
      firmwares: parsed.firmwares,
    },
    streamHex: [...stream].map((x) => x.toString(16).padStart(2, "0")).join(""),
  };
}
$("read").onclick = () =>
  run("read", async () => {
    need();
    const counters = P.parseCounters((await cu.ok(P.CMD.LF_IA_TUNING)).data);
    const emuR = await cu.cmd(P.CMD.HITAG2_GET_EMU_DATA);
    const emu =
      emuR.status === P.STATUS.SUCCESS
        ? emuR.data.slice(0, P.HITAG2_DATA_SIZE)
        : null;
    const t = hasLog ? await readLog() : await readTrace();
    report = {
      firmware,
      counters,
      emu,
      readAt: new Date().toISOString(),
      ...t,
    };
    $("safe").textContent = P.safeMarkdown(report);
    $("private").textContent = P.privateMarkdown(report);
    $("resultbox").hidden = false;
    setState("ready");
    // If the reader's password turned up in the trace (repeated attempts that agree), put it in page 1 so the
    // tag can authenticate on the next visit.
    const pw = P.recoverPassword(t.recs);
    if (pw) {
      $("p1").value = pw.hex;
      updateAscii();
    }
    $("readinfo").textContent =
      `${t.recs.length} record(s) over ${counters.sessions} session(s)` +
      (t.log
        ? `, ${Math.round(t.log.saved / 1024)} of ${Math.round(t.log.capacity / 1024)} KB of the log used.`
        : ".") +
      (pw
        ? ` Reader password ${pw.hex} recovered into page 1 — write it to the slot to authenticate.`
        : "");
    log(
      `read the trace: ${t.recs.length} records, boot ${t.boot}${pw ? `, recovered reader password into page 1` : ""}`,
    );
    $("resultbox").scrollIntoView({ behavior: "smooth", block: "start" });
  });

// The whole log, raw stream included, so lfia.py can analyse it again. It holds the card's pages and the reader's
// password: keep it private.
function downloadReport() {
  if (!report) return;
  const day = (report.readAt ?? new Date().toISOString()).slice(0, 10);
  saveJson(
    report.log ? `cu-flash-log-${day}.json` : "cu-interactive-trace.json",
    report,
  );
}
$("download").onclick = downloadReport;
// Clearing after a read keeps the next test's results apart from these, and keeps the full-log rule from dropping
// a slot's later presentations. The download comes first, so nothing is lost.
$("downloadclear").onclick = () =>
  run("downloadclear", async () => {
    if (!report) return;
    downloadReport();
    await clearLog();
    $("readinfo").textContent =
      "Downloaded and cleared. The report below stays until you leave the page.";
    $("resultbox").hidden = false;
  });

// ---------------------------------------------------------------- firmware flashing
bindFlashButtons({
  firmware: { test: TEST_FW, stock: STOCK },
  port: () => cu?.port ?? null,
  release: async () => {
    await cu?.close();
    cu = null;
  },
  busy: () => (isBusy() ? "busy, try again in a moment" : null),
  done: () => {
    setState("connect");
    $("connectinfo").textContent = "Flashed. Connect the CU again to continue.";
  },
});

bindCopyButtons();
setState("connect");
showFooter();
hasWebSerial();
