import { validTelemetryPayload } from "../../extension/src/shared/telemetry-contract.js";

const PRODUCTION_EXTENSION_ID = "bbjpknpklcpjcogdockeodhieaghbbeb";
const MAX_BYTES = 4096;

export function createEventsHandler({ env = process.env, fetcher = globalThis.fetch } = {}) {
  return async function events(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Origin");
    const origins = [PRODUCTION_EXTENSION_ID, ...(env.TELEMETRY_DEV_EXTENSION_IDS ?? "").split(",")]
      .filter((id) => /^[a-p]{32}$/.test(id)).map((id) => `chrome-extension://${id}`);
    const origin = req.headers.origin;
    const fail = (status, code) => res.status(status).json({ error: code });
    // Origin limits browser access, but public extension clients cannot authenticate themselves.
    if (!origins.includes(origin)) return fail(403, "ORIGIN_NOT_ALLOWED");
    if (req.url?.includes("?")) return fail(400, "INVALID_EVENT");
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      return fail(405, "METHOD_NOT_ALLOWED");
    }
    if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return fail(415, "UNSUPPORTED_MEDIA_TYPE");
    if (Number(req.headers["content-length"]) > MAX_BYTES) return fail(413, "PAYLOAD_TOO_LARGE");
    let body;
    try {
      if (req.body !== undefined) {
        const raw = typeof req.body === "string" || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
        if (Buffer.byteLength(raw) > MAX_BYTES) return fail(413, "PAYLOAD_TOO_LARGE");
        body = typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : JSON.parse(raw);
      } else {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_BYTES) return fail(413, "PAYLOAD_TOO_LARGE");
          chunks.push(buffer);
        }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
    } catch { return fail(400, "INVALID_EVENT"); }
    if (!validTelemetryPayload(body)) return fail(400, "INVALID_EVENT");
    if (!/^G-[A-Z0-9]+$/.test(env.GA4_MEASUREMENT_ID ?? "") || !env.GA4_API_SECRET) return fail(503, "TELEMETRY_UNCONFIGURED");
    const endpoint = new URL("https://www.google-analytics.com/mp/collect");
    endpoint.searchParams.set("measurement_id", env.GA4_MEASUREMENT_ID);
    endpoint.searchParams.set("api_secret", env.GA4_API_SECRET);
    const eventParams = { ...body.event.params };
    if (eventParams.error_code === null) delete eventParams.error_code;
    try {
      const response = await fetcher(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: body.client_id,
          consent: { ad_user_data: "DENIED", ad_personalization: "DENIED" },
          events: [{ name: body.event.name, params: {
            ...eventParams, session_id: body.session_id, engagement_time_msec: 100
          } }]
        }), signal: AbortSignal.timeout(4000), redirect: "error"
      });
      if (!response.ok) return fail(502, "UPSTREAM_UNAVAILABLE");
      // GA's HTTP success acknowledges receipt, not event validation or report visibility.
      return res.status(204).end();
    } catch { return fail(502, "UPSTREAM_UNAVAILABLE"); }
  };
}

export default createEventsHandler();
