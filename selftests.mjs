// node selftests.mjs: runs every tool's selftest.mjs from its own folder, where it finds its fixtures. Exits 1 if
// any fails.
import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

const tests = globSync("**/selftest.mjs", {
  exclude: (p) => p.startsWith("node_modules"),
}).sort();
let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, ["selftest.mjs"], {
    cwd: dirname(t),
    encoding: "utf8",
  });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${t}`);
  if (!ok) console.log(r.stdout + r.stderr);
}
process.exit(failed ? 1 : 0);
