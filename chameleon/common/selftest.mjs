// node selftest.mjs: the command client recovers after a reply that lost bytes on the way, and the slot check
// (fsk.js) says which slots hold the copied card.
import { FrameClient, makeFrame } from "./cu.js";
import { DEFAULT_CARD, checkCards, checkText } from "./fsk.js";

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

// A CU that answers every command with a reply of the same command, through the client's feed(). drop says how many
// bytes to cut from the middle of the next reply.
class FakeLink extends FrameClient {
  drop = 0;
  replySize = 0;
  async send(bytes) {
    const cmd = (bytes[2] << 8) | bytes[3];
    let reply = makeFrame(cmd, 0x68, new Uint8Array(this.replySize).fill(0x5a));
    if (this.drop) {
      reply = Uint8Array.from([
        ...reply.slice(0, 100),
        ...reply.slice(100 + this.drop),
      ]);
      this.drop = 0;
    }
    // in 64-byte pieces, as USB delivers it
    setTimeout(() => {
      for (let i = 0; i < reply.length; i += 64)
        this.feed(reply.slice(i, i + 64));
    }, 1);
  }
}

const cu = new FakeLink();
cu.replySize = 3804;
cu.drop = 640;
let err = null;
try {
  await cu.cmd(3186, Uint8Array.of(0, 0), 0.1);
} catch (e) {
  err = e;
}
check(
  err?.message === "no reply to 3186",
  "a 3814-byte reply that lost 640 bytes times out",
);

cu.replySize = 4;
const r = await cu.cmd(3184, new Uint8Array(0), 0.1).catch(() => null);
check(
  r?.cmd === 3184 && r.data.length === 4,
  "the next command's reply arrives after the timeout",
);

// The slot check: which slots hold the copied card. A made-up Paradox card stands in for a real one.
const P = 203,
  card = Uint8Array.from([0x1e, 0xc0, 0x54, 0x40, 0xa1, 0xb0]),
  dflt = Uint8Array.from(DEFAULT_CARD[P]);
const slots = (list) =>
  list.map((c, slot) => ({ slot, type: c ? P : 0, card: c }));
const held = (list, ref) =>
  checkCards(slots(list), ref)
    .map((h) => h.held)
    .join(" ");
check(
  held([card, card, card], { type: P, card }) === "card card card",
  "every slot holds the copied card",
);
check(
  held([dflt, card, card, dflt, card, card, card], null) ===
    "default card card default card card card",
  "without the source, the card most slots hold is the reference",
);
check(
  held([dflt, dflt], null) === "default default",
  "slots that all hold the made-up card are not ready",
);
check(
  held([card, null], { type: P, card }) === "card empty",
  "an empty slot is reported",
);
check(
  checkText(checkCards(slots([dflt, card, card, dflt]), null)) ===
    "⚠ Slots 1 and 4 hold the firmware's made-up card. Don't test with them: copy the card into the slots again first.",
  "the warning names the slots",
);
check(
  checkText(checkCards(slots([card, card]), { type: P, card })) ===
    "Slots 1 and 2 both hold the same card.",
  "the all-clear names the slots",
);
check(
  checkText(
    checkCards(slots([card, card, card, card, card, card, card]), null),
  ) === "Slots 1–7 all hold the same card.",
  "a run of slots reads as a range",
);
check(
  checkText(checkCards(slots([dflt, card, card, card, dflt, dflt]), null)) ===
    "⚠ Slots 1, 5 and 6 hold the firmware's made-up card. Don't test with them: copy the card into the slots again first.",
  "a run of two stays a list",
);

process.exit(failed ? 1 : 0);
