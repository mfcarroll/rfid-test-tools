# Chameleon Ultra Hitag 2 emulation test (experimental)

The CU emulates a Hitag 2 tag and answers a real reader's commands in time. Set up a test tag, hold the CU to a Hitag
2 reader, and read back the exchange: whether the reader read the UID, which mode it uses, and how it answered. It
records what a reader does without a Proxmark3.

Page: https://mfcarroll.github.io/rfid-test-tools/chameleon/hitag2/

## What it shows

A Hitag 2 reader sends START_AUTH to ask for the tag's UID, then a 32-bit password (password mode) or a 64-bit
command (crypto mode). The CU answers the UID, and, if the reader's password matches the one you set, the data pages.

The emulation answers **password mode** only. So the test tells you:

- whether a real reader reads the emulated UID — that is the interactive uplink working against that reader,
- whether the reader is password mode or crypto mode,
- and, if you set the reader's own password, whether it authenticates and reads the pages.

It is a made-up test tag: a placeholder UID and password, opening no door. A reader reads the UID and then asks for a
password it will not get unless you know and set it. That still proves the reader sees the tag.

## Using it

1. Flash the experimental firmware from the page.
2. **Set up the test tag**: enter a UID (and a password, only if you know the reader's own), and press the button.
   The active slot becomes a Hitag 2 tag and is saved.
3. **Clear the trace**, hold the CU to the reader with the USB cable attached, then **Read the trace**.

Keep the CU plugged into the computer during a test. The exchange trace lives in memory and is lost when the CU
sleeps or loses power, and USB power keeps it awake.

## The report

The **safe report** is counts and a verdict — reader fields, UID requests and whether the UID was read, password and
crypto commands, page reads, and late answers. It names no command bits, so it is safe to post.

The **private details** decode each reader command to bits. A password-mode command's bits are the reader's
password, so they stay out of the safe report and the page warns before a download.

## The CLI

The same, from the Python client on `exp/lf-interactive`:

```
hw slot type -s <n> -t HITAG2
lf hitag2 econfig -s <n> --uid 01020304 --pwd 0A0B0C0D
hw slot enable -s <n> --lf
hw slot change -s <n>
hw slot store
lf interactive clear
lf interactive trace
```

`lf hitag2 econfig` with no options prints the slot's pages. `lf interactive trace` shows the exchange, including the
reader's password in full.

## Firmware

`exp/lf-interactive` on [mfcarroll/ChameleonUltra](https://github.com/mfcarroll/ChameleonUltra/tree/exp/lf-interactive):
upstream `main` with the interactive LF engine, its Hitag 2 module, and the trace commands. Flashing replaces the
CU's firmware and keeps the current slots. Flash stock v2.3.0 to go back.

`node selftest.mjs` checks the trace parser and the report logic against synthetic records.
