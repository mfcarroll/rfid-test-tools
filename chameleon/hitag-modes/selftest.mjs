// node selftest.mjs: the mode names and nicknames, the command 3188 parse and request, and the backup check.
import * as H from "./hitag-modes.js";

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

// The sixteen combinations are 0..15 of four bits.
check(H.CHOICES.length === 16, "sixteen mode combinations");
check(
  H.MODE_BITS === (H.SCALE | H.ALT_DELAY | H.ALT_PROTOCOL | H.REST_UNLOADED),
  "the mode bits cover scale, alt-delay, every-second and rest-unloaded",
);
check(H.modeName(0) === "baseline", "mode 0 is baseline");
check(
  H.modeName(H.SCALE | H.ALT_PROTOCOL) === "scale + every-second",
  "mode names join the set flags",
);
check(
  H.modeName(15) === "scale + alt-delay + every-second + rest-unloaded",
  "mode 15 names all four",
);
check(H.modeNick(0) === "Hitag 2 base", "baseline nickname");
check(
  H.modeNick(H.SCALE | H.ALT_PROTOCOL) === "Hitag 2 S+E",
  "nickname abbreviates the flags",
);
check(H.modeNick(15) === "Hitag 2 S+D+E+R", "all-four nickname");
check(
  H.DEFAULT_MODES.join(",") === "1,3,5,7,9,11,13,15",
  "default plan keeps scale on and sweeps the other three bits",
);

// Command 3188: parse the eight returned modes, build the eight-byte request.
const wire = Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 99); // a trailing byte must be ignored
check(
  H.parseModes(wire).join(",") === "0,1,2,3,4,5,6,7",
  "parseModes reads 8 modes",
);
check(
  H.hex(H.reqSetModes([7, 6, 5, 4, 3, 2, 1, 0])) === "0706050403020100",
  "reqSetModes is eight bytes",
);
let threw = false;
try {
  H.parseModes(Uint8Array.of(0, 1, 2));
} catch {
  threw = true;
}
check(threw, "parseModes rejects a short reply");

// hex/unhex round-trip a 32-byte card.
const card = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) & 0xff);
check(H.hex(H.unhex(H.hex(card))) === H.hex(card), "hex/unhex round-trip");

// The backup check accepts a well-formed file and rejects others.
const good = {
  kind: H.BACKUP_KIND,
  version: 1,
  slots: Array.from({ length: 8 }, (_, s) => ({ slot: s })),
};
check(H.checkBackup(good) === good, "checkBackup accepts a good file");
for (const bad of [
  { ...good, kind: "something else" },
  { ...good, version: 2 },
  { ...good, slots: good.slots.slice(0, 7) },
]) {
  let rej = false;
  try {
    H.checkBackup(bad);
  } catch {
    rej = true;
  }
  check(rej, "checkBackup rejects a bad file");
}

process.exit(failed ? 1 : 0);
