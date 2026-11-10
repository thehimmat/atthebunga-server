// Static checks of the gateway's config: what each file must say for the server to work, written
// down as the bugs that taught it. Run: node --test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const count = (s, re) => (s.match(re) ?? []).length;

describe("compose.yml", () => {
  const compose = read("compose.yml");

  it("pins its own project name, so it never collides with kosh's `selfhost` project", () => {
    assert.match(compose, /^name: atthebunga-server$/m);
    assert.match(read("scripts/compose.sh"), /-p atthebunga-server/);
  });

  it("runs both apps from GHCR images", () => {
    assert.match(compose, /image: ghcr\.io\/thehimmat\/gurmukhi-kosh:/);
    assert.match(compose, /image: ghcr\.io\/thehimmat\/gurmukhi-search:/);
  });

  it("points both apps at the gateway's internal listener, not the public URL", () => {
    assert.equal(count(compose, /SUPABASE_URL: http:\/\/gateway:8080/g), 2);
    assert.equal(count(compose, /SUPABASE_ANON_KEY: \$\{ANON_KEY\}/g), 2);
  });

  it("caps each app's memory so Postgres keeps its share of the 24 GB", () => {
    assert.match(compose, /^x-app: &app\n(?: {2}.*\n)* {2}mem_limit: \d+[mg]$/m);
    assert.equal(count(compose, /^ {4}<<: \*app$/gm), 2);
  });

  // deploy.sh updates the files with git, which replaces each one, and then reloads Caddy. A bind
  // mount of a single file keeps showing the replaced file until the container is recreated, so a
  // reload read the old Caddyfile with the new sites (gurmukhi-kosh#391). Folders show what's there now.
  it("mounts Caddy's config as folders, never single files", () => {
    assert.match(compose, /^ {6}- \.\/caddy:\/etc\/caddy:ro$/m);
    assert.match(compose, /^ {6}- \.\/sites:\/etc\/caddy-sites:ro$/m);
    assert.doesNotMatch(compose, /Caddyfile:/);
  });

  it("keeps the Caddy volume from kosh's project, so certificates aren't issued again", () => {
    assert.match(compose, /^ {2}caddy_data:\n(?: {4}#.*\n)* {4}name: selfhost_caddy_data\n {4}external: true$/m);
  });

  it("serves kosh's backups read-only from kosh's folder", () => {
    assert.match(compose, /- \$\{KOSH_BACKUPS:-\/opt\/kosh\/selfhost\/backups\}:\/srv\/backups:ro/);
  });

  it("joins the gateway, and only the gateway, to each neighbour's network", () => {
    assert.match(compose, /^ {2}gateway:\n(?: {4}.*\n)*? {4}networks: \[default, api-edge, radio-edge, pir-edge\]$/m);
    for (const net of ["api-edge", "radio-edge", "pir-edge"]) {
      assert.match(compose, new RegExp(`^ {2}${net}:\\n {4}name: ${net}\\n {4}external: true$`, "m"), net);
      // Only in the header comment, the gateway's list and the networks: block.
      const uses = compose.split("\n").filter((l) => new RegExp(`\\b${net}\\b`).test(l) && !l.startsWith("#"));
      assert.equal(uses.length, 3, net);
    }
  });

  it("never hands the database's own secrets to the gateway or the apps", () => {
    const yaml = compose.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    assert.doesNotMatch(yaml, /POSTGRES_PASSWORD|JWT_SECRET|AUTHENTICATOR_PASSWORD/);
    assert.doesNotMatch(yaml, /env_file:/);
  });
});

describe("scripts/compose.sh", () => {
  const sh = read("scripts/compose.sh");

  it("reads kosh's .env first and this folder's second, so this one wins", () => {
    const kosh = sh.indexOf('--env-file "$kosh_env"');
    const own = sh.indexOf('--env-file "$here/.env"');
    assert.ok(kosh > 0 && own > kosh);
  });

  it("names the compose file, since kosh's .env sets COMPOSE_FILE for its own folder", () => {
    assert.match(sh, /-f "\$here\/compose\.yml"/);
  });
});

describe("caddy/Caddyfile", () => {
  const caddy = read("caddy/Caddyfile");

  it("loads every site from the mounted folder", () => {
    assert.match(caddy, /^import \/etc\/caddy-sites\/\*\.caddy$/m);
  });

  it("defines Cloudflare's origin TLS once (Origin CA cert plus Authenticated Origin Pulls), before the sites load", () => {
    const snippet = /^\(cloudflare_origin\) \{\n([\s\S]*?)^\}$/m.exec(caddy)?.[1] ?? "";
    assert.match(snippet, /tls \/certs\/origin\.pem \/certs\/origin\.key/);
    assert.match(snippet, /mode require_and_verify/);
    assert.match(snippet, /trust_pool file \/certs\/cloudflare-origin-pull-ca\.pem/);
    assert.ok(caddy.indexOf("(cloudflare_origin) {") < caddy.indexOf("import /etc/caddy-sites/"));
  });

  it("uses no deprecated client-auth field (trusted_ca_cert_file, deprecated since Caddy 2.8)", () => {
    for (const f of ["caddy/Caddyfile", "sites/api.caddy", "sites/search.caddy", "sites/stream.caddy", "sites/pir.caddy"]) {
      assert.doesNotMatch(read(f), /trusted_ca_cert_file/, f);
    }
  });
});

describe("sites/api.caddy (kosh's database API)", () => {
  const api = read("sites/api.caddy");

  it("serves the API on its public name and on an internal port for the apps (http, Docker network only)", () => {
    assert.match(api, /^\{\$SITE_ADDRESS\} \{\n\timport api\n\}$/m);
    assert.match(api, /^:8080 \{\n\timport api\n\}$/m);
  });

  it("refuses requests without a current key, like Supabase's gateway", () => {
    for (const key of ["ANON_KEY", "SERVICE_KEY", "AKHAR_KEY"]) {
      assert.ok(api.includes(`{header.apikey} == "{$${key}}"`), key);
      assert.ok(api.includes(`{header.Authorization} == "Bearer {$${key}}"`), key);
    }
    assert.ok(api.includes('respond `{"message":"Invalid API key"}` 401'));
  });

  it("reaches PostgREST by its name on api-edge", () => {
    assert.match(api, /reverse_proxy rest:3000/);
    assert.match(api, /reverse_proxy rest:3001/);
  });

  it("serves only the latest backup, behind its token", () => {
    assert.ok(api.includes("handle /backups/{$BACKUP_TOKEN}/latest.dump.gpg {"));
  });
});

describe("sites/search.caddy", () => {
  it("serves search.atthebunga.com only to Cloudflare", () => {
    const site = read("sites/search.caddy");
    assert.match(site, /^\timport cloudflare_origin$/m);
    assert.match(site, /reverse_proxy search:3000/);
  });
});

describe("sites/stream.caddy", () => {
  it("serves the radio stack to Cloudflare and on a test name, without buffering audio", () => {
    const site = read("sites/stream.caddy");
    assert.match(site, /^stream\.atthebunga\.com \{\n\timport cloudflare_origin$/m);
    assert.match(site, /^radio\.\{\$SITE_ADDRESS\} \{/m);
    assert.match(site, /reverse_proxy radio:3001/);
    assert.match(site, /flush_interval -1/);
  });
});

describe("sites/pir.caddy", () => {
  it("serves the PIR poller on its own name, WebSocket included", () => {
    const site = read("sites/pir.caddy");
    assert.match(site, /^pir\.\{\$SITE_ADDRESS\} \{/m);
    assert.match(site, /reverse_proxy pir-poller:8080/);
    // Not a Cloudflare-only name: nothing proxies it, so it needs no origin certificate.
    assert.doesNotMatch(site, /import cloudflare_origin/);
  });
});
