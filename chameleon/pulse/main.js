// The pulse test page (index.html). ../common/fsk-page.js runs the page. This file adds what the pulse test does
// differently: slots fixed by the firmware, slot 8 emptied, and command 3130's short fields and trims.

import { STATUS_SUCCESS } from "../common/cu.js";
import { fskPage } from "../common/fsk-page.js";
import * as F from "../common/fsk.js";
import { $, log } from "../../common/page.js";
import * as X from "./pulse.js";

fskPage({
  name: "pulse",
  presets: X,
  firmware: {
    test: {
      zip: "firmware/fsk-pulse-fd981f70-ultra-dfu-app.zip",
      name: "pulse test firmware (fd981f70)",
      version: "v2.3.0-31-gfd981f7",
    },
    stock: {
      zip: "../common/firmware/stock-v2.3.0-ultra-dfu-app.zip",
      name: "stock v2.3.0",
    },
  },
  lacks: "isn't the pulse test firmware",
  flashIt: "it",
  plan: X.PLAN, // slots 1-7, fixed by the firmware
  hasResults: (r) => r.slots.some((s) => s.fields),
  async readMore(cu, req = new Uint8Array(0)) {
    const r = await cu.cmd(X.CMD_PULSE, req);
    if (r.status !== STATUS_SUCCESS)
      throw Object.assign(
        new Error(
          "this firmware has no pulse test. Flash the pulse test firmware first",
        ),
        { noSupport: true },
      );
    const p = X.parsePulse(r.data);
    // The field log clears with the other results (req is reqClear() then).
    const l = await cu.cmd(
      X.CMD_PULSE,
      req.length ? X.reqFieldLogClear() : X.reqFieldLog(),
    );
    p.fieldLog = l.status === STATUS_SUCCESS ? X.parseFieldLog(l.data) : null;
    return p;
  },
  // The pulse test firmware fixes the slots' modes, so it has no setMode, and a restore leaves the modes as they are.
  emptyInactive: true,
  backupHf: true,

  planMode(page, s, td) {
    td(
      page.plan.has(s.slot)
        ? X.presetName(page.plan.get(s.slot))
        : s.slot === X.SPARE
          ? "emptied and disabled"
          : "not changed",
      page.plan.has(s.slot) ? "" : "dim",
    );
  },
  confirmNote: (last) =>
    `\n\nSlot 8 is disabled${last.slots[X.SPARE].lfType ? ` and its LF card (${F.lfName(last.slots[X.SPARE].lfType)}) removed` : ""}.`,
  async afterCopy(page) {
    const cu = page.cu();
    $("planinfo").textContent = "slot 8…";
    const sp = X.SPARE;
    await cu.cmd(F.CMD.DELETE_SLOT_SENSE_TYPE, F.reqSlotLf(sp)); // an empty LF side answers with an error
    await cu.cmd(F.CMD.DELETE_SLOT_TAG_NICK, F.reqSlotLf(sp));
    await cu.ok(F.CMD.SET_SLOT_ENABLE, F.reqEnableLf(sp, false));
    await cu.ok(F.CMD.SET_SLOT_ENABLE, F.reqEnableHf(sp, false));
    log("slot 8: LF card removed, slot disabled (an HF card stays, disabled)");
  },

  resultMode(page, s, td) {
    td(X.presetName(s.preset), F.FSK_TYPES.has(s.lfType) ? "" : "dim");
  },
  resultCells(page, s, td) {
    const q = page.more?.slots[s.slot];
    td(
      q && s.preset & X.PULSE ? String(q.shortFields) : "–",
      q && s.preset & X.PULSE ? "" : "dim",
    );
    td(
      X.trimText(page.more, s),
      s.preset & (X.TRIM_LEARN | X.TRIM_FIXED) ? "" : "dim",
    );
  },
  renderDone(page, r, fw) {
    $("live").textContent = `Firmware ${fw}. Active slot ${r.active + 1}.`;
  },
  saveExtra: (page) => ({ pulse: page.more }),
});
