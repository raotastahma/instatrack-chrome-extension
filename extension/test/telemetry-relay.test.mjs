import assert from "node:assert/strict";
import test from "node:test";
import { createEventsHandler } from "../../site/api/events.mjs";

const origin = "chrome-extension://bbjpknpklcpjcogdockeodhieaghbbeb";
const payload = () => ({ schema_version: 1, client_id: "1234567890.1792000000", session_id: 1792000000,
  event: { name: "sync_status", params: { status: "failed", error_code: "NOT_LOGGED_IN" } } });
async function send({ body = payload(), headers = {}, method = "POST", env = {}, fetcher = async () => ({ ok: true }) } = {}) {
  const result = { headers: {} };
  const res = { setHeader(key, value) { result.headers[key] = value; }, status(status) { result.status = status; return this; },
    json(body) { result.body = body; }, end() {} };
  await createEventsHandler({ env: { GA4_MEASUREMENT_ID: "G-TEST", GA4_API_SECRET: "server-only-secret", ...env }, fetcher })(
    { method, headers: { origin, "content-type": "application/json", ...headers }, body }, res);
  return result;
}

test("relay forwards only a strict event with server credentials, session and denied advertising consent", async () => {
  const sent = [];
  const result = await send({ fetcher: async (url, request) => { sent.push({ url: String(url), body: JSON.parse(request.body), headers: request.headers }); return { ok: true }; } });
  assert.equal(result.status, 204);
  assert.equal(sent.length, 1);
  assert.equal(new URL(sent[0].url).searchParams.get("api_secret"), "server-only-secret");
  assert.deepEqual(sent[0].body.events, [{ name: "sync_status", params: { status: "failed", error_code: "NOT_LOGGED_IN", session_id: 1792000000, engagement_time_msec: 100 } }]);
  assert.deepEqual(sent[0].body.consent, { ad_user_data: "DENIED", ad_personalization: "DENIED" });
  assert.equal(JSON.stringify(result).includes("server-only-secret"), false);
});

test("relay rejects unapproved origin, oversized content, malformed JSON and private fields before forwarding", async () => {
  const noSend = async () => assert.fail("invalid data must never reach GA");
  const cases = [
    { headers: { origin: "https://example.com" }, status: 403 },
    { headers: { origin: undefined }, status: 403 },
    { body: "{" , status: 400 },
    { body: "x".repeat(4097), status: 413 },
    { body: { ...payload(), username: "private" }, status: 400 },
    { body: { ...payload(), event: { name: "sync_status", params: { status: "failed", error_code: "NOT_LOGGED_IN", message: "private" } } }, status: 400 },
    { body: { ...payload(), event: { name: "first_visit", params: {} } }, status: 400 },
    { headers: { "content-type": "text/plain" }, status: 415 },
    { method: "GET", status: 405 }
  ];
  for (const entry of cases) assert.equal((await send({ ...entry, fetcher: noSend })).status, entry.status);
});

test("relay handles CORS, missing configuration and upstream failures without leaking details", async () => {
  assert.equal((await send({ method: "OPTIONS" })).status, 204);
  assert.equal((await send({ env: { GA4_API_SECRET: "" } })).status, 503);
  const failure = await send({ fetcher: async () => { throw new Error("secret internal stack"); } });
  assert.equal(failure.status, 502);
  assert.equal(JSON.stringify(failure).includes("secret internal stack"), false);
  assert.equal((await send({ fetcher: async () => ({ ok: false }) })).status, 502);
});

test("successful stages omit nullable error_code because GA4 does not accept null parameter values", async () => {
  let event;
  const body = payload();
  body.event.params = { status: "completed", error_code: null };
  const result = await send({ body, fetcher: async (_url, request) => {
    event = JSON.parse(request.body).events[0];
    return { ok: true };
  } });
  assert.equal(result.status, 204);
  assert.equal(event.params.status, "completed");
  assert.equal(Object.hasOwn(event.params, "error_code"), false);
});
