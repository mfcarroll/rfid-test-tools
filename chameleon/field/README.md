# Chameleon Ultra field probe (experimental)

https://mfcarroll.github.io/rfid-test-tools/chameleon/field/

Turns the CU into a probe for a reader's field, to answer "what kind of reader is this?" when a card or fob won't
read. While the probe is on, the CU emulates nothing: it senses LF and HF fields whatever its slots hold, measures
them and logs the results. The log survives the CU's sleep, so the CU can go to a reader on battery and report when
it's next connected.

## What it measures

**LF.** When a field appears, the CU measures it at the start, after 1 s and after 4 s. Each measurement records:

- 102 ms of the field's envelope at 100 kHz, with the CU's load on, and every dip in it (start, width, depth). This
  comes first, while a reader that sends one command and stops may still be sending.
- the field's level on LF_RSSI with the CU's load off
- the reader's carrier frequency, from the carrier's ripple in that envelope: at 100 kHz, carriers from 100 to 150 kHz
  each land on their own frequency. If the field switches during the capture, the carrier comes from the longest
  stretch with the field on, if it lasts 20 ms. A 15.6 kHz load tone sampled at two rates stands in only for a steady
  field: on a switching one it reported its own line, or the switching itself (124.4 and 120.1 kHz at a door reader).
- the field's timing: 1.8 s with the load off, in 1 ms steps, as on and off stretches. On a Proxmark3 pulsing 50 ms
  on and 100 ms off, it read 55 and 95 ms: the CU's detector takes about 5 ms to fall.
- for a Hitag 2 reader, the authentication mode: when a fob completes an authentication within the 102 ms envelope,
  the firmware measures the length of the reader's command after the fob's UID — 32 bits is password mode, 64 bits is
  crypto mode — and logs a short summary (the gap count, the span, and the verdict). It reads the command's length
  only: it classifies the install and recovers no secret. A real fob has to answer, or the reader loops on
  START_AUTH and never sends the 32- or 64-bit command.

While a field lasts, the LEDs are cyan and the field LED follows the field. Each time the field drops out, the slots flash red for 150 ms,
and the CU counts the drops. It can't watch while its own load is on (about 0.4 s of each measurement).

The page groups the dips into bursts and reads the intervals between gaps as bits. A steady carrier means the
reader waits for a tag to talk. Command-like gaps mean the reader talks first (Hitag, password-protected T55xx or
EM4x05). The page names a Hitag start command when a burst has Hitag timing and a start command's bits. When a
Hitag 2 fob answers in the capture, the safe report also gives the install's authentication mode (password or
crypto) and the measured command length; the raw gap count is in the private details.

**HF.** When a field appears, the CU's ISO 14443-A receiver counts the frames the reader sends: REQA and WUPA polls,
other frames, and frames with receive errors. The page also notes fields that come and go in short bursts, as a
reader in low-power card detection does.

## Limits

- Checked against a Proxmark3, on USB and on battery. Testers have run it at door readers. On LF the CU found the
  Proxmark's carrier at the same offset as earlier measurements, and decoded a Hitag 2 start command
  (`lf cmdread … -c W11000`) to its bits. On HF it counted a 14443-A reader's polls, and logged 14443-B, ISO 15693
  and iCLASS readers as fields with no frames.
- The carrier frequency is on the CU's own crystal, which can be off by up to ±40 ppm.
- The envelope needs the CU's load on. With it off, the CU's detector holds the field's level through gaps of a few
  ms, so the timing capture only shows gaps of several ms or more.
- The HF receiver only decodes ISO 14443-A, and reports nothing at all for other HF types.
- The log keeps the last 12 LF measurements, 32 LF fields and 32 HF fields. Flashing the firmware clears it, and the
  probe starts on after a flash.
- While the probe is on, the CU's buttons only wake it. A slot change or a reader-mode button function would spoil a
  measurement.
- A reader's field has to last until the CU has woken and started its first measurement. A single PM3
  `lf hitag reader` on battery sometimes doesn't, and the log then shows a wake with no field.
- If the CU resets in the middle of a run (its watchdog, a lockup or a firmware error), the log survives, and the
  report says how many times the CU reset and why. A flat battery still clears the log.

## Firmware

[`exp/field-probe`](https://github.com/mfcarroll/ChameleonUltra/tree/exp/field-probe): the card search page's
`lf-search` firmware with the field probe added. Commands 3160–3165:

| command | request | reply |
| --- | --- | --- |
| 3160 mode | empty, or on (0/1) and the envelope load (0 off, 1 on, 2 tone) | on, load, log version, record size (BE16), log size (BE16) |
| 3161 log | byte offset (BE16), optionally the most bytes to return (BE16) | up to that many bytes of the log, at most 4000 |
| 3162 clear | – | – |
| 3163 measure | – | one LF measurement record, also logged |
| 3164 capture | load, rate in kHz, samples (BE16), analog input, gain divisor | samples taken (BE32) |
| 3165 capture read | chunk | 4000 bytes of the capture, 16-bit little-endian |

The log's layout is `fp_store_t` in `field_probe.h`, packed and little-endian. Version 2 adds the crash record, this
boot's reset reason and a count of USB replies the CU dropped; version 3 adds the gated carrier, the field timing and
the drop count; version 4 adds the Hitag 2 authentication-mode summary (the reader's post-UID command length). The
page reads the 36-byte header first, then the rest in 512-byte pieces, and asks for each piece twice before it gives
up. `node selftest.mjs` checks the page's parser and report against a synthetic log in that layout.
