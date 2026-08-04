import { createHash } from "node:crypto";
import type { AppState } from "./config.ts";

const MAX_FINGERPRINT_CHARS = 64 * 1024;
const PRUNE_INTERVAL_MS = 60_000;

export interface RequestRoutingContext {
	model?: string;
	sessionKey?: string;
	/** previous_response_id 实际产生于该组;并发 Responses 分支必须优先回到这里。 */
	preferredGroupId?: number;
	/** prompt_cache_key 或稳定提示前缀,可用于判断软缓存亲和。 */
	cacheEvidence?: boolean;
	/** 显式会话或服务端 conversation/response 链,切组可能破坏状态连续性。 */
	continuity?: boolean;
}

export interface ResponseAffinity {
	sessionKey: string;
	groupId?: number;
}

export interface RouteBinding {
	rollback: () => void;
	invalidate: () => void;
	isCurrent: () => boolean;
}

export function hashIdentity(value: string): string {
	return createHash("sha256").update(value).digest("base64url");
}

/** 由稳定摘要生成 [0,1),用于可复现的探索/平局打散。 */
export function stableUnitInterval(value: string): number {
	const hex = createHash("sha256").update(value).digest("hex").slice(0, 13);
	return Number.parseInt(hex, 16) / 0x10_0000_0000_0000;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringId(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	const object = record(value);
	return typeof object?.["id"] === "string" && object["id"].length > 0
		? object["id"]
		: undefined;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	const object = record(value);
	if (!object) return value;
	return Object.fromEntries(
		Object.keys(object)
			.sort()
			.map((key) => [key, canonical(object[key])]),
	);
}

function stablePrefix(
	body: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const messages = Array.isArray(body["messages"])
		? body["messages"]
		: Array.isArray(body["input"])
			? body["input"]
			: undefined;
	const prefix: unknown[] = [];
	if (messages) {
		for (const message of messages) {
			prefix.push(message);
			const role = record(message)?.["role"];
			if (role !== "system" && role !== "developer") break;
		}
	} else if (typeof body["input"] === "string" && body["input"].length > 0) {
		prefix.push(body["input"]);
	}

	const fingerprint = {
		model: body["model"],
		instructions: body["instructions"],
		tools: body["tools"],
		prefix,
	};
	const hasPromptIdentity =
		body["instructions"] !== undefined ||
		body["tools"] !== undefined ||
		prefix.length > 0;
	return hasPromptIdentity ? fingerprint : undefined;
}

function parseBody(
	body: ArrayBuffer | undefined,
): Record<string, unknown> | undefined {
	if (!body || body.byteLength === 0) return undefined;
	try {
		return record(JSON.parse(new TextDecoder().decode(body)));
	} catch {
		return undefined;
	}
}

/**
 * 会话标识优先级:显式头 -> conversation -> previous_response_id 别名 ->
 * prompt_cache_key -> 稳定提示前缀。模型始终参与命名空间,结果为不可逆摘要。
 */
export function requestRoutingContext(
	path: string,
	headers: Headers,
	body: ArrayBuffer | undefined,
	resolveResponse: (responseId: string) => ResponseAffinity | undefined,
	sourceGroup?: string,
): RequestRoutingContext {
	const parsed = parseBody(body);
	const model =
		typeof parsed?.["model"] === "string" && parsed["model"].trim().length > 0
			? parsed["model"].trim()
			: undefined;
	// 无来源头时保留既有 hash，已配置来源组时隔离它们的缓存亲和。
	const namespace = sourceGroup
		? `sub2api:${sourceGroup}:${model ?? ""}`
		: (model ?? "");
	const promptCacheKey = parsed
		? stringId(parsed["prompt_cache_key"])
		: undefined;
	const prefix = parsed ? stablePrefix(parsed) : undefined;
	const cacheEvidence = Boolean(promptCacheKey || prefix);

	const explicit = headers.get("x-aihub-auto-session")?.trim();
	if (explicit) {
		return {
			model,
			sessionKey: hashIdentity(`v1:header:${namespace}:${explicit}`),
			cacheEvidence,
			continuity: true,
		};
	}
	if (!parsed) return { model };

	const conversation = stringId(parsed["conversation"]);
	if (conversation) {
		return {
			model,
			sessionKey: hashIdentity(`v1:conversation:${namespace}:${conversation}`),
			cacheEvidence,
			continuity: true,
		};
	}

	const previousResponseId = stringId(parsed["previous_response_id"]);
	if (previousResponseId) {
		const affinity = resolveResponse(previousResponseId);
		return {
			model,
			sessionKey:
				affinity?.sessionKey ??
				hashIdentity(`v1:previous-response:${namespace}:${previousResponseId}`),
			preferredGroupId: affinity?.groupId,
			cacheEvidence,
			continuity: true,
		};
	}

	if (promptCacheKey) {
		return {
			model,
			sessionKey: hashIdentity(
				`v1:prompt-cache:${namespace}:${promptCacheKey}`,
			),
			cacheEvidence: true,
		};
	}

	if (!prefix) return { model };
	const api = path.includes("/responses") ? "responses" : "chat";
	const serialized = JSON.stringify(
		canonical({ v: 1, api, sourceGroup, ...prefix }),
	).slice(0, MAX_FINGERPRINT_CHARS);
	return { model, sessionKey: hashIdentity(serialized), cacheEvidence: true };
}

export function requestSessionKey(
	path: string,
	headers: Headers,
	body: ArrayBuffer | undefined,
	resolveResponse: (responseId: string) => ResponseAffinity | undefined,
	sourceGroup?: string,
): string | undefined {
	return requestRoutingContext(
		path,
		headers,
		body,
		resolveResponse,
		sourceGroup,
	).sessionKey;
}

export function findResponseId(text: string): string | undefined {
	return text.match(/"id"\s*:\s*"(resp_[A-Za-z0-9_-]+)"/)?.[1];
}

export class SessionAffinity {
	private lastPruneAt = 0;
	/** 进程内全局单调版本;不会随会话 churn 增长内存。 */
	private revision = 0;

	constructor(
		private readonly state: Pick<AppState, "sessions" | "responseAliases">,
		private readonly ttlMs: number,
		private readonly maxEntries: number,
		private readonly onChange: () => void = () => {},
	) {}

	resolve(sessionKey: string, now = Date.now()): number | undefined {
		this.pruneMaybe(now);
		const binding = this.state.sessions[sessionKey];
		if (!binding || now - binding.lastUsedAt > this.ttlMs) {
			if (binding) delete this.state.sessions[sessionKey];
			return undefined;
		}
		binding.lastUsedAt = now;
		this.onChange();
		return binding.groupId;
	}

	bind(sessionKey: string, groupId: number, now = Date.now()): boolean {
		const previous = this.state.sessions[sessionKey];
		const revision = this.nextRevision(previous?.revision);
		this.state.sessions[sessionKey] = { groupId, lastUsedAt: now, revision };
		this.onChange();
		this.pruneMaybe(now);
		return previous?.groupId !== groupId;
	}

	/**
	 * 为一次上游尝试声明绑定并返回版本化回滚。后续并发请求一旦声明了更新
	 * 版本,旧请求的回滚就会自动失效,不会清掉较新的成功路径。
	 */
	bindForRoute(
		sessionKey: string,
		groupId: number,
		now = Date.now(),
	): RouteBinding {
		const previous = this.state.sessions[sessionKey]
			? { ...this.state.sessions[sessionKey]! }
			: undefined;
		const revision = this.nextRevision(previous?.revision);
		this.state.sessions[sessionKey] =
			previous?.groupId === groupId
				? { ...previous, lastUsedAt: now, revision }
				: { groupId, lastUsedAt: now, revision };
		this.onChange();
		this.pruneMaybe(now);

		return {
			isCurrent: () => this.state.sessions[sessionKey]?.revision === revision,
			rollback: () => {
				const current = this.state.sessions[sessionKey];
				if (!current || current.revision !== revision) return;
				if (previous) {
					this.state.sessions[sessionKey] = {
						...previous,
						revision: this.nextRevision(revision),
					};
				} else {
					delete this.state.sessions[sessionKey];
				}
				this.onChange();
			},
			invalidate: () => {
				const current = this.state.sessions[sessionKey];
				if (!current || current.revision !== revision) return;
				delete this.state.sessions[sessionKey];
				this.onChange();
			},
		};
	}

	cacheLikelyHot(
		sessionKey: string,
		cacheIdleMs: number,
		now = Date.now(),
	): boolean {
		const binding = this.state.sessions[sessionKey];
		if (
			!binding ||
			now - binding.lastUsedAt > Math.min(cacheIdleMs, this.ttlMs)
		) {
			return false;
		}
		return binding.cacheStatus !== "miss";
	}

	recordCache(
		sessionKey: string,
		status: "hit" | "miss",
		now = Date.now(),
	): void {
		const binding = this.state.sessions[sessionKey];
		if (!binding) return;
		binding.cacheStatus = status;
		binding.cacheObservedAt = now;
		binding.revision = this.nextRevision(binding.revision);
		this.onChange();
	}

	/** 仅当绑定仍指向本次失败组时迁移,避免旧请求覆盖较新的故障转移。 */
	rebind(
		sessionKey: string,
		expectedGroupId: number,
		nextGroupId: number,
		now = Date.now(),
	): boolean {
		const current = this.state.sessions[sessionKey];
		if (!current || current.groupId !== expectedGroupId) return false;
		this.state.sessions[sessionKey] = {
			groupId: nextGroupId,
			lastUsedAt: now,
			revision: this.nextRevision(current.revision),
		};
		this.onChange();
		this.pruneMaybe(now);
		return true;
	}

	clear(sessionKey: string, expectedGroupId?: number): boolean {
		const current = this.state.sessions[sessionKey];
		if (
			!current ||
			(expectedGroupId !== undefined && current.groupId !== expectedGroupId)
		) {
			return false;
		}
		delete this.state.sessions[sessionKey];
		this.onChange();
		return true;
	}

	resolveResponse(
		responseId: string,
		now = Date.now(),
	): ResponseAffinity | undefined {
		this.pruneMaybe(now);
		const alias =
			this.state.responseAliases[hashIdentity(`response:${responseId}`)];
		if (!alias || now - alias.lastUsedAt > this.ttlMs) return undefined;
		alias.lastUsedAt = now;
		this.onChange();
		return { sessionKey: alias.sessionKey, groupId: alias.groupId };
	}

	bindResponse(
		responseId: string,
		sessionKey: string,
		groupId: number,
		now = Date.now(),
	): void {
		this.state.responseAliases[hashIdentity(`response:${responseId}`)] = {
			sessionKey,
			groupId,
			lastUsedAt: now,
		};
		this.onChange();
		this.pruneMaybe(now);
	}

	/** 托管 Key 被强制回收后,同步清除其主会话和 Responses 分支亲和。 */
	forgetGroup(groupId: number): { sessions: number; aliases: number } {
		let sessions = 0;
		let aliases = 0;
		for (const [key, binding] of Object.entries(this.state.sessions)) {
			if (binding.groupId !== groupId) continue;
			delete this.state.sessions[key];
			sessions++;
		}
		for (const [key, alias] of Object.entries(this.state.responseAliases)) {
			if (alias.groupId !== groupId) continue;
			delete this.state.responseAliases[key];
			aliases++;
		}
		if (sessions > 0 || aliases > 0) this.onChange();
		return { sessions, aliases };
	}

	/**
	 * 仅近期亲和需要保留池 Key 以复用前缀缓存。较老的会话/Responses
	 * 记录仍保留到 TTL 以维持上游连续性,需要时再自动创建对应 Key。
	 */
	protectedGroupIds(cacheIdleMs: number, now = Date.now()): Set<number> {
		this.prune(now);
		const windowMs = Math.min(Math.max(cacheIdleMs, 0), this.ttlMs);
		const recent = (lastUsedAt: number) => now - lastUsedAt <= windowMs;
		return new Set([
			...Object.values(this.state.sessions)
				.filter((binding) => recent(binding.lastUsedAt))
				.map((binding) => binding.groupId),
			...Object.values(this.state.responseAliases).flatMap((alias) =>
				alias.groupId === undefined || !recent(alias.lastUsedAt)
					? []
					: [alias.groupId],
			),
		]);
	}

	stats(now = Date.now()): {
		sessions: number;
		responseAliases: number;
		cacheHits: number;
		cacheMisses: number;
		byGroup: Record<string, number>;
		aliasesByGroup: Record<string, number>;
	} {
		this.prune(now);
		const byGroup: Record<string, number> = {};
		const aliasesByGroup: Record<string, number> = {};
		for (const binding of Object.values(this.state.sessions)) {
			const key = String(binding.groupId);
			byGroup[key] = (byGroup[key] ?? 0) + 1;
		}
		for (const alias of Object.values(this.state.responseAliases)) {
			if (alias.groupId === undefined) continue;
			const key = String(alias.groupId);
			aliasesByGroup[key] = (aliasesByGroup[key] ?? 0) + 1;
		}
		const bindings = Object.values(this.state.sessions);
		return {
			sessions: bindings.length,
			responseAliases: Object.keys(this.state.responseAliases).length,
			cacheHits: bindings.filter((binding) => binding.cacheStatus === "hit")
				.length,
			cacheMisses: bindings.filter((binding) => binding.cacheStatus === "miss")
				.length,
			byGroup,
			aliasesByGroup,
		};
	}

	prune(now = Date.now()): { sessions: number; aliases: number } {
		this.lastPruneAt = now;
		let sessions = 0;
		let aliases = 0;
		for (const [key, binding] of Object.entries(this.state.sessions)) {
			if (now - binding.lastUsedAt > this.ttlMs) {
				delete this.state.sessions[key];
				sessions++;
			}
		}
		for (const [key, alias] of Object.entries(this.state.responseAliases)) {
			if (now - alias.lastUsedAt > this.ttlMs) {
				delete this.state.responseAliases[key];
				aliases++;
			}
		}

		sessions += this.trimOldest(this.state.sessions, this.maxEntries);
		aliases += this.trimOldest(this.state.responseAliases, this.maxEntries * 2);
		if (sessions > 0 || aliases > 0) this.onChange();
		return { sessions, aliases };
	}

	private nextRevision(persisted?: number): number {
		this.revision = Math.max(this.revision, persisted ?? 0) + 1;
		return this.revision;
	}

	private pruneMaybe(now: number): void {
		if (
			now - this.lastPruneAt >= PRUNE_INTERVAL_MS ||
			Object.keys(this.state.sessions).length > this.maxEntries ||
			Object.keys(this.state.responseAliases).length > this.maxEntries * 2
		) {
			this.prune(now);
		}
	}

	private trimOldest<T extends { lastUsedAt: number }>(
		entries: Record<string, T>,
		limit: number,
	): number {
		const extra = Object.keys(entries).length - limit;
		if (extra <= 0) return 0;
		const victims = Object.entries(entries)
			.sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
			.slice(0, extra);
		for (const [key] of victims) delete entries[key];
		return victims.length;
	}
}
