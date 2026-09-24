/**
 * Shared queries for the fork's credential-selection policy: the durable-row
 * pool a caller (an auth-gateway principal's grant) is allowed to use, kept
 * consistent across selection, ranking, and rotation so every service admits
 * exactly the same rows.
 */
import type { CredentialPool } from "./pool";
import type { AuthCredential, AuthCredentialSelectionPolicy, StoredSelectionCredential } from "./types";

/** True when `selection` does not restrict the pool, or admits row `id`. */
export function isCredentialIdEligible(id: number, selection: AuthCredentialSelectionPolicy | undefined): boolean {
	return selection === undefined || selection.eligibleCredentialIds.includes(id);
}

/**
 * Stored rows of one type the policy admits. Without a policy the pool order
 * is kept; with one, rows follow the policy's preference order and carry their
 * live pool index so block lookups stay positional.
 */
export function eligibleStoredCredentials<T extends AuthCredential["type"]>(
	pool: CredentialPool,
	provider: string,
	type: T,
	selection: AuthCredentialSelectionPolicy | undefined,
	filter?: (credential: AuthCredential) => boolean,
): StoredSelectionCredential<Extract<AuthCredential, { type: T }>>[] {
	const stored = pool.entries(provider);
	const matchAt = (index: number): StoredSelectionCredential<Extract<AuthCredential, { type: T }>> | undefined => {
		const entry = stored[index];
		if (!entry) return undefined;
		const credential = entry.credential;
		if (credential.type !== type) return undefined;
		if (!(filter?.(credential) ?? true)) return undefined;
		return { id: entry.id, credential: credential as Extract<AuthCredential, { type: T }>, index };
	};
	if (!selection) {
		return stored
			.map((_entry, index) => matchAt(index))
			.filter(
				(entry): entry is StoredSelectionCredential<Extract<AuthCredential, { type: T }>> => entry !== undefined,
			);
	}
	const indexById = new Map<number, number>();
	stored.forEach((entry, index) => {
		indexById.set(entry.id, index);
	});
	const credentials: StoredSelectionCredential<Extract<AuthCredential, { type: T }>>[] = [];
	for (const id of selection.eligibleCredentialIds) {
		const index = indexById.get(id);
		if (index === undefined) continue;
		const matched = matchAt(index);
		if (matched) credentials.push(matched);
	}
	return credentials;
}

/** One stored row addressed by durable id, with its current pool position. */
export function findStoredSelectionCredential(
	pool: CredentialPool,
	provider: string,
	credentialId: number,
): StoredSelectionCredential | undefined {
	const stored = pool.entries(provider);
	const index = stored.findIndex(entry => entry.id === credentialId);
	const entry = index >= 0 ? stored[index] : undefined;
	return entry ? { id: entry.id, credential: entry.credential, index } : undefined;
}

/** Policy-admitted rows that still exist in the pool, in policy order. */
export function eligibleSelectionCredentialIds(
	pool: CredentialPool,
	provider: string,
	selection: AuthCredentialSelectionPolicy,
): number[] {
	const currentIds = new Set(pool.entries(provider).map(entry => entry.id));
	return selection.eligibleCredentialIds.filter(id => currentIds.has(id));
}
