// Connecting a Chameleon Ultra over Web Serial or Web Bluetooth, shared by the Chameleon pages. Each page keeps its
// connection in its own variable and passes it in.

import { SerialCU } from "./cu.js";
import { BleCU, hasWebBluetooth, requestCU } from "./ble.js";
import { $, log, hasWebSerial, connectCard } from "../../common/page.js";

const LINK_KEY = "cu-link";

// The link the Connect step's #link list names: "usb" or "ble".
export const chosenLink = () =>
  /** @type {HTMLSelectElement | null} */ ($("link"))?.value === "ble"
    ? "ble"
    : "usb";

// The pages' watchDisconnect() registrations. A Bluetooth CU reports its own drop, so openCU() needs the list too.
const watchers = [];

/** @param {any} cu @param {string} msg */
function reportGone(cu, msg) {
  for (const w of watchers) {
    if (w.current() !== cu) continue;
    cu.close();
    $("connectinfo").textContent = msg;
    log("the CU disconnected");
    w.gone();
  }
}

async function openBle(previous) {
  if (!hasWebBluetooth()) {
    $("connectinfo").textContent =
      "This browser can't reach Bluetooth devices. Use Chrome or Edge, or Bluefy on an iPhone.";
    return null;
  }
  const device = await requestCU();
  await previous?.close();
  const cu = new BleCU();
  cu.ongone = () =>
    reportGone(
      cu,
      "The CU disconnected. Wake it with a button and connect again.",
    );
  await cu.open(device);
  return cu;
}

async function openSerial(previous) {
  if (!hasWebSerial()) return null;
  const port = await navigator.serial.requestPort();
  await previous?.close();
  const cu = new SerialCU();
  await cu.open(port);
  return cu;
}

// Asks the person to pick their CU over the link the Connect step names, closes previous (the page's last
// connection) and opens the CU picked. Returns the open SerialCU or BleCU, or null if the browser can't reach that
// link. If the person cancels, previous stays open. If the CU picked fails to open, previous is already closed. Either
// way the reason goes on #connectinfo, and the error is thrown.
export async function openCU(previous) {
  try {
    return chosenLink() === "ble"
      ? await openBle(previous)
      : await openSerial(previous);
  } catch (e) {
    $("connectinfo").textContent = `Couldn't connect: ${e.message}`;
    throw e;
  }
}

// A CU that restarts, is unplugged or goes out of Bluetooth range disconnects. If current() is the CU that
// disconnected, this closes it, says so on #connectinfo and in the log, and calls gone(). The page then shows that
// rather than letting the next command time out.
export function watchDisconnect(current, gone) {
  watchers.push({ current, gone });
  navigator.serial?.addEventListener("disconnect", (e) => {
    const cu = current();
    if (cu instanceof SerialCU && e.target === cu.port)
      reportGone(cu, "The CU disconnected. Plug it in and connect again.");
  });
}

// The link list in the Connect step: USB, or Bluetooth. It starts on the person's last choice, or on Bluetooth if the
// browser has no USB access (a phone).
function addLinkChoice() {
  const select = document.createElement("select");
  select.id = "link";
  for (const [value, text] of [
    ["usb", "over USB"],
    ["ble", "over Bluetooth"],
  ]) {
    const o = document.createElement("option");
    Object.assign(o, { value, textContent: text });
    select.append(o);
  }
  let saved = null;
  try {
    saved = localStorage.getItem(LINK_KEY);
  } catch {}
  select.value =
    saved ?? (!("serial" in navigator) && hasWebBluetooth() ? "ble" : "usb");
  select.onchange = () => {
    try {
      localStorage.setItem(LINK_KEY, select.value);
    } catch {}
  };
  $("connect").after(select);
}

// The Connect step for a CU, in the page's <div id="connectcard">. extra and cli as connectCard() takes them. A page
// passes ble: false if it needs USB, such as one that times the CU's replies.
/** @param {{ extra?: string, cli?: boolean, ble?: boolean }} [opts] */
export function cuConnectCard({ extra, cli, ble = true } = {}) {
  if (!ble) {
    connectCard({
      device: "Chameleon Ultra",
      short: "CU",
      prepare:
        "Plug your CU in to USB, not Bluetooth, and close anything else using it, such as the CU app or the Python CLI.",
      extra,
      cli,
    });
    return;
  }
  connectCard({
    device: "Chameleon Ultra",
    short: "CU",
    prepare:
      "For USB, plug the CU in. For Bluetooth, press a button on the CU to wake it. Close anything else using the CU, such as the CU app or the Python CLI.",
    needs:
      "USB needs Chrome or Edge on a computer. Bluetooth works in Chrome or Edge on a computer, and on an iPhone in the Bluefy app. Chrome on Android should work too, but hasn't been tried.",
    extra,
    cli,
  });
  addLinkChoice();
}
