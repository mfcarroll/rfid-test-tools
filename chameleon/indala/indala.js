// Indala test: the CU's commands for reading and emulating Indala, and the results. No DOM, no Web Serial in here.
//
// Two firmwares number Indala differently. #509 (feat/lf-indala) uses tag type 300 and commands 5026/5027 for the
// emulated frame. nieldk's fork uses type 311 and 5014/5015 (which #509's firmware uses for Paradox). Both scan with
// 3035, and only in reader mode.

export const CMD = {
  CHANGE_DEVICE_MODE: 1001, // 1 reader, 0 tag
  SET_ACTIVE_SLOT: 1003,
  SET_SLOT_TAG_TYPE: 1004,
  SET_SLOT_DATA_DEFAULT: 1005,
  SET_SLOT_ENABLE: 1006,
  SET_SLOT_TAG_NICK: 1007,
  SLOT_DATA_CONFIG_SAVE: 1009,
  GET_SLOT_INFO: 1019,
  INDALA_SCAN: 3035,
};
export const STATUS_LF_TAG_OK = 0x40;
export const STATUS_LF_TAG_NO_FOUND = 0x41;
const SENSE_LF = 1;

export const PROFILES = {
  pr509: { name: "#509", type: 300, setEmu: 5026, getEmu: 5027 },
  nieldk: { name: "nieldk", type: 311, setEmu: 5014, getEmu: 5015 },
};

// The card the emulation test loads: #509's default Indala frame, Indala 26-bit FC 123, card 1337. A test value, not
// anyone's credential. The Flipper prints the decode as "Indala26 <hex>" followed by "FC: 123" and "Card: 1337".
export const TEST_FRAME = Uint8Array.from(
  "a00000008f49d2a1".match(/../g),
  (x) => parseInt(x, 16),
);
export const TEST_NICK = "Indala test";
export const TEST_CARD_LABEL = "test card (FC 123, 1337)";
export const isTestDecode = (r) =>
  r.protocol === "Indala26" &&
  r.info.includes("FC: 123") &&
  r.info.includes("Card: 1337");

const LF_TYPES = {
  0: "empty",
  100: "EM410x",
  150: "PAC",
  170: "Viking",
  180: "Jablotron",
  200: "HID Prox",
  201: "ioProx",
  203: "Paradox",
  300: "Indala",
  310: "IDTECK",
  311: "Indala (nieldk)",
};
export const lfName = (t) => LF_TYPES[t] ?? `type ${t}`;

// GET_SLOT_INFO: eight (hf, lf) pairs of u16, slot 1 first.
export function parseSlotInfo(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const slots = [];
  for (let i = 0; i + 4 <= d.length; i += 4)
    slots.push({ hf: v.getUint16(i), lf: v.getUint16(i + 2) });
  return slots;
}

export const reqMode = (reader) => Uint8Array.of(reader ? 1 : 0);
export const reqSlot = (slot) => Uint8Array.of(slot);
export const reqSlotType = (slot, type) =>
  Uint8Array.of(slot, type >> 8, type & 0xff);
export const reqEnableLf = (slot) => Uint8Array.of(slot, SENSE_LF, 1);
export function reqNickLf(slot, name) {
  const b = new TextEncoder().encode(name).slice(0, 32);
  const r = new Uint8Array(2 + b.length);
  r.set([slot, SENSE_LF]);
  r.set(b, 2);
  return r;
}

// A short label for a frame, so results can say "the same card every time" without showing the card: the first 4
// hex digits of its SHA-256.
export async function fingerprint(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...h.slice(0, 2)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// One run: { firmware, test, card?, tries: [{ s, ok, wrong, fp }] }. s is null for a miss. card names a known card
// (the emulation test's); a read test has none, and its card shows as fingerprints.
export function summarise(run) {
  const hits = run.tries.filter((t) => t.ok);
  const times = hits.map((t) => t.s).sort((a, b) => a - b);
  const fps = [...new Set(run.tries.map((t) => t.fp).filter(Boolean))];
  return {
    firmware: run.firmware,
    test: run.test,
    n: run.tries.length,
    ok: hits.length,
    wrong: run.tries.filter((t) => t.wrong).length,
    median: times.length ? times[Math.floor((times.length - 1) / 2)] : null,
    max: times.length ? times[times.length - 1] : null,
    fps,
    card: run.card ?? null,
  };
}

const sec = (s) => (s === null ? "–" : `${s.toFixed(2)} s`);

// The results as { head, rows } of text cells, one row per run. The card column shows the known card for an emulation
// run, and for a read run the fingerprints seen, or "–" when the person leaves fingerprints out.
export function table(runs, fingerprints = true) {
  const head = [
    "CU firmware",
    "test",
    "read",
    "wrong",
    "median",
    "slowest",
    "card",
  ];
  const rows = runs
    .map(summarise)
    .map((r) => [
      r.firmware,
      r.test,
      `${r.ok}/${r.n}`,
      String(r.wrong),
      sec(r.median),
      sec(r.max),
      r.card ?? ((fingerprints && r.fps.join(", ")) || "–"),
    ]);
  return { head, rows };
}

// The same table in Markdown, for pasting into a GitHub comment.
export function markdown(runs, fingerprints = true) {
  const { head, rows } = table(runs, fingerprints);
  return [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ].join("\n");
}
