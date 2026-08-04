import { afterEach, describe, expect, test } from "bun:test";
import { createHarness, type Harness } from "./harness.ts";
import { makeStat } from "./mock-upstream.ts";

let h: Harness;
afterEach(() => h?.dispose());

type Price = {
	status: "ready" | "unauthenticated" | "unavailable" | "stale";
	lowestRate: number | null;
	groupId: number | null;
};

type PriceSnapshot = {
	default: Price;
	groups: Record<string, Price>;
};

async function proxy(
	sourceGroup?: string,
	path = "/v1/chat/completions",
	body: unknown = { model: "gpt-test", messages: [] },
): Promise<Response> {
	const headers = new Headers({
		"Content-Type": "application/json",
		"x-aihub-auto-session": "shared-session",
	});
	if (sourceGroup) headers.set("X-Sub2api-Group", sourceGroup);
	return fetch(`${h.serverUrl}${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

async function prices(): Promise<PriceSnapshot> {
	const response = await fetch(`${h.serverUrl}/ctl/group-prices`, {
		headers: { "x-ui-password": "console-pass-123" },
	});
	expect(response.status).toBe(200);
	return response.json() as Promise<PriceSnapshot>;
}

describe("sub2api source groups", () => {
	test("source policies route independently and report only usable lowest prices", async () => {
		h = createHarness({
			withServer: true,
			configPatch: {
				keyMode: "pool",
				uiPassword: "console-pass-123",
				priceBand: { min: 0, max: 0.2 },
			},
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 1_500 }),
			makeStat({ groupId: 2, rateMultiplier: 0.08, avgTtftMs: 900 }),
		];

		expect((await fetch(`${h.serverUrl}/ctl/group-prices`)).status).toBe(401);
		const updated = await fetch(`${h.serverUrl}/ctl/config`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-ui-password": "console-pass-123",
			},
			body: JSON.stringify({
				groups: {
					budget: {
						mode: "economy",
						priceBand: { min: 0, max: 0.03 },
					},
					"budget-copy": {
						mode: "economy",
						priceBand: { min: 0, max: 0.03 },
					},
					premium: {
						mode: "speed",
						priceBand: { min: 0.07, max: 0.09 },
					},
					alias: {
						mode: "speed",
						priceBand: { min: 0, max: 0.09 },
					},
				},
			}),
		});
		expect(updated.status).toBe(200);
		expect(h.config.groups).toMatchObject({
			budget: { mode: "economy", priceBand: { min: 0, max: 0.03 } },
			"budget-copy": {
				mode: "economy",
				priceBand: { min: 0, max: 0.03 },
			},
			premium: { mode: "speed", priceBand: { min: 0.07, max: 0.09 } },
		});

		const budget = await proxy("budget");
		expect(budget.headers.get("x-aihub-auto-group")).toBe("1");
		await budget.text();
		const budgetCopy = await proxy("budget-copy");
		expect(budgetCopy.headers.get("x-aihub-auto-group")).toBe("1");
		await budgetCopy.text();
		expect(Object.keys(h.state.sessions)).toHaveLength(2);

		const global = await proxy();
		expect(global.headers.get("x-aihub-auto-group")).toBe("1");
		await global.text();
		const premium = await proxy("premium");
		expect(premium.headers.get("x-aihub-auto-group")).toBe("2");
		await premium.text();

		const root = await proxy("budget", "/v1/responses", {
			model: "gpt-test",
			input: "hello",
		});
		expect(root.headers.get("x-aihub-auto-group")).toBe("1");
		const rootBody = (await root.json()) as { id: string };
		const sessionsBeforeBranch = Object.keys(h.state.sessions).length;
		const branch = await proxy("alias", "/v1/responses", {
			model: "gpt-test",
			previous_response_id: rootBody.id,
			input: "continue",
		});
		expect(branch.status).toBe(200);
		await branch.text();
		expect(Object.keys(h.state.sessions)).toHaveLength(
			sessionsBeforeBranch + 1,
		);

		expect(await prices()).toMatchObject({
			default: { status: "ready", lowestRate: 0.02, groupId: 1 },
			groups: {
				budget: { status: "ready", lowestRate: 0.02, groupId: 1 },
				premium: { status: "ready", lowestRate: 0.08, groupId: 2 },
			},
		});

		for (let attempt = 0; attempt < 3; attempt++) h.breaker.recordFailure(1);
		expect((await prices()).groups["budget"]).toEqual({
			status: "unavailable",
			lowestRate: null,
			groupId: null,
		});

		h.mock.stats = h.mock.stats.map((stat) =>
			stat.groupId === 2 ? { ...stat, providerAvailable: false } : stat,
		);
		expect((await prices()).groups["premium"]).toEqual({
			status: "unavailable",
			lowestRate: null,
			groupId: null,
		});

		h.credentials.accessToken = undefined;
		const unauthenticated = await prices();
		expect(unauthenticated.default.status).toBe("unauthenticated");
		expect(unauthenticated.groups["budget"]?.status).toBe("unauthenticated");
		expect(unauthenticated.groups["premium"]?.status).toBe("unauthenticated");
	});

	test("price endpoint distinguishes stale statistics from unavailable account data", async () => {
		h = createHarness({
			withServer: true,
			configPatch: { uiPassword: "console-pass-123" },
		});
		h.mock.stats = [makeStat({ groupId: 1, rateMultiplier: 0.02 })];
		await h.daemon.runOnce();

		const getUsageStats = h.client.getUsageStats.bind(h.client);
		h.client.getUsageStats = async () => {
			throw new Error("usage stats offline");
		};
		expect((await prices()).default).toEqual({
			status: "stale",
			lowestRate: null,
			groupId: null,
		});
		h.client.getUsageStats = getUsageStats;

		h.client.getUserGroupRates = async () => {
			throw new Error("rates offline");
		};
		expect((await prices()).default).toEqual({
			status: "unavailable",
			lowestRate: null,
			groupId: null,
		});
	});
});
