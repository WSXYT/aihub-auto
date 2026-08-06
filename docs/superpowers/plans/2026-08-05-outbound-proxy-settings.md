# Outbound Proxy Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the web-page outbound proxy workflow with a real AIHub connectivity test, safe error reporting, and immediate application of saved settings.

**Architecture:** Extract proxy resolution and Bun fetch construction into a focused transport module shared by normal upstream traffic and a bounded connectivity probe. Add one authenticated `/ctl` endpoint that validates unsaved candidate settings without mutating configuration, then extend the existing settings panel with test status and dirty-form protection.

**Tech Stack:** TypeScript 5.7, Bun fetch/Bun test/Bun.serve, Zod 4, Tauri 2 Rust updater, server-rendered HTML/CSS/JavaScript.

## Global Constraints

- Keep the controls in `Settings -> Network and updates`; do not create a new page.
- Supported modes remain exactly `none`, `system`, and `custom`.
- Custom proxy URLs support only absolute `http://` and `https://` URLs; SOCKS and PAC remain unsupported.
- System proxy precedence remains `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, then `http_proxy`.
- The connectivity probe timeout is exactly 8,000 ms in production.
- Testing candidate settings must never persist or mutate them.
- Saving remains permitted without a successful connectivity test.
- Proxy URLs, embedded credentials, socket details, and upstream response bodies must not appear in probe errors or logs.
- Existing requests in flight are not restarted; the next upstream request observes saved settings.
- Do not add runtime dependencies.

## File Map

- Create `apps/router/src/outbound-proxy.ts`: proxy resolution, dynamic Bun fetch construction, connectivity probe, and sanitized typed failures.
- Create `apps/router/tests/outbound-proxy.test.ts`: transport unit coverage independent of the HTTP control plane.
- Modify `apps/router/src/config.ts`: export one strict candidate-settings schema and reuse its field validation in the full application schema.
- Modify `apps/router/src/main.ts`: replace local proxy helpers with the shared transport and inject the real probe into the server.
- Modify `apps/router/src/server.ts`: expose the authenticated connectivity-test endpoint and map typed failures to HTTP responses.
- Modify `apps/router/tests/harness.ts`: inject deterministic connectivity probes into integration servers.
- Modify `apps/router/tests/integration.test.ts`: verify authentication, validation, non-mutation, response shape, and rendered controls.
- Modify `apps/router/src/ui.ts`: add the test action, inline status, responsive styling, and dirty-form state.
- Modify `README.md` and `apps/router/README.md`: document page configuration, mode semantics, and supported protocols.

---

### Task 1: Shared Outbound Transport

**Files:**
- Create: `apps/router/src/outbound-proxy.ts`
- Create: `apps/router/tests/outbound-proxy.test.ts`
- Modify: `apps/router/src/config.ts:74-105,194-202`
- Modify: `apps/router/src/main.ts:31-58,139`

**Interfaces:**
- Produces: `OutboundProxySettings`, a pick of `outboundProxyMode` and `outboundProxyUrl`.
- Produces: `resolveOutboundProxy(settings, env): string | undefined`.
- Produces: `createOutboundFetch(settings, fetchImpl?): typeof fetch`; it reads the mutable settings object on every request.
- Produces: `probeAIHubConnectivity(settings, options): Promise<{ latencyMs: number }>`.
- Produces: `OutboundProxyProbeError` with `kind` equal to `missing_system_proxy`, `timeout`, `connection`, or `upstream`, and optional `upstreamStatus`.
- Produces: strict `OutboundProxyConfigSchema` for the control endpoint.

- [ ] **Step 1: Write failing transport tests**

Create `apps/router/tests/outbound-proxy.test.ts` with direct/system/custom precedence tests, a mutable hot-update test, and probe outcome tests:

```ts
import { describe, expect, test } from "bun:test";
import {
	createOutboundFetch,
	OutboundProxyProbeError,
	probeAIHubConnectivity,
	resolveOutboundProxy,
	type BunProxyFetch,
} from "../src/outbound-proxy.ts";

describe("outbound proxy resolution", () => {
	test("direct ignores environment and system follows documented precedence", () => {
		const env = {
			HTTPS_PROXY: "http://upper-https:1",
			https_proxy: "http://lower-https:2",
			HTTP_PROXY: "http://upper-http:3",
			http_proxy: "http://lower-http:4",
		};
		expect(
			resolveOutboundProxy(
				{ outboundProxyMode: "none", outboundProxyUrl: "" },
				env,
			),
		).toBeUndefined();
		expect(
			resolveOutboundProxy(
				{ outboundProxyMode: "system", outboundProxyUrl: "" },
				env,
			),
		).toBe("http://upper-https:1");
	});

	test("custom wins and dynamic fetch observes the next settings value", async () => {
		const settings = {
			outboundProxyMode: "custom" as const,
			outboundProxyUrl: "http://first:1",
		};
		const seen: Array<string | undefined> = [];
		const transport = createOutboundFetch(settings, (async (_input, init) => {
			seen.push(init?.proxy);
			return new Response("ok");
		}) as BunProxyFetch);
		await transport("https://aihub.top/first");
		settings.outboundProxyUrl = "http://second:2";
		await transport("https://aihub.top/second");
		expect(seen).toEqual(["http://first:1", "http://second:2"]);
	});
});

describe("AIHub connectivity probe", () => {
	test("returns rounded latency for a 2xx public-provider response", async () => {
		const result = await probeAIHubConnectivity(
			{ outboundProxyMode: "custom", outboundProxyUrl: "http://proxy:7890" },
			{
				baseUrl: "https://aihub.top/",
				fetchImpl: (async (input, init) => {
					expect(String(input)).toBe("https://aihub.top/api/v1/public/providers");
					expect(init?.proxy).toBe("http://proxy:7890");
					return new Response("{}", { status: 200 });
				}) as BunProxyFetch,
			},
		);
		expect(Number.isInteger(result.latencyMs)).toBe(true);
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	test("reports missing system proxy without starting a request", async () => {
		let called = false;
		expect(
			probeAIHubConnectivity(
				{ outboundProxyMode: "system", outboundProxyUrl: "" },
				{
					baseUrl: "https://aihub.top",
					env: {},
					fetchImpl: (async () => {
						called = true;
						return new Response();
					}) as BunProxyFetch,
				},
			),
		).rejects.toMatchObject({ kind: "missing_system_proxy" });
		expect(called).toBe(false);
	});

	test("maps timeout, connection, and upstream status without leaking details", async () => {
		const settings = {
			outboundProxyMode: "custom" as const,
			outboundProxyUrl: "http://user:secret@proxy:7890",
		};
		const timeout = probeAIHubConnectivity(settings, {
			baseUrl: "https://aihub.top",
			timeoutMs: 10,
			fetchImpl: ((_input, init) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					),
				)) as BunProxyFetch,
		});
		await expect(timeout).rejects.toMatchObject({ kind: "timeout" });

		for (const [fetchImpl, expected] of [
			[async () => Promise.reject(new Error("secret socket detail")), "connection"],
			[async () => new Response("private body", { status: 503 }), "upstream"],
		] as const) {
			try {
				await probeAIHubConnectivity(settings, {
					baseUrl: "https://aihub.top",
					fetchImpl: fetchImpl as BunProxyFetch,
				});
				throw new Error("probe unexpectedly succeeded");
			} catch (error) {
				expect(error).toBeInstanceOf(OutboundProxyProbeError);
				expect((error as OutboundProxyProbeError).kind).toBe(expected);
				expect(String(error)).not.toContain("secret");
				expect(String(error)).not.toContain("private body");
			}
		}
	});
});
```

- [ ] **Step 2: Run the new test and verify the missing module failure**

Run: `bun test apps/router/tests/outbound-proxy.test.ts`

Expected: FAIL because `../src/outbound-proxy.ts` does not exist.

- [ ] **Step 3: Export a reusable strict settings schema**

In `apps/router/src/config.ts`, replace the private proxy schema fields with shared field definitions and apply the same refinement to both schemas:

```ts
export const OutboundProxyModeSchema = z.enum(["none", "system", "custom"]);

export const ProxyUrlSchema = z
	.string()
	.url()
	.max(512)
	.refine((value) => {
		try {
			return ["http:", "https:"].includes(new URL(value).protocol);
		} catch {
			return false;
		}
	}, "自定义代理必须是 HTTP(S) URL");

const outboundProxyFields = {
	outboundProxyMode: OutboundProxyModeSchema.default("none"),
	outboundProxyUrl: z.union([z.literal(""), ProxyUrlSchema]).default(""),
};

function validateOutboundProxy(
	config: { outboundProxyMode: "none" | "system" | "custom"; outboundProxyUrl: string },
	ctx: z.RefinementCtx,
): void {
	if (config.outboundProxyMode === "custom" && !config.outboundProxyUrl) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["outboundProxyUrl"],
			message: "自定义代理模式必须填写代理地址",
		});
	}
}

export const OutboundProxyConfigSchema = z
	.object({
		outboundProxyMode: OutboundProxyModeSchema,
		outboundProxyUrl: z.union([z.literal(""), ProxyUrlSchema]),
	})
	.strict()
	.superRefine(validateOutboundProxy);
```

Spread `outboundProxyFields` into `ConfigSchema` and replace its inline callback with `.superRefine(validateOutboundProxy)` so file loading, page saving, and connectivity testing share exactly one rule set.

- [ ] **Step 4: Implement the shared transport and typed probe failures**

Create `apps/router/src/outbound-proxy.ts`:

```ts
import type { AppConfig } from "./config.ts";

export type OutboundProxySettings = Pick<
	AppConfig,
	"outboundProxyMode" | "outboundProxyUrl"
>;

export type BunProxyFetch = (
	input: RequestInfo | URL,
	init?: RequestInit & { proxy?: string },
) => Promise<Response>;

export type OutboundProxyProbeFailure =
	| "missing_system_proxy"
	| "timeout"
	| "connection"
	| "upstream";

export class OutboundProxyProbeError extends Error {
	constructor(
		readonly kind: OutboundProxyProbeFailure,
		readonly upstreamStatus?: number,
	) {
		super(kind);
		this.name = "OutboundProxyProbeError";
	}
}

export function resolveOutboundProxy(
	settings: OutboundProxySettings,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	if (settings.outboundProxyMode === "custom") return settings.outboundProxyUrl;
	if (settings.outboundProxyMode !== "system") return undefined;
	return env["HTTPS_PROXY"] ?? env["https_proxy"] ?? env["HTTP_PROXY"] ?? env["http_proxy"];
}

export function createOutboundFetch(
	settings: OutboundProxySettings,
	fetchImpl: BunProxyFetch = Bun.fetch as BunProxyFetch,
): typeof fetch {
	return ((input: RequestInfo | URL, init?: RequestInit) => {
		const proxy = resolveOutboundProxy(settings);
		return fetchImpl(input, proxy ? { ...init, proxy } : init);
	}) as typeof fetch;
}

export async function probeAIHubConnectivity(
	settings: OutboundProxySettings,
	options: {
		baseUrl: string;
		env?: Record<string, string | undefined>;
		fetchImpl?: BunProxyFetch;
		timeoutMs?: number;
	},
): Promise<{ latencyMs: number }> {
	const proxy = resolveOutboundProxy(settings, options.env ?? process.env);
	if (settings.outboundProxyMode === "system" && !proxy) {
		throw new OutboundProxyProbeError("missing_system_proxy");
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
	const started = performance.now();
	try {
		const fetchImpl = options.fetchImpl ?? (Bun.fetch as BunProxyFetch);
		const response = await fetchImpl(
			`${options.baseUrl.replace(/\/+$/, "")}/api/v1/public/providers`,
			{
				method: "GET",
				headers: { Accept: "application/json" },
				signal: controller.signal,
				...(proxy ? { proxy } : {}),
			},
		);
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new OutboundProxyProbeError("upstream", response.status);
		}
		await response.body?.cancel().catch(() => {});
		return { latencyMs: Math.max(0, Math.round(performance.now() - started)) };
	} catch (error) {
		if (error instanceof OutboundProxyProbeError) throw error;
		if (controller.signal.aborted) throw new OutboundProxyProbeError("timeout");
		throw new OutboundProxyProbeError("connection");
	} finally {
		clearTimeout(timer);
	}
}
```

- [ ] **Step 5: Replace the local main-process transport helpers**

In `apps/router/src/main.ts`, delete `upstreamProxy` and `upstreamFetch`, import `createOutboundFetch`, and initialize the shared client/model transport with:

```ts
const fetchUpstream = createOutboundFetch(config);
```

Because `config` is mutated in place by `/ctl/config`, the closure sees the next saved URL without rebuilding `AIHubClient` or `ProxyDeps`.

- [ ] **Step 6: Run transport and existing config tests**

Run: `bun test apps/router/tests/outbound-proxy.test.ts apps/router/tests/integration.test.ts`

Expected: PASS with no unhandled rejection after the timeout case.

- [ ] **Step 7: Commit the shared transport**

```bash
git add apps/router/src/config.ts apps/router/src/main.ts apps/router/src/outbound-proxy.ts apps/router/tests/outbound-proxy.test.ts
git commit -m "refactor: centralize outbound proxy transport"
```

---

### Task 2: Authenticated Connectivity Test Endpoint

**Files:**
- Modify: `apps/router/src/server.ts:1-27,187-230`
- Modify: `apps/router/src/main.ts:24-30,280-305`
- Modify: `apps/router/tests/harness.ts:30-55,145-185`
- Modify: `apps/router/tests/integration.test.ts:730-805,891-930`

**Interfaces:**
- Consumes: `OutboundProxyConfigSchema`, `OutboundProxySettings`, `OutboundProxyProbeError`, and `probeAIHubConnectivity` from Task 1.
- Produces: required `ServerDeps.probeOutboundProxy(settings): Promise<{ latencyMs: number }>`.
- Produces: `POST /ctl/outbound-proxy/test`, returning `{ ok: true, latencyMs }` or `{ error }` with status 400, 502, or 504.

- [ ] **Step 1: Extend the test harness with deterministic probe injection**

Add an option and server dependency in `apps/router/tests/harness.ts`:

```ts
export function createHarness(opts?: {
	configPatch?: Partial<AppConfig>;
	withServer?: boolean;
	loggedIn?: boolean;
	probeOutboundProxy?: ServerDeps["probeOutboundProxy"];
}): Harness {
	// existing setup remains unchanged
}
```

When constructing `serverDeps`, set:

```ts
probeOutboundProxy:
	opts?.probeOutboundProxy ?? (async () => ({ latencyMs: 1 })),
```

- [ ] **Step 2: Write failing endpoint integration tests**

Add this focused block to `apps/router/tests/integration.test.ts`:

```ts
describe("outbound proxy connectivity control", () => {
	test("tests unsaved strict candidate settings without mutating config", async () => {
		let seen: unknown;
		h = createHarness({
			withServer: true,
			probeOutboundProxy: async (settings) => {
				seen = settings;
				return { latencyMs: 42 };
			},
		});
		const before = {
			mode: h.config.outboundProxyMode,
			url: h.config.outboundProxyUrl,
		};
		const response = await fetch(`${h.serverUrl}/ctl/outbound-proxy/test`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				outboundProxyMode: "custom",
				outboundProxyUrl: "http://127.0.0.1:7890",
			}),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ ok: true, latencyMs: 42 });
		expect(seen).toEqual({
			outboundProxyMode: "custom",
			outboundProxyUrl: "http://127.0.0.1:7890",
		});
		expect(h.config.outboundProxyMode).toBe(before.mode);
		expect(h.config.outboundProxyUrl).toBe(before.url);

		for (const body of [
			{ outboundProxyMode: "custom", outboundProxyUrl: "" },
			{ outboundProxyMode: "none", outboundProxyUrl: "", extra: true },
		]) {
			const invalid = await fetch(`${h.serverUrl}/ctl/outbound-proxy/test`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(invalid.status).toBe(400);
		}
	});

	test("requires ui password and maps only sanitized probe categories", async () => {
		h = createHarness({
			withServer: true,
			configPatch: { uiPassword: "console-pass-123" },
			probeOutboundProxy: async () => {
				throw new OutboundProxyProbeError("timeout");
			},
		});
		const request = (headers?: HeadersInit) =>
			fetch(`${h.serverUrl}/ctl/outbound-proxy/test`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: JSON.stringify({
					outboundProxyMode: "none",
					outboundProxyUrl: "",
				}),
			});
		expect((await request()).status).toBe(401);
		const timedOut = await request({ "x-ui-password": "console-pass-123" });
		expect(timedOut.status).toBe(504);
		expect(await timedOut.json()).toEqual({ error: "AIHub 连接超时" });
	});
});
```

Import `OutboundProxyProbeError` at the top of the test file.

- [ ] **Step 3: Run integration tests and confirm the missing dependency/route failures**

Run: `bun test apps/router/tests/integration.test.ts`

Expected: FAIL because `ServerDeps.probeOutboundProxy` and `/ctl/outbound-proxy/test` are absent.

- [ ] **Step 4: Add the server dependency and exact route**

In `apps/router/src/server.ts`, import the Task 1 types and schema, then add:

```ts
probeOutboundProxy: (
	settings: OutboundProxySettings,
) => Promise<{ latencyMs: number }>;
```

to `ServerDeps`. Immediately after `/ctl/proxy-token`, add the exact POST route:

```ts
if (path === "/ctl/outbound-proxy/test" && req.method === "POST") {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return json({ error: "非法 JSON" }, 400);
	}
	const parsed = OutboundProxyConfigSchema.safeParse(body);
	if (!parsed.success) {
		return json(
			{ error: `代理配置校验失败: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` },
			400,
		);
	}
	try {
		const result = await deps.probeOutboundProxy(parsed.data);
		return json({ ok: true, latencyMs: Math.max(0, Math.round(result.latencyMs)) });
	} catch (error) {
		if (!(error instanceof OutboundProxyProbeError)) {
			return json({ error: "无法通过该代理连接 AIHub" }, 502);
		}
		if (error.kind === "missing_system_proxy") {
			return json({ error: "未检测到 HTTPS_PROXY 或 HTTP_PROXY" }, 400);
		}
		if (error.kind === "timeout") {
			return json({ error: "AIHub 连接超时" }, 504);
		}
		if (error.kind === "upstream") {
			return json({ error: `AIHub 返回 HTTP ${error.upstreamStatus ?? 502}` }, 502);
		}
		return json({ error: "无法通过该代理连接 AIHub" }, 502);
	}
}
```

All `/ctl/*` authentication and browser-origin validation already run before this branch. The shared `json()` helper already sets `Cache-Control: no-store`.

- [ ] **Step 5: Inject the real production probe**

In `apps/router/src/main.ts`, import `probeAIHubConnectivity` and pass this dependency to `createServer`:

```ts
probeOutboundProxy: (settings) =>
	probeAIHubConnectivity(settings, { baseUrl: config.baseUrl }),
```

- [ ] **Step 6: Run endpoint and type tests**

Run: `bun test apps/router/tests/integration.test.ts apps/router/tests/outbound-proxy.test.ts`

Expected: PASS.

Run: `bunx tsc --noEmit -p tsconfig.json`

Expected: exit code 0 with no diagnostics.

- [ ] **Step 7: Commit the control endpoint**

```bash
git add apps/router/src/main.ts apps/router/src/server.ts apps/router/tests/harness.ts apps/router/tests/integration.test.ts
git commit -m "feat: test outbound proxy connectivity"
```

---

### Task 3: Settings Page Test Workflow

**Files:**
- Modify: `apps/router/src/ui.ts:11-14,133-136,160-165,201,209-210,224-225`
- Modify: `apps/router/tests/integration.test.ts:670-700,940-970`

**Interfaces:**
- Consumes: `POST /ctl/outbound-proxy/test` from Task 2.
- Produces: controls `#testOutboundProxy` and `#outboundProxyTestResult`.
- Produces: browser state `outboundProxyDirty`, `proxyFormValues()`, `clearProxyTestResult()`, and `testOutboundProxy()`.

- [ ] **Step 1: Add failing rendered-UI assertions**

Extend the existing `/ui` integration assertions:

```ts
expect(html).toContain('id="outboundProxyMode"');
expect(html).toContain('id="outboundProxyUrl"');
expect(html).toContain('id="testOutboundProxy"');
expect(html).toContain('id="outboundProxyTestResult"');
expect(html).toContain('role="status"');
expect(html).toContain('aria-live="polite"');
expect(html).toContain('function testOutboundProxy');
expect(html).toContain('outboundProxyDirty');
expect(html).toContain('/ctl/outbound-proxy/test');
```

- [ ] **Step 2: Run the focused UI integration test and verify failure**

Run: `bun test apps/router/tests/integration.test.ts --test-name-pattern "uiPassword"`

Expected: FAIL on the missing test button or status element assertion.

- [ ] **Step 3: Add stable responsive controls and accessible status**

In `apps/router/src/ui.ts`, add CSS:

```css
.proxy-test-result{min-width:120px;min-height:21px;align-self:center}
.proxy-test-result:empty{display:none}
```

Replace the current outbound proxy panel body with the same selector and URL fields followed by:

```html
<button class="secondary" id="testOutboundProxy">测试连接</button>
<button id="saveOutboundProxy">保存代理</button>
<span class="chip proxy-test-result" id="outboundProxyTestResult" role="status" aria-live="polite"></span>
<span class="setting-help" id="outboundProxyHelp">直连 AIHub 与更新服务。</span>
```

The existing `.controls { flex-wrap: wrap }` rule supplies narrow-width wrapping without a new breakpoint.

- [ ] **Step 4: Preserve unsaved form values and implement inline probe feedback**

Near other UI state, add:

```js
let outboundProxyDirty=false;
```

Replace direct proxy field population inside `render(status)` with:

```js
if(!outboundProxyDirty){
	$("#outboundProxyMode").value=status.config.outboundProxyMode||"none";
	$("#outboundProxyUrl").value=status.config.outboundProxyUrl||"";
}
syncProxyControl();
```

Add the form and result helpers:

```js
function proxyFormValues(){
	const outboundProxyMode=$("#outboundProxyMode").value;
	const outboundProxyUrl=$("#outboundProxyUrl").value.trim();
	if(outboundProxyMode==="custom"&&!outboundProxyUrl)throw new Error("请填写自定义代理地址");
	return {outboundProxyMode,outboundProxyUrl};
}
function clearProxyTestResult(){
	const result=$("#outboundProxyTestResult");
	result.textContent="";
	result.className="chip proxy-test-result";
}
function proxyFormChanged(){
	outboundProxyDirty=true;
	clearProxyTestResult();
	syncProxyControl();
}
async function testOutboundProxy(){
	const result=$("#outboundProxyTestResult");
	result.textContent="测试中...";
	result.className="chip proxy-test-result warn";
	try{
		const tested=await api("/ctl/outbound-proxy/test",{
			method:"POST",
			body:JSON.stringify(proxyFormValues())
		});
		result.textContent="连接成功 · "+tested.latencyMs+" ms";
		result.className="chip proxy-test-result ok";
	}catch(error){
		result.textContent=error instanceof Error?error.message:String(error);
		result.className="chip proxy-test-result err";
		throw error;
	}
}
async function saveOutboundProxy(){
	await api("/ctl/config",{method:"POST",body:JSON.stringify(proxyFormValues())});
	outboundProxyDirty=false;
	toast("出站代理已保存");
	await refresh();
}
```

Bind the test action and dirty-state events:

```js
$("#testOutboundProxy").addEventListener("click",event=>action(event.currentTarget,testOutboundProxy));
$("#outboundProxyMode").addEventListener("change",proxyFormChanged);
$("#outboundProxyUrl").addEventListener("input",proxyFormChanged);
```

Remove the old mode-only `change` binding. Testing leaves `outboundProxyDirty` true, while a successful save resets it before `refresh()`.

- [ ] **Step 5: Run UI integration and source syntax checks**

Run: `bun test apps/router/tests/integration.test.ts`

Expected: PASS.

Run: `bunx tsc --noEmit -p tsconfig.json`

Expected: exit code 0 with no diagnostics.

- [ ] **Step 6: Commit the settings workflow**

```bash
git add apps/router/src/ui.ts apps/router/tests/integration.test.ts
git commit -m "feat: expose proxy connection test in settings"
```

---

### Task 4: Documentation and End-to-End Verification

**Files:**
- Modify: `README.md:55-96`
- Modify: `apps/router/README.md:90-132`

**Interfaces:**
- Consumes: the completed settings UI, probe route, and runtime transport.
- Produces: user instructions that match the exact page labels and supported proxy protocols.

- [ ] **Step 1: Document the page workflow in the root README**

Add a short paragraph under daily usage stating:

```markdown
AIHub 无法直连时，打开“设置 -> 出站代理”，选择“系统代理”或“自定义代理”。
自定义代理填写完整的 HTTP(S) 地址，例如 `http://127.0.0.1:7890`；可先点击
“测试连接”验证当前输入，再保存。保存后新的 AIHub 与模型请求立即使用该设置，
无需重启。当前不支持 SOCKS 或 PAC。
```

- [ ] **Step 2: Add exact router configuration rows and behavior notes**

In `apps/router/README.md`, add these rows to the configuration table:

```markdown
| `outboundProxyMode` | `none` | `none` 直连、`system` 读取进程的 `HTTPS_PROXY`/`HTTP_PROXY`、`custom` 使用页面填写的地址；可热更新 |
| `outboundProxyUrl` | 空 | 自定义 HTTP(S) 代理地址；仅在 `custom` 模式使用，最长 512 字符 |
```

After the table, document that the page test uses unsaved values, waits at most eight seconds, never saves on its own, and does not expose proxy credentials in error output.

- [ ] **Step 3: Run the complete TypeScript/Bun verification**

Run: `bun run check`

Expected: all Bun tests pass and TypeScript exits with no diagnostics.

- [ ] **Step 4: Run desktop updater regression tests**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: all Rust tests pass, including updater proxy parsing and endpoint tests.

- [ ] **Step 5: Inspect the settings UI in real browser viewports**

Use the `playwright` skill. Start the router on an unused loopback port with an isolated temporary `AIHUB_AUTO_CONFIG_DIR`, open `/ui#settings`, and capture screenshots at 1280x900 and 390x844. Verify all of the following in both screenshots:

```text
The outbound proxy panel is visible in Settings.
Mode, URL, Test connection, and Save proxy do not overlap.
Custom mode enables the URL field.
The status text wraps without changing adjacent control dimensions.
No horizontal page overflow appears at 390px.
```

Exercise direct mode against the normal AIHub endpoint or a deterministic local probe target, then verify the result element changes from `测试中...` to either the green latency result or the red sanitized error. Do not save a machine-specific proxy URL during this visual check.

- [ ] **Step 6: Review the final diff for secret leakage and scope**

Run:

```bash
git diff --check
git diff --stat HEAD~3
rg -n "outboundProxyUrl|ProxyProbe|proxy-test-result" apps/router README.md
```

Expected: no whitespace errors; only the planned router, tests, and documentation files changed; no fixture contains a real credential or externally usable proxy URL.

- [ ] **Step 7: Commit documentation and verification notes**

```bash
git add README.md apps/router/README.md
git commit -m "docs: explain outbound proxy settings"
```
