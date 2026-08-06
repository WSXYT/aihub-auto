import { z } from "zod";
import {
	DEFAULT_DECISION_POLICY,
	DEFAULT_ECONOMY_POLICY,
	DEFAULT_ERROR_RATE_CAP,
	DEFAULT_PRICE_BAND,
} from "@aihub-auto/core";
import { join } from "node:path";
import { homedir } from "node:os";

function isPublicSentryDsn(value: string): boolean {
	try {
		const url = new URL(value);
		const path = url.pathname.split("/").filter(Boolean);
		return (
			(url.protocol === "https:" || url.protocol === "http:") &&
			/^[A-Za-z0-9]+$/.test(url.username) &&
			!url.password &&
			Boolean(url.hostname) &&
			/^\d+$/.test(path.at(-1) ?? "") &&
			!url.pathname.endsWith("/") &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}

export const SentryDsnSchema = z.union([
	z.literal(""),
	z
		.string()
		.url()
		.refine(
			isPublicSentryDsn,
			"需要公共 Sentry DSN(含 public key 和 project id,不得含 secret)",
		),
]);

function isHttpOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "https:" || url.protocol === "http:") &&
			value === url.origin
		);
	} catch {
		return false;
	}
}

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

export const PublicOriginSchema = z.union([
	z.literal(""),
	z
		.string()
		.url()
		.refine(isHttpOrigin, "必须是完整 HTTP(S) origin,不得包含路径"),
]);

export const UpdateMirrorSchema = z
	.string()
	.url()
	.refine(isHttpsUrl, "更新镜像必须是 HTTPS URL");

export const OutboundProxyModeSchema = z.enum(["none", "system", "custom"]);

export const ProxyUrlSchema = z
	.string()
	.url()
	.max(512)
	.refine(
		(value) => {
			try {
				const protocol = new URL(value).protocol;
				return protocol === "http:" || protocol === "https:";
			} catch {
				return false;
			}
		},
		"自定义代理必须是 HTTP(S) URL",
	);

const outboundProxyFields = {
	outboundProxyMode: OutboundProxyModeSchema.default("none"),
	outboundProxyUrl: z.union([z.literal(""), ProxyUrlSchema]).default(""),
};

function validateOutboundProxy(
	config: {
		outboundProxyMode: "none" | "system" | "custom";
		outboundProxyUrl: string;
	},
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

export const ConfigSchema = z
	.object({
	/** AIHub 站点(sub2api),usage-stats 为 aihub 自有接口 */
	baseUrl: z.string().url().default("https://aihub.top"),
	/** 可信反向代理对外 origin;空字符串表示不接受跨 origin 控制台请求。 */
	publicOrigin: PublicOriginSchema.default(""),
	/** Sentry 公共 DSN;留空时后端 SDK 与网页反馈均不加载。 */
	sentryDsn: SentryDsnSchema.default(
		"https://b8e9b3b5f1d86b44f01dae7fe83cfcce@o4510289605296128.ingest.de.sentry.io/4511828894548048",
	),
	/** 桌面更新: GitHub 失败后依次尝试的 HTTPS latest.json 镜像。 */
	updateMirrors: z.array(UpdateMirrorSchema).max(3).default([]),
	/** 出站代理: none 直连,system 使用进程继承的 HTTP(S)_PROXY,custom 使用下方地址。 */
	...outboundProxyFields,
	/** 模型代理请求的 User-Agent;空字符串表示沿用客户端值。 */
	upstreamUserAgent: z
		.string()
		.max(256)
		.refine(
			(value) => /^[\x20-\x7e]*$/.test(value),
			"User-Agent 只能包含可打印 ASCII 字符",
		)
		.default(""),
	listen: z
		.object({
			host: z.string().default("127.0.0.1"),
			port: z.number().int().min(0).max(65535).default(8787),
		})
		.prefault({}),
	mode: z.enum(["economy", "balanced", "speed"]).default("balanced"),
	priceBand: z
		.object({
			min: z.number().min(0).default(DEFAULT_PRICE_BAND.min),
			max: z.number().min(0).default(DEFAULT_PRICE_BAND.max),
		})
		.prefault({}),
	blacklist: z.array(z.number().int()).default([]),
	economyPolicy: z
		.object({
			minOutcomeSamples: z
				.number()
				.int()
				.min(1)
				.max(100)
				.default(DEFAULT_ECONOMY_POLICY.minOutcomeSamples),
			minSuccessRate: z
				.number()
				.min(0)
				.max(1)
				.default(DEFAULT_ECONOMY_POLICY.minSuccessRate),
			maxConservativeLatencyMs: z
				.number()
				.int()
				.min(1_000)
				.max(120_000)
				.default(DEFAULT_ECONOMY_POLICY.maxConservativeLatencyMs),
		})
		.prefault({}),
	/** pool 为主模式;single 仅兼容无法创建 Key 的账号 */
	keyMode: z.enum(["single", "pool"]).default("pool"),
	/** 兼容模式:指定要被全局切组的 keyId;缺省自动选第一个 */
	singleKeyId: z.number().int().optional(),
	poolMaxGroups: z.number().int().min(1).max(20).default(4),
	/** 会话映射保留 24h;池 Key 仅按 cacheIdleMs 短期保护。 */
	sessionTtlMs: z
		.number()
		.int()
		.min(60_000)
		.default(24 * 60 * 60_000),
	sessionMaxEntries: z.number().int().min(100).max(100_000).default(10_000),
	cleanupPoolOnExit: z.boolean().default(false),
	pollIntervalMs: z.number().int().min(5_000).default(60_000),
	samples: z.number().int().min(1).max(500).default(100),
	errorRateCap: z.number().min(0).max(1).default(DEFAULT_ERROR_RATE_CAP),
	decision: z
		.object({
			stickiness: z.number().min(0).default(DEFAULT_DECISION_POLICY.stickiness),
			cachePenaltyMax: z
				.number()
				.min(0)
				.default(DEFAULT_DECISION_POLICY.cachePenaltyMax),
			cacheIdleMs: z
				.number()
				.int()
				.min(0)
				.default(DEFAULT_DECISION_POLICY.cacheIdleMs),
			minDwellMs: z
				.number()
				.int()
				.min(0)
				.default(DEFAULT_DECISION_POLICY.minDwellMs),
		})
		.prefault({}),
	/** TTFB 超时(故障转移判定) */
	ttfbTimeoutMs: z.number().int().min(1_000).default(60_000),
	/** 非 loopback 监听时必须:反代 /v1 的 Bearer 口令 */
	proxyToken: z.string().min(16).optional(),
	/** 非 loopback 监听时必须:/ctl 控制台口令 */
	uiPassword: z.string().min(9).optional(),
	/** JSONL 审计日志 */
	auditLog: z.boolean().default(false),
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
	})
	.superRefine(validateOutboundProxy);

export type AppConfig = z.infer<typeof ConfigSchema>;

export const StateSchema = z.object({
	currentGroupId: z.number().int().optional(),
	/** 控制台手动锁定;revision 防止多个标签页用旧状态覆盖新锁定。 */
	manualLock: z
		.object({
			groupId: z.number().int().positive().nullable(),
			revision: z.number().int().nonnegative(),
		})
		.default({ groupId: null, revision: 0 }),
	lastSwitchAt: z.number().optional(),
	pendingSwitch: z
		.object({ groupId: z.number().int(), since: z.number() })
		.optional(),
	/** pool Key:groupId -> {keyId, sk, lastUsedAt} */
	pool: z
		.record(
			z.string(),
			z.object({
				keyId: z.number().int(),
				sk: z.string(),
				lastUsedAt: z.number(),
			}),
		)
		.default({}),
	/** 只保存 SHA-256 会话摘要,不落原始提示词/会话 ID */
	sessions: z
		.record(
			z.string(),
			z.object({
				groupId: z.number().int(),
				lastUsedAt: z.number(),
				/** 进程内 CAS 版本;旧状态文件缺失时从 0 继续。 */
				revision: z.number().int().nonnegative().optional(),
				cacheStatus: z.enum(["hit", "miss"]).optional(),
				cacheObservedAt: z.number().optional(),
			}),
		)
		.default({}),
	/** Responses API:hash(response_id) -> 会话摘要 + 实际上游组 */
	responseAliases: z
		.record(
			z.string(),
			z.object({
				sessionKey: z.string(),
				groupId: z.number().int().optional(),
				lastUsedAt: z.number(),
			}),
		)
		.default({}),
	/** hash(model) -> groupId -> 不兼容记录过期时间 */
	modelBlocks: z
		.record(z.string(), z.record(z.string(), z.number()))
		.default({}),
	breaker: z.unknown().optional(),
	observations: z.unknown().optional(),
});

export type AppState = z.infer<typeof StateSchema>;

export const CredentialsSchema = z.object({
	accessToken: z.string().optional(),
	/** 已验证 AIHub 身份邮箱,仅用于 Sentry user/Feedback 默认邮箱。 */
	email: z.string().email().optional(),
	refreshToken: z.string().optional(),
	expiresAt: z.number().optional(),
	/** 模式 A 使用的 sk(反代注入用);从 keys 列表或用户粘贴获得 */
	singleKeySk: z.string().optional(),
});

export type Credentials = z.infer<typeof CredentialsSchema>;

export function configDir(): string {
	if (process.env["AIHUB_AUTO_CONFIG_DIR"])
		return process.env["AIHUB_AUTO_CONFIG_DIR"];
	const platform = process.platform;
	if (platform === "win32") {
		return join(
			process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"),
			"aihub-auto",
		);
	}
	if (platform === "darwin") {
		return join(homedir(), "Library", "Application Support", "aihub-auto");
	}
	return join(
		process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
		"aihub-auto",
	);
}

function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** 非 loopback 监听的安全硬门槛 */
export function validateListenSecurity(config: AppConfig): string[] {
	const problems: string[] = [];
	if (!isLoopback(config.listen.host)) {
		if (!config.proxyToken) {
			problems.push(
				`监听 ${config.listen.host} 暴露反代到网络,必须设置 proxyToken(≥16 字符),否则任何人都能消耗你的额度`,
			);
		}
		if (!config.uiPassword) {
			problems.push(
				`监听 ${config.listen.host} 时必须设置 uiPassword(≥9 字符)保护控制台`,
			);
		}
	}
	return problems;
}

export class FileStore {
	private readonly writes = new Map<string, Promise<void>>();

	constructor(readonly dir: string) {}

	private path(name: string): string {
		return join(this.dir, name);
	}

	async read<T>(name: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
		try {
			const text = await Bun.file(this.path(name)).text();
			const parsed = schema.safeParse(JSON.parse(text));
			return parsed.success ? parsed.data : fallback;
		} catch {
			return fallback;
		}
	}

	/** 同一文件串行原子写,避免并发 rename 覆盖或共享临时文件。 */
	write(name: string, data: unknown): Promise<void> {
		const text = JSON.stringify(data, null, 2);
		const previous = this.writes.get(name) ?? Promise.resolve();
		const pending = previous
			.catch(() => undefined)
			.then(() => this.writeFile(name, text));
		this.writes.set(name, pending);
		return pending.finally(() => {
			if (this.writes.get(name) === pending) this.writes.delete(name);
		});
	}

	private async writeFile(name: string, text: string): Promise<void> {
		const { mkdir, rename, chmod } = await import("node:fs/promises");
		await mkdir(this.dir, { recursive: true });
		const target = this.path(name);
		const tmp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
		await Bun.write(tmp, text);
		if (process.platform !== "win32") await chmod(tmp, 0o600);
		await rename(tmp, target);
	}
}

export async function loadConfig(store: FileStore): Promise<AppConfig> {
	return store.read("config.json", ConfigSchema, ConfigSchema.parse({}));
}

export async function loadState(store: FileStore): Promise<AppState> {
	return store.read("state.json", StateSchema, StateSchema.parse({}));
}

export async function loadCredentials(store: FileStore): Promise<Credentials> {
	return store.read("credentials.json", CredentialsSchema, {});
}
