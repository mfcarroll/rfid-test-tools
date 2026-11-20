// node selftest.mjs: the mode names and nicknames, the command 3188 parse and request, the backup check and the
// copy's read-back.
import * as H from "./hitag-modes.js";

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

// The eight combinations of three bits.
check(
  H.CHOICES.join(",") === "0,1,4,5,8,9,12,13",
  "eight mode combinations, bit 0x02 left out",
);
check(
  H.MODE_BITS === (H.SCALE | H.ALT_PROTOCOL | H.REST_LOADED),
  "the mode bits cover scale, every-second and rest-loaded",
);
check(H.modeName(0) === "baseline", "mode 0 is baseline");
check(
  H.modeName(H.SCALE | H.ALT_PROTOCOL) === "scale + every-second",
  "mode names join the set flags",
);
check(
  H.modeName(13) === "scale + every-second + rest-loaded",
  "mode 13 names all three",
);
check(H.modeNick(0) === "Hitag 2 base", "baseline nickname");
check(
  H.modeNick(H.SCALE | H.ALT_PROTOCOL) === "Hitag 2 S+E",
  "nickname abbreviates the flags",
);
check(H.modeNick(13) === "Hitag 2 S+E+L", "all-three nickname");
check(
  H.DEFAULT_MODES.join(",") === "0,1,4,5,8,9,12,13",
  "default plan gives each slot one combination",
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

// The copy's read-back: the card, the firmware's made-up card, or anything else.
{
  const card = Uint8Array.from(
    { length: H.HITAG2_DATA_SIZE },
    (_, i) => 0x40 + i,
  );
  const longer = Uint8Array.from([...card, 0, 0]); // a reply may carry trailing bytes
  check(H.checkCopy(longer, card) === "card", "checkCopy finds the card");
  check(
    H.checkCopy(H.DEFAULT_CARD, card) === "default",
    "checkCopy names the firmware's made-up card",
  );
  const near = card.slice();
  near[31] ^= 1;
  check(H.checkCopy(near, card) === "other", "checkCopy rejects one bit off");
  check(H.checkCopy(null, card) === "other", "checkCopy rejects no data");
  check(
    H.checkCopy(card.slice(0, 16), card) === "other",
    "checkCopy rejects short data",
  );
}

process.exit(failed ? 1 : 0);
