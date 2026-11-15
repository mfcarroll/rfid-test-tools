// The FSK self-trim page (index.html): connecting the CU, setting up the slots, and reading the results.

import { STATUS_SUCCESS, STATUS_INVALID_CMD } from "../common/cu.js";
import { bindFlashButtons } from "../common/flash-ui.js";
import { openCU } from "../common/session.js";
import {
  $,
  log,
  saveJson,
  showSiteCommit,
  showState,
  oneAtATime,
} from "../../common/page.js";
import * as X from "./selftrim.js";

const FIRMWARE = {
  test: {
    zip: "firmware/fsk-selftrim-489-0609420c-ultra-dfu-app.zip",
    name: "test firmware (fsk-selftrim-489 0609420c)",
    version: "v2.3.0-26-g0609420",
  },
  stock: {
    zip: "../common/firmware/stock-v2.3.0-ultra-dfu-app.zip",
    name: "stock v2.3.0",
  },
};
// The test firmware's commit, on its flash button
$("fwname").textContent = FIRMWARE.test.name.match(/([0-9a-f]{7,8})\)$/)[1];

let cu = null,
  fw = "",
  last = null,
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
  const r = await cu.cmd(X.CMD_EXP_FSK, req);
  if (r.status === STATUS_INVALID_CMD)
    throw Object.assign(
      new Error(
        "this firmware has no self-trim support. Flash the test firmware first",
      ),
      { noSupport: true },
    );
  if (r.status !== STATUS_SUCCESS)
    throw new Error(`3120 returned status 0x${r.status.toString(16)}`);
  return X.parse(r.data);
}

const { run } = oneAtATime();

// ---------------------------------------------------------------- connect and firmware

async function connect() {
  cu = await openCU(cu);
  if (!cu) throw new Error("no Web Serial");
  fw = await cu.version();
  log(`connected, firmware ${fw}`);
  try {
    last = await exp(X.reqQuery());
    support = true;
  } catch (e) {
    if (!e.noSupport) throw e;
    support = false;
    last = null;
  }
  const current = fw.includes(FIRMWARE.test.version);
  $("fwinfo").textContent = !support
    ? `Firmware ${fw} has no self-trim support. Flash the test firmware below, then connect again.`
    : current
      ? `Firmware ${fw}, the current test build.`
      : `Firmware ${fw}, an older test build. Flash the current one below before testing.`;
  $("flashTest").className = support && current ? "" : "primary";
  $("setup").hidden = !support;
  for (const id of ["backup", "restore"]) $(id).disabled = !support;
}

// A CU that has already seen a reader goes straight to its results.
const hasResults = (r) => r.slots.some((s) => s.fields || s.kept);

$("connect").onclick = () =>
  run("connect", async () => {
    try {
      await connect();
    } catch (e) {
      $("connectinfo").textContent = `Couldn't connect: ${e.message}`;
      throw e;
    }
    if (support && hasResults(last)) await showResults();
    else {
      renderPlan();
      setState("ready");
    }
  });

bindFlashButtons({
  firmware: FIRMWARE,
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

// ---------------------------------------------------------------- set up: copy a card into slots

const plan = new Map(); // slot -> mode, for the slots ticked
X.PLANS[4].forEach((mode, i) => plan.set(i, mode));

function renderPlan() {
  const r = last,
    tb = $("plan"),
    src = $("src");
  if (!r) return;
  const prev = src.value;
  src.textContent = "";
  const fsk = r.slots.filter((s) => X.EMU_ID[s.lfType]);
  for (const s of fsk)
    src.append(new Option(`slot ${s.slot + 1}: ${X.lfName(s.lfType)}`, s.slot));
  if (!fsk.length)
    src.append(new Option("no HID Prox, Paradox or ioProx slot", ""));
  if ([...src.options].some((o) => o.value === prev)) src.value = prev;
  src.disabled = !fsk.length;
  const from = src.value === "" ? null : r.slots[Number(src.value)];
  tb.textContent = "";
  for (const s of r.slots) {
    const tr = document.createElement("tr");
    const td = (el) => {
      const c = document.createElement("td");
      if (typeof el === "string") c.textContent = el;
      else c.append(el);
      tr.append(c);
      return c;
    };
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = plan.has(s.slot);
    cb.disabled = !from;
    td(cb);
    td(String(s.slot + 1));
    const isSrc = from && s.slot === from.slot;
    const now = td(
      isSrc ? `${X.lfName(s.lfType)} (the card to copy)` : X.lfName(s.lfType),
    );
    if (!isSrc && plan.has(s.slot) && s.lfType) {
      now.className = "warn";
      now.textContent += " — will be replaced";
    }
    const sel = document.createElement("select");
    X.CHOICES.forEach((p) => sel.append(new Option(X.presetName(p), p)));
    sel.value = String(plan.get(s.slot) ?? s.preset);
    sel.disabled = !cb.checked;
    td(sel);
    cb.onchange = () => {
      if (cb.checked) plan.set(s.slot, Number(sel.value));
      else plan.delete(s.slot);
      renderPlan();
    };
    sel.onchange = () => plan.set(s.slot, Number(sel.value));
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
        `slot ${s.slot + 1}${s.lfType ? `: ${X.lfName(s.lfType)}` : " (empty)"}`,
        s.slot,
      ),
    );
  const empty = last.slots.find((s) => !s.lfType);
  sel.value = prev !== "" ? prev : empty ? String(empty.slot) : "";
  $("scan").disabled = sel.value === "";
}
$("scanslot").onchange = () =>
  ($("scan").disabled = $("scanslot").value === "");

function fillPlan(n) {
  plan.clear();
  X.PLANS[n].forEach((mode, i) => plan.set(i, mode)); // slots 1..n
  renderPlan();
}
$("src").onchange = renderPlan;
$("plan4").onclick = () => fillPlan(4);
$("plan6").onclick = () => fillPlan(6);

$("apply").onclick = () =>
  run("set up the test", async () => {
    const from = last.slots[Number($("src").value)];
    const type = from.lfType,
      [get, set, len] = X.EMU_ID[type];
    const targets = [...plan.entries()].sort((a, b) => a[0] - b[0]);
    const replaced = targets
      .filter(([t]) => t !== from.slot && last.slots[t].lfType)
      .map(([t]) => `slot ${t + 1} (${X.lfName(last.slots[t].lfType)})`);
    const lost = targets
      .filter(
        ([t]) =>
          t !== from.slot &&
          last.slots[t].lfType &&
          !X.LF_CARD[last.slots[t].lfType],
      )
      .map(([t]) => `slot ${t + 1} (${X.lfName(last.slots[t].lfType)})`);
    if (
      !confirm(
        `Copy the ${X.lfName(type)} card from slot ${from.slot + 1} into ${targets.map(([t]) => t + 1).join(", ")}` +
          ` and set their modes? A backup of every slot downloads first.` +
          (replaced.length
            ? `\n\nThis replaces the LF card in ${replaced.join(", ")}.`
            : "") +
          (lost.length
            ? `\n\n⚠ The backup can't hold ${lost.join(", ")}. This firmware can't read that card type, and replacing it loses the card.`
            : ""),
      )
    )
      return;
    await backupNow();
    $("planinfo").textContent = "reading the card…";
    await cu.ok(X.CMD.SET_ACTIVE_SLOT, X.reqSlot(from.slot));
    let card = (await cu.ok(get)).data.slice(0, len);
    if (card.length !== len)
      throw new Error(
        `the card in slot ${from.slot + 1} is ${card.length} bytes, expected ${len}`,
      );
    try {
      for (const [t, mode] of targets) {
        $("planinfo").textContent = `slot ${t + 1}…`;
        if (t !== from.slot) {
          await cu.ok(X.CMD.SET_SLOT_TAG_TYPE, X.reqSlotType(t, type));
          await cu.ok(X.CMD.SET_SLOT_DATA_DEFAULT, X.reqSlotType(t, type));
          await cu.ok(X.CMD.SET_ACTIVE_SLOT, X.reqSlot(t));
          await cu.ok(set, card);
          await cu.ok(X.CMD.SET_SLOT_ENABLE, X.reqEnableLf(t));
        }
        await cu.ok(
          X.CMD.SET_SLOT_TAG_NICK,
          X.reqNickLf(t, X.presetNick(type, mode)),
        );
        await exp(X.reqSet(t, mode));
        log(
          `slot ${t + 1}: ${t === from.slot ? "kept its card" : "card copied"}, mode ${X.presetName(mode)}`,
        );
      }
      await cu.ok(X.CMD.SET_ACTIVE_SLOT, X.reqSlot(targets[0][0]));
      await cu.ok(X.CMD.SLOT_DATA_CONFIG_SAVE);
      log(`saved; slot ${targets[0][0] + 1} is active`);
      $("planinfo").textContent = `Done. Slot ${targets[0][0] + 1} is active.`;
    } finally {
      card.fill(0);
      card = null;
    }
    last = await exp(X.reqQuery());
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
    for (const [type, cmd, req, len] of X.SCANS) {
      const r = await cu.cmd(cmd, Uint8Array.from(req));
      if (r.status === X.STATUS_LF_TAG_OK)
        return { type, card: r.data.slice(0, len) };
      if (r.status !== X.STATUS_LF_TAG_NO_FOUND)
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
        `Replace the ${X.lfName(was)} card in slot ${t + 1}? A backup of every slot downloads first.` +
          (X.LF_CARD[was]
            ? ""
            : `\n\n⚠ The backup can't hold slot ${t + 1} (${X.lfName(was)}). This firmware can't read that card type, and replacing it loses the card.`),
      )
    )
      return;
    if (was) await backupNow();
    scanInfo("Hold the card flat against the CU's button side…");
    await cu.ok(X.CHANGE_DEVICE_MODE, Uint8Array.of(1));
    let found = null;
    try {
      found = await scanCard();
    } catch (e) {
      scanInfo(`Couldn't read a card: ${e.message}`, "bad");
      throw e;
    } finally {
      await cu.ok(X.CHANGE_DEVICE_MODE, Uint8Array.of(0));
    }
    if (!found) {
      scanInfo(
        `No HID Prox, Paradox or ioProx card found in ${SCAN_SECONDS} s. Try again, moving the card slowly.`,
      );
      return;
    }
    try {
      await cu.ok(X.CMD.SET_SLOT_TAG_TYPE, X.reqSlotType(t, found.type));
      await cu.ok(X.CMD.SET_SLOT_DATA_DEFAULT, X.reqSlotType(t, found.type));
      await cu.ok(X.CMD.SET_ACTIVE_SLOT, X.reqSlot(t));
      await cu.ok(X.EMU_ID[found.type][1], found.card);
      await cu.ok(X.CMD.SET_SLOT_ENABLE, X.reqEnableLf(t));
      await cu.cmd(X.CMD.DELETE_SLOT_TAG_NICK, X.reqSlotLf(t)); // a nickname may name the old card's mode
      await cu.ok(X.CMD.SLOT_DATA_CONFIG_SAVE);
    } finally {
      found.card.fill(0);
    }
    log(`read a ${X.lfName(found.type)} card into slot ${t + 1}`);
    scanInfo(
      `${X.lfName(found.type)} card successfully read into slot ${t + 1}`,
      "ok",
    );
    last = await exp(X.reqQuery());
    renderPlan();
    $("src").value = String(t);
    renderPlan();
  });

// Clearing first makes the results this reader's alone: a slot keeps the reader it learned last.
async function clearAll() {
  last = await exp(X.reqClear());
  const r = await cu.cmd(X.CMD_EVENT_LOG, X.reqLogClear());
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

// ---------------------------------------------------------------- results

// Back from the reader the CU has usually been unplugged, so this connects again if it needs to.
$("readResults").onclick = () =>
  run("read the results", async () => {
    try {
      last = await exp(X.reqQuery());
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
  last = await exp(X.reqQuery());
  render(last);
  await readLog();
  setState("done");
}

function render(r) {
  const tb = $("slots");
  tb.textContent = "";
  let far = false;
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
    radio.title = `Make slot ${s.slot + 1} the active slot`;
    radio.onchange = () =>
      run("change the active slot", async () => {
        await cu.ok(X.CMD.SET_ACTIVE_SLOT, X.reqSlot(s.slot));
        await cu.ok(X.CMD.SLOT_DATA_CONFIG_SAVE); // kept after a restart, as the CU's buttons do
        log(`slot ${s.slot + 1} is now active`);
        render((last = await exp(X.reqQuery())));
      });
    td("").append(radio);
    td(String(s.slot + 1));
    const fsk = X.FSK_TYPES.has(s.lfType);
    td(X.lfName(s.lfType), s.lfType ? "" : "dim");
    const mode = td("");
    const sel = document.createElement("select");
    X.CHOICES.forEach((p) =>
      sel.append(
        new Option(
          X.presetName(p) + (p === r.defaultPreset ? " (default)" : ""),
          p,
        ),
      ),
    );
    sel.value = String(s.preset);
    sel.onchange = () =>
      run("set mode", async () => {
        render((last = await exp(X.reqSet(s.slot, Number(sel.value)))));
        log(
          `slot ${s.slot + 1}: mode ${X.presetName(Number(sel.value))}, saved`,
        );
      });
    mode.append(sel);
    if (!fsk) mode.className = "dim";
    td(String(s.fields), s.fields ? "" : "dim");
    if (s.kept) {
      const f = X.farOff(s.kept.readerPpm);
      far ||= f;
      td(
        `${X.fmtPpm(s.kept.readerPpm)} ppm${f ? " ⚠" : ""}${s.kept.lfType !== s.lfType ? ` (learned as ${X.lfName(s.kept.lfType)})` : ""}`,
        f ? "warn" : "",
      );
      td(String(s.kept.fields));
    } else {
      td("–", "dim");
      td("–", "dim");
    }
    tb.append(tr);
  }
  $("farnote").hidden = !far;
  const a = r.auto;
  $("live").textContent =
    `Firmware ${fw}. Active slot ${r.active + 1}: ${a.locked ? "locked to a reader" : "no reader locked"}, ` +
    `${a.wides} wide searches, ${a.restores} learned readers restored.`;
}

async function readLog() {
  const r = await cu.cmd(X.CMD_EVENT_LOG, X.reqLog());
  const l = r.status === STATUS_SUCCESS ? X.parseLog(r.data) : null;
  lastLog = l;
  $("evlog").className = l ? "" : "dim";
  $("evlog").textContent = l
    ? X.logReport(l, fw)
    : "This firmware has no self-trim event log, or the log is empty.";
  return l;
}

const fullReport = () =>
  X.report(last, fw) + (lastLog ? "\n\n" + X.logReport(lastLog, fw) : "");

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
  saveJson(`selftrim-report-${t}.json`, {
    firmware: fw,
    read: new Date().toISOString(),
    report: X.report(last, fw),
    slots: last.slots.map(({ slot, lfType, preset, fields, kept }) => ({
      slot,
      lfType,
      preset,
      fields,
      kept,
    })),
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

// ---------------------------------------------------------------- backup and restore

async function readBackup() {
  const r = await exp(X.reqQuery());
  const enabled = (await cu.ok(X.CMD.GET_ENABLED_SLOTS)).data;
  const b = {
    kind: X.BACKUP_KIND,
    version: 1,
    created: new Date().toISOString(),
    firmware: fw,
    active: r.active,
    slots: [],
  };
  for (const s of r.slots) {
    const e = {
      slot: s.slot,
      lfType: s.lfType,
      lfEnabled: !!enabled[s.slot * 2 + 1],
      preset: s.stored,
      nick: null,
      card: null,
    };
    const n = await cu.cmd(X.CMD.GET_SLOT_TAG_NICK, X.reqSlotLf(s.slot));
    if (n.status === STATUS_SUCCESS) e.nick = new TextDecoder().decode(n.data);
    const io = X.LF_CARD[s.lfType];
    if (io) {
      await cu.ok(X.CMD.SET_ACTIVE_SLOT, X.reqSlot(s.slot));
      e.card = X.hex((await cu.ok(io[0])).data.slice(io[2]));
    } else if (s.lfType) {
      e.unreadable = `${X.lfName(s.lfType)}: this firmware can't read this card type back`;
    }
    b.slots.push(e);
  }
  await cu.ok(X.CMD.SET_ACTIVE_SLOT, X.reqSlot(r.active));
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
        ? `; not readable here: ${bad.map((e) => `slot ${e.slot + 1} (${X.lfName(e.lfType)})`).join(", ")}`
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
    const b = X.checkBackup(JSON.parse(await f.text()));
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
        await cu.cmd(X.CMD.DELETE_SLOT_SENSE_TYPE, X.reqSlotLf(e.slot)); // the slot had no LF card
      } else {
        const io = X.LF_CARD[e.lfType];
        if (!io)
          throw new Error(
            `slot ${e.slot + 1}: this firmware can't write ${X.lfName(e.lfType)}`,
          );
        await cu.ok(X.CMD.SET_SLOT_TAG_TYPE, X.reqSlotType(e.slot, e.lfType));
        await cu.ok(
          X.CMD.SET_SLOT_DATA_DEFAULT,
          X.reqSlotType(e.slot, e.lfType),
        );
        await cu.ok(X.CMD.SET_ACTIVE_SLOT, X.reqSlot(e.slot));
        let card = X.unhex(e.card);
        try {
          await cu.ok(io[1], card);
        } finally {
          card.fill(0);
        }
        await cu.ok(X.CMD.SET_SLOT_ENABLE, X.reqEnableLf(e.slot, e.lfEnabled));
      }
      if (e.nick)
        await cu.ok(X.CMD.SET_SLOT_TAG_NICK, X.reqNickLf(e.slot, e.nick));
      else await cu.cmd(X.CMD.DELETE_SLOT_TAG_NICK, X.reqSlotLf(e.slot));
      await exp(X.reqSet(e.slot, e.preset));
    }
    await cu.ok(X.CMD.SET_ACTIVE_SLOT, X.reqSlot(b.active));
    await cu.ok(X.CMD.SLOT_DATA_CONFIG_SAVE);
    log(
      `restored from the backup of ${b.created}; slot ${b.active + 1} active`,
    );
    $("backupinfo").textContent = "restored";
    last = await exp(X.reqQuery());
    if ($("app").dataset.state === "done") render(last);
    else renderPlan();
  });

setState("connect");
showSiteCommit($("siteversion"));
