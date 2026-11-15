// FSK self-trim field test: the presets command 3120 sets (../common/fsk.js) and the report. No DOM, no Web Serial
// in here.
//
// The test firmware gives each slot a preset, saved on the CU. The preset is a mode: 0 stock (as stock firmware),
// 1 drive (the new modulation drive, no trim) or 2 self-trim. Self-trim is the new drive matched to the reader: it
// measures the reader's clock, trims to it and restarts in phase with it, and keeps what it learns per slot. Flag 0x04
// adds exact bits: HID Prox and Paradox bits at exactly 50 carrier cycles on average, where stock firmware makes each
// fc/8 bit 48. Unset slots use the default.

import { EXACT_BITS, UNSET, FSK_TYPES, lfName, fmtPpm } from "../common/fsk.js";

const MODES = ["stock", "new drive only", "self-trim"];
const SHORT = ["stock", "drive", "selftrim"];
// The choices offered, in this order.
export const CHOICES = [0, EXACT_BITS, 2, 2 | EXACT_BITS, 1, 1 | EXACT_BITS];
export const presetName = (p) =>
  MODES[p & 3] + (p & EXACT_BITS ? " + exact bits" : "");
// A slot nickname for a preset, e.g. "Paradox selftrim+x" (the CU allows 32 bytes).
export const presetNick = (lfType, p) =>
  `${lfName(lfType)} ${SHORT[p & 3]}${p & EXACT_BITS ? "+x" : ""}`;
// Test plans: the modes to compare, in the order they go into slots.
export const PLANS = {
  4: [0, EXACT_BITS, 2, 2 | EXACT_BITS],
  6: [0, EXACT_BITS, 2, 2 | EXACT_BITS, 1, 1 | EXACT_BITS],
};

// A crystal-controlled reader sits within about 100 ppm of the CU. Further off, its clock is something else (an LC or
// ceramic oscillator): one real HID reader ran at -4187 ppm. Stock reads such a reader only close in.
export const FAR_PPM = 300;
export const farOff = (ppm) => Math.abs(ppm) > FAR_PPM;

// Plain text for pasting into a chat: one line per slot that matters.
export function report(r, firmware) {
  const lines = [`CU firmware ${firmware}, active slot ${r.active + 1}`];
  for (const s of r.slots) {
    if (!FSK_TYPES.has(s.lfType) && !s.kept && !s.fields) continue;
    let l = `slot ${s.slot + 1}: ${lfName(s.lfType)}, ${presetName(s.preset)}${s.stored === UNSET ? " (default)" : ""}, fields seen ${s.fields}`;
    if (s.kept)
      l +=
        `, reader ${fmtPpm(s.kept.readerPpm)} ppm vs CU (learned on ${lfName(s.kept.lfType)}, trim ${s.kept.trim})` +
        (farOff(s.kept.readerPpm) ? ", far off nominal" : "");
    else if ((s.preset & 3) === 2) l += ", no reader learned";
    lines.push(l);
  }
  return lines.join("\n");
}
