/**
 * Package `dist/` for distribution or App Inspect.
 *
 * `dist/` is not directly submittable, and that is by design rather than an oversight: it is the
 * directory Splunk mounts and runs in development, so it accumulates things a submission must not
 * contain. Each of these is a hard App Inspect failure, and each looks like an app defect when you
 * hit it:
 *
 *   metadata/local.meta   written by Splunk when anyone changes a permission through the UI.
 *                         `cleanDistPath.keep` deliberately preserves it across builds so local
 *                         overrides survive. `check_that_local_meta_does_not_exist` fails on it.
 *   local/                same story for any conf edited through Splunk's UI.
 *   __pycache__/, *.pyc   written by the Python interpreter when Splunk RUNS the app. The build
 *                         sweeps compiled Python out of its own output, but it cannot sweep what
 *                         appears afterwards. `check_for_compiled_python` fails on it.
 *
 * So this copies `dist/` to a staging directory, drops those, and tars the result with the app id
 * as the single top-level directory - which is the layout Splunk and App Inspect both expect.
 *
 *   pnpm package                  ->  dist-package/<appId>.tar.gz
 *   pnpm package --out <dir>      ->  somewhere else
 */

import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import packageJson from "../package.json" with { type: "json" };

const appId = packageJson.splunkApp?.appId;
if (!appId) throw new Error("Missing splunkApp.appId in package.json");

const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
const outDir = path.resolve(outIndex >= 0 ? argv[outIndex + 1] : "dist-package");
const distDir = path.resolve("dist");

if (!existsSync(distDir)) {
  throw new Error(`No dist/ directory - run "pnpm build" first.`);
}

/** Paths that must not ship, relative to the app root. */
const EXCLUDE_EXACT = new Set(["metadata/local.meta"]);
const EXCLUDE_DIRS = new Set(["local", "__pycache__"]);
const EXCLUDE_SUFFIX = [".pyc", ".pyo"];

const removed = [];

async function prune(dir, relative = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) {
        await rm(full, { recursive: true, force: true });
        removed.push(`${rel}/`);
        continue;
      }
      await prune(full, rel);
      continue;
    }

    if (EXCLUDE_EXACT.has(rel) || EXCLUDE_SUFFIX.some((s) => entry.name.endsWith(s))) {
      await rm(full, { force: true });
      removed.push(rel);
    }
  }
}

const staging = await mkdtemp(path.join(tmpdir(), "splunk-package-"));
const appRoot = path.join(staging, appId);

try {
  await cp(distDir, appRoot, { recursive: true });
  await prune(appRoot);
  await mkdir(outDir, { recursive: true });

  const archive = path.join(outDir, `${appId}.tar.gz`);

  // System tar rather than a bundled implementation: it is present everywhere this build already
  // runs, and it gets file modes and symlinks right without any extra dependency.
  await new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", archive, "-C", staging, appId], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`))
    );
  });

  const { size } = await stat(archive);
  console.log(`\nPackaged ${appId} -> ${path.relative(process.cwd(), archive)} (${(size / 1e6).toFixed(1)} MB)`);
  if (removed.length) {
    console.log(`Excluded ${removed.length} development-only path(s):`);
    for (const item of removed.slice(0, 10)) console.log(`  ${item}`);
    if (removed.length > 10) console.log(`  ... and ${removed.length - 10} more`);
  }
  console.log(`\nValidate with:\n  splunk-appinspect inspect ${path.relative(process.cwd(), archive)} --included-tags cloud`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
