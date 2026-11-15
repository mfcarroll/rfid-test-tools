// Connecting a Chameleon Ultra over Web Serial, shared by the Chameleon pages. Each page keeps its connection in
// its own variable and passes it in.

import { SerialCU } from "./cu.js";
import { $, log, hasWebSerial } from "../../common/page.js";

// Asks the person to pick their CU, closes previous (the page's last connection) and opens the CU picked. Returns
// the open SerialCU, or null if the browser has no Web Serial. If the person cancels, previous stays open. If the
// CU picked fails to open, previous is already closed. Either way the reason goes on #connectinfo, and the error
// is thrown.
export async function openCU(previous) {
  if (!hasWebSerial()) return null;
  try {
    const port = await navigator.serial.requestPort();
    await previous?.close();
    const cu = new SerialCU();
    await cu.open(port);
    return cu;
  } catch (e) {
    $("connectinfo").textContent = `Couldn't connect: ${e.message}`;
    throw e;
  }
}

// A CU that restarts, or is unplugged, disappears from USB. If current() is the CU that disappeared, this closes
// it, says so on #connectinfo and in the log, and calls gone(). The page then shows that rather than letting the
// next command time out.
export function watchDisconnect(current, gone) {
  navigator.serial?.addEventListener("disconnect", (e) => {
    const cu = current();
    if (!cu || e.target !== cu.port) return;
    cu.close();
    $("connectinfo").textContent =
      "The CU disconnected. Plug it in and connect again.";
    log("the CU disconnected");
    gone();
  });
}
