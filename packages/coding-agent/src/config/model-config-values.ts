import { execSync } from "node:child_process";
import { $envExact } from "@oh-my-pi/pi-utils";

// Successful command-backed secrets are cached briefly to avoid an execSync on
// every request, but must be reread after external credential rotation.
const COMMAND_SUCCESS_CACHE_MS = 30_000;
const commandValueCache = new Map<string, { expiresAt: number; value: string }>();
// Failed `!command` resolutions (non-zero exit, empty stdout) are negative-cached
// with a TTL instead of forever: a transient failure (locked password manager,
// network hiccup) must not disable the key until process restart, but re-running
// the command on every resolution would restore the execSync storm this cache
// exists to prevent. One probe per TTL window bounds both.
const COMMAND_FAILURE_RETRY_MS = 30_000;
const commandFailureRetryAt = new Map<string, number>();

export function isCommandConfigValue(valueConfig: string | undefined): valueConfig is string {
	return valueConfig?.startsWith("!") === true;
}

/** Drops every memoized `!command` result so the next resolve re-runs the command. */
export function clearCommandValueCaches(): void {
	commandValueCache.clear();
	commandFailureRetryAt.clear();
}

function resolveCommandConfig(command: string): string | undefined {
	const now = Date.now();
	const cached = commandValueCache.get(command);
	if (cached !== undefined && now < cached.expiresAt) return cached.value;
	if (cached !== undefined) commandValueCache.delete(command);
	const retryAt = commandFailureRetryAt.get(command);
	if (retryAt !== undefined && now < retryAt) return undefined;
	try {
		const stdout = execSync(command, { encoding: "utf8", timeout: 10_000, windowsHide: true });
		const trimmed = stdout.trim();
		if (trimmed.length === 0) {
			commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
			return undefined;
		}
		commandFailureRetryAt.delete(command);
		commandValueCache.set(command, { expiresAt: Date.now() + COMMAND_SUCCESS_CACHE_MS, value: trimmed });
		return trimmed;
	} catch {
		commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
		return undefined;
	}
}

export interface CommandApiKeyResolution {
	configured: boolean;
	value?: string;
}
/**
 * Resolve a models.yml/models.yaml secret/config value to an actual value.
 * `!cmd` runs a shell command and returns trimmed stdout, otherwise env vars are
 * checked first and the input falls back to a literal value.
 */
export function resolveConfigValue(valueConfig: string): string | undefined {
	if (valueConfig.startsWith("!")) return resolveCommandConfig(valueConfig.slice(1).trim());
	const envValue = $envExact(valueConfig);
	if (envValue) return envValue;
	return valueConfig;
}

export type HeaderSource = Record<string, string> | undefined;

interface HeaderResolutionOptions {
	authHeader?: boolean;
	apiKeyConfig?: string;
	/**
	 * Drops an `Authorization` header carried by the FIRST source. Discovery
	 * caches replay the header the provider was originally reached with; when a
	 * models.yml override supplies auth itself that stale bearer must not win
	 * over the freshly resolved one.
	 */
	dropAuthorizationFromFirstSource?: boolean;
}

function materializeConfigHeaderSources(
	sources: readonly HeaderSource[],
	options?: HeaderResolutionOptions,
): Record<string, string> | undefined {
	const resolved: Record<string, string> = {};
	for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
		const source = sources[sourceIndex];
		if (!source) continue;
		for (const [key, value] of Object.entries(source)) {
			if (options?.dropAuthorizationFromFirstSource && sourceIndex === 0 && key.toLowerCase() === "authorization") {
				continue;
			}
			const next = resolveConfigValue(value);
			if (next) resolved[key] = next;
		}
	}
	if (options?.authHeader && options.apiKeyConfig) {
		const resolvedKey = resolveConfigValue(options.apiKeyConfig);
		if (resolvedKey) resolved.Authorization = `Bearer ${resolvedKey}`;
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function createLiveConfigHeaders(
	sources: readonly HeaderSource[],
	options?: HeaderResolutionOptions,
): Record<string, string> | undefined {
	const hasSources = sources.some(source => source !== undefined);
	if (!hasSources && (!options?.authHeader || !options.apiKeyConfig)) return undefined;

	const localHeaders: Record<string, string> = {};
	const allSources = [...sources, localHeaders];
	const current = () => materializeConfigHeaderSources(allSources, options) ?? {};
	return new Proxy(localHeaders, {
		get(target, property, receiver) {
			if (typeof property !== "string") return Reflect.get(target, property, receiver);
			return current()[property];
		},
		set(target, property, value) {
			if (typeof property !== "string" || typeof value !== "string") return false;
			target[property] = value;
			return true;
		},
		deleteProperty(target, property) {
			if (typeof property !== "string") return false;
			delete target[property];
			return true;
		},
		has(_target, property) {
			if (typeof property !== "string") return false;
			return Object.hasOwn(current(), property);
		},
		ownKeys() {
			return Reflect.ownKeys(current());
		},
		getOwnPropertyDescriptor(_target, property) {
			if (typeof property !== "string") return undefined;
			const headers = current();
			if (!Object.hasOwn(headers, property)) return undefined;
			return {
				configurable: true,
				enumerable: true,
				value: headers[property],
				writable: true,
			};
		},
	});
}
