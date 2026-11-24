# Chameleon Ultra Hitag 2 modes (experimental)

This is test firmware whose Hitag 2 emulation can answer a reader in several ways, set by a per-slot mode, with a page
that copies one Hitag 2 card into every slot and gives each slot a different mode. To try it at a reader, walk the
eight slots past the reader and compare which modes it accepts.

Live at https://mfcarroll.github.io/rfid-test-tools/chameleon/hitag-modes/ (Chrome or Edge on a computer, over USB).

## What the modes change

Each slot has three independent mode bits, so eight combinations, one per slot. **Default setup** gives each slot one
of them, from slot 1 (baseline) to slot 8 (all three on), so one walk past a reader compares scale, every-second and
rest-loaded, and their combinations. On firmware with answer delays (below) it sets every slot's delay to 194 periods,
which every reader tried so far reads, instead of the firmware's own 189.

- **scale**: the CU measures the reader's carrier at the start of each field and times the answer's bits and delay in
  that reader's carrier periods. Without it, a carrier period is taken as 8 µs (125 kHz), so the answer drifts against
  a reader whose clock is off nominal.
- **every-second**: the tag answers only every second START_AUTH. The HT2 datasheet (rev 2.1, 4.2.2) says a second
  START_AUTH resets a genuine tag's state machine, so it answers only every second one. A reader that relies on that
  may reject a tag that answers every time.
- **rest-loaded**: after each answer the CU listens with its load on at once, the way this firmware always did before
  `f7eab3fb`. Without it the CU holds the load off for 56 carrier periods first, as a genuine tag rests unloaded, so the
  answer's last half-bit ends cleanly. A CU reading a CU in rest-loaded mode fails on an odd UID. A door reader has
  accepted rest-loaded, so it stays here for comparison. On `802a3a6d` and earlier the bit meant the opposite: it was
  rest-unloaded, with a one-bit rest.

## Answer delays

On firmware `d50aac62` and later each slot also has an **answer delay**: how many carrier periods after the end of the
reader's command the tag starts its answer. Readers differ here. A Paxton Net2 read from 180 to 196 periods, and
another reader read at 196 and not at 189. The firmware's own delay is 189 periods (1512 µs at 125 kHz).

**Delay sweep** copies the card into every slot with the mode at baseline and a different delay in each: 184, 187,
189, 191, 193, 196, 199 and 202 periods (1472 to 1616 µs). Walk the slots past the reader to find which delays it
reads. **Fine sweep** does the same with 187 to 194 periods, one apart (1496 to 1552 µs), to find a reader's lower edge to
the period once Delay sweep has placed it near 190, and to check that 194 works there. Each slot's nickname gives its delay in µs, e.g.
"Hitag 2 base 1568us". A delay can also be set per slot by hand, alongside its mode, any period from 180 to 205; with scale on, the CU counts the reader's own periods. The flash log records the delay each
answer used, and the Interactive page's report shows it per slot.

The modes and delays are kept in retained RAM. They survive sleep, so a test runs at a reader on battery, but reset to baseline on
a power-on reset or a flash. Saving the slots does not save the modes, so the page sets them again whenever it copies.

This page only sets the modes; it reads no results back. To see what a reader actually sent and how the tag answered,
use the [Interactive LF emulation page](../interactive/), which records the exchange.

## Firmware

- `firmware/lf-hitag-modes-d50aac62-ultra-dfu-app.zip`: built from
  [`exp/lf-hitag-modes`](https://github.com/mfcarroll/ChameleonUltra/tree/exp/lf-hitag-modes), commit `d50aac62`.
  Reports `v2.3.0-90-gd50aac6` (2026-11-24 20:01 UTC). It's the interactive LF engine (a listen-and-respond Hitag 2 tag
  in password mode) plus per-slot answer timing and the research modes. Command 3188 reads and sets the eight slot
  modes and answer delays. It logs every presentation at a reader to flash, which the interactive page reads back, and it starts
  emulating as soon as a reader's field wakes it. The same build drives the [Interactive LF emulation](../interactive/) page, including its reader answer timing.
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
