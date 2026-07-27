import { describe, expect, test } from "bun:test";
import path from "node:path";

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
