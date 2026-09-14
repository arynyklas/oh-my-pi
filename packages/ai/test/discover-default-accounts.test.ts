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

	test("reads nested, flat, and scalar providers.accountPriority forms from config.yml", async () => {
		const nested = await withConfig(
			"providers:\n  accountPriority:\n    anthropic:\n      - first@example.com\n      - second@example.com\n",
		);
		expect(nested.getAccountPrioritySelectors("anthropic")).toEqual(["first@example.com", "second@example.com"]);

		const flat = await withConfig('"providers.accountPriority":\n  anthropic:\n    - flat@example.com\n');
		expect(flat.getAccountPrioritySelectors("anthropic")).toEqual(["flat@example.com"]);

		// A bare string is the one-entry list, so hand-written configs that mirror
		// `providers.defaultAccount` still pin instead of being dropped.
		const scalar = await withConfig("providers:\n  accountPriority:\n    anthropic: only@example.com\n");
		expect(scalar.getAccountPrioritySelectors("anthropic")).toEqual(["only@example.com"]);
	});

	test("injected accountPriorities override config discovery", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-default-account-"));
		await Bun.write(
			path.join(dir, "config.yml"),
			"providers:\n  accountPriority:\n    anthropic:\n      - from-file@example.com\n",
		);
		const storage = await discoverAuthStorage({
			agentDir: dir,
			accountPriorities: { anthropic: ["injected@example.com"] },
		});
		cleanups.push(async () => {
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		});
		expect(storage.getAccountPrioritySelectors("anthropic")).toEqual(["injected@example.com"]);
	});
});
