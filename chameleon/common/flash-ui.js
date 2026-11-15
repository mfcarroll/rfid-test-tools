// The Firmware section's controls, shared by the Chameleon pages. bindFlashButtons() puts them in the page's
// <div id="flash">: the page's own firmware's button (flashTest), the others under "Other firmware" (flashStock,
// flashFile), the bootloader button (flashDfu) and a status line (flashinfo).
//   firmware: { test: { zip, name, label }, stock: { zip, name } }. A button shows its entry's label, or
//             "Flash <name>". An entry may instead be a function that returns the firmware ({ name, data } for a file
//             the person picked), or null to cancel. A "file" button with no entry uses pickFile().
//   buttons:  which button flashes which entry, { key: element id }. The default is test, stock and file as above.
//   port():    the connected CU's port, reused so the browser doesn't ask again (or null)
//   release(): close the page's connection to the CU before flashing
//   busy():    a reason not to flash now, or null
//   done(fw):  called after a flash succeeds, with the firmware flashed

import { Flasher, loadFlashLib } from "./cu.js";
import { $, log, hasWebSerial } from "../../common/page.js";

// Asks for a DFU package from the computer through the hidden <input id="fwfile">. Returns { name, data }, or null
// if the person cancels.
export function pickFile() {
  const input = $("fwfile");
  input.value = "";
  const picked = new Promise((resolve) => {
    input.onchange = async () => {
      const f = input.files[0];
      resolve(f ? { name: f.name, data: await f.arrayBuffer() } : null);
    };
    input.oncancel = () => resolve(null);
  });
  input.click();
  return picked;
}

// The button for the page's own firmware (the first in buttons). showFirmware() makes it primary.
let mainButton = null;

function addControls(firmware, buttons) {
  const button = ([key, id]) => {
    const b = document.createElement("button");
    b.id = id;
    const f = firmware[key];
    b.textContent = f?.label ?? (f?.name ? `Flash ${f.name}` : "Flash a file…");
    return b;
  };
  const [first, ...rest] = Object.entries(buttons);
  mainButton = first[1];
  const row = document.createElement("div");
  row.className = "row gap-top";
  const input = document.createElement("input");
  Object.assign(input, { id: "fwfile", type: "file", accept: ".zip" });
  input.hidden = true;
  const dfu = document.createElement("button");
  Object.assign(dfu, { id: "flashDfu", className: "primary", hidden: true });
  dfu.textContent = "Allow the bootloader (first time only)";
  row.append(button(first), input, dfu);
  const more = document.createElement("details");
  more.className = "more";
  const summary = document.createElement("summary");
  summary.textContent = "Other firmware";
  const moreRow = document.createElement("div");
  moreRow.className = "row gap-top";
  moreRow.append(...rest.map(button));
  more.append(summary, moreRow);
  const info = document.createElement("div");
  Object.assign(info, { id: "flashinfo", className: "note gap-top" });
  $("flash").replaceChildren(row, more, info);
}

// Says what firmware the connected CU runs, on the page's #fwinfo line. If needsFlash, the line shows as a warning
// and the page's own firmware button becomes the primary one.
/** @param {string} text @param {boolean} needsFlash */
export function showFirmware(text, needsFlash) {
  $("fwinfo").textContent = text;
  $("fwinfo").classList.toggle("warn", needsFlash);
  if (mainButton) $(mainButton).classList.toggle("primary", needsFlash);
}

/**
 * @param {{
 *   firmware: Record<string, any>,
 *   buttons?: Record<string, string>,
 *   port: () => SerialPort | null,
 *   release: () => Promise<void>,
 *   busy?: () => string | null,
 *   done?: (fw: any) => void,
 * }} opts
 */
export function bindFlashButtons({
  firmware,
  buttons = { test: "flashTest", stock: "flashStock", file: "flashFile" },
  port,
  release,
  busy = () => null,
  done = () => {},
}) {
  addControls(firmware, buttons);
  let flash = null;
  loadFlashLib().catch((e) =>
    log(`couldn't load the flashing library: ${e.message}`),
  );

  const setFlashing = (on, msg) => {
    // the daily firmware page flashes without connecting, so it has no Connect button
    for (const id of [...Object.values(buttons), "connect"])
      if ($(id)) $(id).disabled = on;
    if (msg !== undefined) $("flashinfo").textContent = msg;
  };

  async function start(which) {
    if (!hasWebSerial()) return;
    const why = busy();
    if (why) return log(why);
    const entry = firmware[which] ?? (which === "file" ? pickFile : null);
    const f = typeof entry === "function" ? await entry() : entry;
    if (!f) return;
    if (
      !confirm(
        `Flash ${f.name} to the CU? This replaces its firmware. Keep it plugged in until it's done.`,
      )
    )
      return;
    const known = port();
    setFlashing(true, known ? "starting…" : "pick the CU…");
    await release();
    flash = new Flasher(f, {
      log,
      status: (m) => ($("flashinfo").textContent = m),
    });
    try {
      if (await flash.start(known)) {
        setFlashing(false, `flashed ${f.name}`);
        flash = null;
        done(f);
        return;
      }
      $("flashDfu").hidden = false;
      setFlashing(
        true,
        "the CU restarted in its bootloader: allow it once (it may look the same as the CU in the list)",
      );
    } catch (e) {
      log(`flash failed: ${e.message}`);
      setFlashing(false, "flash failed: see the log");
      flash = null;
    }
  }

  for (const [key, id] of Object.entries(buttons))
    $(id).onclick = () => start(key);
  $("flashDfu").onclick = async () => {
    $("flashDfu").hidden = true;
    try {
      await flash.allowBootloader();
      setFlashing(false, `flashed ${flash.fw.name}`);
      const flashed = flash.fw;
      flash = null;
      done(flashed);
    } catch (e) {
      log(`flash failed: ${e.message}`);
      $("flashDfu").hidden = false;
      setFlashing(true, "select the bootloader port to try again");
    }
  };
}
