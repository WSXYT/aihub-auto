import {
	AIHubApiError,
	AIHubClient,
	CircuitBreaker,
	LocalObservationStore,
} from "@aihub-auto/core";
import { join } from "node:path";
import {
	configDir,
	FileStore,
	loadConfig,
	loadCredentials,
	loadState,
	SentryDsnSchema,
	validateListenSecurity,
} from "./config.ts";
import { RouteDaemon } from "./daemon.ts";
import { RouteExecutor } from "./executor.ts";
import { AuditLog, CrashLog, Logger, RollingFileLog } from "./logger.ts";
import {
	createOutboundFetch,
	probeAIHubConnectivity,
} from "./outbound-proxy.ts";
import type { ProxyDeps } from "./proxy.ts";
import { createServer } from "./server.ts";
import { SessionAffinity } from "./session.ts";
import {
	applyStartupOptions,
	parseStartupOptions,
	STARTUP_HELP,
} from "./startup.ts";
import { SingleKeyGate, TrafficTracker } from "./traffic.ts";
import {
	captureRouterException,
	flushRouterSentry,
	initRouterSentry,
	syncSentryUser,
} from "./sentry.ts";

async function main(): Promise<void> {
	const startup = parseStartupOptions(process.argv.slice(2), process.env);
	if (startup.help) {
		console.log(STARTUP_HELP);
		return;
	}
	const dir = configDir();
	const store = new FileStore(dir);
	let config = applyStartupOptions(await loadConfig(store), startup);
	// The desktop sidecar must not inherit a standalone LAN bind from config.json.
	if (process.env["AIHUB_AUTO_DESKTOP"] === "1") {
		config = { ...config, listen: { ...config.listen, host: "127.0.0.1" } };
	}
	const state = await loadState(store);
	const credentials = await loadCredentials(store);
	const sentryDsn = SentryDsnSchema.parse(
		(process.env["SENTRY_DSN"] ?? config.sentryDsn).trim(),
	);
	initRouterSentry({
		dsn: sentryDsn,
		upstreamBaseUrl: config.baseUrl,
	});

	const appLogPath = join(dir, "app.log");
	const crashLogPath = join(dir, "crash.log");
	const appLog = new RollingFileLog(appLogPath);
	const logger = new Logger(config.logLevel, (line) => {
		console.log(line);
		appLog.write(line);
	});
	const crashLog = new CrashLog(crashLogPath);
	// 启动即创建空文件,避免正式环境只剩控制台输出却找不到日志。
	appLog.write(
		`${new Date().toISOString()} [INFO] app.log ready dir=${dir} pid=${process.pid}`,
	);
	crashLog.record("start", {
		runtime: process.version,
		pid: process.pid,
		configDir: dir,
		appLog: appLogPath,
		crashLog: crashLogPath,
		exe: process.execPath,
		cwd: process.cwd(),
	});
	const isControllerClosed = (reason: unknown): boolean =>
		reason instanceof Error &&
		/controller is already closed|invalid state/i.test(reason.message);
	process.on("unhandledRejection", (reason) => {
		const detail =
			reason instanceof Error
				? (reason.stack ?? reason.message)
				: String(reason);
		if (isControllerClosed(reason)) {
			crashLog.record("stream_controller_closed", detail);
			logger.warn(`流控制器竞态(已吞掉):${detail}`);
			return;
		}
		crashLog.record("unhandled_rejection", detail);
		captureRouterException(reason, "unhandled_rejection");
		logger.error(`未处理 Promise:${detail}`);
	});
	process.on("uncaughtException", (err) => {
		crashLog.record("uncaught_exception", err.stack ?? err.message);
		captureRouterException(err, "uncaught_exception");
		logger.error(`未捕获异常:${err.stack ?? err.message}`);
	});
	process.on("beforeExit", (code) =>
		crashLog.record("before_exit", `code=${code}`),
	);
	process.on("exit", (code) => crashLog.record("exit", `code=${code}`));
	const audit = new AuditLog(
		config.auditLog ? join(dir, "audit.jsonl") : undefined,
	);

	const securityProblems = validateListenSecurity(config);
	if (securityProblems.length > 0) {
		for (const p of securityProblems) logger.error(p);
		process.exit(1);
	}

	const fetchUpstream = createOutboundFetch(config);
	const client = new AIHubClient({
		baseUrl: config.baseUrl,
		token: () => credentials.accessToken,
		fetch: fetchUpstream,
	});

	const breaker = CircuitBreaker.fromJSON(state.breaker);
	const observations = LocalObservationStore.fromJSON(state.observations);
	const traffic = new TrafficTracker();
	const singleKeyGate = new SingleKeyGate();
	const persistState = async () => store.write("state.json", state);
	let persistTimer: ReturnType<typeof setTimeout> | undefined;
	const persistStateSoon = () => {
		if (persistTimer) return;
		persistTimer = setTimeout(() => {
			persistTimer = undefined;
			void persistState().catch((err) =>
				logger.warn(`状态保存失败:${err.message}`),
			);
		}, 250);
	};
	const affinity = new SessionAffinity(
		state,
		config.sessionTtlMs,
		config.sessionMaxEntries,
		persistStateSoon,
	);
	const persistConfig = async () => store.write("config.json", config);
	const persistCredentials = async () =>
		store.write("credentials.json", credentials);
	const clearSentryIdentity = async () => {
		if (credentials.email !== undefined) {
			credentials.email = undefined;
			await persistCredentials();
		}
		syncSentryUser(undefined);
	};
	const refreshSentryIdentity = async () => {
		if (!credentials.accessToken) {
			await clearSentryIdentity();
			return;
		}
		try {
			const me = await client.me();
			const value = typeof me["email"] === "string" ? me["email"].trim() : "";
			const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
				? value
				: undefined;
			if (credentials.email !== email) {
				credentials.email = email;
				await persistCredentials();
			}
			syncSentryUser(email);
		} catch (error) {
			if (error instanceof AIHubApiError && error.status === 401) {
				await clearSentryIdentity();
				return;
			}
			syncSentryUser(credentials.email);
		}
	};
	await refreshSentryIdentity();

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
			if (!credentials.refreshToken) {
				daemon.needsReauth = true;
				await clearSentryIdentity();
				return false;
			}
			try {
				const session = await client.refreshSession(credentials.refreshToken);
				credentials.accessToken = session.accessToken;
				credentials.refreshToken = session.refreshToken;
				credentials.expiresAt = session.expiresAt;
				await persistCredentials();
				await refreshSentryIdentity();
				logger.info("token 已自动续期");
				return true;
			} catch {
				await clearSentryIdentity();
				daemon.needsReauth = true;
				logger.error("token 续期失败,请重新登录(控制台)");
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
		persistStateSoon,
		persistCredentials,
	});

	const proxyDeps: ProxyDeps = {
		baseUrl: config.baseUrl,
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
		fetch: fetchUpstream,
	};

	let server: ReturnType<typeof createServer>;
	try {
		server = createServer({
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
			sentryDsn,
			desktopMode: process.env["AIHUB_AUTO_DESKTOP"] === "1",
			syncSentryUser,
			probeOutboundProxy: (settings) =>
				probeAIHubConnectivity(settings, { baseUrl: config.baseUrl }),
		});
	} catch (err) {
		logger.error(
			`无法监听 ${config.listen.host}:${config.listen.port}(端口被占用?已有实例在运行?):${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}

	logger.info(
		`aihub-auto 已启动:http://${config.listen.host}:${config.listen.port}`,
	);
	logger.info(
		`控制台:http://${config.listen.host === "0.0.0.0" ? "127.0.0.1" : config.listen.host}:${config.listen.port}/ui`,
	);
	logger.info(`配置目录:${dir}`);
	logger.info(`应用日志:${appLogPath}`);
	logger.info(`崩溃日志:${crashLogPath}`);

	// 有凭据才做启动对账 + 守护
	if (credentials.accessToken) {
		if (config.keyMode === "pool") {
			executor
				.reconcile()
				.catch((err) => logger.warn(`启动对账失败:${err.message}`));
		}
		daemon.start();
	} else {
		logger.warn("尚未登录 AIHub:打开控制台完成登录后自动开始路由");
		// 轮询等待登录
		const waitLogin = setInterval(() => {
			if (credentials.accessToken) {
				clearInterval(waitLogin);
				if (config.keyMode === "pool") {
					executor
						.reconcile()
						.catch((err) => logger.warn(`对账失败:${err.message}`));
				}
				daemon.start();
			}
		}, 2000);
	}

	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info(`收到 ${signal},优雅退出…`);
		crashLog.record("signal", signal);
		if (persistTimer) clearTimeout(persistTimer);
		daemon.stop();
		server.stop(true);
		if (config.keyMode === "pool" && config.cleanupPoolOnExit) {
			await executor.cleanup().catch(() => {});
		}
		state.breaker = breaker.toJSON();
		state.observations = observations.toJSON();
		await persistState().catch(() => {});
		await flushRouterSentry();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	const desktopShutdownToken = process.env["AIHUB_AUTO_DESKTOP_SHUTDOWN_TOKEN"];
	if (desktopShutdownToken) {
		let input = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => {
			input += chunk;
			let newline = input.indexOf("\n");
			while (newline >= 0) {
				const command = input.slice(0, newline).trimEnd();
				input = input.slice(newline + 1);
				if (command === `shutdown ${desktopShutdownToken}`)
					void shutdown("desktop sidecar");
				newline = input.indexOf("\n");
			}
			if (input.length > 1024) input = input.slice(-1024);
		});
	}
}

main().catch(async (err) => {
	new CrashLog(join(configDir(), "crash.log")).record("startup_error", err);
	captureRouterException(err, "startup_error");
	console.error(`启动失败:${err instanceof Error ? err.message : String(err)}`);
	await flushRouterSentry();
	process.exit(1);
});
