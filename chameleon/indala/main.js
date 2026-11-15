// The Indala test page (index.html): connecting the CU, loading the test card, and timing the reads.

import { STATUS_INVALID_CMD } from "../common/cu.js";
import { bindFlashButtons, showFirmware } from "../common/flash-ui.js";
import { openCU } from "../common/session.js";
import { SerialFlipper } from "../../flipper/crystal/flipper.js";
import {
  $,
  log,
  nowS,
  sleep,
  hasWebSerial,
  showState,
  setDisabled,
  oneAtATime,
  bindTabs,
  showFooter,
} from "../../common/page.js";
import * as X from "./indala.js";

const PR = {
  zip: "firmware/pr509-7bba4118-ultra-dfu-app.zip",
  name: "#509 7bba411",
  version: "g7bba411",
};
const STOCK = {
  zip: "../common/firmware/stock-v2.3.0-ultra-dfu-app.zip",
  name: "stock v2.3.0",
};
PR.label = `Flash #509 (${PR.name.replace("#509 ", "")})`;

let cu = null,
  fl = null,
  fw = "",
  stopping = false,
  loaded = null; // the slot the test card went into on this connection
const runs = [];

// Two steps: connect, then test (ready). The results stay visible below the tests once there are any.
const setState = (state) =>
  showState(state, {
    connect: ["current"],
    ready: ["done", "current"],
  });

// The Connect Flipper buttons, one in each step.
const flipperButtons = () =>
  /** @type {NodeListOf<HTMLButtonElement>} */ (
    document.querySelectorAll(".connectFlipper")
  );

// While a test runs, its progress shows under the tabs and the other controls wait.
const CONTROLS = [
  "readTest",
  "emuTest",
  "reconnect",
  "tab-read",
  "tab-emu",
  "flashPr",
  "flashStock",
  "flashFile",
];
function setRunning(on) {
  $("runbox").hidden = !on;
  setDisabled(CONTROLS, on);
  for (const b of flipperButtons()) b.disabled = on;
  if (!on) showReady();
}

const { run, isBusy } = oneAtATime();

const profile = () => X.PROFILES[$("profile").value] ?? null;

// ---------------------------------------------------------------- results

function showResults() {
  const { head, rows } = X.table(runs, $("showfp").checked);
  const tr = (cells, tag) => {
    const row = document.createElement("tr");
    for (const c of cells) {
      const cell = document.createElement(tag);
      cell.textContent = c;
      row.append(cell);
    }
    return row;
  };
  $("resulthead").replaceChildren(tr(head, "th"));
  $("resultrows").replaceChildren(...rows.map((r) => tr(r, "td")));
  $("resultbox").hidden = !runs.length;
}

$("copyResults").onclick = async () => {
  const button = $("copyResults");
  const md = X.markdown(runs, $("showfp").checked);
  try {
    await navigator.clipboard.writeText(md);
    button.textContent = "Copied";
  } catch {
    // no clipboard access: show the Markdown in the log to copy by hand
    log(`results:\n${md}`);
    button.textContent = "See the log";
  }
  setTimeout(() => (button.textContent = "Copy"), 1500);
};

$("showfp").onchange = showResults;
$("fpwhat").onclick = () => {
  const info = $("fpinfo");
  info.hidden = !info.hidden;
  $("fpwhat").setAttribute("aria-expanded", String(!info.hidden));
};
$("clear").onclick = () => {
  runs.length = 0;
  showResults();
};

// Progress while a test runs: what it's doing, read i of n, and the last result.
function progress(phase, i, n, last) {
  $("phase").textContent = phase;
  $("count").textContent = `read ${i} of ${n}`;
  $("progress").style.width = `${(100 * i) / n}%`;
  if (last !== undefined) $("last").textContent = last;
}
$("stop").onclick = () => {
  stopping = true;
  $("stop").disabled = true;
};

// Runs one test, with its progress showing, and puts the controls back whatever happens.
async function test(what, fn) {
  if (isBusy()) return;
  stopping = false;
  $("stop").disabled = false;
  $("last").textContent = "–";
  setRunning(true);
  await run(what, fn);
  setRunning(false);
  showResults();
}

// ---------------------------------------------------------------- connect and firmware

// #509's firmware answers its frame command (5027) with a status of some kind. Firmware without it answers
// "invalid command".
async function detectProfile() {
  const r = await cu.cmd(X.PROFILES.pr509.getEmu);
  if (r.status !== STATUS_INVALID_CMD) return "pr509";
  return /nieldk|v2\.4/i.test(fw) ? "nieldk" : "";
}

async function showSlots() {
  const r = await cu.ok(X.CMD.GET_SLOT_INFO);
  const slots = X.parseSlotInfo(r.data);
  const keep = $("slot").value;
  $("slot").innerHTML = slots
    .map((s, i) => `<option value="${i}">${i + 1}: ${X.lfName(s.lf)}</option>`)
    .join("");
  // default: a slot that already holds the test card's type, else the last slot
  const p = profile();
  const mine = slots.findIndex((s) => p && s.lf === p.type);
  $("slot").value = keep || String(mine >= 0 ? mine : slots.length - 1);
}

function showReady() {
  const p = profile();
  $("readTest").disabled = !p;
  $("emuTest").disabled = !(p && fl);
  $("emuinfo").textContent = !fl
    ? "Connect a Flipper Zero above to run this test."
    : "";
}

const connectCU = () =>
  run("connect", async () => {
    try {
      cu = await openCU(cu);
      if (!cu) return;
      fw = await cu.version();
    } catch (e) {
      $("connectinfo").textContent = `Couldn't connect: ${e.message}`;
      $("fwinfo").textContent = `Couldn't connect: ${e.message}`;
      throw e;
    }
    log(`CU connected, firmware ${fw}`);
    loaded = null;
    const p = await detectProfile();
    $("profile").value = p;
    const old = p === "pr509" && !fw.includes(PR.version);
    showFirmware(
      p
        ? `Firmware ${fw}.` +
            (old
              ? ` This isn't #509's current build (${PR.name.replace("#509 ", "")}). To test that build, use Flash #509 below.`
              : "")
        : `Firmware ${fw} has no Indala commands this page knows. Flash #509 below, then connect again.`,
      !p || old,
    );
    $("connectinfo").textContent = "";
    await showSlots();
    showReady();
    $("connectinfo").textContent = "Connected";
    $("continue").hidden = false;
    // back from a flash, or with the Flipper already connected: no reason to stop here
    if (runs.length || fl) setState("ready");
  });

$("connect").onclick = connectCU;
$("reconnect").onclick = connectCU;
$("continue").onclick = () => setState("ready");

$("profile").onchange = () => {
  loaded = null;
  showReady();
  if (cu) run("slots", showSlots);
};

// The file input has to open from the click itself, so this returns a promise that its change event settles.
bindFlashButtons({
  firmware: { pr: PR, stock: STOCK },
  buttons: { pr: "flashPr", stock: "flashStock", file: "flashFile" },
  port: () => cu?.port ?? null,
  release: async () => {
    await cu?.close();
    cu = null;
  },
  busy: () => (isBusy() ? "wait for the current test to finish" : null),
  done: (f) => {
    $("connectinfo").textContent = `Flashed ${f.name}. Connect again.`;
    $("continue").hidden = true;
    $("profile").value = "";
    setState("connect");
  },
});

// ---------------------------------------------------------------- read test

$("readTest").onclick = () =>
  test("read test", async () => {
    const n = Number($("nread").value);
    const r = {
      firmware: fw,
      test: `read: ${$("what").value}`,
      tries: [],
    };
    runs.push(r);
    await cu.ok(X.CMD.CHANGE_DEVICE_MODE, X.reqMode(true));
    try {
      for (let i = 0; i < n && !stopping; i++) {
        progress("Reading the card", i, n);
        const a = await cu.cmd(X.CMD.INDALA_SCAN, undefined, 8);
        // X.table() decides which reads are wrong, from every run with the same card label
        const t = { s: null, fp: null };
        if (a.status === X.STATUS_LF_TAG_OK) {
          t.s = a.ta - a.tb;
          t.fp = await X.fingerprint(a.data);
        } else if (a.status !== X.STATUS_LF_TAG_NO_FOUND)
          throw new Error(`scan returned status 0x${a.status.toString(16)}`);
        r.tries.push(t);
        const line = t.fp
          ? `read ${i + 1}: ${t.s.toFixed(2)} s, fingerprint ${t.fp}`
          : `read ${i + 1}: no card found`;
        log(line);
        progress("Reading the card", i + 1, n, line);
        showResults();
      }
    } finally {
      await cu.ok(X.CMD.CHANGE_DEVICE_MODE, X.reqMode(false));
    }
  });

// ---------------------------------------------------------------- emulation test

// Load the test card into the chosen slot, unless this connection already did. Returns false if the person
// cancels.
async function loadTestCard() {
  const p = profile();
  const s = Number($("slot").value);
  await cu.ok(X.CMD.CHANGE_DEVICE_MODE, X.reqMode(false));
  if (loaded === s) return true;
  if (
    !confirm(
      `Replace slot ${s + 1}'s LF card with the Indala test card (FC 123, card 1337)?`,
    )
  )
    return false;
  await cu.ok(X.CMD.SET_SLOT_TAG_TYPE, X.reqSlotType(s, p.type));
  await cu.ok(X.CMD.SET_SLOT_DATA_DEFAULT, X.reqSlotType(s, p.type));
  await cu.ok(X.CMD.SET_ACTIVE_SLOT, X.reqSlot(s));
  await cu.ok(p.setEmu, X.TEST_FRAME);
  await cu.ok(X.CMD.SET_SLOT_ENABLE, X.reqEnableLf(s));
  await cu.ok(X.CMD.SET_SLOT_TAG_NICK, X.reqNickLf(s, X.TEST_NICK));
  await cu.ok(X.CMD.SLOT_DATA_CONFIG_SAVE, undefined, 10);
  log(`slot ${s + 1}: Indala test card loaded, slot active`);
  loaded = s;
  await showSlots();
  return true;
}

// The Flipper's status shows in both steps.
const flipperInfo = (text) => {
  for (const el of document.querySelectorAll(".flipperinfo"))
    el.textContent = text;
};
const connectFlipper = () =>
  run("connect Flipper", async () => {
    if (!hasWebSerial()) return;
    try {
      const port = await navigator.serial.requestPort();
      await fl?.close();
      fl = new SerialFlipper(nowS);
      await fl.open(port);
    } catch (e) {
      flipperInfo(`Couldn't connect: ${e.message}`);
      fl = null;
      showReady();
      throw e;
    }
    const info = await fl.deviceInfo();
    const name = info["hardware.name"] ?? "Flipper";
    const fork = info["firmware.origin.fork"] ?? "";
    const app = await fl.runningApp();
    flipperInfo(
      `${name}, ${fork} ${info["firmware.version"] ?? ""}` +
        (app ? `. Exit ${app} on the Flipper first.` : ""),
    );
    for (const b of flipperButtons()) b.textContent = "Reconnect";
    log(`Flipper connected: ${name}, ${fork}`);
    showReady();
  });
for (const b of flipperButtons()) b.onclick = connectFlipper;

$("emuTest").onclick = () =>
  test("emulation test", async () => {
    const app = await fl.runningApp();
    if (app) throw new Error(`exit ${app} on the Flipper first`);
    const n = Number($("nemu").value),
      limit = Number($("emutimeout").value);
    progress("Loading the test card", 0, n);
    if (!(await loadTestCard())) return;
    const r = {
      firmware: fw,
      test: "emulate to a Flipper",
      card: X.TEST_CARD_LABEL,
      tries: [],
    };
    runs.push(r);
    for (let i = 0; i < n && !stopping; i++) {
      progress("The Flipper is reading the CU", i, n);
      const d = await fl.rfidRead("indala", limit);
      const t = {
        s: d.s,
        ok: d.s !== null && X.isTestDecode(d),
        wrong: d.s !== null && !X.isTestDecode(d),
        fp: null,
      };
      r.tries.push(t);
      const line =
        `Flipper read ${i + 1}: ` +
        (d.s === null
          ? `nothing in ${limit} s`
          : `${d.s.toFixed(2)} s, ${d.protocol} ${d.info.join(", ")}`);
      log(line);
      progress("The Flipper is reading the CU", i + 1, n, line);
      showResults();
      await sleep(1); // the Flipper's field off between reads
    }
  });

bindTabs();
setState("connect");
showFooter();
