import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

describe("auth-gateway graceful shutdown", () => {
	it("drains an in-flight request instead of aborting it when close() is called", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-drain-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "openrouter/drain-model" });

		// Gate the mock response: the handler parks until the test releases it,
		// so the request is provably in-flight when close() runs.
		const requestArrived = Promise.withResolvers<void>();
		const releaseResponse = Promise.withResolvers<void>();
		mock.push(async () => {
			requestArrived.resolve();
			await releaseResponse.promise;
			return { content: ["drained answer"], stopReason: "stop" };
		});

		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => mock.model,
			version: "test",
		});

		try {
			const responsePromise = fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "openrouter/drain-model",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});

			// Wait until the request is actually being served upstream — a real
			// event, not a wall-clock guess.
			await requestArrived.promise;

			// Begin graceful shutdown while the request is in-flight. With a forced
			// stop this would abort the socket and the fetch below would fail; with
			// a graceful drain the parked request still completes with a full body.
			const closePromise = handle.close();

			// Release the upstream response; the in-flight request drains cleanly.
			releaseResponse.resolve();

			const res = await responsePromise;
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				error?: unknown;
				choices?: Array<{ message?: { content?: string | null } }>;
			};
			expect(body.error).toBeUndefined();
			expect(body.choices?.[0]?.message?.content).toContain("drained answer");

			// close() resolves once the drained request has finished.
			await closePromise;
		} finally {
			releaseResponse.resolve();
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
