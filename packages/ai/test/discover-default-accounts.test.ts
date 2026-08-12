import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-ai/auth-broker/discover";
import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";

const cleanups: Array<() => Promise<void> | void> = [];

async function withConfig(yaml: string): Promise<AuthStorage> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-default-account-"));
	await Bun.write(path.join(dir, "config.yml"), yaml);
	const storage = await discoverAuthStorage({ agentDir: dir });
	cleanups.push(async () => {
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return storage;
}

describe("discoverAuthStorage providers.defaultAccount", () => {
	afterEach(async () => {
		for (const dispose of cleanups.splice(0)) await dispose();
	});

	test("reads the nested providers.defaultAccount form from config.yml", async () => {
		const storage = await withConfig("providers:\n  defaultAccount:\n    anthropic: me@example.com\n");
		expect(storage.getDefaultAccountSelector("anthropic")).toBe("me@example.com");
	});

	test("reads the flat providers.defaultAccount form from config.yml", async () => {
		const storage = await withConfig('"providers.defaultAccount":\n  anthropic: me@example.com\n');
		expect(storage.getDefaultAccountSelector("anthropic")).toBe("me@example.com");
	});

	test("injected defaultAccounts option overrides config discovery", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-default-account-"));
		await Bun.write(
			path.join(dir, "config.yml"),
			"providers:\n  defaultAccount:\n    anthropic: from-file@example.com\n",
		);
		const storage = await discoverAuthStorage({
			agentDir: dir,
			defaultAccounts: { anthropic: "injected@example.com" },
		});
		cleanups.push(async () => {
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		});
		expect(storage.getDefaultAccountSelector("anthropic")).toBe("injected@example.com");
	});
});
