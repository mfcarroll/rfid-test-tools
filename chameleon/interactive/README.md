# Chameleon Ultra interactive LF emulation (experimental)

https://mfcarroll.github.io/rfid-test-tools/chameleon/interactive/

Emulates an interactive LF tag — one that answers a reader's commands, not just a fixed card number. The CU's
existing LF emulation only broadcasts a pattern; this firmware adds a listen-and-respond engine, and its first
module is Hitag 2 in password mode. The page sets up a test tag, and after you hold the CU to a reader it reports
whether the reader engaged with the emulation and how far the exchange got.

## The test tag

A made-up Hitag 2 tag, not a real credential:

- **UID**: yours to set on the page. Set it to your fob's if you want the reader to see that number.
- **Password**: a fixed placeholder (`0A0B0C0D`). A reader won't open anything, because its own password won't
  match. That is fine: the test is whether the reader treats the CU as a Hitag 2 tag at all.
- **Config**: `0x06` — Hitag 2, Manchester, password mode.

The page writes these to the active slot and saves them. Flashing keeps the slots; setting up the tag overwrites the
active slot's LF side.

## What it reports

While a reader works the CU, the engine records each command it hears and each answer it sends, in a trace in
retained RAM that survives the CU's sleep. So you can clear the trace, unplug the CU, hold it to a reader on
battery, and read the trace back here afterwards. Each wake from sleep is a new boot in the report.

The report splits in two, like the field page:

- **Safe to share.** Per field session: whether a reader's field appeared, whether it sent START_AUTH and the CU
  answered its UID, whether it sent a 32-bit password command (password mode) or a 64-bit command (crypto mode,
  which this emulation does not support), and how many pages it read. It gives the emulated UID and counts of
  commands and answers. It never gives the content of a command.
- **Private details.** Every command decoded to bits, and every answer. In password mode one of those commands is
  the reader's password, so these are kept out of the safe report and marked not to post.

## How a reader's exchange reads

A Hitag 2 reader starts with START_AUTH (a 5-bit frame), to which the tag answers its 32-bit UID. The reader then
sends a 32-bit password; if it matches, the tag answers its configuration page and serves page reads (10-bit
commands). A reader in crypto mode sends a 64-bit authentication frame instead, which this emulation does not
answer. The safe report names each of these by the command's length, so it tells password mode from crypto mode
without reading any secret.

## Limits

- Password mode only. Crypto mode is recognised and reported, not answered.
- Checked against a Proxmark3 acting as the reader: `lf hitag reader` read the UID, and `lf hitag read --ht2`
  authenticated with the placeholder password and read all eight pages. The retained trace survived the CU's sleep
  across several wakes on battery. Not yet checked against a commercial Hitag 2 reader.
- The trace keeps the first 8 records since a clear and the latest 24; a long run at a polling reader overwrites the
  middle, and the report says so.
- While a slot emulates the interactive tag, that slot answers nothing else on LF.
- The UID the CU presents is whatever you set. A reader that checks more than the UID (its own password, crypto)
  won't complete, and the report shows how far it got.

## Firmware

[`exp/lf-interactive`](https://github.com/mfcarroll/ChameleonUltra/tree/exp/lf-interactive): the interactive LF
engine (a protocol-agnostic listen-and-respond loop), the Hitag 2 password-mode module, and the retained exchange
trace, on top of upstream `main`. Commands the page uses:

| command | request | reply |
| --- | --- | --- |
| 1004 set slot type | slot (u8), tag type (BE16) | – |
| 5040 set Hitag 2 data | 32 bytes: eight pages, page 0 first, MSB first | – |
| 5041 get Hitag 2 data | – | the active slot's 32 bytes, if its LF type is Hitag 2 |
| 3180 trace read | first record index (BE16) | total (u32 LE), record size (u16 LE), count (u8), first kept (u8), boot (u16 LE), then the records |
| 3181 trace clear | – | – |
| 3184 counters | – | the 14-byte tuning struct, then seven u32 counters (sessions, commands, answers, late, ADC ticks, slips, longest tick) |

The record layout is `lf_ia_trace_rec_t` in `lf_ia_trace.h`, packed and little-endian, 276 bytes. The page reads the
10-byte reply header, then the records, asking for the next batch until it has them all. `node selftest.mjs` checks
the parser, the session grouping and verdicts, and that the safe report never contains a decoded command's bits.
