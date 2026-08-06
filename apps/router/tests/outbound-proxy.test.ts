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
					expect(String(input)).toBe(
						"https://aihub.top/api/v1/public/providers",
					);
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
		await expect(
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
