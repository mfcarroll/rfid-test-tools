# Chameleon Ultra interactive LF emulation (experimental)

https://mfcarroll.github.io/rfid-test-tools/chameleon/interactive/

Emulates an interactive LF tag — one that answers a reader's commands, not just a fixed card number. The CU's
existing LF emulation only broadcasts a pattern; this firmware adds a listen-and-respond engine, and its first
module is Hitag 2 in password mode. The page sets up the tag — from fields you enter or from a real tag it reads —
and after you hold the CU to a reader it reports whether the reader engaged with the emulation and how far the
exchange got.

## The tag

The page shows all eight Hitag 2 pages as fields, in order, each hex, with an ASCII column beside them (the page's
bytes as printable characters, a dot for each non-printable one, like a Proxmark dump). Most defaults are greyed
placeholders — leave a field blank to use its default, or type over it:

| page | default                                 | holds                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `12345678`                              | **UID.** Yours to set; set it to your fob's for the reader to see that number. It appears in the safe report, since a reader broadcasts it over the air anyway.                                                                                                                                                                                                                       |
| 1    | empty (placeholder `4D494B52` / `MIKR`) | **Reader password.** The password the tag expects. It starts empty — the placeholder is the Hitag 2 manufacturer default; blank falls back to it. Set it to the reader's own password to authenticate, or leave it and let a reader's failed attempts reveal it (see below), which fills this field. It stays on the page and in the private details, never the safe report.          |
| 2    | `22222222`                              | Crypto key, high bytes. Unused in password mode.                                                                                                                                                                                                                                                                                                                                      |
| 3    | `06` + `AABBCC`                         | **Config + tag password.** The config byte box is read-only, `06` (Hitag 2, password mode) by default; reading a tag shows that tag's real config byte instead, flagged when it isn't `06`. The three bytes after it are what the tag returns once a reader authenticates. The emulation ignores the config byte and always runs password mode, so a non-`06` value is informational. |
| 4–7  | `44444444`–`77777777`                   | User pages.                                                                                                                                                                                                                                                                                                                                                                           |

Either type the fields, or **read a real tag** into them: hold the tag to the CU and read its UID alone, or, with the
tag's password in page 1, read all eight pages into the fields. Review them, then write the tag to the slot. Reading
uses the firmware's Hitag 2 reader; the page puts the CU in reader mode for the read and back to tag mode after, so the
slot keeps emulating. A page it cannot read keeps its field's value.

Pick the slot to write to (it defaults to the CU's active slot); writing makes that slot active, sets its LF side to the
tag and saves it. Flashing keeps the slots; writing the tag overwrites the chosen slot's LF side.

## What it reports

While a reader works the CU, the engine records each presentation, each command it hears and each answer it sends,
in a log. The CU keeps the log in RAM while a reader's field is present and saves it to a 192 KB flash area while
none is, so it survives sleep and a power loss. That holds about two days of testing like 20 November's. So you can
clear the log, unplug the CU, test every slot at the readers on battery, and read the log back here afterwards. Each
wake from sleep is a new boot in the report. Read the log out before flashing other firmware: a build with a
different log format erases it. The log keeps going across a flash of a build with the same format, so it names the firmware behind each
presentation, and the report splits its tables by build if there is more than one. **Download and clear the log**
saves the log and then clears it, so the next test starts fresh. Firmware from before the flash log keeps a 48-record trace in RAM instead, and the
page reads that.

The report splits in two, like the field page:

- **Safe to share.** With the flash log, a table per slot and per mode: presentations, how far each got (accepted,
  password answered, password not matched, UID only, nothing decoded, no command), the median time to acceptance,
  and which START_AUTH the accepted password followed. A timing table per slot and per mode gives the medians of the time
  to the first command and to acceptance, the reader's turnaround after the UID and after the password, the carrier
  and the field level, and counts of late answers, undecoded commands, field resets and answers the field dropped
  during. A line on the reader gives its carrier, pulse width and gap-to-gap times for a 0 and a 1. Timings and counts
  only: none of it shows a command's content. Then per field session: whether a reader's field appeared, whether it sent START_AUTH and the CU
  answered its UID, whether it sent a 32-bit password command (password mode) or a 64-bit command (crypto mode,
  which this emulation does not support), and how many pages it read. It gives the emulated UID and counts of
  commands and answers, and, if the reader's password was recovered, says so — without the value. It never gives the
  content of a command.
- **Private details.** Every command decoded to bits (and, for byte-aligned frames, as hex) and every answer. In
  password mode one of those commands is the reader's password, so these are kept out of the safe report and marked
  not to post. When the password is recovered it is called out here in hex.

### Recovering the reader's password

A reader whose password the emulated tag does not hold will not authenticate, so it retries: START_AUTH, then its
32-bit password, over and over. The page collects those 32-bit commands and, when the same value appears at least
twice (so a single mis-decode cannot stand), treats it as the reader's password. It reports it (hex in the private
details, "recovered" in the safe report) and fills it into page 1, so writing the tag to the slot and visiting the
reader again authenticates. Page 1 therefore starts empty (its default `MIKR` is only a placeholder): leave it for the
reader to reveal, or type a password you already know.

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
- If the log fills, it keeps each slot's first success and first failure and drops the other presentations. The
  report says so. Builds before the flash log keep the first 8 records and the latest 40, and a long run overwrites
  the middle.
- While a slot emulates the interactive tag, that slot answers nothing else on LF.
- The UID the CU presents is whatever you set. A reader that checks more than the UID (its own password, crypto)
  won't complete, and the report shows how far it got.

## Firmware

The page flashes the [Hitag 2 modes](../hitag-modes/) page's build, `f559dee3`. It reports `v2.3.0-72-gf559dee`
(2026-11-20 07:31 UTC).

[`exp/lf-interactive`](https://github.com/mfcarroll/ChameleonUltra/tree/exp/lf-interactive): the interactive LF
engine (a protocol-agnostic listen-and-respond loop), the Hitag 2 password-mode module, a Hitag 2 reader, and the
retained exchange trace, on top of upstream `main`. Commands the page uses:

| command               | request                                        | reply                                                                                                                                   |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1003 set active slot  | slot (u8)                                      | –                                                                                                                                       |
| 1004 set slot type    | slot (u8), tag type (BE16)                     | –                                                                                                                                       |
| 1018 get active slot  | –                                              | the active slot (u8)                                                                                                                    |
| 1019 get slot info    | –                                              | each slot's HF and LF tag type (BE16 each), slot 1 first                                                                                |
| 3037 Hitag 2 read     | the reader password, 4 bytes                   | 32 page bytes, then a u8 mask of which pages read (status `LF_TAG_OK`, `LF_TAG_NO_FOUND` if partial, `MF_ERR_AUTH` on a wrong password) |
| 3038 Hitag 2 scan     | –                                              | the tag's UID, 4 bytes (status `LF_TAG_OK`, else `LF_TAG_NO_FOUND`)                                                                     |
| 5040 set Hitag 2 data | 32 bytes: eight pages, page 0 first, MSB first | –                                                                                                                                       |
| 5041 get Hitag 2 data | –                                              | the active slot's 32 bytes, if its LF type is Hitag 2                                                                                   |
| 3180 trace read       | first record index (BE16)                      | builds before the flash log: total (u32 LE), record size (u16 LE), count (u8), first kept (u8), boot (u16 LE), then the records         |
| 3181 trace clear      | –                                              | builds before the flash log: –                                                                                                          |
| 3192 log info         | –                                              | `lf_ia_trace_info_t`, 68 bytes LE: format, state, space used, counters                                                                  |
| 3193 log read         | stream offset (u32 LE), most bytes (u16 LE)    | the offset (u32 LE), the stream's end (u32 LE), then the bytes                                                                          |
| 3194 log clear        | –                                              | –; the CU then erases the log a page at a time while no field is present, and 3192 counts the pages left                                |
| 3184 counters         | –                                              | the 14-byte tuning struct, then seven u32 counters (sessions, commands, answers, late, ADC ticks, slips, longest tick)                  |

3037 and 3038 are reader commands: the firmware rejects them unless the CU is already in reader mode (command 1001,
argument 1), returning a device-mode error. The page switches to reader mode around each read and back to tag mode
after, so the slot keeps emulating.

The log's entry format is the comment at the top of `lf_ia_trace.c`: each entry has a header word and a CRC trailer,
and the page skips an entry that fails its CRC and reports it. The old trace's record is `lf_ia_trace_rec_t`, packed
and little-endian, 276 to 294 bytes. `node selftest.mjs` checks both parsers, the session grouping, the outcomes and
tables, and that the safe report never contains a decoded command's bits.
