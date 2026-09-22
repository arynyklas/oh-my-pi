import { beforeAll, describe, expect, it } from "bun:test";
import {
	type AccountManagerActionResult,
	type AccountManagerEventRow,
	type AccountManagerOptions,
	AccountManagerSelectorComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/account-manager-selector";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { toSessionPinAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/session-pin";
import type { SessionPinAccount } from "@oh-my-pi/pi-tui/overlays/session-account-selector";

beforeAll(async () => {
	await initTheme();
});

const WIDTH = 120;
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";
const DOWN = "\x1b[B";
const ENTER = "\r";
const LOG = "l";

/** Three stored accounts; the middle one is the session's active credential. */
const STORED_ACCOUNTS = [
	{ position: 0, credentialId: 11, email: "first@example.com", active: false },
	{ position: 1, credentialId: 12, email: "second@example.com", active: true },
	{ position: 2, credentialId: 13, email: "third@example.com", active: false },
];

interface HarnessConfig {
	/** Oldest-first, exactly as `AuthStorage.listAccountSelectionEvents` hands them over. */
	events?: readonly AccountManagerEventRow[];
	/** Credential ids in priority order; `onMove` rewrites this live. */
	priority?: readonly number[];
	defaultCredentialId?: number;
	quotaFor?: (account: SessionPinAccount) => string | undefined;
	setDefaultResult?: AccountManagerActionResult;
}

interface Harness {
	component: AccountManagerSelectorComponent;
	accounts: readonly SessionPinAccount[];
	/** Mutated by the component's move callback, so re-reads show the new order. */
	priority: number[];
	moves: { label: string; delta: -1 | 1 }[];
	defaults: string[];
	content: () => string[];
}

/**
 * Mirrors how `SelectorController.showAccountManager` wires the pane: every
 * getter is re-read on repaint and the mutation callbacks edit the fixture
 * state the getters read from.
 */
function makeHarness(config: HarnessConfig = {}): Harness {
	const accounts = toSessionPinAccounts(STORED_ACCOUNTS);
	const priority = [...(config.priority ?? [])];
	const events = config.events ?? [];
	const moves: { label: string; delta: -1 | 1 }[] = [];
	const defaults: string[] = [];
	const quotaFor = config.quotaFor ?? ((): string | undefined => undefined);
	const options: AccountManagerOptions = {
		providerName: "Anthropic",
		credentialSource: undefined,
		accounts: () => accounts,
		events: () => events,
		quotaFor,
		isDefault: account => account.credentialId === config.defaultCredentialId,
		priorityRank: account => {
			const index = priority.indexOf(account.credentialId);
			return index >= 0 ? index + 1 : undefined;
		},
		onSetDefault: account => {
			defaults.push(account.label);
			return config.setDefaultResult;
		},
		onClearDefault: () => undefined,
		onMove: (account, delta) => {
			moves.push({ label: account.label, delta });
			const index = priority.indexOf(account.credentialId);
			const target = index + delta;
			if (index >= 0 && target >= 0 && target < priority.length) {
				const [moved] = priority.splice(index, 1);
				if (moved !== undefined) priority.splice(target, 0, moved);
			}
			return undefined;
		},
		onCancel: () => {},
		requestRender: () => {},
	};
	const component = new AccountManagerSelectorComponent(options);
	return {
		component,
		accounts,
		priority,
		moves,
		defaults,
		content: () => component.renderContent(WIDTH).map(line => Bun.stripANSI(line).trimEnd()),
	};
}

function accountAt(harness: Harness, index: number): SessionPinAccount {
	const account = harness.accounts[index];
	if (!account) throw new Error(`fixture is missing account ${index}`);
	return account;
}

function rowFor(lines: readonly string[], label: string): string {
	return lines.find(line => line.includes(label)) ?? "";
}

const OLDER_AT = Date.UTC(2026, 2, 4, 9, 30, 15);
const NEWER_AT = OLDER_AT + 90_000;

describe("AccountManagerSelectorComponent", () => {
	it("marks the active, default and priority-ranked accounts and starts on the active row", () => {
		const harness = makeHarness({
			defaultCredentialId: 13,
			priority: [12, 11],
			quotaFor: account => (account.active ? "5h 12% left" : undefined),
		});
		const first = accountAt(harness, 0);
		const second = accountAt(harness, 1);
		const third = accountAt(harness, 2);
		const lines = harness.content();

		// Every stored account is listed with its 1-based storage position.
		expect(rowFor(lines, first.label)).toContain("1. ");
		expect(rowFor(lines, second.label)).toContain("2. ");
		expect(rowFor(lines, third.label)).toContain("3. ");

		// The session's credential is the highlighted row and the only "active" one.
		expect(harness.component.selectedAccount?.credentialId).toBe(12);
		expect(rowFor(lines, second.label)).toContain(theme.nav.cursor);
		expect(rowFor(lines, second.label)).toContain("active");
		expect(rowFor(lines, first.label)).not.toContain("active");
		expect(rowFor(lines, third.label)).not.toContain("active");

		// Default marker follows `isDefault`, not the active row.
		expect(rowFor(lines, third.label)).toContain("★ default");
		expect(rowFor(lines, second.label)).not.toContain("default");

		// Priority positions come from priorityRank; the unranked row shows none.
		expect(rowFor(lines, second.label)).toContain("priority 1");
		expect(rowFor(lines, first.label)).toContain("priority 2");
		expect(rowFor(lines, third.label)).not.toContain("priority");

		// Quota and the in-use note hang under the row they describe.
		const activeRow = lines.indexOf(rowFor(lines, second.label));
		expect(lines[activeRow + 1]).toContain("5h 12% left");
		expect(lines[activeRow + 2]).toContain("in use by this session");
		expect(lines.filter(line => line.includes("in use by this session"))).toHaveLength(1);
	});

	it("moves the highlighted account through onMove and repaints the new priority order", () => {
		const harness = makeHarness({ priority: [11, 12] });
		const first = accountAt(harness, 0);
		const second = accountAt(harness, 1);

		expect(rowFor(harness.content(), second.label)).toContain("priority 2");

		harness.component.handleInput(SHIFT_UP);
		expect(harness.moves).toEqual([{ label: second.label, delta: -1 }]);
		expect(harness.priority).toEqual([12, 11]);
		const promoted = harness.content();
		expect(rowFor(promoted, second.label)).toContain("priority 1");
		expect(rowFor(promoted, first.label)).toContain("priority 2");

		harness.component.handleInput(SHIFT_DOWN);
		expect(harness.moves).toEqual([
			{ label: second.label, delta: -1 },
			{ label: second.label, delta: 1 },
		]);
		const demoted = harness.content();
		expect(rowFor(demoted, second.label)).toContain("priority 2");
		expect(rowFor(demoted, first.label)).toContain("priority 1");

		// Reordering never moves the cursor off the account being reordered.
		expect(harness.component.selectedAccount?.credentialId).toBe(12);
	});

	it("collapses the session log to a count and expands it newest-first on l", () => {
		const events: AccountManagerEventRow[] = [
			{
				origin: "main",
				event: { atMs: OLDER_AT, provider: "anthropic", credentialId: 11, reason: "pinned-default" },
			},
			{
				origin: "reviewer",
				event: {
					atMs: NEWER_AT,
					provider: "anthropic",
					previousCredentialId: 11,
					credentialId: 12,
					reason: "fallover-blocked",
					detail: "default blocked, retry in 42m",
				},
			},
		];
		const harness = makeHarness({ events });
		const first = accountAt(harness, 0);
		const second = accountAt(harness, 1);

		const collapsed = harness.content();
		expect(collapsed).toContain("Session account changes: 2 — l to expand");
		expect(collapsed.some(line => line.includes("fallover-blocked"))).toBe(false);

		harness.component.handleInput(LOG);
		const expanded = harness.content();
		expect(expanded.some(line => line.includes("l to expand"))).toBe(false);
		expect(expanded).toContain("Session account changes");

		const advisorRow = expanded.findIndex(line => line.includes("fallover-blocked"));
		const mainRow = expanded.findIndex(line => line.includes("pinned-default"));
		expect(advisorRow).toBeGreaterThanOrEqual(0);
		// Newest change leads, even though the getter hands rows over oldest-first.
		expect(advisorRow).toBeLessThan(mainRow);

		// The advisor row names its origin session and resolves both credential ids.
		const switchedAt = new Date(NEWER_AT);
		const clock = [switchedAt.getHours(), switchedAt.getMinutes(), switchedAt.getSeconds()]
			.map(part => String(part).padStart(2, "0"))
			.join(":");
		expect(expanded[advisorRow]).toContain(clock);
		expect(expanded[advisorRow]).toContain("anthropic");
		expect(expanded[advisorRow]).toContain("reviewer");
		expect(expanded[advisorRow]).toContain(`${first.label} → ${second.label}`);
		expect(expanded[advisorRow + 1]).toContain("default blocked, retry in 42m");

		// A first-ever selection has no previous credential.
		expect(expanded[mainRow]).toContain("main");
		expect(expanded[mainRow]).toContain(`none → ${first.label}`);

		harness.component.handleInput(LOG);
		expect(harness.content()).toContain("Session account changes: 2 — l to expand");
	});

	it("sets the default from the highlighted row and surfaces the returned result until navigation", () => {
		const harness = makeHarness({
			// Multi-line failure text has to collapse into the single status row.
			setDefaultResult: { message: "second@example.com is no longer\navailable (selector 2).", tone: "error" },
		});
		const second = accountAt(harness, 1);

		harness.component.handleInput(ENTER);
		expect(harness.defaults).toEqual([second.label]);

		const afterEnter = harness.content();
		const statusRows = afterEnter.filter(line => line.includes("is no longer"));
		expect(statusRows).toHaveLength(1);
		expect(statusRows[0]).toContain("second@example.com is no longer available (selector 2).");

		// Moving the cursor drops the stale result and retargets the callback.
		harness.component.handleInput(DOWN);
		expect(harness.content().some(line => line.includes("is no longer"))).toBe(false);
		harness.component.handleInput(ENTER);
		expect(harness.defaults).toEqual([second.label, accountAt(harness, 2).label]);
	});
});
