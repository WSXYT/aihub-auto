# Outbound Proxy Settings Design

## Goal

Expose outbound proxy configuration as a first-class control in the router web
settings page. Users who cannot reach AIHub directly must be able to select a
connection mode, enter a proxy URL, test the proposed settings, and save them
without editing `config.json`.

The repository already has the configuration fields, a basic settings form,
and Bun/Tauri proxy wiring. This change completes the page workflow with an
actual connectivity test, clear status feedback, and focused regression
coverage. It does not add another proxy layer or change client-facing `/v1`
authentication.

## User Interface

Keep the controls in **Settings -> Network and updates**, where related update
mirror settings already live. The proxy row contains:

- a mode selector with `Direct`, `System proxy`, and `Custom proxy`;
- a custom proxy URL input with an example such as
  `http://127.0.0.1:7890`;
- a `Test connection` secondary action;
- the existing `Save proxy` primary action;
- a compact inline result for testing, including successful latency or a
  concise failure reason.

The URL input is enabled only in custom mode. Changing either field clears the
previous test result so stale success is never presented as evidence for new
values. Testing is available before saving and uses the current form values.
Saving does not require a successful test, because a temporarily unavailable
proxy must not prevent configuration, but invalid form values are rejected.

The page remains usable on narrow desktop and mobile-width webviews: actions
may wrap to a new line and the result text must not resize or overlap the
controls.

## Configuration Contract

Continue using the existing persisted fields:

```json
{
  "outboundProxyMode": "none | system | custom",
  "outboundProxyUrl": "http://127.0.0.1:7890"
}
```

`none` always performs a direct connection. `system` reads the router
process's inherited environment in this order:

1. `HTTPS_PROXY`
2. `https_proxy`
3. `HTTP_PROXY`
4. `http_proxy`

`custom` requires an absolute `http://` or `https://` proxy URL. The URL is
stored only in the local configuration file, is never written to logs or
error messages, and may contain standard URL user information when the proxy
requires authentication. SOCKS, PAC, and operating-system proxy modification
are outside this change.

The existing authenticated `POST /ctl/config` route remains the save path.
After a successful save, subsequent AIHub account, statistics, key-management,
and model requests use the new setting without a router restart. Requests
already in flight continue with the transport on which they started. The
desktop updater reads the same persisted fields whenever an update check or
installation begins.

## Outbound Transport Boundary

Move the current proxy resolution and Bun fetch construction from `main.ts`
into a small outbound transport module. It owns three operations:

- validate and resolve a proxy from mode, URL, and process environment;
- create a Bun-backed `fetch` function that applies the resolved proxy;
- perform a bounded AIHub connectivity probe using candidate settings.

The main AIHub client and model proxy continue to receive one shared fetch
function. That function resolves the mutable configuration for each new
request, preserving the existing hot-update behavior. The connectivity probe
uses the same resolver and Bun proxy option, so a successful test exercises
the same path as real AIHub traffic.

Keeping transport policy in one module prevents the settings test, account
API, background polling, and model forwarding from interpreting proxy modes
differently.

## Connectivity Test API

Add an authenticated control endpoint:

```text
POST /ctl/outbound-proxy/test
Content-Type: application/json

{
  "outboundProxyMode": "custom",
  "outboundProxyUrl": "http://127.0.0.1:7890"
}
```

The endpoint accepts exactly these two fields, validates them with the same
schema as persisted configuration, and does not modify in-memory or on-disk
configuration. It requests AIHub's existing public providers endpoint through
the candidate transport with an eight-second timeout. Success requires a 2xx
HTTP response and returns:

```json
{
  "ok": true,
  "latencyMs": 128
}
```

The endpoint is protected by the same `uiPassword`, origin, and local-host
checks as every other `/ctl/*` route. Responses use `Cache-Control: no-store`.

## Error Handling

The server maps failures to stable user-facing categories without returning
the proxy URL, credentials, low-level socket details, or an upstream response
body:

- malformed JSON, unknown fields, invalid mode, or invalid URL: HTTP 400;
- system mode with no inherited proxy environment variable: HTTP 400;
- probe timeout: HTTP 504 with `AIHub connection timed out`;
- proxy connection, DNS, or TLS failure: HTTP 502 with
  `Cannot connect to AIHub through this proxy`;
- non-2xx AIHub response: HTTP 502 with the upstream status number only.

The page keeps the entered values after failure, displays the returned message
inline, and allows immediate retesting. A failed test never changes the saved
transport. Saving failures use the existing toast/error path and also leave
the form intact.

## Tests

Unit coverage for the outbound transport module will verify:

- direct mode never applies a proxy, even when proxy environment variables
  exist;
- system mode follows the documented environment precedence;
- custom mode uses the submitted URL;
- hot updates affect the next fetch call;
- proxy URLs or embedded credentials do not appear in sanitized errors;
- probe success, timeout, missing system proxy, and network failure mapping.

Router integration coverage will verify:

- the settings HTML contains the mode, URL, test, result, and save controls;
- `/ctl/status` supplies the saved mode and URL needed to populate the form;
- `/ctl/config` persists valid page values and rejects custom mode without a
  URL;
- `/ctl/outbound-proxy/test` enforces UI authentication and rejects unknown
  fields;
- testing candidate values does not mutate saved configuration;
- an injected successful probe returns a bounded integer latency;
- test responses are non-cacheable.

The existing router suite must continue to prove that AIHub API calls and
model forwarding use the injected upstream fetch function. TypeScript checks
and the desktop Rust tests remain required because both runtime surfaces read
the shared persisted settings.

## Out of Scope

- SOCKS4/SOCKS5 proxy support;
- PAC files or automatic proxy discovery;
- changing the operating system's proxy settings;
- per-AIHub-endpoint or per-model proxy selection;
- proxy failover lists;
- routing Sentry telemetry through this proxy.
