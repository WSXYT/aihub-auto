import {
	AIHubClient,
	CircuitBreaker,
	LocalObservationStore,
} from "@aihub-auto/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ConfigSchema,
	FileStore,
	StateSchema,
	type AppConfig,
	type AppState,
	type Credentials,
} from "../src/config.ts";
import { RouteDaemon } from "../src/daemon.ts";
import { RouteExecutor } from "../src/executor.ts";
import { AuditLog, Logger } from "../src/logger.ts";
import type { ProxyDeps } from "../src/proxy.ts";
import { createServer, type ServerDeps } from "../src/server.ts";
import { SessionAffinity } from "../src/session.ts";
import { SingleKeyGate, TrafficTracker } from "../src/traffic.ts";
import { MockAIHub } from "./mock-upstream.ts";

export interface Harness {
	mock: MockAIHub;
	config: AppConfig;
	state: AppState;
	credentials: Credentials;
	client: AIHubClient;
	executor: RouteExecutor;
	daemon: RouteDaemon;
	breaker: CircuitBreaker;
	observations: LocalObservationStore;
	affinity: SessionAffinity;
	traffic: TrafficTracker;
	proxyDeps: ProxyDeps;
	server?: ReturnType<typeof createServer>;
	serverUrl?: string;
	configDir: string;
	dispose: () => void;
}

export function createHarness(opts?: {
	configPatch?: Partial<AppConfig>;
	withServer?: boolean;
	loggedIn?: boolean;
	probeOutboundProxy?: ServerDeps["probeOutboundProxy"];
}): Harness {
	const mock = new MockAIHub();
	const dir = mkdtempSync(join(tmpdir(), "aihub-auto-test-"));
	const store = new FileStore(dir);

	const config = ConfigSchema.parse({
		baseUrl: mock.url,
		pollIntervalMs: 60_000,
		...opts?.configPatch,
	});
	const state = StateSchema.parse({});
	const credentials: Credentials =
		opts?.loggedIn === false
			? {}
			: { accessToken: "mock-at", refreshToken: "mock-rt" };

	const logger = new Logger("error", () => {});
	const audit = new AuditLog(undefined);
	const client = new AIHubClient({
		baseUrl: mock.url,
		token: () => credentials.accessToken,
	});
	const breaker = new CircuitBreaker();
	const observations = new LocalObservationStore();
	const traffic = new TrafficTracker();
	const singleKeyGate = new SingleKeyGate();
	const affinity = new SessionAffinity(
		state,
		config.sessionTtlMs,
		config.sessionMaxEntries,
	);

	const persistState = async () => store.write("state.json", state);
	const persistCredentials = async () =>
		store.write("credentials.json", credentials);
	const persistConfig = async () => store.write("config.json", config);

	const executor = new RouteExecutor({
		client,
		state,
		credentials,
		logger,
		keyMode: config.keyMode,
		singleKeyId: config.singleKeyId,
		poolMaxGroups: config.poolMaxGroups,
		evictionGraceMs: config.decision.cacheIdleMs,
		hardProtectedGroupIds: () => traffic.activeGroupIds(),
		softProtectedGroupIds: () => {
			const groups = affinity.protectedGroupIds(config.decision.cacheIdleMs);
			if (state.manualLock.groupId !== null) {
				groups.add(state.manualLock.groupId);
			}
			return groups;
		},
		onPoolKeyRemoved: (groupId, forced) => {
			if (forced) affinity.forgetGroup(groupId);
		},
		persistState,
		persistCredentials,
		reauth: async () => {
			if (!credentials.refreshToken) return false;
			try {
				const s = await client.refreshSession(credentials.refreshToken);
				credentials.accessToken = s.accessToken;
				return true;
			} catch {
				return false;
			}
		},
	});

	const daemon = new RouteDaemon({
		config,
		state,
		credentials,
		client,
		executor,
		breaker,
		observations,
		affinity,
		traffic,
		singleKeyGate,
		logger,
		audit,
		persistState,
		persistStateSoon: () => {},
		persistCredentials,
	});

	const proxyDeps: ProxyDeps = {
		baseUrl: mock.url,
		keyMode: config.keyMode,
		route: (request) => daemon.route(request),
		reportFailure: (groupId) => daemon.reportFailure(groupId),
		reportSuccess: (groupId) => daemon.reportSuccess(groupId),
		reportNeutral: (groupId) => daemon.reportNeutral(groupId),
		reportModelIncompatible: (groupId, model) =>
			daemon.reportModelIncompatible(groupId, model),
		reportModelSupported: (groupId, model) =>
			daemon.reportModelSupported(groupId, model),
		affinity,
		observations,
		traffic,
		singleKeyGate,
		logger,
		ttfbTimeoutMs: config.ttfbTimeoutMs,
		proxyToken: config.proxyToken,
		upstreamUserAgent: () => config.upstreamUserAgent,
	};

	let server: ReturnType<typeof createServer> | undefined;
	let serverUrl: string | undefined;
	if (opts?.withServer) {
		const serverDeps: ServerDeps = {
			config,
			state,
			credentials,
			client,
			daemon,
			executor,
			proxyDeps,
			store,
			logger,
			persistConfig,
			persistState,
			persistCredentials,
			sentryDsn: config.sentryDsn,
			desktopMode: false,
			syncSentryUser: () => {},
			probeOutboundProxy:
				opts?.probeOutboundProxy ?? (async () => ({ latencyMs: 1 })),
		};
		config.listen.port = 0;
		server = createServer(serverDeps);
		serverUrl = `http://127.0.0.1:${server.port}`;
	}

	return {
		mock,
		config,
		state,
		credentials,
		client,
		executor,
		daemon,
		breaker,
		observations,
		affinity,
		traffic,
		proxyDeps,
		server,
		serverUrl,
		configDir: dir,
		dispose: () => {
			daemon.stop();
			server?.stop(true);
			mock.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
