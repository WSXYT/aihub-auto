import type { AppConfig } from "./config.ts";

export type OutboundProxySettings = Pick<
	AppConfig,
	"outboundProxyMode" | "outboundProxyUrl"
>;

export type BunProxyFetch = (
	input: Request | string | URL,
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
	return (
		env["HTTPS_PROXY"] ??
		env["https_proxy"] ??
		env["HTTP_PROXY"] ??
		env["http_proxy"]
	);
}

export function createOutboundFetch(
	settings: OutboundProxySettings,
	fetchImpl: BunProxyFetch = Bun.fetch as BunProxyFetch,
): typeof fetch {
	return ((input: Request | string | URL, init?: RequestInit) => {
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
		return {
			latencyMs: Math.max(0, Math.round(performance.now() - started)),
		};
	} catch (error) {
		if (error instanceof OutboundProxyProbeError) throw error;
		if (controller.signal.aborted) {
			throw new OutboundProxyProbeError("timeout");
		}
		throw new OutboundProxyProbeError("connection");
	} finally {
		clearTimeout(timer);
	}
}
