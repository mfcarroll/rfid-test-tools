// The Flipper crystal calibration page (index.html): connecting the Flipper, the measurement run, and saving the correction.

import {
  SerialFlipper,
  NOMINAL,
  CAL_LIMIT,
  APP_PATH,
  pickBuild,
} from "./flipper.js";
import {
  $,
  fmt,
  fmtPm,
  log,
  nowS,
  hasWebSerial,
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

const TEMPERATURE_EVERY = 16; // s between temperature readings
const PPM_PER_DEGREE = 0.25; // the crystal's shift per °C, measured on one Flipper
const TEMPERATURE_LIMIT = 3; // °C change during a run (about 0.75 ppm), above which the result isn't saved
const CAL_PATH = "/ext/apps_data/nfc_rfid_detector/lf_cal_ppm10.txt";

let fl = null,
  info = null,
  builds = [],
  build = null,
  running = false;

// The page shows one step of the flow at a time: connect, ready, run or done.
function setState(state) {
  const saved = currentRun()?.saved !== undefined;
  showState(state, {
    connect: ["current"],
    ready: ["done", "current"],
    run: ["done", "current"],
    done: ["done", "done", saved ? "done" : "current"],
  });
  setButtons();
}

function setButtons() {
  const run = currentRun(),
    r = run?.result;
  $("start").disabled = running || !fl;
  $("install").disabled = running || !build;
  // a result that failed a check can still be saved by hand
  $("send").hidden =
    running ||
    !(r?.suspect || run?.unsteady) ||
    run.saved !== undefined ||
    Math.abs(r.ppm) > CAL_LIMIT;
}

// ---------------------------------------------------------------- connect and install

// What's on the Flipper now: whether the app is installed, and the calibration it has saved.
async function checkFlipper() {
  const stat = await fl.cli(`storage stat ${APP_PATH}`).catch(() => "");
  const installed = /size/i.test(stat) && !/error/i.test(stat);
  // a build this page made is known by its MD5; another build's version can't be read without opening it
  const md5 = installed
    ? ((await fl.cli(`storage md5 ${APP_PATH}`).catch(() => "")).match(
        /[0-9a-f]{32}/,
      )?.[0] ?? "")
    : "";
  const known = builds.find((b) => b.md5 && b.md5 === md5);
  const saved = (
    await fl.cli(`storage read ${CAL_PATH}`).catch(() => "")
  ).match(/^\s*(-?\d+)(?:\s+(\d+))?\s*$/m);
  let cal = "Not calibrated yet.";
  if (saved) {
    const value = Number(saved[1]) / 10;
    cal = `Current calibration: ${saved[2] ? fmtPm(value, Number(saved[2]) / 10) : `${fmt(value, 1)} ppm`}`;
  }
  $("appinfo").textContent = !installed
    ? "The RFID detector app isn't installed yet."
    : `RFID detector app ${known ? `version ${known.version} (${known.source}) ` : ""}installed. ${cal}`;
  $("install").textContent = installed ? "Update app" : "Install app";
  $("install").className = installed ? "" : "primary";
  $("start").className = installed ? "primary" : "";
}

$("connect").onclick = async () => {
  if (!hasWebSerial()) return;
  try {
    const port = await navigator.serial.requestPort();
    await fl?.close();
    fl = new SerialFlipper(nowS);
    await fl.open(port);
    info = await fl.deviceInfo();
    const fw = `${info["firmware.origin.fork"] ?? "?"} ${info["firmware.version"] ?? "?"}`;
    $("devinfo").textContent = `${info["hardware.name"] ?? "Flipper"} · ${fw}`;
    const commit = `${info["firmware.commit.hash"] ?? "?"}${info["firmware.commit.dirty"] === "true" ? "-dirty" : ""}`;
    log(
      `connected: ${fw} (${commit}), API ${info["firmware.api.major"]}.${info["firmware.api.minor"]}`,
    );
    builds = await fetch("apps/manifest.json", { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => []);
    build = pickBuild(builds, info);
    if (!build) {
      $("installinfo").hidden = false;
      $("installinfo").textContent =
        "There's no build here for this firmware. Update it to the latest release, then connect again.";
    }
    await checkFlipper();
    setState("ready");
  } catch (e) {
    log(`connect failed: ${e.message}`);
    $("connectinfo").textContent = `Couldn't connect: ${e.message}`;
  }
};

$("install").onclick = async () => {
  if (!fl || !build) return;
  running = true;
  setButtons();
  $("installinfo").hidden = false;
  try {
    const bytes = new Uint8Array(
      await (
        await fetch(`apps/${build.file}`, { cache: "no-cache" })
      ).arrayBuffer(),
    );
    // Not `loader close`: older versions of the app leave hardware running when closed that way.
    const open = await fl.runningApp();
    if (open)
      throw new Error(
        `exit "${open}" on the Flipper first (Back until the main screen), then install again`,
      );
    log(
      `installing ${build.file}, app ${build.version} (${build.source}), ${bytes.length} bytes, to ${APP_PATH}`,
    );
    await fl.cli("storage mkdir /ext/apps/Tools").catch(() => {});
    await fl.writeFile(
      APP_PATH,
      bytes,
      (p) =>
        ($("installinfo").textContent = `Installing: ${Math.floor(p * 100)} %`),
    );
    await fl.openApp();
    $("installinfo").textContent =
      `Installed app ${build.version} (${build.source}). It's open on its calibration screen.`;
    log("installed and opened");
    await checkFlipper();
  } catch (e) {
    log(`install failed: ${e.message}`);
    $("installinfo").textContent = `Install failed: ${e.message}`;
  }
  running = false;
  setButtons();
};

// ---------------------------------------------------------------- the run

const checked = (p) => {
  if (!p.pll)
    throw new Error("the Flipper's clock left the crystal (it slept?): re-run");
  return p;
};

// The app's calibration session. It stays open after the run, so the result can be saved over it.
const device = {
  start: async () => {
    const run = currentRun();
    run.before = await fl.calStart();
    $("saved").textContent = `${fmt(run.before, 1)} ppm`;
    log(
      `run ${run.id}: ${run.minutes} min, bursts of ${run.burstN}; the app's calibration is ${fmt(run.before, 1)} ppm`,
    );
    return checked(await fl.calRead());
  },
  read: async () => checked(await fl.calRead()),
  stop: async () => {},
};

// progress for the Flipper's status screen after every read, with the estimate once it has settled
async function onRead(run, t) {
  await fl.calProgress(
    t - run.t0,
    run.minutes * 60,
    run.estimate?.settled ? run.estimate : null,
  );
  // the crystal shifts by about 0.25 ppm per °C, so the run records the temperature
  run.temps ??= [];
  if (!run.temps.length || t - run.temps.at(-1)[0] >= TEMPERATURE_EVERY) {
    run.temps.push([t, await fl.calTemperature()]);
    $("temp").textContent = `${run.temps.at(-1)[1].toFixed(1)} °C`;
  }
}

// After a run: the temperature range, and a warning if it changed enough to move the result. An unsteady run
// isn't saved automatically.
function showTemperature(run) {
  const c = (run.temps ?? []).map(([, celsius]) => celsius);
  if (!c.length) return;
  const change = Math.max(...c) - Math.min(...c);
  run.unsteady = change > TEMPERATURE_LIMIT;
  log(
    `  Flipper temperature ${c[0].toFixed(1)} → ${c.at(-1).toFixed(1)} °C, range ${Math.min(...c).toFixed(1)}–${Math.max(...c).toFixed(1)}` +
      (run.unsteady
        ? `: ⚠ changed by ${change.toFixed(1)} °C (more than ${TEMPERATURE_LIMIT}). Not saved automatically`
        : ""),
  );
  $("temp").textContent = `${c[0].toFixed(1)} → ${c.at(-1).toFixed(1)} °C`;
  $("tempwarn").hidden = !run.unsteady;
  $("tempwarn").textContent =
    `The Flipper's temperature changed by ${change.toFixed(1)} °C during the run, which can move the result ` +
    `by about ${(change * PPM_PER_DEGREE).toFixed(1)} ppm.`;
}

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

function showSaved(text, kind) {
  $("sendinfo").textContent = text;
  $("sendinfo").className = `small ${kind}`;
}

async function save(ppm, sig) {
  try {
    await fl.calSend(ppm, sig);
    currentRun().saved = ppm;
    showSaved("Saved on your Flipper", "ok");
    log(`saved ${fmtPm(ppm, sig)} on the Flipper`);
  } catch (e) {
    showSaved(`Not saved: ${e.message}`, "bad");
    log(`saving on the Flipper failed: ${e.message}`);
  }
  setState("done");
}

$("start").onclick = async () => {
  await fl.calStop().catch(() => {});
  newRun({
    minutes: Number($("minutes").value),
    burstN: Math.max(20, Number($("burst").value) | 0),
    nominal: NOMINAL,
    probeEvery: 20,
    device: "Flipper",
    firmware: info,
  });
  $("saved").textContent = "–";
  $("temp").textContent = "–";
  $("tempwarn").hidden = true;
  $("progress").style.width = "0";
  running = true;
  setState("run");
  $("details").hidden = false;
  $("details").open = true;
  const r = await measure(device, { onRead });
  running = false;
  showTemperature(currentRun());
  if (!r) {
    $("notice").textContent = stopNotice();
    setState("ready");
  } else if (Math.abs(r.ppm) > CAL_LIMIT) {
    showSaved(
      `Not saved: ${fmt(r.ppm, 1)} ppm is beyond the app's ±${CAL_LIMIT}`,
      "bad",
    );
    setState("done");
  } else if (r.suspect) {
    showSaved(
      "Not saved: the network check failed. Run it again, or save it anyway.",
      "warn",
    );
    setState("done");
  } else if (currentRun().unsteady) {
    showSaved(
      "Not saved: the Flipper's temperature changed. Run it again once its temperature is steady, or save it anyway.",
      "warn",
    );
    setState("done");
  } else await save(r.ppm, r.sig);
};

$("send").onclick = () => {
  const r = currentRun()?.result;
  if (r) {
    $("send").hidden = true;
    save(r.ppm, r.sig);
  }
};

$("again").onclick = async () => {
  $("notice").textContent =
    "Keep this tab open in the foreground with the computer awake, and stay on the same network.";
  if (fl) await checkFlipper().catch(() => {});
  setState("ready");
};

// a plot hidden while its section was closed draws at its real size once it opens
$("details").addEventListener(
  "toggle",
  () => $("details").open && redrawPlots(),
);

bindTabs();
bindCopyButtons();
showSiteCommit($("sitecommit"));
bindRunControls("flipper-crystal");
setState("connect");
