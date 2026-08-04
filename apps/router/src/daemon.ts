import {
	AIHubApiError,
	MODE_WEIGHTS,
	type AIHubClient,
	type CircuitBreaker,
	type Decision,
	type Evaluation,
	type ExcludeReason,
	type GroupStat,
	type LocalObservationStore,
	type Platform,
	type RouteState,
	type ScoredCandidate,
	type ScoringOptions,
	decide,
	evaluate,
	mergeProviderLatencies,
} from "@aihub-auto/core";
import { randomUUID } from "node:crypto";
import type { AppConfig, AppState, Credentials } from "./config.ts";
import type { ActiveKey, RouteExecutor } from "./executor.ts";
import type { AuditLog, Logger } from "./logger.ts";
import {
	hashIdentity,
	stableUnitInterval,
	type SessionAffinity,
} from "./session.ts";
import type { SingleKeyGate, TrafficTracker } from "./traffic.ts";

export interface DaemonDeps {
	config: AppConfig;
	state: AppState;
	credentials: Credentials;
	client: AIHubClient;
	executor: RouteExecutor;
	breaker: CircuitBreaker;
	observations: LocalObservationStore;
	affinity: SessionAffinity;
	traffic: TrafficTracker;
	singleKeyGate: SingleKeyGate;
	logger: Logger;
	audit: AuditLog;
	persistState: () => Promise<void>;
	persistStateSoon: () => void;
	persistCredentials: () => Promise<void>;
}

export interface RoundResult {
	platform: Platform;
	evaluation: Evaluation;
	decision: Decision;
	executed: boolean;
	stale: boolean;
}

export interface RouteRequest {
	sessionKey?: string;
	model?: string;
	preferredGroupId?: number;
	cacheEvidence?: boolean;
	continuity?: boolean;
	/** sub2api 来源组;选择其独立 mode/priceBand。 */
	sourceGroup?: string;
	/** false 表示并发旧请求只可自选备用组,不得覆盖更新的会话主绑定。 */
	updateBinding?: boolean;
	failedGroupIds?: readonly number[];
}

export type LowestPriceStatus =
	| "ready"
	| "unauthenticated"
	| "unavailable"
	| "stale";

export interface LowestPrice {
	status: LowestPriceStatus;
	lowestRate: number | null;
	groupId: number | null;
}

export interface LowestPrices {
	at: number;
	default: LowestPrice;
	groups: Record<string, LowestPrice>;
}

type AccountDataStatus = "ready" | "unauthenticated" | "unavailable";

/** 公开统计控制面 + 请求本地 P2C/Peak-EWMA 路由面。 */
export class RouteDaemon {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private stopped = false;
	private readonly lastStats = new Map<
		Platform,
		{ items: GroupStat[]; at: number }
	>();
	private statsInflight:
		| Promise<{ items: GroupStat[]; stale: boolean }>
		| undefined;
	private allowedGroupIds: number[] | undefined;
	private userRates: Map<number, number> | undefined;
	private readonly routeLocks = new Map<
		string,
		Promise<ActiveKey | undefined>
	>();
	private singleRoute: Promise<unknown> = Promise.resolve();
	private controlMutation: Promise<unknown> = Promise.resolve();
	needsReauth = false;
	lastRound: RoundResult | undefined;

	constructor(private readonly deps: DaemonDeps) {}

	async fetchStats(
		platform: Platform,
	): Promise<{ items: GroupStat[]; stale: boolean }> {
		if (this.statsInflight) return this.statsInflight;
		const pending = (async () => {
			try {
				const [page, providers] = await Promise.all([
					this.deps.client.getUsageStats({
						platform,
						samples: this.deps.config.samples,
					}),
					this.deps.client.getProviderLatencyStats(platform).catch((err) => {
						this.deps.logger.debug(
							`provider TTFT 拉取失败(${platform}),回退 usage-stats:${err instanceof Error ? err.message : ""}`,
						);
						return new Map();
					}),
				]);
				const items = mergeProviderLatencies(page.items, providers);
				this.lastStats.set(platform, { items, at: Date.now() });
				return { items, stale: false };
			} catch (err) {
				const cached = this.lastStats.get(platform);
				this.deps.logger.warn(
					`usage-stats 拉取失败(${platform}),${cached ? "使用上轮缓存" : "无缓存可用"}:${err instanceof Error ? err.message : ""}`,
				);
				return { items: cached?.items ?? [], stale: true };
			}
		})();
		this.statsInflight = pending;
		return pending.finally(() => {
			if (this.statsInflight === pending) this.statsInflight = undefined;
		});
	}

	private async refreshAccountData(): Promise<AccountDataStatus> {
		if (!this.deps.credentials.accessToken) return "unauthenticated";
		const [groups, rates] = await Promise.allSettled([
			this.deps.client.getAvailableGroups(),
			this.deps.client.getUserGroupRates(),
		]);
		if (groups.status === "fulfilled") {
			this.allowedGroupIds = groups.value
				.filter((group) => !group.platform || group.platform === "openai")
				.map((group) => group.id)
				.filter((id) => Number.isInteger(id) && id > 0);
		}
		if (rates.status === "fulfilled") this.userRates = rates.value;
		if (groups.status === "fulfilled" && rates.status === "fulfilled") {
			return "ready";
		}
		return [groups, rates].some(
			(result) =>
				result.status === "rejected" &&
				result.reason instanceof AIHubApiError &&
				result.reason.status === 401,
		)
			? "unauthenticated"
			: "unavailable";
	}

	private sourcePolicy(
		sourceGroup?: string,
	): Pick<ScoringOptions, "mode" | "priceBand"> {
		const config = this.deps.config;
		const policy = sourceGroup ? config.groups[sourceGroup] : undefined;
		return {
			mode: policy?.mode ?? config.mode,
			priceBand: { ...config.priceBand, ...policy?.priceBand },
		};
	}

	async lowestPrices(): Promise<LowestPrices> {
		const at = Date.now();
		const sourceGroups = Object.keys(this.deps.config.groups);
		const unavailable = (
			status: Exclude<LowestPriceStatus, "ready">,
		): LowestPrice => ({ status, lowestRate: null, groupId: null });
		const unavailableSnapshot = (
			status: Exclude<LowestPriceStatus, "ready">,
		): LowestPrices => ({
			at,
			default: unavailable(status),
			groups: Object.fromEntries(
				sourceGroups.map((group) => [group, unavailable(status)]),
			),
		});
		if (!this.deps.credentials.accessToken || this.needsReauth) {
			return unavailableSnapshot("unauthenticated");
		}

		const [{ items, stale }, accountData] = await Promise.all([
			this.fetchStats("openai"),
			this.refreshAccountData(),
		]);
		if (accountData !== "ready") return unavailableSnapshot(accountData);
		if (stale) return unavailableSnapshot("stale");

		const priceFor = (sourceGroup?: string): LowestPrice => {
			const evaluation = this.evaluate(items, at, [], false, sourceGroup);
			const candidate = [...evaluation.eligible, ...evaluation.standby].reduce<
				ScoredCandidate | undefined
			>(
				(best, current) =>
					!best ||
					current.effectiveRate < best.effectiveRate ||
					(current.effectiveRate === best.effectiveRate &&
						current.stat.groupId < best.stat.groupId)
						? current
						: best,
				undefined,
			);
			return candidate
				? {
						status: "ready",
						lowestRate: candidate.effectiveRate,
						groupId: candidate.stat.groupId,
					}
				: unavailable("unavailable");
		};
		return {
			at,
			default: priceFor(),
			groups: Object.fromEntries(
				sourceGroups.map((group) => [group, priceFor(group)]),
			),
		};
	}

	private breakerGroupIds(now: number, allowHalfOpen: boolean): number[] {
		return this.deps.breaker
			.snapshot(now)
			.filter(
				(entry) =>
					entry.state === "open" ||
					(!allowHalfOpen && entry.state === "half-open"),
			)
			.map((entry) => entry.groupId);
	}

	scoringOptions(
		platform: Platform,
		now: number,
		extraBlacklist: readonly number[] = [],
		allowHalfOpen = false,
		sourceGroup?: string,
	): ScoringOptions {
		const config = this.deps.config;
		const policy = this.sourcePolicy(sourceGroup);
		return {
			mode: policy.mode,
			priceBand: policy.priceBand,
			blacklist: [...config.blacklist, ...extraBlacklist],
			circuitOpenGroupIds: this.breakerGroupIds(now, allowHalfOpen),
			economyPolicy: config.economyPolicy,
			allowedGroupIds: this.allowedGroupIds,
			errorRateCap: config.errorRateCap,
			platform,
			now,
		};
	}

	private evaluate(
		items: GroupStat[],
		now: number,
		extraBlacklist: readonly number[] = [],
		allowHalfOpen = false,
		sourceGroup?: string,
	): Evaluation {
		return evaluate(
			items,
			this.scoringOptions(
				"openai",
				now,
				extraBlacklist,
				allowHalfOpen,
				sourceGroup,
			),
			this.deps.observations.asMap(now),
			this.userRates,
		);
	}

	/** 仅强无效原因可越过会话软保护;省钱层备用组始终保留。 */
	private forceReclaimablePoolGroupIds(
		items: readonly GroupStat[],
		evaluation: Evaluation,
		statsStale: boolean,
	): Set<number> {
		const forceReasons = new Set([
			"platform_mismatch",
			"unavailable_group",
			"invalid_rate",
			"price_band",
			"blacklisted",
			"invalid_latency",
			"local_error_rate",
		]);
		if (Object.keys(this.deps.config.groups).length > 0) {
			forceReasons.delete("price_band");
		}
		const groupIds = new Set(
			evaluation.excluded
				.filter((candidate) => forceReasons.has(candidate.excludeReason))
				.map((candidate) => candidate.stat.groupId),
		);
		// 拉取成功的最新统计中已不存在的历史组没有复用价值;拉取失败时不猜测。
		if (!statsStale) {
			const latestGroupIds = new Set(items.map((item) => item.groupId));
			for (const groupId of Object.keys(this.deps.state.pool).map(Number)) {
				if (!latestGroupIds.has(groupId)) groupIds.add(groupId);
			}
		}
		return groupIds;
	}

	/** 公开统计轮:维护默认组并预热它的 Key;已绑定会话不会随之迁移。 */
	runOnce(opts?: {
		dryRun?: boolean;
		platform?: Platform;
	}): Promise<RoundResult> {
		return this.serializeControlMutation(() => this.runOnceLocked(opts));
	}

	/** 与守护轮串行执行其他控制面变更。 */
	runControlMutation<T>(fn: () => Promise<T>): Promise<T> {
		return this.serializeControlMutation(fn);
	}

	/** 锁 revision、当前配置资格检查与持久化在同一控制事务内完成。 */
	updateManualLock(
		groupId: number | null,
		expectedRevision: number,
	): Promise<
		| { updated: true; lock: AppState["manualLock"] }
		| {
				updated: false;
				lock: AppState["manualLock"];
				conflict: "revision" | "not_found" | "ineligible";
				reason?: ExcludeReason;
		  }
	> {
		return this.serializeControlMutation(async () => {
			const current = this.deps.state.manualLock;
			if (current.revision !== expectedRevision) {
				return {
					updated: false as const,
					lock: { ...current },
					conflict: "revision" as const,
				};
			}
			if (current.groupId === groupId) {
				return { updated: true as const, lock: { ...current } };
			}
			if (groupId !== null) {
				await this.refreshAccountData();
				const items = await this.routingItems();
				const target = items.find((item) => item.groupId === groupId);
				if (!target) {
					return {
						updated: false as const,
						lock: { ...current },
						conflict: "not_found" as const,
					};
				}
				const checked = evaluate(
					[target],
					{
						...this.scoringOptions("openai", Date.now(), [], true),
						mode: "balanced",
					},
					this.deps.observations.asMap(),
					this.userRates,
				);
				if (
					!checked.eligible.some((candidate) =>
						Number.isFinite(candidate.score),
					)
				) {
					return {
						updated: false as const,
						lock: { ...current },
						conflict: "ineligible" as const,
						reason: checked.excluded[0]?.excludeReason,
					};
				}
			}
			const lock = { groupId, revision: current.revision + 1 };
			this.deps.state.manualLock = lock;
			await this.deps.persistState();
			return { updated: true as const, lock: { ...lock } };
		});
	}

	private async runOnceLocked(opts?: {
		dryRun?: boolean;
		platform?: Platform;
	}): Promise<RoundResult> {
		const now = Date.now();
		const platform = opts?.platform ?? "openai";
		const [{ items, stale }] = await Promise.all([
			this.fetchStats(platform),
			this.refreshAccountData(),
		]);
		const evaluation = this.evaluate(items, now);
		const routeState: RouteState = {
			currentGroupId: this.deps.state.currentGroupId,
			lastSwitchAt: this.deps.state.lastSwitchAt,
			pendingSwitch: this.deps.state.pendingSwitch,
		};
		const lockedCandidate = this.manualLockCandidate(items, new Set(), now);
		const decision: Decision = lockedCandidate
			? {
					targetGroupId: lockedCandidate.stat.groupId,
					shouldSwitch:
						routeState.currentGroupId !== lockedCandidate.stat.groupId,
					reason: "manual_lock",
					targetScore: lockedCandidate.score,
					effectiveThreshold: 0,
					nextState:
						routeState.currentGroupId === lockedCandidate.stat.groupId
							? { ...routeState, pendingSwitch: undefined }
							: {
									currentGroupId: lockedCandidate.stat.groupId,
									lastSwitchAt: now,
									pendingSwitch: undefined,
								},
				}
			: decide(
					evaluation,
					routeState,
					this.deps.config.decision,
					this.deps.traffic.snapshot(now),
					now,
				);

		let executed = false;
		if (
			!opts?.dryRun &&
			decision.shouldSwitch &&
			decision.targetGroupId !== undefined
		) {
			const releaseSingleKey =
				this.deps.config.keyMode === "single"
					? await this.deps.singleKeyGate.acquire()
					: undefined;
			try {
				await this.deps.executor.switchTo(decision.targetGroupId);
				executed = true;
				this.deps.state.lastSwitchAt = decision.nextState.lastSwitchAt;
				this.deps.state.pendingSwitch = decision.nextState.pendingSwitch;
			} catch (err) {
				this.deps.logger.error(
					`切换执行失败:${err instanceof Error ? err.message : String(err)}`,
				);
			} finally {
				releaseSingleKey?.();
			}
		} else if (!opts?.dryRun) {
			this.deps.state.pendingSwitch = decision.nextState.pendingSwitch;
		}
		if (!opts?.dryRun) {
			this.deps.state.breaker = this.deps.breaker.toJSON();
			this.deps.state.observations = this.deps.observations.toJSON();
			await this.deps.persistState();
			await this.deps.executor.trimPool(
				this.forceReclaimablePoolGroupIds(items, evaluation, stale),
			);
		}

		await this.deps.audit.append({
			platform,
			stale,
			decision: {
				reason: decision.reason,
				shouldSwitch: decision.shouldSwitch,
				target: decision.targetGroupId,
				advantage: decision.advantage,
				threshold: decision.effectiveThreshold,
			},
			candidates: evaluation.eligible.map((candidate) => ({
				group: candidate.stat.groupId,
				code: candidate.stat.code,
				rate: candidate.effectiveRate,
				userTtft: candidate.userTtftMs
					? Math.round(candidate.userTtftMs)
					: undefined,
				userSamples: candidate.userSampleCount,
				cloudProbeTtft: candidate.cloudProbeTtftMs
					? Math.round(candidate.cloudProbeTtftMs)
					: undefined,
				upstreamTtft: candidate.upstreamTtftMs
					? Math.round(candidate.upstreamTtftMs)
					: undefined,
				localTtft: candidate.localTtftMs
					? Math.round(candidate.localTtftMs)
					: undefined,
				ttft: Math.round(candidate.blendedTtftMs),
				conservative: Math.round(candidate.conservativeLatencyMs),
				confidence: Number(candidate.confidence.toFixed(3)),
				successRate: Number(candidate.successRate.toFixed(3)),
				outcomeSamples: candidate.outcomeSampleCount,
				premium: Number.isFinite(candidate.premium)
					? Number(candidate.premium.toFixed(3))
					: "inf",
				score: Number.isFinite(candidate.score)
					? Number(candidate.score.toFixed(4))
					: "-inf",
			})),
			standby: evaluation.standby.map((candidate) => ({
				group: candidate.stat.groupId,
				rate: candidate.effectiveRate,
				conservative: Math.round(candidate.conservativeLatencyMs),
			})),
			excluded: evaluation.excluded.map((candidate) => ({
				group: candidate.stat.groupId,
				reason: candidate.excludeReason,
			})),
		});

		const result: RoundResult = {
			platform,
			evaluation,
			decision,
			executed,
			stale,
		};
		this.lastRound = result;
		return result;
	}

	/** 请求本地路由;同一会话的选择/迁移串行化,其他会话互不影响。 */
	async route(request: RouteRequest): Promise<ActiveKey | undefined> {
		if (this.deps.config.keyMode === "single") {
			const pending = this.singleRoute
				.catch(() => undefined)
				.then(() => this.routeSingle(request));
			this.singleRoute = pending;
			return pending;
		}
		if (!request.sessionKey) return this.routePool(request);
		const previous =
			this.routeLocks.get(request.sessionKey) ?? Promise.resolve(undefined);
		const pending = previous
			.catch(() => undefined)
			.then(() => this.routePool(request));
		this.routeLocks.set(request.sessionKey, pending);
		return pending.finally(() => {
			if (this.routeLocks.get(request.sessionKey!) === pending) {
				this.routeLocks.delete(request.sessionKey!);
			}
		});
	}

	private async routeSingle(
		request: RouteRequest,
	): Promise<ActiveKey | undefined> {
		const now = Date.now();
		const items = await this.routingItems();
		const blocked = new Set(request.failedGroupIds ?? []);
		for (const groupId of this.modelBlockedGroupIds(request.model, now)) {
			blocked.add(groupId);
		}
		const current = this.deps.executor.currentKey();
		const lockedGroupId = this.deps.state.manualLock.groupId;
		if (
			lockedGroupId !== null &&
			!blocked.has(lockedGroupId) &&
			this.hardEligible(
				lockedGroupId,
				items,
				blocked,
				now,
				request.sourceGroup,
			) &&
			this.deps.breaker.allowRequest(lockedGroupId, now)
		) {
			if (current?.groupId === lockedGroupId) return current;
			try {
				return await this.deps.executor.switchTo(lockedGroupId);
			} catch (err) {
				this.deps.breaker.releaseRequest(lockedGroupId, now);
				throw err;
			}
		}
		if (
			current &&
			this.hardEligible(
				current.groupId,
				items,
				blocked,
				now,
				request.sourceGroup,
			) &&
			this.deps.breaker.allowRequest(current.groupId, now)
		) {
			return current;
		}

		for (;;) {
			const evaluation = this.evaluate(
				items,
				now,
				[...blocked],
				true,
				request.sourceGroup,
			);
			const target = evaluation.eligible.find((candidate) =>
				Number.isFinite(candidate.score),
			);
			if (!target) return undefined;
			if (!this.deps.breaker.allowRequest(target.stat.groupId, now)) {
				blocked.add(target.stat.groupId);
				continue;
			}
			try {
				return await this.deps.executor.switchTo(target.stat.groupId);
			} catch (err) {
				this.deps.breaker.releaseRequest(target.stat.groupId, now);
				throw err;
			}
		}
	}

	private async routePool(
		request: RouteRequest,
	): Promise<ActiveKey | undefined> {
		const now = Date.now();
		const items = await this.routingItems();
		const failed = new Set(request.failedGroupIds ?? []);
		for (const groupId of this.modelBlockedGroupIds(request.model, now)) {
			failed.add(groupId);
		}
		const cacheLikelyHot = Boolean(
			request.sessionKey &&
				request.cacheEvidence &&
				this.deps.affinity.cacheLikelyHot(
					request.sessionKey,
					this.deps.config.decision.cacheIdleMs,
					now,
				),
		);
		const previousGroupId = request.sessionKey
			? this.deps.affinity.resolve(request.sessionKey, now)
			: undefined;
		const affinityGroupId = request.preferredGroupId ?? previousGroupId;
		const preserveBinding = Boolean(request.continuity || cacheLikelyHot);

		if (
			preserveBinding &&
			affinityGroupId !== undefined &&
			this.hardEligible(
				affinityGroupId,
				items,
				failed,
				now,
				request.sourceGroup,
			) &&
			this.deps.breaker.allowRequest(affinityGroupId, now)
		) {
			return this.prepareRequestKey(
				affinityGroupId,
				request,
				previousGroupId,
				now,
			);
		}

		const lockedGroupId = this.deps.state.manualLock.groupId;
		if (
			lockedGroupId !== null &&
			!failed.has(lockedGroupId) &&
			this.hardEligible(
				lockedGroupId,
				items,
				failed,
				now,
				request.sourceGroup,
			) &&
			this.deps.breaker.allowRequest(lockedGroupId, now)
		) {
			return this.prepareRequestKey(
				lockedGroupId,
				request,
				previousGroupId,
				now,
			);
		}

		const blocked = new Set(failed);
		const probe = this.halfOpenProbe(
			items,
			blocked,
			now,
			request.sessionKey,
			request.sourceGroup,
		);
		if (probe !== undefined && this.deps.breaker.allowRequest(probe, now)) {
			return this.prepareRequestKey(probe, request, previousGroupId, now);
		}

		let target: ScoredCandidate | undefined;
		for (;;) {
			const evaluation = this.evaluate(
				items,
				now,
				[...blocked],
				false,
				request.sourceGroup,
			);
			target = this.selectP2c(
				evaluation,
				request.sessionKey ?? randomUUID(),
				this.sourcePolicy(request.sourceGroup).mode,
			);
			if (!target) break;
			if (this.deps.breaker.allowRequest(target.stat.groupId, now)) break;
			blocked.add(target.stat.groupId);
		}

		let groupId = target?.stat.groupId;
		if (groupId === undefined) {
			const fallback = this.deps.state.currentGroupId;
			if (
				fallback === undefined ||
				!this.hardEligible(
					fallback,
					items,
					blocked,
					now,
					request.sourceGroup,
				) ||
				!this.deps.breaker.allowRequest(fallback, now)
			) {
				return undefined;
			}
			groupId = fallback;
		}
		return this.prepareRequestKey(groupId, request, previousGroupId, now);
	}

	private async routingItems(): Promise<GroupStat[]> {
		const cached = this.lastStats.get("openai")?.items;
		if (cached?.length) return cached;
		return (await this.fetchStats("openai")).items;
	}

	private hardEligible(
		groupId: number,
		items: readonly GroupStat[],
		blocked: ReadonlySet<number>,
		now: number,
		sourceGroup?: string,
		probe = false,
	): boolean {
		const observations = this.deps.observations.asMap(now);
		if (probe) {
			const observation = observations.get(groupId);
			if (observation) {
				observations.set(groupId, {
					...observation,
					errorRate: 0,
					outcomeConfidence: 0,
				});
			}
		}
		// 连续会话必须按上游状态所在组完成;这里仅检查硬约束,不套用 economy 的排序层。
		return evaluate(
			[...items],
			{
				...this.scoringOptions("openai", now, [...blocked], true, sourceGroup),
				mode: "balanced",
			},
			observations,
			this.userRates,
		).eligible.some((candidate) => candidate.stat.groupId === groupId);
	}

	private manualLockCandidate(
		items: readonly GroupStat[],
		blocked: ReadonlySet<number>,
		now: number,
	): ScoredCandidate | undefined {
		const groupId = this.deps.state.manualLock.groupId;
		if (groupId === null || blocked.has(groupId)) return undefined;
		const target = items.find((item) => item.groupId === groupId);
		if (!target) return undefined;
		return evaluate(
			[target],
			{
				...this.scoringOptions("openai", now, [...blocked], true),
				mode: "balanced",
			},
			this.deps.observations.asMap(now),
			this.userRates,
		).eligible.find(
			(candidate) =>
				candidate.stat.groupId === groupId && Number.isFinite(candidate.score),
		);
	}

	private async prepareRequestKey(
		groupId: number,
		request: RouteRequest,
		_previousGroupId: number | undefined,
		now: number,
	): Promise<ActiveKey> {
		const releasePending = this.deps.traffic.reserve(groupId);
		let key: ActiveKey;
		try {
			key = await this.deps.executor.acquireKey(groupId);
		} catch (err) {
			releasePending();
			this.deps.breaker.releaseRequest(groupId, now);
			throw err;
		}
		const releaseKey = key.release;
		const release = () => {
			releaseKey?.();
			releasePending();
		};
		if (
			!request.sessionKey ||
			request.updateBinding === false ||
			request.preferredGroupId !== undefined
		) {
			return { ...key, release };
		}
		const binding = this.deps.affinity.bindForRoute(
			request.sessionKey,
			groupId,
			now,
		);
		return {
			...key,
			release,
			rollback: binding.rollback,
			invalidate: binding.invalidate,
			isCurrentBinding: binding.isCurrent,
		};
	}

	private selectP2c(
		evaluation: Evaluation,
		seed: string,
		mode = this.deps.config.mode,
	): ScoredCandidate | undefined {
		// 请求调度使用显式池上限,不复用 Koishi 展示用的 scoreWindow。
		// 否则健康容量会在负载计算前被永久排除。
		const candidates = evaluation.eligible
			.filter((candidate) => Number.isFinite(candidate.score))
			.slice(0, this.deps.config.poolMaxGroups);
		if (candidates.length <= 1) return candidates[0];

		// 小池场景始终让静态最优组参加比较,再按会话稳定抽一个挑战者。
		// 空载不牺牲质量;最优组积压后仍能使用池内全部容量。
		const first = candidates[0]!;
		const secondIndex =
			1 +
			Math.floor(
				stableUnitInterval(`${seed}:p2c:challenger`) * (candidates.length - 1),
			);
		const second = candidates[secondIndex]!;
		const active = this.deps.traffic.snapshot().activeByGroup ?? {};
		const { latencyWeight } = MODE_WEIGHTS[mode];
		const adjustedScore = (candidate: ScoredCandidate): number => {
			const pending = active[String(candidate.stat.groupId)] ?? 0;
			// 静态评分与负载评分共享同一对数效用:
			// log(latency * (pending + 1)) = log(latency) + log(pending + 1)。
			return candidate.score - latencyWeight * Math.log(pending + 1);
		};
		const firstScore = adjustedScore(first);
		const secondScore = adjustedScore(second);
		if (firstScore !== secondScore)
			return firstScore > secondScore ? first : second;
		// 等权候选用会话哈希拆分,避免静态最优组在并发冷启动时形成热点。
		return stableUnitInterval(`${seed}:p2c:tie`) < 0.5 ? first : second;
	}

	private halfOpenProbe(
		items: readonly GroupStat[],
		blocked: ReadonlySet<number>,
		now: number,
		seed: string = randomUUID(),
		sourceGroup?: string,
	): number | undefined {
		const candidates = this.deps.breaker
			.snapshot(now)
			.filter(
				(entry) =>
					entry.state === "half-open" &&
					!blocked.has(entry.groupId) &&
					this.hardEligible(
						entry.groupId,
						items,
						blocked,
						now,
						sourceGroup,
						true,
					),
			)
			.sort(
				(left, right) =>
					stableUnitInterval(`${seed}:half-open:${left.groupId}`) -
					stableUnitInterval(`${seed}:half-open:${right.groupId}`),
			);
		return candidates[0]?.groupId;
	}

	private modelBlockedGroupIds(
		model: string | undefined,
		now: number,
	): number[] {
		if (!model) return [];
		const modelKey = hashIdentity(`v1:model:${model.toLowerCase()}`);
		const bucket = this.deps.state.modelBlocks[modelKey];
		if (!bucket) return [];
		const blocked: number[] = [];
		for (const [groupId, expiresAt] of Object.entries(bucket)) {
			if (expiresAt <= now) delete bucket[groupId];
			else blocked.push(Number(groupId));
		}
		if (Object.keys(bucket).length === 0)
			delete this.deps.state.modelBlocks[modelKey];
		return blocked;
	}

	reportModelIncompatible(groupId: number, model: string): void {
		const modelKey = hashIdentity(`v1:model:${model.toLowerCase()}`);
		const bucket = (this.deps.state.modelBlocks[modelKey] ??= {});
		bucket[String(groupId)] = Date.now() + this.deps.config.sessionTtlMs;
		this.trimModelBlocks();
		this.deps.logger.info(
			`模型不兼容:group=${groupId} modelHash=${modelKey.slice(0, 8)}`,
		);
		this.deps.persistStateSoon();
	}

	reportModelSupported(groupId: number, model: string | undefined): void {
		if (!model) return;
		const modelKey = hashIdentity(`v1:model:${model.toLowerCase()}`);
		const bucket = this.deps.state.modelBlocks[modelKey];
		if (!bucket) return;
		delete bucket[String(groupId)];
		if (Object.keys(bucket).length === 0)
			delete this.deps.state.modelBlocks[modelKey];
		this.deps.persistStateSoon();
	}

	private trimModelBlocks(): void {
		const entries = Object.entries(this.deps.state.modelBlocks).flatMap(
			([modelKey, groups]) =>
				Object.entries(groups).map(([groupId, expiresAt]) => ({
					modelKey,
					groupId,
					expiresAt,
				})),
		);
		const extra = entries.length - this.deps.config.sessionMaxEntries;
		if (extra <= 0) return;
		for (const entry of entries
			.sort((left, right) => left.expiresAt - right.expiresAt)
			.slice(0, extra)) {
			delete this.deps.state.modelBlocks[entry.modelKey]?.[entry.groupId];
		}
	}

	modelBlockStats(now = Date.now()): { models: number; pairs: number } {
		for (const modelKey of Object.keys(this.deps.state.modelBlocks)) {
			const bucket = this.deps.state.modelBlocks[modelKey]!;
			for (const [groupId, expiresAt] of Object.entries(bucket)) {
				if (expiresAt <= now) delete bucket[groupId];
			}
			if (Object.keys(bucket).length === 0)
				delete this.deps.state.modelBlocks[modelKey];
		}
		return {
			models: Object.keys(this.deps.state.modelBlocks).length,
			pairs: Object.values(this.deps.state.modelBlocks).reduce(
				(sum, groups) => sum + Object.keys(groups).length,
				0,
			),
		};
	}

	private persistRuntimeStateSoon(): void {
		this.deps.state.breaker = this.deps.breaker.toJSON();
		this.deps.state.observations = this.deps.observations.toJSON();
		this.deps.persistStateSoon();
	}

	reportFailure(groupId: number): void {
		this.deps.breaker.recordFailure(groupId);
		this.persistRuntimeStateSoon();
	}

	reportSuccess(groupId: number): void {
		this.deps.breaker.recordSuccess(groupId);
		this.persistRuntimeStateSoon();
	}

	reportNeutral(groupId: number): void {
		this.deps.breaker.releaseRequest(groupId);
		this.persistRuntimeStateSoon();
	}

	private serializeControlMutation<T>(fn: () => Promise<T>): Promise<T> {
		const current = this.controlMutation.then(fn, fn);
		this.controlMutation = current.then(
			() => undefined,
			() => undefined,
		);
		return current;
	}

	/** 旧调用兼容;pool 下只为本次请求选择备用组。 */
	async failover(
		failedGroupIds: number[],
		_platform: Platform,
	): Promise<ActiveKey | undefined> {
		return this.route({ failedGroupIds });
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.stopped = false;
		const loop = async () => {
			if (this.stopped) return;
			try {
				await this.runOnce();
			} catch (err) {
				this.deps.logger.error(
					`路由轮失败:${err instanceof Error ? err.message : String(err)}`,
				);
			}
			if (!this.stopped) {
				this.timer = setTimeout(loop, this.deps.config.pollIntervalMs);
			}
		};
		this.timer = setTimeout(loop, 0);
	}

	stop(): void {
		this.stopped = true;
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
	}
}
