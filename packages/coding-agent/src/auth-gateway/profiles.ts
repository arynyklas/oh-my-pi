import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizeAuthGatewayAdminUrl } from "@oh-my-pi/pi-ai/auth-gateway";
import { getAuthGatewayProfilesPath, getAuthGatewayTokensDir, isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { resolveConfigValue } from "../config/resolve-config-value";

export const AUTH_GATEWAY_CONNECTION_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

const WINDOWS_DEVICE_BASENAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/;

export type AuthGatewayTokenSource =
	| { type: "file" }
	| { type: "env"; variable: string }
	| { type: "command"; command: string };

export interface AuthGatewayConnectionProfile {
	name: string;
	url: string;
	tokenSource: AuthGatewayTokenSource;
}

export interface AuthGatewayProfilesDocument {
	version: 1;
	activeConnection: string | null;
	connections: AuthGatewayConnectionProfile[];
}

export interface ResolvedAuthGatewayConnection {
	profile: AuthGatewayConnectionProfile;
	token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) throw new Error(`Invalid auth-gateway ${label}: unknown field ${key}`);
	}
}

export function normalizeAuthGatewayConnectionName(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (
		!AUTH_GATEWAY_CONNECTION_NAME_PATTERN.test(normalized) ||
		normalized.endsWith(".") ||
		WINDOWS_DEVICE_BASENAME_PATTERN.test(normalized)
	) {
		throw new Error(`Invalid auth-gateway connection name: ${value}`);
	}
	return normalized;
}

function validateTokenSource(value: unknown): AuthGatewayTokenSource {
	if (!isRecord(value)) throw new Error("Invalid auth-gateway token source");
	const type = value.type;
	if (type === "file") {
		assertKeys(value, ["type"], "token source");
		return { type: "file" };
	}
	if (type === "env") {
		assertKeys(value, ["type", "variable"], "token source");
		if (typeof value.variable !== "string" || value.variable.trim().length === 0) {
			throw new Error("Invalid auth-gateway env token source");
		}
		return { type: "env", variable: value.variable };
	}
	if (type === "command") {
		assertKeys(value, ["type", "command"], "token source");
		if (typeof value.command !== "string" || value.command.trim().length === 0) {
			throw new Error("Invalid auth-gateway command token source");
		}
		return { type: "command", command: value.command };
	}
	throw new Error("Invalid auth-gateway token source");
}

function validateProfile(value: unknown): AuthGatewayConnectionProfile {
	if (!isRecord(value)) throw new Error("Invalid auth-gateway connection profile");
	assertKeys(value, ["name", "url", "tokenSource"], "connection profile");
	if (typeof value.name !== "string") throw new Error("Invalid auth-gateway connection profile name");
	if (typeof value.url !== "string") throw new Error("Invalid auth-gateway connection profile URL");
	return {
		name: normalizeAuthGatewayConnectionName(value.name),
		url: normalizeAuthGatewayAdminUrl(value.url),
		tokenSource: validateTokenSource(value.tokenSource),
	};
}

function sortProfiles(connections: AuthGatewayConnectionProfile[]): AuthGatewayConnectionProfile[] {
	return [...connections].sort((left, right) => left.name.localeCompare(right.name));
}

function validateDocument(value: unknown): AuthGatewayProfilesDocument {
	if (!isRecord(value)) throw new Error("Invalid auth-gateway profiles document");
	assertKeys(value, ["version", "activeConnection", "connections"], "profiles document");
	if (value.version !== 1) throw new Error("Unsupported auth-gateway profiles document version");
	if (value.activeConnection !== null && typeof value.activeConnection !== "string") {
		throw new Error("Invalid auth-gateway active connection");
	}
	if (!Array.isArray(value.connections)) throw new Error("Invalid auth-gateway connections list");

	const seen = new Set<string>();
	const connections = sortProfiles(
		value.connections.map(connection => {
			const profile = validateProfile(connection);
			if (seen.has(profile.name)) throw new Error(`Duplicate auth-gateway connection name: ${profile.name}`);
			seen.add(profile.name);
			return profile;
		}),
	);
	const activeConnection =
		value.activeConnection === null ? null : normalizeAuthGatewayConnectionName(value.activeConnection);
	if (activeConnection !== null && !seen.has(activeConnection)) {
		throw new Error(`Dangling active auth-gateway connection: ${activeConnection}`);
	}
	return { version: 1, activeConnection, connections };
}

async function readDocument(documentPath: string): Promise<AuthGatewayProfilesDocument> {
	try {
		const text = await fs.readFile(documentPath, "utf-8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error("Invalid auth-gateway profiles document JSON");
		}
		return validateDocument(parsed);
	} catch (error) {
		if (isEnoent(error)) return { version: 1, activeConnection: null, connections: [] };
		throw error;
	}
}

async function chmodBestEffort(targetPath: string, mode: number): Promise<void> {
	try {
		await fs.chmod(targetPath, mode);
	} catch {
		// Best-effort on platforms/filesystems that do not support POSIX modes.
	}
}

async function ensurePrivateDir(dirPath: string): Promise<void> {
	await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
	await chmodBestEffort(dirPath, 0o700);
}

async function writeJsonAtomic(documentPath: string, document: AuthGatewayProfilesDocument): Promise<void> {
	const dir = path.dirname(documentPath);
	await ensurePrivateDir(dir);
	const tempPath = path.join(dir, `.auth-gateways.${process.pid}.${randomUUID()}.tmp`);
	const content = `${JSON.stringify(document, null, 2)}\n`;
	try {
		await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
		await chmodBestEffort(tempPath, 0o600);
		await fs.rename(tempPath, documentPath);
		await chmodBestEffort(documentPath, 0o600);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

function tokenPath(tokenDir: string, name: string): string {
	return path.join(tokenDir, `${name}.token`);
}

function profileIndex(document: AuthGatewayProfilesDocument, name: string): number {
	return document.connections.findIndex(connection => connection.name === name);
}

function connectionNames(document: AuthGatewayProfilesDocument): Set<string> {
	return new Set(document.connections.map(connection => connection.name));
}

async function writeManagedTokenFile(filePath: string, token: string): Promise<void> {
	await fs.writeFile(filePath, token, { encoding: "utf-8", mode: 0o600 });
	await chmodBestEffort(filePath, 0o600);
}

async function writeManagedToken(tokenDir: string, name: string, token: string): Promise<void> {
	await ensurePrivateDir(tokenDir);
	await writeManagedTokenFile(tokenPath(tokenDir, name), token);
}

async function stageManagedToken(tokenDir: string, name: string, token: string): Promise<string> {
	await ensurePrivateDir(tokenDir);
	const stagedPath = path.join(tokenDir, `.${name}.${process.pid}.${randomUUID()}.token.tmp`);
	await writeManagedTokenFile(stagedPath, token);
	return stagedPath;
}

async function commitStagedManagedToken(tokenDir: string, name: string, stagedPath: string): Promise<void> {
	const filePath = tokenPath(tokenDir, name);
	await fs.rename(stagedPath, filePath);
	await chmodBestEffort(filePath, 0o600);
}

async function removeManagedToken(tokenDir: string, name: string): Promise<void> {
	await fs.rm(tokenPath(tokenDir, name), { force: true });
}

async function copyManagedToken(tokenDir: string, from: string, to: string): Promise<boolean> {
	await ensurePrivateDir(tokenDir);
	const fromPath = tokenPath(tokenDir, from);
	const toPath = tokenPath(tokenDir, to);
	try {
		await fs.copyFile(fromPath, toPath);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	try {
		const source = await fs.stat(fromPath);
		await chmodBestEffort(toPath, source.mode & 0o777);
	} catch {
		await chmodBestEffort(toPath, 0o600);
	}
	return true;
}

function nextActiveAfterDelete(document: AuthGatewayProfilesDocument, deleted: string): string | null {
	if (document.activeConnection !== deleted) return document.activeConnection;
	return document.connections[0]?.name ?? null;
}

export class AuthGatewayProfileStore {
	readonly #documentPath: string;
	readonly #tokenDir: string;

	constructor(options: { documentPath: string; tokenDir: string }) {
		this.#documentPath = options.documentPath;
		this.#tokenDir = options.tokenDir;
	}

	async #withDocumentLock<T>(fn: () => Promise<T>): Promise<T> {
		await ensurePrivateDir(path.dirname(this.#documentPath));
		return await withFileLock(this.#documentPath, fn);
	}

	static open(options: { documentPath?: string; tokenDir?: string } = {}): AuthGatewayProfileStore {
		return new AuthGatewayProfileStore({
			documentPath: options.documentPath ?? getAuthGatewayProfilesPath(),
			tokenDir: options.tokenDir ?? getAuthGatewayTokensDir(),
		});
	}

	async load(): Promise<AuthGatewayProfilesDocument> {
		return await readDocument(this.#documentPath);
	}

	async list(): Promise<AuthGatewayConnectionProfile[]> {
		return (await this.load()).connections;
	}

	async get(name?: string): Promise<AuthGatewayConnectionProfile | null> {
		const document = await this.load();
		const selected = name === undefined ? document.activeConnection : normalizeAuthGatewayConnectionName(name);
		if (selected === null) return null;
		return document.connections.find(connection => connection.name === selected) ?? null;
	}

	async #commitProfileMutation(
		document: AuthGatewayProfilesDocument,
		originalName: string,
		index: number,
		nextProfile: AuthGatewayConnectionProfile,
		fileToken: string | undefined,
		hadConnections: boolean,
	): Promise<void> {
		const existing = index >= 0 ? document.connections[index] : undefined;
		const previousWasFileToken = existing?.tokenSource.type === "file";
		const nameChanged = originalName !== nextProfile.name;
		let wroteNewFileToken = false;
		let copiedToken = false;
		let stagedTokenPath: string | null = null;

		if (nextProfile.tokenSource.type === "file") {
			if (fileToken === undefined && !previousWasFileToken) {
				throw new Error(`A managed file token is required for auth-gateway connection ${nextProfile.name}`);
			}
			if (fileToken !== undefined) {
				if (previousWasFileToken) {
					stagedTokenPath = await stageManagedToken(this.#tokenDir, nextProfile.name, fileToken);
				} else {
					await writeManagedToken(this.#tokenDir, nextProfile.name, fileToken);
					wroteNewFileToken = true;
				}
			} else if (previousWasFileToken && nameChanged) {
				copiedToken = await copyManagedToken(this.#tokenDir, originalName, nextProfile.name);
			}
		}

		if (index >= 0) {
			document.connections[index] = nextProfile;
		} else {
			document.connections.push(nextProfile);
		}
		document.connections = sortProfiles(document.connections);
		if (!hadConnections) document.activeConnection = nextProfile.name;
		if (nameChanged && document.activeConnection === originalName) document.activeConnection = nextProfile.name;

		try {
			await writeJsonAtomic(this.#documentPath, document);
		} catch (error) {
			if (wroteNewFileToken || copiedToken)
				await removeManagedToken(this.#tokenDir, nextProfile.name).catch(() => {});
			if (stagedTokenPath) await fs.rm(stagedTokenPath, { force: true }).catch(() => {});
			throw error;
		}

		try {
			if (stagedTokenPath) await commitStagedManagedToken(this.#tokenDir, nextProfile.name, stagedTokenPath);
			if (previousWasFileToken && (nameChanged || nextProfile.tokenSource.type !== "file")) {
				await removeManagedToken(this.#tokenDir, originalName);
			}
		} catch (error) {
			if (stagedTokenPath) await fs.rm(stagedTokenPath, { force: true }).catch(() => {});
			throw error;
		}
	}

	async upsert(profile: AuthGatewayConnectionProfile, fileToken?: string): Promise<void> {
		const nextProfile = validateProfile(profile);
		await this.#withDocumentLock(async () => {
			const document = await readDocument(this.#documentPath);
			const hadConnections = document.connections.length > 0;
			const index = profileIndex(document, nextProfile.name);
			await this.#commitProfileMutation(document, nextProfile.name, index, nextProfile, fileToken, hadConnections);
		});
	}

	async updateAndRename(from: string, profile: AuthGatewayConnectionProfile, fileToken?: string): Promise<void> {
		const fromName = normalizeAuthGatewayConnectionName(from);
		const nextProfile = validateProfile(profile);
		await this.#withDocumentLock(async () => {
			const document = await readDocument(this.#documentPath);
			const index = profileIndex(document, fromName);
			if (index < 0) throw new Error(`Unknown auth-gateway connection: ${fromName}`);
			if (fromName !== nextProfile.name && connectionNames(document).has(nextProfile.name)) {
				throw new Error(`Auth-gateway connection already exists: ${nextProfile.name}`);
			}
			await this.#commitProfileMutation(
				document,
				fromName,
				index,
				nextProfile,
				fileToken,
				document.connections.length > 0,
			);
		});
	}

	async rename(from: string, to: string): Promise<void> {
		const fromName = normalizeAuthGatewayConnectionName(from);
		const toName = normalizeAuthGatewayConnectionName(to);
		if (fromName === toName) return;

		await this.#withDocumentLock(async () => {
			const document = await readDocument(this.#documentPath);
			const index = profileIndex(document, fromName);
			if (index < 0) throw new Error(`Unknown auth-gateway connection: ${fromName}`);
			if (connectionNames(document).has(toName))
				throw new Error(`Auth-gateway connection already exists: ${toName}`);

			const current = document.connections[index]!;
			await this.#commitProfileMutation(document, fromName, index, { ...current, name: toName }, undefined, true);
		});
	}

	async delete(name: string): Promise<boolean> {
		const normalized = normalizeAuthGatewayConnectionName(name);
		return await this.#withDocumentLock(async () => {
			const document = await readDocument(this.#documentPath);
			const index = profileIndex(document, normalized);
			if (index < 0) return false;
			const [removed] = document.connections.splice(index, 1);
			document.connections = sortProfiles(document.connections);
			document.activeConnection = nextActiveAfterDelete(document, normalized);
			await writeJsonAtomic(this.#documentPath, document);
			if (removed?.tokenSource.type === "file") await removeManagedToken(this.#tokenDir, normalized);
			return true;
		});
	}

	async setActive(name: string | null): Promise<void> {
		const normalized = name === null ? null : normalizeAuthGatewayConnectionName(name);
		await this.#withDocumentLock(async () => {
			const document = await readDocument(this.#documentPath);
			if (normalized !== null && !connectionNames(document).has(normalized)) {
				throw new Error(`Unknown auth-gateway connection: ${normalized}`);
			}
			document.activeConnection = normalized;
			await writeJsonAtomic(this.#documentPath, document);
		});
	}

	async resolve(name?: string): Promise<ResolvedAuthGatewayConnection> {
		const document = await this.load();
		const selected = name === undefined ? document.activeConnection : normalizeAuthGatewayConnectionName(name);
		if (selected === null) throw new Error("No auth-gateway connection is configured");
		const profile = document.connections.find(connection => connection.name === selected);
		if (!profile) throw new Error(`Unknown auth-gateway connection: ${selected}`);
		const token = await this.#resolveToken(profile);
		return { profile, token };
	}

	async #resolveToken(profile: AuthGatewayConnectionProfile): Promise<string> {
		let value: string | undefined;
		if (profile.tokenSource.type === "file") {
			try {
				value = await fs.readFile(tokenPath(this.#tokenDir, profile.name), "utf-8");
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		} else if (profile.tokenSource.type === "env") {
			value = process.env[profile.tokenSource.variable];
		} else {
			value = await resolveConfigValue(`!${profile.tokenSource.command}`);
		}

		const token = value?.trim();
		if (!token) throw new Error(`No token resolved for auth-gateway connection ${profile.name}`);
		return token;
	}
}
