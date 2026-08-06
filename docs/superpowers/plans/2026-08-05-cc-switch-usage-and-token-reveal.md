# CC Switch Usage and Token Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the AIHub account balance at authenticated `GET /v1/usage`, let CC Switch display it, and let an authenticated console user reveal `proxyToken` for ten seconds.

**Architecture:** Route `/v1/usage` locally before the generic OpenAI proxy and reuse the proxy's Bearer/x-api-key authentication rule. Keep `proxyToken` out of status and HTML, exposing it only through the existing `/ctl` password boundary; the UI fetches it on demand, renders it briefly, and removes it on timeout or page hiding. Build version `0.4.5`, preserve the live configuration, and replace only the deployed binary after creating a rollback copy.

**Tech Stack:** Bun, TypeScript, Bun test, single-file HTML/CSS/JavaScript UI, PowerShell, SSH, Linux systemd.

## Global Constraints

- Provider Base URL remains exactly `http://111.228.17.120:10001/v1`.
- CC Switch must request `{{baseUrl}}/usage`; `{{baseUrl}}/v1/usage` would produce the invalid path `/v1/v1/usage`.
- `/v1/usage` and `/v1/responses` use the same existing `proxyToken`; do not add another client secret.
- Keep `GET /v1` unauthenticated and keep all other proxy behavior unchanged.
- Keep `/ctl/*` protected by the existing `uiPassword` and never include `proxyToken` in HTML, `/ctl/status`, logs, URLs, local storage, or session storage.
- Reveal `proxyToken` for at most 10 seconds and clear it immediately when hidden manually, when the document becomes hidden, or when UI authentication is rejected.
- Preserve remote `/var/lib/aihub-auto/config.json`, credentials, state, service user, systemd hardening, port `10001`, `proxyToken`, and `uiPassword`.

---

### Task 1: Add the Authenticated Usage Endpoint

**Files:**
- Modify: `apps/router/src/proxy.ts`
- Modify: `apps/router/src/server.ts`
- Test: `apps/router/tests/integration.test.ts`

**Interfaces:**
- Produces: `proxyTokenAuthorized(req: Request, proxyToken?: string): boolean` in `proxy.ts`.
- Produces: local `GET /v1/usage` response `{ is_active: true, remaining: number, balance: number, unit: "USD" }`.
- Consumes: `ServerDeps.credentials`, `ServerDeps.client.me()`, and existing `accountBalance()` normalization.

- [ ] **Step 1: Write failing integration tests for usage authentication and data**

Add a focused `describe("CC Switch usage endpoint", ...)` block that creates a server with `proxyToken: "proxy-token-123456"` and verifies:

```ts
test("requires the proxy token and returns CC Switch balance fields", async () => {
  h = createHarness({
    withServer: true,
    configPatch: { proxyToken: "proxy-token-123456" },
  });
  const base = h.serverUrl!;

  const missing = await fetch(`${base}/v1/usage`);
  expect(missing.status).toBe(401);
  expect(await missing.json()).toMatchObject({ error: "代理口令错误" });

  const bearer = await fetch(`${base}/v1/usage`, {
    headers: { Authorization: "Bearer proxy-token-123456" },
  });
  expect(bearer.status).toBe(200);
  expect(bearer.headers.get("cache-control")).toBe("no-store");
  expect(await bearer.json()).toEqual({
    is_active: true,
    remaining: 12.34,
    balance: 12.34,
    unit: "USD",
  });

  const apiKey = await fetch(`${base}/v1/usage`, {
    headers: { "x-api-key": "proxy-token-123456" },
  });
  expect(apiKey.status).toBe(200);
  expect(h.mock.requestLog.filter((entry) => entry.path === "/v1/usage")).toHaveLength(0);
});
```

Add tests proving a wrong token returns 401, `POST /v1/usage` returns 405 with `Allow: GET`, a logged-out harness returns 503 after valid proxy authentication, and `h.mock.expireToken = true` maps AIHub's 401 to an account-login error distinct from `代理口令错误`.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```powershell
bun test apps/router/tests/integration.test.ts --test-name-pattern "CC Switch usage endpoint"
```

Expected: FAIL because `/v1/usage` is forwarded upstream or does not return the required fields.

- [ ] **Step 3: Extract the shared proxy-token predicate**

In `apps/router/src/proxy.ts`, add and use:

```ts
export function proxyTokenAuthorized(
  req: Request,
  proxyToken?: string,
): boolean {
  if (!proxyToken) return true;
  const auth = req.headers.get("authorization") ?? "";
  const key = req.headers.get("x-api-key") ?? "";
  return auth === `Bearer ${proxyToken}` || key === proxyToken;
}
```

Replace the existing inline comparison in `handleProxyRequest()` with this predicate while preserving the current `errorResponse(401, "代理口令错误")` response.

- [ ] **Step 4: Implement the local usage handler**

In `apps/router/src/server.ts`, import `proxyTokenAuthorized`, add a small `handleUsage()` function, and invoke it before generic `handleProxy()` routing:

```ts
async function handleUsage(req: Request, deps: ServerDeps): Promise<Response> {
  if (req.method !== "GET") {
    const response = json({ error: "仅支持 GET" }, 405);
    response.headers.set("Allow", "GET");
    return response;
  }
  if (!proxyTokenAuthorized(req, deps.config.proxyToken)) {
    return json({ error: "代理口令错误" }, 401);
  }
  if (!deps.credentials.accessToken) {
    return json({ error: "尚未登录 AIHub" }, 503);
  }
  try {
    const profile = await deps.client.me();
    const balance = accountBalance(profile);
    if (balance === null) return json({ error: "AIHub 余额格式无效" }, 502);
    return json({
      is_active: true,
      remaining: balance,
      balance,
      unit: "USD",
    });
  } catch (error) {
    if (error instanceof AIHubApiError && error.status === 401) {
      return json({ error: "AIHub 登录已失效" }, 401);
    }
    return json({ error: "读取 AIHub 账户余额失败" }, 502);
  }
}
```

Route only exact `/v1/usage`; do not add `/v1/v1/usage` compatibility because it would hide an incorrect CC Switch Base URL/script combination.

- [ ] **Step 5: Run focused proxy and integration tests**

Run:

```powershell
bun test apps/router/tests/integration.test.ts --test-name-pattern "CC Switch usage endpoint"
bun test apps/router/tests/proxy.test.ts --test-name-pattern "proxyToken"
```

Expected: all selected tests PASS, including existing `/v1/responses` proxy authentication behavior.

- [ ] **Step 6: Commit the endpoint**

```powershell
git add apps/router/src/proxy.ts apps/router/src/server.ts apps/router/tests/integration.test.ts
git commit -m "feat: expose authenticated usage balance"
```

### Task 2: Add Ten-Second Proxy Token Reveal

**Files:**
- Modify: `apps/router/src/server.ts`
- Modify: `apps/router/src/ui.ts`
- Test: `apps/router/tests/integration.test.ts`

**Interfaces:**
- Produces: authenticated `GET /ctl/proxy-token` response `{ proxyToken: string | null }`.
- Produces: UI functions `revealProxyToken()`, `hideProxyToken()`, and `renderProxyToken()`.
- Consumes: existing `api()` UI helper, `uiPassword` prompt flow, `#guideApiKey`, and `#settingsApiKey` displays.

- [ ] **Step 1: Write failing control-route and HTML tests**

Extend the existing `uiPassword` integration test with:

```ts
expect((await fetch(`${base}/ctl/proxy-token`)).status).toBe(401);
const tokenResponse = await fetch(`${base}/ctl/proxy-token`, {
  headers: { "x-ui-password": "console-pass-123" },
});
expect(tokenResponse.status).toBe(200);
expect(tokenResponse.headers.get("cache-control")).toBe("no-store");
expect(await tokenResponse.json()).toEqual({ proxyToken: h.config.proxyToken ?? null });
```

Create the harness with both `uiPassword` and `proxyToken`, then assert the rendered HTML contains `revealGuideKey`, `revealSettingsKey`, `hideProxyToken`, `10_000`, and `visibilitychange`, while `html` does not contain the configured token value.

- [ ] **Step 2: Run the UI-password test and verify it fails**

Run:

```powershell
bun test apps/router/tests/integration.test.ts --test-name-pattern "uiPassword"
```

Expected: FAIL because `/ctl/proxy-token` and the reveal controls do not exist.

- [ ] **Step 3: Add the protected control route**

In `handleControl()`, after the common `ctlAuthorized()` check and before `/ctl/status`, add:

```ts
if (path === "/ctl/proxy-token" && req.method === "GET") {
  return json({ proxyToken: deps.config.proxyToken ?? null });
}
```

Do not add this value to `/ctl/status` or any rendered HTML data.

- [ ] **Step 4: Add masked eye controls to both connection displays**

In `apps/router/src/ui.ts`, add eye icon buttons beside `#guideApiKey` and `#settingsApiKey`. Use Lucide Eye/EyeOff path geometry in inline SVG because the UI is a dependency-free HTML template; add `title` and `aria-label` values that switch between `查看代理口令` and `隐藏代理口令`.

Keep both copy buttons disabled while masked. Add narrowly scoped `.token-eye` styles so the icons use stroke rendering and stable dimensions without altering existing filled icons.

- [ ] **Step 5: Implement reveal lifecycle and auth rejection cleanup**

Add transient state and functions equivalent to:

```js
let revealedProxyToken="",proxyTokenTimer;
function hideProxyToken(){
  if(proxyTokenTimer)clearTimeout(proxyTokenTimer);
  proxyTokenTimer=undefined;
  revealedProxyToken="";
  renderProxyToken();
}
function renderProxyToken(){
  const protectedKey=Boolean(lastStatus?.config.proxyAuthRequired);
  const value=protectedKey?(revealedProxyToken||"••••••••••••"):"aihub-auto";
  $("#guideApiKey").textContent=value;
  $("#settingsApiKey").textContent=value;
  $("#copyGuideKey").disabled=protectedKey&&!revealedProxyToken;
  $("#copySettingsKey").disabled=protectedKey&&!revealedProxyToken;
  // Update both eye buttons' icon, title, aria-label, and hidden state here.
}
async function revealProxyToken(){
  if(revealedProxyToken){hideProxyToken();return}
  const result=await api("/ctl/proxy-token");
  if(typeof result.proxyToken!=="string"||!result.proxyToken)throw new Error("未配置代理口令");
  revealedProxyToken=result.proxyToken;
  renderProxyToken();
  proxyTokenTimer=setTimeout(hideProxyToken,10_000);
}
```

Change `api()` so any 401 clears `uiPass` and calls `hideProxyToken()` before prompting again. Call `renderProxyToken()` from `updateConnection()` rather than inserting the instructional placeholder. Add a `visibilitychange` listener that calls `hideProxyToken()` whenever `document.visibilityState !== "visible"`.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
bun test apps/router/tests/integration.test.ts --test-name-pattern "uiPassword|CC Switch usage endpoint"
bunx tsc --noEmit -p tsconfig.json
```

Expected: selected tests and TypeScript check PASS.

- [ ] **Step 7: Commit the reveal feature**

```powershell
git add apps/router/src/server.ts apps/router/src/ui.ts apps/router/tests/integration.test.ts
git commit -m "feat: reveal proxy token temporarily"
```

### Task 3: Document CC Switch and Prepare Release 0.4.5

**Files:**
- Modify: `apps/router/README.md`
- Modify: `apps/router/package.json`

**Interfaces:**
- Produces: copyable CC Switch custom usage script using `{{baseUrl}}/usage`.
- Produces: router release metadata `0.4.5` used by Sentry and built artifacts.

- [ ] **Step 1: Add operator documentation**

Document these exact CC Switch settings in `apps/router/README.md`:

```text
Base URL: http://111.228.17.120:10001/v1
API Key:  router config.json 中的 proxyToken（不是 uiPassword，也不是 AIHub 原始 Key）
```

Include the approved custom usage script from the design with `url: "{{baseUrl}}/usage"`, and state that usage-query Base URL/API Key overrides should remain empty so provider credentials are reused.

- [ ] **Step 2: Bump the router version**

Change only `apps/router/package.json` from `0.4.4` to `0.4.5`. Do not change the core or Koishi package versions.

- [ ] **Step 3: Run complete validation**

Run:

```powershell
bun run check
bun scripts/build.ts linux-x64
```

Expected: all tests PASS, TypeScript reports no errors, and `artifacts/linux-x64/aihub-auto` plus `artifacts/aihub-auto-headless-linux-x64.zip` are created.

- [ ] **Step 4: Confirm the token is absent from artifacts and diffs**

Run searches for the live token only through a shell variable, never as a command literal or displayed output. Confirm the configured value is absent from source, HTML tests, build logs, and `git diff`; verify `git diff --check` passes.

- [ ] **Step 5: Commit docs and release metadata**

```powershell
git add apps/router/README.md apps/router/package.json
git commit -m "docs: add CC Switch usage setup"
```

### Task 4: Back Up, Deploy, and Verify the Live Service

**Files:**
- Local build: `artifacts/linux-x64/aihub-auto`
- Remote binary: `/opt/aihub-auto/aihub-auto`
- Remote config, read-only: `/var/lib/aihub-auto/config.json`
- Remote rollback directory: `/var/lib/aihub-auto/rollback-v0.4.5-<timestamp>`

**Interfaces:**
- Consumes: verified Linux x64 binary from Task 3.
- Preserves: current live config, credentials, state, systemd unit, port, and secrets.
- Produces: healthy `aihub-auto.service` running release `0.4.5` behavior.

- [ ] **Step 1: Capture baseline health without exposing secrets**

Over SSH as `easytunnel-deploy@111.228.17.120`, record service active state, PID, `NRestarts`, listener on port `10001`, binary SHA-256, and HTTP status for `/healthz`, `/v1`, `/ui`, unauthenticated `/ctl/status`, and unauthenticated `/v1/responses`. Read `proxyToken` only into a remote shell variable for authenticated probes; never echo it.

- [ ] **Step 2: Upload and verify the candidate binary**

Compute local SHA-256, upload to a unique `/tmp/aihub-auto-0.4.5-<timestamp>` path with `scp`, compute the remote SHA-256, and require exact equality before installation.

- [ ] **Step 3: Create a rollback backup**

Create `/var/lib/aihub-auto/rollback-v0.4.5-<timestamp>` with mode `0700`, copy the current `/opt/aihub-auto/aihub-auto` into it, preserve executable mode, and verify the backup hash matches the pre-deployment hash.

- [ ] **Step 4: Install and restart atomically**

Use `sudo install -o root -g root -m 0755 <uploaded-file> /opt/aihub-auto/aihub-auto`, restart `aihub-auto.service`, and wait until systemd reports `active`. Do not edit `/var/lib/aihub-auto/config.json` or the unit file.

- [ ] **Step 5: Verify live API and UI behavior**

Verify:

```text
GET /healthz                                      -> 200
GET /v1                                           -> 200 without token
GET /v1/responses                                 -> 401 without token
GET /v1/usage                                     -> 401 without token
GET /v1/usage + Authorization: Bearer proxyToken  -> 200 with finite remaining and unit USD
GET /ctl/proxy-token                              -> 401 without uiPassword
GET /ctl/proxy-token + x-ui-password              -> 200 and exact configured token
```

Perform authenticated comparisons inside the remote shell or local variables without printing either secret. Fetch `/ui`, confirm the eye controls and ten-second script are present, and confirm neither configured secret appears in the HTML.

- [ ] **Step 6: Verify CC Switch request shape**

Issue the same request as the approved script against `http://111.228.17.120:10001/v1/usage` with the provider API key in `Authorization: Bearer ...`. Confirm the response's `remaining` is finite and equals `balance`.

- [ ] **Step 7: Check stability and retain rollback**

Confirm the service PID is stable after probes, `NRestarts` has not increased unexpectedly, logs contain no new startup or request errors, and port `10001` remains the only intended listener. Keep the rollback directory and report its path and deployed SHA-256.
