// node selftest.mjs: lfdemod.js against captures of made-up cards that a Proxmark wrote to a T5577, read on a CU
// with the identify build. Each line is the protocol's modulation, rate and frame length.
import { readFileSync } from "node:fs";
import { analyse, paradoxFrame, t55xxAnswer, traceBlock } from "./lfdemod.js";
import {
  em4x05Answer,
  frameChecks,
  frameCheckLine,
  shapeFits,
  t55Config,
  t55ConfigFromProbe,
} from "./framecheck.js";
import * as X from "./identify.js";

const WANT = {
  hid: ["FSK", 50, 96],
  paradox: ["FSK", 50, 96],
  awid: ["FSK", 50, 96],
  pyramid: ["FSK", 50, 128],
  ioprox: ["FSK", 64, 64],
  em410x: ["ASK", 64, 64],
  jablotron: ["ASK", 64, 64],
  gproxii: ["ASK", 64, 96],
  viking: ["ASK", 32, 64],
  gallagher: ["ASK", 32, 96],
  fdxb: ["ASK", 32, 128],
  securakey: ["ASK", 40, 96],
  noralsy: ["ASK", 32, 96],
  pac: ["ASK", 32, 128],
  indala: ["PSK", 32, 64],
  keri: ["PSK", 32, 64],
  idteck: ["PSK", 32, 64],
  nexwatch: ["PSK", 32, 96],
};
// Noralsy's frame length comes out wrong (100). It is listed so the failure stays visible.
// The Proxmark clones Noralsy with the T5577's sequence terminator on, so its frame is 96 data bits and the
// terminator's 4: 100 on air. The table holds the data length.
const KNOWN = new Set();

const dir = new URL("./fixtures/", import.meta.url);
let bad = 0;
for (const [name, [mod, rate, frame]] of Object.entries(WANT)) {
  const r = analyse(readFileSync(new URL(`${name}.bin`, dir)));
  const ok =
    r.modulation === mod &&
    r.rate === rate &&
    (r.dataBits ?? r.frameBits) === frame;
  if (!ok && !KNOWN.has(name)) bad++;
  console.log(
    `${ok ? "ok  " : KNOWN.has(name) ? "known" : "FAIL"} ${name.padEnd(10)} ${r.modulation} ${r.detail ?? ""} RF/${r.rate} ` +
      `frame ${r.frameBits} (want ${mod} RF/${rate} frame ${frame})`,
  );
}
const plain = analyse(readFileSync(new URL("fdxb.bin", dir)));
const t = t55xxAnswer(
  readFileSync(new URL("t55xx-probe-fdxb.bin", dir)),
  plain,
);
// The Proxmark dumped this T5577's trace block (page 1 block 1) as e03900d0.
const tOk = t.answer === "yes" && t.block === "e03900d0";
console.log(
  `${tOk ? "ok  " : "FAIL"} T55xx answers the chip probe: ${t.answer}, block ${t.block} (want e03900d0)`,
);
if (!tOk) bad++;
// The same chip configured as Paradox answers in FSK.
const fp = t55xxAnswer(
  readFileSync(new URL("t55xx-probe-paradox.bin", dir)),
  analyse(readFileSync(new URL("paradox.bin", dir))),
);
const fpOk = fp.answer === "yes" && fp.block === "e03900d0";
console.log(
  `${fpOk ? "ok  " : "FAIL"} T55xx answers in FSK: ${fp.answer}, block ${fp.block} (want e03900d0)`,
);
if (!fpOk) bad++;
// On CU1 the page once reported e009f402, the Manchester reading of the same answer. The block must come out right
// whichever pair alignment the capture's analysis chose, at every rotation.
let biOk = true;
for (let lv = 1, half = "", i = 0; i < 32; i++) {
  lv ^= 1;
  half += lv;
  if (
    "e03900d0"
      .split("")
      .map((c) => parseInt(c, 16).toString(2).padStart(4, "0"))
      .join("")[i] === "0"
  )
    lv ^= 1;
  half += lv;
  if (i < 31) continue;
  for (let rot = 0; rot < 64; rot++)
    for (const halfOffset of [0, 1]) {
      const b = traceBlock({
        frame: half.slice(rot) + half.slice(0, rot),
        halfOffset,
        frameBits: 32,
      });
      if (b !== "e03900d0") biOk = false;
    }
}
console.log(
  `${biOk ? "ok  " : "FAIL"} the trace block reads e03900d0 at every rotation and alignment`,
);
if (!biOk) bad++;
const n = t55xxAnswer(readFileSync(new URL("fdxb.bin", dir)), plain);
console.log(
  `${n.answer === "no" ? "ok  " : "FAIL"} a plain capture is no answer: ${n.answer}`,
);
if (n.answer !== "no") bad++;

// CU1's Paradox reply (PR 489's read) for the made-up card FC 123, card 4567, CRC 0x9c.
const px = X.LF_SCANS.find((s) => s.name === "Paradox").parse(
  Uint8Array.from([0x00, 0x1e, 0xc4, 0x75, 0xe7, 0x30]),
);
const pxOk =
  px.private.facility === 123 &&
  px.private.card === 4567 &&
  px.private.crc === 0x9c;
console.log(
  `${pxOk ? "ok  " : "FAIL"} Paradox reply parses: FC ${px.private.facility}, card ${px.private.card}, CRC ${px.private.crc}`,
);
if (!pxOk) bad++;

// The Paradox frame check on the page. The fixture is FC 96, card 40426, checksum 0xb2 by the Proxmark. With one
// data pair flipped (10 to 01) the frame keeps its shape and the CRC stops matching. Other FSK cards aren't Paradox.
const pxSig = analyse(readFileSync(new URL("paradox.bin", dir)));
const pf = paradoxFrame(pxSig);
const pfOk =
  pf?.crcMatches &&
  pf.standardLayout &&
  pf.facility === 96 &&
  pf.card === 40426 &&
  pf.crc === 0xb2;
console.log(
  `${pfOk ? "ok  " : "FAIL"} Paradox frame check: ${JSON.stringify(pf)}`,
);
if (!pfOk) bad++;
const at = (pxSig.frame + pxSig.frame).indexOf("00001111") % 96;
const rot = pxSig.frame.slice(at) + pxSig.frame.slice(0, at);
const pos = 8 + 2 * 30; // a card bit
const flipped =
  rot.slice(0, pos) +
  (rot.slice(pos, pos + 2) === "10" ? "01" : "10") +
  rot.slice(pos + 2);
const pb = paradoxFrame({ ...pxSig, frame: flipped });
const pbOk = pb && !pb.crcMatches && pb.standardLayout;
console.log(
  `${pbOk ? "ok  " : "FAIL"} a changed Paradox frame keeps its shape and fails the CRC: ${JSON.stringify(pb)}`,
);
if (!pbOk) bad++;
// A Flipper emulating Paradox with the data 112233445566, whose CRC doesn't match: PR 489's read finds nothing, and
// the check reports the frame. With one bit slipped into the stream no frame repeats, and it still finds one.
const fl = analyse(
  readFileSync(new URL("flipper-paradox-112233445566.bin", dir)),
);
const flWant = (p) =>
  p &&
  !p.crcMatches &&
  !p.standardLayout &&
  p.facility === 136 &&
  p.card === 52497 &&
  p.crc === 85;
const fp1 = paradoxFrame(fl);
console.log(
  `${flWant(fp1) ? "ok  " : "FAIL"} a Paradox frame with a bad CRC is reported: ${JSON.stringify(fp1)}`,
);
if (!flWant(fp1)) bad++;
const mid = fl.stream.length >> 1;
const fp2 = paradoxFrame({
  ...fl,
  frameBits: null,
  frame: null,
  stream: fl.stream.slice(0, mid) + "1" + fl.stream.slice(mid),
});
console.log(
  `${flWant(fp2) ? "ok  " : "FAIL"} it is found in the stream when no frame repeats`,
);
if (!flWant(fp2)) bad++;
const others = ["hid", "awid", "pyramid", "ioprox"].filter((n) =>
  paradoxFrame(analyse(readFileSync(new URL(n + ".bin", dir)))),
);
console.log(
  `${others.length ? "FAIL" : "ok  "} other FSK cards aren't Paradox${others.length ? `: ${others}` : ""}`,
);
if (others.length) bad++;

// The safe report must hold no private field. A report with a HID read (FC 123, card 4567), the HID capture's frame
// and an HF card, then every private value searched for in the safe Markdown.
const hidReply = Uint8Array.from(
  "010000007b00000011d7000000000000".match(/../g),
  (h) => parseInt(h, 16),
);
const hidScan = X.LF_SCANS.find((s) => s.name === "HID Prox");
const hf = X.parseHf14a(
  Uint8Array.from("04a1b2c3d4040008 00".replace(" ", "").match(/../g), (h) =>
    parseInt(h, 16),
  ),
);
const rep = {
  firmware: "test",
  lf: {
    named: [{ name: "HID Prox", ...hidScan.parse(hidReply) }],
    signal: analyse(readFileSync(new URL("hid.bin", dir))),
  },
  hf: { cards: hf },
};
const safe = X.safeMarkdown(rep);
const pxRep = {
  firmware: "test",
  lf: { named: [], signal: pxSig, checks: frameChecks(pxSig) },
  hf: null,
};
const pxSafe = X.safeMarkdown(pxRep);
const pxLeaks = ["40426", "178", pxSig.frame.slice(0, 24)].filter((v) =>
  pxSafe.includes(v),
);
const pxFull = X.fullMarkdown(pxRep).includes('"facility":96,"card":40426');
console.log(
  `${!pxLeaks.length && pxFull ? "ok  " : "FAIL"} the Paradox fields are only in the full report${pxLeaks.length ? `: ${pxLeaks}` : ""}`,
);
if (pxLeaks.length || !pxFull) bad++;
console.log(
  pxSafe
    .split("\n")
    .filter((l) => l.includes("Paradox"))
    .join("\n"),
);
const leaks = [
  "123",
  "4567",
  "a1b2c3d4",
  rep.lf.signal.frame.slice(0, 24),
].filter((v) => safe.includes(v));
console.log(
  `${leaks.length ? "FAIL" : "ok  "} the safe report holds no private value${leaks.length ? `: ${leaks}` : ""}`,
);
if (leaks.length) bad++;
const full = X.fullMarkdown(rep);
const shown = ["123", "4567", "a1b2c3d4"].every((v) => full.includes(v));
console.log(`${shown ? "ok  " : "FAIL"} the full report holds them`);
if (!shown) bad++;
// Frame checks: each card the CU reads has its frame found, with every check holding, and the values the Proxmark
// wrote. The others match none.
const CHECKS = {
  em410x: ["EM410x", { id: "1234567890" }],
  hid: ["HID Prox", { wiegand: "10111101100010001110101110" }],
  indala: ["Indala", { facility: 123, card: 1337, raw: "a00000008f49d2a1" }],
  ioprox: ["ioProx", { facility: 83, card: 1337 }],
  jablotron: ["Jablotron", { id: "1234567890" }],
  paradox: ["Paradox", { facility: 96, card: 40426 }],
  pyramid: ["Farpointe/Pyramid", {}],
  viking: ["Viking", { id: "1a337f9c" }],
};
for (const n of [
  "awid",
  "fdxb",
  "gallagher",
  "gproxii",
  "idteck",
  "keri",
  "nexwatch",
  "noralsy",
  "pac",
  "securakey",
  ...Object.keys(CHECKS),
]) {
  const c = frameChecks(analyse(readFileSync(new URL(n + ".bin", dir))));
  const want = CHECKS[n];
  const ok = want
    ? c.length === 1 &&
      c[0].name === want[0] &&
      c[0].ok &&
      Object.entries(want[1]).every(([k, v]) => c[0].private[k] === v)
    : c.length === 0;
  console.log(
    `${ok ? "ok  " : "FAIL"} frame check ${n.padEnd(10)} ${c.map(frameCheckLine).join(" | ") || "none"}`,
  );
  if (!ok) bad++;
}
const fits = shapeFits(analyse(readFileSync(new URL("hid.bin", dir))));
const fitsOk = fits?.join() === "HID Prox,Paradox,AWID (no CU read)";
console.log(
  `${fitsOk ? "ok  " : "FAIL"} a 96-bit FSK RF/50 frame fits ${fits}`,
);
if (!fitsOk) bad++;

// The T55xx configuration blocks the Proxmark dumped: FDX-B and Paradox clones.
const cf = t55Config(0x00098080),
  cp = t55Config(0x00107060);
const cfgOk =
  cf.modulationName === "biphase ('57)" &&
  cf.rate === 32 &&
  cf.maxBlock === 4 &&
  !cf.password &&
  cp.modulationName === "FSK2a" &&
  cp.rate === 50 &&
  cp.maxBlock === 3 &&
  !cp.password;
console.log(
  `${cfgOk ? "ok  " : "FAIL"} T55xx configuration blocks decode: ${cf.modulationName} RF/${cf.rate}, ${cp.modulationName} RF/${cp.rate}`,
);
if (!cfgOk) bad++;

// CU1's read of the configuration block (probe 3) on the T5577 written as Paradox. The Proxmark's block 0 for a
// Paradox clone is 00107060.
const cfgProbe = t55ConfigFromProbe(
  analyse(readFileSync(new URL("t55xx-config-paradox.bin", dir))),
  analyse(readFileSync(new URL("paradox.bin", dir))),
);
const cfgProbeOk = cfgProbe?.word === "00107060";
console.log(
  `${cfgProbeOk ? "ok  " : "FAIL"} the configuration probe reads ${cfgProbe?.word} (want 00107060)`,
);
if (!cfgProbeOk) bad++;

// Noralsy 112233 on the T5577, with the sequence terminator on (as the Proxmark clones it) and then off (block 0
// rewritten from 00088068 to 00088060). With it on, the card's frame is 100 bits and the T5577's answers are 36.
{
  const on = analyse(readFileSync(new URL("noralsy.bin", dir)));
  const off = analyse(readFileSync(new URL("noralsy-no-terminator.bin", dir)));
  const ta = t55xxAnswer(
    readFileSync(new URL("t55xx-probe-noralsy-st.bin", dir)),
    on,
  );
  const tb = t55xxAnswer(
    readFileSync(new URL("t55xx-probe-noralsy-no-terminator.bin", dir)),
    off,
  );
  const ca = t55ConfigFromProbe(
    analyse(readFileSync(new URL("t55xx-config-noralsy-st.bin", dir))),
    on,
  );
  const cb = t55ConfigFromProbe(
    analyse(
      readFileSync(new URL("t55xx-config-noralsy-no-terminator.bin", dir)),
    ),
    off,
  );
  const checks = [
    [
      on.frameBits === 100 && on.terminator && on.dataBits === 96,
      `terminator on: frame ${on.frameBits}, data ${on.dataBits}`,
    ],
    [
      off.frameBits === 96 && !off.terminator,
      `terminator off: frame ${off.frameBits}`,
    ],
    [
      shapeFits(on)?.join() === "Gallagher (no CU read),Noralsy (no CU read)",
      `terminator on fits ${shapeFits(on)}`,
    ],
    [
      ta.answer === "yes" && ca?.word === "00088068",
      `terminator on: T55xx ${ta.answer}, configuration ${ca?.word}`,
    ],
    [
      tb.answer === "yes" && cb?.word === "00088060",
      `terminator off: T55xx ${tb.answer}, configuration ${cb?.word}`,
    ],
    [
      traceBlock(tb.probe, cb) === "e03900d0",
      `terminator off, Manchester: trace block ${traceBlock(tb.probe, cb)}`,
    ],
    [
      traceBlock(ta.probe, ca) === null,
      `terminator on: trace block ${traceBlock(ta.probe, ca)} (this capture can't give it)`,
    ],
  ];
  for (const [ok, what] of checks) {
    console.log(`${ok ? "ok  " : "FAIL"} Noralsy, ${what}`);
    if (!ok) bad++;
  }
}

// HF replies as the CU sends them: UID length, UID, ATQA least significant byte first, SAK, ATS length, ATS. The
// types and ATS are those a Gen4 card gave on CU1, with made-up UIDs. The page shows ATQA most significant first.
{
  const reply = (h) =>
    Uint8Array.from(h.replace(/ /g, "").match(/../g), (x) => parseInt(x, 16));
  const HF = [
    [
      "04 a1b2c3d4 0400 08 00",
      "0004",
      "MIFARE Classic 1K or Plus 2K in SL1",
      "",
    ],
    [
      "07 04a1b2c3d4e5f6 4400 08 00",
      "0044",
      "MIFARE Classic 1K (7-byte UID) or Plus 2K in SL1",
      "",
    ],
    [
      "07 04a1b2c3d4e5f6 4200 18 00",
      "0042",
      "MIFARE Classic 4K or Plus 4K in SL1",
      "",
    ],
    ["07 04a1b2c3d4e5f6 4400 00 00", "0044", "MIFARE Ultralight or NTAG", ""],
    [
      "07 04a1b2c3d4e5f6 4403 20 09 0978009102dabc1910",
      "0344",
      "MIFARE DESFire",
      "0978009102dabc1910",
    ],
  ];
  for (const [h, atqa, guess, ats] of HF) {
    const [c] = X.parseHf14a(reply(h));
    const ok = c.atqa === atqa && X.hfGuess(c) === guess && c.ats === ats;
    console.log(
      `${ok ? "ok  " : "FAIL"} HF ATQA ${c.atqa} SAK ${c.sak.toString(16).padStart(2, "0")}: ${X.hfGuess(c)}`,
    );
    if (!ok) bad++;
  }
}

// PR 509's Indala reply for the made-up card.
const ix = X.LF_SCANS.find((s) => s.name === "Indala").parse(
  Uint8Array.from(Buffer.from("a00000008f49d2a1", "hex")),
);
const ixOk =
  ix.safe.format === "64-bit" &&
  ix.private.facility === 123 &&
  ix.private.card === 1337;
console.log(
  `${ixOk ? "ok  " : "FAIL"} Indala reply parses: ${JSON.stringify(ix)}`,
);
if (!ixOk) bad++;

// The EM4x05 answer, built here: 00001010, then word 0 as every EM4305 with a 330 pF capacitor and the default
// customer code has it (0x00040072), least significant bit first, in rows of 8 with even parity, the column parity
// and a 0. Sent as FSK bits, inverted, after some of the card's own bits.
{
  const word = 0x00040072;
  let f = "";
  const rows = [];
  for (let r = 0; r < 4; r++) {
    let g = "";
    for (let i = 0; i < 8; i++) g += (word >>> (8 * r + i)) & 1;
    rows.push(g);
    f += g + ([...g].filter((c) => c === "1").length % 2);
  }
  for (let c = 0; c < 8; c++) f += rows.reduce((n, g) => n + +g[c], 0) % 2;
  f += "0";
  const flipB = (b) => [...b].map((c) => (c === "1" ? "0" : "1")).join("");
  const stream = flipB(
    "0110100111010010" + "00001010" + f + "1101001011010010".repeat(4),
  );
  const a = em4x05Answer({ modulation: "FSK", halfOffset: null, stream });
  const ok =
    a?.word === "00040072" &&
    a.chip === "EM4305" &&
    a.capacitor === "330 pF" &&
    a.customerCode === 512;
  console.log(
    `${ok ? "ok  " : "FAIL"} an EM4x05 answer decodes: ${JSON.stringify(a)}`,
  );
  if (!ok) bad++;
  const none = ["indala", "hid", "em410x", "fdxb", "t55xx-probe-fdxb"].filter(
    (n) => em4x05Answer(analyse(readFileSync(new URL(n + ".bin", dir)))),
  );
  console.log(
    `${none.length ? "FAIL" : "ok  "} no EM4x05 answer in other captures${none.length ? `: ${none}` : ""}`,
  );
  if (none.length) bad++;
}

process.exit(bad ? 1 : 0);
