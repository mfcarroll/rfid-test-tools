// The crystal offset page (index.html): connecting the CU, checking its firmware, and the measurement run.

import * as H from "./hfxo.js";
import { bindFlashButtons } from "../common/flash-ui.js";
import { openCU } from "../common/session.js";
import {
  $,
  nowS,
  log,
  showState,
  bindTabs,
  bindCopyButtons,
  showSiteCommit,
} from "../../common/page.js";
import {
  newRun,
  measure,
  bindRunControls,
  currentRun,
  stopNotice,
  redrawPlots,
} from "../../common/timerun.js";

const FIRMWARE = {
  test: {
    zip: "firmware/hfxo-count-4e494589-ultra-dfu-app.zip",
    name: "test firmware (hfxo-count 4e494589)",
  },
  stock: {
    zip: "../common/firmware/stock-v2.3.0-ultra-dfu-app.zip",
    name: "stock v2.3.0",
  },
};
// The test firmware's commit, on its flash button
$("fwname").textContent = FIRMWARE.test.name.match(/([0-9a-f]{7,8})\)$/)[1];

let cu = null,
  counter = false, // the connected firmware has command 3125
  running = false;

// The page shows one step of the flow at a time: connect, ready, run or done.
function setState(state) {
  showState(state, {
    connect: ["current"],
    ready: ["done", "current"],
    run: ["done", "current"],
    done: ["done", "done", "done"],
  });
  setButtons();
}

function setButtons() {
  $("start").disabled = running || !cu || !counter;
}

// ---------------------------------------------------------------- connect and firmware

// A READ of command 3125 only reports the counter: it works on this test firmware and the FSK self-trim one.
async function checkFirmware(version) {
  counter = await H.hfxoCount(cu, H.READ).then(
    () => true,
    () => false,
  );
  $("fwinfo").textContent = counter
    ? `Firmware ${version}, with the crystal tick counter.`
    : `Firmware ${version} can't count the crystal's ticks. Flash the test firmware below.`;
  $("flashTest").className = counter ? "" : "primary";
  $("start").className = counter ? "primary" : "";
}

$("connect").onclick = async () => {
  try {
    cu = await openCU(cu);
    if (!cu) return;
    const version = await cu.version();
    log(`connected, firmware ${version}`);
    await checkFirmware(version);
    setState("ready");
  } catch (e) {
    log(`connect failed: ${e.message}`);
    $("connectinfo").textContent = `Couldn't connect: ${e.message}`;
  }
};

bindFlashButtons({
  firmware: FIRMWARE,
  port: () => cu?.port ?? null,
  release: async () => {
    await cu?.close();
    cu = null;
    counter = false;
  },
  busy: () => (running ? "finish or stop the run before flashing" : null),
  done: (fw) => {
    $("connectinfo").textContent =
      `Flashed ${fw.name}. Connect again to continue.`;
    setState("connect");
  },
});

// ---------------------------------------------------------------- the run

// The CU's tick counter (command 3125). A lapse means the crystal was released, so the rate is invalid.
const device = {
  start: () => H.hfxoCount(cu, H.START),
  read: async () => {
    const p = await H.hfxoCount(cu, H.READ);
    if (!p.running) throw new Error("counter not running (CU reset?)");
    if (p.lapses)
      throw new Error(
        `HFXO lapsed ${p.lapses}x: the count rate is invalid, re-run with no LF activity`,
      );
    return p;
  },
  stop: () => H.hfxoCount(cu, H.STOP),
};

// the progress bar, every second alongside the shared Elapsed figure
setInterval(() => {
  const run = currentRun();
  if (!running || !run) return;
  const done = Math.min(100, ((nowS() - run.t0) / (run.minutes * 60)) * 100);
  $("progress").style.width = `${done}%`;
  document
    .querySelector(".bar")
    .setAttribute("aria-valuenow", String(Math.round(done)));
}, 1000);

$("start").onclick = async () => {
  const minutes = Number($("minutes").value);
  const burstN = Math.max(20, Number($("burst").value) | 0);
  const firmware = await cu.version();
  const run = newRun({
    minutes,
    burstN,
    nominal: H.NOMINAL,
    device: "CU",
    firmware,
  });
  log(
    `run ${run.id}: ${minutes} min, bursts of ${burstN}, firmware ${firmware}`,
  );
  $("progress").style.width = "0";
  running = true;
  setState("run");
  $("details").hidden = false;
  $("details").open = true;
  const r = await measure(device);
  running = false;
  if (!r) {
    $("notice").textContent = stopNotice();
    setState("ready");
    return;
  }
  $("doneinfo").textContent = r.suspect
    ? "The network check failed. Run it again."
    : "Measured";
  $("doneinfo").className = `small ${r.suspect ? "warn" : "ok"}`;
  setState("done");
};

$("again").onclick = () => {
  $("notice").textContent =
    "Keep this tab open in the foreground with the computer awake, stay on the same network, and keep the CU away from readers.";
  setState(cu ? "ready" : "connect");
};

// a plot hidden while its section was closed draws at its real size once it opens
$("details").addEventListener(
  "toggle",
  () => $("details").open && redrawPlots(),
);

bindTabs();
bindCopyButtons();
bindRunControls("cu-crystal");
setState("connect");
showSiteCommit($("siteversion"));
