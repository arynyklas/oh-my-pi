import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import type { ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-large-session-");

afterEach(() => {
	vi.restoreAllMocks();
});

async function writeLargeSessionFile(): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), "--tmp--large-session");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "session.jsonl");
	const timestamp = new Date().toISOString();
	const payload = "x".repeat(16 * 1024);
	const lines: string[] = [];
	for (let i = 0; i < 256; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `assistant-${i}`,
				parentId: null,
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: payload }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.4",
					usage: {
						input: 1,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 3,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now() + i,
					duration: 10,
					ttft: 5,
				},
			}),
		);
	}
	await Bun.write(sessionFile, `${lines.join("\n")}\n`);
	return sessionFile;
}

describe("large session parsing", () => {
	it("parses a JSONL chunk with more entries than the JavaScript argument limit", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--large-session");
		await fs.mkdir(dir, { recursive: true });
		const sessionFile = path.join(dir, "large.jsonl");
		const entry = `${JSON.stringify({ type: "session", id: "s", timestamp: "2026-06-28T00:00:00.000Z", cwd: "/tmp" })}\n`;
		const entryCount = 700_000;
		await fs.writeFile(sessionFile, entry.repeat(entryCount));

		const result = await parseSessionFile(sessionFile);

		// The lenient line scanner consumes the entire file (every line is `\n`-terminated),
		// so the resume offset is the full byte length rather than the byte before the final newline.
		expect(result.newOffset).toBe(entry.length * entryCount);
		expect(result.stats).toEqual([]);
		expect(result.userStats).toEqual([]);
		expect(result.userLinks).toEqual([]);
	});

	it("parses multi-megabyte JSONL without entering Bun.JSONL.parseChunk", async () => {
		const sessionFile = await writeLargeSessionFile();
		vi.spyOn(Bun.JSONL, "parseChunk").mockImplementation(() => {
			throw new Error("native JSONL parser unavailable");
		});

		const result = await parseSessionFile(sessionFile);

		expect(result.stats).toHaveLength(256);
		expect(result.newOffset).toBeGreaterThan(4 * 1024 * 1024);
	});

	it("resumes across byte-budgeted chunks without dropping or duplicating entries", async () => {
		const sessionFile = await writeLargeSessionFile();
		const size = (await fs.stat(sessionFile)).size;
		const seen: string[] = [];
		let offset = 0;
		let tier: ServiceTierByFamily | null = null;
		let calls = 0;
		for (;;) {
			const chunk = await parseSessionFile(sessionFile, {
				fromOffset: offset,
				serviceTier: tier,
				maxBytes: 512 * 1024,
			});
			calls++;
			seen.push(...chunk.stats.map(s => s.entryId));
			expect(chunk.newOffset).toBeGreaterThan(offset);
			offset = chunk.newOffset;
			tier = chunk.serviceTier;
			if (chunk.done) break;
		}
		expect(calls).toBeGreaterThan(1);
		expect(offset).toBe(size);
		expect(seen).toEqual(Array.from({ length: 256 }, (_, i) => `assistant-${i}`));
	});
});
