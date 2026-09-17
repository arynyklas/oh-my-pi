import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AssistantMessage,
	coerceServiceTierByFamily,
	getPriorityPremiumRequests,
	resolveModelServiceTier,
	type ServiceTierByFamily,
	type ToolCall,
	type ToolResultMessage,
	type Usage,
} from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { getSessionsDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type {
	AgentType,
	MessageStatsInput,
	SessionEntry,
	SessionMessageEntry,
	SessionModelUsageEntry,
	SessionServiceTierChangeEntry,
	ToolCallStats,
	ToolResultLink,
	UserMessageLink,
	UserMessageStats,
} from "./types";
import { computeUserMessageMetrics } from "./user-metrics";

/** Basename of an advisor agent's transcript inside a session artifacts dir. */
const ADVISOR_TRANSCRIPT_BASENAME = "__advisor.jsonl";

/** Characters a persisted tool name may consist of without sanitization. */
const TOOL_NAME_PATTERN = /^[\w.:-]+$/;

/**
 * Classify which agent produced a transcript from its path within the sessions
 * directory. Layout: `<sessionsDir>/<project>/<file>.jsonl` is the `main`
 * agent; subagent and advisor transcripts live nested one level deeper inside
 * the session's artifacts dir (`<project>/<session>/<id>.jsonl`,
 * `<project>/<session>/__advisor.jsonl`). Any advisor transcript
 * (`__advisor.jsonl` or `__advisor.<slug>.jsonl`) — at any depth, including a
 * subagent's own advisor — counts as `advisor`; every other nested transcript
 * is a task `subagent`.
 */
export function classifyAgentType(sessionPath: string): AgentType {
	const base = path.basename(sessionPath);
	if (base === ADVISOR_TRANSCRIPT_BASENAME || (base.startsWith("__advisor.") && base.endsWith(".jsonl"))) {
		return "advisor";
	}
	const rel = path.relative(getSessionsDir(), sessionPath);
	// `<project>/<file>.jsonl` -> 2 segments. Deeper nesting is a subagent.
	return rel.split(path.sep).length <= 2 ? "main" : "subagent";
}

/**
 * Extract folder name from session filename.
 * Session files are named like: --work--pi--/timestamp_uuid.jsonl
 * The folder part uses -- as path separator.
 */
export function extractFolderFromPath(sessionPath: string): string {
	const sessionsDir = getSessionsDir();
	const rel = path.relative(sessionsDir, sessionPath);
	const projectDir = rel.split(path.sep)[0];
	// Convert --work--pi-- to /work/pi
	return projectDir.replace(/^--/, "/").replace(/--/g, "/");
}

/**
 * Check if an entry is an assistant message.
 */
function isAssistantMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	// Legacy sessions (pre-id tracking) recorded message entries without an `id`.
	// They're not linkable and would violate the messages.entry_id NOT NULL
	// constraint, so skip them at the parser boundary.
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	return msgEntry.message?.role === "assistant";
}

function isModelUsage(entry: SessionEntry): entry is SessionModelUsageEntry {
	if (entry.type !== "model_usage") return false;
	const usageEntry = entry as SessionModelUsageEntry;
	return typeof usageEntry.id === "string" && usageEntry.id.length > 0;
}

/**
 * Check if an entry is a user message (non-toolResult).
 */
function isUserMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	return msgEntry.message?.role === "user";
}

/**
 * Check if an entry is a service-tier change.
 */
function isServiceTierChange(entry: SessionEntry): entry is SessionServiceTierChangeEntry {
	return entry.type === "service_tier_change";
}

/**
 * Check if an entry is a tool-result message.
 */
function isToolResultMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	return (entry as SessionMessageEntry).message?.role === "toolResult";
}

/**
 * Extract plain text from a user message content payload.
 */
function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("");
}

/**
 * Build user-message stats from an entry. Returns null for empty/synthetic content.
 */
function extractUserStats(sessionFile: string, folder: string, entry: SessionMessageEntry): UserMessageStats | null {
	const msg = entry.message as { role: "user"; content?: unknown; synthetic?: boolean };
	if (msg.role !== "user" || msg.synthetic) return null;
	const text = extractUserText(msg.content);
	if (!text.trim()) return null;
	const metrics = computeUserMessageMetrics(text);
	const ts = Date.parse(entry.timestamp);
	return {
		sessionFile,
		entryId: entry.id,
		folder,
		timestamp: Number.isFinite(ts) ? ts : 0,
		model: null,
		provider: null,
		chars: metrics.chars,
		words: metrics.words,
		yelling: metrics.yelling,
		profanity: metrics.profanity,
		anguish: metrics.anguish,
		negation: metrics.negation,
		repetition: metrics.repetition,
		blame: metrics.blame,
	};
}

/**
 * Session JSONL is written by older versions and foreign producers, so a token
 * counter is whatever was persisted, not what `Usage` declares. A non-numeric
 * bucket (`input: "10"`) must never be parsed and must never be summed: `+`
 * would concatenate it into the derived total and SQLite would coerce the
 * resulting string to a different, far larger number. A non-finite one
 * (`input: 1e999` is legal JSON) must not reach a NOT NULL column either.
 * Malformed input counts as absent.
 */
function isFiniteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function finiteTokenCount(value: unknown): number {
	return isFiniteCount(value) ? value : 0;
}

/**
 * Token-bucket view for total derivation. Persisted session payloads are
 * outside-controlled (old versions, foreign producers), so every counter is
 * `unknown` and validated at read time.
 */
export interface UsageBucketView {
	totalTokens?: unknown;
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	orchestration?: { input?: unknown; output?: unknown; cacheRead?: unknown } | null;
}

/**
 * Total tokens for one usage payload, per the documented contract: the
 * conversation buckets plus provider-reported orchestration tokens. A present
 * finite provider total stays authoritative; a missing or malformed one
 * (absent, string, NaN) is derived from the buckets, which would otherwise
 * persist a zero total next to real token counts. Shared by ingest and the
 * trace builder so stored and displayed totals cannot disagree.
 */
export function resolveUsageTotal(usage: UsageBucketView | null | undefined): number {
	if (typeof usage?.totalTokens === "number" && Number.isFinite(usage.totalTokens)) return usage.totalTokens;
	if (!usage || typeof usage !== "object") return 0;
	const orchestration =
		usage.orchestration && typeof usage.orchestration === "object" ? usage.orchestration : undefined;
	return (
		finiteTokenCount(usage.input) +
		finiteTokenCount(usage.output) +
		finiteTokenCount(usage.cacheRead) +
		finiteTokenCount(usage.cacheWrite) +
		finiteTokenCount(orchestration?.input) +
		finiteTokenCount(orchestration?.output) +
		finiteTokenCount(orchestration?.cacheRead)
	);
}

/**
 * Extract stats from an assistant message entry.
 *
 * Session JSONL on disk is not guaranteed to match the current
 * `AssistantMessage` shape: crash-truncated turns, sessions written by older
 * versions, and foreign producers all flow through this parser. Every field
 * returned here feeds a NOT NULL column in stats.db, so malformed entries are
 * coerced (missing `stopReason`, token counts, `timestamp`) or skipped
 * (missing `model`/`provider`/`api`/`usage`) instead of crashing the whole
 * sync with a constraint violation.
 */
function extractStats(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry,
	currentServiceTier: ServiceTierByFamily | undefined,
	agentType: AgentType,
): MessageStatsInput | null {
	const msg = entry.message as AssistantMessage;
	if (msg?.role !== "assistant") return null;
	if (typeof msg.model !== "string" || typeof msg.provider !== "string" || typeof msg.api !== "string") return null;
	const rawUsage = msg.usage as Partial<Usage> | undefined;
	if (!rawUsage || typeof rawUsage !== "object") return null;

	// Backfill: when the session recorded `priority` as the active service tier
	// at this point but the AI usage payload was captured before priority
	// requests were folded into `premiumRequests`, derive the count here so the
	// "Premium Reqs" stat aggregates priority traffic on re-sync. Trust any
	// non-zero value already in `usage.premiumRequests` (Copilot multipliers or
	// the new AI code path) and only synthesise when the field is missing/zero.
	const recorded = rawUsage.premiumRequests ?? 0;
	const model = {
		provider: msg.provider,
		api: msg.api,
		identity: classifyModel(msg.provider, msg.model, { lenient: true }),
	};
	const tier = resolveModelServiceTier(currentServiceTier, model);
	const derived = recorded > 0 ? recorded : getPriorityPremiumRequests(tier, model);
	const wellFormed =
		isFiniteCount(rawUsage.input) &&
		isFiniteCount(rawUsage.output) &&
		isFiniteCount(rawUsage.cacheRead) &&
		isFiniteCount(rawUsage.cacheWrite) &&
		isFiniteCount(rawUsage.totalTokens);
	const usage: MessageStatsInput["usage"] =
		wellFormed && derived === recorded
			? (rawUsage as Usage)
			: {
					...rawUsage,
					input: finiteTokenCount(rawUsage.input),
					output: finiteTokenCount(rawUsage.output),
					cacheRead: finiteTokenCount(rawUsage.cacheRead),
					cacheWrite: finiteTokenCount(rawUsage.cacheWrite),
					// A present finite provider total stays authoritative; a missing
					// or malformed one (absent, string, NaN) is derived from the buckets.
					totalTokens: resolveUsageTotal(rawUsage),
					// An omitted `cost` must stay omitted: `resolveStoredCost` reads
					// absence as "no recorded price" and estimates the request, while
					// a zero would read as an explicitly free request.
					cost: rawUsage.cost,
					premiumRequests: derived,
				};

	return {
		sessionFile,
		entryId: entry.id,
		folder,
		model: msg.model,
		provider: msg.provider,
		api: msg.api,
		timestamp: coerceEntryTimestamp(msg.timestamp, entry),
		duration: msg.duration ?? null,
		ttft: msg.ttft ?? null,
		// A message persisted without a terminal stop reason never completed
		// normally: classify by whether it carried an error.
		stopReason: msg.stopReason ?? (msg.errorMessage ? "error" : "aborted"),
		errorMessage: msg.errorMessage ?? null,
		usage,
		agentType,
	};
}

function extractModelUsageStats(
	sessionFile: string,
	folder: string,
	entry: SessionModelUsageEntry,
	agentType: AgentType,
): MessageStatsInput | null {
	const timestamp = Date.parse(entry.timestamp);
	return extractStats(
		sessionFile,
		folder,
		{
			type: "message",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			message: {
				role: "assistant",
				content: [],
				api: entry.api,
				provider: entry.provider,
				model: entry.model,
				usage: entry.usage,
				stopReason: entry.stopReason ?? "stop",
				errorMessage: entry.errorMessage,
				timestamp: Number.isFinite(timestamp) ? timestamp : 0,
			},
		},
		undefined,
		agentType,
	);
}

/** Message timestamp, falling back to the entry's ISO timestamp, then 0. */
function coerceEntryTimestamp(timestamp: number | undefined, entry: SessionMessageEntry): number {
	// A stored zero is the "no timestamp" sentinel, not 1970: fall through to
	// the entry envelope so a recoverable ISO time still selects its tariff.
	if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) return timestamp;
	const ts = Date.parse(entry.timestamp);
	return Number.isFinite(ts) ? ts : 0;
}

/**
 * Extract one {@link ToolCallStats} per `toolCall` content block of an
 * assistant message. Returns an empty array for turns without tool calls.
 */
function extractToolCalls(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry,
	agentType: AgentType,
): ToolCallStats[] {
	const msg = entry.message as AssistantMessage;
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return [];
	// `tool_calls` columns are NOT NULL: skip turns that can't be attributed
	// (malformed persisted entries — see extractStats) and blocks missing ids.
	if (typeof msg.model !== "string" || typeof msg.provider !== "string") return [];

	const blocks = msg.content.filter(
		(block): block is ToolCall =>
			block !== null &&
			typeof block === "object" &&
			block.type === "toolCall" &&
			typeof block.id === "string" &&
			typeof block.name === "string",
	);
	if (blocks.length === 0) return [];

	const calls: ToolCallStats[] = [];
	for (const block of blocks) {
		// Names reduced to nothing by sanitization carry no tool identity:
		// skip them rather than attributing usage to garbage (see
		// sanitizeToolName). callsInTurn still counts the raw block total.
		const toolName = sanitizeToolName(block.name);
		if (toolName === null) continue;
		let argsChars = 0;
		try {
			argsChars = JSON.stringify(block.arguments ?? {}).length;
		} catch {
			// Non-serializable arguments (shouldn't happen in persisted JSONL); size unknown.
		}
		calls.push({
			sessionFile,
			entryId: entry.id,
			toolCallId: block.id,
			folder,
			toolName,
			model: msg.model,
			provider: msg.provider,
			timestamp: coerceEntryTimestamp(msg.timestamp, entry),
			agentType,
			callsInTurn: blocks.length,
			argsChars,
		});
	}
	return calls;
}

/**
 * Tool names as persisted can be polluted by provider-side parse garbage — a
 * gateway may hand the model's whole invocation text back as the function
 * name (e.g. `bash command="ls -la …"` with a stray in-band closer), which
 * then shows up verbatim in every `GROUP BY tool_name` aggregate and the
 * dashboard tool filter. Reduce such names to their leading identifier token;
 * names that yield no identifier at all carry no tool identity and are
 * returned as `null` so the row is skipped.
 */
function sanitizeToolName(name: string): string | null {
	const trimmed = name.trim();
	if (trimmed.length === 0) return null;
	if (TOOL_NAME_PATTERN.test(trimmed)) return trimmed;
	const candidate = trimmed.split(/[^\w.:-]/)[0] ?? "";
	return candidate.length > 0 ? candidate : null;
}

/**
 * Build the result linkage for a `toolResult` entry: text characters fed back
 * into context plus the error flag, keyed to the originating call.
 */
function extractToolResultLink(sessionFile: string, entry: SessionMessageEntry): ToolResultLink | null {
	const msg = entry.message as ToolResultMessage;
	if (msg.role !== "toolResult" || typeof msg.toolCallId !== "string" || msg.toolCallId.length === 0) return null;
	let resultChars = 0;
	if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
				resultChars += block.text.length;
			}
		}
	}
	return {
		sessionFile,
		toolCallId: msg.toolCallId,
		resultChars,
		isError: msg.isError === true,
	};
}

const LF = 0x0a;
const CR = 0x0d;
const jsonLineDecoder = new TextDecoder();

/** Positional read granularity. Verified flat-RSS on a 6.3 GB transcript. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** Bytes of a transcript one `parseSessionFile` call consumes before yielding. */
export const PARSE_CHUNK_BYTES = 256 * 1024 * 1024;
/** A single JSONL line longer than this is discarded rather than buffered. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

function parseJsonLine(line: Uint8Array): SessionEntry | null {
	let end = line.length;
	while (end > 0 && line[end - 1] === CR) end--;
	if (end === 0) return null;
	try {
		return JSON.parse(jsonLineDecoder.decode(line.subarray(0, end))) as SessionEntry;
	} catch {
		return null;
	}
}

/**
 * Walk the JSONL lines of `sessionPath` starting at byte `start`, reading at
 * most {@link READ_CHUNK_BYTES} per positional read so peak memory stays flat
 * regardless of file size (advisor transcripts on real machines reach 13 GB,
 * which no single allocation can serve).
 *
 * `visit` receives a view into the read buffer and must not retain it past the
 * call; returning `false` stops the scan without committing that line.
 *
 * Returns the absolute offset just past the last committed line terminator —
 * always a line boundary, so it is safe to persist and resume from — and
 * whether the scan reached end of file. The scan also stops once `maxBytes`
 * have been committed since `start`.
 */
async function scanSessionLines(
	sessionPath: string,
	start: number,
	maxBytes: number,
	visit: (line: Uint8Array) => boolean,
): Promise<{ read: number; done: boolean }> {
	const file = Bun.file(sessionPath);
	const size = file.size;
	let pos = Math.min(Math.max(0, start), size);
	const begin = pos;
	let read = pos;
	if (pos >= size) return { read, done: true };

	let carry: Uint8Array | null = null;
	let discarding = false;

	while (pos < size) {
		const chunk = await file.slice(pos, Math.min(size, pos + READ_CHUNK_BYTES)).bytes();
		// File shrank mid-scan (rotation/truncation); commit what we have.
		if (chunk.length === 0) return { read, done: true };
		const chunkBase = pos;
		pos += chunk.length;

		let c = 0;
		while (c < chunk.length) {
			const nl = chunk.indexOf(LF, c);
			if (nl === -1) {
				if (!discarding) {
					const rest = chunk.subarray(c);
					const carried: number = carry?.length ?? 0;
					if (carried + rest.length > MAX_LINE_BYTES) {
						carry = null;
						discarding = true;
						logger.warn("stats: skipping oversized session line", { sessionPath, offset: read });
					} else {
						// Copy: `rest` views the chunk buffer, which the next read replaces.
						const merged = new Uint8Array(carried + rest.length);
						if (carry) merged.set(carry, 0);
						merged.set(rest, carried);
						carry = merged;
					}
				}
				break;
			}
			if (discarding) {
				discarding = false;
			} else {
				let line: Uint8Array;
				if (carry) {
					const merged = new Uint8Array(carry.length + (nl - c));
					merged.set(carry, 0);
					merged.set(chunk.subarray(c, nl), carry.length);
					line = merged;
					carry = null;
				} else {
					line = chunk.subarray(c, nl);
				}
				if (!visit(line)) return { read, done: false };
			}
			read = chunkBase + nl + 1;
			c = nl + 1;
			// Budget exhausted. If it ran out exactly at EOF the caller has the
			// whole file, so report `done` and save it a no-op round trip.
			if (read - begin >= maxBytes) return { read, done: read >= size };
		}
	}

	// Final line without a trailing newline: surface it, but leave its bytes
	// uncommitted so a later append completes the line. Every insert path is an
	// idempotent upsert, so re-visiting it on the next sync is harmless.
	if (carry && !discarding && carry.length > 0) visit(carry);
	return { read, done: true };
}

const SERVICE_TIER_NEEDLE = Buffer.from('"service_tier_change"');

/** Parse every well-formed entry in a transcript buffer (malformed lines skipped). */
export function parseAllSessionEntries(bytes: Uint8Array): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let cursor = 0;
	while (cursor < bytes.length) {
		const newline = bytes.indexOf(LF, cursor);
		const hasNewline = newline !== -1;
		const lineEnd = hasNewline ? newline : bytes.length;
		const entry = parseJsonLine(bytes.subarray(cursor, lineEnd));
		if (entry) entries.push(entry);
		if (!hasNewline) break;
		cursor = newline + 1;
	}
	return entries;
}

/**
 * Recover the service tier active at `endOffset` by replaying the preceding
 * bytes without materializing them. `endOffset` always comes from a previous
 * `newOffset` and is therefore a line boundary, so passing it as the byte
 * budget stops the scan exactly there. Lines are prefiltered with a raw byte
 * search, keeping the pass memory-scan bound rather than JSON bound.
 */
async function scanServiceTierPrefix(sessionPath: string, endOffset: number): Promise<ServiceTierByFamily | null> {
	let tier: ServiceTierByFamily | undefined;
	await scanSessionLines(sessionPath, 0, endOffset, line => {
		const view = Buffer.from(line.buffer as ArrayBuffer, line.byteOffset, line.length);
		if (!view.includes(SERVICE_TIER_NEEDLE)) return true;
		const entry = parseJsonLine(line);
		if (entry && isServiceTierChange(entry)) tier = coerceServiceTierByFamily(entry.serviceTier);
		return true;
	});
	return tier ?? null;
}

/**
 * Persisted parse cursor for one transcript: where the last pass stopped, the
 * file identity and tail hash that prove the cursor still points into the same
 * byte stream, and the service tier active at `offset` (so an incremental sync
 * of a huge transcript does not replay the prefix to recover it).
 */
export interface SessionParserState {
	version: 1;
	offset: number;
	dev: number;
	ino: number;
	birthtimeMs: number;
	size: number;
	mtimeMs: number;
	checkpoint: string;
	serviceTier: ServiceTierByFamily | null;
}

export interface ParseSessionOptions {
	/** Resume offset; must be a line boundary from a previous `newOffset`. Default 0. */
	fromOffset?: number;
	/**
	 * Persisted cursor for `fromOffset`. When it still matches the file on disk
	 * the appended tail is parsed directly and the recorded tier is reused;
	 * otherwise the file is re-read from byte 0 and `reset` is reported.
	 */
	state?: SessionParserState;
	/** Force a full re-parse from byte 0, ignoring `fromOffset` and `state`. */
	replay?: boolean;
	/**
	 * Active service tier at `fromOffset` for callers that carry the tier
	 * without a full cursor. `null` = none active; `undefined` = unknown, which
	 * makes this call replay the prefix with {@link scanServiceTierPrefix} to
	 * recover it. Ignored when `state` resumes.
	 */
	serviceTier?: ServiceTierByFamily | null;
	/** Soft byte budget for this call; the scan stops at the next line boundary past it. */
	maxBytes?: number;
}

export interface ParseSessionResult {
	stats: MessageStatsInput[];
	userStats: UserMessageStats[];
	userLinks: UserMessageLink[];
	toolCalls: ToolCallStats[];
	toolResults: ToolResultLink[];
	newOffset: number;
	/** Cursor to persist and feed back as `state` on the next pass for this file. */
	parserState?: SessionParserState;
	/** The file did not continue the persisted cursor, so it was re-read from byte 0. */
	reset?: boolean;
	/** Active tier at `newOffset`; feed back into the next call for this file. */
	serviceTier: ServiceTierByFamily | null;
	/** True when `newOffset` reached end of file as observed by this pass. */
	done: boolean;
}

const CHECKPOINT_BYTES = 256;

/**
 * The {@link CHECKPOINT_BYTES} bytes ending at `end`. Hashing them proves a
 * stored offset still points into the same byte stream, which catches a file
 * rewritten in place at an identical size.
 */
async function readCheckpoint(sessionPath: string, end: number): Promise<Uint8Array> {
	if (end <= 0) return new Uint8Array(0);
	return await Bun.file(sessionPath)
		.slice(Math.max(0, end - CHECKPOINT_BYTES), end)
		.bytes();
}

export function matchesSessionFile(state: SessionParserState, info: nodeFs.Stats): boolean {
	return state.dev === info.dev && state.ino === info.ino && state.birthtimeMs === info.birthtimeMs;
}

/**
 * Parse a slice of a session file and extract assistant/user/tool stats.
 *
 * Reading is incremental in two dimensions: `fromOffset` (validated against
 * `state`) skips bytes already committed by an earlier sync, and `maxBytes`
 * caps how much this call consumes so multi-gigabyte transcripts are ingested
 * in bounded-memory chunks. Callers loop until `done`, feeding
 * `newOffset`/`parserState` back in. A cursor that no longer matches the file
 * on disk — different inode, shrunk, rewritten in place, or a mismatched tail
 * hash — re-reads from byte 0 and reports `reset` so the caller can discard the
 * rows it already stored for that file.
 *
 * Service-tier carry-over: the tier is session-scoped state derived from
 * `service_tier_change` entries that decides whether subsequent OpenAI
 * assistant replies count as premium requests. Incremental syncs that resume
 * past the most-recent tier change would otherwise lose it and silently record
 * `premiumRequests = 0` for priority traffic (the coding-agent stopped folding
 * the tier into `usage.premiumRequests` after 13f59162e — the parser is now the
 * sole source of truth). A resumed `state` carries the tier; without one the
 * prefix is replayed to recover it.
 */
export async function parseSessionFile(
	sessionPath: string,
	options: ParseSessionOptions = {},
): Promise<ParseSessionResult> {
	const fromOffset = Math.max(0, options.fromOffset ?? 0);
	const maxBytes = options.maxBytes ?? PARSE_CHUNK_BYTES;
	const state = options.state;
	const replay = options.replay === true;

	const folder = extractFolderFromPath(sessionPath);
	const agentType = classifyAgentType(sessionPath);
	const stats: MessageStatsInput[] = [];
	const userStats: UserMessageStats[] = [];
	const userLinks: UserMessageLink[] = [];
	const toolCalls: ToolCallStats[] = [];
	const toolResults: ToolResultLink[] = [];
	let currentServiceTier: ServiceTierByFamily | null | undefined;
	let reset = false;

	try {
		const info = await fs.stat(sessionPath);
		let resume = !replay && state?.version === 1 && state.offset === fromOffset;
		if (resume && state) {
			reset =
				!matchesSessionFile(state, info) ||
				info.size < state.size ||
				(info.size === state.size && info.mtimeMs !== state.mtimeMs);
			if (!reset) {
				const previous = await readCheckpoint(sessionPath, fromOffset);
				reset = Bun.hash(previous).toString(16) !== state.checkpoint;
			}
			resume = !reset;
		}
		if (fromOffset > info.size) reset = true;
		const start = reset || replay ? 0 : fromOffset;

		// Nothing precedes byte 0, so a fresh parse never pays for a prefix scan.
		currentServiceTier =
			start === 0
				? null
				: resume
					? (state?.serviceTier ?? null)
					: options.serviceTier !== undefined
						? options.serviceTier
						: await scanServiceTierPrefix(sessionPath, start);

		const { read, done } = await scanSessionLines(sessionPath, start, maxBytes, line => {
			const entry = parseJsonLine(line);
			if (!entry) return true;
			if (isServiceTierChange(entry)) {
				currentServiceTier = coerceServiceTierByFamily(entry.serviceTier) ?? null;
				return true;
			}
			if (isUserMessage(entry)) {
				const userMsg = extractUserStats(sessionPath, folder, entry);
				if (userMsg) userStats.push(userMsg);
				return true;
			}
			if (isToolResultMessage(entry)) {
				const link = extractToolResultLink(sessionPath, entry);
				if (link) toolResults.push(link);
				return true;
			}
			if (isModelUsage(entry)) {
				const modelUsageStats = extractModelUsageStats(sessionPath, folder, entry, agentType);
				if (modelUsageStats) stats.push(modelUsageStats);
				return true;
			}
			if (isAssistantMessage(entry)) {
				const msgStats = extractStats(sessionPath, folder, entry, currentServiceTier ?? undefined, agentType);
				if (msgStats) stats.push(msgStats);
				toolCalls.push(...extractToolCalls(sessionPath, folder, entry, agentType));
				// Link assistant's responding model back to the user message it answered.
				const parentId = (entry as SessionMessageEntry).parentId;
				if (parentId) {
					const msg = entry.message as AssistantMessage;
					if (msg.model && msg.provider) {
						// Emit unconditionally. The aggregator's UPDATE is guarded by
						// `model IS NULL` so this is idempotent: a no-op for already
						// linked rows, a fix-up for fresh inserts (which start NULL
						// because the user row is recorded before its reply lands) and
						// for cross-pass orphans whose parent was committed by an
						// earlier incremental sync.
						userLinks.push({
							sessionFile: sessionPath,
							entryId: parentId,
							model: msg.model,
							provider: msg.provider,
						});
					}
				}
			}
			return true;
		});

		const checkpoint = Bun.hash(await readCheckpoint(sessionPath, read)).toString(16);
		return {
			stats,
			userStats,
			userLinks,
			toolCalls,
			toolResults,
			newOffset: read,
			serviceTier: currentServiceTier ?? null,
			done,
			reset,
			parserState: {
				version: 1,
				offset: read,
				dev: info.dev,
				ino: info.ino,
				birthtimeMs: info.birthtimeMs,
				size: info.size,
				mtimeMs: info.mtimeMs,
				checkpoint,
				serviceTier: currentServiceTier ?? null,
			},
		};
	} catch (err) {
		if (isEnoent(err))
			return {
				stats: [],
				userStats: [],
				userLinks: [],
				toolCalls: [],
				toolResults: [],
				newOffset: fromOffset,
				serviceTier: currentServiceTier ?? null,
				done: true,
			};
		throw err;
	}
}

/**
 * List all session directories (folders).
 */
export async function listSessionFolders(): Promise<string[]> {
	try {
		const sessionsDir = getSessionsDir();
		const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => path.join(sessionsDir, e.name));
	} catch {
		return [];
	}
}

/**
 * List all session files in a folder.
 */
export async function listSessionFiles(folderPath: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(folderPath, { recursive: true, withFileTypes: true });
		return entries.filter(e => e.isFile() && e.name.endsWith(".jsonl")).map(e => path.join(e.parentPath, e.name));
	} catch {
		return [];
	}
}

/**
 * List all session files across all folders.
 */
export async function listAllSessionFiles(): Promise<string[]> {
	const folders = await listSessionFolders();
	const allFiles: string[] = [];

	for (const folder of folders) {
		const files = await listSessionFiles(folder);
		allFiles.push(...files);
	}

	return allFiles;
}

/**
 * Find a specific entry in a session file. Uses the bounded scanner rather
 * than streaming the whole file, so looking up an entry in a multi-gigabyte
 * transcript costs one chunk of memory instead of the file's size.
 */
export async function getSessionEntry(sessionPath: string, entryId: string): Promise<SessionEntry | null> {
	let found: SessionEntry | null = null;
	try {
		await scanSessionLines(sessionPath, 0, Number.POSITIVE_INFINITY, line => {
			const entry = parseJsonLine(line);
			if (entry && "id" in entry && entry.id === entryId) {
				found = entry;
				return false;
			}
			return true;
		});
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	return found;
}
