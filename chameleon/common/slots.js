// The CU's slots, shared by the Chameleon pages: the names of the LF card types, and GET_SLOT_INFO's reply (each
// slot's HF and LF type). No DOM, no Web Serial in here.

export const CMD_GET_SLOT_INFO = 1019;

const LF_TYPES = {
  0: "empty",
  100: "EM410x",
  101: "EM410x/16",
  102: "EM410x/32",
  103: "EM410x/64",
  104: "EM410x Electra",
  150: "PAC",
  170: "Viking",
  180: "Jablotron",
  200: "HID Prox",
  201: "ioProx",
  202: "Pyramid",
  203: "Paradox",
  300: "Indala",
  310: "IDTECK",
  311: "Indala (nieldk)",
  470: "Hitag 2",
};
/** @param {number} t */
export const lfName = (t) => LF_TYPES[t] ?? `type ${t}`;

// GET_SLOT_INFO: eight (hf, lf) pairs of u16, slot 1 first.
/** @param {Uint8Array} d */
export function parseSlotInfo(d) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const slots = [];
  for (let i = 0; i + 4 <= d.length; i += 4)
    slots.push({ hf: v.getUint16(i), lf: v.getUint16(i + 2) });
  return slots;
}
