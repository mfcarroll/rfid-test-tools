# Chameleon Ultra field probe (experimental)

https://mfcarroll.github.io/rfid-test-tools/chameleon/field/

Turns the CU into a probe for a reader's field, to answer "what kind of reader is this?" when a card or fob won't
read. While the probe is on, the CU emulates nothing: it senses LF and HF fields whatever its slots hold, measures
them and logs the results. The log survives the CU's sleep, so the CU can go to a reader on battery and report when
it's next connected.

## What it measures

**LF.** When a field appears, the CU measures it at the start, after 1 s and after 4 s. Each measurement records:

- the field's level on LF_RSSI with the CU's load off
- 102 ms of the field's envelope at 100 kHz, with the CU's load on, and every dip in it (start, width, depth)
- the reader's carrier frequency, from the carrier's ripple in that envelope: at 100 kHz, carriers from 100 to 150 kHz
  each land on their own frequency. If the field switches during the capture, a 15.6 kHz load tone sampled at two
  rates stands in.

The page groups the dips into bursts and reads the intervals between gaps as bits. A steady carrier means the
reader waits for a tag to talk. Command-like gaps mean the reader talks first (Hitag, password-protected T55xx or
EM4x05). The page names a Hitag start command when a burst has Hitag timing and a start command's bits.

**HF.** When a field appears, the CU's ISO 14443-A receiver counts the frames the reader sends: REQA and WUPA polls,
other frames, and frames with receive errors. The page also notes fields that come and go in short bursts, as a
reader in low-power card detection does.

## Limits

- Checked against a Proxmark3, on USB and on battery, not yet against a door reader. On LF the CU found the
  Proxmark's carrier at the same offset as earlier measurements, and decoded a Hitag 2 start command
  (`lf cmdread … -c W11000`) to its bits. On HF it counted a 14443-A reader's polls, and logged 14443-B, ISO 15693
  and iCLASS readers as fields with no frames.
- The carrier frequency is on the CU's own crystal, which can be off by up to ±40 ppm.
- The envelope needs the CU's load on. With it off, the CU's detector holds the field's level and a reader's gaps
  don't show.
- The HF receiver only decodes ISO 14443-A, and reports nothing at all for other HF types.
- The log keeps the last 12 LF measurements, 32 LF fields and 32 HF fields. Flashing the firmware clears it and turns
  the probe off.

## Firmware

[`exp/field-probe`](https://github.com/mfcarroll/ChameleonUltra/tree/exp/field-probe): the card search page's
`lf-search` firmware with the field probe added. Commands 3160–3165:

| command | request | reply |
| --- | --- | --- |
| 3160 mode | empty, or on (0/1) and the envelope load (0 off, 1 on, 2 tone) | on, load, log version, record size (BE16), log size (BE16) |
| 3161 log | byte offset (BE16) | up to 4000 bytes of the log |
| 3162 clear | – | – |
| 3163 measure | – | one LF measurement record, also logged |
| 3164 capture | load, rate in kHz, samples (BE16), analog input, gain divisor | samples taken (BE32) |
| 3165 capture read | chunk | 4000 bytes of the capture, 16-bit little-endian |

The log's layout is `fp_store_t` in `field_probe.h`, packed and little-endian. `node selftest.mjs` checks the
page's parser and report against a synthetic log in that layout.
