// Hitag 2 slot modes: command 3188 on the interactive-LF test firmware (exp/lf-hitag-modes), copying a Hitag 2 card
// between slots, and the slot backup. No DOM, no Web Serial in here.
//
// The firmware runs the interactive LF engine, whose first module is a Hitag 2 tag. Each slot carries three research
// mode bits (lf_ia.h), a test of how the emulated tag should follow the reader:
//   SCALE (0x01):         time the answer's bits and delay in the reader's measured carrier, not a fixed 125 kHz.
//   ALT_PROTOCOL (0x04):  answer only every second START_AUTH, as the HT2 datasheet says a genuine tag does.
//   REST_LOADED (0x08):   after each answer, listen with the load on at once (the old default). Without it the tag
//                         holds the load off for 56 periods first, as a genuine tag does. Firmware 802a3a6d and
//                         earlier used this bit the other way round, as rest-unloaded.
// Bit 0x02 has no meaning: firmware f559dee3 and later ignore it, and earlier builds answered later with it. The three
// bits give eight combinations, one per slot. Command 3188 reads all eight slots' modes,
// or sets them from eight bytes. The modes live in retained RAM: they survive sleep (a test runs at a reader on
// battery) but reset to 0 on a power-on reset or a flash.

import { lfName } from "../common/slots.js";

export { lfName };

// ---------------------------------------------------------------- commands and constants

export const CMD = {
  CHANGE_DEVICE_MODE: 1001, // 1 reader, 0 tag
  SET_ACTIVE_SLOT: 1003,
  SET_SLOT_TAG_TYPE: 1004,
  SET_SLOT_DATA_DEFAULT: 1005,
  SET_SLOT_ENABLE: 1006,
  SET_SLOT_TAG_NICK: 1007,
  GET_SLOT_TAG_NICK: 1008,
  SLOT_DATA_CONFIG_SAVE: 1009,
  GET_ACTIVE_SLOT: 1018,
  GET_SLOT_INFO: 1019,
  DELETE_SLOT_TAG_NICK: 1021,
  GET_ENABLED_SLOTS: 1023,
  DELETE_SLOT_SENSE_TYPE: 1024,
  HITAG2_SET_EMU_DATA: 5040,
  HITAG2_GET_EMU_DATA: 5041,
  LF_IA_SLOT_MODES: 3188, // in: empty to read, or 8 bytes to set; out: the 8 slot modes
};
export const STATUS_SUCCESS = 0x68;
export const STATUS_INVALID_CMD = 0x67;

export const TAG_TYPE_HITAG2 = 470;
export const SENSE_LF = 1;
export const SENSE_HF = 2;
export const HITAG2_DATA_SIZE = 32; // eight 32-bit pages
export const SLOTS = 8;

// ---------------------------------------------------------------- modes

export const SCALE = 0x01;
export const ALT_PROTOCOL = 0x04;
export const REST_LOADED = 0x08;
export const MODE_BITS = SCALE | ALT_PROTOCOL | REST_LOADED;
// Every combination of the three bits, in counting order: 0, 1, 4, 5, 8, 9, 12, 13.
export const CHOICES = [0, 1, 2, 3, 4, 5, 6, 7].map(
  (i) =>
    (i & 1 ? SCALE : 0) |
    (i & 2 ? ALT_PROTOCOL : 0) |
    (i & 4 ? REST_LOADED : 0),
);
// The default plan gives each slot one of the eight, so one walk past a reader tries every combination.
export const DEFAULT_MODES = [...CHOICES];

/** @type {[number, string][]} */
const FLAGS = [
  [SCALE, "scale"],
  [ALT_PROTOCOL, "every-second"],
  [REST_LOADED, "rest-loaded"],
];
// A mode's name, e.g. "scale + every-second", or "baseline" for 0.
export const modeName = (m) => {
  const on = FLAGS.filter(([bit]) => m & bit).map(([, name]) => name);
  return on.length ? on.join(" + ") : "baseline";
};
// True if a plan sets every slot to baseline. The page asks before it writes such a plan: after a flash every slot
// reads back as baseline, and a tester who skips Default setup would otherwise write no timing modes at all.
export const isAllBaseline = (plan) => plan.every((m) => !(m & MODE_BITS));
// A slot nickname for a mode, e.g. "Hitag 2 S+E" or "Hitag 2 base" (the CU allows 32 bytes).
/** @type {[number, string][]} */
const SHORT = [
  [SCALE, "S"],
  [ALT_PROTOCOL, "E"],
  [REST_LOADED, "L"],
];
export const modeNick = (m) => {
  const on = SHORT.filter(([bit]) => m & bit).map(([, c]) => c);
  return `Hitag 2 ${on.length ? on.join("+") : "base"}`;
};

// Command 3188 reply: the 8 slot modes, slot 1 first.
export function parseModes(d) {
  if (d.length < SLOTS)
    throw new Error(`3188 reply is ${d.length} bytes, expected ${SLOTS}`);
  return Array.from(d.slice(0, SLOTS));
}
// Command 3188 request to set every slot's mode.
export const reqSetModes = (modes) => Uint8Array.from(modes);

// ---------------------------------------------------------------- requests

export const reqSlot = (slot) => Uint8Array.of(slot);
export const reqSlotType = (slot, type) =>
  Uint8Array.of(slot, type >> 8, type & 0xff);
export const reqSlotLf = (slot) => Uint8Array.of(slot, SENSE_LF);
export const reqEnable = (slot, sense, on = true) =>
  Uint8Array.of(slot, sense, on ? 1 : 0);
export function reqNick(slot, sense, name) {
  const b = new TextEncoder().encode(name).slice(0, 32);
  const r = new Uint8Array(2 + b.length);
  r[0] = slot;
  r[1] = sense;
  r.set(b, 2);
  return r;
}

export const hex = (b) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (h) =>
  Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

// The made-up card that set slot data default writes into a Hitag 2 slot (the firmware's
// lf_tag_hitag2_data_factory()).
export const DEFAULT_CARD = unhex(
  "010203040a0b0c0d02020202060e0f1004040404050505050606060607070707",
);

// What a slot read back after a copy holds: "card" (the copied card), "default" (DEFAULT_CARD) or "other". got is
// the slot's Hitag 2 data, or null if the slot didn't send any.
export function checkCopy(got, card) {
  if (!got || got.length < HITAG2_DATA_SIZE) return "other";
  const same = (a) => a.every((x, i) => got[i] === x);
  if (same(card)) return "card";
  return same(DEFAULT_CARD) ? "default" : "other";
}

// ---------------------------------------------------------------- backup

// A backup file holds each slot's LF side: card type, Hitag 2 card data, whether LF and HF are enabled, the
// nickname and the mode. A slot whose LF type this page can't read back is noted and left as it is on restore.
export const BACKUP_KIND =
  "rfid-test-tools/chameleon/hitag-modes LF slot backup";
export function checkBackup(b) {
  if (
    b?.kind !== BACKUP_KIND ||
    b.version !== 1 ||
    !Array.isArray(b.slots) ||
    b.slots.length !== SLOTS
  )
    throw new Error("this isn't a backup file from this page");
  return b;
}
