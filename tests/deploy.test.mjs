// deploy.sh is the deploy keys' forced command: what it accepts is what GitHub Actions can do on
// the server. Run: node --test
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "scripts/deploy.sh");
const run = (arg) =>
  spawnSync("sh", [script], { env: { ...process.env, SSH_ORIGINAL_COMMAND: arg, DEPLOY_DRY_RUN: "1" }, encoding: "utf8" });

describe("scripts/deploy.sh", () => {
  it("refuses anything but a known target", () => {
    for (const arg of ["", "db", "selfhost", "kosh; id", "kosh$(id)", "../kosh", "kosh search"]) {
      assert.equal(run(arg).status, 2, JSON.stringify(arg));
    }
  });

  it("accepts kosh, search, kosh-db and infra", () => {
    for (const arg of ["kosh", "search", "kosh-db", "infra"]) {
      const r = run(arg);
      assert.equal(r.status, 0, arg);
      assert.match(r.stdout, new RegExp(`^deploy ${arg}$`, "m"));
    }
  });
});
