// FSK pulse test: the presets command 3120 reports (../common/fsk.js), command 3130 and the report. No DOM, no Web
// Serial in here.
//
// The pulse test firmware fixes each slot's mode, so every tester's setup is the same (lf_exp_fsk.c). A preset is a
// drive (0 stock load switching, 1 the U1 drive) plus flags: 0x04 exact bits (HID Prox and Paradox bits at exactly 50
// carrier cycles on average, where stock makes each fc/8 bit 48), 0x08 pulse timing (a fresh frame 2.1 ms into each
// field, for a reader that switches its field on and off), 0x10 a trim learned from the reader's pulses, 0x20 a fixed
// trim. Command 3130 reports what each slot learned.

import { EXACT_BITS, FSK_TYPES, lfName, fmtPpm } from "../common/fsk.js";

export const PULSE = 0x08;
export const TRIM_LEARN = 0x10;
export const TRIM_FIXED = 0x20;
export const CMD_PULSE = 3130;
export function presetName(p) {
  if (p === 0) return "stock";
  const parts = [];
  if (p & PULSE) parts.push("pulse timing");
  if (p & EXACT_BITS) parts.push("exact bits");
  if (p & TRIM_LEARN) parts.push("learned trim");
  if (p & TRIM_FIXED) parts.push("fixed trim");
  if ((p & 3) === 1) parts.push("drive");
  if ((p & 3) === 2) parts.push("self-trim");
  return parts.join(" + ");
}
// A slot nickname, e.g. "Paradox 5 pulse+x+learn" (the CU allows 32 bytes).
export function presetNick(lfType, p, slot) {
  const parts = p === 0 ? ["stock"] : [];
  if (p & PULSE) parts.push("pulse");
  if (p & EXACT_BITS) parts.push("x");
  if (p & TRIM_LEARN) parts.push("learn");
  if (p & TRIM_FIXED) parts.push("fixed");
  if ((p & 3) === 1) parts.push("drive");
  return `${lfName(lfType)} ${slot + 1} ${parts.join("+")}`;
}
// The firmware's slots 1-7 (lf_exp_fsk.c), the one plan.
export const PLAN = [0x00, 0x08, 0x0c, 0x18, 0x1c, 0x2c, 0x2d];

// Command 3130's reply: what each slot learned from the reader's pulses.
export function parsePulse(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d[0] !== 1)
    throw new Error(`3130 reply version ${d[0]}, this page knows version 1`);
  const p = { active: d[1], fixedPpm: v.getInt32(2) / 10, slots: [] };
  for (let s = 0, n = 6; s < 8; s++, n += 19)
    p.slots.push({
      slot: s,
      preset: d[n],
      learned: !!d[n + 1],
      haveLast: !!d[n + 2],
      ppm: v.getInt32(n + 3) / 10,
      lastPpm: v.getInt32(n + 7) / 10,
      lastSnr: v.getInt16(n + 11) / 10,
      measures: v.getUint16(n + 13),
      fails: v.getUint16(n + 15),
      shortFields: v.getUint16(n + 17),
    });
  if (d.length !== 6 + 8 * 19)
    throw new Error(`3130 reply is ${d.length} bytes, expected ${6 + 8 * 19}`);
  return p;
}

// What a slot's trim is: learned (or not yet), fixed, or none.
export function trimText(p, s) {
  const q = p?.slots[s.slot];
  if (s.preset & TRIM_FIXED) return `fixed ${fmtPpm(p?.fixedPpm ?? 0)} ppm`;
  if (!(s.preset & TRIM_LEARN)) return "none";
  if (!q) return "?";
  if (q.learned) return `learned ${fmtPpm(q.ppm)} ppm`;
  return q.haveLast
    ? `not confirmed (last ${fmtPpm(q.lastPpm)} ppm)`
    : "not learned";
}

// Command 3130 with 0xF1 (read) or 0xF0 (clear): the field log, one record per field the CU saw, oldest first.
// Firmware without the field log answers 0xF1 with the ordinary reply, so the entry size tells the two
// apart (that reply's second byte is the active slot, 0-7). Returns null for that firmware.
export const reqFieldLog = () => Uint8Array.of(0xf1);
export const reqFieldLogClear = () => Uint8Array.of(0xf0);
const FIELD_END = [
  "on",
  "long check",
  "short check",
  "watchdog",
  "measure",
  "stopped",
];
export function parseFieldLog(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const size = d[1];
  if (d.length < 6 || d[0] !== 1 || size !== 24 || (d.length - 6) % size)
    return null;
  const log = { total: v.getUint16(2), wake: v.getUint16(4), fields: [] };
  for (let n = 6; n < d.length; n += size)
    log.fields.push({
      wake: v.getUint16(n),
      slot: d[n + 2],
      end: FIELD_END[d[n + 3]] ?? `other (${d[n + 3]})`,
      startMs: v.getUint32(n + 4),
      ms: v.getUint16(n + 8),
      frames: v.getUint16(n + 10),
      longHigh: v.getUint16(n + 12),
      shortHigh: v.getUint16(n + 14),
      level: [d[n + 16], d[n + 17] === 0xff ? 0 : d[n + 17], d[n + 18]],
      measured: d[n + 19] >> 4,
      noLine: d[n + 19] & 15,
      watchdog: d[n + 20],
      measuredLevel: v.getUint16(n + 22),
    });
  return log;
}

// One line per field. The gap is the time since the previous field of the same wake ended: a short gap inside one hold
// means the CU lost the field and found it again.
export function fieldLogReport(log) {
  if (!log) return "";
  const lines = [
    `Field log: ${log.total} field(s) since it was cleared, ${log.fields.length} kept, ${log.wake} wake(s)`,
  ];
  let prev = null;
  for (const f of log.fields) {
    const gap =
      prev && prev.wake === f.wake
        ? `, ${f.startMs - (prev.startMs + prev.ms)} ms after the last`
        : "";
    let l = `wake ${f.wake} slot ${f.slot + 1}: ${f.ms} ms${gap}, ${f.frames} frames, ended at ${f.end}`;
    if (f.level[2]) l += `, level ${f.level[1]}-${f.level[2]}`;
    if (f.measured || f.noLine)
      l += `, measured ${f.measured} + ${f.noLine} without a line (level ${f.measuredLevel})`;
    if (f.watchdog) l += `, watchdog ${f.watchdog}`;
    lines.push(l);
    prev = f;
  }
  return lines.join("\n");
}

// Plain text for pasting into a chat: one line per slot that matters, then the field log.
export function report(r, firmware, p) {
  const lines = [`CU firmware ${firmware}, active slot ${r.active + 1}`];
  for (const s of r.slots) {
    if (!FSK_TYPES.has(s.lfType) && !s.fields) continue;
    let l = `slot ${s.slot + 1}: ${lfName(s.lfType)}, ${presetName(s.preset)}, fields seen ${s.fields}`;
    const q = p?.slots[s.slot];
    if (q && s.preset & PULSE) l += `, short fields ${q.shortFields}`;
    if (s.preset & (TRIM_LEARN | TRIM_FIXED)) l += `, trim ${trimText(p, s)}`;
    if (q && s.preset & TRIM_LEARN)
      l += ` (${q.measures} measurement(s), ${q.fails} without a line${q.haveLast ? `, last ${q.lastSnr.toFixed(0)} dB` : ""})`;
    lines.push(l);
  }
  const f = fieldLogReport(p?.fieldLog);
  return f ? lines.join("\n") + "\n\n" + f : lines.join("\n");
}

// Slot 8 (index 7) is emptied and disabled for the test, so the CU's buttons skip it.
export const SPARE = 7;
