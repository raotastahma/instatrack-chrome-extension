import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRuntime } from "../scripts/check.mjs";

const extensionRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function withExtensionCopy(callback) {
  const copyRoot = mkdtempSync(resolve(tmpdir(), "followers-tracker-pro-"));
  cpSync(extensionRoot, copyRoot, {
    filter: (source) => !source.includes(`${extensionRoot}/dist`) && !source.includes(`${extensionRoot}/node_modules`),
    recursive: true
  });

  try {
    callback(copyRoot);
  } finally {
    rmSync(copyRoot, { force: true, recursive: true });
  }
}

function updateManifest(root, update) {
  const manifestPath = resolve(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  update(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("the manifest and dashboard shell satisfy the local relationship data and scoped telemetry foundation", () => {
  assert.doesNotThrow(() => checkRuntime(extensionRoot));
  const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "manifest.json"), "utf8"));
  const packageMetadata = JSON.parse(readFileSync(resolve(extensionRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, "0.1.9");
  assert.equal(packageMetadata.version, manifest.version);
  assert.equal(manifest.incognito, "split");
});

test("the check requires Chrome 121 for deterministic tab recency", () => {
  withExtensionCopy((root) => {
    updateManifest(root, (manifest) => {
      manifest.minimum_chrome_version = "120";
    });

    assert.throws(() => checkRuntime(root), /minimum_chrome_version must be 121/);
  });
});

test("the check rejects an action popup", () => {
  withExtensionCopy((root) => {
    updateManifest(root, (manifest) => {
      manifest.action.default_popup = "popup.html";
    });

    assert.throws(() => checkRuntime(root), /must not declare a popup/);
  });
});

test("the check rejects unapproved permissions and hosts", () => {
  withExtensionCopy((root) => {
    updateManifest(root, (manifest) => {
      manifest.permissions.push("tabs");
    });

    assert.throws(() => checkRuntime(root), /permissions must contain exactly/);
  });

  withExtensionCopy((root) => {
    updateManifest(root, (manifest) => {
      manifest.host_permissions.push("https://example.com/*");
    });

    assert.throws(() => checkRuntime(root), /host_permissions must contain exactly/);
  });

  withExtensionCopy((root) => {
    updateManifest(root, (manifest) => {
      manifest.permissions = [];
    });

    assert.throws(() => checkRuntime(root), /permissions must contain exactly/);
  });
});

test("the check rejects missing entrypoints and early-access copy", () => {
  withExtensionCopy((root) => {
    updateManifest(root, (manifest) => {
      manifest.background.service_worker = "src/background/missing.js";
    });

    assert.throws(() => checkRuntime(root), /does not exist/);
  });

  withExtensionCopy((root) => {
    const dashboardPath = resolve(root, "dashboard/index.html");
    writeFileSync(
      dashboardPath,
      readFileSync(dashboardPath, "utf8").replace("Free during early access", "Free during early access.")
    );

    assert.throws(() => checkRuntime(root), /data-early-access element must contain exactly/);
  });

  withExtensionCopy((root) => {
    const constantsPath = resolve(root, "src/shared/constants.js");
    writeFileSync(
      constantsPath,
      readFileSync(constantsPath, "utf8").replace("Free during early access", "Free during early access.")
    );

    assert.throws(() => checkRuntime(root), /EARLY_ACCESS_COPY must equal exactly/);
  });
});

test("the check rejects missing or incorrectly sized icons", () => {
  withExtensionCopy((root) => {
    updateManifest(root, (manifest) => {
      delete manifest.icons["16"];
    });

    assert.throws(() => checkRuntime(root), /icon sizes must contain exactly/);
  });

  withExtensionCopy((root) => {
    const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
    rmSync(resolve(root, manifest.icons["16"]));

    assert.throws(() => checkRuntime(root), /icons\.16 does not exist/);
  });

  withExtensionCopy((root) => {
    const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
    const iconPath = resolve(root, manifest.icons["16"]);
    const icon = readFileSync(iconPath);
    icon.writeUInt32BE(15, 16);
    writeFileSync(iconPath, icon);

    assert.throws(() => checkRuntime(root), /icons\.16 must be 16x16, received 15x16/);
  });
});

test("the check rejects remote runtime clients or configuration", () => {
  withExtensionCopy((root) => {
    writeFileSync(resolve(root, "src/shared/remote.js"), "fetch('https://example.com');\n");

    assert.throws(() => checkRuntime(root), /forbidden remote runtime configuration or client/);
  });
});

test("the check rejects a service worker that does not open the dashboard", () => {
  withExtensionCopy((root) => {
    writeFileSync(resolve(root, "src/background/service-worker.js"), "chrome.runtime.onInstalled.addListener(() => {});\n");

    assert.throws(() => checkRuntime(root), /must open the dedicated dashboard/);
  });
});
