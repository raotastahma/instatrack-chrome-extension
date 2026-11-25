import { migrateLegacyReport } from "../domain/analytics.js";
import { STORAGE_KEYS, STORAGE_KEY_NAMES } from "../shared/constants.js";

function requireStorageArea(storageArea) {
  if (!storageArea || typeof storageArea.get !== "function" || typeof storageArea.set !== "function" || typeof storageArea.remove !== "function") {
    throw new TypeError("chrome.storage.local is unavailable.");
  }
  return storageArea;
}

export function createStorageAdapter(storageArea = globalThis.chrome?.storage?.local) {
  const area = requireStorageArea(storageArea);

  return {
    async read() {
      const values = await area.get(STORAGE_KEY_NAMES);
      const history = values[STORAGE_KEYS.history] ?? null;
      return {
        history,
        report: migrateLegacyReport(values[STORAGE_KEYS.report] ?? null, history),
        lastSync: values[STORAGE_KEYS.lastSync] ?? null
      };
    },

    async writeState({ history, report, lastSync }) {
      await area.set({
        [STORAGE_KEYS.history]: history,
        [STORAGE_KEYS.report]: migrateLegacyReport(report, history),
        [STORAGE_KEYS.lastSync]: lastSync
      });
    },

    async writeLastSync(lastSync) {
      await area.set({ [STORAGE_KEYS.lastSync]: lastSync });
    },

    async reset() {
      await area.remove(STORAGE_KEY_NAMES);
    }
  };
}
