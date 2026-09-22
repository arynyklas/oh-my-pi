import type { AccountSelectionEvent } from "@oh-my-pi/pi-ai";
import { extractPrintableText, matchesKey, Spacer, TruncatedText } from "@oh-my-pi/pi-tui";
import type { SessionPinAccount } from "@oh-my-pi/pi-tui/overlays/session-account-selector";
import { sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "@oh-my-pi/pi-tui/keybinding-matchers";
import { OverlayPanel, PanelDivider } from "@oh-my-pi/pi-tui/chrome/overlay-box";

/** Accounts shown at once before the list windows around the cursor. */
const ACCOUNT_WINDOW = 8;
/** Newest selection events rendered when the change-log pane is expanded. */
const EVENT_WINDOW = 8;

const KEY_HINT = "↑/↓ select · ↵ default · d clear · Shift+↑/↓ or [ ] reorder · l log · Esc close";

/**
 * Outcome of a mutation triggered from the account manager. `message` is shown
 * in the pane's status row; `tone` picks its color. Returning `undefined` means
 * "nothing to report".
 */
export interface AccountManagerActionResult {
	message: string;
	tone: "info" | "warning" | "error";
}

/**
 * One session account-change entry with the provider-session it belongs to.
 * Advisors run on their own provider-session ids, so the log has to name the
 * origin (`main` or the advisor slug) or two rows look identical.
 */
export interface AccountManagerEventRow {
	origin: string;
	event: AccountSelectionEvent;
}

/** Live state + mutations the account manager renders and drives. */
export interface AccountManagerOptions {
	providerName: string;
	/** `authStorage.describeCredentialSource()` for the provider, when known. */
	credentialSource: string | undefined;
	/** Stored accounts, re-read on every repaint so an edit's effect shows at once. */
	accounts: () => readonly SessionPinAccount[];
	/** Session selection rows sorted oldest-first; read live on every repaint. */
	events: () => readonly AccountManagerEventRow[];
	/** Compact quota line for one account, or `undefined` when usage is unavailable. */
	quotaFor: (account: SessionPinAccount) => string | undefined;
	/** True when the account is the provider's pinned default right now. */
	isDefault: (account: SessionPinAccount) => boolean;
	/** 1-based position in the provider's priority order, or `undefined` when unranked. */
	priorityRank: (account: SessionPinAccount) => number | undefined;
	onSetDefault: (account: SessionPinAccount) => AccountManagerActionResult | undefined;
	onClearDefault: () => AccountManagerActionResult | undefined;
	onMove: (account: SessionPinAccount, delta: -1 | 1) => AccountManagerActionResult | undefined;
	onCancel: () => void;
	requestRender: () => void;
}

function formatEventTime(atMs: number): string {
	const at = new Date(atMs);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * Interactive `/account` pane: every stored OAuth account for the current
 * provider with its active/default/priority markers and quota, plus a
 * collapsed-by-default log of this session's account switches. Enter pins the
 * default, `d` clears it and Shift+↑/↓ (or `[`/`]`) rewrites the priority order;
 * the pane stays open across mutations so several edits need one invocation.
 */
export class AccountManagerSelectorComponent extends OverlayPanel {
	#options: AccountManagerOptions;
	#accounts: readonly SessionPinAccount[];
	#accountsByCredentialId = new Map<number, SessionPinAccount>();
	#selectedIndex = 0;
	#showLog = false;
	#status: AccountManagerActionResult | undefined;

	constructor(options: AccountManagerOptions) {
		super(`Accounts — ${sanitizeStatusText(options.providerName)}`);
		this.#options = options;
		this.#accounts = options.accounts();
		const activeIndex = this.#accounts.findIndex(account => account.active);
		if (activeIndex >= 0) this.#selectedIndex = activeIndex;
		this.#update();
	}

	get selectedAccount(): SessionPinAccount | undefined {
		return this.#accounts[this.#selectedIndex];
	}

	#line(text: string): void {
		this.addChild(new TruncatedText(text, 0, 0));
	}

	#accountRow(account: SessionPinAccount, index: number): void {
		const selected = index === this.#selectedIndex;
		const rank = this.#options.priorityRank(account);
		const label = sanitizeStatusText(account.label);
		const markers: string[] = [];
		if (account.active) markers.push(theme.fg("success", `${theme.status.success} active`));
		if (this.#options.isDefault(account)) markers.push(theme.fg("accent", "★ default"));
		if (rank !== undefined) markers.push(theme.fg("muted", `priority ${rank}`));
		const number = `${account.position + 1}.`;
		const head = selected
			? `${theme.fg("accent", `${theme.nav.cursor} `)}${theme.fg("accent", `${number} ${label}`)}`
			: `  ${number} ${label}`;
		this.#line(markers.length > 0 ? `${head}  ${markers.join("  ")}` : head);

		const quota = this.#options.quotaFor(account);
		if (quota) this.#line(theme.fg("dim", `      ${sanitizeStatusText(quota)}`));
		if (account.active) {
			this.#line(theme.fg("dim", "      in use by this session"));
		}
	}

	#eventLabel(credentialId: number | undefined, email?: string, accountId?: string): string {
		if (credentialId === undefined) return "none";
		const known = this.#accountsByCredentialId.get(credentialId);
		if (known) return sanitizeStatusText(known.label);
		const fallback = email || accountId;
		return fallback ? sanitizeStatusText(fallback) : `#${credentialId}`;
	}

	#logPane(): void {
		const events = this.#options.events();
		this.addChild(new PanelDivider());
		if (!this.#showLog) {
			const count = events.length;
			this.#line(
				theme.fg(
					"muted",
					count === 0
						? "Session account changes: none — l to expand"
						: `Session account changes: ${count} — l to expand`,
				),
			);
			return;
		}
		this.#line(theme.fg("muted", theme.bold("Session account changes")));
		if (events.length === 0) {
			this.#line(theme.fg("dim", "  No account changes this session."));
			return;
		}
		// AuthStorage hands back oldest-first; the newest switch is the one the
		// user is trying to explain, so it leads.
		const newestFirst = [...events].reverse();
		const shown = newestFirst.slice(0, EVENT_WINDOW);
		for (const { origin, event } of shown) {
			const from = this.#eventLabel(event.previousCredentialId);
			const to = this.#eventLabel(event.credentialId, event.email, event.accountId);
			const head = `  ${formatEventTime(event.atMs)} ${sanitizeStatusText(event.provider)} ${sanitizeStatusText(origin)}  ${from} → ${to}`;
			this.#line(`${theme.fg("dim", head)}  ${theme.fg("muted", sanitizeStatusText(event.reason))}`);
			if (event.detail) this.#line(theme.fg("dim", `           ${sanitizeStatusText(event.detail)}`));
		}
		const hidden = newestFirst.length - shown.length;
		if (hidden > 0) this.#line(theme.fg("dim", `  +${hidden} older change${hidden === 1 ? "" : "s"}`));
	}

	#update(): void {
		this.clear();

		const source = this.#options.credentialSource;
		this.#line(
			theme.fg(
				"muted",
				source
					? `credentials from ${sanitizeStatusText(source)}`
					: "credentials from stored OAuth logins (/login adds more)",
			),
		);
		this.addChild(new Spacer(1));

		const accounts = this.#options.accounts();
		this.#accounts = accounts;
		this.#accountsByCredentialId = new Map(accounts.map(account => [account.credentialId, account]));
		const total = accounts.length;
		if (total > 0) this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, total - 1));
		if (total === 0) {
			this.#line(theme.fg("dim", "No stored OAuth accounts for this provider."));
		} else {
			const start =
				total <= ACCOUNT_WINDOW
					? 0
					: Math.max(0, Math.min(this.#selectedIndex - Math.floor(ACCOUNT_WINDOW / 2), total - ACCOUNT_WINDOW));
			const end = Math.min(start + ACCOUNT_WINDOW, total);
			for (let index = start; index < end; index++) {
				const account = accounts[index];
				if (account) this.#accountRow(account, index);
			}
			if (total > ACCOUNT_WINDOW) {
				this.#line(theme.fg("dim", `showing ${start + 1}-${end} of ${total}`));
			}
		}

		this.#logPane();

		this.addChild(new PanelDivider());
		this.#line(theme.fg("muted", KEY_HINT));
		const status = this.#status;
		if (status) {
			const color = status.tone === "error" ? "error" : status.tone === "warning" ? "warning" : "success";
			this.#line(theme.fg(color, sanitizeStatusText(status.message)));
		}
	}

	/** Re-read the live callbacks and repaint (after an external mutation). */
	refresh(): void {
		this.#update();
		this.#options.requestRender();
	}

	#apply(result: AccountManagerActionResult | undefined): void {
		this.#status = result;
		this.refresh();
	}

	#move(delta: -1 | 1): void {
		const account = this.selectedAccount;
		if (!account) return;
		this.#apply(this.#options.onMove(account, delta));
	}

	handleInput(keyData: string): void {
		if (matchesSelectCancel(keyData)) {
			this.#options.onCancel();
			return;
		}
		if (matchesKey(keyData, "shift+up")) {
			this.#move(-1);
			return;
		}
		if (matchesKey(keyData, "shift+down")) {
			this.#move(1);
			return;
		}
		if (matchesSelectUp(keyData)) {
			const total = this.#accounts.length;
			if (total > 0) this.#selectedIndex = this.#selectedIndex === 0 ? total - 1 : this.#selectedIndex - 1;
			this.#status = undefined;
			this.refresh();
			return;
		}
		if (matchesSelectDown(keyData)) {
			const total = this.#accounts.length;
			if (total > 0) this.#selectedIndex = this.#selectedIndex === total - 1 ? 0 : this.#selectedIndex + 1;
			this.#status = undefined;
			this.refresh();
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const account = this.selectedAccount;
			if (!account) return;
			this.#apply(this.#options.onSetDefault(account));
			return;
		}
		const printable = extractPrintableText(keyData);
		if (printable === "[") {
			this.#move(-1);
			return;
		}
		if (printable === "]") {
			this.#move(1);
			return;
		}
		if (printable === "d") {
			this.#apply(this.#options.onClearDefault());
			return;
		}
		if (printable === "l") {
			this.#showLog = !this.#showLog;
			this.#status = undefined;
			this.refresh();
		}
	}
}
