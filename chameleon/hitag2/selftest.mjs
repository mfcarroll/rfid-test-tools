// Checks the trace parser and the report logic against synthetic records. Run: node selftest.mjs
import * as H from "./hitag2.js";

let failed = 0;
const check = (cond, msg) => {
  if (!cond) {
    failed++;
    console.log("FAIL", msg);
  }
};

// Builds a 268-byte record. opts: {type, verdict, decode, flags, n_bits, bits, n_tx_bits, txBits, n_gaps, t_us}.
function rec(opts = {}) {
  const b = new Uint8Array(268);
  const dv = new DataView(b.buffer);
  b[0] = opts.type ?? 3;
  b[1] = opts.verdict ?? 0;
  b[2] = opts.decode ?? 0;
  b[3] = opts.flags ?? 0;
  dv.setUint32(4, opts.t_us ?? 0, true);
  dv.setUint16(28, opts.n_gaps ?? (opts.n_bits ? opts.n_bits + 1 : 0), true);
  dv.setUint16(30, opts.n_bits ?? 0, true);
  dv.setUint16(32, opts.n_tx_bits ?? 0, true);
  const putBits = (off, s) => {
    for (let i = 0; i < (s?.length ?? 0); i++) if (s[i] === "1") b[off + (i >> 3)] |= 1 << (7 - (i & 7));
  };
  putBits(44, opts.bits);
  putBits(60, opts.txBits);
  return b;
}

// parseRec round-trips the fields.
{
  const r = H.parseRec(rec({ type: 3, verdict: 1, n_bits: 5, bits: "11000", n_tx_bits: 37, txBits: "1".repeat(5) + "0".repeat(32), flags: 1 }));
  check(r.type === 3 && r.verdict === 1 && r.n_bits === 5 && r.bits === "11000", "parseRec bits");
  check(r.n_tx_bits === 37 && r.txBits.startsWith("11111"), "parseRec txBits");
  check(r.late === true, "parseRec late flag");
  check(H.commandRole(r) === "START_AUTH", "role START_AUTH");
}
check(H.commandRole(H.parseRec(rec({ n_bits: 32 }))) === "password", "role password");
check(H.commandRole(H.parseRec(rec({ n_bits: 64 }))) === "crypto", "role crypto");
check(H.commandRole(H.parseRec(rec({ n_bits: 10 }))) === "read", "role read");
check(H.commandRole(H.parseRec(rec({ decode: 1 }))) === "undecoded", "role undecoded");

// A full password-mode read: field, START_AUTH answered, password answered, 8 reads answered.
{
  const recs = [
    rec({ type: 1 }),
    rec({ verdict: 1, n_bits: 5, bits: "11000" }),
    rec({ verdict: 1, n_bits: 32, bits: "0".repeat(32) }),
    ...Array.from({ length: 8 }, () => rec({ verdict: 1, n_bits: 10 })),
    rec({ type: 2 }),
  ].map(H.parseRec);
  const c = H.classify(recs);
  check(c.fields === 1 && c.startAuth === 1 && c.uidRead === 1, "full: field + UID");
  check(c.password === 1 && c.passwordMatched === 1 && c.reads === 8, "full: password + reads");
  check(H.headline(c, "01020304").includes("end to end"), "full: headline");
}

// UID read, password did not match (the common case for a tester with an unknown reader password).
{
  const recs = [
    rec({ type: 1 }),
    rec({ verdict: 1, n_bits: 5, bits: "11000" }),
    rec({ verdict: 0, n_bits: 32 }),
  ].map(H.parseRec);
  const c = H.classify(recs);
  check(c.uidRead === 1 && c.password === 1 && c.passwordMatched === 0, "mismatch: counts");
  check(H.headline(c, "01020304").includes("did not match"), "mismatch: headline");
  const safe = H.safeMarkdown({ firmware: "test", uid: "01020304", counts: c });
  check(safe.includes("matched the emulated password: no"), "mismatch: safe report");
  check(!safe.includes("11000"), "safe report holds no reader bits");
}

// Crypto reader: UID read, then a 64-bit command.
{
  const recs = [
    rec({ type: 1 }),
    rec({ verdict: 1, n_bits: 5, bits: "11000" }),
    rec({ verdict: 0, n_bits: 64 }),
  ].map(H.parseRec);
  const c = H.classify(recs);
  check(c.crypto === 1 && H.headline(c, "01020304").includes("crypto"), "crypto: headline");
}

// No field, and a field with no START_AUTH.
check(H.headline(H.classify([]), "01020304").includes("No reader field"), "empty: headline");
check(
  H.headline(H.classify([rec({ type: 1 })].map(H.parseRec)), "01020304").includes("not be a Hitag 2 reader"),
  "field only: headline",
);

// The private report shows a command's bits; the safe report never does.
{
  const recs = [rec({ verdict: 0, n_bits: 32, bits: "10101010".repeat(4) })].map(H.parseRec);
  const report = { firmware: "t", uid: "01020304", counts: H.classify(recs), recs };
  check(H.privateMarkdown(report).includes("10101010101010101010101010101010"), "private shows bits");
  check(!H.safeMarkdown(report).includes("10101010"), "safe hides bits");
}

// parseTraceChunk reads the header and splits records.
{
  const payload = new Uint8Array(7 + 2 * 268);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 5, true);
  dv.setUint16(4, 268, true);
  payload[6] = 2;
  payload[7] = 3; // first record's type
  payload[7 + 268] = 1; // second record's type
  const { total, size, n, recs } = H.parseTraceChunk(payload);
  check(total === 5 && size === 268 && n === 2 && recs.length === 2, "parseTraceChunk header");
  check(recs[0][0] === 3 && recs[1][0] === 1, "parseTraceChunk split");
}

// parseHex4 accepts 8 hex, rejects the rest.
check(H.hex(H.parseHex4("01020304", "UID")) === "01020304", "parseHex4 round-trip");
try {
  H.parseHex4("0102", "UID");
  check(false, "parseHex4 should reject short input");
} catch {}

console.log(failed ? `${failed} checks failed` : "selftest ok");
process.exit(failed ? 1 : 0);
