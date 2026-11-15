// The Proxmark3 crystal offset page (index.html): connecting the PM3, checking its firmware, and the measurement run.

import * as P from "./pm3.js";
import {
  $,
  nowS,
  log,
  hasWebSerial,
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

let pm3 = null,
  ticks = null,
  counter = false, // the connected firmware has CMD_HW_TICKS
  running = false;

// The page shows one step of the flow at a time: connect, ready, run or done.
function setState(state) {
  $("app").dataset.state = state;
  const steps = {
    connect: ["current", "", ""],
    ready: ["done", "current", ""],
    run: ["done", "current", ""],
    done: ["done", "done", "done"],
  }[state];
  ["step-connect", "step-measure", "step-result"].forEach(
    (id, i) => ($(id).className = steps[i]),
  );
  setButtons();
}

function setButtons() {
  $("start").disabled = running || !pm3 || !counter;
}

// ---------------------------------------------------------------- connect and firmware

// A READ of CMD_HW_TICKS changes nothing, and only the test firmware answers it.
async function checkFirmware(version) {
  counter = await ticks.read().then(
    () => true,
    (e) => (log(`firmware check: ${e.message}`), false),
  );
  $("fwinfo").textContent = counter
    ? `Firmware ${version}, with the tick counter.`
    : `Firmware ${version} can't count the crystal's ticks. Flash the test firmware below.`;
  $("start").className = counter ? "primary" : "";
}

// Reuse the PM3 port this page was allowed before. With none, or more than one, the browser asks.
async function pickPort() {
  const known = (await navigator.serial.getPorts()).filter((p) => {
    const i = p.getInfo();
    return (
      i.usbVendorId === P.USB.usbVendorId &&
      i.usbProductId === P.USB.usbProductId
    );
  });
  return known.length === 1
    ? known[0]
    : navigator.serial.requestPort({ filters: [P.USB] });
}

$("connect").onclick = async () => {
  if (!hasWebSerial()) {
    $("connectinfo").textContent =
      "This browser can't reach USB devices. Use Chrome or Edge on a computer.";
    return;
  }
  try {
    const port = await pickPort();
    await pm3?.close();
    pm3 = new P.SerialPM3({ onDebug: (text) => log(`PM3: ${text}`) });
    await pm3.open(port);
    ticks = new P.Ticks(pm3);
    const version = (await pm3.version()).os;
    $("devinfo").textContent = "Proxmark3";
    log(`connected, firmware ${version}`);
    await checkFirmware(version);
    setState("ready");
  } catch (e) {
    log(`connect failed: ${e.message}`);
    $("connectinfo").textContent = /open|busy|access/i.test(e.message)
      ? `Couldn't open the PM3. Is the pm3 client still running? (${e.message})`
      : `Couldn't connect: ${e.message}`;
    await pm3?.close();
    pm3 = null;
  }
};

// ---------------------------------------------------------------- the run

// Another command that starts or stops the tick counter resets or stops the count. A read whose count moved
// more than 1 s away from the local clock's elapsed time means such a command ran.
let prev = null;
const device = {
  start: async () => (prev = await ticks.start()),
  read: async () => {
    const p = await ticks.read();
    const dt = (p.tb + p.ta) / 2 - (prev.tb + prev.ta) / 2;
    if (Math.abs((p.ticks - prev.ticks) / P.NOMINAL - dt) > 1)
      throw new Error(
        `the tick count jumped ${((p.ticks - prev.ticks) / P.NOMINAL - dt).toFixed(1)} s. The PM3 reset or ran another command.`,
      );
    return (prev = p);
  },
  stop: () => ticks.stop(),
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
  const firmware = (await pm3.version()).os;
  const run = newRun({
    minutes,
    burstN,
    nominal: P.NOMINAL,
    device: "PM3",
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
    "Keep this tab open in the foreground with the computer awake, stay on the same network, and leave the PM3's button alone.";
  setState(pm3 ? "ready" : "connect");
};

// a plot hidden while its section was closed draws at its real size once it opens
$("details").addEventListener(
  "toggle",
  () => $("details").open && redrawPlots(),
);

bindTabs();
bindCopyButtons();
bindRunControls("pm3-crystal");
setState("connect");
showSiteCommit($("siteversion"));
