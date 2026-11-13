# Chameleon Ultra pulse test (experimental)

Test firmware and a page for readers that switch their field on for 50 to 80 ms at a time, over and over. The page
copies one HID Prox, Paradox or ioProx card into slots 1–7, and each slot answers the reader a different way.

Live at https://mfcarroll.github.io/rfid-test-tools/chameleon/pulse/ (Chrome or Edge on a computer, over USB).

## Why

A card loses power between a reader's pulses, so it starts its frame again at every pulse. A T5577 starts its frame
about 2.2 ms after the field comes on. Stock CU firmware sends 10 frames (about 0.4 s) before it checks the field, so
after the first pulse it keeps sending through the gaps, and the next pulse catches it mid-frame. A HID Prox or Paradox
frame is about 38 ms, so a 50 ms pulse holds one whole frame only if it starts within the first 12 ms.

On a Proxmark3 switching its field on for 50 ms and off for 100 ms or more (40 pulses each):

| | whole frame inside the pulse |
|---|---|
| stock | 11 of 40 |
| pulse timing | 40 of 40 |
| T5577 | 40 of 40 |

The current firmware (`2ca24315`), with a Paradox card, on a Proxmark3 switching its field on for 77 ms or 49 ms and off
for 173 ms (a Paradox door reader's timing):

| | 77 ms pulses | 49 ms pulses |
|---|---|---|
| stock | 40 of 40 | 16 of 40 |
| pulse timing, with or without exact bits | 40 of 40 | 40 of 40 |

A 77 ms pulse always holds one of stock's back-to-back frames, at a random point. The pulse slots start theirs at
2.1 ms, and the next frame follows straight after it. The first version of this firmware (`9e043062`) checked the
field after every frame, which left 20 ms of silence there.

## The slots

The firmware fixes each slot's mode, so every tester's setup is the same. Slot 8 isn't used.

1. **stock**: as stock firmware.
2. **pulse timing**: a fresh frame 2.1 ms into each field, then a second frame straight after it, as a T5577 sends,
   then a field check. A field's first 3 pairs of frames are sent that way, so the frame restarts at every pulse. A
   field that stays on gets 10-frame bursts after that.
3. **+ exact bits**: stock firmware sends a HID Prox or Paradox `0` bit as 48 carrier cycles where the standard is 50,
   so each frame is about 2 % short. This flag makes the bits 50 cycles on average.
4. **+ learned trim**: the CU runs on its own crystal, and a reader's clock can be well off 125 kHz. Over one frame the
   difference shifts the bits against the reader's timing (at 0.5 %, about half a bit by the frame's end). This slot
   first measures the reader, without sending the card: it holds a load on its coil, captures 41 ms at 100 kHz and
   fits the carrier on the part of the capture where the field is on (the field probe's method). Two measurements
   within 11.4 ppm confirm each other. The slot then trims the card's timing to match and keeps the result through
   sleep.
5. As 4, with exact bits.
6. As 5, with a fixed trim of +5197.6 ppm instead of a learned one: one Paradox door reader, measured with the
   tester's own CU at 125.6497 kHz. It tests the trim even if the learning fails.
7. As 6, with the CU also driving its coil (the self-trim page's "new drive"), for about 3 times the signal. The drive
   puts out the CU's own carrier, which beats against the reader's unless the trim matches.

On the Proxmark3 bench: slot 5 learned −138.8 ppm (the CU measures the PM3 at −140 ppm) and gave a whole frame in 40 of
40 pulses; slot 6's frame was 4775 cycles (4800 less 0.52 %), 40 of 40. Slot 7 can't be checked on a PM3: its trim is
set for a reader 5200 ppm away from the PM3, so its drive beats against the PM3's carrier.

## Commands

- 3120: each slot's mode and fields seen (as on the self-trim page); `0xC1` clears.
- 3130: per slot, what it learned from the reader's pulses: learned flag and ppm, the last measurement and its SNR,
  measurements, measurements without a line, and short fields (fields gone within about 300 ms). `0xC1` clears.
- 3100: the event log, as on the self-trim page.

Source: [mfcarroll/ChameleonUltra `exp/fsk-selftrim-489-pulse`](https://github.com/mfcarroll/ChameleonUltra/tree/exp/fsk-selftrim-489-pulse).
