# Chameleon Ultra Indala test

Page: https://mfcarroll.github.io/rfid-test-tools/chameleon/indala/

The page times Indala reads on a Chameleon Ultra, and times a Flipper Zero reading the CU's Indala emulation. To
compare firmwares, flash a different one between runs without moving anything. It's made for testing [ChameleonUltra
PR #509](https://github.com/RfidResearchGroup/ChameleonUltra/pull/509), and requires Chrome or Edge on a computer.

## Tests

The page has two steps. Connect takes the CU, and optionally a Flipper Zero for the emulation test. Test has a tab
for each test, and the results table below the firmware section gains a row for each run.

- **Read a card.** The CU reads the card on its antenna a set number of times (`lf indala read`, command 3035) and
  times each read. The frame most reads return counts as the card, and a read that returns any other frame counts as
  wrong. The first read can't decide it, because a reader that returns wrong frames can return one first. The card
  column lists the fingerprints with their counts if there are several. The page compares frames by their
  fingerprint, the first 4 hex digits of the frame's SHA-256, and never shows the frame.
- **Emulate to a Flipper.** The page loads an Indala test card (Indala 26-bit, FC 123, card 1337, frame
  `a00000008f49d2a1`) into the slot the person picks when they press Start, and makes it active. It then runs `rfid
read indala` on the Flipper the set number of times. Each read is timed from sending the command to the Flipper's
  decode line, and stopped with Ctrl-C after the time limit. A decode other than the test card counts as wrong.

Each run adds a row to the results table: CU firmware, test, reads, wrong reads, median and slowest time, and the
card. Copy puts the table on the clipboard as Markdown. For an emulation run the card is the test card. For a read run
it is the fingerprints seen, if the checkbox under the table is ticked (it starts ticked). Fingerprints show whether
two runs read the same card, such as a card and its T5577 clone. ⚠ A fingerprint doesn't fully hide a card. An Indala
26-bit card has about 2^24 possible values and a fingerprint 2^16, so one fingerprint matches about 256
possible cards. The page's "What is this?" link under the checkbox says so.

## Firmware

- `firmware/pr509-444eb0aa-ultra-dfu-app.zip`: #509 (`feat/lf-indala`) at `444eb0aa`, built with
  `firmware/build.sh`. Rebuild it when the PR moves.
- `../common/firmware/stock-v2.3.0-ultra-dfu-app.zip`: stock v2.3.0, which has no Indala.
- **Flash a file** takes any application DFU package from the computer, such as a nieldk release. The page doesn't
  host other people's firmware.

Flashing keeps the CU's slots.

The page uses each firmware's own Indala commands. #509 uses tag type 300 and command 5026 for the emulated frame.
nieldk v2.4 uses type 311 and 5014. The page picks #509's when the firmware answers 5027, and nieldk's when the
version string names nieldk or v2.4. The person can change the choice. Both firmwares scan with 3035.

⚠ The nieldk choice hasn't been tried on nieldk firmware.

## Crystal offsets

How long the Flipper takes can depend on how far apart the two crystals run. The [CU](../crystal/) and
[Flipper](../../flipper/crystal/) crystal pages measure each. The CU page flashes its own test firmware and then
stock, so run this page's tests first.

## Files

| file         | what                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| `index.html` | the page                                                                     |
| `indala.js`  | the commands per firmware, the test card, fingerprints and the results table |
| `firmware/`  | #509's build                                                                 |

The page also uses `../common/cu.js` and `../common/flash-ui.js` for the CU, and `../../flipper/crystal/flipper.js`
(`rfidRead`) for the Flipper.

GPL-3.0.
