import { migrateLegacyReport } from "../domain/analytics.js";
import { normalizeUsername } from "../domain/normalization.js";
import { isLastSync, isTimestamp } from "../domain/schema.js";
import { STORAGE_KEYS, STORAGE_KEY_NAMES } from "../shared/constants.js";

const ACCOUNT_PREFIX = "instatrack.account.v1.";
const CONTROL_KEY = "instatrack.control.v1";
const RUN_KEYS = Object.freeze({
  regular: "instatrack.run.v1.regular",
  incognito: "instatrack.run.v1.incognito"
});
const USERNAME_PATTERN = /^[a-z0-9._]+$/;
const RUN_KEY_NAMES = Object.freeze(Object.values(RUN_KEYS));

function requireStorageArea(storageArea) {
  if (!storageArea || typeof storageArea.get !== "function" || typeof storageArea.set !== "function" || typeof storageArea.remove !== "function") {
    throw new TypeError("chrome.storage.local is unavailable.");
  }
  return storageArea;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function accountKey(generation, account) {
  return `${ACCOUNT_PREFIX}${generation}.${account}`;
}

function normalizeAccount(value) {
  const account = normalizeUsername(value);
  if (!USERNAME_PATTERN.test(account)) {
    throw new TypeError("A normalized Instagram account is required.");
  }
  return account;
}

function isNormalizedAccount(value) {
  return typeof value === "string" && USERNAME_PATTERN.test(value);
}

function defaultControl() {
  return { version: 1, generation: 0, resetting: false };
}

function readControl(value) {
  if (value === undefined) {
    return defaultControl();
  }
  if (!hasExactKeys(value, ["version", "generation", "resetting"]) || value.version !== 1 || !Number.isInteger(value.generation) || value.generation < 0 || typeof value.resetting !== "boolean") {
    throw new TypeError("Stored account control state is invalid.");
  }
  return value;
}

function isBundle(value, generation, account) {
  return (
    hasExactKeys(value, ["version", "generation", "instagram_account", "history", "report", "last_sync"]) &&
    value.version === 1 &&
    value.generation === generation &&
    value.instagram_account === account
  );
}

function isStartFailure(value) {
  return isLastSync(value) && value.instagram_account === null && value.state === "failed"
    && value.stage === "preflight" && value.finished_at !== null;
}

function isRun(value, generation, account) {
  return (
    hasExactKeys(value, ["version", "generation", "instagram_account", "last_sync"]) &&
    value.version === 1 &&
    value.generation === generation &&
    (isNormalizedAccount(value.instagram_account) || (value.instagram_account === null && isStartFailure(value.last_sync))) &&
    value.instagram_account === account
  );
}

function hasMatchingRunLastSyncOwner(run) {
  return run?.last_sync === null || (
    isObject(run?.last_sync) &&
    (run.last_sync.instagram_account === null || run.last_sync.instagram_account === run.instagram_account)
  );
}

function isRunningRun(value, generation, account) {
  return isRun(value, generation, account) && hasMatchingRunLastSyncOwner(value) && value.last_sync?.state === "running";
}

function runValue(generation, account, lastSync) {
  return {
    version: 1,
    generation,
    instagram_account: account,
    last_sync: lastSync
  };
}

function ownerFrom(value, owners) {
  if (value === undefined || value === null) {
    return true;
  }
  const account = normalizeUsername(value);
  if (!USERNAME_PATTERN.test(account)) {
    return false;
  }
  owners.add(account);
  return true;
}

function matchingEmbeddedOwners({ history, report, lastSync }, account) {
  const owners = new Set();
  const historyOwners = [
    history?.meta?.instagram_account,
    history?.last_snapshot?.instagram_account,
    ...(Array.isArray(history?.sync_points) ? history.sync_points.map((point) => point?.instagram_account) : [])
  ];
  const values = [...historyOwners, report?.instagram_account, lastSync?.instagram_account];
  return values.every((value) => ownerFrom(value, owners)) && [...owners].every((owner) => owner === account);
}

function legacyMatchesAccount(values, account) {
  return legacyOwner(values) === account;
}

function legacyOwner(values) {
  const owners = new Set();
  const history = values[STORAGE_KEYS.history] ?? null;
  const candidates = [
    history?.meta?.instagram_account,
    history?.last_snapshot?.instagram_account,
    ...(Array.isArray(history?.sync_points) ? history.sync_points.map((point) => point?.instagram_account) : []),
    values[STORAGE_KEYS.report]?.instagram_account,
    values[STORAGE_KEYS.lastSync]?.instagram_account
  ];
  return candidates.every((value) => ownerFrom(value, owners)) && owners.size === 1 ? [...owners][0] : null;
}

function bundleAccountFromKey(key, generation) {
  const prefix = `${ACCOUNT_PREFIX}${generation}.`;
  if (!key.startsWith(prefix)) {
    return null;
  }
  const account = key.slice(prefix.length);
  return isNormalizedAccount(account) ? account : null;
}

function latestSuccessfulAt(history, report) {
  const timestamps = [
    ...(Array.isArray(history?.sync_points) ? history.sync_points.map((point) => point?.taken_at) : []),
    report?.generated_at
  ].filter(isTimestamp);
  return timestamps.reduce((latest, timestamp) => (!latest || timestamp.epoch > latest.epoch ? timestamp : latest), null);
}

function latestDiagnostic(stored, run, successfulAt = null) {
  if (!run) return stored;
  if (run.state === "running") return run;
  if (run.state === "completed") return stored;
  const time = (sync) => sync?.finished_at?.epoch ?? sync?.started_at?.epoch ?? -1;
  const storedTime = Math.max(time(stored), successfulAt?.epoch ?? -1);
  return time(run) >= storedTime ? run : stored;
}

function conflictLastSync(lastSync) {
  return {
    ...lastSync,
    state: "failed",
    finished_at: lastSync.started_at,
    error: {
      code: "COLLECTION_FAILED",
      message: "A sync for this Instagram account is already running in another browser context."
    }
  };
}

function runningAccountError() {
  const error = new Error("A sync for this Instagram account is already running in another browser context.");
  error.code = "COLLECTION_FAILED";
  return error;
}

function interruptedAfterRestart(lastSync, finishedAt) {
  return {
    ...lastSync,
    ...(Object.hasOwn(lastSync, "paused") ? { paused: false } : {}),
    state: "interrupted",
    finished_at: finishedAt,
    duration_ms: Math.max(0, (finishedAt.epoch - lastSync.started_at.epoch) * 1000),
    error: {
      code: "COLLECTION_INTERRUPTED",
      message: "The browser closed before sync finished. Retry sync."
    }
  };
}

function isManagedKey(key) {
  return STORAGE_KEY_NAMES.includes(key) || RUN_KEY_NAMES.includes(key) || key.startsWith(ACCOUNT_PREFIX);
}

function storageChangeSource(storageArea) {
  return [storageArea?.onChanged, globalThis.chrome?.storage?.onChanged]
    .filter((source, index, sources) => source && typeof source.addListener === "function" && sources.indexOf(source) === index);
}

export function createAccountStore(storageArea = globalThis.chrome?.storage?.local, { incognito = false } = {}) {
  const area = requireStorageArea(storageArea);
  const mode = incognito ? "incognito" : "regular";
  const ownRunKey = RUN_KEYS[mode];
  const otherRunKey = RUN_KEYS[incognito ? "regular" : "incognito"];
  const adapters = new Map();

  for (const source of storageChangeSource(area)) {
    source.addListener((changes, areaName) => {
      if ((!areaName || areaName === "local") && Object.hasOwn(changes ?? {}, CONTROL_KEY)) {
        adapters.clear();
      }
    });
  }

  async function generationFor(adapter) {
    const values = await area.get([CONTROL_KEY]);
    const control = readControl(values[CONTROL_KEY]);
    if (control.resetting) {
      throw new Error("Account storage reset is in progress.");
    }
    if (adapter.generation === undefined) {
      adapter.generation = control.generation;
    } else if (adapter.generation !== control.generation) {
      throw new Error("Account storage adapter is stale after reset.");
    }
    return adapter.generation;
  }

  async function assertGeneration(adapter, expectedGeneration) {
    const values = await area.get([CONTROL_KEY]);
    const control = readControl(values[CONTROL_KEY]);
    if (control.resetting) {
      throw new Error("Account storage reset is in progress.");
    }
    if (control.generation !== expectedGeneration || adapter.generation !== expectedGeneration) {
      throw new Error("Account storage adapter is stale after reset.");
    }
  }

  async function readRun() {
    const values = await area.get([CONTROL_KEY, ownRunKey]);
    const control = readControl(values[CONTROL_KEY]);
    if (control.resetting) {
      return { instagram_account: null, lastSync: null };
    }
    const run = values[ownRunKey];
    if (!isObject(run) || !isRun(run, control.generation, run.instagram_account) || !hasMatchingRunLastSyncOwner(run)) {
      return { instagram_account: null, lastSync: null };
    }
    return { instagram_account: run.instagram_account, lastSync: run.last_sync };
  }

  async function writeStartFailure(lastSync) {
    if (!isStartFailure(lastSync)) throw new TypeError("A failed account preflight is required.");
    const values = await area.get([CONTROL_KEY]);
    const control = readControl(values[CONTROL_KEY]);
    if (control.resetting) throw new Error("Account storage reset is in progress.");
    await area.set({ [ownRunKey]: runValue(control.generation, null, lastSync) });
    const afterWrite = await area.get([CONTROL_KEY, ownRunKey]);
    const currentControl = readControl(afterWrite[CONTROL_KEY]);
    if (currentControl.resetting || currentControl.generation !== control.generation) {
      if (afterWrite[ownRunKey]?.last_sync?.run_id === lastSync.run_id) await area.remove([ownRunKey]);
      throw new Error("Account storage reset interrupted sync preparation.");
    }
  }

  async function readLatest() {
    const values = await area.get(null);
    const control = readControl(values[CONTROL_KEY]);
    if (control.resetting) {
      return { instagram_account: null, history: null, report: null, lastSync: null };
    }

    const bundles = [];
    const bundleAccounts = new Set();
    for (const key of Object.keys(values)) {
      const account = bundleAccountFromKey(key, control.generation);
      if (!account) {
        continue;
      }
      bundleAccounts.add(account);
      const bundle = values[key];
      if (!isBundle(bundle, control.generation, account) || !matchingEmbeddedOwners({ history: bundle.history, report: bundle.report, lastSync: bundle.last_sync }, account)) {
        continue;
      }
      const report = migrateLegacyReport(bundle.report, bundle.history);
      const latestAt = latestSuccessfulAt(bundle.history, report);
      if (latestAt) {
        bundles.push({ account, history: bundle.history, report, lastSync: bundle.last_sync, latestAt });
      }
    }

    if (control.generation === 0) {
      const account = legacyOwner(values);
      if (account && !bundleAccounts.has(account)) {
        const history = values[STORAGE_KEYS.history] ?? null;
        const report = migrateLegacyReport(values[STORAGE_KEYS.report] ?? null, history);
        const latestAt = latestSuccessfulAt(history, report);
        if (latestAt) {
          bundles.push({ account, history, report, lastSync: values[STORAGE_KEYS.lastSync] ?? null, latestAt });
        }
      }
    }

    const selected = bundles.sort((left, right) => (
      right.latestAt.epoch - left.latestAt.epoch || left.account.localeCompare(right.account)
    ))[0];
    const run = values[ownRunKey];
    const diagnostic = isRun(run, control.generation, run?.instagram_account) && hasMatchingRunLastSyncOwner(run) ? run.last_sync : null;
    return {
      instagram_account: selected?.account ?? null,
      history: selected?.history ?? null,
      report: selected?.report ?? null,
      lastSync: latestDiagnostic(selected?.lastSync ?? null, diagnostic, selected?.latestAt)
    };
  }

  async function reset() {
    const values = await area.get(null);
    const control = readControl(values[CONTROL_KEY]);
    const nextControl = control.resetting
      ? control
      : { version: 1, generation: control.generation + 1, resetting: true };
    const deletedKeys = Object.keys(values).filter(isManagedKey);
    if (!control.resetting) {
      await area.set({ [CONTROL_KEY]: nextControl });
    }
    try {
      if (deletedKeys.length > 0) {
        await area.remove(deletedKeys);
      }
      const racedValues = await area.get(null);
      const racedKeys = Object.keys(racedValues).filter(isManagedKey);
      if (racedKeys.length > 0) {
        await area.remove(racedKeys);
        deletedKeys.push(...racedKeys.filter((key) => !deletedKeys.includes(key)));
      }
      await area.set({ [CONTROL_KEY]: { ...nextControl, resetting: false } });
    } catch (cause) {
      adapters.clear();
      throw cause;
    }
    adapters.clear();
    return deletedKeys;
  }

  async function interruptRunsAfterRestart(finishedAt) {
    if (!isTimestamp(finishedAt)) {
      throw new TypeError("A finished timestamp is required.");
    }
    const values = await area.get([CONTROL_KEY, ...RUN_KEY_NAMES]);
    const control = readControl(values[CONTROL_KEY]);
    if (control.resetting) {
      throw new Error("Account storage reset is in progress.");
    }
    const interrupted = Object.fromEntries(RUN_KEY_NAMES.flatMap((key) => {
      const run = values[key];
      if (!isObject(run) || !isRunningRun(run, control.generation, run.instagram_account) || !isTimestamp(run.last_sync.started_at)) {
        return [];
      }
      return [[key, runValue(control.generation, run.instagram_account, interruptedAfterRestart(run.last_sync, finishedAt))]];
    }));
    const interruptedKeys = Object.keys(interrupted);
    if (interruptedKeys.length === 0) {
      return [];
    }

    const beforeWrite = await area.get([CONTROL_KEY]);
    const currentControl = readControl(beforeWrite[CONTROL_KEY]);
    if (currentControl.resetting || currentControl.generation !== control.generation) {
      throw new Error(currentControl.resetting ? "Account storage reset is in progress." : "Account storage adapter is stale after reset.");
    }
    await area.set(interrupted);

    const afterWrite = await area.get([CONTROL_KEY, ...interruptedKeys]);
    const finalControl = readControl(afterWrite[CONTROL_KEY]);
    if (!finalControl.resetting && finalControl.generation === control.generation) {
      return interruptedKeys;
    }
    const staleKeys = interruptedKeys.filter((key) => {
      const original = values[key];
      const stored = afterWrite[key];
      return (
        isRun(stored, control.generation, original.instagram_account) &&
        stored.last_sync?.run_id === original.last_sync.run_id &&
        stored.last_sync?.state === "interrupted"
      );
    });
    if (staleKeys.length > 0) {
      await area.remove(staleKeys);
    }
    throw new Error(finalControl.resetting ? "Account storage reset is in progress." : "Account storage adapter is stale after reset.");
  }

  function forAccount(username) {
    const account = normalizeAccount(username);
    const cached = adapters.get(account);
    if (cached) {
      return cached.api;
    }

    const adapter = { account, generation: undefined, api: null };

    async function reconcileWrite(generation, bundleKey, lastSync) {
      const keys = [CONTROL_KEY, ownRunKey];
      if (bundleKey) {
        keys.push(bundleKey);
      }
      const values = await area.get(keys);
      const control = readControl(values[CONTROL_KEY]);
      if (!control.resetting && control.generation === generation && adapter.generation === generation) {
        return;
      }

      const staleKeys = [];
      if (bundleKey && isBundle(values[bundleKey], generation, account)) {
        staleKeys.push(bundleKey);
      }
      const run = values[ownRunKey];
      if (
        isRun(run, generation, account) &&
        (lastSync === null || lastSync === undefined
          ? run.last_sync === lastSync
          : run.last_sync?.run_id === lastSync.run_id)
      ) {
        staleKeys.push(ownRunKey);
      }
      if (staleKeys.length > 0) {
        await area.remove(staleKeys);
      }
      throw new Error(control.resetting ? "Account storage reset is in progress." : "Account storage adapter is stale after reset.");
    }

    async function claim(lastSync) {
      if (
        !isObject(lastSync) ||
        lastSync.state !== "running" ||
        typeof lastSync.run_id !== "string" ||
        !lastSync.run_id ||
        lastSync.instagram_account !== account
      ) {
        throw new TypeError("A running sync for the selected Instagram account is required.");
      }
      const generation = await generationFor(adapter);
      await assertGeneration(adapter, generation);
      await area.set({ [ownRunKey]: runValue(generation, account, lastSync) });

      const values = await area.get([CONTROL_KEY, ownRunKey, otherRunKey]);
      const control = readControl(values[CONTROL_KEY]);
      if (control.resetting || control.generation !== generation || adapter.generation !== generation) {
        await reconcileWrite(generation, null, lastSync);
      }
      const ownRun = values[ownRunKey];
      if (!isRun(ownRun, generation, account) || ownRun.last_sync?.run_id !== lastSync.run_id || ownRun.last_sync?.state !== "running") {
        return false;
      }
      if (!isRunningRun(values[otherRunKey], generation, account)) {
        await reconcileWrite(generation, null, lastSync);
        return true;
      }

      const conflict = conflictLastSync(lastSync);
      await assertGeneration(adapter, generation);
      await area.set({ [ownRunKey]: runValue(generation, account, conflict) });
      await reconcileWrite(generation, null, conflict);
      return false;
    }

    const api = {
      account,

      get storageKeys() {
        return [accountKey(adapter.generation ?? 0, account), ownRunKey];
      },

      async read() {
        const generation = await generationFor(adapter);
        const bundleKey = accountKey(generation, account);
        const values = await area.get([CONTROL_KEY, bundleKey, ownRunKey, ...STORAGE_KEY_NAMES]);
        const control = readControl(values[CONTROL_KEY]);
        if (control.resetting) {
          throw new Error("Account storage reset is in progress.");
        }
        if (control.generation !== generation) {
          throw new Error("Account storage adapter is stale after reset.");
        }

        let history = null;
        let report = null;
        let lastSync = null;
        if (Object.hasOwn(values, bundleKey)) {
          const bundle = values[bundleKey];
          if (!isBundle(bundle, generation, account)) {
            throw new TypeError("Stored account bundle is invalid.");
          }
          if (!matchingEmbeddedOwners({ history: bundle.history, report: bundle.report, lastSync: bundle.last_sync }, account)) {
            throw new TypeError("Stored account bundle is invalid.");
          }
          history = bundle.history;
          report = migrateLegacyReport(bundle.report, history);
          lastSync = bundle.last_sync;
        } else if (generation === 0 && legacyMatchesAccount(values, account)) {
          history = values[STORAGE_KEYS.history] ?? null;
          report = migrateLegacyReport(values[STORAGE_KEYS.report] ?? null, history);
          lastSync = values[STORAGE_KEYS.lastSync] ?? null;
        }

        const run = values[ownRunKey];
        if (isRun(run, generation, account) && hasMatchingRunLastSyncOwner(run)) {
          lastSync = latestDiagnostic(lastSync, run.last_sync, latestSuccessfulAt(history, report));
        }
        return { history, report, lastSync };
      },

      async writeState({ history, report, lastSync }) {
        if (!matchingEmbeddedOwners({ history, report, lastSync }, account)) {
          throw new TypeError("Stored analytics must belong to the selected Instagram account.");
        }
        const generation = await generationFor(adapter);
        await assertGeneration(adapter, generation);
        const bundleKey = accountKey(generation, account);
        await area.set({
          [bundleKey]: {
            version: 1,
            generation,
            instagram_account: account,
            history,
            report: migrateLegacyReport(report, history),
            last_sync: lastSync
          },
          [ownRunKey]: runValue(generation, account, lastSync)
        });
        await reconcileWrite(generation, bundleKey, lastSync);
      },

      async writeLastSync(lastSync) {
        if (!matchingEmbeddedOwners({ history: null, report: null, lastSync }, account)) {
          throw new TypeError("Stored analytics must belong to the selected Instagram account.");
        }
        const generation = await generationFor(adapter);
        await assertGeneration(adapter, generation);
        await area.set({ [ownRunKey]: runValue(generation, account, lastSync) });
        await reconcileWrite(generation, null, lastSync);
      },

      async assertImportAllowed() {
        const generation = await generationFor(adapter);
        const values = await area.get([CONTROL_KEY, ownRunKey, otherRunKey]);
        const control = readControl(values[CONTROL_KEY]);
        if (control.resetting) {
          throw new Error("Account storage reset is in progress.");
        }
        if (control.generation !== generation || adapter.generation !== generation) {
          throw new Error("Account storage adapter is stale after reset.");
        }
        const ownRun = values[ownRunKey];
        if (isRunningRun(ownRun, generation, ownRun?.instagram_account) || isRunningRun(values[otherRunKey], generation, account)) {
          throw runningAccountError();
        }
      },

      async updateHistory(transform, startedAt, runId) {
        await api.assertImportAllowed();
        const generation = await generationFor(adapter);
        const previous = await area.get([ownRunKey]);
        const claimState = {
          run_id: runId, state: "running", stage: "processing", started_at: startedAt, finished_at: null,
          instagram_account: account, followers_count: null, following_count: null, duration_ms: null, error: null
        };
        try {
          if (!await claim(claimState)) throw runningAccountError();
          const next = transform(await api.read());
          await api.writeState(next);
        } catch (cause) {
          // A failed edit must retire its temporary claim without changing the prior diagnostic.
          const current = await area.get([CONTROL_KEY, ownRunKey]);
          const control = readControl(current[CONTROL_KEY]);
          if (!control.resetting && control.generation === generation && current[ownRunKey]?.last_sync?.run_id === runId) {
            if (Object.hasOwn(previous, ownRunKey)) await area.set(previous);
            else await area.remove([ownRunKey]);
          }
          throw cause;
        }
      },

      async claimRun(lastSync) {
        return claim(lastSync);
      },

      reset
    };
    adapter.api = api;
    adapters.set(account, adapter);
    return api;
  }

  return { forAccount, readRun, readLatest, writeStartFailure, reset, interruptRunsAfterRestart };
}
