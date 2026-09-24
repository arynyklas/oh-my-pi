import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import { selectShard } from "./ci-test-ts";

async function runCiTestTs(args: string[]): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
	planned: string[];
}> {
	const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "ci-test-ts.ts"), ...args], {
		cwd: path.join(import.meta.dir, ".."),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...Bun.env, NO_COLOR: "1" },
	});
	const stdoutPromise = new Response(proc.stdout).text();
	const stderrPromise = new Response(proc.stderr).text();
	try {
		const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
		return {
			stdout,
			stderr,
			exitCode,
			planned: stdout
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(line => line.startsWith("$ ")),
		};
	} finally {
		if (proc.exitCode === null) {
			proc.kill();
			await proc.exited;
		}
	}
}

describe("ci-test-ts coding-agent requested filters", () => {
	// The runner appends `--parallel`/`--timeout` from its own budget, so the
	// stable contract is "exactly one chunk, targeting only the requested file".
	function expectOnlyRequestedCliTest(planned: string[]): void {
		expect(planned).toHaveLength(1);
		expect(planned[0]).toMatch(/^\$ bun test test\/auth-gateway-cli\.test\.ts(?:\s|$)/);
	}

	test("plans a single coding-agent test from package-relative filter", async () => {
		const result = await runCiTestTs(["coding-agent-heavy", "test/auth-gateway-cli.test.ts", "--dry-run", "--full"]);

		expect(result.exitCode).toBe(0);
		expectOnlyRequestedCliTest(result.planned);
	}, 30_000);

	test.each([
		"packages/coding-agent/test/auth-gateway-cli.test.ts",
		"packages\\coding-agent\\test\\auth-gateway-cli.test.ts",
		"test\\auth-gateway-cli.test.ts",
	])(
		"normalizes %s to the package-relative coding-agent command",
		async filter => {
			const result = await runCiTestTs(["coding-agent-heavy", filter, "--dry-run", "--full"]);

			expect(result.exitCode).toBe(0);
			expectOnlyRequestedCliTest(result.planned);
		},
		30_000,
	);

	test("fails when requested coding-agent filters match no tests", async () => {
		const result = await runCiTestTs(["coding-agent-heavy", "test/does-not-exist.test.ts", "--dry-run", "--full"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.planned).toEqual([]);
		expect(result.stderr).toContain("No coding-agent tests matched requested filter(s): test/does-not-exist.test.ts");
	}, 30_000);

	test("fails a mixed coding-agent-heavy request before planning matched tests", async () => {
		const result = await runCiTestTs([
			"coding-agent-heavy",
			"test/auth-gateway-cli.test.ts",
			"test/typo.test.ts",
			"--dry-run",
			"--full",
		]);

		expect(result.exitCode).not.toBe(0);
		expect(result.planned).toEqual([]);
		expect(result.stderr).toContain("No coding-agent tests matched requested filter(s): test/typo.test.ts");
		expect(result.stderr).not.toContain("test/auth-gateway-cli.test.ts");
	}, 30_000);

	test("fails an unmatched all-mode coding-agent request before aggregate plans", async () => {
		const result = await runCiTestTs(["all", "test/typo.test.ts", "--dry-run", "--full"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.planned).toEqual([]);
		expect(result.stderr).toContain("No coding-agent tests matched requested filter(s): test/typo.test.ts");
	}, 30_000);

	test("fails an unmatched local-ts coding-agent request before aggregate plans", async () => {
		const result = await runCiTestTs(["local-ts", "test/typo.test.ts", "--dry-run", "--full"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.planned).toEqual([]);
		expect(result.stderr).toContain("No coding-agent tests matched requested filter(s): test/typo.test.ts");
	}, 30_000);
});

describe("test runner watchdog", () => {
	// Parent fake timers cannot drive the real watchdog inside the isolated runner process.
	test("kills a stalled chunk, reports failure, and continues the queue", async () => {
		using dir = TempDir.createSync("omp-test-runner-watchdog-");
		const started = dir.join("started");
		const completed = dir.join("completed");
		const continued = dir.join("continued");
		const stalledCommand = [
			process.execPath,
			"-e",
			`await Bun.write(${JSON.stringify(started)}, "started"); await Bun.sleep(60_000); await Bun.write(${JSON.stringify(completed)}, "completed");`,
		];
		const nextCommand = [process.execPath, "-e", `await Bun.write(${JSON.stringify(continued)}, "continued");`];
		const commands = [
			{ label: "stalled chunk", cwd: ".", command: stalledCommand },
			{ label: "following chunk", cwd: ".", command: nextCommand },
		];
		const result = await ptree.exec(
			[
				process.execPath,
				"-e",
				`import { runTestCommandsInParallel } from ${JSON.stringify(import.meta.resolve("./ci-test-ts.ts"))}; await runTestCommandsInParallel(${JSON.stringify(commands)}, 1);`,
			],
			{
				env: { ...Bun.env, OMP_TEST_CHUNK_TIMEOUT: "1", NO_COLOR: "1" },
				timeout: 10_000,
				detached: true,
				allowNonZero: true,
			},
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("[watchdog]");
		expect(await Bun.file(started).exists()).toBe(true);
		expect(await Bun.file(completed).exists()).toBe(false);
		expect(await Bun.file(continued).text()).toBe("continued");
	}, 15_000);
});

describe("OMP_TEST_SHARD", () => {
	test("shards partition every chunk exactly once, balanced to within one", () => {
		const chunks = Array.from({ length: 79 }, (_, i) => i);
		const shards = [1, 2, 3].map(i => selectShard(chunks, `${i}/3`));
		expect(shards.flat().sort((a, b) => a - b)).toEqual(chunks);
		const sizes = shards.map(s => s.length);
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
		expect(selectShard(chunks, "1/1")).toEqual(chunks);
		expect(selectShard(chunks, undefined)).toEqual(chunks);
	});

	test("rejects malformed specs instead of running an empty or partial shard", () => {
		for (const spec of ["0/2", "3/2", "1/0", "2", "a/b", "1/2/3"]) {
			expect(() => selectShard([1, 2, 3], spec)).toThrow("Invalid OMP_TEST_SHARD");
		}
	});

	test("rejects a shard that selects no chunks", () => {
		expect(() => selectShard([1], "2/2")).toThrow("selects no chunks");
		expect(() => selectShard([], "1/1")).toThrow("selects no chunks");
	});
});
