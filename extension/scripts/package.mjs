import { accessSync, constants, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRuntime } from "./check.mjs";

const extensionRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = resolve(extensionRoot, "dist", "followers-tracker-pro");
const privacySiteRoot = resolve(extensionRoot, "dist", "privacy-site");
const zipExecutable = "/usr/bin/zip";

checkRuntime(extensionRoot);
const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "manifest.json"), "utf8"));
const archivePath = resolve(extensionRoot, "dist", `followers-tracker-pro-${manifest.version}.zip`);

try {
  accessSync(zipExecutable, constants.X_OK);
} catch {
  throw new Error(`Packaging failed: required ZIP executable is unavailable at ${zipExecutable}.`);
}

rmSync(packageRoot, { force: true, recursive: true });
rmSync(archivePath, { force: true });
rmSync(privacySiteRoot, { force: true, recursive: true });
mkdirSync(packageRoot, { recursive: true });
mkdirSync(privacySiteRoot, { recursive: true });

for (const runtimePath of ["manifest.json", "dashboard", "src", "icons"]) {
  cpSync(resolve(extensionRoot, runtimePath), resolve(packageRoot, runtimePath), { recursive: true });
}
cpSync(resolve(extensionRoot, "dashboard", "privacy.html"), resolve(privacySiteRoot, "index.html"));

checkRuntime(packageRoot);

try {
  execFileSync(zipExecutable, ["-q", "-r", archivePath, "."], { cwd: packageRoot });
} catch (error) {
  rmSync(archivePath, { force: true });
  throw new Error(`Packaging failed while creating the Chrome Web Store ZIP: ${error.message}`);
}

manifest.name += " dev";
manifest.action.default_title += " dev";
writeFileSync(resolve(packageRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write(
  `Created loadable package at dist/followers-tracker-pro, Chrome Web Store archive at dist/followers-tracker-pro-${manifest.version}.zip, and privacy site at dist/privacy-site.\n`
);
