import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRuntime } from "../scripts/check.mjs";

const extensionRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const unzipExecutable = "/usr/bin/unzip";
const runtimePaths = ["manifest.json", "dashboard", "src", "icons"];

function collectFiles(root, path = root) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(root, entryPath);
    }
    return entry.isFile() ? [relative(root, entryPath)] : [];
  });
}

function expectedRuntimeFiles(root) {
  return runtimePaths.flatMap((runtimePath) => {
    const path = resolve(root, runtimePath);
    return runtimePath === "manifest.json" ? [runtimePath] : collectFiles(root, path);
  });
}

test("package labels only the unpacked artifact as dev", () => {
  assert.equal(existsSync(unzipExecutable), true, `required archive inspector is missing: ${unzipExecutable}`);

  const copyRoot = mkdtempSync(resolve(tmpdir(), "followers-tracker-package-source-"));
  const extractRoot = mkdtempSync(resolve(tmpdir(), "followers-tracker-package-extract-"));
  cpSync(extensionRoot, copyRoot, {
    filter: (source) => !source.includes(`${extensionRoot}/dist`) && !source.includes(`${extensionRoot}/node_modules`),
    recursive: true
  });

  try {
    const siblingArtifact = resolve(copyRoot, "dist", "user-owned.txt");
    mkdirSync(resolve(copyRoot, "dist"), { recursive: true });
    writeFileSync(siblingArtifact, "preserve me\n");

    execFileSync(process.execPath, ["scripts/package.mjs"], { cwd: copyRoot });

    const manifest = JSON.parse(readFileSync(resolve(copyRoot, "manifest.json"), "utf8"));
    const packageRoot = resolve(copyRoot, "dist", "followers-tracker-pro");
    const privacySiteRoot = resolve(copyRoot, "dist", "privacy-site");
    const archivePath = resolve(copyRoot, "dist", `followers-tracker-pro-${manifest.version}.zip`);
    const expectedFiles = expectedRuntimeFiles(copyRoot).sort();

    assert.equal(readFileSync(siblingArtifact, "utf8"), "preserve me\n");
    assert.deepEqual(collectFiles(privacySiteRoot), ["index.html"]);
    assert.deepEqual(
      readFileSync(resolve(privacySiteRoot, "index.html")),
      readFileSync(resolve(copyRoot, "dashboard", "privacy.html"))
    );
    assert.equal(existsSync(archivePath), true);
    assert.deepEqual(collectFiles(packageRoot).sort(), expectedFiles);
    assert.doesNotThrow(() => checkRuntime(packageRoot));

    const archiveEntries = execFileSync(unzipExecutable, ["-Z1", archivePath], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((entry) => entry && !entry.endsWith("/"))
      .sort();
    assert.deepEqual(archiveEntries, expectedFiles);
    assert.equal(archiveEntries.includes("manifest.json"), true);
    assert.equal(archiveEntries.some((entry) => entry.startsWith("privacy-site/")), false);
    assert.equal(archiveEntries.some((entry) => /^(?:test|scripts|docs)\//.test(entry)), false);
    assert.equal(archiveEntries.includes("package.json"), false);

    execFileSync(unzipExecutable, ["-q", archivePath, "-d", extractRoot]);
    assert.doesNotThrow(() => checkRuntime(extractRoot));
    assert.deepEqual(collectFiles(extractRoot).sort(), expectedFiles);

    const devManifest = structuredClone(manifest);
    devManifest.name += " dev";
    devManifest.action.default_title += " dev";
    assert.deepEqual(JSON.parse(readFileSync(resolve(packageRoot, "manifest.json"), "utf8")), devManifest);

    for (const file of expectedFiles) {
      if (file !== "manifest.json") {
        assert.deepEqual(readFileSync(resolve(packageRoot, file)), readFileSync(resolve(copyRoot, file)));
      }
      assert.deepEqual(readFileSync(resolve(extractRoot, file)), readFileSync(resolve(copyRoot, file)));
    }
  } finally {
    rmSync(copyRoot, { force: true, recursive: true });
    rmSync(extractRoot, { force: true, recursive: true });
  }
});
