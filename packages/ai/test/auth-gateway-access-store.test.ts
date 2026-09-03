import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthGatewayAccessError,
	type AuthGatewayAuditEvent,
	evaluateAuthGatewayAccess,
	evaluateAuthGatewayRouteAccess,
	resolveAuthGatewayPoolSelection,
	SqliteAuthGatewayAccessStore,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { removeWithRetries } from "../../utils/src/temp";

interface CountRow {
	count: number;
}

interface VersionRow {
	version: number;
}

interface PoolCredentialRow {
	credential_id: number;
	position: number;
	created_at: number;
}

interface TableColumnRow {
	name: string;
}

interface UserPoolBindingRow {
	user_id: number;
	pool_id: number;
	position: number;
	created_at: number;
}

interface PoolRecordRow {
	id: number;
	name: string;
	strategy: string;
	created_at: number;
	updated_at: number;
}

function readSchemaVersion(dbPath: string): number | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT version FROM auth_gateway_schema_version WHERE id = 1").get() as
			| VersionRow
			| undefined;
		return row?.version ?? null;
	} finally {
		db.close();
	}
}

function countRows(dbPath: string, table: string): number {
	if (!/^[a-z_]+$/.test(table)) throw new Error(`unsafe table name ${table}`);
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow | undefined;
		return row?.count ?? 0;
	} finally {
		db.close();
	}
}

function readPoolCredentialRows(dbPath: string, poolId: number): PoolCredentialRow[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT credential_id, position, created_at FROM gateway_pool_credentials WHERE pool_id = ? ORDER BY position ASC",
			)
			.all(poolId) as PoolCredentialRow[];
	} finally {
		db.close();
	}
}

function indexExists(dbPath: string, indexName: string): boolean {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.prepare("SELECT 1 AS count FROM sqlite_master WHERE type = 'index' AND name = ?")
			.get(indexName) as CountRow | undefined;
		return row != null;
	} finally {
		db.close();
	}
}

function tableColumns(dbPath: string, table: string): string[] {
	if (!/^[a-z_]+$/.test(table)) throw new Error(`unsafe table name ${table}`);
	const db = new Database(dbPath, { readonly: true });
	try {
		return (db.prepare(`PRAGMA table_info(${table})`).all() as TableColumnRow[]).map(row => row.name);
	} finally {
		db.close();
	}
}

function readUserPoolBindingRows(dbPath: string, userId: number): UserPoolBindingRow[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT user_id, pool_id, position, created_at FROM gateway_user_pools WHERE user_id = ? ORDER BY position ASC",
			)
			.all(userId) as UserPoolBindingRow[];
	} finally {
		db.close();
	}
}

function readPoolRecord(dbPath: string, poolId: number): PoolRecordRow | undefined {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare("SELECT id, name, strategy, created_at, updated_at FROM gateway_pools WHERE id = ?")
			.get(poolId) as PoolRecordRow | undefined;
	} finally {
		db.close();
	}
}

function createV1Fixture(dbPath: string, options: { duplicateUserPoolBinding?: boolean } = {}): void {
	const db = new Database(dbPath);
	try {
		db.run("PRAGMA foreign_keys=OFF");
		db.run(`
			CREATE TABLE auth_gateway_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_gateway_schema_version(id, version) VALUES (1, 1);
			CREATE TABLE gateway_users (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 64 AND substr(name, 1, 1) GLOB '[a-z]' AND name NOT GLOB '*[^a-z0-9_-]*'),
				description TEXT,
				owner TEXT,
				role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
				enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				last_used_at INTEGER
			);
			CREATE TABLE gateway_user_tokens (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL REFERENCES gateway_users(id) ON DELETE CASCADE,
				public_id TEXT NOT NULL UNIQUE,
				token_hash BLOB NOT NULL,
				label TEXT,
				created_at INTEGER NOT NULL,
				last_used_at INTEGER,
				revoked_at INTEGER
			);
			CREATE TABLE gateway_acl_rules (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL REFERENCES gateway_users(id) ON DELETE CASCADE,
				effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
				kind TEXT NOT NULL CHECK (kind IN ('provider', 'model', 'route')),
				pattern TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				UNIQUE(user_id, effect, kind, pattern)
			);
			CREATE TABLE gateway_pools (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 64 AND substr(name, 1, 1) GLOB '[a-z]' AND name NOT GLOB '*[^a-z0-9_-]*'),
				provider TEXT NOT NULL,
				model TEXT,
				strategy TEXT NOT NULL CHECK (strategy IN ('sticky-session', 'least-used', 'round-robin', 'failover')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE gateway_pool_credentials (
				pool_id INTEGER NOT NULL REFERENCES gateway_pools(id) ON DELETE CASCADE,
				credential_id INTEGER NOT NULL,
				position INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY(pool_id, credential_id),
				UNIQUE(pool_id, position)
			);
			CREATE TABLE gateway_user_pools (
				user_id INTEGER NOT NULL,
				pool_id INTEGER NOT NULL,
				provider TEXT NOT NULL,
				model_key TEXT NOT NULL
			);
			CREATE TABLE gateway_audit_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				request_id TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				completed_at INTEGER NOT NULL,
				user_id INTEGER,
				user_name TEXT,
				token_id INTEGER,
				method TEXT NOT NULL,
				path TEXT NOT NULL,
				route_family TEXT NOT NULL,
				requested_model TEXT,
				resolved_provider TEXT,
				resolved_model TEXT,
				credential_id INTEGER,
				outcome TEXT NOT NULL,
				status_code INTEGER NOT NULL,
				input_tokens INTEGER NOT NULL,
				output_tokens INTEGER NOT NULL,
				cache_read_tokens INTEGER NOT NULL,
				cache_write_tokens INTEGER NOT NULL,
				total_tokens INTEGER NOT NULL,
				cost_usd REAL NOT NULL,
				error_code TEXT
			);
		`);
		db.prepare(
			"INSERT INTO gateway_users(id, name, role, enabled, created_at, updated_at) VALUES (?, ?, 'user', 1, ?, ?)",
		).run(7, "migrated", 100, 101);
		for (const [id, name, provider, model, strategy, createdAt, updatedAt] of [
			[2, "exact", "anthropic", "anthropic/claude-3-5-sonnet", "failover", 200, 201],
			[5, "wide", "openai", null, "round-robin", 500, 501],
			[9, "unused", "mock", null, "least-used", 900, 901],
		] as const) {
			db.prepare(
				"INSERT INTO gateway_pools(id, name, provider, model, strategy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(id, name, provider, model, strategy, createdAt, updatedAt);
		}
		for (const [poolId, credentialId, position, createdAt] of [
			[2, 101, 0, 2_001],
			[2, 201, 1, 2_002],
			[5, 301, 0, 5_001],
			[5, 101, 1, 5_002],
			[9, 401, 0, 9_001],
		] as const) {
			db.prepare(
				"INSERT INTO gateway_pool_credentials(pool_id, credential_id, position, created_at) VALUES (?, ?, ?, ?)",
			).run(poolId, credentialId, position, createdAt);
		}
		for (const [userId, poolId, provider, modelKey] of [
			[7, 5, "openai", ""],
			[7, 2, "anthropic", "anthropic/claude-3-5-sonnet"],
		] as const) {
			db.prepare("INSERT INTO gateway_user_pools(user_id, pool_id, provider, model_key) VALUES (?, ?, ?, ?)").run(
				userId,
				poolId,
				provider,
				modelKey,
			);
		}
		if (options.duplicateUserPoolBinding) {
			db.prepare("INSERT INTO gateway_user_pools(user_id, pool_id, provider, model_key) VALUES (?, ?, ?, ?)").run(
				7,
				2,
				"anthropic",
				"",
			);
		}
	} finally {
		db.close();
	}
}

function assertAccessError(error: unknown, code: "invalid_request" | "not_found" | "conflict"): void {
	expect(error).toBeInstanceOf(AuthGatewayAccessError);
	if (error instanceof AuthGatewayAccessError) {
		expect(error.code).toBe(code);
	}
}

function eventInput(patch: Partial<Omit<AuthGatewayAuditEvent, "id">> = {}): Omit<AuthGatewayAuditEvent, "id"> {
	return {
		requestId: `req-${Math.random()}`,
		startedAt: 1_700_000_000_000,
		completedAt: 1_700_000_000_123,
		userId: null,
		userName: null,
		tokenId: null,
		method: "POST",
		path: "/v1/chat/completions",
		routeFamily: "chat",
		requestedModel: null,
		resolvedProvider: null,
		resolvedModel: null,
		credentialId: null,
		outcome: "success",
		statusCode: 200,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		errorCode: null,
		...patch,
	};
}

describe("SqliteAuthGatewayAccessStore", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthGatewayAccessStore;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-gateway-access-"));
		dbPath = path.join(tempDir, "auth-gateway.db");
		store = await SqliteAuthGatewayAccessStore.open(dbPath);
	});

	afterEach(async () => {
		setSystemTime();
		vi.useRealTimers();
		store?.close();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("creates users with stable ids and one-time managed tokens that authenticate after reopen", async () => {
		const alice = store.createUser({ name: "alice", description: "primary", owner: "team-a", tokenLabel: "laptop" });
		const bob = store.createUser({ name: "bob" });

		expect(alice.user.id).not.toBe(bob.user.id);
		expect(alice.user.name).toBe("alice");
		expect(alice.token.userId).toBe(alice.user.id);
		expect(alice.token.value).toMatch(/^omp_gw_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
		expect(bob.token.value).toMatch(/^omp_gw_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
		expect(alice.token.value).not.toBe(bob.token.value);
		expect(readSchemaVersion(dbPath)).toBe(2);
		expect(store.counts()).toEqual({ users: 2, activeTokens: 2, pools: 0 });

		const listedAlice = store.listUsers().find(user => user.id === alice.user.id);
		expect(JSON.stringify(listedAlice)).not.toContain(alice.token.value);
		expect(JSON.stringify(store.getUser("alice"))).not.toContain(alice.token.value);
		expect(JSON.stringify(store.listUserTokens(alice.user.id))).not.toContain(alice.token.value);

		const principal = store.authenticateToken(alice.token.value);
		expect(principal).toMatchObject({ kind: "managed", userId: alice.user.id, name: "alice", role: "user" });
		expect(store.getUser(alice.user.id)?.lastUsedAt).toBeNumber();
		expect(store.listUserTokens(alice.user.id)[0]?.lastUsedAt).toBeNumber();

		store.close();
		store = await SqliteAuthGatewayAccessStore.open(dbPath);
		expect(store.authenticateToken(alice.token.value)).toMatchObject({
			userId: alice.user.id,
			tokenId: alice.token.id,
		});
		expect(store.getUser("999999")).toBeUndefined();
		expect(store.getUser(String(alice.user.id))?.id).toBe(alice.user.id);
	});

	test("throttles managed-token last-used writes for sixty seconds", () => {
		vi.useFakeTimers();
		const firstNow = 1_700_000_000_000;
		setSystemTime(firstNow);
		const alice = store.createUser({ name: "alice" });

		expect(store.authenticateToken(alice.token.value)).toMatchObject({
			userId: alice.user.id,
			tokenId: alice.token.id,
		});
		const firstUserLastUsedAt = store.getUser(alice.user.id)?.lastUsedAt;
		const firstTokenLastUsedAt = store.listUserTokens(alice.user.id)[0]?.lastUsedAt;
		expect(firstUserLastUsedAt).toBe(firstNow);
		expect(firstTokenLastUsedAt).toBe(firstNow);

		setSystemTime(firstNow + 30_000);
		expect(store.authenticateToken(alice.token.value)).toMatchObject({
			userId: alice.user.id,
			tokenId: alice.token.id,
		});
		expect(store.getUser(alice.user.id)?.lastUsedAt).toBe(firstUserLastUsedAt);
		expect(store.listUserTokens(alice.user.id)[0]?.lastUsedAt).toBe(firstTokenLastUsedAt);

		const refreshedNow = firstNow + 60_001;
		setSystemTime(refreshedNow);
		expect(store.authenticateToken(alice.token.value)).toMatchObject({
			userId: alice.user.id,
			tokenId: alice.token.id,
		});
		expect(store.getUser(alice.user.id)?.lastUsedAt).toBe(refreshedNow);
		expect(store.listUserTokens(alice.user.id)[0]?.lastUsedAt).toBe(refreshedNow);
	});

	test("rejects revoked tokens and disabled users inside the last-used throttle window", () => {
		vi.useFakeTimers();
		const firstNow = 1_700_000_000_000;
		setSystemTime(firstNow);
		const revoked = store.createUser({ name: "revoked" });
		const disabled = store.createUser({ name: "disabled" });

		expect(store.authenticateToken(revoked.token.value)?.userId).toBe(revoked.user.id);
		expect(store.authenticateToken(disabled.token.value)?.userId).toBe(disabled.user.id);

		setSystemTime(firstNow + 30_000);
		expect(store.revokeUserToken(revoked.user.id, revoked.token.id)).toBe(true);
		expect(store.authenticateToken(revoked.token.value)).toBeNull();

		store.updateUser(disabled.user.id, { enabled: false });
		expect(store.authenticateToken(disabled.token.value)).toBeNull();
	});

	test("recreates additive indexes when reopening a v2 database", async () => {
		expect(indexExists(dbPath, "idx_gateway_audit_user_id")).toBe(true);
		expect(indexExists(dbPath, "idx_gateway_user_pools_pool_id")).toBe(true);
		store.close();
		expect(readSchemaVersion(dbPath)).toBe(2);
		const db = new Database(dbPath);
		try {
			db.run("DROP INDEX IF EXISTS idx_gateway_audit_user_id");
			db.run("DROP INDEX IF EXISTS idx_gateway_user_pools_pool_id");
		} finally {
			db.close();
		}
		expect(indexExists(dbPath, "idx_gateway_audit_user_id")).toBe(false);
		expect(indexExists(dbPath, "idx_gateway_user_pools_pool_id")).toBe(false);
		expect(readSchemaVersion(dbPath)).toBe(2);
		store = await SqliteAuthGatewayAccessStore.open(dbPath);
		expect(indexExists(dbPath, "idx_gateway_audit_user_id")).toBe(true);
		expect(indexExists(dbPath, "idx_gateway_user_pools_pool_id")).toBe(true);
		expect(readSchemaVersion(dbPath)).toBe(2);
	});

	test("isolates token add revoke rotate disable and delete per user", () => {
		const alice = store.createUser({ name: "alice" });
		const bob = store.createUser({ name: "bob" });
		const aliceSecond = store.addUserToken(alice.user.id, "phone");

		expect(aliceSecond.value).toMatch(/^omp_gw_/);
		expect(store.authenticateToken(alice.token.value)?.userId).toBe(alice.user.id);
		expect(store.authenticateToken(aliceSecond.value)?.userId).toBe(alice.user.id);
		expect(store.authenticateToken(bob.token.value)?.userId).toBe(bob.user.id);

		expect(store.revokeUserToken(alice.user.id, alice.token.id)).toBe(true);
		expect(store.authenticateToken(alice.token.value)).toBeNull();
		expect(store.authenticateToken(aliceSecond.value)?.userId).toBe(alice.user.id);
		expect(store.authenticateToken(bob.token.value)?.userId).toBe(bob.user.id);

		const rotated = store.rotateUserTokens(alice.user.id, "rotated");
		expect(rotated.value).toMatch(/^omp_gw_/);
		expect(store.authenticateToken(aliceSecond.value)).toBeNull();
		expect(store.authenticateToken(rotated.value)?.userId).toBe(alice.user.id);
		expect(store.listUserTokens(alice.user.id).filter(token => token.revokedAt === null)).toHaveLength(1);
		expect(store.authenticateToken(bob.token.value)?.userId).toBe(bob.user.id);

		store.updateUser(alice.user.id, { enabled: false });
		expect(store.authenticateToken(rotated.value)).toBeNull();
		expect(store.authenticateToken(bob.token.value)?.userId).toBe(bob.user.id);

		expect(store.deleteUser(alice.user.id)).toBe(true);
		expect(store.authenticateToken(rotated.value)).toBeNull();
		expect(store.authenticateToken(bob.token.value)?.userId).toBe(bob.user.id);
		expect(countRows(dbPath, "gateway_user_tokens")).toBe(1);
	});

	test("does not authenticate tokens revoked during the last-used write", () => {
		const alice = store.createUser({ name: "alice" });
		const triggerDb = new Database(dbPath);
		try {
			triggerDb.run(`
				CREATE TRIGGER revoke_during_auth
				BEFORE UPDATE OF last_used_at ON gateway_user_tokens
				WHEN OLD.revoked_at IS NULL
				BEGIN
					UPDATE gateway_user_tokens SET revoked_at = 123 WHERE id = OLD.id;
				END
			`);
			expect(store.authenticateToken(alice.token.value)).toBeNull();
			const [token] = store.listUserTokens(alice.user.id);
			expect(token?.revokedAt).toBe(123);
			expect(store.getUser(alice.user.id)?.lastUsedAt).toBeNull();
		} finally {
			triggerDb.run("DROP TRIGGER IF EXISTS revoke_during_auth");
			triggerDb.close();
		}
	});

	test("validates names case-insensitively and rejects invalid refs and disabled credentials", () => {
		const alice = store.createUser({ name: "Alice" });
		expect(alice.user.name).toBe("alice");
		expect(() => store.createUser({ name: "ALICE" })).toThrow(AuthGatewayAccessError);
		try {
			store.createUser({ name: "ALICE" });
		} catch (error) {
			assertAccessError(error, "conflict");
		}

		for (const name of ["", "1alice", "_alice", "alice!", "a".repeat(65)]) {
			try {
				store.createUser({ name });
			} catch (error) {
				assertAccessError(error, "invalid_request");
			}
		}

		const db = new Database(dbPath);
		try {
			expect(() =>
				db
					.prepare(
						"INSERT INTO gateway_users(name, role, enabled, created_at, updated_at) VALUES (?, 'user', 1, 1, 1)",
					)
					.run("bad!"),
			).toThrow();
			expect(() =>
				db
					.prepare(
						"INSERT INTO gateway_pools(name, strategy, created_at, updated_at) VALUES (?, 'failover', 1, 1)",
					)
					.run("1bad"),
			).toThrow();
		} finally {
			db.close();
		}

		store.updateUser("alice", { enabled: false });
		expect(store.authenticateToken(alice.token.value)).toBeNull();
		expect(() => store.updateUser("missing", { enabled: true })).toThrow(AuthGatewayAccessError);
	});

	test("evaluates ACL deny precedence default deny route gates and admin bypass", () => {
		const alice = store.createUser({ name: "alice" });
		const principal = store.authenticateToken(alice.token.value);
		expect(principal).not.toBeNull();
		if (!principal) throw new Error("expected managed principal");

		expect(
			evaluateAuthGatewayAccess(principal, [], {
				route: "chat",
				provider: "anthropic",
				qualifiedModel: "anthropic/claude",
			}),
		).toEqual({
			allowed: false,
			reason: "no_matching_allow",
		});
		expect(evaluateAuthGatewayRouteAccess(principal, [], "models", false)).toEqual({ allowed: true });
		expect(evaluateAuthGatewayRouteAccess(principal, [], "usage", true)).toEqual({
			allowed: false,
			reason: "route_denied",
		});

		store.addAclRule(alice.user.id, { effect: "allow", kind: "route", pattern: "chat" });
		store.addAclRule(alice.user.id, { effect: "allow", kind: "provider", pattern: "anthropic" });
		expect(
			evaluateAuthGatewayAccess(principal, store.listAclRules(alice.user.id), {
				route: "chat",
				provider: "anthropic",
				qualifiedModel: "anthropic/claude-sonnet",
			}),
		).toEqual({ allowed: true });
		expect(
			evaluateAuthGatewayAccess(principal, store.listAclRules(alice.user.id), {
				route: "messages",
				provider: "anthropic",
				qualifiedModel: "anthropic/claude-sonnet",
			}),
		).toEqual({ allowed: false, reason: "route_denied" });

		store.addAclRule(alice.user.id, { effect: "deny", kind: "model", pattern: "anthropic/claude-sonnet" });
		expect(
			evaluateAuthGatewayAccess(principal, store.listAclRules(alice.user.id), {
				route: "chat",
				provider: "anthropic",
				qualifiedModel: "anthropic/claude-sonnet",
			}),
		).toEqual({ allowed: false, reason: "model_denied" });

		store.addAclRule(alice.user.id, { effect: "allow", kind: "model", pattern: "openai/gpt-4o" });
		expect(
			evaluateAuthGatewayAccess(principal, store.listAclRules(alice.user.id), {
				route: "chat",
				provider: "openai",
				qualifiedModel: "openai/gpt-4o",
			}),
		).toEqual({ allowed: true });

		const admin = store.createUser({ name: "admin", role: "admin" });
		const adminPrincipal = store.authenticateToken(admin.token.value);
		expect(adminPrincipal).not.toBeNull();
		if (!adminPrincipal) throw new Error("expected admin principal");
		expect(
			evaluateAuthGatewayAccess(adminPrincipal, store.listAclRules(alice.user.id), {
				route: "usage",
				provider: "hidden",
				qualifiedModel: "hidden/model",
			}),
		).toEqual({ allowed: true });

		expect(() =>
			store.addAclRule(alice.user.id, { effect: "allow", kind: "model", pattern: "anthropic/claude*" }),
		).toThrow(AuthGatewayAccessError);
		expect(() => store.addAclRule(alice.user.id, { effect: "allow", kind: "route", pattern: "management" })).toThrow(
			AuthGatewayAccessError,
		);
	});

	test("creates neutral pools and appends removes reorders user bindings", async () => {
		const alice = store.createUser({ name: "alice" });
		const fallback = store.createPool({ name: "fallback", strategy: "round-robin" });
		const primary = store.createPool({ name: "primary", strategy: "failover" });

		expect(fallback).toEqual({
			id: fallback.id,
			name: "fallback",
			strategy: "round-robin",
			createdAt: fallback.createdAt,
			updatedAt: fallback.updatedAt,
			members: [],
		});
		expect(tableColumns(dbPath, "gateway_pools")).not.toContain("provider");
		expect(tableColumns(dbPath, "gateway_pools")).not.toContain("model");
		expect(tableColumns(dbPath, "gateway_user_pools")).toEqual(["user_id", "pool_id", "position", "created_at"]);

		store.addPoolCredential(primary.id, 30);
		store.addPoolCredential(primary.id, 20);
		store.addPoolCredential(fallback.id, 20);
		store.addPoolCredential(fallback.id, 10);

		const firstBind = store.bindUserPool(alice.user.id, primary.id);
		expect(firstBind.created).toBe(true);
		expect(firstBind.binding).toMatchObject({ poolId: primary.id, position: 0 });
		expect(firstBind.binding.pool.members.map(member => member.credentialId)).toEqual([30, 20]);
		expect(store.bindUserPool(alice.user.id, primary.id)).toMatchObject({
			created: false,
			binding: { poolId: primary.id, position: 0 },
		});
		expect(store.bindUserPool(alice.user.id, fallback.id)).toMatchObject({
			created: true,
			binding: { poolId: fallback.id, position: 1 },
		});

		let bindings = store.listUserPoolBindings(alice.user.id);
		expect(bindings.map(binding => [binding.poolId, binding.position])).toEqual([
			[primary.id, 0],
			[fallback.id, 1],
		]);
		expect(resolveAuthGatewayPoolSelection(bindings, [10])?.credentialIds).toEqual([10]);
		expect(resolveAuthGatewayPoolSelection(bindings, [20, 10])?.credentialIds).toEqual([20]);
		expect(resolveAuthGatewayPoolSelection(bindings, [999])).toBeNull();

		const reordered = store.setUserPoolOrder(alice.user.id, [fallback.id, primary.id]);
		expect(reordered.map(binding => [binding.poolId, binding.position])).toEqual([
			[fallback.id, 0],
			[primary.id, 1],
		]);
		bindings = store.listUserPoolBindings(alice.user.id);
		expect(resolveAuthGatewayPoolSelection(bindings, [20, 30])?.poolId).toBe(fallback.id);
		expect(resolveAuthGatewayPoolSelection(bindings, [20, 30])?.credentialIds).toEqual([20]);

		for (const poolIds of [
			[fallback.id, fallback.id],
			[fallback.id],
			[fallback.id, primary.id, 999],
			[fallback.id, 0],
		]) {
			expect(() => store.setUserPoolOrder(alice.user.id, poolIds)).toThrow(
				"pool order must include every current user pool exactly once",
			);
		}
		expect(store.listUserPoolBindings(alice.user.id).map(binding => binding.poolId)).toEqual([
			fallback.id,
			primary.id,
		]);

		expect(store.unbindUserPool(alice.user.id, fallback.id)).toBe(true);
		expect(store.unbindUserPool(alice.user.id, fallback.id)).toBe(false);
		expect(store.listUserPoolBindings(alice.user.id).map(binding => [binding.poolId, binding.position])).toEqual([
			[primary.id, 0],
		]);

		const admin = store.createUser({ name: "admin", role: "admin" });
		expect(() => store.bindUserPool(admin.user.id, primary.id)).toThrow(AuthGatewayAccessError);

		store.close();
		store = await SqliteAuthGatewayAccessStore.open(dbPath);
		expect(store.listUserPoolBindings(alice.user.id).map(binding => [binding.poolId, binding.position])).toEqual([
			[primary.id, 0],
		]);
	});

	test("migrates v1 scoped pools into neutral pools and ordered bindings", async () => {
		store.close();
		dbPath = path.join(tempDir, "v1.db");
		createV1Fixture(dbPath);
		vi.useFakeTimers();
		setSystemTime(7_000);

		store = await SqliteAuthGatewayAccessStore.open(dbPath);

		expect(readSchemaVersion(dbPath)).toBe(2);
		expect(tableColumns(dbPath, "gateway_pools")).toEqual(["id", "name", "strategy", "created_at", "updated_at"]);
		expect(tableColumns(dbPath, "gateway_user_pools")).toEqual(["user_id", "pool_id", "position", "created_at"]);
		expect(readPoolRecord(dbPath, 2)).toEqual({
			id: 2,
			name: "exact",
			strategy: "failover",
			created_at: 200,
			updated_at: 201,
		});
		expect(readPoolCredentialRows(dbPath, 2)).toEqual([
			{ credential_id: 101, position: 0, created_at: 2_001 },
			{ credential_id: 201, position: 1, created_at: 2_002 },
		]);
		expect(readPoolCredentialRows(dbPath, 5)).toEqual([
			{ credential_id: 301, position: 0, created_at: 5_001 },
			{ credential_id: 101, position: 1, created_at: 5_002 },
		]);
		expect(readUserPoolBindingRows(dbPath, 7)).toEqual([
			{ user_id: 7, pool_id: 2, position: 0, created_at: 7_000 },
			{ user_id: 7, pool_id: 5, position: 1, created_at: 7_000 },
		]);
		expect(
			store.listUserPoolBindings(7).map(binding => [binding.poolId, binding.position, binding.pool.name]),
		).toEqual([
			[2, 0, "exact"],
			[5, 1, "wide"],
		]);
		expect(store.listCredentialPools(101).map(pool => pool.id)).toEqual([2, 5]);

		const created = store.createPool({ name: "after-migration" });
		expect(created.id).toBeGreaterThan(9);
		const appended = store.bindUserPool(7, created.id);
		expect(appended.binding.position).toBe(2);
		expect(store.listUserPoolBindings(7).map(binding => [binding.poolId, binding.position])).toEqual([
			[2, 0],
			[5, 1],
			[created.id, 2],
		]);
	});

	test("rejects malformed v1 fixtures with duplicate user pool bindings without migrating", async () => {
		store.close();
		dbPath = path.join(tempDir, "duplicate-v1.db");
		createV1Fixture(dbPath, { duplicateUserPoolBinding: true });

		await expect(SqliteAuthGatewayAccessStore.open(dbPath)).rejects.toThrow(
			"duplicate user pool bindings cannot be migrated",
		);
		expect(readSchemaVersion(dbPath)).toBe(1);
		expect(tableColumns(dbPath, "gateway_pools")).toContain("provider");
		store = await SqliteAuthGatewayAccessStore.open(path.join(tempDir, "replacement.db"));
	});

	test("treats a duplicate pool-member insert at the SQLite boundary as idempotent", async () => {
		const pool = store.createPool({ name: "primary" });
		const triggerDb = new Database(dbPath);
		try {
			triggerDb.run(`
				CREATE TRIGGER simulate_pool_member_race
				BEFORE INSERT ON gateway_pool_credentials
				WHEN NEW.credential_id = 42 AND NEW.created_at >= 0
				BEGIN
					INSERT INTO gateway_pool_credentials(pool_id, credential_id, position, created_at)
					VALUES (NEW.pool_id, NEW.credential_id, NEW.position, -1);
				END
			`);
		} finally {
			triggerDb.close();
		}

		store.close();
		store = await SqliteAuthGatewayAccessStore.open(dbPath);
		try {
			const result = store.addPoolCredential(pool.id, 42);

			expect(result.created).toBe(false);
			expect(result.pool.members.map(member => member.credentialId)).toEqual([42]);
			expect(store.getPool(pool.id)?.members).toMatchObject([{ credentialId: 42, position: 0 }]);
		} finally {
			store.close();
			const cleanupDb = new Database(dbPath);
			try {
				cleanupDb.run("DROP TRIGGER IF EXISTS simulate_pool_member_race");
			} finally {
				cleanupDb.close();
			}
			store = await SqliteAuthGatewayAccessStore.open(dbPath);
		}
	});

	test("concurrent appends preserve ordered user pool bindings", async () => {
		const alice = store.createUser({ name: "alice" });
		const firstPool = store.createPool({ name: "primary" });
		const secondPool = store.createPool({ name: "secondary" });
		const secondStore = await SqliteAuthGatewayAccessStore.open(dbPath);
		try {
			const attempts = await Promise.allSettled([
				Promise.resolve().then(() => store.bindUserPool(alice.user.id, firstPool.id)),
				Promise.resolve().then(() => secondStore.bindUserPool(alice.user.id, secondPool.id)),
			]);
			expect(attempts.every(result => result.status === "fulfilled")).toBe(true);
			const bindings = store.listUserPoolBindings(alice.user.id);
			expect(bindings.map(binding => binding.position)).toEqual([0, 1]);
			expect(new Set(bindings.map(binding => binding.poolId))).toEqual(new Set([firstPool.id, secondPool.id]));
		} finally {
			secondStore.close();
		}
	});

	test("persists redacted audit rows and usage aggregates across reopen", async () => {
		const rawGatewayToken = "omp_gw_abcdefghijklmnop.secretsecretsecretsecretsecretsecretsecret1";
		const providerApiKey = "sk-provider-secret";
		const oauthAccess = "oauth-access-secret";
		const oauthRefresh = "oauth-refresh-secret";
		const alice = store.createUser({ name: "alice" });
		const bob = store.createUser({ name: "bob" });

		store.recordAudit(
			eventInput({
				requestId: "req-success-1",
				userId: alice.user.id,
				userName: alice.user.name,
				tokenId: alice.token.id,
				path: `/v1/chat/completions?token=${rawGatewayToken}#${providerApiKey}`,
				requestedModel: "anthropic/claude",
				resolvedProvider: "anthropic",
				resolvedModel: "claude",
				credentialId: 123,
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 3,
				cacheWriteTokens: 2,
				totalTokens: 20,
				costUsd: 0.25,
				errorCode: `${oauthAccess}-${oauthRefresh}`,
			}),
		);
		store.recordAudit(
			eventInput({
				requestId: "req-success-2",
				userId: alice.user.id,
				userName: alice.user.name,
				requestedModel: "anthropic/haiku",
				resolvedProvider: "anthropic",
				resolvedModel: "haiku",
				credentialId: 124,
				inputTokens: 1,
				outputTokens: 2,
				totalTokens: 3,
				costUsd: 0.5,
			}),
		);
		store.recordAudit(
			eventInput({
				requestId: "req-models-list",
				userId: alice.user.id,
				userName: alice.user.name,
				routeFamily: "models",
				requestedModel: "anthropic/list",
				resolvedProvider: "anthropic",
				resolvedModel: "list",
				totalTokens: 100,
				costUsd: 10,
			}),
		);
		store.recordAudit(
			eventInput({
				requestId: "req-denied",
				userId: alice.user.id,
				userName: alice.user.name,
				outcome: "denied_by_acl",
				statusCode: 403,
				resolvedProvider: "anthropic",
				resolvedModel: "hidden",
				totalTokens: 999,
				costUsd: 99,
			}),
		);
		store.recordAudit(
			eventInput({
				requestId: "req-bob",
				userId: bob.user.id,
				userName: bob.user.name,
				resolvedProvider: "openai",
				resolvedModel: "gpt-4o",
				totalTokens: 7,
				costUsd: 0.07,
			}),
		);

		store.close();
		store = await SqliteAuthGatewayAccessStore.open(dbPath);
		const globalPage = store.listAudit({ limit: 3 });
		expect(globalPage.events.map(event => event.requestId)).toEqual(["req-bob", "req-denied", "req-models-list"]);
		expect(globalPage.nextBefore).toBeNumber();
		const globalNextPage = store.listAudit({ limit: 3, before: globalPage.nextBefore ?? undefined });
		expect(globalNextPage.events.map(event => event.requestId)).toEqual(["req-success-2", "req-success-1"]);
		expect(globalNextPage.events.every(event => event.id < (globalPage.nextBefore ?? 0))).toBe(true);
		expect(globalNextPage.nextBefore).toBeNull();

		const page = store.listAudit({ userId: alice.user.id, limit: 3 });
		expect(page.events).toHaveLength(3);
		expect(page.events.map(event => event.requestId)).toEqual(["req-denied", "req-models-list", "req-success-2"]);
		expect(page.nextBefore).toBeNumber();
		expect(page.events[0]?.id).toBeGreaterThan(page.events[1]?.id ?? 0);
		const nextPage = store.listAudit({ userId: alice.user.id, limit: 3, before: page.nextBefore ?? undefined });
		expect(nextPage.events.map(event => event.requestId)).toEqual(["req-success-1"]);
		expect(nextPage.events.every(event => event.id < (page.nextBefore ?? 0))).toBe(true);
		expect(nextPage.nextBefore).toBeNull();

		const serializedAudit = JSON.stringify(store.listAudit({ limit: 100 }));
		expect(serializedAudit).not.toContain(rawGatewayToken);
		expect(serializedAudit).not.toContain(providerApiKey);
		expect(serializedAudit).not.toContain(oauthAccess);
		expect(serializedAudit).not.toContain(oauthRefresh);
		expect(store.listAudit({ limit: 100 }).events.find(event => event.requestId === "req-success-1")?.path).toBe(
			"/v1/chat/completions",
		);
		expect(
			store.listAudit({ limit: 100 }).events.find(event => event.requestId === "req-success-1")?.errorCode,
		).toBeNull();

		const usage = store.getUserUsage(alice.user.id);
		expect(usage.userId).toBe(alice.user.id);
		expect(usage.since).toBe(0);
		expect(usage.totals).toEqual({
			requests: 2,
			inputTokens: 11,
			outputTokens: 7,
			cacheReadTokens: 3,
			cacheWriteTokens: 2,
			totalTokens: 23,
			costUsd: 0.75,
		});
		expect(usage.byProviderModel).toEqual([
			{ provider: "anthropic", model: "claude", requests: 1, totalTokens: 20, costUsd: 0.25 },
			{ provider: "anthropic", model: "haiku", requests: 1, totalTokens: 3, costUsd: 0.5 },
		]);
	});

	test("reorders pool credentials as an exact atomic permutation and preserves member timestamps", () => {
		const pool = store.createPool({ name: "ordered" });
		store.addPoolCredential(pool.id, 10);
		store.addPoolCredential(pool.id, 20);
		store.addPoolCredential(pool.id, 30);
		const before = readPoolCredentialRows(dbPath, pool.id);

		const reordered = store.setPoolCredentialOrder(pool.id, [30, 10, 20]);
		expect(reordered.members).toMatchObject([
			{ credentialId: 30, position: 0 },
			{ credentialId: 10, position: 1 },
			{ credentialId: 20, position: 2 },
		]);
		const after = readPoolCredentialRows(dbPath, pool.id);
		expect(after.map(row => row.position)).toEqual([0, 1, 2]);
		expect(new Map(after.map(row => [row.credential_id, row.created_at]))).toEqual(
			new Map(before.map(row => [row.credential_id, row.created_at])),
		);

		for (const credentialIds of [
			[30, 30, 20],
			[30, 10],
			[30, 10, 20, 40],
			[30, 10, 0],
		]) {
			try {
				store.setPoolCredentialOrder(pool.id, credentialIds);
			} catch (error) {
				assertAccessError(error, "invalid_request");
			}
			expect(store.getPool(pool.id)?.members.map(member => member.credentialId)).toEqual([30, 10, 20]);
			expect(readPoolCredentialRows(dbPath, pool.id).map(row => row.position)).toEqual([0, 1, 2]);
		}

		expect(() => store.setPoolCredentialOrder(999999, [30, 10, 20])).toThrow(AuthGatewayAccessError);
	});

	test("lists credential pools by pool id without consulting credential storage", () => {
		const first = store.createPool({ name: "first" });
		const second = store.createPool({ name: "second" });
		const unrelated = store.createPool({ name: "unrelated" });
		store.addPoolCredential(second.id, 42);
		store.addPoolCredential(first.id, 42);
		store.addPoolCredential(unrelated.id, 7);

		expect(store.listCredentialPools(42).map(pool => pool.id)).toEqual([first.id, second.id]);
		expect(store.listCredentialPools(42).map(pool => pool.name)).toEqual(["first", "second"]);
		expect(store.listCredentialPools(7).map(pool => pool.id)).toEqual([unrelated.id]);
		expect(store.listCredentialPools(999999)).toEqual([]);
	});
});
