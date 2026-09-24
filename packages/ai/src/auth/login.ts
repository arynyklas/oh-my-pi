/**
 * Shared OAuth/API-key login acquisition used by both
 * {@link OAuthAccounts.login} (which persists) and hosts that run the login
 * wizard themselves (the auth-gateway account console) and persist through a
 * different path. Kept out of `oauth.ts` so callers without an {@link AuthStorage}
 * can import it without pulling the whole account service.
 */
import { untilAborted } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { getProviderDefinition, PASTE_CODE_LOGIN_PROVIDERS } from "../registry";
import { getOAuthProvider } from "../registry/oauth";
import type { OAuthController, OAuthCredentials, OAuthProviderId } from "../registry/oauth/types";
import type { AcquiredAuthCredential, AuthCredential } from "./types";

/**
 * Drive a provider's interactive login and return the credential it produced,
 * or `null` when the flow was cancelled or produced no key (an empty paste at
 * an optional-key prompt). Does NOT persist — the caller decides where the
 * credential goes, which is why an aborted flow reports `null` here while
 * {@link OAuthAccounts.login} must still reject with
 * {@link AIError.LoginCancelledError}.
 */
export async function acquireAuthCredential(
	provider: OAuthProviderId,
	controller: OAuthController,
): Promise<AcquiredAuthCredential | null> {
	// Only paste-code providers (fixed non-loopback redirect, e.g. GitLab Duo
	// Agent's vscode:// URI) get a default manual-code prompt. For loopback OAuth
	// providers an eager paste prompt adds noise to a flow that normally completes
	// through HTTP. Synthesizing the default only for paste-code providers is the
	// authoritative gate (it covers every caller, not
	// just the CLI); an explicit caller-supplied `onManualCodeInput` is still
	// honored for any provider as an escape hatch.
	const manualCodeInput = PASTE_CODE_LOGIN_PROVIDERS.has(provider)
		? (signal?: AbortSignal) =>
				untilAborted(
					signal,
					() =>
						controller.onPrompt?.({ message: "Paste the authorization code (or full redirect URL):" }) ??
						Promise.resolve(""),
				)
		: undefined;
	// Built-in registry first, then runtime-registered extension providers.
	const def = getProviderDefinition(provider) ?? getOAuthProvider(provider);
	if (!def?.login) {
		throw new AIError.ConfigurationError(`Unknown OAuth provider: ${provider}`);
	}
	const storageProvider = def.storeCredentialsAs ?? provider;
	let result: OAuthCredentials | string;
	try {
		result = await def.login({
			onAuth: controller.onAuth!,
			onProgress: controller.onProgress,
			onPrompt: controller.onPrompt!,
			onManualCodeInput: controller.onManualCodeInput ?? manualCodeInput,
			onBrowserSession: controller.onBrowserSession,
			signal: controller.signal,
			fetch: controller.fetch,
		});
	} catch (error) {
		if (error instanceof AIError.LoginCancelledError) return null;
		throw error;
	}
	if (typeof result === "string") {
		// Some flows (e.g. ollama) return "" to signal that no key was entered.
		if (!result) return null;
		const credential: AuthCredential = { type: "api_key", key: result };
		return { provider: storageProvider, credential };
	}
	const credential: AuthCredential = { type: "oauth", ...result };
	return { provider: storageProvider, credential };
}
