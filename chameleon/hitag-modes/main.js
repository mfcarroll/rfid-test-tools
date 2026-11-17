// The Hitag 2 modes page (index.html): connecting the CU, copying a Hitag 2 card into the slots, setting each slot's
// mode (command 3188), and slot backups. The logic with no DOM is in hitag-modes.js.

import { bindFlashButtons, showFirmware } from "../common/flash-ui.js";
import { openCU, watchDisconnect, cuConnectCard } from "../common/session.js";
import {
  $,
  log,
  hasWebSerial,
  showState,
  setDisabled,
  oneAtATime,
  saveJson,
  showFooter,
} from "../../common/page.js";
import { parseSlotInfo } from "../common/slots.js";
import * as H from "./hitag-modes.js";

cuConnectCard({
  extra: "It works with the Chameleon Ultra only, not the Lite.",
});

const TEST_FW = {
  zip: "firmware/lf-hitag-modes-25fdc86e-ultra-dfu-app.zip",
  name: "Hitag 2 modes firmware (25fdc86e)",
  version: "v2.3.0-52-g25fdc86",
};
TEST_FW.label = `Flash the test firmware (${TEST_FW.version})`;
const STOCK = {
  zip: "../common/firmware/stock-v2.3.0-ultra-dfu-app.zip",
  name: "stock v2.3.0",
};

let cu = null,
  fw = "",
  support = false, // the firmware has command 3188
  slots = null, // each slot: { lf, nick }, from GET_SLOT_INFO and GET_SLOT_TAG_NICK
  modes = null, // each slot's mode, from command 3188
  active = 0; // the active slot

const copy = new Set(); // slots to copy the card into; starts empty so the current layout shows first
const planModes = [...H.DEFAULT_MODES]; // the chosen mode per slot

const CONTROLS = [
  "src",
  "planDefault",
  "apply",
  "setModes",
  "backup",
  "restore",
  "again",
  "reread",
];
const { run } = oneAtATime((on) => {
  setDisabled(CONTROLS, on);
  if (!on) syncButtons();
});

const setState = (state) =>
  showState(state, {
    connect: ["current"],
    ready: ["done", "current"],
    done: ["done", "done", "current"],
  });

// -------------------------------------------------------------- connect and firmware

async function readState() {
  const info = await cu.cmd(H.CMD.GET_SLOT_INFO);
  const types =
    info.status === H.STATUS_SUCCESS
      ? parseSlotInfo(info.data).map((s) => s.lf)
      : null;
  const m = await cu.cmd(H.CMD.LF_IA_SLOT_MODES);
  modes = m.status === H.STATUS_SUCCESS ? H.parseModes(m.data) : null;
  if (!types || !modes) {
    slots = null;
    return;
  }
  // The LF nickname per slot names its mode once set, so the table and the slots view show it.
  slots = [];
  for (let s = 0; s < H.SLOTS; s++) {
    const n = await cu.cmd(H.CMD.GET_SLOT_TAG_NICK, H.reqSlotLf(s));
    const nick =
      n.status === H.STATUS_SUCCESS ? new TextDecoder().decode(n.data) : "";
    slots.push({ lf: types[s], nick });
  }
  active = (await cu.ok(H.CMD.GET_ACTIVE_SLOT)).data[0];
  // The mode selects start from what the CU actually has, so the table reflects reality.
  for (let s = 0; s < H.SLOTS; s++) planModes[s] = modes[s];
  render();
  renderDone();
}

async function connect() {
  cu = await openCU(cu);
  if (!cu) throw new Error("no Web Serial");
  fw = await cu.version();
  log(`connected, firmware ${fw}`);
  // Command 3188 is the probe: a firmware without the engine answers "invalid command".
  const probe = await cu.cmd(H.CMD.LF_IA_SLOT_MODES);
  support = probe.status === H.STATUS_SUCCESS;
  const current = fw.includes(TEST_FW.version);
  showFirmware(
    !support
      ? `Firmware ${fw} has no Hitag 2 modes. Flash the test firmware below, then connect again.`
      : current
        ? `Firmware ${fw}, the current test build.`
        : `Firmware ${fw}, an older test build. Flash the current one below before testing.`,
    !(support && current),
  );
  $("setup").hidden = !support;
  for (const id of ["backup", "restore"]) $(id).disabled = !support;
  if (support) await readState();
}

$("connect").onclick = () =>
  run("connect", async () => {
    try {
      await connect();
    } catch (e) {
      $("connectinfo").textContent = `Couldn't connect: ${e.message}`;
      throw e;
    }
    setState("ready");
  });

watchDisconnect(
  () => cu,
  () => {
    cu = null;
    support = false;
    setState("connect");
  },
);

// -------------------------------------------------------------- the plan table

// The slots that hold a Hitag 2 card, for the "Card from" list.
function hitagSlots() {
  return slots
    ? slots.flatMap((s, i) => (s.lf === H.TAG_TYPE_HITAG2 ? [i] : []))
    : [];
}

// A slot's "Now" text: its card type, and its nickname when it has one (the nickname names the mode).
const slotNow = (s) =>
  H.lfName(slots[s].lf) + (slots[s].nick ? ` — ${slots[s].nick}` : "");

function syncButtons() {
  const src = $("src");
  const haveSrc = !src.disabled && src.value !== "";
  $("apply").disabled = !support || !haveSrc || copy.size === 0;
  $("setModes").disabled = !support;
}

function renderSrc() {
  const src = $("src"),
    prev = src.value;
  src.textContent = "";
  const hs = hitagSlots();
  for (const s of hs)
    src.append(
      new Option(`slot ${s + 1}: ${H.lfName(slots[s].lf)}`, String(s)),
    );
  if (!hs.length)
    src.append(
      new Option("no Hitag 2 slot — read a card on the Interactive page", ""),
    );
  src.disabled = !hs.length;
  if (hs.some((s) => String(s) === prev)) src.value = prev;
}

function render() {
  if (!slots || !modes) return;
  renderSrc();
  const src = $("src");
  const from = src.disabled || src.value === "" ? null : Number(src.value);
  const tb = $("plan");
  tb.textContent = "";
  for (let s = 0; s < H.SLOTS; s++) {
    const tr = document.createElement("tr");
    /** @param {string|Node} [el] @param {string} [cls] */
    const td = (el = "", cls) => {
      const c = document.createElement("td");
      if (typeof el === "string") c.textContent = el;
      else c.append(el);
      if (cls) c.className = cls;
      tr.append(c);
      return c;
    };

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = copy.has(s);
    cb.onchange = () => {
      if (cb.checked) copy.add(s);
      else copy.delete(s);
      render();
    };
    td(cb);

    td(String(s + 1));

    const isSrc = from === s;
    const now = td(isSrc ? `${slotNow(s)} (the card to copy)` : slotNow(s));
    if (!isSrc && copy.has(s) && slots[s].lf) {
      now.className = "warn";
      now.textContent += " — will be replaced";
    }

    const sel = document.createElement("select");
    for (const m of H.CHOICES) sel.append(new Option(H.modeName(m), String(m)));
    sel.value = String(planModes[s]);
    sel.onchange = () => (planModes[s] = Number(sel.value));
    const modeCell = td(sel);
    if (modes[s] !== planModes[s])
      modeCell.append(
        Object.assign(document.createElement("span"), {
          className: "note dim",
          textContent: ` (now ${H.modeName(modes[s])})`,
        }),
      );

    tb.append(tr);
  }
  syncButtons();
}

$("src").onchange = render;

$("planDefault").onclick = () => {
  copy.clear();
  for (let s = 0; s < H.SLOTS; s++) {
    copy.add(s);
    planModes[s] = H.DEFAULT_MODES[s];
  }
  render();
};

// -------------------------------------------------------------- the slots view (after setting up)

function renderDone() {
  if (!slots || !modes) return;
  const tb = $("slotsview");
  tb.textContent = "";
  for (let s = 0; s < H.SLOTS; s++) {
    const tr = document.createElement("tr");
    if (s === active) tr.className = "active";
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
    radio.checked = s === active;
    radio.title = `Make slot ${s + 1} the active slot`;
    radio.onchange = () =>
      run("change the active slot", async () => {
        await cu.ok(H.CMD.SET_ACTIVE_SLOT, H.reqSlot(s));
        await cu.ok(H.CMD.SLOT_DATA_CONFIG_SAVE);
        log(`slot ${s + 1} is now active`);
        await readState();
      });
    td("").append(radio);

    td(String(s + 1));
    td(H.lfName(slots[s].lf), slots[s].lf ? "" : "dim");
    td(slots[s].nick || "–", slots[s].nick ? "" : "dim");

    // Changing a mode here writes it at once (the modes live in retained RAM; no save needed).
    const sel = document.createElement("select");
    for (const m of H.CHOICES) sel.append(new Option(H.modeName(m), String(m)));
    sel.value = String(modes[s]);
    sel.onchange = () =>
      run("set the mode", async () => {
        const next = [...modes];
        next[s] = Number(sel.value);
        await cu.ok(H.CMD.LF_IA_SLOT_MODES, H.reqSetModes(next));
        // The nickname names the mode, so rename the slot to match and save it.
        await cu.ok(
          H.CMD.SET_SLOT_TAG_NICK,
          H.reqNick(s, H.SENSE_LF, H.modeNick(next[s])),
        );
        await cu.ok(H.CMD.SLOT_DATA_CONFIG_SAVE);
        log(`slot ${s + 1}: mode ${H.modeName(next[s])}`);
        await readState();
      });
    td("").appendChild(sel);

    tb.append(tr);
  }
}

$("again").onclick = () => {
  copy.clear();
  render();
  setState("ready");
};
$("reread").onclick = () => run("read the slots", readState);

// -------------------------------------------------------------- copy and set modes

$("apply").onclick = () =>
  run("set up the test", async () => {
    const from = Number($("src").value);
    const targets = [...copy].sort((a, b) => a - b);
    const replaced = targets
      .filter((t) => t !== from && slots[t].lf)
      .map((t) => `slot ${t + 1} (${H.lfName(slots[t].lf)})`);
    const lost = targets
      .filter(
        (t) => t !== from && slots[t].lf && slots[t].lf !== H.TAG_TYPE_HITAG2,
      )
      .map((t) => `slot ${t + 1} (${H.lfName(slots[t].lf)})`);
    if (
      !confirm(
        `Copy the Hitag 2 card from slot ${from + 1} into ${targets
          .map((t) => t + 1)
          .join(
            ", ",
          )} and set every slot's mode? A backup of every slot downloads first.` +
          (replaced.length
            ? `\n\nThis replaces the LF card in ${replaced.join(", ")}.`
            : "") +
          (lost.length
            ? `\n\n⚠ The backup can't hold ${lost.join(", ")}. This page can't read that card type, and replacing it loses the card.`
            : ""),
      )
    )
      return;
    await backupNow();
    $("planinfo").textContent = "reading the card…";
    await cu.ok(H.CMD.SET_ACTIVE_SLOT, H.reqSlot(from));
    let card = (await cu.ok(H.CMD.HITAG2_GET_EMU_DATA)).data.slice(
      0,
      H.HITAG2_DATA_SIZE,
    );
    if (card.length !== H.HITAG2_DATA_SIZE)
      throw new Error(
        `slot ${from + 1} sent ${card.length} bytes, expected ${H.HITAG2_DATA_SIZE}`,
      );
    try {
      for (const t of targets) {
        $("planinfo").textContent = `slot ${t + 1}…`;
        if (t !== from) {
          await cu.ok(
            H.CMD.SET_SLOT_TAG_TYPE,
            H.reqSlotType(t, H.TAG_TYPE_HITAG2),
          );
          await cu.ok(H.CMD.SET_ACTIVE_SLOT, H.reqSlot(t));
          await cu.ok(H.CMD.HITAG2_SET_EMU_DATA, card);
          await cu.ok(H.CMD.SET_SLOT_ENABLE, H.reqEnable(t, H.SENSE_LF, true));
        }
        await cu.ok(
          H.CMD.SET_SLOT_TAG_NICK,
          H.reqNick(t, H.SENSE_LF, H.modeNick(planModes[t])),
        );
        log(
          `slot ${t + 1}: ${t === from ? "kept its card" : "card copied"}, mode ${H.modeName(planModes[t])}`,
        );
      }
    } finally {
      card.fill(0);
      card = null;
    }
    await cu.ok(H.CMD.LF_IA_SLOT_MODES, H.reqSetModes(planModes));
    await cu.ok(H.CMD.SET_ACTIVE_SLOT, H.reqSlot(targets[0]));
    await cu.ok(H.CMD.SLOT_DATA_CONFIG_SAVE);
    log(`modes set; slot ${targets[0] + 1} is active`);
    await readState();
    $("doneinfo").textContent =
      `Copied the card into slot${targets.length > 1 ? "s" : ""} ${targets.map((t) => t + 1).join(", ")} and set the modes. Slot ${targets[0] + 1} is active.`;
    setState("done");
  });

$("setModes").onclick = () =>
  run("set the modes", async () => {
    await cu.ok(H.CMD.LF_IA_SLOT_MODES, H.reqSetModes(planModes));
    // The nicknames name the modes, so keep each slot's nickname in step (only where it holds a card).
    for (let s = 0; s < H.SLOTS; s++)
      if (slots[s].lf)
        await cu.ok(
          H.CMD.SET_SLOT_TAG_NICK,
          H.reqNick(s, H.SENSE_LF, H.modeNick(planModes[s])),
        );
    await cu.ok(H.CMD.SLOT_DATA_CONFIG_SAVE);
    log(`modes set: ${planModes.map((m) => H.modeName(m)).join(", ")}`);
    await readState();
    $("doneinfo").textContent = "Modes set. The cards were not changed.";
    setState("done");
  });

// -------------------------------------------------------------- backup and restore

async function readBackup() {
  const info = parseSlotInfo((await cu.ok(H.CMD.GET_SLOT_INFO)).data).map(
    (s) => s.lf,
  );
  const enabled = (await cu.ok(H.CMD.GET_ENABLED_SLOTS)).data;
  const m = H.parseModes((await cu.ok(H.CMD.LF_IA_SLOT_MODES)).data);
  const active = (await cu.ok(H.CMD.GET_ACTIVE_SLOT)).data[0];
  const b = {
    kind: H.BACKUP_KIND,
    version: 1,
    created: new Date().toISOString(),
    firmware: fw,
    active,
    slots: [],
  };
  for (let s = 0; s < H.SLOTS; s++) {
    /** @type {Record<string, any>} */
    const e = {
      slot: s,
      lfType: info[s],
      lfEnabled: !!enabled[s * 2 + 1],
      hfEnabled: !!enabled[s * 2],
      mode: m[s],
      nick: null,
      card: null,
    };
    const n = await cu.cmd(H.CMD.GET_SLOT_TAG_NICK, H.reqSlotLf(s));
    if (n.status === H.STATUS_SUCCESS)
      e.nick = new TextDecoder().decode(n.data);
    if (info[s] === H.TAG_TYPE_HITAG2) {
      await cu.ok(H.CMD.SET_ACTIVE_SLOT, H.reqSlot(s));
      e.card = H.hex(
        (await cu.ok(H.CMD.HITAG2_GET_EMU_DATA)).data.slice(
          0,
          H.HITAG2_DATA_SIZE,
        ),
      );
    } else if (info[s]) {
      e.unreadable = `${H.lfName(info[s])}: this page can't read this card type back`;
    }
    b.slots.push(e);
  }
  // Reading a Hitag 2 slot's card made it active; put the active slot back.
  await cu.ok(H.CMD.SET_ACTIVE_SLOT, H.reqSlot(active));
  return b;
}

async function backupNow() {
  $("backupinfo").textContent = "reading every slot…";
  const b = await readBackup();
  saveJson(
    `cu-hitag-slots-${b.created.replace(/[:.]/g, "").slice(0, 15)}.json`,
    b,
  );
  const bad = b.slots.filter((e) => e.unreadable);
  log(
    `backup downloaded: ${b.slots.filter((e) => e.card).length} Hitag 2 cards` +
      (bad.length
        ? `; not readable here: ${bad.map((e) => `slot ${e.slot + 1} (${H.lfName(e.lfType)})`).join(", ")}`
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
    const b = H.checkBackup(JSON.parse(await f.text()));
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
        await cu.cmd(H.CMD.DELETE_SLOT_SENSE_TYPE, H.reqSlotLf(e.slot)); // the slot had no LF card
      } else if (e.lfType === H.TAG_TYPE_HITAG2) {
        await cu.ok(
          H.CMD.SET_SLOT_TAG_TYPE,
          H.reqSlotType(e.slot, H.TAG_TYPE_HITAG2),
        );
        await cu.ok(H.CMD.SET_ACTIVE_SLOT, H.reqSlot(e.slot));
        let card = H.unhex(e.card);
        try {
          await cu.ok(H.CMD.HITAG2_SET_EMU_DATA, card);
        } finally {
          card.fill(0);
        }
        await cu.ok(
          H.CMD.SET_SLOT_ENABLE,
          H.reqEnable(e.slot, H.SENSE_LF, e.lfEnabled),
        );
      } else {
        throw new Error(
          `slot ${e.slot + 1}: this page can't write ${H.lfName(e.lfType)}`,
        );
      }
      if (e.nick)
        await cu.ok(
          H.CMD.SET_SLOT_TAG_NICK,
          H.reqNick(e.slot, H.SENSE_LF, e.nick),
        );
      else await cu.cmd(H.CMD.DELETE_SLOT_TAG_NICK, H.reqSlotLf(e.slot));
      if (e.hfEnabled !== undefined)
        await cu.ok(
          H.CMD.SET_SLOT_ENABLE,
          H.reqEnable(e.slot, H.SENSE_HF, e.hfEnabled),
        );
    }
    await cu.ok(
      H.CMD.LF_IA_SLOT_MODES,
      H.reqSetModes(b.slots.map((e) => e.mode ?? 0)),
    );
    await cu.ok(H.CMD.SET_ACTIVE_SLOT, H.reqSlot(b.active));
    await cu.ok(H.CMD.SLOT_DATA_CONFIG_SAVE);
    log(
      `restored from the backup of ${b.created}; slot ${b.active + 1} active`,
    );
    $("backupinfo").textContent = "restored";
    await readState();
  });

// -------------------------------------------------------------- firmware flashing

bindFlashButtons({
  firmware: { test: TEST_FW, stock: STOCK },
  port: () => cu?.port ?? null,
  release: async () => {
    await cu?.close();
    cu = null;
    support = false;
  },
  done: () => {
    setState("connect");
    $("connectinfo").textContent = "Flashed. Connect the CU again to continue.";
  },
});

setState("connect");
showFooter();
hasWebSerial();
