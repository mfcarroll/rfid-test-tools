// Frame checks: does the LF frame have the shape of a protocol the CU reads, and would the CU's read accept it? Each
// check follows the CU's own decoder (firmware/application/src/rfid/nfctag/lf/protocols), so a frame that passes here
// and still doesn't read points at the signal, and one that fails says which part the CU rejects.
//
// Each check returns null (not that protocol), or { name, safe, private }. The safe part says which parts of the frame
// hold and how it is sent. The private part holds the numbers.

import { paradoxFrame, samples16 } from "./lfdemod.js";

const flip = (b) => [...b].map((c) => (c === "1" ? "0" : "1")).join("");
const val = (b, from, n) => parseInt(b.slice(from, from + n), 2);
const ones = (b) => [...b].filter((c) => c === "1").length;
const hex = (b) =>
  b
    .match(/.{1,4}/g)
    .map((n) => parseInt(n, 2).toString(16))
    .join("");

// Readings of the frame as bits, each with how it was read. FSK and PSK frames are bits already; PSK's polarity is
// arbitrary, and some cards invert FSK. An ASK frame is half-bits, read as Manchester (10 is 1) and as biphase (no
// change in the middle is 1), at both pair alignments.
function readings(sig) {
  if (!sig?.frame || !sig.frameBits) return [];
  // with a T55xx's sequence terminator on, read the data without it
  if (sig.terminator)
    return sig.dataFrames.flatMap((f) =>
      readings({
        ...sig,
        terminator: false,
        frame: f,
        halfOffset: 0,
        frameBits: sig.dataBits,
      }),
    );
  const out = [];
  const add = (bits, how) =>
    out.push({ bits, how }, { bits: flip(bits), how: how + ", inverted" });
  if (sig.modulation === "PSK") {
    // The PSK demodulator gives a 1 where the phase changes. The card's bits are the phase itself.
    let p = 0,
      phase = "";
    for (const c of sig.frame) phase += p ^= +c;
    add(phase, "PSK");
  } else if (sig.halfOffset == null) add(sig.frame, sig.modulation);
  else {
    const h = sig.frame + sig.frame;
    for (const o of [0, 1]) {
      let man = "",
        bi = "";
      for (let i = o; man.length < sig.frameBits; i += 2)
        man += h[i] === "1" && h[i + 1] === "0" ? "1" : "0";
      for (let i = o; bi.length < sig.frameBits; i += 2)
        bi += h[i] === h[i + 1] ? "1" : "0";
      add(man, "Manchester");
      add(bi, "biphase");
    }
  }
  return out;
}

// Each rotation of each reading that starts with the preamble, for a frame of the given length.
function* windows(sig, length, preamble) {
  if ((sig.dataBits ?? sig.frameBits) !== length) return;
  for (const r of readings(sig)) {
    const two = r.bits + r.bits;
    for (let i = 0; i < length; i++)
      if (two.startsWith(preamble, i))
        yield { w: two.slice(i, i + length), how: r.how };
  }
}

// The first window whose checks all hold, else the first that has the preamble at all. A preamble can turn up by
// chance in another reading or rotation, so one that only matches the preamble is a weak result.
function best(sig, length, preamble, check) {
  let first = null;
  for (const { w, how } of windows(sig, length, preamble)) {
    const r = check(w, how);
    if (!r) continue;
    if (r.ok) return r;
    first ??= r;
  }
  return first;
}

// ---------------------------------------------------------------- the checks

// HID Prox: FSK RF/50, 96 bits. The preamble 00011101, then 44 bits as Manchester pairs (10 is 1). The CU takes the
// Wiegand length from the 44 bits as pm3 does, then needs a format it knows of that length whose parity holds.
const HID_LENGTHS = {
  26: 2,
  27: 3,
  28: 1,
  29: 1,
  30: 1,
  31: 1,
  32: 5,
  33: 1,
  34: 5,
  35: 1,
  36: 4,
  37: 6,
};
const hid = (sig) =>
  best(sig, 96, "00011101", (w, how) => {
    let raw = "";
    for (let i = 8; i < 96; i += 2) {
      const p = w.slice(i, i + 2);
      if (p !== "10" && p !== "01") return null;
      raw += p === "10" ? "1" : "0";
    }
    // raw is 44 bits, MSB first. Bit 37 (from the LSB) clear means a 37-bit card; else the length is 25 plus the
    // position of the highest set bit among bits 26..36.
    const bit = (n) => raw[43 - n] === "1";
    let length = 37;
    if (bit(37)) {
      length = 25;
      for (let n = 36; n >= 26; n--)
        if (bit(n)) {
          length = n;
          break;
        }
    }
    const card = raw.slice(44 - length);
    // The outer parity of the common layouts: H10301 (26), H10306 (34) and H10302 (37).
    let parity = null;
    if (length === 26 || length === 34) {
      const half = length / 2;
      parity =
        ones(card.slice(0, half)) % 2 === 0 && ones(card.slice(half)) % 2 === 1;
    } else if (length === 37)
      parity =
        ones(card.slice(0, 19)) % 2 === 0 && ones(card.slice(18)) % 2 === 1;
    const cuFormats = HID_LENGTHS[length] ?? 0;
    return {
      name: "HID Prox",
      ok: parity !== false && cuFormats > 0,
      safe: { how, length, cuFormats, parity },
      private: { wiegand: card, raw: hex(raw) },
    };
  });

// ioProx: FSK RF/64, 64 bits. Nine 0s, then bytes each followed by a 1: 0xF0, facility, version, two card bytes and a
// checksum, 0xFF minus the sum of the five before it.
const ioprox = (sig) =>
  best(sig, 64, "0000000001", (w, how) => {
    const b = [9, 18, 27, 36, 45, 54].map((o) => val(w, o, 8));
    const sum = (b[0] + b[1] + b[2] + b[3] + b[4]) & 0xff;
    const header = b[0] === 0xf0,
      checksum = 0xff - sum === b[5];
    return {
      name: "ioProx",
      ok: header && checksum,
      safe: { how, header, checksum },
      private: { facility: b[1], version: b[2], card: (b[3] << 8) | b[4] },
    };
  });

// Farpointe/Pyramid: FSK RF/50, 128 bits. A 24-bit preamble, odd parity on each 8-bit group from bit 8, and a
// CRC-8/MAXIM over bits 16..119 in the last byte.
const pyramid = (sig) =>
  best(sig, 128, "000000000000000100000001", (w, how) => {
    let parity = true;
    for (let g = 8; g < 128; g += 8)
      if (ones(w.slice(g, g + 8)) % 2 === 0) parity = false;
    let crc = 0;
    for (let i = 16; i < 120; i += 8) {
      crc ^= val(w, i, 8);
      for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >> 1) ^ 0x8c : crc >> 1;
    }
    crc = crc === val(w, 120, 8);
    return {
      name: "Farpointe/Pyramid",
      ok: parity && crc,
      safe: { how, parity, crc },
      private: { raw: hex(w) },
    };
  });

// EM410x: ASK, 64 bits. Nine 1s, ten rows of 4 data bits and an even parity bit, 4 even column parity bits, a 0. The
// CU reads it as Manchester at RF/16, RF/32 or RF/64. A frame with more than one row failing isn't counted: nine 1s
// turn up by chance in other cards.
const em410x = (sig) =>
  best(sig, 64, "111111111", (w, how) => {
    if (w[63] !== "0") return null;
    let rowFails = 0,
      id = "";
    for (let r = 0; r < 10; r++) {
      const row = w.slice(9 + 5 * r, 14 + 5 * r);
      if (ones(row) % 2) rowFails++;
      id += row.slice(0, 4);
    }
    if (rowFails > 1) return null;
    let columns = true;
    for (let c = 0; c < 4; c++) {
      let n = w[59 + c] === "1" ? 1 : 0;
      for (let r = 0; r < 10; r++) n += w[9 + 5 * r + c] === "1" ? 1 : 0;
      if (n % 2) columns = false;
    }
    const rows = rowFails === 0;
    const cuReads = how === "Manchester" && [16, 32, 64].includes(sig.rate);
    return {
      name: "EM410x",
      ok: rows && columns,
      safe: { how, rows, columns, rate: sig.rate, cuReads },
      private: { id: hex(id) },
    };
  });

// Viking: ASK Manchester RF/32, 64 bits. The header 0xF20000, 4 data bytes, and a checksum, 0x5A XOR the data bytes.
const viking = (sig) =>
  best(sig, 64, "111100100000000000000000", (w, how) => {
    let crc = 0x5a;
    for (let i = 24; i < 56; i += 8) crc ^= val(w, i, 8);
    const checksum = crc === val(w, 56, 8);
    return {
      name: "Viking",
      ok: checksum,
      safe: { how, checksum },
      private: { id: hex(w.slice(24, 56)) },
    };
  });

// Jablotron: ASK RF/64, 64 bits, differential biphase. Sixteen 1s, a 0, then 5 data bytes (the first starting with
// that 0) and a checksum, their sum XOR 0x3A.
const jablotron = (sig) =>
  best(sig, 64, "11111111111111110", (w, how) => {
    let sum = 0;
    for (let i = 16; i < 56; i += 8) sum += val(w, i, 8);
    const checksum = ((sum & 0xff) ^ 0x3a) === val(w, 56, 8);
    return {
      name: "Jablotron",
      ok: checksum,
      safe: { how, checksum },
      private: { id: hex(w.slice(16, 56)) },
    };
  });

// Indala (PR 509): PSK RF/32, 64 bits. The preamble is bits 0 and 2 and 32 set, the rest of 0..32 clear. FC and card
// sit in fixed bits after it, which the Proxmark decodes whatever the rest holds. Its encoder (and PR 509's) also
// writes two parity bits (34, 38) and a two-bit checksum (62, 63) by a reverse-engineered rule, but the Proxmark never
// checks them on a read, and none of its own sample frames follows that rule in every bit. So the page decodes FC and
// card whenever the preamble is right, and only says whether those bits follow the encoder: not following it isn't
// a fault in the card. It does mean a clone written from FC and card can differ from the card.
const IND_FC = [57, 49, 44, 47, 48, 53, 39, 58];
const IND_CN = [42, 45, 43, 40, 52, 36, 35, 51, 46, 33, 37, 54, 56, 59, 50, 41];
const IND_PRE = "101" + "0".repeat(29) + "1";
// FC and card from a 64-bit Indala frame (a string of 0s and 1s), and whether it has the 26-bit layout.
export function indalaFields(w) {
  const fc = IND_FC.reduce((v, i) => v * 2 + +w[i], 0);
  const cn = IND_CN.reduce((v, i) => v * 2 + +w[i], 0);
  const chk = [14, 12, 9, 8, 6, 5, 2, 0].reduce(
    (n, s) => n + ((cn >> s) & 1),
    0,
  );
  // The encoder computes both parity bits while bits 34 and 38 are still 0.
  let p1 = 1,
    p2 = 1;
  for (let i = 33; i < 64; i++)
    if (i % 2) p1 ^= +w[i];
    else if (i !== 34 && i !== 38) p2 ^= +w[i];
  const encoderBits =
    w[62] === (chk % 2 ? "0" : "1") &&
    w[63] === (chk % 2 ? "1" : "0") &&
    +w[34] === p1 &&
    +w[38] === p2;
  return {
    preamble: w.startsWith(IND_PRE),
    encoderBits,
    facility: fc,
    card: cn,
  };
}
const indala = (sig) =>
  best(sig, 64, IND_PRE, (w, how) => {
    const f = indalaFields(w);
    return {
      name: "Indala",
      ok: true,
      safe: { how, encoderBits: f.encoderBits },
      private: { facility: f.facility, card: f.card, raw: hex(w) },
    };
  });

// Paradox, from lfdemod.js, in the same shape.
function paradox(sig) {
  const p = paradoxFrame(sig);
  if (!p) return null;
  return {
    name: "Paradox",
    ok: p.crcMatches,
    safe: {
      how: p.inverted ? "FSK, inverted" : "FSK",
      crc: p.crcMatches,
      standardLayout: p.standardLayout,
    },
    private: {
      facility: p.facility,
      card: p.card,
      crc: p.crc,
      expectedCrc: p.expectedCrc,
    },
  };
}

export function frameChecks(sig) {
  if (!sig || sig.modulation === "none") return [];
  const all =
    sig.modulation === "FSK"
      ? [hid, paradox, ioprox, pyramid]
      : sig.modulation === "PSK"
        ? [indala]
        : [em410x, viking, jablotron];
  const found = all.map((f) => f(sig)).filter(Boolean);
  // When one protocol's checks all hold, the others' preambles are chance.
  return found.some((c) => c.ok) ? found.filter((c) => c.ok) : found;
}

// One line for the safe report.
export function frameCheckLine(c) {
  const s = c.safe;
  const yes = (b, good, bad) => (b ? good : bad);
  switch (c.name) {
    case "HID Prox":
      return (
        `HID preamble and Manchester pairs valid, ${s.length}-bit Wiegand` +
        (s.parity == null
          ? ""
          : yes(s.parity, ", outer parity holds", ", outer parity fails")) +
        (s.cuFormats
          ? `; the CU knows ${s.cuFormats} format(s) of this length`
          : "; the CU knows no format of this length, so its HID read gives nothing")
      );
    case "Paradox":
      return `Paradox preamble and Manchester pairs valid, CRC ${yes(s.crc, "matches", "doesn't match")}, ${yes(s.standardLayout, "standard", "non-standard")} layout`;
    case "ioProx":
      return `ioProx preamble valid, header ${yes(s.header, "valid", "wrong")}, checksum ${yes(s.checksum, "matches", "doesn't match")}`;
    case "Farpointe/Pyramid":
      return `Pyramid preamble valid, group parity ${yes(s.parity, "holds", "fails")}, CRC ${yes(s.crc, "matches", "doesn't match")}`;
    case "EM410x":
      return (
        `EM410x header valid as ${s.how}, row parity ${yes(s.rows, "holds", "fails")}, column parity ${yes(s.columns, "holds", "fails")}` +
        yes(
          s.cuReads,
          "",
          `; the CU's EM410x read only takes Manchester at RF/16, 32 or 64, and this is ${s.how} at RF/${s.rate}`,
        )
      );
    case "Viking":
      return `Viking header valid as ${s.how}, checksum ${yes(s.checksum, "matches", "doesn't match")}`;
    case "Jablotron":
      return `Jablotron header valid as ${s.how}, checksum ${yes(s.checksum, "matches", "doesn't match")}`;
    case "Indala":
      return (
        // PSK has no fixed polarity, so which reading matched says nothing about the card.
        "Indala preamble valid, " +
        yes(
          s.encoderBits,
          "parity and checksum bits as the Proxmark's encoder writes them",
          "parity and checksum bits don't follow the Proxmark's encoder (it doesn't check them on a read, and its own sample cards vary)",
        )
      );
  }
  return c.name;
}

// ---------------------------------------------------------------- what the signal's shape fits

// Protocols by modulation, bit rate and frame length, from the cards a Proxmark wrote and the CU recorded. `cu` marks
// those the identify build has a read for.
const SHAPES = [
  [
    "FSK",
    50,
    96,
    [
      ["HID Prox", 1],
      ["Paradox", 1],
      ["AWID", 0],
    ],
  ],
  ["FSK", 50, 128, [["Farpointe/Pyramid", 1]]],
  ["FSK", 64, 64, [["ioProx", 1]]],
  [
    "ASK",
    64,
    64,
    [
      ["EM410x", 1],
      ["Jablotron", 1],
    ],
  ],
  ["ASK", 64, 96, [["Guardall G-Prox II", 0]]],
  [
    "ASK",
    32,
    64,
    [
      ["Viking", 1],
      ["EM410x at RF/32", 1],
    ],
  ],
  [
    "ASK",
    32,
    96,
    [
      ["Gallagher", 0],
      ["Noralsy", 0],
    ],
  ],
  [
    "ASK",
    32,
    128,
    [
      ["FDX-B", 0],
      ["PAC/Stanley", 1],
    ],
  ],
  ["ASK", 40, 96, [["Securakey", 0]]],
  [
    "PSK",
    32,
    64,
    [
      ["Indala", 1],
      ["Keri", 0],
      ["IDTECK", 0],
    ],
  ],
  ["PSK", 32, 96, [["NexWatch", 0]]],
  ["PSK", 32, 224, [["Indala 224-bit", 0]]],
];
export function shapeFits(sig) {
  if (!sig?.frameBits) return null;
  const m = SHAPES.find(
    ([mod, rate, bits]) =>
      mod === sig.modulation &&
      rate === sig.rate &&
      bits === (sig.dataBits ?? sig.frameBits),
  );
  if (!m) return null;
  return m[3].map(([n, cu]) => n + (cu ? "" : " (no CU read)"));
}

// ---------------------------------------------------------------- the EM4x05 answer

// After the chip probe's EM4x05 read of word 0, an EM4x05 sends 00001010 and then the word: four rows of 8 bits, each
// with an even parity bit, a row of 8 even column parity bits, and a 0. It sends it in its own modulation, then goes
// back to its card. The word is least significant bit first. Word 0 holds the chip type (bits 1-4), the resonant
// capacitor (5-6) and the customer code (9-18), as the Proxmark's `lf em 4x05 info` reads them.
const EM_TYPES = { 4: "EM4469", 8: "EM4205", 9: "EM4305", 12: "EM4369" };
const EM_CAPS = ["no resonant capacitor", "250 pF", "210 pF", "330 pF"];
export function em4x05Answer(probe) {
  if (!probe?.stream || probe.modulation === "none") return null;
  const s = probe.stream.slice(0, 1200);
  const streams = [];
  if (probe.modulation === "PSK") {
    let p = 0,
      ph = "";
    for (const c of s) ph += p ^= +c;
    streams.push(ph);
  } else if (probe.halfOffset != null)
    for (const o of [0, 1]) {
      let man = "",
        bi = "";
      for (let i = o; i + 1 < s.length; i += 2) {
        man += s[i] === "1" && s[i + 1] === "0" ? "1" : "0";
        bi += s[i] === s[i + 1] ? "1" : "0";
      }
      streams.push(man, bi);
    }
  else streams.push(s);
  for (const t of streams)
    for (const b of [t, flip(t)])
      for (
        let o = b.indexOf("00001010");
        o >= 0 && o + 53 <= b.length;
        o = b.indexOf("00001010", o + 1)
      ) {
        const f = b.slice(o + 8, o + 53);
        let ok = f[44] === "0",
          data = "";
        for (let r = 0; r < 4 && ok; r++) {
          const g = f.slice(9 * r, 9 * r + 9);
          if (ones(g) % 2) ok = false;
          data += g.slice(0, 8);
        }
        for (let c = 0; c < 8 && ok; c++) {
          let n = +f[36 + c];
          for (let r = 0; r < 4; r++) n += +f[9 * r + c];
          if (n % 2) ok = false;
        }
        if (!ok) continue;
        const word = [...data].reduce((v, c, i) => v + +c * 2 ** i, 0);
        return {
          word: word.toString(16).padStart(8, "0"),
          chip:
            EM_TYPES[(word >>> 1) & 0xf] ??
            `unknown EM4x05 type ${(word >>> 1) & 0xf}`,
          capacitor: EM_CAPS[(word >>> 5) & 3],
          customerCode: (word >>> 9) & 0x2ff,
        };
      }
  return null;
}

// ---------------------------------------------------------------- the Hitag 2 answer

// After the chip probe's Hitag 2 start command (START_AUTH, 11000), a Hitag 2 or Hitag S tag answers once, about
// 7 ms into the capture on a CU: a header of 1 bits (5 from a real Hitag 2) and its 32-bit serial, Manchester-coded at
// 32 carrier cycles per bit, so 16 samples per half bit. The decoder finds the longest stretch where the signal stays
// above or below zero for one or two half bits at a time, reads it as Manchester, and takes the serial from the 32
// bits after the header. The capture's first 4.8 ms hold the CU's own settling and are skipped.
const HT_FROM = 600,
  HT_TO = 4400,
  HT_HALF = 16;
export function hitag2Answer(bytes) {
  const x = samples16(bytes);
  if (x.length < HT_TO + 512) return null;
  const quiet = [...x.slice(HT_TO)].sort((a, b) => a - b);
  const mid = quiet[quiet.length >> 1];
  const r = x.slice(HT_FROM, HT_TO).map((v) => v - mid);
  const dev = quiet.map((v) => Math.abs(v - mid)).sort((a, b) => a - b);
  const noise = dev[dev.length >> 1] + 1;
  const mags = [...r].map(Math.abs).sort((a, b) => a - b);
  const peak = mags[Math.floor(0.99 * (mags.length - 1))];
  if (peak < 10 * noise) return null;
  // The sign with hysteresis, as runs of [level, samples].
  const t = 0.3 * peak;
  const runs = [];
  let level = 0;
  for (const v of r) {
    const now = v > t ? 1 : v < -t ? -1 : level;
    if (now !== level || !runs.length) runs.push([now, 0]);
    level = now;
    runs.at(-1)[1]++;
  }
  // The longest stretch of runs one or two half bits long.
  const halves = (n) =>
    n >= 0.6 * HT_HALF && n <= 1.4 * HT_HALF ? 1 : n >= 1.6 * HT_HALF && n <= 2.4 * HT_HALF ? 2 : 0;
  let best = [0, 0];
  for (let i = 0, start = 0; i <= runs.length; i++)
    if (i === runs.length || runs[i][0] === 0 || !halves(runs[i][1])) {
      if (i - start > best[1] - best[0]) best = [start, i];
      start = i + 1;
    }
  let hs = "";
  for (const [lv, n] of runs.slice(best[0], best[1])) hs += (lv > 0 ? "H" : "L").repeat(halves(n));
  if (hs.length < 2 * 37) return null;
  for (const polarity of ["HL", "LH"])
    for (const phase of [0, 1]) {
      let bits = "";
      for (let k = phase; k + 1 < hs.length; k += 2) {
        const p = hs.slice(k, k + 2);
        if (p === polarity) bits += "1";
        else if (p[0] !== p[1]) bits += "0";
        else break;
      }
      const lead = bits.match(/^1*/)[0].length;
      const header = Math.min(lead, bits.length - 32);
      if (header < 5) continue;
      const serial = bits.slice(header, header + 32);
      return { header, serial: parseInt(serial, 2).toString(16).padStart(8, "0"), bits: bits.length };
    }
  return null;
}

// ---------------------------------------------------------------- the T55xx configuration block

const T55_RATES = [8, 16, 32, 40, 50, 64, 100, 128];
const T55_MODS = {
  0: "direct (NRZ)",
  1: "PSK1",
  2: "PSK2",
  3: "PSK3",
  4: "FSK1",
  5: "FSK2",
  6: "FSK1a",
  7: "FSK2a",
  8: "Manchester",
  16: "biphase",
  24: "biphase ('57)",
};
const family = (m) => (m === 0 || m >= 8 ? "ASK" : m <= 3 ? "PSK" : "FSK");

// Page 0 block 0 of a T5577, as the T5577 datasheet lays it out: master key (0-3), bit rate (11-13, or 10-15 in
// extended mode), modulation (15-19), PSK sub-carrier (20-21), answer on request (22), blocks sent (24-26), password
// mode (27), sequence terminator (28), inverted data (30, extended mode), power-on delay (31).
export function t55Config(word) {
  const b = word.toString(2).padStart(32, "0");
  const key = val(b, 0, 4);
  const extended = key === 6 || key === 9;
  const mod = val(b, 15, 5);
  return {
    word: word.toString(16).padStart(8, "0"),
    key,
    extended,
    rate: extended ? 2 * val(b, 10, 6) + 2 : T55_RATES[val(b, 11, 3)],
    modulation: mod,
    modulationName: T55_MODS[mod] ?? `unknown (${mod})`,
    pskClock: [2, 4, 8, 0][val(b, 20, 2)],
    answerOnRequest: b[22] === "1",
    maxBlock: val(b, 24, 3),
    password: b[27] === "1",
    sequenceTerminator: b[28] === "1",
    inverted: extended && b[30] === "1",
    powerOnDelay: b[31] === "1",
    basicZeros: extended || val(b, 4, 7) === 0,
  };
}

// The configuration block from the probe's capture. The tag repeats the 32-bit block with no marker, so the start is
// unknown: keep the rotations whose configuration is self-consistent and matches the card's own signal (its
// modulation family and bit rate, and for ASK Manchester or biphase as read). Null unless they all agree.
export function t55ConfigFromProbe(probe, card) {
  // 36 bits: the block and a 4-bit sequence terminator after it
  const n = probe?.frameBits;
  if ((n !== 32 && n !== 36) || !card?.modulation) return null;
  const withTerminator = n === 36;
  const found = new Set();
  for (const r of readings({ ...probe, terminator: false })) {
    const two = r.bits + r.bits;
    for (let i = 0; i < n; i++) {
      const c = t55Config(
        parseInt(
          withTerminator ? two.slice(i + 4, i + 36) : two.slice(i, i + 32),
          2,
        ),
      );
      if (
        !T55_MODS[c.modulation] ||
        !c.basicZeros ||
        ![0, 6, 9].includes(c.key)
      )
        continue;
      if (family(c.modulation) !== card.modulation || c.rate !== card.rate)
        continue;
      // the block's own terminator bit must agree with the answer
      if (c.sequenceTerminator !== withTerminator) continue;
      if (card.modulation === "ASK" && c.modulation !== 0) {
        const man = c.modulation === 8;
        if (r.how.startsWith("Manchester") !== man) continue;
      }
      found.add(c.word);
    }
  }
  return found.size === 1 ? t55Config(parseInt([...found][0], 16)) : null;
}

export function t55ConfigLine(c) {
  const parts = [c.modulationName, `RF/${c.rate}`];
  if (c.modulation >= 1 && c.modulation <= 3)
    parts.push(`sub-carrier RF/${c.pskClock}`);
  parts.push(`${c.maxBlock} data block${c.maxBlock === 1 ? "" : "s"}`);
  parts.push(c.password ? "password mode on" : "password mode off");
  if (c.sequenceTerminator) parts.push("sequence terminator on");
  if (c.answerOnRequest) parts.push("answers only on request");
  if (c.inverted) parts.push("inverted data");
  if (c.extended) parts.push("extended mode");
  if (c.powerOnDelay) parts.push("power-on delay");
  return parts.join(", ");
}
