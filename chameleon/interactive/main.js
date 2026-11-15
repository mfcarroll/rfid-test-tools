// The interactive LF emulation page (index.html): connecting the CU, the Hitag 2 test tag, and reading its trace.

import { bindFlashButtons } from "../common/flash-ui.js";
import { openCU, watchDisconnect } from "../common/session.js";
import {
  $,
  log,
  hasWebSerial,
  showState,
  setDisabled,
  oneAtATime,
  bindCopyButtons,
  saveJson,
  showSiteCommit,
} from "../../common/page.js";
import * as P from "./interactive.js";

const TEST_FW = {
  zip: "firmware/lf-interactive-bcf166a8-ultra-dfu-app.zip",
  name: "experimental bcf166a8",
};
const STOCK = {
  zip: "../common/firmware/stock-v2.3.0-ultra-dfu-app.zip",
  name: "stock v2.3.0",
};
TEST_FW.label = `Flash the experimental firmware (${TEST_FW.name.replace("experimental ", "")})`;
for (let s = 0; s < 8; s++) $("slot").append(new Option(`slot ${s + 1}`, s));

let cu = null,
  has = false, // the firmware has the interactive engine
  firmware = "",
  report = null;

const setState = (state) =>
  showState(state, {
    connect: ["current"],
    ready: ["done", "current"],
  });
const CONTROLS = [
  "slot",
  "setup",
  "scan",
  "readtag",
  "clear",
  "read",
  "reconnect",
  "flashTest",
  "flashStock",
  "flashFile",
];
const { run, isBusy } = oneAtATime((on) => setDisabled(CONTROLS, on));
const need = () => {
  if (!has) throw new Error("this firmware has no interactive LF engine");
};

// ---------------------------------------------------------------- connect and firmware
async function checkFirmware() {
  const fw = await cu.version();
  // The engine's counters command is the probe: a firmware without it answers "invalid command".
  const r = await cu.cmd(P.CMD.LF_IA_TUNING);
  has = r.status === P.STATUS.SUCCESS;
  $("fwinfo").textContent =
    `CU on ${fw}: ` +
    (has ? "has the interactive LF engine" : "no interactive LF engine");
  $("fwneed").hidden = has;
  log(`connected: ${fw}, interactive engine ${has ? "yes" : "no"}`);
  return fw;
}
const connectCU = () =>
  run("connect", async () => {
    cu = await openCU(cu);
    if (!cu) return;
    firmware = await checkFirmware();
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
    setState("connect");
  },
);

// ---------------------------------------------------------------- the tag's details
// A blank field uses its placeholder (the default shown greyed), so the defaults still write without being typed.
const fv = (id) => $(id).value.trim() || $(id).placeholder;
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
// Fills every editable field from a read. The config byte is fixed, so it is left alone.
function fillFields(f) {
  for (const k of ["p0", "p1", "p2", "p4", "p5", "p6", "p7"]) $(k).value = f[k];
  $("p3tagpw").value = f.tagpw;
  // Show the tag's real config byte, even though it is normally fixed at 06. The emulation ignores it and always
  // runs password mode, so a non-06 value is informational.
  $("p3config").value = f.config;
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
// the slot keeps emulating.
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

$("scan").onclick = () =>
  run("scan", async () => {
    need();
    setScan("Hold a tag to the CU…");
    const r = await inReaderMode(() => cu.cmd(P.CMD.HITAG2_SCAN));
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
    setScan("Hold a tag to the CU…");
    const r = await inReaderMode(() =>
      cu.cmd(P.CMD.HITAG2_READ, P.reqHitag2Read(pw)),
    );
    if (r.status === P.STATUS.MF_ERR_AUTH) {
      setScan("The tag did not accept the password.", "bad");
      return;
    }
    const read =
      (r.status === P.STATUS.LF_TAG_OK ||
        r.status === P.STATUS.LF_TAG_NO_FOUND) &&
      P.parseHitag2Read(r.data);
    if (!read) {
      setScan("No Hitag 2 tag found.", "bad");
      return;
    }
    const pages = P.pagesFromRead(read);
    fillFields(P.fieldsFromPages(pages));
    const partial = r.status === P.STATUS.LF_TAG_NO_FOUND;
    const cfg = P.describeConfig(pages);
    const cfgNote =
      cfg.byte === 0x06
        ? ""
        : ` Config is 0x${cfg.byte.toString(16).padStart(2, "0")} (${cfg.mode} mode); the emulation runs password mode regardless.`;
    setScan(
      `Read ${read.count}/8 pages into the fields${partial ? " (some pages unread)" : ""}. Review, then write it to the slot.${cfgNote}`,
      partial ? "warn" : "ok",
    );
    log(
      `read a Hitag 2 tag, ${read.count}/8 pages, UID ${P.uidOf(P.pagesFromRead(read))}`,
    );
  });

// ---------------------------------------------------------------- write the tag to the slot
$("setup").onclick = () =>
  run("set up", async () => {
    need();
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
  });

$("clear").onclick = () =>
  run("clear", async () => {
    need();
    await cu.ok(P.CMD.LF_IA_TRACE_CLEAR);
    $("clearinfo").textContent =
      "Trace cleared. Unplug the CU and hold it to the reader.";
    $("resultbox").hidden = true;
    log("trace cleared");
  });

// ---------------------------------------------------------------- read the trace
// One trace-read batch is up to 14 records (~3.9 KB) in a single reply — far larger than the other replies. Give
// it a longer timeout and retry a couple of times, so a slow or dropped large reply does not fail the whole read.
async function traceBatch(first) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await cu.ok(P.CMD.LF_IA_TRACE_READ, P.reqTraceRead(first), 8);
    } catch (e) {
      lastErr = e;
      log(`trace read from ${first}: attempt ${attempt} ${e.message}`);
    }
  }
  throw lastErr;
}
async function readTrace() {
  const recs = [];
  let total = 0,
    keep = P.TRACE_KEEP,
    boot = 0;
  for (;;) {
    const r = await traceBatch(recs.length);
    const part = P.parseTraceReply(r.data);
    if (part.size !== P.REC_SIZE)
      throw new Error(
        `trace record size ${part.size}, this page reads ${P.REC_SIZE}: firmware and page differ`,
      );
    ({ total, keep, boot } = part);
    if (part.n === 0) break;
    recs.push(...part.recs);
    if (recs.length >= total) break;
  }
  return { total, keep, boot, recs };
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
    const t = await readTrace();
    report = { firmware, counters, emu, ...t };
    $("safe").textContent = P.safeMarkdown(report);
    $("private").textContent = P.privateMarkdown(report);
    $("resultbox").hidden = false;
    // If the reader's password turned up in the trace (repeated attempts that agree), put it in page 1 so the
    // tag can authenticate on the next visit.
    const pw = P.recoverPassword(t.recs);
    if (pw) {
      $("p1").value = pw.hex;
      updateAscii();
    }
    $("readinfo").textContent =
      `${t.recs.length} record(s) over ${counters.sessions} session(s).` +
      (pw
        ? ` Reader password ${pw.hex} recovered into page 1 — write it to the slot to authenticate.`
        : "");
    log(
      `read the trace: ${t.recs.length} records, boot ${t.boot}${pw ? `, recovered reader password into page 1` : ""}`,
    );
    $("resultbox").scrollIntoView({ behavior: "smooth", block: "start" });
  });

$("download").onclick = () => {
  if (report) saveJson("cu-interactive-trace.json", report);
};

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
showSiteCommit($("siteversion"));
hasWebSerial();
