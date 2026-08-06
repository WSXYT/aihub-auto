import type { LocalObservationStore, Platform } from "@aihub-auto/core";
import type { RouteRequest } from "./daemon.ts";
import type { ActiveKey } from "./executor.ts";
import type { Logger } from "./logger.ts";
import {
	findResponseId,
	requestRoutingContext,
	type SessionAffinity,
} from "./session.ts";
import type { SingleKeyGate, TrafficTracker } from "./traffic.ts";

export interface ProxyDeps {
	baseUrl: string;
	keyMode: "single" | "pool";
	route: (request: RouteRequest) => Promise<ActiveKey | undefined>;
	reportFailure: (groupId: number) => void;
	reportSuccess: (groupId: number) => void;
	reportNeutral: (groupId: number) => void;
	reportModelIncompatible: (groupId: number, model: string) => void;
	reportModelSupported: (groupId: number, model: string | undefined) => void;
	affinity: SessionAffinity;
	observations: LocalObservationStore;
	traffic: TrafficTracker;
	singleKeyGate: SingleKeyGate;
	logger: Logger;
	ttfbTimeoutMs: number;
	maxRetries?: number;
	/** 请求体缓冲上限(重试需要);超限直通不可重试 */
	maxBufferBytes?: number;
	proxyToken?: string;
	/** 每次请求读取,支持控制台热更新;空值时保留客户端 User-Agent。 */
	upstreamUserAgent?: () => string;
	fetch?: typeof globalThis.fetch;
}

const MAX_ERROR_BYTES = 16 * 1024;
const MAX_RESPONSE_ID_BYTES = 16 * 1024;
const MAX_USAGE_BYTES = 64 * 1024;
const LOCAL_RESPONSE_HEADER = "x-aihub-auto-local-response";

interface ByteReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(reason?: unknown): Promise<void>;
}

function isControllerClosedError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return (
		err.name === "TypeError" &&
		/controller is already closed|invalid state/i.test(err.message)
	);
}

function safeEnqueue(
	controller: ReadableStreamDefaultController<Uint8Array>,
	value: Uint8Array,
): boolean {
	try {
		controller.enqueue(value);
		return true;
	} catch (err) {
		if (isControllerClosedError(err)) return false;
		throw err;
	}
}

function safeClose(
	controller: ReadableStreamDefaultController<Uint8Array>,
): void {
	try {
		controller.close();
	} catch (err) {
		if (!isControllerClosedError(err)) throw err;
	}
}

async function bufferBodyWithinLimit(
	body: ReadableStream<Uint8Array>,
	limit: number,
): Promise<ArrayBuffer | undefined> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel("request body exceeds retry buffer").catch(() => {});
			return undefined;
		}
		chunks.push(value);
	}
	const buffered = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		buffered.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return buffered.buffer;
}

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
	"authorization",
	"x-api-key",
	LOCAL_RESPONSE_HEADER,
]);

export function detectPlatform(_path: string, _headers: Headers): Platform {
	return "openai";
}

/** /openai/v1/... -> /v1/...;原生 /v1/... 不变。 */
export function upstreamPath(path: string): string {
	const match = path.match(/^\/openai(\/.*)$/);
	return match ? match[1]! : path;
}

function upstreamFailure(status: number): boolean {
	return status === 429 || status >= 500;
}

function errorResponse(status: number, message: string): Response {
	return new Response(
		JSON.stringify({ error: { message, type: "aihub_auto_proxy" } }),
		{
			status,
			headers: {
				"Content-Type": "application/json",
				[LOCAL_RESPONSE_HEADER]: "1",
			},
		},
	);
}

export function proxyTokenAuthorized(
	req: Request,
	proxyToken?: string,
): boolean {
	if (!proxyToken) return true;
	const auth = req.headers.get("authorization") ?? "";
	const key = req.headers.get("x-api-key") ?? "";
	return auth === `Bearer ${proxyToken}` || key === proxyToken;
}

function downstreamHeaders(source: Headers, groupId: number): Headers {
	const headers = new Headers();
	source.forEach((value, name) => {
		const lower = name.toLowerCase();
		if (!HOP_BY_HOP.has(lower) && lower !== "content-encoding") {
			headers.set(name, value);
		}
	});
	headers.set("x-aihub-auto-group", String(groupId));
	return headers;
}

function upstreamErrorResponse(
	response: Response,
	groupId: number,
	message = `上游返回 HTTP ${response.status}(组 ${groupId})`,
): Response {
	const headers = downstreamHeaders(response.headers, groupId);
	headers.set("Content-Type", "application/json");
	headers.set(LOCAL_RESPONSE_HEADER, "1");
	return new Response(
		JSON.stringify({ error: { message, type: "upstream_error" } }),
		{
			status: response.status,
			statusText: response.statusText,
			headers,
		},
	);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function findCacheUsage(
	text: string,
): { cachedTokens: number; inputTokens?: number } | undefined {
	let cachedTokens: number | undefined;
	for (const match of text.matchAll(/"cached_tokens"\s*:\s*(\d+)/g)) {
		cachedTokens = Number(match[1]);
	}
	if (cachedTokens === undefined) return undefined;
	let inputTokens: number | undefined;
	for (const match of text.matchAll(
		/"(?:prompt_tokens|input_tokens)"\s*:\s*(\d+)/g,
	)) {
		inputTokens = Number(match[1]);
	}
	return { cachedTokens, inputTokens };
}

async function responsePrefix(
	response: Response,
	limit: number,
	timeoutMs = 250,
): Promise<string> {
	const reader = response.clone().body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	const deadline = Date.now() + timeoutMs;
	try {
		while (size < limit) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<{ done: true; value?: undefined }>(
				(resolve) => {
					timer = setTimeout(() => resolve({ done: true }), remaining);
				},
			);
			const result = await Promise.race([reader.read(), timeout]).finally(
				() => {
					if (timer !== undefined) clearTimeout(timer);
				},
			);
			if (result.done || !result.value) break;
			const chunk = result.value.subarray(0, Math.max(limit - size, 0));
			chunks.push(chunk);
			size += chunk.byteLength;
			if (chunk.byteLength < result.value.byteLength) break;
		}
	} finally {
		// A tee branch can wait for the original response forever; detection is best-effort.
		void reader.cancel().catch(() => {});
	}
	const joined = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(joined);
}

/** 上游余额不足信号(组级账单故障,应换组并记失败)。 */
const BILLING_ERROR_PATTERN =
	/insufficient[^"]{0,40}balance|billing_error|insufficient_quota|no\s+balance|out\s*of\s*(?:api\s*)?(?:credits|quota)|quota\s*exceeded|余额(?:不足|已用尽)|没有余额/i;

export async function isBillingErrorResponse(
	response: Response,
): Promise<boolean> {
	if (response.status !== 403) return false;
	const text = await responsePrefix(response, MAX_ERROR_BYTES);
	if (!text) return false;
	return BILLING_ERROR_PATTERN.test(text);
}

/** 只学习强模型能力信号;普通 400/404 不得污染 capability cache。 */
export async function isModelIncompatibleResponse(
	response: Response,
): Promise<boolean> {
	if (response.status !== 400 && response.status !== 404) return false;
	const text = await responsePrefix(response, MAX_ERROR_BYTES);
	if (!text) return false;
	let error: Record<string, unknown> = {};
	try {
		const body = record(JSON.parse(text));
		error = record(body?.["error"]) ?? body ?? {};
	} catch {
		// 某些兼容上游返回 text/plain;下方仍只匹配强语义短语。
	}
	const code = String(error["code"] ?? "")
		.toLowerCase()
		.replaceAll("-", "_");
	if (
		["model_not_found", "unsupported_model", "model_not_supported"].includes(
			code,
		)
	) {
		return true;
	}
	const detail = String(error["message"] ?? error["detail"] ?? text)
		.toLowerCase()
		.replace(/[\s_-]+/g, " ");
	if (
		response.status === 400 &&
		detail.includes("model is not supported when using codex")
	) {
		return true;
	}
	return (
		/(?:\bmodel\b|模型)/.test(detail) &&
		/(\bnot supported\b|\bunsupported\b|\bunknown model\b|\bmodel not found\b|不支持|不可用|不存在)/.test(
			detail,
		)
	);
}

/** OpenAI 反代:会话亲和、流式观测、请求本地故障转移。 */
export async function handleProxy(
	req: Request,
	deps: ProxyDeps,
): Promise<Response> {
	if (deps.keyMode !== "single") {
		const response = await handleProxyRequest(req, deps);
		response.headers.delete(LOCAL_RESPONSE_HEADER);
		return response;
	}
	const finish = await deps.singleKeyGate.acquire();
	try {
		const response = await handleProxyRequest(req, deps);
		if (response.headers.get(LOCAL_RESPONSE_HEADER) === "1") {
			response.headers.delete(LOCAL_RESPONSE_HEADER);
			finish();
			return response;
		}
		if (!response.body) {
			finish();
			return response;
		}
		const reader = response.body.getReader();
		let bodyClosed = false;
		let completed = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				void (async () => {
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (bodyClosed) return;
							if (done) {
								completed = true;
								bodyClosed = true;
								safeClose(controller);
								return;
							}
							if (value && !safeEnqueue(controller, value)) {
								bodyClosed = true;
								return;
							}
						}
					} catch {
						if (!bodyClosed) {
							bodyClosed = true;
							safeClose(controller);
						}
					} finally {
						if (!completed)
							await reader.cancel("downstream closed").catch(() => {});
						finish();
					}
				})().catch(finish);
			},
			async cancel(reason) {
				bodyClosed = true;
				try {
					await reader.cancel(reason).catch(() => {});
				} finally {
					finish();
				}
			},
		});
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (err) {
		finish();
		throw err;
	}
}

async function handleProxyRequest(
	req: Request,
	deps: ProxyDeps,
): Promise<Response> {
	let url: URL;
	try {
		url = new URL(req.url);
	} catch {
		return errorResponse(400, "非法请求 URL");
	}
	const path = upstreamPath(url.pathname) + url.search;
	const fetchFn = deps.fetch ?? globalThis.fetch;
	const maxRetries = deps.maxRetries ?? 2;
	const maxBuffer = deps.maxBufferBytes ?? 20 * 1024 * 1024;

	if (!proxyTokenAuthorized(req, deps.proxyToken))
		return errorResponse(401, "代理口令错误");

	let body: ArrayBuffer | undefined;
	let retriable = true;
	if (req.body) {
		const declaredLength = req.headers.get("content-length");
		const length = declaredLength === null ? undefined : Number(declaredLength);
		if (length !== undefined && Number.isFinite(length) && length > maxBuffer) {
			// 已知大请求只透传一次,不为故障转移复制进内存。
			retriable = false;
		} else if (length !== undefined && Number.isFinite(length) && length > 0) {
			body = await req.arrayBuffer();
		} else {
			body = await bufferBodyWithinLimit(req.body, maxBuffer);
			if (body === undefined)
				return errorResponse(413, `请求体超过重试缓冲上限 ${maxBuffer} 字节`);
		}
	}

	const context = requestRoutingContext(path, req.headers, body, (responseId) =>
		deps.affinity.resolveResponse(responseId),
	);
	let active: ActiveKey | undefined;
	try {
		active = await deps.route(context);
	} catch (err) {
		deps.logger.error(
			`路由准备失败:${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!active) {
		return errorResponse(503, "路由器未就绪:没有可用分组或尚未完成 AIHub 登录");
	}

	const headers = new Headers();
	req.headers.forEach((value, name) => {
		if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
	});

	// Bun fetch 会自动解压响应;请求 identity 并在响应侧移除编码声明,
	// 防止把已解压字节伪装成 gzip 导致客户端二次解压。
	headers.set("Accept-Encoding", "identity");
	const upstreamUserAgent = deps.upstreamUserAgent?.();
	if (upstreamUserAgent) headers.set("User-Agent", upstreamUserAgent);

	const failedGroups: number[] = [];
	let trackedGroup = active.groupId;
	let lastError: Response | undefined;
	let streaming = false;
	deps.traffic.begin(trackedGroup);
	active.release?.();

	const rollbackActive = (): boolean => {
		const current = active;
		const ownedBinding = current?.isCurrentBinding?.() ?? !context.sessionKey;
		const rollback = current?.rollback;
		if (rollback) {
			current.rollback = undefined;
			rollback();
		}
		return ownedBinding;
	};
	let mayUpdateBinding = true;
	const markFailure = (groupId: number) => {
		if (failedGroups.includes(groupId)) return;
		failedGroups.push(groupId);
		deps.observations.recordFailure(groupId);
		deps.reportFailure(groupId);
	};

	try {
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (attempt > 0) {
				let next: ActiveKey | undefined;
				try {
					next = await deps.route({
						...context,
						updateBinding: mayUpdateBinding,
						failedGroupIds: failedGroups,
					});
				} catch (err) {
					deps.logger.warn(
						`备用路由准备失败:${err instanceof Error ? err.message : String(err)}`,
					);
					break;
				}
				if (!next) break;
				deps.traffic.move(trackedGroup, next.groupId);
				trackedGroup = next.groupId;
				active = next;
				next.release?.();
			}

			const groupId = active.groupId;
			headers.set("Authorization", `Bearer ${active.sk}`);
			const startedAt = performance.now();
			const controller = new AbortController();
			let timedOut = false;
			const timeoutError = new DOMException("TTFB timeout", "TimeoutError");
			let rejectTimeout!: (reason: unknown) => void;
			const timeout = new Promise<never>((_, reject) => {
				rejectTimeout = reject;
			});
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort(timeoutError);
				rejectTimeout(timeoutError);
			}, deps.ttfbTimeoutMs);
			const abortForClient = () => {
				const reason =
					req.signal.reason ?? new DOMException("Client aborted", "AbortError");
				controller.abort(reason);
				rejectTimeout(reason);
			};
			if (req.signal.aborted) abortForClient();
			else req.signal.addEventListener("abort", abortForClient, { once: true });
			const finishTtfb = () => {
				clearTimeout(timer);
				req.signal.removeEventListener("abort", abortForClient);
			};

			let response: Response;
			let prefetched: { done: boolean; value?: Uint8Array } | undefined;
			let firstByteAt: number | undefined;
			let upstreamReader: ByteReader | undefined;
			try {
				response = await Promise.race([
					fetchFn(`${deps.baseUrl}${path}`, {
						method: req.method,
						headers,
						body: body !== undefined ? body : req.body,
						redirect: "manual",
						signal: controller.signal,
					}),
					timeout,
				]);

				if (response.ok && response.body) {
					upstreamReader = response.body.getReader();
					do {
						prefetched = await Promise.race([upstreamReader.read(), timeout]);
					} while (
						prefetched !== undefined &&
						!prefetched.done &&
						(prefetched.value?.byteLength ?? 0) === 0
					);
					firstByteAt = performance.now();
				} else {
					firstByteAt = performance.now();
				}
				finishTtfb();
			} catch (err) {
				finishTtfb();
				void upstreamReader?.cancel(err).catch(() => {});
				const clientCanceled = req.signal.aborted && !timedOut;
				if (clientCanceled) {
					deps.reportNeutral(groupId);
					mayUpdateBinding = rollbackActive();
					lastError = errorResponse(499, "客户端已取消请求");
					break;
				}
				deps.logger.warn(
					`上游${timedOut ? "TTFB 超时" : "连接失败"} group=${groupId} attempt=${attempt}`,
				);
				if (timedOut)
					deps.observations.recordLatency(groupId, deps.ttfbTimeoutMs);
				markFailure(groupId);
				mayUpdateBinding = rollbackActive();
				lastError = errorResponse(
					502,
					`上游${timedOut ? "TTFB 超时" : "连接失败"}(组 ${groupId})`,
				);
				if (!retriable) break;
				continue;
			}

			if (response.status === 401 && active.invalidateCredential) {
				finishTtfb();
				lastError = upstreamErrorResponse(
					response,
					groupId,
					`上游拒绝托管 Key(组 ${groupId})`,
				);
				void response.body?.cancel().catch(() => {});
				deps.reportNeutral(groupId);
				mayUpdateBinding = rollbackActive();
				const invalidated = await active.invalidateCredential().catch((err) => {
					deps.logger.warn(
						`池 Key 作废失败 group=${groupId}: ${err instanceof Error ? err.message : String(err)}`,
					);
					return false;
				});
				deps.logger.warn(
					`上游 401 group=${groupId} attempt=${attempt};${invalidated ? "已作废旧 Key" : "Key 已由并发请求刷新"}`,
				);
				if (!retriable) break;
				continue;
			}

			if (context.model && (await isModelIncompatibleResponse(response))) {
				deps.reportModelIncompatible(groupId, context.model);
				deps.reportNeutral(groupId);
				if (!failedGroups.includes(groupId)) failedGroups.push(groupId);
				mayUpdateBinding = rollbackActive();
				lastError = upstreamErrorResponse(
					response,
					groupId,
					`模型 ${context.model} 在上游组 ${groupId} 不可用`,
				);
				void response.body?.cancel().catch(() => {});
				if (!retriable) break;
				continue;
			}
			if (response.status === 403 && (await isBillingErrorResponse(response))) {
				finishTtfb();
				lastError = upstreamErrorResponse(
					response,
					groupId,
					`上游余额不足(组 ${groupId})`,
				);
				void response.body?.cancel().catch(() => {});
				deps.logger.warn(`上游余额不足 group=${groupId} attempt=${attempt}`);
				markFailure(groupId);
				mayUpdateBinding = rollbackActive();
				if (!retriable) break;
				continue;
			}
			if (upstreamFailure(response.status)) {
				finishTtfb();
				lastError = upstreamErrorResponse(response, groupId);
				void response.body?.cancel().catch(() => {});
				deps.logger.warn(
					`上游错误 ${response.status} group=${groupId} attempt=${attempt}`,
				);
				markFailure(groupId);
				mayUpdateBinding = rollbackActive();
				if (!retriable) break;
				continue;
			}
			if (!response.ok) deps.reportNeutral(groupId);
			const invalidateBinding = active.invalidate;
			const isCurrentBinding = active.isCurrentBinding;
			active.rollback = undefined;

			const outHeaders = downstreamHeaders(response.headers, groupId);

			let sawFirstByte = false;
			let outcomeRecorded = false;
			let ended = false;
			let responseProbe = "";
			let usageProbe = "";
			let responseIdBound = false;
			const decoder = new TextDecoder();
			const endOnce = () => {
				if (ended) return;
				ended = true;
				deps.traffic.end(groupId);
			};
			const recordFirstByte = () => {
				if (sawFirstByte || !response.ok) return;
				sawFirstByte = true;
				deps.observations.recordLatency(
					groupId,
					(firstByteAt ?? performance.now()) - startedAt,
				);
				deps.reportModelSupported(groupId, context.model);
			};
			const recordSuccess = () => {
				if (outcomeRecorded || !response.ok) return;
				recordFirstByte();
				outcomeRecorded = true;
				deps.observations.recordSuccess(groupId);
				deps.reportSuccess(groupId);
			};
			const recordStreamFailure = () => {
				if (outcomeRecorded || !response.ok) return;
				outcomeRecorded = true;
				deps.observations.recordFailure(groupId);
				deps.reportFailure(groupId);
				invalidateBinding?.();
			};
			const inspectResponseMetadata = (chunk: Uint8Array, flush = false) => {
				if (!context.sessionKey) return;
				const text = decoder.decode(chunk, { stream: !flush });
				if (!responseIdBound && responseProbe.length < MAX_RESPONSE_ID_BYTES) {
					responseProbe = (responseProbe + text).slice(
						0,
						MAX_RESPONSE_ID_BYTES,
					);
					const responseId = findResponseId(responseProbe);
					if (responseId) {
						deps.affinity.bindResponse(responseId, context.sessionKey, groupId);
						responseIdBound = true;
					}
				}
				usageProbe = (usageProbe + text).slice(-MAX_USAGE_BYTES);
				if (!flush || !isCurrentBinding?.()) return;
				const usage = findCacheUsage(usageProbe);
				if (usage?.cachedTokens && usage.cachedTokens > 0) {
					deps.affinity.recordCache(context.sessionKey, "hit");
				} else if (usage?.cachedTokens === 0 && (usage.inputTokens ?? 0) > 0) {
					deps.affinity.recordCache(context.sessionKey, "miss");
				}
			};

			streaming = true;
			if (!response.body) {
				recordSuccess();
				endOnce();
				return new Response(null, {
					status: response.status,
					statusText: response.statusText,
					headers: outHeaders,
				});
			}
			const reader = upstreamReader ?? response.body.getReader();
			let firstPending = upstreamReader ? prefetched : undefined;
			let sourceCompleted = false;
			let streamSettled = false;
			let downstreamClosed = false;
			const settleNeutral = () => {
				if (streamSettled) return;
				streamSettled = true;
				deps.reportNeutral(groupId);
				endOnce();
			};
			const cancelUpstream = (reason: unknown) => {
				downstreamClosed = true;
				settleNeutral();
				return reader.cancel(reason).catch(() => {});
			};
			const abortStream = () => {
				void cancelUpstream(req.signal.reason ?? "client aborted");
			};
			if (req.signal.aborted) abortStream();
			else req.signal.addEventListener("abort", abortStream, { once: true });
			const piped = new ReadableStream<Uint8Array>({
				start(controller) {
					void (async () => {
						try {
							for (;;) {
								let part: { done: boolean; value?: Uint8Array };
								try {
									part = firstPending ?? (await reader.read());
									firstPending = undefined;
								} catch (err) {
									if (
										downstreamClosed ||
										req.signal.aborted ||
										isControllerClosedError(err)
									) {
										settleNeutral();
									} else {
										recordStreamFailure();
										streamSettled = true;
										endOnce();
									}
									safeClose(controller);
									return;
								}
								if (downstreamClosed) return;
								if (part.done) {
									inspectResponseMetadata(new Uint8Array(), true);
									recordSuccess();
									sourceCompleted = true;
									streamSettled = true;
									endOnce();
									safeClose(controller);
									return;
								}
								if (part.value) {
									recordFirstByte();
									inspectResponseMetadata(part.value);
									if (!safeEnqueue(controller, part.value)) {
										await cancelUpstream("downstream closed");
										return;
									}
								}
							}
						} finally {
							req.signal.removeEventListener("abort", abortStream);
							if (!sourceCompleted && !downstreamClosed) {
								settleNeutral();
								await reader.cancel("downstream closed").catch(() => {});
							}
							endOnce();
						}
					})().catch(() => {
						settleNeutral();
						safeClose(controller);
					});
				},
				cancel(reason) {
					return cancelUpstream(reason);
				},
			});
			return new Response(piped, {
				status: response.status,
				statusText: response.statusText,
				headers: outHeaders,
			});
		}

		return lastError ?? errorResponse(503, "所有候选分组均不可用");
	} finally {
		if (!streaming) deps.traffic.end(trackedGroup);
	}
}
