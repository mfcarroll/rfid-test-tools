// The page the FSK test firmwares share (the self-trim and pulse pages): connecting the CU, copying a card into
// slots, the test at a reader, the results, and slot backups. fskPage(variant) returns the page object its hooks
// get. Each page passes what differs as its variant:
//   name:       the report file's prefix
//   presets:    the page's module: presetName(p), presetNick(lfType, p, slot), report(r, fw, more)
//   firmware:   { test: { zip, name, version }, stock: { zip, name } }
//   lacks:      what a firmware without command 3120 lacks, after "this firmware" ("has no self-trim support")
//   flashIt:    what to flash then, after "Flash" ("the test firmware")
//   plan:       each slot's preset when the page opens, slot 1 first
//   hasResults(r): whether a 3120 reply shows the CU has already seen a reader
//   readMore(cu, req): a second command's reply, kept beside 3120's as page.more. req is empty to read it, or
//               reqClear() to clear it. Throws an error with noSupport set if the firmware lacks the command.
//   setMode(page, slot, preset): sets a slot's preset. Without it, the firmware fixes each slot's preset.
//   planUse(page, s, td, from): the plan table's first cell for slot s, before the slot number
//   planMode(page, s, td): the plan table's mode cell for slot s
//   confirmModes: what the setup's question adds after the slots it copies to (" and set their modes")
//   confirmNote(last): a paragraph the setup's question adds after the slots it replaces
//   afterCopy(page): runs after the card is in every planned slot, before the save
//   resultMode(page, s, td, r): the results table's mode cell for slot s
//   resultCells(page, s, td): the results table's cells after the fields seen
//   renderDone(page, r, fw): runs after the results table is drawn
//   emptyInactive: an empty slot can't be made the active slot
//   backupHf:   the backup keeps whether each slot's HF side is enabled, and a restore sets it again
//   saveExtra(page): more keys for the saved report

import { STATUS_SUCCESS, STATUS_INVALID_CMD } from "./cu.js";
import { bindFlashButtons } from "./flash-ui.js";
import { openCU } from "./session.js";
import * as F from "./fsk.js";
import {
  $,
  log,
  saveJson,
  showSiteCommit,
  showState,
  oneAtATime,
} from "../../common/page.js";

export function fskPage(variant) {
  const V = variant,
    X = variant.presets;
  // The test firmware's commit, on its flash button
  V.firmware.test.label = `Flash the test firmware (${V.firmware.test.name.match(/([0-9a-f]{7,8})\)$/)[1]})`;

  let cu = null,
    fw = "",
    last = null,
    more = null,
    lastLog = null,
    support = false; // the connected firmware has command 3120

  // The page shows one step of the flow at a time: connect, ready (set up), run (at the reader) or done (results).
  const setState = (state) =>
    showState(state, {
      connect: ["current"],
      ready: ["done", "current"],
      run: ["done", "done", "current"],
      done: ["done", "done", "done", "current"],
    });

  async function exp(req) {
    const r = await cu.cmd(F.CMD_EXP_FSK, req);
    if (r.status === STATUS_INVALID_CMD)
      throw Object.assign(
        new Error(`this firmware ${V.lacks}. Flash ${V.flashIt} first`),
        { noSupport: true },
      );
    if (r.status !== STATUS_SUCCESS)
      throw new Error(`3120 returned status 0x${r.status.toString(16)}`);
    return F.parse(r.data);
  }
  const readMore = async (req) =>
    V.readMore ? await V.readMore(cu, req) : null;

  const { run } = oneAtATime();

  // What the variant's hooks reach.
  const page = {
    cu: () => cu,
    run,
    exp,
    plan: null,
    renderPlan: () => renderPlan(),
    refresh: (r) => render((last = r)),
    get more() {
      return more;
    },
  };

  // -------------------------------------------------------------- connect and firmware

  async function connect() {
    cu = await openCU(cu);
    if (!cu) throw new Error("no Web Serial");
    fw = await cu.version();
    log(`connected, firmware ${fw}`);
    try {
      last = await exp(F.reqQuery());
      more = await readMore();
      support = true;
    } catch (e) {
      if (!e.noSupport) throw e;
      support = false;
      last = null;
    }
    const current = fw.includes(V.firmware.test.version);
    $("fwinfo").textContent = !support
      ? `Firmware ${fw} ${V.lacks}. Flash ${V.flashIt} below, then connect again.`
      : current
        ? `Firmware ${fw}, the current test build.`
        : `Firmware ${fw}, an older test build. Flash the current one below before testing.`;
    $("flashTest").className = support && current ? "" : "primary";
    $("setup").hidden = !support;
    for (const id of ["backup", "restore"]) $(id).disabled = !support;
  }

  $("connect").onclick = () =>
    run("connect", async () => {
      try {
        await connect();
      } catch (e) {
        $("connectinfo").textContent = `Couldn't connect: ${e.message}`;
        throw e;
      }
      // A CU that has already seen a reader goes straight to its results.
      if (support && V.hasResults(last)) await showResults();
      else {
        renderPlan();
        setState("ready");
      }
    });

  bindFlashButtons({
    firmware: V.firmware,
    port: () => cu?.port ?? null,
    release: async () => {
      await cu?.close();
      cu = null;
      support = false;
    },
    done: (f) => {
      $("connectinfo").textContent =
        `Flashed ${f.name}. Connect again to continue.`;
      setState("connect");
    },
  });

  // -------------------------------------------------------------- set up: copy a card into slots

  const plan = new Map(); // slot -> mode, for the slots the card goes into
  V.plan.forEach((mode, i) => plan.set(i, mode));
  page.plan = plan;

  function renderPlan() {
    const r = last,
      tb = $("plan"),
      src = $("src");
    if (!r) return;
    const prev = src.value;
    src.textContent = "";
    const fsk = r.slots.filter((s) => F.EMU_ID[s.lfType]);
    for (const s of fsk)
      src.append(
        new Option(`slot ${s.slot + 1}: ${F.lfName(s.lfType)}`, s.slot),
      );
    if (!fsk.length)
      src.append(new Option("no HID Prox, Paradox or ioProx slot", ""));
    if ([...src.options].some((o) => o.value === prev)) src.value = prev;
    src.disabled = !fsk.length;
    const from = src.value === "" ? null : r.slots[Number(src.value)];
    tb.textContent = "";
    for (const s of r.slots) {
      const tr = document.createElement("tr");
      const td = (el = "", cls) => {
        const c = document.createElement("td");
        if (typeof el === "string") c.textContent = el;
        else c.append(el);
        if (cls) c.className = cls;
        tr.append(c);
        return c;
      };
      V.planUse?.(page, s, td, from);
      td(String(s.slot + 1));
      const isSrc = from && s.slot === from.slot;
      const now = td(
        isSrc ? `${F.lfName(s.lfType)} (the card to copy)` : F.lfName(s.lfType),
      );
      if (!isSrc && plan.has(s.slot) && s.lfType) {
        now.className = "warn";
        now.textContent += " — will be replaced";
      }
      V.planMode(page, s, td);
      tb.append(tr);
    }
    $("apply").disabled = !from || !plan.size;
    renderScanSlots();
  }

  // The slot a card is read into: by default the first slot with no LF card. If every slot has one, the person
  // chooses which to replace.
  function renderScanSlots() {
    const sel = $("scanslot"),
      prev = sel.value;
    sel.textContent = "";
    sel.append(new Option("choose a slot", ""));
    for (const s of last.slots)
      sel.append(
        new Option(
          `slot ${s.slot + 1}${s.lfType ? `: ${F.lfName(s.lfType)}` : " (empty)"}`,
          s.slot,
        ),
      );
    const empty = last.slots.find((s) => !s.lfType);
    sel.value = prev !== "" ? prev : empty ? String(empty.slot) : "";
    $("scan").disabled = sel.value === "";
  }
  $("scanslot").onchange = () =>
    ($("scan").disabled = $("scanslot").value === "");
  $("src").onchange = renderPlan;

  $("apply").onclick = () =>
    run("set up the test", async () => {
      const from = last.slots[Number($("src").value)];
      const type = from.lfType,
        [get, set, len] = F.EMU_ID[type];
      const targets = [...plan.entries()].sort((a, b) => a[0] - b[0]);
      const replaced = targets
        .filter(([t]) => t !== from.slot && last.slots[t].lfType)
        .map(([t]) => `slot ${t + 1} (${F.lfName(last.slots[t].lfType)})`);
      const lost = targets
        .filter(
          ([t]) =>
            t !== from.slot &&
            last.slots[t].lfType &&
            !F.LF_CARD[last.slots[t].lfType],
        )
        .map(([t]) => `slot ${t + 1} (${F.lfName(last.slots[t].lfType)})`);
      if (
        !confirm(
          `Copy the ${F.lfName(type)} card from slot ${from.slot + 1} into ${targets.map(([t]) => t + 1).join(", ")}` +
            `${V.confirmModes ?? ""}? A backup of every slot downloads first.` +
            (replaced.length
              ? `\n\nThis replaces the LF card in ${replaced.join(", ")}.`
              : "") +
            (V.confirmNote?.(last) ?? "") +
            (lost.length
              ? `\n\n⚠ The backup can't hold ${lost.join(", ")}. This firmware can't read that card type, and replacing it loses the card.`
              : ""),
        )
      )
        return;
      await backupNow();
      $("planinfo").textContent = "reading the card…";
      await cu.ok(F.CMD.SET_ACTIVE_SLOT, F.reqSlot(from.slot));
      let card = (await cu.ok(get)).data.slice(0, len);
      if (card.length !== len)
        throw new Error(
          `the card in slot ${from.slot + 1} is ${card.length} bytes, expected ${len}`,
        );
      try {
        for (const [t, mode] of targets) {
          $("planinfo").textContent = `slot ${t + 1}…`;
          if (t !== from.slot) {
            await cu.ok(F.CMD.SET_SLOT_TAG_TYPE, F.reqSlotType(t, type));
            await cu.ok(F.CMD.SET_SLOT_DATA_DEFAULT, F.reqSlotType(t, type));
            await cu.ok(F.CMD.SET_ACTIVE_SLOT, F.reqSlot(t));
            await cu.ok(set, card);
            await cu.ok(F.CMD.SET_SLOT_ENABLE, F.reqEnableLf(t));
          }
          await cu.ok(
            F.CMD.SET_SLOT_TAG_NICK,
            F.reqNickLf(t, X.presetNick(type, mode, t)),
          );
          await V.setMode?.(page, t, mode);
          log(
            `slot ${t + 1}: ${t === from.slot ? "kept its card" : "card copied"}, mode ${X.presetName(mode)}`,
          );
        }
        await V.afterCopy?.(page);
        await cu.ok(F.CMD.SET_ACTIVE_SLOT, F.reqSlot(targets[0][0]));
        await cu.ok(F.CMD.SLOT_DATA_CONFIG_SAVE);
        log(`saved; slot ${targets[0][0] + 1} is active`);
        $("planinfo").textContent =
          `Done. Slot ${targets[0][0] + 1} is active.`;
      } finally {
        card.fill(0);
        card = null;
      }
      last = await exp(F.reqQuery());
      renderPlan();
    });

  // Read a card on the CU's antenna into a slot. The CU goes back to tag mode afterwards, even if the read fails.
  const SCAN_SECONDS = 20;
  function scanInfo(text, kind = "") {
    $("scaninfo").textContent = text;
    $("scaninfo").className = `note ${kind}`;
  }
  async function scanCard() {
    const end = Date.now() + SCAN_SECONDS * 1000;
    while (Date.now() < end) {
      for (const [type, cmd, req, len] of F.SCANS) {
        const r = await cu.cmd(cmd, Uint8Array.from(req));
        if (r.status === F.STATUS_LF_TAG_OK)
          return { type, card: r.data.slice(0, len) };
        if (r.status !== F.STATUS_LF_TAG_NO_FOUND)
          throw new Error(
            `scan ${cmd} returned status 0x${r.status.toString(16)}`,
          );
      }
    }
    return null;
  }
  $("scan").onclick = () =>
    run("read a card", async () => {
      const t = Number($("scanslot").value),
        was = last.slots[t].lfType;
      if (
        was &&
        !confirm(
          `Replace the ${F.lfName(was)} card in slot ${t + 1}? A backup of every slot downloads first.` +
            (F.LF_CARD[was]
              ? ""
              : `\n\n⚠ The backup can't hold slot ${t + 1} (${F.lfName(was)}). This firmware can't read that card type, and replacing it loses the card.`),
        )
      )
        return;
      if (was) await backupNow();
      scanInfo("Hold the card flat against the CU's button side…");
      await cu.ok(F.CHANGE_DEVICE_MODE, Uint8Array.of(1));
      let found = null;
      try {
        found = await scanCard();
      } catch (e) {
        scanInfo(`Couldn't read a card: ${e.message}`, "bad");
        throw e;
      } finally {
        await cu.ok(F.CHANGE_DEVICE_MODE, Uint8Array.of(0));
      }
      if (!found) {
        scanInfo(
          `No HID Prox, Paradox or ioProx card found in ${SCAN_SECONDS} s. Try again, moving the card slowly.`,
        );
        return;
      }
      try {
        await cu.ok(F.CMD.SET_SLOT_TAG_TYPE, F.reqSlotType(t, found.type));
        await cu.ok(F.CMD.SET_SLOT_DATA_DEFAULT, F.reqSlotType(t, found.type));
        await cu.ok(F.CMD.SET_ACTIVE_SLOT, F.reqSlot(t));
        await cu.ok(F.EMU_ID[found.type][1], found.card);
        await cu.ok(F.CMD.SET_SLOT_ENABLE, F.reqEnableLf(t));
        await cu.cmd(F.CMD.DELETE_SLOT_TAG_NICK, F.reqSlotLf(t)); // a nickname may name the old card's mode
        await cu.ok(F.CMD.SLOT_DATA_CONFIG_SAVE);
      } finally {
        found.card.fill(0);
      }
      log(`read a ${F.lfName(found.type)} card into slot ${t + 1}`);
      scanInfo(
        `${F.lfName(found.type)} card successfully read into slot ${t + 1}`,
        "ok",
      );
      last = await exp(F.reqQuery());
      renderPlan();
      $("src").value = String(t);
      renderPlan();
    });

  // Clearing first makes the results this reader's alone: a slot keeps the reader it learned last.
  async function clearAll() {
    last = await exp(F.reqClear());
    more = await readMore(F.reqClear());
    const r = await cu.cmd(F.CMD_EVENT_LOG, F.reqLogClear());
    if (r.status === STATUS_SUCCESS) log("results and event log cleared");
    else log("results cleared (this firmware has no event log)");
  }

  $("toTest").onclick = () =>
    run("start the test", async () => {
      await clearAll();
      $("testinfo").textContent = "";
      setState("run");
    });
  $("backToSetup").onclick = () => setState(cu ? "ready" : "connect");

  // -------------------------------------------------------------- results

  // Back from the reader the CU has usually been unplugged, so this connects again if it needs to.
  $("readResults").onclick = () =>
    run("read the results", async () => {
      try {
        last = await exp(F.reqQuery());
      } catch {
        $("testinfo").textContent = "Choose the CU's port again.";
        await connect();
        if (!support) {
          setState("ready");
          return;
        }
      }
      await showResults();
    });

  async function showResults() {
    last = await exp(F.reqQuery());
    more = await readMore();
    render(last);
    await readLog();
    setState("done");
  }

  function render(r) {
    const tb = $("slots");
    tb.textContent = "";
    for (const s of r.slots) {
      const tr = document.createElement("tr");
      if (s.slot === r.active) tr.className = "active";
      const td = (text, cls) => {
        const c = document.createElement("td");
        c.textContent = text;
        if (cls) c.className = cls;
        tr.append(c);
        return c;
      };
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "active";
      radio.checked = s.slot === r.active;
      const usable = !V.emptyInactive || s.lfType;
      radio.disabled = !usable; // an empty slot (the pulse page's slot 8, after setup) can't be chosen
      radio.title = usable
        ? `Make slot ${s.slot + 1} the active slot`
        : `Slot ${s.slot + 1} is empty`;
      radio.onchange = () =>
        run("change the active slot", async () => {
          await cu.ok(F.CMD.SET_ACTIVE_SLOT, F.reqSlot(s.slot));
          await cu.ok(F.CMD.SLOT_DATA_CONFIG_SAVE); // kept after a restart, as the CU's buttons do
          log(`slot ${s.slot + 1} is now active`);
          last = await exp(F.reqQuery());
          more = await readMore();
          render(last);
        });
      td("").append(radio);
      td(String(s.slot + 1));
      td(F.lfName(s.lfType), s.lfType ? "" : "dim");
      V.resultMode(page, s, td, r);
      td(String(s.fields), s.fields ? "" : "dim");
      V.resultCells(page, s, td);
      tb.append(tr);
    }
    V.renderDone(page, r, fw);
  }

  async function readLog() {
    const r = await cu.cmd(F.CMD_EVENT_LOG, F.reqLog());
    const l = r.status === STATUS_SUCCESS ? F.parseLog(r.data) : null;
    lastLog = l;
    $("evlog").className = l ? "" : "dim";
    $("evlog").textContent = l
      ? F.logReport(l, fw)
      : "This firmware has no self-trim event log, or the log is empty.";
    return l;
  }

  const fullReport = () =>
    X.report(last, fw, more) +
    (lastLog ? "\n\n" + F.logReport(lastLog, fw) : "");

  $("copy").onclick = async () => {
    if (!last) return;
    const text = fullReport();
    try {
      await navigator.clipboard.writeText(text);
      log("report copied");
    } catch {
      log("couldn't copy; here it is:");
      log("\n" + text);
    }
  };
  $("saveReport").onclick = () => {
    if (!last) return;
    const t = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    saveJson(`${V.name}-report-${t}.json`, {
      firmware: fw,
      read: new Date().toISOString(),
      report: X.report(last, fw, more),
      slots: last.slots.map(({ slot, lfType, preset, fields, kept }) => ({
        slot,
        lfType,
        preset,
        fields,
        kept,
      })),
      ...V.saveExtra?.(page),
      eventLog: lastLog,
    });
  };
  $("nextReader").onclick = () =>
    run("start the next reader", async () => {
      if (
        !confirm(
          "Clear the results and the event log for the next reader? Copy the report first if you need it. Slots and modes are kept.",
        )
      )
        return;
      await clearAll();
      setState("run");
    });
  $("newSetup").onclick = () => {
    renderPlan();
    setState("ready");
  };

  // -------------------------------------------------------------- backup and restore

  async function readBackup() {
    const r = await exp(F.reqQuery());
    const enabled = (await cu.ok(F.CMD.GET_ENABLED_SLOTS)).data;
    const b = {
      kind: F.BACKUP_KIND,
      version: 1,
      created: new Date().toISOString(),
      firmware: fw,
      active: r.active,
      slots: [],
    };
    for (const s of r.slots) {
      /** @type {Record<string, any>} */
      const e = {
        slot: s.slot,
        lfType: s.lfType,
        lfEnabled: !!enabled[s.slot * 2 + 1],
        ...(V.backupHf && { hfEnabled: !!enabled[s.slot * 2] }),
        preset: s.stored,
        nick: null,
        card: null,
      };
      const n = await cu.cmd(F.CMD.GET_SLOT_TAG_NICK, F.reqSlotLf(s.slot));
      if (n.status === STATUS_SUCCESS)
        e.nick = new TextDecoder().decode(n.data);
      const io = F.LF_CARD[s.lfType];
      if (io) {
        await cu.ok(F.CMD.SET_ACTIVE_SLOT, F.reqSlot(s.slot));
        e.card = F.hex((await cu.ok(io[0])).data.slice(io[2]));
      } else if (s.lfType) {
        e.unreadable = `${F.lfName(s.lfType)}: this firmware can't read this card type back`;
      }
      b.slots.push(e);
    }
    await cu.ok(F.CMD.SET_ACTIVE_SLOT, F.reqSlot(r.active));
    return b;
  }

  const saveFile = (b) =>
    saveJson(
      `cu-lf-slots-${b.created.replace(/[:.]/g, "").slice(0, 15)}.json`,
      b,
    );

  async function backupNow() {
    $("backupinfo").textContent = "reading every slot…";
    const b = await readBackup();
    saveFile(b);
    const bad = b.slots.filter((e) => e.unreadable);
    log(
      `backup downloaded: ${b.slots.filter((e) => e.card).length} LF cards` +
        (bad.length
          ? `; not readable here: ${bad.map((e) => `slot ${e.slot + 1} (${F.lfName(e.lfType)})`).join(", ")}`
          : ""),
    );
    $("backupinfo").textContent = "backup downloaded";
    return b;
  }

  $("backup").onclick = () => run("backup", backupNow);
  $("restore").onclick = () => $("restorefile").click();
  $("restorefile").onchange = () =>
    run("restore", async () => {
      const f = $("restorefile").files[0];
      $("restorefile").value = "";
      if (!f) return;
      const b = F.checkBackup(JSON.parse(await f.text()));
      const skip = b.slots.filter((e) => e.unreadable);
      if (
        !confirm(
          `Restore every slot's LF side from the backup of ${b.created.slice(0, 16).replace("T", " ")}?` +
            (skip.length
              ? `\n\nThese can't be restored from it and are left as they are now: ${skip.map((e) => `slot ${e.slot + 1}`).join(", ")}.`
              : ""),
        )
      )
        return;
      for (const e of b.slots) {
        if (e.unreadable) continue;
        $("backupinfo").textContent = `slot ${e.slot + 1}…`;
        if (!e.lfType) {
          await cu.cmd(F.CMD.DELETE_SLOT_SENSE_TYPE, F.reqSlotLf(e.slot)); // the slot had no LF card
        } else {
          const io = F.LF_CARD[e.lfType];
          if (!io)
            throw new Error(
              `slot ${e.slot + 1}: this firmware can't write ${F.lfName(e.lfType)}`,
            );
          await cu.ok(F.CMD.SET_SLOT_TAG_TYPE, F.reqSlotType(e.slot, e.lfType));
          await cu.ok(
            F.CMD.SET_SLOT_DATA_DEFAULT,
            F.reqSlotType(e.slot, e.lfType),
          );
          await cu.ok(F.CMD.SET_ACTIVE_SLOT, F.reqSlot(e.slot));
          let card = F.unhex(e.card);
          try {
            await cu.ok(io[1], card);
          } finally {
            card.fill(0);
          }
          await cu.ok(
            F.CMD.SET_SLOT_ENABLE,
            F.reqEnableLf(e.slot, e.lfEnabled),
          );
        }
        if (e.nick)
          await cu.ok(F.CMD.SET_SLOT_TAG_NICK, F.reqNickLf(e.slot, e.nick));
        else await cu.cmd(F.CMD.DELETE_SLOT_TAG_NICK, F.reqSlotLf(e.slot));
        if (V.backupHf && e.hfEnabled !== undefined)
          await cu.ok(
            F.CMD.SET_SLOT_ENABLE,
            F.reqEnableHf(e.slot, e.hfEnabled),
          );
        await V.setMode?.(page, e.slot, e.preset);
      }
      await cu.ok(F.CMD.SET_ACTIVE_SLOT, F.reqSlot(b.active));
      await cu.ok(F.CMD.SLOT_DATA_CONFIG_SAVE);
      log(
        `restored from the backup of ${b.created}; slot ${b.active + 1} active`,
      );
      $("backupinfo").textContent = "restored";
      last = await exp(F.reqQuery());
      if ($("app").dataset.state === "done") render(last);
      else renderPlan();
    });

  setState("connect");
  showSiteCommit($("siteversion"));
  return page;
}
