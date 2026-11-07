// Card search page: the CU's read commands, their replies, and the report. No DOM, no Web Serial in here.
//
// Every command here only reads. The named scans and the sniff turn the field on and listen. The HF scan is the
// ISO 14443-A anticollision a phone or door reader also runs. The MIFARE Classic checks ask the card for an
// authentication nonce and stop there. The chip probe sends one read command (the T55xx read of page 1 block 1 that
// the Proxmark's `lf search` also sends) and then listens.
//
// Each result has a safe part and a private part. The safe part says what kind of card it is and how it talks. The
// private part holds anything that can be the card's number: IDs, facility codes, frames, UIDs, raw captures.

export const CMD = {
  CHANGE_DEVICE_MODE: 1001, // 1 reader, 0 tag
  GET_DEVICE_MODE: 1002,
  HF14A_SCAN: 2000,
  MF1_DETECT_SUPPORT: 2001,
  MF1_DETECT_PRNG: 2002,
  EM410X_SCAN: 3000,
  HIDPROX_SCAN: 3002,
  VIKING_SCAN: 3004,
  IOPROX_SCAN: 3010,
  PAC_SCAN: 3014,
  JABLOTRON_SCAN: 3019,
  PYRAMID_SCAN: 3021,
  PARADOX_SCAN: 3022, // PR 489
  INDALA_SCAN: 3035, // PR 509
  LF_SNIFF: 3031,
  LF_CHIP_PROBE: 3140,
};
export const STATUS = {
  HF_TAG_OK: 0x00,
  HF_TAG_NO: 0x01,
  LF_TAG_OK: 0x40,
  LF_TAG_NO_FOUND: 0x41,
  DEVICE_MODE_ERROR: 0x66,
  INVALID_CMD: 0x67,
};
export const PROBE_T55XX_TRACE = 1;
export const PROBE_T55XX_CONFIG = 3;
export const PROBE_EM4X05_WORD0 = 2;
export const PROBE_HITAG2_START = 4;

const hex = (d) =>
  Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
const u32 = (d, o) =>
  ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

export const reqMode = (reader) => Uint8Array.of(reader ? 1 : 0);

// ---------------------------------------------------------------- long captures

// A long sniff request: timeout 2000 ms, 16-bit samples, default phase, rate and gain, 2 ms settle, then the chunk.
export const reqSniff = (chunk) =>
  Uint8Array.of(0x07, 0xd0, 16, 0, 0, 6, 2, chunk);
export const reqProbe = (probe) => Uint8Array.of(probe, 16, 20, 0);
export const SNIFF_INFO_CHUNK = 0xff;

// The description of the last capture (chunk 0xff). Null if the firmware has none, which means it has no long
// captures: stock firmware returns its usual 4000-byte capture instead.
export function parseSniffInfo(d) {
  if (d.length < 13 || d.length > 64) return null;
  return {
    total: u32(d, 0),
    dropped: u32(d, 4),
    bits: d[8],
    rate: d[10],
    gain: d[11],
    settle: d[12],
    probe: d.length >= 14 ? d[13] : 0,
  };
}

// ---------------------------------------------------------------- named LF scans

const HID_FORMATS = {
  1: "H10301 26-bit",
  2: "Indala 26-bit",
  3: "Indala 27-bit",
  4: "Indala ASC 27-bit",
  5: "Tecom 27-bit",
  6: "2804 Wiegand 28-bit",
  7: "Indala 29-bit",
  8: "ATS Wiegand 30-bit",
  9: "ADT 31-bit",
  10: "Check Point 32-bit",
  11: "Hewlett-Packard 32-bit",
  12: "Kastle 32-bit",
  13: "Indala/Kantech KFS 32-bit",
  14: "Wiegand 32-bit",
  15: "D10202 33-bit",
  16: "H10306 34-bit",
  17: "Honeywell/Northern N10002 34-bit",
  18: "Indala Optus 34-bit",
  19: "Cardkey Smartpass 34-bit",
  20: "BQT 34-bit",
  21: "Corporate 1000 35-bit",
  22: "KeyScan 36-bit",
  23: "Simplex 36-bit",
  24: "Siemens 36-bit",
  25: "H10320 37-bit BCD",
  26: "H10302 37-bit",
  27: "H10304 37-bit",
  28: "P10004 37-bit",
  29: "Generic 37-bit",
  30: "PointGuard MDI 37-bit",
  42: "ACTProx 36-bit",
};

// Each scan: its command, its name, and how to split its reply into a safe and a private part.
export const LF_SCANS = [
  {
    cmd: CMD.EM410X_SCAN,
    name: "EM410x",
    parse: (d) => ({
      safe: {},
      private: {
        id: hex(d.subarray(2, ((d[0] << 8) | d[1]) === 104 ? 15 : 7)),
      },
    }),
  },
  {
    cmd: CMD.HIDPROX_SCAN,
    name: "HID Prox",
    req: Uint8Array.of(0),
    parse: (d) => ({
      safe: { format: HID_FORMATS[d[0]] ?? `format ${d[0]}` },
      private: {
        facility: u32(d, 1),
        card: u32(d, 6),
        issue: d[10],
        oem: (d[11] << 8) | d[12],
      },
    }),
  },
  {
    cmd: CMD.IOPROX_SCAN,
    name: "ioProx",
    parse: (d) => ({
      safe: {},
      private: {
        version: d[0],
        facility: d[1],
        card: (d[2] << 8) | d[3],
        raw: hex(d.subarray(4, 12)),
      },
    }),
  },
  {
    cmd: CMD.VIKING_SCAN,
    name: "Viking",
    parse: (d) => ({ safe: {}, private: { id: hex(d.subarray(0, 4)) } }),
  },
  {
    cmd: CMD.PAC_SCAN,
    name: "PAC/Stanley",
    parse: (d) => ({
      safe: {},
      private: { card: new TextDecoder().decode(d.subarray(0, 8)) },
    }),
  },
  {
    // PR 489's read. It accepts a frame only if its CRC matches, so a read here is a whole Paradox frame. The reply is
    // 6 bytes: 2 zero bits, FC (8), card (16), CRC (8), then padding.
    cmd: CMD.PARADOX_SCAN,
    name: "Paradox",
    parse: (d) => {
      const v = d.subarray(0, 6).reduce((n, b) => n * 256n + BigInt(b), 0n);
      return {
        safe: {},
        private: {
          facility: Number((v >> 30n) & 0xffn),
          card: Number((v >> 14n) & 0xffffn),
          crc: Number((v >> 6n) & 0xffn),
          raw: hex(d.subarray(0, 6)),
        },
      };
    },
  },
  {
    // PR 509's read. The reply is the 64-bit frame.
    cmd: CMD.INDALA_SCAN,
    name: "Indala",
    parse: (d) => {
      const raw = hex(d.subarray(0, 8));
      const f = indalaFields(
        [...d.subarray(0, 8)]
          .map((b) => b.toString(2).padStart(8, "0"))
          .join(""),
      );
      return {
        safe: {
          format: !f.preamble
            ? "no Indala preamble"
            : f.encoderBits
              ? "64-bit"
              : "64-bit, parity and checksum bits don't follow the Proxmark's encoder",
        },
        private: f.preamble
          ? { facility: f.facility, card: f.card, raw }
          : { raw },
      };
    },
  },
  {
    cmd: CMD.JABLOTRON_SCAN,
    name: "Jablotron",
    parse: (d) => ({ safe: {}, private: { id: hex(d.subarray(0, 5)) } }),
  },
  {
    cmd: CMD.PYRAMID_SCAN,
    name: "Farpointe/Pyramid",
    parse: (d) => ({ safe: {}, private: { raw: hex(d.subarray(0, 16)) } }),
  },
];

// ---------------------------------------------------------------- HF

// One card per entry: uid length, uid, ATQA (2), SAK, ATS length, ATS.
export function parseHf14a(d) {
  const cards = [];
  for (let o = 0; o < d.length;) {
    const n = d[o++];
    const uid = d.subarray(o, o + n);
    o += n;
    const atqa = d.subarray(o, o + 2);
    const sak = d[o + 2];
    const atsLen = d[o + 3];
    o += 4;
    const ats = d.subarray(o, o + atsLen);
    o += atsLen;
    cards.push({
      uid: hex(uid),
      uidLength: n,
      // sent least significant byte first; shown most significant first, as the Proxmark and the datasheets do
      atqa: hex(atqa.slice().reverse()),
      sak,
      ats: hex(ats),
    });
  }
  return cards;
}

// The card type that ATQA and SAK usually mean. Other cards can share these values, so the page says "likely".
export function hfGuess({ atqa, sak }) {
  const a = atqa.toLowerCase();
  if (sak === 0x08)
    return a === "0044"
      ? "MIFARE Classic 1K (7-byte UID) or Plus 2K in SL1"
      : "MIFARE Classic 1K or Plus 2K in SL1";
  if (sak === 0x18) return "MIFARE Classic 4K or Plus 4K in SL1";
  if (sak === 0x09) return "MIFARE Mini";
  if (sak === 0x01) return "MIFARE Classic 1K (Infineon)";
  if (sak === 0x10 || sak === 0x11) return "MIFARE Plus in SL2";
  if (sak === 0x00)
    return a === "0044"
      ? "MIFARE Ultralight or NTAG"
      : "ISO 14443-3 card with no ISO 14443-4";
  if (sak === 0x20)
    return a === "0344"
      ? "MIFARE DESFire"
      : "ISO 14443-4 card (DESFire, Plus SL3, a bank card or a JavaCard, for example)";
  if (sak === 0x28 || sak === 0x38)
    return "Smart card that also emulates MIFARE Classic";
  return "Unknown ISO 14443-A card";
}

// The CU's PRNG check (2002) calls a card static when it gives the same nonce twice, with the field reset between.
// A weak PRNG runs from power-up, and the CU reads it at the same moment each time, so a weak card can show the same.
// On a Gen4 card that the Proxmark judged weak, the CU said static.
export const PRNG = {
  0: "the same nonce twice (static, or a weak PRNG read at the same moment after power-up)",
  1: "weak (crackable offline)",
  2: "hard",
};
export const isClassic = (sak) =>
  [0x01, 0x08, 0x09, 0x18, 0x28, 0x38].includes(sak);

// ---------------------------------------------------------------- report

import { decodeHalfBits } from "./lfdemod.js";
import { frameCheckLine, indalaFields, t55ConfigLine } from "./framecheck.js";

const bitsHex = (bits) => {
  let h = "";
  for (let i = 0; i + 4 <= bits.length; i += 4)
    h += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return h;
};

// What the signal suggests went wrong, if anything. None of it says anything about the card's number.
function hints(lf) {
  const s = lf.signal,
    out = [];
  // A Hitag answers its start command once, after the recording that looks for a repeating frame.
  if (!s || lf.hitag2) return out;
  if (s.modulation === "none")
    out.push(
      "No LF modulation. Either there's no LF card, the card only answers a command first (Hitag, EM4x50 and some others), or it's too far away: lay it flat on the CU's button side.",
    );
  else if (!s.frameBits)
    out.push(
      "No frame repeats. The card may have moved during the recording, or its frame is longer than 260 bits.",
    );
  if (s.modulation !== "none" && s.depth < 0.05)
    out.push(`The signal is weak (depth ${s.depth}): move the card closer.`);
  if (lf.config?.password)
    out.push(
      "The T55xx has password mode on, so writing it needs its password.",
    );
  if (lf.config?.answerOnRequest)
    out.push(
      "The T55xx only answers after a wake-up command, so readers that only listen miss it.",
    );
  if (lf.config?.sequenceTerminator)
    out.push(
      "The T55xx sends a sequence terminator, which some readers don't expect.",
    );
  return out;
}

// The safe report, as Markdown. It leaves out every private field, and the selftest checks that.
export function safeMarkdown(r) {
  const L = [];
  L.push(`**Chameleon Ultra card search report** (safe to share)`, "");
  L.push(`- Firmware: ${r.firmware}`);
  if (r.baseline) L.push(`- Empty-field level: ${r.baseline.level}`);
  L.push("", "**LF (125 kHz)**");
  const lf = r.lf;
  if (!lf) L.push("- not checked");
  else {
    const named = lf.named.map(
      (n) => n.name + (n.safe.format ? `, ${n.safe.format}` : ""),
    );
    L.push(
      `- Named reads: ${named.length ? named.join("; ") : "none matched"}`,
    );
    const s = lf.signal;
    if (s && s.modulation !== "none")
      L.push(
        `- Signal: ${s.modulation} (${s.detail}), RF/${s.rate}` +
          (!s.frameBits
            ? ", no repeating frame found"
            : s.terminator
              ? `, repeats every ${s.frameBits} bits (${s.dataBits} data bits and a 4-bit sequence terminator)`
              : `, repeats every ${s.frameBits} bits`),
      );
    else L.push("- Signal: no modulation found");
    if (s)
      L.push(
        `- Level ${s.level}, modulation depth ${s.depth}` +
          (lf.change != null
            ? `, average level ${Math.abs(lf.change)}% ${lf.change >= 0 ? "above" : "below"} the empty field`
            : ""),
      );
    if (lf.fits) L.push(`- Fits: ${lf.fits.join(", ")}`);
    for (const c of lf.checks ?? [])
      L.push(`- Frame check: ${frameCheckLine(c)}`);
    if (lf.dropped) L.push(`- ⚠ The capture lost ${lf.dropped} samples`);
    if (lf.chip)
      L.push(
        `- Chip check (T55xx read): ${{ yes: "answered, a T55xx", no: "no T55xx answer", unclear: "unclear" }[lf.chip]}`,
      );
    if (lf.em4x05 !== undefined)
      L.push(
        "- Chip check (EM4x05 read of word 0): " +
          (lf.em4x05
            ? `answered, an ${lf.em4x05.chip} (${lf.em4x05.capacitor}, customer code ${lf.em4x05.customerCode})`
            : "no EM4x05 answer"),
      );
    if (lf.hitag2 !== undefined)
      L.push(
        "- Chip check (Hitag 2 start command): " +
          (lf.hitag2
            ? `answered, a Hitag 2 or Hitag S tag (Manchester, RF/32, a ${lf.hitag2.header}-bit header and a 32-bit serial)`
            : "no Hitag answer"),
      );
    if (lf.config) L.push(`- T55xx configuration: ${t55ConfigLine(lf.config)}`);
    else if (lf.chip === "yes")
      L.push(
        "- T55xx configuration: not read (no single reading fits the card's signal)",
      );
    for (const h of hints(lf)) L.push(`- ⚠ ${h}`);
  }
  L.push("", "**HF (13.56 MHz, ISO 14443-A only)**");
  if (!r.hf) L.push("- not checked");
  else if (!r.hf.cards.length) L.push("- no ISO 14443-A card answered");
  else
    for (const c of r.hf.cards)
      L.push(
        `- ${hfGuess(c)}: ATQA ${c.atqa}, SAK ${c.sak.toString(16).padStart(2, "0")}, ${c.uidLength}-byte UID` +
          (c.ats ? `, ATS ${c.ats}` : "") +
          (c.prng != null ? `, PRNG ${PRNG[c.prng] ?? c.prng}` : ""),
      );
  return L.join("\n");
}

// The full report: everything, private fields included.
export function fullMarkdown(r) {
  const L = [
    safeMarkdown(r).replace(
      "(safe to share)",
      "(full: may contain the card's credential)",
    ),
    "",
    "**Private details**",
  ];
  if (r.lf) {
    for (const n of r.lf.named)
      L.push(`- ${n.name}: ${JSON.stringify(n.private)}`);
    const sig = r.lf.signal;
    if (sig?.frame) {
      // The frame starts at an arbitrary bit, so its hex is a rotation of the card's frame.
      if (sig.halfOffset != null) {
        const d = decodeHalfBits(sig.frame, sig.halfOffset);
        L.push(
          `- One LF frame, as Manchester: ${d.manchester}`,
          `- The same frame, as biphase: ${d.biphase}`,
        );
        L.push(`- Its half-bits: ${sig.frame}`);
      } else
        L.push(`- One LF frame: ${bitsHex(sig.frame)} (bits ${sig.frame})`);
    }
    for (const c of r.lf.checks ?? [])
      L.push(`- ${c.name} fields from the frame: ${JSON.stringify(c.private)}`);
    if (r.lf.em4x05) L.push(`- EM4x05 word 0: ${r.lf.em4x05.word}`);
    if (r.lf.hitag2) L.push(`- Hitag serial: ${r.lf.hitag2.serial}`);
    if (r.lf.chipBlock) L.push(`- T55xx answer: ${r.lf.chipBlock}`);
  }
  if (r.hf) for (const c of r.hf.cards) L.push(`- HF UID: ${c.uid}`);
  return L.join("\n");
}
