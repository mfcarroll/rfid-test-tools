// Chameleon Ultra over Web Bluetooth. The CU's Nordic UART service carries the same frames as USB: the page writes
// them to the RX characteristic and the CU's replies arrive as notifications on TX. No DOM in here.

import { FrameClient } from "./cu.js";

export const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // the page writes here
const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // the CU notifies here
// The bootloader's Secure DFU service, 0xFE59, written out in full: Bluefy may lack BluetoothUUID.
export const DFU_SERVICE = "0000fe59-0000-1000-8000-00805f9b34fb";

// What the browser's device list shows: the CU, which advertises as "ChameleonUltra", and its bootloader, which
// advertises as "CU" with the DFU service. The service filters cover Bluefy, which ignores name filters.
export const CU_FILTERS = [
  { name: "ChameleonUltra" },
  { namePrefix: "CU" },
  { services: [NUS_SERVICE] },
  { services: [DFU_SERVICE] },
];

// The largest write that fits a BLE packet before the MTU exchange. Web Bluetooth doesn't report the MTU, and
// command frames are small, so the page never needs more.
const WRITE_MAX = 20;

export const hasWebBluetooth = () => "bluetooth" in navigator;

// Asks the person to pick their CU from the browser's Bluetooth list.
export const requestCU = () =>
  navigator.bluetooth.requestDevice({
    filters: CU_FILTERS,
    optionalServices: [NUS_SERVICE, DFU_SERVICE],
  });

export class BleCU extends FrameClient {
  // Called once if the link drops without close().
  ongone = () => {};

  /** @param {BluetoothDevice} device */
  async open(device) {
    // port is what the flasher reuses, so the browser doesn't ask for the CU again.
    this.port = device;
    this.closing = false;
    this.onDisconnect = () => {
      this.fail(new Error("the Bluetooth link dropped"));
      if (!this.closing) this.ongone();
    };
    device.addEventListener("gattserverdisconnected", this.onDisconnect);
    const gatt = await device.gatt.connect();
    // Ask for each service by its UUID. In Bluefy 3.9.3, no service from getPrimaryServices() matched these strings.
    const service = (uuid) => gatt.getPrimaryService(uuid).catch(() => null);
    const nus = await service(NUS_SERVICE);
    if (!nus) {
      const dfu = (await service(DFU_SERVICE)) !== null;
      await this.close();
      throw new Error(
        dfu
          ? "that's the CU's bootloader, not the CU: flash it in the Firmware section"
          : "that device has no Chameleon service",
      );
    }
    this.rx = await nus.getCharacteristic(NUS_RX);
    const tx = await nus.getCharacteristic(NUS_TX);
    this.onNotify = (e) => {
      const v = e.target.value;
      this.feed(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
    };
    tx.addEventListener("characteristicvaluechanged", this.onNotify);
    await tx.startNotifications();
    this.tx = tx;
  }
  async send(bytes) {
    const write = this.rx.properties.writeWithoutResponse
      ? (b) => this.rx.writeValueWithoutResponse(b)
      : (b) => this.rx.writeValueWithResponse(b);
    for (let i = 0; i < bytes.length; i += WRITE_MAX)
      await write(bytes.slice(i, i + WRITE_MAX));
  }
  // Resolves once the browser has reported the disconnect, or after a second. The flasher opens the same device next,
  // and Bluefy delivers the disconnect event late: a late event would end the flasher's connection.
  async close() {
    this.closing = true;
    try {
      this.tx?.removeEventListener("characteristicvaluechanged", this.onNotify);
      this.port.removeEventListener(
        "gattserverdisconnected",
        this.onDisconnect,
      );
      if (!this.port.gatt.connected) return;
      const gone = new Promise((resolve) => {
        this.port.addEventListener("gattserverdisconnected", resolve, {
          once: true,
        });
        setTimeout(resolve, 1000);
      });
      this.port.gatt.disconnect();
      await gone;
    } catch {}
  }
}
