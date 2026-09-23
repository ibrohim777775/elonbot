import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const shellPath = (path: string) => process.platform === "win32"
  ? path.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`) : path;

test("update preparation dispatches dependencies and config access without root and rejects UID 0", { skip: !existsSync(bash) }, async () => {
  const script = await readFile("scripts/update-server.sh", "utf8");
  execFileSync(bash, ["--noprofile", "--norc", "-n", "scripts/update-server.sh"]);
  const identity = script.slice(script.indexOf("SOURCE_USER="), script.indexOf("STAMP="));
  const preparation = script.slice(script.indexOf("printf 'Подготовка версии"), script.indexOf("printf 'Переключение версии"));
  assert.ok(identity.includes("APP_USER=")); assert.ok(preparation.includes("PORT="));
  const dir = await mkdtemp(join(tmpdir(), "elonbot-update-test-"));
  try {
    await mkdir(join(dir, "app"));
    await writeFile(join(dir, "app/main.ts"), ""); await writeFile(join(dir, "package-lock.json"), "{}");
    // Interpret the actual preparation commands, replacing OS operations with recording stubs.
    // No root, package installation, configuration copying or service control occurs in this test.
    const harness = `
set -Eeuo pipefail
SOURCE_DIR=/unused-source
APP_DIR=/unused-app
SERVICE=elonbot
STAGE="$1"
TEST_USER="$2"
TEST_PORT="\${3:-8000}"
TEST_ACTOR=root
export TEST_ACTOR
die() { printf '%s\\n' "$*" >&2; exit 1; }
stat() { printf deploy; }
systemctl() { printf '%s' "$TEST_USER"; }
id() { case "$2" in root|root-alias) printf 0;; deploy) printf 1002;; *) printf 1001;; esac; }
record() { printf '%s:%s\\n' "$1" "$TEST_ACTOR" >&2; }
runuser() ( [[ "$1" == -u && "$3" == -- ]]; export TEST_ACTOR="$2"; shift 3; "$@"; )
git() { [[ "$TEST_ACTOR" == deploy ]]; if [[ "$3" == rev-parse ]]; then printf test-revision; fi; }
node() {
  record node
  [[ "$TEST_ACTOR" == elonbot ]] || return 91
  if [[ "$*" == *dotenv* ]]; then
    if [[ "$TEST_PORT" == multiline ]]; then printf '8000\\nextra'; else printf '%s' "$TEST_PORT"; fi
  fi
}
env() { while [[ "$1" == *=* ]]; do shift; done; "$@"; }
npm() { record npm; [[ "$TEST_ACTOR" == elonbot ]]; }
cp() { record cp; [[ "$TEST_ACTOR" == elonbot ]]; }
chmod() { record chmod; [[ "$TEST_ACTOR" == elonbot ]]; }
chown() { record chown; [[ "$TEST_ACTOR" == root ]]; }
tar() { record tar; [[ "$TEST_ACTOR" == elonbot ]]; cat >/dev/null; }
${identity}
${preparation}
[[ "$PORT" == 8000 ]]
`;
    const args = ["--noprofile", "--norc", "-c", harness, "update-test", shellPath(dir)];
    const options = { encoding: "utf8" as const, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
    const run = execFileSync(bash, [...args, "elonbot"], options);
    assert.match(run, /test-revision/);
    for (const user of ["", "root", "root-alias"]) {
      assert.throws(() => execFileSync(bash, [...args, user], options), (error: any) => {
        assert.equal(error.status, 1);
        assert.match(error.stderr, /Сервис должен работать/);
        assert.doesNotMatch(error.stderr, /node:|npm:|cp:/);
        return true;
      });
    }
    for (const port of ["65536", "multiline", "$(false)", "0"]) {
      assert.throws(() => execFileSync(bash, [...args, "elonbot", port], options), (error: any) => {
        assert.equal(error.status, 1); assert.match(error.stderr, /Некорректный PORT/); return true;
      }, `Must reject port: ${JSON.stringify(port)}`);
    }
    assert.throws(() => execFileSync(bash, [...args, "deploy"], options), (error: any) => {
      assert.equal(error.status, 1); assert.match(error.stderr, /разным пользователям/); return true;
    });
  } finally {
    await unlink(join(dir, "app/main.ts")); await unlink(join(dir, "package-lock.json"));
    await rmdir(join(dir, "app")); await rmdir(dir);
  }
});
