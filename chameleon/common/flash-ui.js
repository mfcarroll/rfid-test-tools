// The Firmware section's buttons (flashTest, flashStock, flashDfu, flashinfo), shared by the Chameleon pages.
//   firmware: { test: { zip, name }, stock: { zip, name } }. An entry may instead be a function that returns the
//             firmware ({ name, data } for a file the person picked), or null to cancel.
//   buttons:  which button flashes which entry, { key: element id }. The default is test and stock as above.
//   port():    the connected CU's port, reused so the browser doesn't ask again (or null)
//   release(): close the page's connection to the CU before flashing
//   busy():    a reason not to flash now, or null
//   done(fw):  called after a flash succeeds, with the firmware flashed

import { Flasher, loadFlashLib } from "./cu.js";
import { $, log, hasWebSerial } from "../../common/page.js";

export function bindFlashButtons({
  firmware,
  buttons = { test: "flashTest", stock: "flashStock" },
  port,
  release,
  busy = () => null,
  done = () => {},
}) {
  let flash = null;
  loadFlashLib().catch((e) =>
    log(`couldn't load the flashing library: ${e.message}`),
  );

  const setFlashing = (on, msg) => {
    for (const id of [...Object.values(buttons), "connect"])
      $(id).disabled = on;
    if (msg !== undefined) $("flashinfo").textContent = msg;
  };

  async function start(which) {
    if (!hasWebSerial()) return;
    const why = busy();
    if (why) return log(why);
    const entry = firmware[which];
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
