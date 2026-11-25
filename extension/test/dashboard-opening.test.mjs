import assert from "node:assert/strict";
import test from "node:test";

for (const incognito of [false, true]) {
  test(`the action opens and reuses the dashboard in its ${incognito ? "incognito" : "regular"} window`, async () => {
    const windowId = incognito ? 42 : 21;
    const url = "chrome-extension://test-extension/dashboard/index.html";
    const created = [];
    const activated = [];
    let contexts = [];
    let onClicked;
    const previousChrome = globalThis.chrome;
    globalThis.chrome = {
      action: { onClicked: { addListener(listener) { onClicked = listener; } } },
      runtime: {
        onMessage: { addListener() {} },
        getURL: (path) => `chrome-extension://test-extension/${path}`,
        openOptionsPage() { assert.fail("the action must preserve the source window"); },
        async getContexts(filter) {
          assert.deepEqual(filter, { contextTypes: ["TAB"], windowIds: [windowId] });
          return contexts.filter((context) => context.windowId === windowId);
        }
      },
      storage: { local: { get() {}, set() {}, remove() {} } },
      tabs: {
        async create(properties) { created.push(properties); },
        async update(tabId, properties) { activated.push({ tabId, ...properties }); }
      }
    };

    try {
      await import(`../src/background/service-worker.js?dashboard-opening=${incognito}`);
      contexts = [{ tabId: 7, windowId: windowId + 1, documentUrl: url }];
      await onClicked({ id: 1, windowId, incognito });
      assert.deepEqual(created, [{ url, windowId, active: true }]);
      assert.deepEqual(activated, []);

      contexts.push({ tabId: 8, windowId, documentUrl: `${url}#reports` });
      await onClicked({ id: 1, windowId, incognito });
      assert.equal(created.length, 1, "reopening must reuse the dashboard in the same window");
      assert.deepEqual(activated, [{ tabId: 8, active: true }]);
    } finally {
      if (previousChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = previousChrome;
    }
  });
}
