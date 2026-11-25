// The daily firmware page (index.html): what the current build adds to upstream, and flashing it. The build's
// publish step (publish-daily.py, next to build-daily.sh in rfid-research) writes firmware/daily.json and the DFU.

import { bindFlashButtons, buildText } from "../common/flash-ui.js";
import { addLinkChoice, CU_NEEDS, CU_PREPARE } from "../common/session.js";
import { $, log, showFooter, utcTime } from "../../common/page.js";

// USB or Bluetooth, with the same words as the Connect step on the other CU pages. The browser asks for the CU when
// the flash starts.
$("flashprep").textContent =
  `${CU_PREPARE} The browser asks you to pick the CU when you flash.`;
$("flashneeds").textContent = CU_NEEDS;
addLinkChoice($("linkat"));

const STOCK = {
  zip: "../common/firmware/stock-v2.3.0-ultra-dfu-app.zip",
  name: "stock v2.3.0",
};

// What a change's badge says, by the state publish-daily.py gives it.
const STATE = {
  open: ["badge", "open PR"],
  merged: ["badge upstreamed", "merged upstream"],
  closed: ["badge", "closed PR"],
  "not upstreamed yet": ["badge", "not upstreamed yet"],
  "personal preference": ["badge", "personal preference"],
};

// daily.json's version string and the build commit's time in UTC (committed), as buildText() takes them. If
// daily.json has no committed time, buildText() gives the version alone.
const build = (d) => ({ version: d.version, time: d.committed });

function showChanges(d) {
  const committed = d.committed ? ` (${utcTime(d.committed)})` : "";
  $("build").textContent =
    `Version ${d.version}${committed}, published ${utcTime(d.published)}. Upstream main ${d.upstream.commit}, plus:`;
  for (const c of d.changes) {
    const li = document.createElement("li");
    if (c.url) {
      const a = document.createElement("a");
      a.href = c.url;
      a.textContent = `#${c.pr}`;
      li.append(a, " ");
    }
    li.append(c.title);
    const [cls, text] = STATE[c.state] ?? ["badge", c.state];
    const badge = document.createElement("span");
    badge.className = cls;
    badge.textContent = text;
    li.append(badge);
    $("changes").append(li);
  }
  const upstream = document.createElement("a");
  upstream.href = d.upstream.url;
  upstream.textContent = `upstream ${d.upstream.commit}`;
  const source = document.createElement("a");
  source.href = d.source.url;
  source.textContent = `the fork's daily branch (${d.source.commit})`;
  $("source").append("Source: ", source, ", built on ", upstream, ".");
}

showFooter();
try {
  const r = await fetch("firmware/daily.json", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  showChanges(d);
  bindFlashButtons({
    firmware: {
      test: {
        zip: `firmware/${d.zip}`,
        name: `daily firmware ${d.version}`,
        label: `Flash the daily firmware (${buildText(build(d))})`,
      },
      stock: STOCK,
    },
    port: () => null,
    release: async () => {},
    done: (f) => log(`flashed ${f.name}`),
  });
  $("flashTest").classList.add("primary"); // flashing is what this page is for
} catch (e) {
  $("build").textContent =
    `Couldn't load the build's details (${e.message}). Reload the page to try again.`;
  log(`couldn't load firmware/daily.json: ${e.message}`);
}
