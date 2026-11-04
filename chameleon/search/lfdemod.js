// LF signal analysis for the identify page: from one raw capture, the modulation, the bit rate, the frame length and
// one frame's bits. No DOM, no Web Serial in here.
//
// The input is the CU's 16-bit lf sniff capture, one sample per carrier cycle (125 kHz). A rate is in carrier
// cycles per bit (RF/50 is 50). The tests are tried in order: FSK, then ASK, then PSK, and the first that fits wins.

export const RATES = [8, 16, 32, 40, 50, 64, 100, 128];

// 16-bit big-endian samples, as the firmware sends them.
export function samples16(bytes) {
  const n = bytes.length >> 1;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = (bytes[2 * i] << 8) | bytes[2 * i + 1];
  return x;
}

// A moving average over k samples, centred as numpy's convolve(..., "same") centres it.
function box(x, k) {
  const n = x.length,
    out = new Float64Array(n),
    pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  const back = Math.floor((k - 1) / 2);
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n, i + back + 1),
      lo = Math.max(0, i + back + 1 - k);
    out[i] = (pre[hi] - pre[lo]) / k;
  }
  return out;
}

function mean(a) {
  let s = 0;
  for (const v of a) s += v;
  return a.length ? s / a.length : 0;
}

function std(a) {
  const m = mean(a);
  let s = 0;
  for (const v of a) s += (v - m) ** 2;
  return a.length ? Math.sqrt(s / a.length) : 0;
}

// numpy's default (linear) percentile
function percentile(a, p) {
  const s = Float64Array.from(a).sort();
  const r = (p / 100) * (s.length - 1),
    lo = Math.floor(r);
  return lo + 1 < s.length ? s[lo] + (r - lo) * (s[lo + 1] - s[lo]) : s[lo];
}

// The period, in bits, at which the bit stream repeats, and how well it repeats (1 = exactly). A bit misread once
// lowers every multiple of the period a little differently, so the shortest period within 0.02 of the best wins.
export function frameLength(bits, top = 260) {
  const n = bits.length;
  const all = [];
  for (let P = 16; P < Math.min(Math.floor(n / 2), top); P++) {
    let c = 0;
    for (let i = 0; i + P < n; i++)
      c += (2 * bits[i] - 1) * (2 * bits[i + P] - 1);
    all.push({ bits: P, match: c / (n - P) });
  }
  if (!all.length) return null;
  const top1 = Math.max(...all.map((a) => a.match));
  return all.find((a) => a.match >= top1 - 0.02);
}

// FSK with fc/8 and fc/10 tones (FSK2a, as HID, AWID, Paradox and ioProx use). The sub-carrier's periods come from
// the rising crossings of the high-passed signal.
export function fsk(x) {
  const base = box(x, 25);
  const h = box(
    Float64Array.from(x, (v, i) => v - base[i]),
    2,
  );
  const up = [];
  for (let i = 0; i + 1 < h.length; i++)
    if (h[i] < 0 && h[i + 1] >= 0) up.push(i);
  const all = [];
  for (let i = 1; i < up.length; i++) all.push(up[i] - up[i - 1]);
  const p = all.filter((v) => v >= 4 && v <= 14);
  if (p.length < 50) return null;
  const hist = new Array(15).fill(0);
  for (const v of p) hist[v]++;
  const share =
    [5, 6, 7, 8, 9, 10, 11].reduce((s, k) => s + hist[k], 0) / p.length;
  const lo = (hist[7] + hist[8]) / p.length,
    hi = (hist[9] + hist[10] + hist[11]) / p.length;
  if (share < 0.85 || lo < 0.15 || hi < 0.15) return null;
  // one tone per sub-carrier period, then the bit length from how long each tone lasts
  const tone = all.map((v) => (v >= 9 ? 1 : 0));
  const pos = up.slice(1);
  const e = [];
  for (let i = 1; i < tone.length; i++) if (tone[i] !== tone[i - 1]) e.push(i);
  const cyc = [];
  for (let i = 1; i < e.length; i++) {
    const d = pos[e[i]] - pos[e[i - 1]];
    if (d > 20) cyc.push(d);
  }
  if (!cyc.length) return null;
  let rate = null,
    bestErr = Infinity;
  for (const R of RATES) {
    const err =
      mean(cyc.map((c) => Math.abs(c / R - Math.round(c / R)))) +
      (R < 32 ? 0.02 : 0);
    if (err < bestErr) [rate, bestErr] = [R, err];
  }
  const bits = [];
  for (let k = 0; k + 1 < e.length; k++) {
    const n = Math.round((pos[e[k + 1]] - pos[e[k]]) / rate);
    for (let j = 0; j < n; j++) bits.push(tone[e[k]]);
  }
  return { modulation: "FSK", detail: "fc/8 and fc/10", rate, bits };
}

// ASK. The envelope is sliced halfway between its quiet and loud levels. The slicer makes high and low runs
// unequal, so the rate comes from rise-to-rise intervals, where that bias cancels. Runs of one and two units fit both
// Manchester at R and NRZ at R/2: Manchester wins when every interval is 2-4 half-bits.
export function ask(x) {
  const env = box(x, 4);
  const lo = percentile(env, 5),
    hi = percentile(env, 95);
  if (hi - lo < 0.3 * hi) return null;
  const mid = (lo + hi) / 2;
  const b = Uint8Array.from(env, (v) => (v > mid ? 1 : 0));
  const up = [],
    dn = [];
  for (let i = 0; i + 1 < b.length; i++) {
    if (!b[i] && b[i + 1]) up.push(i + 1);
    if (b[i] && !b[i + 1]) dn.push(i + 1);
  }
  if (up.length < 20) return null;
  const iv = [];
  for (let i = 1; i < up.length; i++) iv.push(up[i] - up[i - 1]);
  let best = null;
  for (const R of RATES) {
    for (const [code, unit, allowed, pref] of [
      ["Manchester or biphase", R / 2, [2, 3, 4], 0.03],
      ["NRZ", R, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 0],
    ]) {
      const q = iv.map((v) => Math.round(v / unit));
      const fit =
        iv.filter(
          (v, i) => Math.abs(v / unit - q[i]) < 0.25 && allowed.includes(q[i]),
        ).length / iv.length;
      if (!best || fit + pref > best.fit + best.pref)
        best = { fit, code, rate: R, unit, q, pref };
    }
  }
  if (best.fit < 0.9) return null;
  // NRZ symbols: each rise-to-rise interval is a high part then a low part
  const sym = [];
  let d = 0;
  for (let k = 0; k + 1 < up.length; k++) {
    while (d < dn.length && dn[d] <= up[k]) d++;
    const n = best.q[k];
    if (d >= dn.length || dn[d] >= up[k + 1] || n < 2) continue;
    const h = Math.min(
      Math.max(Math.round((dn[d] - up[k]) / best.unit), 1),
      n - 1,
    );
    for (let j = 0; j < n; j++) sym.push(j < h ? 1 : 0);
  }
  const nrz = best.code === "NRZ";
  const centred = nrz ? null : riseSym(up, best.unit);
  return {
    modulation: "ASK",
    detail: best.code,
    rate: best.rate,
    fit: best.fit,
    nrz,
    sym: centred ? centred.sym : sym,
    offset: centred?.offset ?? 0,
    sliced: b,
  };
}

function majorityFrame(bits, P) {
  const ones = new Array(P).fill(0),
    n = new Array(P).fill(0);
  for (let i = P; i < bits.length; i++) {
    ones[i % P] += bits[i];
    n[i % P]++;
  }
  return ones.map((o, j) => (2 * o > n[j] ? 1 : 0)).join("");
}

// Half-bits rebuilt from the rises alone. On a loud card the CU's front end shows each rise as a clean step and then
// decays towards zero, so the falls in the sliced signal are early and only the rises carry timing. Between two rises
// the level falls once. Manchester and biphase never hold a level for more than two half-bits, and at one of the two
// pair alignments every pair changes level. So a gap of 2 half-bits is 10, 4 is 1100, and 3 is 110 or 100, whichever
// keeps that alignment's pairs changing.
function riseSym(up, unit) {
  const at = up.map((u) => Math.round((u - up[0]) / unit));
  let best = null;
  for (const offset of [0, 1]) {
    const sym = [];
    let bad = 0;
    for (let k = 0; k + 1 < at.length; k++) {
      const n = at[k + 1] - at[k];
      if (n < 2 || n > 4) {
        bad++;
        for (let j = 0; j < n; j++) sym.push(j === 0 ? 1 : 0);
        continue;
      }
      const start = sym.length;
      const options = n === 3 ? [1, 2] : [n / 2];
      let pick = options[0];
      for (const h of options) {
        const seg = Array.from({ length: n }, (_, j) => (j < h ? 1 : 0));
        let ok = true;
        for (let p = start; p < start + n; p++) {
          if ((p - offset) % 2 !== 1 || p === 0) continue;
          const prev = p - 1 >= start ? seg[p - 1 - start] : sym[p - 1];
          if (prev === seg[p - start]) ok = false;
        }
        if (ok) {
          pick = h;
          break;
        }
      }
      for (let j = 0; j < n; j++) sym.push(j < pick ? 1 : 0);
    }
    let eq = 0,
      t = 0;
    for (let p = offset; p + 1 < sym.length; p += 2, t++)
      if (sym[p] === sym[p + 1]) eq++;
    const share = (eq + bad) / Math.max(t, 1);
    if (!best || share < best.share) best = { share, sym, offset };
  }
  return best;
}

// One frame of half-bits, decoded both ways, as hex. As Manchester, a pair 10 is 1 and 01 is 0 (some tags use the
// opposite, which is the same hex inverted). As biphase, a bit with no change in the middle is 1.
export function decodeHalfBits(half, offset) {
  const man = [],
    bi = [];
  for (let i = offset; i + 1 < half.length; i += 2)
    man.push(half[i] === "1" && half[i + 1] === "0" ? 1 : 0);
  for (let i = 1 - offset; i + 1 < half.length; i += 2)
    bi.push(half[i] === half[i + 1] ? 1 : 0);
  return { manchester: toHex(man), biphase: toHex(bi) };
}
function toHex(bits) {
  let h = "";
  for (let i = 0; i + 4 <= bits.length; i += 4)
    h += (
      (bits[i] << 3) |
      (bits[i + 1] << 2) |
      (bits[i + 2] << 1) |
      bits[i + 3]
    ).toString(16);
  return h;
}

// PSK on an fc/2 sub-carrier (PSK1, as Indala, Keri and NexWatch use), from a carrier-locked capture: two samples per
// sub-carrier cycle. Multiplying by (-1)^n moves the sub-carrier to DC, and a [1, 2, 1] filter removes the carrier
// ripple that the multiply moves to fs/2. Then each bit is integrated, at the bit offset whose weakest bits are
// strongest.
export function psk(x) {
  const m = mean(x);
  const raw = Float64Array.from(x, (v, i) => (i % 2 ? -(v - m) : v - m));
  const y = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++)
    y[i] =
      (i > 0 ? raw[i - 1] : 0) +
      2 * raw[i] +
      (i + 1 < raw.length ? raw[i + 1] : 0);
  const pre = new Float64Array(y.length + 1);
  for (let i = 0; i < y.length; i++) pre[i + 1] = pre[i] + y[i];
  // The best bit offset at each rate.
  const atRate = [];
  for (const R of [16, 32, 64]) {
    let b = null;
    for (let off = 0; off < R; off += 2) {
      const v = [];
      for (let a = off; a + R <= y.length; a += R) v.push(pre[a + R] - pre[a]);
      if (v.length < 40) continue;
      const mag = v.map(Math.abs);
      const score = percentile(mag, 10) / (mean(mag) + 1e-9);
      if (!b || score > b.score) b = { score, rate: R, v };
    }
    if (b) {
      // PSK1: a phase flip marks a 1
      b.bits = [];
      for (let i = 1; i < b.v.length; i++)
        b.bits.push(b.v[i] > 0 !== b.v[i - 1] > 0 ? 1 : 0);
      const P = frameLength(b.bits);
      b.repeats = P && P.match > 0.9 ? P.bits : null;
      atRate.push(b);
    }
  }
  // Integrating over half a bit scores about as well as over a whole one, so the score alone can pick twice the true
  // rate. The frame decides: at half the bit time a frame repeats at twice its length, so prefer the longer bit
  // whose frame repeats at half the bits. Otherwise the best score, preferring one whose frame repeats.
  let best = atRate.reduce(
    (a, b) =>
      !a ||
      (b.repeats && !a.repeats) ||
      (!!b.repeats === !!a.repeats && b.score > a.score)
        ? b
        : a,
    null,
  );
  for (const b of atRate)
    if (
      b.rate === 2 * best?.rate &&
      b.score > 0.5 &&
      (!best.repeats || b.repeats * 2 === best.repeats)
    )
      best = b;
  if (!best || best.score < 0.25) return null;
  const bits = best.bits;
  return {
    modulation: "PSK",
    detail: "fc/2 sub-carrier",
    rate: best.rate,
    score: best.score,
    bits,
  };
}

// The whole analysis of one capture. The result's safe fields (modulation, detail, rate, frameBits, level, depth)
// say nothing about the card's number. Its frame field is one frame's bits, which can be the credential.
export function analyse(bytes) {
  const x = samples16(bytes).subarray(200); // the field's start-up ringing
  if (x.length < 2000)
    return { modulation: "none", reason: "capture too short" };
  const out = {
    level: Math.round(mean(x)),
    depth: +(std(x) / mean(x)).toFixed(3),
  };
  let r = fsk(x);
  let bits = r?.bits;
  if (!r) {
    r = ask(x);
    if (r) bits = r.sym;
  }
  if (!r) {
    r = psk(x);
    bits = r?.bits;
  }
  if (!r) return { ...out, modulation: "none" };
  const P = frameLength(bits, r.modulation === "ASK" ? 520 : 260);
  const repeats = P && P.match > 0.9;
  const perBit = r.modulation === "ASK" && !r.nrz ? 2 : 1;
  const frame = repeats ? majorityFrame(bits, P.bits) : null;
  const halfOffset = perBit === 2 ? (r.offset + P.bits) % 2 : null;
  return {
    ...out,
    modulation: r.modulation,
    detail: r.detail,
    rate: r.rate,
    frameBits: repeats ? P.bits / perBit : null,
    // one frame of 0s and 1s, from an arbitrary point in the frame; half-bits for Manchester or biphase. Each bit
    // is the majority across every repetition in the capture, so a bit misread once doesn't show.
    frame,
    halfOffset,
    ...(frame && halfOffset != null ? terminator(frame, halfOffset) : {}),
    // every bit in the capture (FSK bits, ASK half-bits, PSK phase changes), for checks that look for one frame
    // anywhere: Paradox when no frame repeats cleanly, and an EM4x05's answer at the start of a probe capture
    stream: bits.join(""),
  };
}

// A T55xx's sequence terminator: when it's on, the tag sends a 4-bit marker after each pass through its data, so the
// frame repeats every data length plus 4 bits. The marker breaks the modulation. At the pair alignment where every
// pair of a Manchester or biphase frame changes level, up to 4 bits in one stretch don't. Returns the data length and
// the frame's half-bits with the marker cut out, starting just after it, once for each place it could start.
function terminator(frame, off) {
  const n = frame.length / 2;
  const bad = [];
  const h = frame + frame;
  for (let b = 0; b < n; b++)
    if (h[off + 2 * b] === h[off + 2 * b + 1]) bad.push(b);
  if (!bad.length || bad.length > 4 || n < 36) return {};
  // the stretch can wrap past the end of the frame
  let first = bad[0],
    span = bad[bad.length - 1] - bad[0];
  for (let i = 1; i < bad.length; i++)
    if (bad[i - 1] + n - bad[i] < span) {
      first = bad[i];
      span = bad[i - 1] + n - bad[i];
    }
  if (span > 3) return {};
  const cuts = [];
  for (let s = first + span - 3; s <= first; s++) {
    const start = off + 2 * ((((s + 4) % n) + n) % n);
    cuts.push((frame + frame).slice(start, start + 2 * (n - 4)));
  }
  return { terminator: true, dataBits: n - 4, dataFrames: cuts };
}

// T55xx check. After the chip probe's read of page 1 block 1, a T55xx sends that block over and over, in its own
// modulation, instead of its card. So its signal repeats every 32 bits. The verdict compares the probe's capture with
// a plain capture of the same card: "yes" if the probe's repeats at 32 bits and the card's own frame doesn't,
// "unclear" if the card's own frame is 32 bits, else "no".
export function t55xxAnswer(probeBytes, plain) {
  const p = analyse(probeBytes);
  // With the sequence terminator on (seen in the card's own frame), the block repeats every 36 bits.
  const answered =
    p.frameBits === 32 || (p.frameBits === 36 && plain?.terminator);
  if (!answered) return { answer: "no", probe: p };
  if ((plain?.dataBits ?? plain?.frameBits) === 32)
    return { answer: "unclear", probe: p };
  return { answer: "yes", probe: p, block: traceBlock(p) };
}

// The trace block itself: a reading of the answer whose 32 bits start with 0xE0. It holds the chip's maker and
// serial number, so it belongs with the private details. The configuration block, when the page has it, says how the
// tag modulates, so only that reading is tried. Without it, biphase comes before Manchester at both pair alignments:
// the Manchester reading of a biphase answer can also start with 0xE0 (e03900d0 reads as e009f402). With the sequence
// terminator on (a 36-bit answer), the block is the 32 bits after the terminator, at each place it could be, and
// only a single match counts.
export function traceBlock(p, config) {
  if (!p?.frame) return null;
  const n = p.frameBits;
  const withTerminator = n === 36;
  const reads = [];
  if (p.halfOffset != null) {
    // Each reading counts the pairs that break its encoding: a Manchester bit whose halves are equal, or a biphase
    // boundary with no change. The reading that fits best goes first.
    const h = p.frame + p.frame;
    for (const o of [0, 1]) {
      let man = "",
        bi = "",
        manBad = 0,
        biBad = 0;
      for (let i = o; man.length < n; i += 2) {
        man += h[i] === "1" && h[i + 1] === "0" ? "1" : "0";
        bi += h[i] === h[i + 1] ? "1" : "0";
        if (h[i] === h[i + 1]) manBad++;
        if (h[i + 1] === h[i + 2]) biBad++;
      }
      reads.push(
        { bits: bi, how: "biphase", bad: biBad },
        { bits: man, how: "Manchester", bad: manBad },
      );
    }
    reads.sort(
      (x, y) =>
        x.bad - y.bad || (x.how === y.how ? 0 : x.how === "biphase" ? -1 : 1),
    );
  } else if (p.modulation === "PSK") {
    // the PSK demodulator gives a 1 where the phase changes, and the block is the phase itself
    let ph = 0,
      bits = "";
    for (const c of p.frame) bits += ph ^= +c;
    reads.push({ bits, how: "PSK" });
  } else reads.push({ bits: p.frame, how: p.modulation });
  const kind =
    !config || config.modulation < 8
      ? null
      : config.modulation === 8
        ? "Manchester"
        : "biphase";
  for (const r of reads) {
    if (kind && r.how !== kind) continue;
    for (const b of [
      r.bits,
      [...r.bits].map((c) => (c === "1" ? "0" : "1")).join(""),
    ]) {
      const two = b + b;
      if (!withTerminator) {
        for (let i = 0; i < 32; i++)
          if (two.startsWith("11100000", i))
            return parseInt(two.slice(i, i + 32), 2)
              .toString(16)
              .padStart(8, "0");
      } else {
        const found = new Set();
        for (let s = 0; s < 36; s++)
          if (two.startsWith("11100000", s + 4))
            found.add(
              parseInt(two.slice(s + 4, s + 36), 2)
                .toString(16)
                .padStart(8, "0"),
            );
        if (found.size === 1) return [...found][0];
      }
    }
  }
  return null;
}

// The Paradox frame check, from PR 489's decoder (paradox.c), for when its read finds nothing. That read accepts a
// frame only if its CRC matches, so a card with a Paradox frame and some other checksum reads as nothing there. This
// looks at the FSK frame itself: a 96-bit frame, the preamble 00001111, then 44 bits as Manchester pairs (10 is 1, 01
// is 0). Then it checks the CRC (CRC-8/MAXIM with a final XOR of 0x06, over the 68 encoded bits before the CRC, with
// four zero bits in front) and the layout PR 489's client calls canonical (the first 10 data bits 0, the last 2 bits
// 1). It tries each rotation of the repeating frame. If no frame repeats cleanly, as when the card moves during the
// capture, it tries each stretch of the bit stream that has the preamble and another preamble 96 bits later, as PR
// 489's decoder does. Null if none has the preamble and 44 valid pairs, in either polarity.
export function paradoxFrame(sig) {
  if (sig?.modulation !== "FSK") return null;
  const windows = [];
  for (const inverted of [false, true]) {
    const flip = (b) =>
      inverted ? [...b].map((c) => (c === "1" ? "0" : "1")).join("") : b;
    if (sig.frameBits === 96 && sig.frame) {
      const f = flip(sig.frame);
      for (let r = 0; r < 96; r++)
        windows.push([f.slice(r) + f.slice(0, r), inverted]);
    } else if (sig.stream) {
      const s = flip(sig.stream);
      for (
        let o = s.indexOf("00001111");
        o >= 0 && o + 104 <= s.length;
        o = s.indexOf("00001111", o + 1)
      )
        if (s.startsWith("00001111", o + 96))
          windows.push([s.slice(o, o + 96), inverted]);
    }
  }
  for (const [w, inverted] of windows) {
    if (!w.startsWith("00001111")) continue;
    const data = [];
    for (let i = 0; i < 44; i++) {
      const pair = w.slice(8 + 2 * i, 10 + 2 * i);
      if (pair !== "10" && pair !== "01") break;
      data.push(pair === "10" ? 1 : 0);
    }
    if (data.length < 44) continue;
    const field = (from, n) =>
      data.slice(from, from + n).reduce((v, b) => v * 2 + b, 0);
    const enc = "0000" + w.slice(8, 76);
    let crc = 0;
    for (let i = 0; i < enc.length; i += 8) {
      crc ^= parseInt(enc.slice(i, i + 8), 2);
      for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >> 1) ^ 0x8c : crc >> 1;
    }
    crc ^= 0x06;
    const stored = field(34, 8);
    return {
      crcMatches: stored === crc,
      standardLayout: field(0, 10) === 0 && field(42, 2) === 3,
      inverted,
      facility: field(10, 8),
      card: field(18, 16),
      crc: stored,
      expectedCrc: crc,
    };
  }
  return null;
}
