import { describe, expect, test, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

describe("/account builtin slash command", () => {
	function createAccountHarness() {
		const showAccountManager = vi.fn(async () => {});
		const showStatus = vi.fn();
		const setText = vi.fn();
		const ctx = {
			editor: { setText } as unknown as InteractiveModeContext["editor"],
			showAccountManager,
			showStatus,
		} as unknown as InteractiveModeContext;
		return { runtime: { ctx }, showAccountManager, showStatus, setText };
	}

	test("opens the account manager pane", async () => {
		const harness = createAccountHarness();

		expect(await executeBuiltinSlashCommand("/account", harness.runtime)).toBe(true);

		expect(harness.showAccountManager).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	// One runtime row: every nonempty arg hits the same rejection branch. What
	// the removed verbs need beyond that is (a) the line not escaping as a
	// prompt and (b) their absence from published metadata, both below.
	test("refuses arguments instead of opening the pane or leaking a prompt", async () => {
		const harness = createAccountHarness();

		// `true` means consumed: `false` would send the line to the model.
		expect(await executeBuiltinSlashCommand("/account default me@example.com", harness.runtime)).toBe(true);

		expect(harness.showAccountManager).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith(
			"/account takes no arguments — change the default and priority order in the pane.",
		);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	test("publishes no account subcommands to autocomplete or help", () => {
		const account = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "account");

		expect(account).toBeDefined();
		expect(account?.subcommands).toBeUndefined();
		// Args must stay dispatchable so the rejection above runs at all.
		expect(account?.allowArgs).toBe(true);
	});

	// The ACP/headless surface has no pane, so it would be the one place a
	// removed verb could still be honored — it must refuse without even
	// reaching the provider account lookup.
	test("refuses arguments on the ACP surface without listing accounts", async () => {
		const output = vi.fn(async () => {});
		const listCurrentProviderOAuthAccounts = vi.fn(async () => undefined);
		const runtime = {
			session: { listCurrentProviderOAuthAccounts },
			output,
		} as unknown as SlashCommandRuntime;

		expect(await executeAcpBuiltinSlashCommand("/account priority 2 1", runtime)).toEqual({ consumed: true });

		expect(listCurrentProviderOAuthAccounts).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(
			"/account takes no arguments — change the default and priority order in the pane.",
		);
	});
});
