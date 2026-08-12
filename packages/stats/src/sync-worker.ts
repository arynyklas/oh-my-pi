/**
 * Stateless parse worker for `syncAllSessions`. The main thread owns the
 * SQLite handle; workers receive `{ sessionFile, fromOffset, serviceTier }`,
 * run `parseSessionFile` (which is pure I/O + CPU, no DB), and post the
 * structured-clone-safe result back. One in-flight request per worker so
 * the main thread can fan jobs out 1:1 with the pool size.
 *
 * Each request parses at most one chunk (`PARSE_CHUNK_BYTES`); the main thread
 * loops on `result.done`, so a multi-gigabyte transcript crosses the wire as a
 * sequence of bounded results instead of one unbounded allocation. `maxBytes`
 * is deliberately not part of the protocol — both the serial and worker paths
 * take the parser default.
 *
 * A `{ kind: "ping" }` request is also accepted and replies with
 * `{ ok: true, kind: "pong" }` — used by `smokeTestSyncWorker` to prove the
 * worker actually spawns and runs in compiled binaries (regression coverage
 * for issue #1011 / PR #1027, where the worker silently failed to load).
 */

import type { ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import { type ParseSessionResult, parseSessionFile } from "./parser";

export type SyncWorkerRequest =
	| {
			kind?: "parse";
			sessionFile: string;
			fromOffset: number;
			serviceTier?: ServiceTierByFamily | null;
	  }
	| { kind: "ping" };

export type SyncWorkerResponse =
	| { ok: true; kind?: "parse"; result: ParseSessionResult }
	| { ok: true; kind: "pong" }
	| { ok: false; error: string };

declare const self: Worker & {
	onmessage: ((event: MessageEvent<SyncWorkerRequest>) => void) | null;
};

self.onmessage = async event => {
	const request = event.data;
	try {
		if (request.kind === "ping") {
			self.postMessage({ ok: true, kind: "pong" } satisfies SyncWorkerResponse);
			return;
		}
		const result = await parseSessionFile(request.sessionFile, {
			fromOffset: request.fromOffset,
			serviceTier: request.serviceTier,
		});
		self.postMessage({ ok: true, result } satisfies SyncWorkerResponse);
	} catch (err) {
		const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
		self.postMessage({ ok: false, error } satisfies SyncWorkerResponse);
	}
};
