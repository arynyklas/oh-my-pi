import type { Settings } from "../../config/settings";
import type { AuthStorage, OAuthAccountSummary } from "../../session/auth-storage";

/**
 * Everything the account-priority mutations need: the settings file they
 * persist to and the live AuthStorage they apply to, scoped to one provider.
 * Shared by the `/account` TUI and the non-interactive `/account` subcommands
 * so both write the exact same pair of keys.
 */
export interface AccountPriorityContext {
	settings: Settings;
	authStorage: AuthStorage;
	providerId: string;
}

/**
 * Most portable selector string that resolves to exactly one stored row, as
 * decided by AuthStorage — a bare email is ambiguous when two credentials share
 * it under different orgs, so hand-deriving the selector would write a pin that
 * AuthStorage then refuses to resolve. Falls back to the `#<credentialId>` form.
 */
export function resolveAccountSelector(ctx: AccountPriorityContext, credentialId: number): string {
	return ctx.authStorage.describeAccountSelector(ctx.providerId, credentialId) ?? `#${credentialId}`;
}

/**
 * True when a stored selector string identifies `account`. A priority list can
 * hold an account under any of its identity fields (email, account id, project
 * id, enterprise URL, `#<credentialId>`), so reordering must recognize all of
 * them instead of only the canonical {@link resolveAccountSelector} form.
 */
export function selectorMatchesAccount(selector: string, account: OAuthAccountSummary): boolean {
	const wanted = selector.trim().toLowerCase();
	if (!wanted) return false;
	if (wanted === `#${account.credentialId}`) return true;
	return [account.email, account.accountId, account.projectId, account.enterpriseUrl].some(
		value => value?.trim().toLowerCase() === wanted,
	);
}

function writeDefaultAccountSelector(ctx: AccountPriorityContext, selector: string | undefined): void {
	const current = { ...ctx.settings.get("providers.defaultAccount") };
	if (selector === undefined) delete current[ctx.providerId];
	else current[ctx.providerId] = selector;
	ctx.settings.set("providers.defaultAccount", current);
	ctx.authStorage.setDefaultAccountSelector(ctx.providerId, selector);
}

/**
 * Persist an ordered priority list for the provider and apply it live. An empty
 * list removes the provider key entirely (nothing is ranked); a non-empty list
 * also republishes its head through `providers.defaultAccount`, because the
 * head of the priority list *is* the pinned default and the two keys must never
 * disagree.
 */
export function applyAccountPriority(ctx: AccountPriorityContext, selectors: readonly string[]): void {
	const current = { ...ctx.settings.get("providers.accountPriority") };
	if (selectors.length === 0) {
		delete current[ctx.providerId];
		ctx.settings.set("providers.accountPriority", current);
		ctx.authStorage.setAccountPrioritySelectors(ctx.providerId, undefined);
		return;
	}
	current[ctx.providerId] = [...selectors];
	ctx.settings.set("providers.accountPriority", current);
	ctx.authStorage.setAccountPrioritySelectors(ctx.providerId, selectors);
	const head = selectors[0];
	if (head !== undefined) writeDefaultAccountSelector(ctx, head);
}

/**
 * Pin `account` as the provider's default. With no priority list this is the
 * plain single-pin write; with a list the account is moved to position 1 (its
 * head), since a divergent `providers.defaultAccount` would be shadowed by the
 * list head and silently ignored.
 */
export function setDefaultAccount(ctx: AccountPriorityContext, account: OAuthAccountSummary): string {
	const selector = resolveAccountSelector(ctx, account.credentialId);
	const priority = ctx.authStorage.getAccountPrioritySelectors(ctx.providerId);
	if (priority.length === 0) {
		writeDefaultAccountSelector(ctx, selector);
		return selector;
	}
	const rest = priority.filter(entry => !selectorMatchesAccount(entry, account));
	applyAccountPriority(ctx, [selector, ...rest]);
	return selector;
}

/**
 * Unpin the provider's default. When a priority list exists its head is the
 * default, so clearing drops the whole list — otherwise the next request would
 * still be pinned by the list.
 */
export function clearDefaultAccount(ctx: AccountPriorityContext): boolean {
	const priority = ctx.authStorage.getAccountPrioritySelectors(ctx.providerId);
	const hadPriority = priority.length > 0;
	if (hadPriority) applyAccountPriority(ctx, []);
	writeDefaultAccountSelector(ctx, undefined);
	return hadPriority;
}

/** Outcome of a priority move: whether anything changed and the resulting rank. */
export interface AccountPriorityMove {
	moved: boolean;
	/** 1-based rank of the account after the move. */
	rank: number;
	/** Total number of ranked accounts after the move. */
	total: number;
}

/**
 * Move `account` one slot earlier (`delta === -1`) or later (`delta === 1`) in
 * the provider's priority order. An account that is not ranked yet counts as
 * sitting just past the end of the list, so a first move inserts it at the
 * target position instead of doing nothing.
 */
export function moveAccountPriority(
	ctx: AccountPriorityContext,
	account: OAuthAccountSummary,
	delta: -1 | 1,
): AccountPriorityMove {
	const list = [...ctx.authStorage.getAccountPrioritySelectors(ctx.providerId)];
	const index = list.findIndex(entry => selectorMatchesAccount(entry, account));
	if (index >= 0) {
		const target = index + delta;
		if (target < 0 || target >= list.length) return { moved: false, rank: index + 1, total: list.length };
		const [entry] = list.splice(index, 1);
		list.splice(target, 0, entry!);
		applyAccountPriority(ctx, list);
		return { moved: true, rank: target + 1, total: list.length };
	}
	// Unranked accounts rank behind every listed one; clamp the implicit slot.
	const target = Math.max(0, Math.min(list.length + delta, list.length));
	list.splice(target, 0, resolveAccountSelector(ctx, account.credentialId));
	applyAccountPriority(ctx, list);
	return { moved: true, rank: target + 1, total: list.length };
}
