import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const allowedPermissions = new Set(["storage"]);
const instagramHosts = new Set(["https://www.instagram.com/*"]);
const allowedHostPermissions = new Set([...instagramHosts, "https://telemetry.example.invalid/*"]);
const requiredIconSizes = new Set(["16", "32", "48", "128"]);
const earlyAccessCopy = "Free during early access";
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const forbiddenRuntimePatterns = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bsendBeacon\s*\(/,
  /\b(?:api[_-]?key|service[_-]?role|publishable[_-]?key)\b/i,
  /https?:\/\//i
];
const forbiddenScriptClientPatterns = [
  /\b(?:supabase|sentry|datadog|logrocket|amplitude|mixpanel|posthog|firebase)\b/i,
  /\bsegment\s*(?:\.|\()/i,
  /\b(?:from\s+|import\s*\()\s*["']@?segment\b/i
];
const allowedRuntimeUrl = "https://www.instagram.com/";
const storeListingUrl = "https://chromewebstore.google.com/detail/instagram-followers-track/bbjpknpklcpjcogdockeodhieaghbbeb";

function fail(message) {
  throw new Error(`Extension check failed: ${message}`);
}

function readManifest(root) {
  const manifestPath = resolve(root, "manifest.json");

  if (!existsSync(manifestPath)) {
    fail("manifest.json is missing.");
  }

  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`manifest.json is invalid JSON: ${error.message}`);
  }
}

function assertExactAllowed(values, allowed, label) {
  if (
    !Array.isArray(values) ||
    values.length !== allowed.size ||
    values.some((value) => !allowed.has(value))
  ) {
    fail(`${label} must contain exactly: ${[...allowed].join(", ")}.`);
  }
}

function assertEntryPath(root, entryPath, label) {
  if (typeof entryPath !== "string" || !entryPath || entryPath.startsWith("/") || entryPath.includes("..")) {
    fail(`${label} must be a local relative path.`);
  }

  if (!existsSync(resolve(root, entryPath))) {
    fail(`${label} does not exist: ${entryPath}`);
  }
}

function assertIcon(root, iconPath, size) {
  if (!iconPath.toLowerCase().endsWith(".png")) {
    fail(`icons.${size} must reference a PNG file.`);
  }

  const contents = readFileSync(resolve(root, iconPath));
  if (
    contents.length < 24 ||
    !contents.subarray(0, pngSignature.length).equals(pngSignature) ||
    contents.toString("ascii", 12, 16) !== "IHDR"
  ) {
    fail(`icons.${size} must be a valid PNG file.`);
  }

  const width = contents.readUInt32BE(16);
  const height = contents.readUInt32BE(20);
  const expectedSize = Number(size);
  if (width !== expectedSize || height !== expectedSize) {
    fail(`icons.${size} must be ${size}x${size}, received ${width}x${height}.`);
  }
}

function assertEarlyAccessCopy(root, dashboardPath) {
  const dashboardContents = readFileSync(dashboardPath, "utf8");
  const earlyAccessElement = dashboardContents.match(
    /<([a-z][\w-]*)\b(?=[^>]*\bdata-early-access(?:\s|=|>))[^>]*>([^<]*)<\/\1\s*>/i
  );

  if (!earlyAccessElement || earlyAccessElement[2].trim() !== earlyAccessCopy) {
    fail(`the data-early-access element must contain exactly: ${earlyAccessCopy}`);
  }

  const constantsPath = resolve(root, "src/shared/constants.js");
  if (!existsSync(constantsPath)) {
    fail("early-access constants source is missing: src/shared/constants.js");
  }

  const constantsContents = readFileSync(constantsPath, "utf8");
  const constant = constantsContents.match(
    /export\s+const\s+EARLY_ACCESS_COPY\s*=\s*(["'])([^"']*)\1\s*;/
  );
  if (!constant || constant[2] !== earlyAccessCopy) {
    fail(`EARLY_ACCESS_COPY must equal exactly: ${earlyAccessCopy}`);
  }
}

function collectEntryPaths(manifest) {
  const entries = [
    [manifest.options_ui?.page, "options_ui.page"],
    [manifest.background?.service_worker, "background.service_worker"]
  ];

  for (const [index, contentScript] of (manifest.content_scripts ?? []).entries()) {
    for (const [scriptIndex, script] of (contentScript.js ?? []).entries()) {
      entries.push([script, `content_scripts[${index}].js[${scriptIndex}]`]);
    }
    for (const [styleIndex, style] of (contentScript.css ?? []).entries()) {
      entries.push([style, `content_scripts[${index}].css[${styleIndex}]`]);
    }
  }

  for (const [size, icon] of Object.entries(manifest.icons ?? {})) {
    entries.push([icon, `icons.${size}`]);
  }

  return entries;
}

function collectRuntimeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      return collectRuntimeFiles(path);
    }

    return entry.isFile() ? [path] : [];
  });
}

function assertNoForbiddenRuntimeCode(root) {
  const runtimeDirectories = ["dashboard", "src"];

  for (const directory of runtimeDirectories) {
    const path = resolve(root, directory);
    if (!existsSync(path)) {
      fail(`runtime directory is missing: ${directory}`);
    }

    for (const filePath of collectRuntimeFiles(path)) {
      if (!statSync(filePath).isFile()) {
        continue;
      }

      const contents = readFileSync(filePath, "utf8").replaceAll(allowedRuntimeUrl, "");
      let checkedContents = relative(root, filePath) === "src/dashboard/dashboard.js"
        ? contents.replaceAll(`${storeListingUrl}/reviews`, "")
        : contents;
      if (relative(root, filePath) === "dashboard/index.html") {
        checkedContents = checkedContents.replaceAll(`href="${storeListingUrl}"`, "");
      }
      if (relative(root, filePath) === "src/shared/telemetry-contract.js") {
        checkedContents = checkedContents.replaceAll("https://telemetry.example.invalid/api/events", "");
      }
      if (relative(root, filePath) === "dashboard/privacy.html") {
        for (const url of ["https://telemetry.example.invalid/product/", "https://telemetry.example.invalid/",
          "https://extension.example.invalid/privacy", "https://extension.example.invalid",
          "https://policies.google.com/privacy", storeListingUrl]) {
          checkedContents = checkedContents.replaceAll(url, "");
        }
      }
      const patterns = filePath.endsWith(".js")
        ? [...forbiddenRuntimePatterns, ...forbiddenScriptClientPatterns]
        : forbiddenRuntimePatterns;
      const forbiddenPattern = patterns.find((pattern) => pattern.test(checkedContents));

      if (forbiddenPattern) {
        fail(`forbidden remote runtime configuration or client in ${relative(root, filePath)}.`);
      }
    }
  }
}

export function checkRuntime(root = extensionRoot) {
  const manifest = readManifest(root);

  if (manifest.manifest_version !== 3) {
    fail("manifest_version must be 3.");
  }

  if (manifest.minimum_chrome_version !== "121") {
    fail("minimum_chrome_version must be 121 for deterministic tab recency.");
  }

  if (manifest.action?.default_popup || JSON.stringify(manifest).includes("default_popup")) {
    fail("the extension action must not declare a popup.");
  }

  assertExactAllowed(manifest.permissions, allowedPermissions, "permissions");
  assertExactAllowed(manifest.host_permissions, allowedHostPermissions, "host_permissions");

  if (manifest.options_ui?.open_in_tab !== true) {
    fail("options_ui must open the dedicated dashboard in a tab.");
  }

  if (manifest.background?.type !== "module") {
    fail("the service worker must be a module.");
  }

  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length !== 1) {
    fail("exactly one Instagram content-script entry is required.");
  }

  assertExactAllowed(manifest.content_scripts[0].matches, instagramHosts, "content_scripts[0].matches");

  assertExactAllowed(Object.keys(manifest.icons ?? {}), requiredIconSizes, "icon sizes");

  for (const [entryPath, label] of collectEntryPaths(manifest)) {
    assertEntryPath(root, entryPath, label);
  }

  const dashboardPath = resolve(root, manifest.options_ui.page);
  for (const size of requiredIconSizes) {
    assertIcon(root, manifest.icons[size], size);
  }
  assertEarlyAccessCopy(root, dashboardPath);

  const serviceWorkerPath = resolve(root, manifest.background.service_worker);
  const serviceWorkerContents = readFileSync(serviceWorkerPath, "utf8");
  if (!/chrome\.action\.onClicked[\s\S]*chrome\.runtime\.openOptionsPage/.test(serviceWorkerContents)) {
    fail("the extension action must open the dedicated dashboard.");
  }

  assertNoForbiddenRuntimeCode(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkRuntime(process.argv[2] ? resolve(process.argv[2]) : extensionRoot);
  process.stdout.write("Extension runtime checks passed.\n");
}
