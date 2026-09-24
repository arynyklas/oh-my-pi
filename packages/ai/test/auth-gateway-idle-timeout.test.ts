import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

// Bun's socket timers use real time, not JS fake timers. Shorten the server
// default so the inference exemption must survive a real socket idle deadline.
const realServe = Bun.serve.bind(Bun);

afterEach(() => {
	vi.restoreAllMocks();
	clearCustomApis();
});

describe("auth-gateway quiet inference", () => {
	it.each(["pi-native", "chat"])(
		"completes after upstream silence (%s)",
		async format => {
			registerMockApi();
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-idle-"));
			const storage = await AuthStorage.create(path.join(dir, "auth.db"));
			storage.keys.setRuntime("openrouter", "test-key");
			const mock = createMockModel({ provider: "openrouter", id: "quiet-model" });
			mock.push({ delayMs: 6000, content: ["completed after silence"], stopReason: "stop" });
			const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(options => {
				options.idleTimeout = 1;
				return realServe(options);
			});
			let gateway;
			try {
				gateway = startAuthGateway({
					bind: "127.0.0.1:0",
					bearerTokens: ["t"],
					storage,
					resolveModel: () => mock.model,
				});
			} finally {
				// Never leave the global spy active while another async test can run.
				serveSpy.mockRestore();
			}
			try {
				const native = format === "pi-native";
				const response = await fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/chat/completions"}`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
					body: JSON.stringify(
						native
							? {
									modelId: "quiet-model",
									context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
									stream: true,
								}
							: { model: "quiet-model", messages: [{ role: "user", content: "hi" }], stream: true },
					),
					signal: AbortSignal.timeout(10000),
				});
				expect(response.status).toBe(200);
				const body = await response.text();
				// pi-native stays silent before headers; chat sends a role chunk first.
				// Both must deliver the answer and terminal SSE marker, not truncated EOF.
				expect(body).toContain("completed after silence");
				expect(body).toContain("data: [DONE]");
			} finally {
				await gateway.close();
				storage.close();
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
		15000,
	);
});
