// Small helpers every tool page uses: the page's elements, its log, and sleeping that survives a hidden tab.

// The page element with this id. Typed any: the pages look up inputs, selects and canvases by id.
/** @type {(id: string) => any} */
export const $ = (id) => document.getElementById(id);
export const nowS = () => (performance.timeOrigin + performance.now()) / 1000;
export const fmt = (v, d = 2) => (v >= 0 ? "+" : "") + v.toFixed(d);

// "+16.2 ± 0.7 ppm". Both numbers go to the ±'s first significant digit, or to its first two when that digit is
// 1, and never finer than 0.1 ppm.
export function fmtPm(value, sig) {
  let decimals = 1;
  if (sig > 0) {
    const exponent = Math.floor(Math.log10(sig));
    decimals = Math.max(
      0,
      Math.min(1, -exponent + (sig / 10 ** exponent < 2 ? 1 : 0)),
    );
  }
  return `${fmt(value, decimals)} ± ${sig.toFixed(decimals)} ppm`;
}

export function log(msg) {
  const el = $("log");
  el.textContent += `${new Date().toLocaleTimeString([], { hourCycle: "h23" })}  ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

// Sleep in a worker: a hidden tab throttles its own timers to once a minute, a worker's are not.
const worker = new Worker(
  URL.createObjectURL(
    new Blob(
      [
        "onmessage = (e) => setTimeout(() => postMessage(e.data.id), e.data.ms);",
      ],
      {
        type: "text/javascript",
      },
    ),
  ),
);
const sleepers = new Map();
let sleepId = 0;
worker.onmessage = (e) => {
  sleepers.get(e.data)?.();
  sleepers.delete(e.data);
};
export const sleep = (s) =>
  new Promise((r) => {
    const id = ++sleepId;
    sleepers.set(id, r);
    worker.postMessage({ id, ms: Math.max(0, s * 1000) });
  });

export function saveJson(name, data) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }),
  );
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// The Connect step's heading, instructions and button, in the page's <div id="connectcard">. device names what to
// connect ("Chameleon Ultra") and short names it on the button ("CU"). prepare says what to plug in and close first.
// extra adds a sentence of the page's own. cli says the page has a command-line version further down.
/** @param {{ device: string, short: string, prepare: string, extra?: string, cli?: boolean }} card */
export function connectCard({
  device,
  short,
  prepare,
  extra = "",
  cli = false,
}) {
  const note =
    `${prepare} This page needs Chrome or Edge on a computer.` +
    (cli ? " The command-line version is further down." : "") +
    (extra ? ` ${extra}` : "");
  const h2 = document.createElement("h2");
  h2.textContent = `Connect your ${device}`;
  const p = document.createElement("p");
  p.className = "note";
  p.textContent = note;
  const row = document.createElement("div");
  row.className = "row gap-top";
  const button = document.createElement("button");
  Object.assign(button, { id: "connect", className: "primary" });
  button.textContent = `Connect ${short}`;
  const info = document.createElement("span");
  Object.assign(info, { id: "connectinfo", className: "note" });
  row.append(button, info);
  $("connectcard").replaceChildren(h2, p, row);
}

// The page's <footer>: what happens to the device's data, and the site's version.
export function showFooter() {
  const privacy = document.createElement("p");
  privacy.textContent =
    "The page sends your device's data nowhere: it stays in this browser until you press Copy or Download.";
  const version = document.createElement("p");
  $("footer").replaceChildren(privacy, version);
  showSiteCommit(version);
}

// The commit GitHub Pages serves this site from: the head of main, read from the GitHub API. A page served from
// anywhere other than <owner>.github.io/<repo>/ shows nothing.
export async function showSiteCommit(el) {
  const owner = location.hostname.match(/^([\w-]+)\.github\.io$/)?.[1];
  const repo = location.pathname.split("/")[1];
  if (!owner || !repo) return;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/main`,
      {
        headers: { Accept: "application/vnd.github.sha" },
        cache: "no-store",
      },
    );
    const sha = r.ok ? (await r.text()).trim() : "";
    if (!/^[0-9a-f]{40}$/.test(sha)) return;
    el.innerHTML = `Page version: <a href="https://github.com/${owner}/${repo}/commit/${sha}">${sha.slice(0, 7)}</a>`;
  } catch {
    // offline or rate-limited: leave the line empty
  }
}

// Says so on #connectinfo and in the log if the browser has no Web Serial.
export function hasWebSerial() {
  if ("serial" in navigator) return true;
  const msg =
    "This browser can't reach USB devices. Use Chrome or Edge on a computer.";
  if ($("connectinfo")) $("connectinfo").textContent = msg;
  log(msg);
  return false;
}

// Shows a page state. <main id="app"> takes the state, and the page's CSS shows the parts for it. Each item of the
// progress list (.steps li, in order) takes its class from the state's row in rows: "current", "done" or "". An
// item the row leaves out gets "".
export function showState(state, rows) {
  $("app").dataset.state = state;
  const row = rows[state];
  document
    .querySelectorAll(".steps li")
    .forEach((li, i) => (li.className = row[i] ?? ""));
}

export function setDisabled(ids, disabled) {
  for (const id of ids) $(id).disabled = disabled;
}

// Runs a page's steps one at a time. run(what, fn) ignores a click while a step is running, and logs a step that
// fails. onBusy(true) runs before each step and onBusy(false) after it.
/** @param {(busy: boolean) => void} [onBusy] */
export function oneAtATime(onBusy = () => {}) {
  let busy = false;
  return {
    isBusy: () => busy,
    run: async (what, fn) => {
      if (busy) return;
      busy = true;
      onBusy(true);
      try {
        await fn();
      } catch (e) {
        log(`${what} failed: ${e.message}`);
      } finally {
        busy = false;
        onBusy(false);
      }
    },
  };
}

// Tabs: buttons with role="tab" and aria-controls naming their panel. Arrow keys move between them.
export function bindTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')].map(
    (t) => /** @type {HTMLElement} */ (t),
  );
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    }
  };
  tabs.forEach((tab, i) => {
    tab.onclick = () => select(tab);
    tab.onkeydown = (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      const next = tabs[(i + step + tabs.length) % tabs.length];
      select(next);
      next.focus();
    };
  });
  if (tabs.length) select(tabs[0]);
}

// Copy buttons: each copies the text of the element just before it.
export function bindCopyButtons() {
  for (const button of document.querySelectorAll("button.copy")) {
    if (!(button instanceof HTMLButtonElement)) continue;
    button.onclick = async () => {
      try {
        await navigator.clipboard.writeText(
          button.previousElementSibling.textContent,
        );
        button.textContent = "Copied";
      } catch {
        // no clipboard access: select the text so a copy shortcut finishes the job
        getSelection().selectAllChildren(button.previousElementSibling);
        button.textContent = "Selected";
      }
      setTimeout(() => (button.textContent = "Copy"), 1500);
    };
  }
}
