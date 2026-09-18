import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const preview = process.argv.includes("--preview");
const children = new Set(); let stopping = false;
function run(args, persistent = false) {
  const child = spawn(process.execPath, args, { stdio: "inherit", windowsHide: true }); children.add(child);
  child.on("error", error => { console.error("[dev] Cannot start child process:", error.code); stop(1); });
  child.on("exit", code => { children.delete(child); if (persistent && !stopping) stop(code || 0); });
  return child;
}
let timer;
const checkFrontend = () => {
  clearTimeout(timer);
  timer = setTimeout(() => { for (const file of ["public/app.js", "public/account.js", "public/admin.js", "public/admin-broadcasts.js", "public/help.js"]) run(["--check", file]); }, 150);
};
const watcher = watch("public", (_event, name) => { if (name?.endsWith(".js")) checkFrontend(); });
function stop(code = 0) {
  if (stopping) return; stopping = true; clearTimeout(timer); watcher.close();
  for (const child of children) {
    // Stop the application child as well as tsx's watcher on Windows.
    if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    else child.kill("SIGTERM");
  }
  process.exitCode = code;
  const force = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 7000); force.unref();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop());
console.log(`[dev] ${preview ? "LOCAL PREVIEW: fake Telegram, isolated database" : "Elonbot"}. TypeScript and JavaScript checks are shown below. No build needed.`);
checkFrontend();
run([require.resolve("typescript/bin/tsc"), "--noEmit", "--watch", "--preserveWatchOutput"], true);
run([require.resolve("tsx/cli"), "watch", "--clear-screen=false", "--include", ".env", preview ? "app/tests/preview.ts" : "app/main.ts"], true);
