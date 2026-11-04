# Chameleon Ultra card search

The page finds out what kind of card or fob someone has, with a Chameleon Ultra and no Proxmark. It tries every LF
card type the CU can read, records the raw LF signal and works out its modulation, bit rate and frame length, and
checks for an ISO 14443-A card on HF. It gives a safe report to post and keeps the private details apart.

Live at https://mfcarroll.github.io/rfid-test-tools/chameleon/search/ (Chrome or Edge on a computer, over USB).

## What it sends

- **Measure the empty field** (optional): reader mode, then `lf sniff` (3031) with the card away.
- **Search**: reader mode, then each named LF read the firmware has (EM410x 3000, HID Prox 3002, Viking 3004,
  ioProx 3010, PAC 3014, Jablotron 3019, Pyramid 3021, Paradox 3022 from PR 489 and Indala 3035 from PR 509), twice if
  it finds nothing. Then `lf sniff` for 115 ms of
  16-bit samples, an ISO 14443-A scan (2000), and for a MIFARE Classic the PRNG check (2002). All of these listen,
  or run the standard anticollision and stop at the authentication nonce.
- **Then, on the experimental firmware**: the chip probe (3140) with the T55xx read of page 1 block 1 and no password, as the
  Proxmark's `lf search` sends it, then a capture. A T55xx answers by repeating that block, so the signal repeats
  every 32 bits instead of at the card's own frame length. If it does, the chip probe again with the read of page 0
  block 0, the configuration, as `lf t55xx detect` starts. Each read is 6 bits on air (opcode, lock bit 0, address);
  a write needs 32 more, so neither can change the card. If no T55xx answers, the chip probe with the EM4x05 read of
  word 0, encoded as the Proxmark's `EM4xReadWord` sends it: 13 bits on air, and a write, protect or disable needs a
  45-bit data field after the command. An EM4x05 answers `00001010` and the word, which names the chip.

Nothing writes to the card or changes the CU's slots. The page puts the CU back in the mode it found it in.

The page leaves out the CU's EM4x05 read (3030). If the tag's configuration asks for a login, that read logs in, and
its downlink doesn't match the Proxmark's. The chip probe's EM4x05 read was checked on air (a Proxmark recorded the
same 13 bits and timing as its own read) and on an EM4305: three answers, each equal to word 0 as the Proxmark dumps
it, and the chip's words were the same before and after.

## The report

The frame checks (`framecheck.js`) follow the CU's own decoders for EM410x, HID Prox, ioProx, Pyramid, Viking,
Jablotron, Paradox (PR 489) and Indala (PR 509): preamble, Manchester pairs, parity, checksum or CRC, and for HID the
Wiegand length and whether the CU knows a format of that length. Each says which parts hold, so a card the CU's read
turns away shows why. For Indala, the page decodes FC and card whenever the preamble is right, as the Proxmark does, and
says whether the parity and checksum bits follow the Proxmark's encoder. That encoder's rule is reverse-engineered,
the Proxmark never checks it on a read, and none of the Proxmark's own sample frames follows it in every bit, so
not following it isn't a fault in the card. A clone written from FC and card gets the encoder's bits, though, so it
can differ from the card. The T55xx configuration block repeats with no marker, so the page keeps the rotations whose
configuration matches the card's own signal, and reports it only when they agree.

The safe report holds the firmware, which named reads matched (with HID's format name), the modulation, rate and
frame length, the signal level, the average level against the empty field, for a 96-bit FSK frame the Paradox
check (preamble, Manchester pairs, whether the CRC matches, layout), the chip check's answer, and each HF
card's ATQA, SAK, UID length, ATS and PRNG. The private details hold card numbers, facility codes, raw frames, one
demodulated frame (for ASK, decoded both as Manchester and as biphase), the T55xx trace block and UIDs. Copy the
full report and Download the raw signal both ask first. `selftest.mjs` checks that no private value reaches the safe
report.

## The analysis

`lfdemod.js` tries FSK, then ASK, then PSK, on one capture at one sample per carrier cycle:

- **FSK** (fc/8 and fc/10): sub-carrier periods from the rising crossings of the high-passed signal, then the bit
  length from how long each tone lasts.
- **ASK**: the envelope sliced halfway between its quiet and loud levels. The rate comes from rise-to-rise
  intervals, where the slicer's bias between high and low runs cancels. Manchester or biphase wins over NRZ at half
  the rate when every interval is 2 to 4 half-bits.
- **PSK** (fc/2 sub-carrier): the capture multiplied by (-1)^n, filtered [1, 2, 1] and integrated per bit, at the
  bit offset whose weakest bits are strongest.

The frame length is the period at which the bits repeat.

`node selftest.mjs` runs it on `fixtures/`: captures of made-up cards that a Proxmark wrote to a T5577, read by a CU
with the experimental firmware. All 18 protocols give the right modulation, rate and frame length. The Proxmark clones
Noralsy with the T5577's sequence terminator on, a 4-bit marker after each pass through the data, so that frame
repeats every 100 bits. The page finds the marker (the stretch where the modulation breaks), and reports 96 data
bits and the terminator. With the terminator on, the T5577's answers to the chip probe are 36 bits, and the page
takes the block from the 32 bits after the marker. Two captures follow the chip probe, with the T5577 set up as FDX-B (biphase) and as
Paradox (FSK). Both give the trace block the Proxmark dumped, `e03900d0`.
HF was checked with a Gen4 card the Proxmark set as Classic 1K (4- and 7-byte UID), Classic 4K, Ultralight and an
ISO 14443-4 card with an ATS: the CU's scan and the page matched the Proxmark each time. The CU sends the ATQA least
significant byte first, and the page shows it most significant first, as the Proxmark does. The CU's PRNG check
called that card static, where the Proxmark found a weak PRNG, so the page says what the check saw: the same nonce
twice. The selftest covers these HF replies with made-up UIDs.

One capture is a Flipper emulating Paradox with the made-up data `112233445566`, whose CRC doesn't match. PR 489's
read finds nothing on it, and the page's frame check reports the frame with "CRC doesn't match".

## Firmware

- `firmware/lf-search-360bfa73-ultra-dfu-app.zip`: `lf-search` at `360bfa73`
  ([source](https://github.com/mfcarroll/ChameleonUltra/tree/lf-search)), upstream `main` plus long raw
  captures for `lf sniff` (up to 28672 bytes in 4000-byte slices, 16-bit samples, sample rate, phase and gain), the
  chip probe (3140) with the T55xx trace and configuration reads, PR 489's Paradox read (3022) and PR 509's Indala
  read (3035), both merged unchanged.
- `../common/firmware/stock-v2.3.0-ultra-dfu-app.zip`: stock v2.3.0. With it the page runs the named reads and the
  HF check only.

## Limits

- The CU's HF reader only covers ISO 14443-A.
- On LF, a card that only answers commands (Hitag, EM4x50 and others) shows as a change in the field with no
  signal.
- The analysis has been tried on T5577 clones only, on the CU's antenna.
