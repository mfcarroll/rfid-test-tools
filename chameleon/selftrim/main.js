// The FSK self-trim page (index.html). ../common/fsk-page.js runs the page. This file adds what self-trim does
// differently: a choice of slots and modes, setting a slot's mode, and the reader each slot learned.

import { fskPage } from "../common/fsk-page.js";
import * as F from "../common/fsk.js";
import { $, log } from "../../common/page.js";
import * as X from "./selftrim.js";

// The mode choices, each named, the firmware's default marked if given.
function modeSelect(value, defaultPreset) {
  const sel = document.createElement("select");
  X.CHOICES.forEach((p) =>
    sel.append(
      new Option(
        X.presetName(p) + (p === defaultPreset ? " (default)" : ""),
        String(p),
      ),
    ),
  );
  sel.value = String(value);
  return sel;
}

const page = fskPage({
  name: "selftrim",
  presets: X,
  firmware: {
    test: {
      zip: "firmware/fsk-selftrim-489-0609420c-ultra-dfu-app.zip",
      name: "test firmware (fsk-selftrim-489 0609420c)",
      version: "v2.3.0-26-g0609420",
      time: "2026-10-31T06:49:34Z", // the commit time, in UTC
    },
    stock: {
      zip: "../common/firmware/stock-v2.3.0-ultra-dfu-app.zip",
      name: "stock v2.3.0",
    },
  },
  lacks: "has no self-trim support",
  flashIt: "the test firmware",
  plan: X.PLANS[4],
  hasResults: (r) => r.slots.some((s) => s.fields || s.kept),
  setMode: (page, slot, preset) => page.exp(F.reqSet(slot, preset)),
  confirmModes: " and set their modes",

  // A tick box per slot: the card goes into the slots ticked.
  planUse(page, s, td, from) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = page.plan.has(s.slot);
    cb.disabled = !from;
    const cell = td(cb);
    cb.onchange = () => {
      const sel = cell.parentNode.querySelector("select");
      if (cb.checked) page.plan.set(s.slot, Number(sel.value));
      else page.plan.delete(s.slot);
      page.renderPlan();
    };
  },
  planMode(page, s, td) {
    const sel = modeSelect(page.plan.get(s.slot) ?? s.preset);
    sel.disabled = !page.plan.has(s.slot);
    sel.onchange = () => page.plan.set(s.slot, Number(sel.value));
    td(sel);
  },

  // A slot's mode changes at once, from the results.
  resultMode(page, s, td, r) {
    const cell = td("");
    const sel = modeSelect(s.preset, r.defaultPreset);
    sel.onchange = () =>
      page.run("set mode", async () => {
        page.refresh(await page.exp(F.reqSet(s.slot, Number(sel.value))));
        log(
          `slot ${s.slot + 1}: mode ${X.presetName(Number(sel.value))}, saved`,
        );
      });
    cell.append(sel);
    if (!F.FSK_TYPES.has(s.lfType)) cell.className = "dim";
  },
  resultCells(page, s, td) {
    if (s.kept) {
      const f = X.farOff(s.kept.readerPpm);
      td(
        `${F.fmtPpm(s.kept.readerPpm)} ppm${f ? " ⚠" : ""}${s.kept.lfType !== s.lfType ? ` (learned as ${F.lfName(s.kept.lfType)})` : ""}`,
        f ? "warn" : "",
      );
      td(String(s.kept.fields));
    } else {
      td("–", "dim");
      td("–", "dim");
    }
  },
  renderDone(page, r, fw) {
    $("farnote").hidden = !r.slots.some(
      (s) => s.kept && X.farOff(s.kept.readerPpm),
    );
    const a = r.auto;
    $("live").textContent =
      `Firmware ${fw}. Active slot ${r.active + 1}: ${a.locked ? "locked to a reader" : "no reader locked"}, ` +
      `${a.wides} wide searches, ${a.restores} learned readers restored.`;
  },
});

// The test plans: the modes to compare, in slots 1 to n.
for (const n of [4, 6])
  $(`plan${n}`).onclick = () => {
    page.plan.clear();
    X.PLANS[n].forEach((mode, i) => page.plan.set(i, mode));
    page.renderPlan();
  };
