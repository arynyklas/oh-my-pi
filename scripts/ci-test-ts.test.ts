import { describe, expect, test } from "bun:test";
import path from "node:path";
import { describeChunkFailure } from "./ci-test-ts.ts";

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
	const plannedCliCommand = "$ bun test --parallel=1 test/auth-gateway-cli.test.ts";

	test("plans a single coding-agent test from package-relative filter", async () => {
		const result = await runCiTestTs(["coding-agent-heavy", "test/auth-gateway-cli.test.ts", "--dry-run", "--full"]);

		expect(result.exitCode).toBe(0);
		expect(result.planned).toEqual([plannedCliCommand]);
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
			expect(result.planned).toEqual([plannedCliCommand]);
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

// The two ways a chunk reaches SIGKILL are indistinguishable by exit code, so
// these drive real subprocesses to produce a genuine 137 rather than asserting
// against a hand-written constant.
async function spawnExitCode(script: string): Promise<number> {
	const proc = Bun.spawn(["sh", "-c", script], { stdout: "ignore", stderr: "ignore" });
	return await proc.exited;
}

// Re-hosts the sequential runner's failure tail: spawn, watchdog, attribute.
// `runTestCommand` itself is not injectable (it builds argv from the repo
// layout), so the decision under test is driven directly.
async function runWithWatchdog(script: string, timeoutMs: number): Promise<string> {
	const proc = Bun.spawn(["sh", "-c", script], { stdout: "ignore", stderr: "ignore" });
	let timedOut = false;
	const killTimer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, timeoutMs);
	const exitCode = await proc.exited;
	clearTimeout(killTimer);
	return describeChunkFailure(exitCode, timedOut);
}

describe("describeChunkFailure", () => {
	test("a real SIGKILL that the watchdog did not cause is attributed to the OOM killer", async () => {
		const exitCode = await spawnExitCode("kill -9 $$");
		expect(exitCode).toBe(137);

		const message = describeChunkFailure(exitCode, false);
		expect(message).toContain("OOM killer");
		expect(message).toContain("chunkSize");
		// The old wording carried no cause at all; it must not come back.
		expect(message).not.toBe("failed with exit code 137");
	});

	test("a watchdog kill is attributed to the watchdog, not to memory", async () => {
		const message = await runWithWatchdog("sleep 30", 150);
		expect(message).toContain("chunk watchdog");
		expect(message).toContain("OMP_TEST_CHUNK_TIMEOUT");
		expect(message).not.toContain("OOM killer");
	});

	test("the two SIGKILL causes produce different messages from the same exit code", async () => {
		const oomKilled = describeChunkFailure(137, false);
		const watchdogKilled = describeChunkFailure(137, true);
		expect(oomKilled).not.toBe(watchdogKilled);
	});

	test("an ordinary test failure keeps the plain wording", async () => {
		const exitCode = await spawnExitCode("exit 1");
		expect(exitCode).toBe(1);
		expect(describeChunkFailure(exitCode, false)).toBe("failed with exit code 1");
	});

	test("a bun crash exit keeps the plain wording so the retry log still reads naturally", () => {
		expect(describeChunkFailure(134, false)).toBe("failed with exit code 134");
		expect(describeChunkFailure(139, false)).toBe("failed with exit code 139");
	});

	test("the watchdog message reports the configured timeout", () => {
		const previous = Bun.env.OMP_TEST_CHUNK_TIMEOUT;
		Bun.env.OMP_TEST_CHUNK_TIMEOUT = "42";
		try {
			expect(describeChunkFailure(137, true)).toContain("42s");
		} finally {
			if (previous === undefined) delete Bun.env.OMP_TEST_CHUNK_TIMEOUT;
			else Bun.env.OMP_TEST_CHUNK_TIMEOUT = previous;
		}
	});
});
