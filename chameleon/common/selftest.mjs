// node selftest.mjs: the command client recovers after a reply that lost bytes on the way.
import { FrameClient, makeFrame } from "./cu.js";

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

process.exit(failed ? 1 : 0);
