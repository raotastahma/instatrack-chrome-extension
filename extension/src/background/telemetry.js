import {
  TELEMETRY_ENDPOINT, TELEMETRY_KEY, TELEMETRY_STATUSES, TERMINAL_STATUSES,
  validTelemetryEvent, validTelemetryPayload, exactKeys
} from "../shared/telemetry-contract.js";

const emptyState = () => ({ version: 1, consent: "unknown", client_id: null, session: null, first_dashboard_open: false, run: null });

export function createTelemetry({ storage, incognito = false, fetcher = globalThis.fetch,
  now = Date.now, createClientId = () => Array.from(crypto.getRandomValues(new Uint32Array(2))).join(".") }) {
  let serial = Promise.resolve();
  let consentGeneration = 0;
  let blocked = false;
  const requests = new Set();

  function enqueue(work) {
    const result = serial.then(work).catch(() => false);
    serial = result;
    return result;
  }

  async function read() {
    if (incognito) return { ...emptyState(), consent: "denied" };
    const value = (await storage.get([TELEMETRY_KEY]))?.[TELEMETRY_KEY];
    if (!exactKeys(value, ["version", "consent", "client_id", "session", "first_dashboard_open", "run"])
      || value.version !== 1 || typeof value.first_dashboard_open !== "boolean") return emptyState();
    if (["unknown", "denied"].includes(value.consent)) return value.client_id === null && value.session === null
      && value.run === null && !value.first_dashboard_open ? value : emptyState();
    if (value.consent !== "granted" || !validTelemetryPayload({ schema_version: 1,
      client_id: value.client_id, session_id: 1, event: { name: "sync_click", params: {} } })) return emptyState();
    if (value.session !== null && (!exactKeys(value.session, ["id", "last_event_at"])
      || !Number.isSafeInteger(value.session.id) || value.session.id <= 0
      || !Number.isSafeInteger(value.session.last_event_at) || value.session.last_event_at < 0)) return emptyState();
    if (value.run !== null && (!exactKeys(value.run, ["run_id", "statuses", "terminal"])
      || typeof value.run.run_id !== "string" || !value.run.run_id || !Array.isArray(value.run.statuses)
      || new Set(value.run.statuses).size !== value.run.statuses.length
      || !value.run.statuses.every((status) => TELEMETRY_STATUSES.includes(status))
      || (value.run.terminal !== null && !TERMINAL_STATUSES.includes(value.run.terminal)))) return emptyState();
    return value;
  }

  async function getState() {
    const value = await read();
    return { consent: blocked ? "denied" : value.consent, enabled: !incognito && !blocked && value.consent === "granted", incognito };
  }

  function deliver(body, generation) {
    if (generation !== consentGeneration || incognito || blocked) return;
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      Promise.resolve(fetcher(TELEMETRY_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
        signal: controller.signal
      })).catch(() => {}).finally(() => {
        clearTimeout(timer);
        requests.delete(controller);
      });
    } catch {
      clearTimeout(timer);
      requests.delete(controller);
    }
  }

  async function claim(value, event, generation) {
    if (generation !== consentGeneration || blocked || value.consent !== "granted" || !value.client_id) return false;
    const timestamp = now();
    if (!value.session || timestamp < value.session.last_event_at || timestamp - value.session.last_event_at >= 30 * 60 * 1000) {
      value.session = { id: Math.max(1, Math.floor(timestamp / 1000)), last_event_at: timestamp };
    } else value.session.last_event_at = timestamp;
    await storage.set({ [TELEMETRY_KEY]: value });
    if (generation !== consentGeneration) return false;
    deliver({ schema_version: 1, client_id: value.client_id, session_id: value.session.id, event }, generation);
    return true;
  }

  function setConsent(enabled) {
    consentGeneration += 1;
    if (!enabled) blocked = true;
    const generation = consentGeneration;
    for (const request of requests) request.abort();
    return enqueue(async () => {
      if (incognito) return getState();
      const previous = await read();
      const reuse = !blocked && previous.consent === "granted";
      const value = enabled ? {
        ...emptyState(), consent: "granted",
        client_id: reuse ? previous.client_id : createClientId(),
        session: reuse ? previous.session : null,
        first_dashboard_open: reuse ? previous.first_dashboard_open : false,
        run: reuse ? previous.run : null
      } : { ...emptyState(), consent: "denied" };
      if (generation !== consentGeneration) return false;
      await storage.set({ [TELEMETRY_KEY]: value });
      if (generation !== consentGeneration) return false;
      if (enabled) blocked = false;
      return getState();
    });
  }

  function record(event) {
    if (incognito || !validTelemetryEvent(event, { dashboard: true })) return Promise.resolve(false);
    const generation = consentGeneration;
    return enqueue(async () => {
      const value = await read();
      if (event.name === "dashboard_open" && value.consent === "granted" && !value.first_dashboard_open) {
        value.first_dashboard_open = true;
        await claim(value, { name: "dashboard_first_open", params: {} }, generation);
      }
      return claim(value, event, generation);
    });
  }

  function prepareRun(runId, eligible) {
    const generation = consentGeneration;
    return enqueue(async () => {
      if (incognito || !eligible || typeof runId !== "string") return false;
      const value = await read();
      if (value.consent !== "granted" || eligible !== value.client_id || generation !== consentGeneration) return false;
      if (value.run?.run_id === runId) return true;
      value.run = { run_id: runId, statuses: ["preflight"], terminal: null };
      return claim(value, { name: "sync_status", params: { status: "preflight", error_code: null } }, generation);
    });
  }

  function observe(lastSync) {
    const generation = consentGeneration;
    return enqueue(async () => {
      if (incognito) return false;
      const value = await read();
      const run = value.run;
      if (value.consent !== "granted" || !run || run.run_id !== lastSync?.run_id || run.terminal) return false;
      const statuses = TERMINAL_STATUSES.includes(lastSync.state) ? [lastSync.state] : [lastSync.stage];
      if (lastSync.state === "running") {
        if (lastSync.paused) statuses.push("paused");
        else if (run.statuses.includes("paused")) statuses.push("resumed");
      }
      let emitted = false;
      for (const status of statuses) {
        if (!TELEMETRY_STATUSES.includes(status) || run.statuses.includes(status)) continue;
        const event = { name: "sync_status", params: {
          status, error_code: ["failed", "interrupted"].includes(status) ? lastSync.error?.code : null
        } };
        if (!validTelemetryEvent(event)) continue;
        run.statuses.push(status);
        if (TERMINAL_STATUSES.includes(status)) run.terminal = status;
        emitted = await claim(value, event, generation) || emitted;
      }
      return emitted;
    });
  }

  return { getState, setConsent, record, prepareRun, observe,
    eligibility: async () => { const value = await read(); return !incognito && !blocked && value.consent === "granted" ? value.client_id : null; },
    flush: () => serial };
}
