# Chameleon Ultra Hitag 2 modes (experimental)

This is test firmware whose Hitag 2 emulation can answer a reader in several ways, set by a per-slot mode, with a page
that copies one Hitag 2 card into every slot and gives each slot a different mode. To try it at a reader, walk the
eight slots past the reader and compare which modes it accepts.

Live at https://mfcarroll.github.io/rfid-test-tools/chameleon/hitag-modes/ (Chrome or Edge on a computer, over USB).

## What the modes change

Each slot has three independent mode bits, so eight combinations. Slot _n_ gets combination _n_ by default (slot 1
baseline, slot 8 all three on), so one walk past a reader compares them all.

- **scale**: the CU measures the reader's carrier at the start of each field and times the answer's bits and delay in
  that reader's carrier periods. Without it, a carrier period is taken as 8 µs (125 kHz), so the answer drifts against
  a reader whose clock is off nominal.
- **alt-delay**: the tag answers in the middle of the reader's listening window, rather than at a genuine fob's timing.
  A reader with a wide window may read either; a strict one may prefer one.
- **every-second**: the tag answers only every second START_AUTH. The HT2 datasheet (rev 2.1, 4.2.2) says a second
  START_AUTH resets a genuine tag's state machine, so it answers only every second one. A reader that relies on that
  may reject a tag that answers every time.

The modes are kept in retained RAM. They survive sleep, so a test runs at a reader on battery, but reset to baseline on
a power-on reset or a flash. Saving the slots does not save the modes, so the page sets them again whenever it copies.

This page only sets the modes; it reads no results back. To see what a reader actually sent and how the tag answered,
use the [Interactive LF emulation page](../interactive/), which records the exchange.

## Firmware

- `firmware/lf-hitag-modes-271eaf55-ultra-dfu-app.zip`: built from
  [`exp/lf-hitag-modes`](https://github.com/mfcarroll/ChameleonUltra/tree/exp/lf-hitag-modes), commit `271eaf55`.
  Reports `v2.3.0-53-g271eaf5`. It's the interactive LF engine (a listen-and-respond Hitag 2 tag in password mode)
  plus per-slot answer timing and the three research modes. Command 3188 reads and sets the eight slot modes. The
  same build drives the [Interactive LF emulation](../interactive/) page, including its reader answer timing.
- `../common/firmware/stock-v2.3.0-ultra-dfu-app.zip`: the official v2.3.0 application package, unchanged, for flashing
  back. It has no Hitag 2 emulation.

It works on the Chameleon Ultra only, not the Lite, which has no reader-side antenna driver. Flashing replaces the
firmware. Slots and saved cards are kept. Flashing resets every slot's mode to baseline. Flash stock back when you're
done, or use **Flash a file** for another application DFU package.

### Building it

The worktree `ChameleonUltra-ilf` holds the `exp/lf-hitag-modes` branch. Build on this machine with the host toolchain
(see `rfid-research/METHOD.md` M41 — `nrfutil` is `.tools/bin/nrfutil`, and the SDK needs the toolchain root set):

```
cd ChameleonUltra-ilf/firmware
PATH=/Users/Shared/code/personal/rfid/.tools/bin:$PATH
(cd application && make -j4 GNU_INSTALL_ROOT=/opt/homebrew/bin/ GNU_VERSION=13.3.1)
(cd objects && nrfutil nrf5sdk-tools pkg generate --hw-version 0 \
   --key-file ../../resource/dfu_key/chameleon.pem \
   --application application.hex --application-version 1 --sd-req 0x0100 ultra-dfu-app.zip)
cp objects/ultra-dfu-app.zip \
   ../../rfid-test-tools/chameleon/hitag-modes/firmware/lf-hitag-modes-<sha>-ultra-dfu-app.zip
```

Because it's a worktree, `git describe` runs on the host (where the worktree's gitdir is reachable), so the version
string is correct — building in the firmware's Docker image (which mounts only the worktree) would lose it. The app DFU
package is all the device needs; the full `build.sh` also builds the bootloader and merges a full image with `mergehex`
(not installed here), which the page doesn't use.

## The page

| File             | What it is                                                       |
| ---------------- | ---------------------------------------------------------------- |
| `index.html`     | the page                                                         |
| `main.js`        | the page's controller: connect, copy, set modes, backup          |
| `hitag-modes.js` | the modes, command 3188, the Hitag 2 copy and backup (no DOM)    |
| `selftest.mjs`   | `node selftest.mjs` checks the mode names, 3188 parse and backup |
| `firmware/`      | the test firmware DFU                                            |

The card data only passes between the CU and the page's memory. The page never shows, logs, stores or sends it, except
in a backup file you download.
