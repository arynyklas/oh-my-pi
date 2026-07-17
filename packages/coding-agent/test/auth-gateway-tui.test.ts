import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredential, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import type {
	AuthGatewayAclRule,
	AuthGatewayAdminClient as AuthGatewayAdminClientType,
	AuthGatewayAdminStatus,
	AuthGatewayAuditEvent,
	AuthGatewayCredentialSummary,
	AuthGatewayIssuedTokenValue,
	AuthGatewayModelSummary,
	AuthGatewayPool,
	AuthGatewayToken,
	AuthGatewayUsageSummary,
	AuthGatewayUser,
	AuthGatewayUserDetails,
	AuthGatewayUserPoolBinding,
	CreatePoolInput,
	CreateUserInput,
	UpdatePoolInput,
	UpdateUserInput,
} from "@oh-my-pi/pi-ai/auth-gateway";
import {
	AUTH_GATEWAY_ACL_ROUTES,
	AUTH_GATEWAY_BASIC_ROUTES,
	AuthGatewayAdminClient,
	AuthGatewayAdminClientError,
	SqliteAuthGatewayAccessStore,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProviderInterface } from "@oh-my-pi/pi-ai/oauth/types";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import {
	AuthGatewayProfileStore,
	type ResolvedAuthGatewayConnection,
} from "@oh-my-pi/pi-coding-agent/auth-gateway/profiles";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	AuthGatewayAccountLoginController,
	uploadAcquiredAuthGatewayCredential,
} from "@oh-my-pi/pi-coding-agent/modes/components/auth-gateway/account-login";
import { AuthGatewayConsole } from "@oh-my-pi/pi-coding-agent/modes/components/auth-gateway/console";
import {
	ACTIVE_POLL_MS,
	AuthGatewayConsoleController,
	POLL_ERROR_BACKOFF_MS,
} from "@oh-my-pi/pi-coding-agent/modes/components/auth-gateway/console-controller";
import {
	closeOneTimeTokenDialog,
	copyOneTimeTokenDialogValue,
	createOneTimeTokenDialog,
} from "@oh-my-pi/pi-coding-agent/modes/components/auth-gateway/dialogs";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import * as clipboard from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const NOW = 1_800_000_000_000;
const OAUTH_SOURCE_ID = "task-6-auth-gateway-tui-test";
const SECRET_TOKEN = "otk-secret-never-render";
const API_KEY = "sk-secret-never-render";
const OAUTH_ACCESS = "oauth-access-never-render";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	return { promise, resolve, reject };
}

function user(id: number, name: string, role: "user" | "admin" = "user"): AuthGatewayUser {
	return {
		id,
		name,
		description: null,
		owner: null,
		role,
		enabled: true,
		createdAt: NOW - 10_000,
		updatedAt: NOW - 5_000,
		lastUsedAt: null,
	};
}

function token(id: number, userId: number, publicId = `tok_${id}`): AuthGatewayToken {
	return {
		id,
		userId,
		publicId,
		label: null,
		createdAt: NOW - 8_000,
		lastUsedAt: null,
		revokedAt: null,
	};
}

function aclRule(id: number, userId: number): AuthGatewayAclRule {
	return {
		id,
		userId,
		effect: "allow",
		kind: "route",
		pattern: "/v1/chat/*",
		createdAt: NOW - 7_000,
	};
}

function pool(id: number, name: string, credentialIds: number[] = []): AuthGatewayPool {
	return {
		id,
		name,
		strategy: "round-robin",
		createdAt: NOW - 20_000,
		updatedAt: NOW - 1_000,
		members: credentialIds.map((credentialId, position) => ({
			credentialId,
			position,
			createdAt: NOW - 9_000 + position,
		})),
	};
}

function poolBinding(poolValue: AuthGatewayPool, position: number): AuthGatewayUserPoolBinding {
	return {
		poolId: poolValue.id,
		position,
		createdAt: NOW - 7_000 + position,
		pool: poolValue,
	};
}

function credential(
	id: number,
	provider = "openai",
	type: "oauth" | "api_key" = "oauth",
): AuthGatewayCredentialSummary {
	return {
		id,
		provider,
		type,
		identityKey: type === "oauth" ? `acct:${id}` : null,
		email: type === "oauth" ? `account-${id}@example.com` : null,
		accountId: type === "oauth" ? `account-${id}` : null,
		projectId: null,
		orgId: null,
		orgName: null,
		enterpriseUrl: null,
		apiEndpoint: null,
		expiresAt: null,
	};
}

function modelSummary(id: string, provider = "openai"): AuthGatewayModelSummary {
	return { id, provider, api: "openai" };
}

function auditEvent(id: number, beforeOffset = 0): AuthGatewayAuditEvent {
	return {
		id,
		requestId: `req-${id}`,
		startedAt: NOW - beforeOffset - id,
		completedAt: NOW - beforeOffset,
		userId: 1,
		userName: "alice",
		tokenId: 7,
		method: "POST",
		path: "/v1/chat/completions",
		routeFamily: "chat",
		requestedModel: "gpt-test",
		resolvedProvider: "openai",
		resolvedModel: "gpt-test",
		credentialId: 11,
		outcome: "success",
		statusCode: 200,
		inputTokens: 3,
		outputTokens: 5,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 8,
		costUsd: 0.01,
		errorCode: null,
	};
}

const STATUS: AuthGatewayAdminStatus = {
	ok: true,
	version: "test-version",
	serverTime: NOW,
	principal: { kind: "managed", userId: 1, name: "admin", role: "admin", tokenId: 77 },
	counts: { users: 2, activeTokens: 3, pools: 1, credentials: 2 },
};

const USAGE: AuthGatewayUsageSummary = {
	userId: 1,
	since: NOW - 60_000,
	generatedAt: NOW,
	totals: {
		requests: 1,
		inputTokens: 3,
		outputTokens: 5,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 8,
		costUsd: 0.01,
	},
	byProviderModel: [{ provider: "openai", model: "gpt-test", requests: 1, totalTokens: 8, costUsd: 0.01 }],
};

class FakeGatewayClient {
	statusCalls = 0;
	listUsersCalls = 0;
	getUserCalls: number[] = [];
	usageCalls: Array<{ userId: number; since?: number }> = [];
	listPoolsCalls = 0;
	listPoolUsersCalls: number[] = [];
	listCredentialsCalls = 0;
	listUsageReportsCalls = 0;
	listAuditQueries: Array<{ userId?: number; limit?: number; before?: number }> = [];
	createUserCalls: CreateUserInput[] = [];
	updateUserCalls: Array<{
		userId: number;
		input: UpdateUserInput;
	}> = [];
	deleteUserCalls: number[] = [];
	addUserTokenCalls: Array<{ userId: number; label?: string }> = [];
	revokeUserTokenCalls: Array<{ userId: number; tokenId: number }> = [];
	rotateUserCalls: number[] = [];
	addAclRuleCalls: Array<{
		userId: number;
		input: { effect: "allow" | "deny"; kind: "route" | "model" | "provider"; pattern: string };
	}> = [];
	addAclRulesCalls: Array<{
		userId: number;
		rules: Array<{ effect: "allow" | "deny"; kind: "route" | "model" | "provider"; pattern: string }>;
	}> = [];
	listModelsCalls = 0;
	deleteAclRuleCalls: Array<{ userId: number; ruleId: number }> = [];
	bindUserPoolCalls: Array<{ userId: number; poolId: number }> = [];
	unbindUserPoolCalls: Array<{ userId: number; poolId: number }> = [];
	setUserPoolOrderCalls: Array<{ userId: number; poolIds: number[] }> = [];
	createPoolCalls: CreatePoolInput[] = [];
	updatePoolCalls: Array<{ poolId: number; input: UpdatePoolInput }> = [];
	deletePoolCalls: number[] = [];
	addPoolCredentialCalls: Array<{ poolId: number; credentialId: number }> = [];
	removePoolCredentialCalls: Array<{ poolId: number; credentialId: number }> = [];
	removeCredentialCalls: number[] = [];
	uploadCredentialCalls: Array<{ provider: string; credential: AuthCredential }> = [];
	setPoolCredentialOrderCalls: Array<{ poolId: number; credentialIds: number[] }> = [];
	refreshCredentialCalls: number[] = [];
	userDetailQueue = new Map<number, Deferred<AuthGatewayUserDetails>>();
	statusResponse: AuthGatewayAdminStatus = STATUS;
	statusQueue: Deferred<AuthGatewayAdminStatus>[] = [];
	userListQueue: Deferred<AuthGatewayUser[]>[] = [];
	deleteUserQueue: Deferred<void>[] = [];
	users: AuthGatewayUser[] = [user(1, "alice", "admin"), user(2, "bob")];
	pools: AuthGatewayPool[] = [pool(10, "primary", [11, 12])];
	credentials: AuthGatewayCredentialSummary[] = [credential(11), credential(12, "openai", "api_key")];
	userPoolIds = new Map<number, number[]>([[1, [10]]]);
	tokens = new Map<number, AuthGatewayToken[]>([[1, [token(77, 1, "tok-current")]]]);
	acl = new Map<number, AuthGatewayAclRule[]>([[1, [aclRule(301, 1)]]]);
	auditPages = new Map<number | undefined, { events: AuthGatewayAuditEvent[]; nextBefore: number | null }>([
		[undefined, { events: [auditEvent(1), auditEvent(2)], nextBefore: 50 }],
		[50, { events: [auditEvent(3, 50)], nextBefore: null }],
	]);
	credentialListQueue: Deferred<AuthGatewayCredentialSummary[]>[] = [];
	addAclRulesQueue: Deferred<Array<{ rule: AuthGatewayAclRule; created: boolean }>>[] = [];
	addUserTokenQueue: Deferred<AuthGatewayIssuedTokenValue>[] = [];
	rotateUserTokenQueue: Deferred<AuthGatewayIssuedTokenValue>[] = [];
	models: AuthGatewayModelSummary[] = [modelSummary("gpt-test")];
	modelListQueue: Deferred<AuthGatewayModelSummary[]>[] = [];
	deleteAclRuleQueue: Deferred<void>[] = [];
	auditQueue = new Map<number | undefined, Deferred<{ events: AuthGatewayAuditEvent[]; nextBefore: number | null }>>();
	nextStatusError: Error | null = null;
	nextUsersError: Error | null = null;
	nextAclDeleteError: Error | null = null;
	nextBindUserPoolError: Error | null = null;
	nextUnbindUserPoolError: Error | null = null;
	nextSetUserPoolOrderError: Error | null = null;
	nextAddPoolCredentialError: Error | null = null;
	nextRemovePoolCredentialError: Error | null = null;
	nextCredentialRemoveError: Error | null = null;
	nextCredentialRefreshError: Error | null = null;
	abortedSignals: AbortSignal[] = [];
	nextCredentialUploadError: Error | null = null;

	async status(signal?: AbortSignal): Promise<AuthGatewayAdminStatus> {
		this.statusCalls++;
		if (signal) this.abortedSignals.push(signal);
		if (this.statusQueue.length > 0) return await this.statusQueue.shift()!.promise;
		if (this.nextStatusError) {
			const error = this.nextStatusError;
			this.nextStatusError = null;
			throw error;
		}
		return this.statusResponse;
	}

	async listUsers(signal?: AbortSignal): Promise<AuthGatewayUser[]> {
		this.listUsersCalls++;
		if (signal) this.abortedSignals.push(signal);
		const queued = this.userListQueue.shift();
		if (queued) return await queued.promise;
		if (this.nextUsersError) {
			const error = this.nextUsersError;
			this.nextUsersError = null;
			throw error;
		}
		return this.users;
	}

	async getUser(userId: number, signal?: AbortSignal): Promise<AuthGatewayUserDetails> {
		this.getUserCalls.push(userId);
		if (signal) this.abortedSignals.push(signal);
		const queued = this.userDetailQueue.get(userId);
		if (queued) return await queued.promise;
		const found = this.users.find(item => item.id === userId) ?? this.users[0]!;
		return {
			user: found,
			tokens: this.tokens.get(userId) ?? [],
			acl: this.acl.get(userId) ?? [],
			poolBindings:
				this.userPoolIds
					.get(userId)
					?.map(poolId => this.pools.find(item => item.id === poolId))
					.filter((item): item is AuthGatewayPool => item !== undefined)
					.map((item, index) => poolBinding(item, index)) ?? [],
		};
	}

	async getUserUsage(userId: number, since?: number, signal?: AbortSignal): Promise<AuthGatewayUsageSummary> {
		this.usageCalls.push({ userId, since });
		if (signal) this.abortedSignals.push(signal);
		return { ...USAGE, userId, since: since ?? USAGE.since };
	}

	async createUser(
		input: CreateUserInput,
		signal?: AbortSignal,
	): Promise<{ user: AuthGatewayUser; token: AuthGatewayIssuedTokenValue }> {
		this.createUserCalls.push(input);
		if (signal) this.abortedSignals.push(signal);
		const created = user(100 + this.createUserCalls.length, input.name, input.role ?? "user");
		created.description = input.description ?? null;
		created.owner = input.owner ?? null;
		this.users = [...this.users, created];
		return { user: created, token: { id: 900, value: SECRET_TOKEN, label: null } };
	}

	async updateUser(userId: number, input: UpdateUserInput, signal?: AbortSignal): Promise<AuthGatewayUser> {
		this.updateUserCalls.push({ userId, input });
		if (signal) this.abortedSignals.push(signal);
		const existing = this.users.find(item => item.id === userId) ?? user(userId, `user-${userId}`);
		const updated = { ...existing, ...input, updatedAt: NOW };
		this.users = this.users.map(item => (item.id === userId ? updated : item));
		return updated;
	}

	async deleteUser(userId: number, signal?: AbortSignal): Promise<void> {
		this.deleteUserCalls.push(userId);
		if (signal) this.abortedSignals.push(signal);
		const queued = this.deleteUserQueue.shift();
		if (queued) await queued.promise;
		this.users = this.users.filter(item => item.id !== userId);
	}

	async addUserToken(userId: number, label?: string, signal?: AbortSignal): Promise<AuthGatewayIssuedTokenValue> {
		this.addUserTokenCalls.push({ userId, label });
		if (signal) this.abortedSignals.push(signal);
		const queued = this.addUserTokenQueue.shift();
		if (queued) return await queued.promise;
		return { id: 501, value: SECRET_TOKEN, label: label ?? null };
	}

	async revokeUserToken(userId: number, tokenId: number, signal?: AbortSignal): Promise<void> {
		this.revokeUserTokenCalls.push({ userId, tokenId });
		if (signal) this.abortedSignals.push(signal);
		this.tokens.set(
			userId,
			(this.tokens.get(userId) ?? []).filter(item => item.id !== tokenId),
		);
	}

	async rotateUserTokens(userId: number, _label?: string, signal?: AbortSignal): Promise<AuthGatewayIssuedTokenValue> {
		this.rotateUserCalls.push(userId);
		if (signal) this.abortedSignals.push(signal);
		const queued = this.rotateUserTokenQueue.shift();
		if (queued) return await queued.promise;
		return { id: 500, value: SECRET_TOKEN, label: null };
	}

	async addAclRule(
		userId: number,
		input: { effect: "allow" | "deny"; kind: "route" | "model" | "provider"; pattern: string },
		signal?: AbortSignal,
	): Promise<AuthGatewayAclRule> {
		this.addAclRuleCalls.push({ userId, input });
		if (signal) this.abortedSignals.push(signal);
		const created = { id: 700 + this.addAclRuleCalls.length, userId, ...input, createdAt: NOW };
		this.acl.set(userId, [...(this.acl.get(userId) ?? []), created]);
		return created;
	}

	async addAclRules(
		userId: number,
		input: { rules: Array<{ effect: "allow" | "deny"; kind: "route" | "model" | "provider"; pattern: string }> },
		signal?: AbortSignal,
	): Promise<Array<{ rule: AuthGatewayAclRule; created: boolean }>> {
		this.addAclRulesCalls.push({ userId, rules: input.rules.map(rule => ({ ...rule })) });
		if (signal) this.abortedSignals.push(signal);
		const queued = this.addAclRulesQueue.shift();
		if (queued) return await queued.promise;
		const results: Array<{ rule: AuthGatewayAclRule; created: boolean }> = [];
		for (const rule of input.rules) {
			const existing = (this.acl.get(userId) ?? []).find(
				item => item.effect === rule.effect && item.kind === rule.kind && item.pattern === rule.pattern,
			);
			if (existing) {
				results.push({ rule: existing, created: false });
				continue;
			}
			const created = {
				id: 800 + this.addAclRulesCalls.length * 10 + results.length,
				userId,
				...rule,
				createdAt: NOW,
			};
			this.acl.set(userId, [...(this.acl.get(userId) ?? []), created]);
			results.push({ rule: created, created: true });
		}
		return results;
	}

	async deleteAclRule(userId: number, ruleId: number, signal?: AbortSignal): Promise<void> {
		this.deleteAclRuleCalls.push({ userId, ruleId });
		if (signal) this.abortedSignals.push(signal);
		const queued = this.deleteAclRuleQueue.shift();
		if (queued) await queued.promise;
		if (this.nextAclDeleteError) {
			const error = this.nextAclDeleteError;
			this.nextAclDeleteError = null;
			throw error;
		}
		this.acl.set(
			userId,
			(this.acl.get(userId) ?? []).filter(item => item.id !== ruleId),
		);
	}

	async bindUserPool(userId: number, poolId: number, signal?: AbortSignal): Promise<boolean> {
		this.bindUserPoolCalls.push({ userId, poolId });
		if (signal) this.abortedSignals.push(signal);
		if (this.nextBindUserPoolError) {
			const error = this.nextBindUserPoolError;
			this.nextBindUserPoolError = null;
			throw error;
		}
		this.userPoolIds.set(userId, [...(this.userPoolIds.get(userId) ?? []), poolId]);
		return true;
	}

	async unbindUserPool(userId: number, poolId: number, signal?: AbortSignal): Promise<void> {
		this.unbindUserPoolCalls.push({ userId, poolId });
		if (signal) this.abortedSignals.push(signal);
		if (this.nextUnbindUserPoolError) {
			const error = this.nextUnbindUserPoolError;
			this.nextUnbindUserPoolError = null;
			throw error;
		}
		this.userPoolIds.set(
			userId,
			(this.userPoolIds.get(userId) ?? []).filter(id => id !== poolId),
		);
	}

	async setUserPoolOrder(
		userId: number,
		poolIds: readonly number[],
		signal?: AbortSignal,
	): Promise<AuthGatewayUserPoolBinding[]> {
		this.setUserPoolOrderCalls.push({ userId, poolIds: [...poolIds] });
		if (signal) this.abortedSignals.push(signal);
		if (this.nextSetUserPoolOrderError) {
			const error = this.nextSetUserPoolOrderError;
			this.nextSetUserPoolOrderError = null;
			throw error;
		}
		this.userPoolIds.set(userId, [...poolIds]);
		const bindings = poolIds
			.map(poolId => this.pools.find(item => item.id === poolId))
			.filter((item): item is AuthGatewayPool => item !== undefined)
			.map((item, index) => poolBinding(item, index));
		return bindings;
	}

	async createPool(input: CreatePoolInput, signal?: AbortSignal): Promise<AuthGatewayPool> {
		this.createPoolCalls.push(input);
		if (signal) this.abortedSignals.push(signal);
		const created = {
			...pool(200 + this.createPoolCalls.length, input.name, []),
			strategy: input.strategy ?? "round-robin",
		};
		this.pools = [...this.pools, created];
		return created;
	}

	async updatePool(poolId: number, input: UpdatePoolInput, signal?: AbortSignal): Promise<AuthGatewayPool> {
		this.updatePoolCalls.push({ poolId, input });
		if (signal) this.abortedSignals.push(signal);
		const existing = this.pools.find(item => item.id === poolId) ?? pool(poolId, `pool-${poolId}`);
		const updated = { ...existing, ...input, updatedAt: NOW };
		this.pools = this.pools.map(item => (item.id === poolId ? updated : item));
		return updated;
	}

	async deletePool(poolId: number, signal?: AbortSignal): Promise<void> {
		this.deletePoolCalls.push(poolId);
		if (signal) this.abortedSignals.push(signal);
		this.pools = this.pools.filter(item => item.id !== poolId);
	}

	async listPools(signal?: AbortSignal): Promise<AuthGatewayPool[]> {
		this.listPoolsCalls++;
		if (signal) this.abortedSignals.push(signal);
		return this.pools;
	}

	async listPoolUsers(poolId: number, signal?: AbortSignal): Promise<AuthGatewayUser[]> {
		this.listPoolUsersCalls.push(poolId);
		if (signal) this.abortedSignals.push(signal);
		return this.users.slice(0, 1);
	}
	async addPoolCredential(poolId: number, credentialId: number, signal?: AbortSignal): Promise<AuthGatewayPool> {
		this.addPoolCredentialCalls.push({ poolId, credentialId });
		if (signal) this.abortedSignals.push(signal);
		if (this.nextAddPoolCredentialError) {
			const error = this.nextAddPoolCredentialError;
			this.nextAddPoolCredentialError = null;
			throw error;
		}
		const existing = this.pools.find(item => item.id === poolId) ?? pool(poolId, `pool-${poolId}`);
		const nextOrder = [...existing.members.map(member => member.credentialId), credentialId];
		this.pools = this.pools.map(item =>
			item.id === poolId ? { ...item, members: pool(item.id, item.name, nextOrder).members } : item,
		);
		return this.pools.find(item => item.id === poolId)!;
	}

	async removePoolCredential(poolId: number, credentialId: number, signal?: AbortSignal): Promise<void> {
		this.removePoolCredentialCalls.push({ poolId, credentialId });
		if (signal) this.abortedSignals.push(signal);
		if (this.nextRemovePoolCredentialError) {
			const error = this.nextRemovePoolCredentialError;
			this.nextRemovePoolCredentialError = null;
			throw error;
		}
		const existing = this.pools.find(item => item.id === poolId) ?? pool(poolId, `pool-${poolId}`);
		const nextOrder = existing.members.map(member => member.credentialId).filter(id => id !== credentialId);
		this.pools = this.pools.map(item =>
			item.id === poolId ? { ...item, members: pool(item.id, item.name, nextOrder).members } : item,
		);
	}

	async setPoolCredentialOrder(poolId: number, credentialIds: readonly number[]): Promise<AuthGatewayPool> {
		this.setPoolCredentialOrderCalls.push({ poolId, credentialIds: [...credentialIds] });
		this.pools = this.pools.map(item => (item.id === poolId ? pool(item.id, item.name, [...credentialIds]) : item));
		return this.pools.find(item => item.id === poolId)!;
	}

	async listCredentials(signal?: AbortSignal): Promise<AuthGatewayCredentialSummary[]> {
		this.listCredentialsCalls++;
		if (signal) this.abortedSignals.push(signal);
		const queued = this.credentialListQueue.shift();
		if (queued) return await queued.promise;
		return this.credentials;
	}

	async listUsageReports(signal?: AbortSignal): Promise<UsageReport[]> {
		this.listUsageReportsCalls++;
		if (signal) this.abortedSignals.push(signal);
		return [];
	}

	async listModels(signal?: AbortSignal): Promise<AuthGatewayModelSummary[]> {
		this.listModelsCalls++;
		if (signal) this.abortedSignals.push(signal);
		const queued = this.modelListQueue.shift();
		if (queued) return await queued.promise;
		return this.models;
	}

	async removeCredential(credentialId: number): Promise<void> {
		this.removeCredentialCalls.push(credentialId);
		if (this.nextCredentialRemoveError) {
			const error = this.nextCredentialRemoveError;
			this.nextCredentialRemoveError = null;
			throw error;
		}
		this.credentials = this.credentials.filter(item => item.id !== credentialId);
	}

	async uploadCredential(
		provider: string,
		uploadedCredential: AuthCredential,
	): Promise<AuthGatewayCredentialSummary[]> {
		this.uploadCredentialCalls.push({ provider, credential: uploadedCredential });
		if (this.nextCredentialUploadError) {
			const error = this.nextCredentialUploadError;
			this.nextCredentialUploadError = null;
			throw error;
		}
		return this.credentials;
	}

	async refreshCredential(credentialId: number): Promise<AuthGatewayCredentialSummary> {
		this.refreshCredentialCalls.push(credentialId);
		if (this.nextCredentialRefreshError) {
			const error = this.nextCredentialRefreshError;
			this.nextCredentialRefreshError = null;
			throw error;
		}
		return this.credentials.find(item => item.id === credentialId) ?? credential(credentialId);
	}

	async listAudit(
		query: { userId?: number; limit?: number; before?: number } = {},
		signal?: AbortSignal,
	): Promise<{ events: AuthGatewayAuditEvent[]; nextBefore: number | null }> {
		this.listAuditQueries.push(query);
		if (signal) this.abortedSignals.push(signal);
		const queued = this.auditQueue.get(query.before);
		if (queued) return await queued.promise;
		return this.auditPages.get(query.before) ?? { events: [], nextBefore: null };
	}
}

let root = "";
let store: AuthGatewayProfileStore;
let connection: ResolvedAuthGatewayConnection;
let fake: FakeGatewayClient;

beforeEach(async () => {
	await initTheme();
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	setSystemTime(NOW);
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-gateway-tui-"));
	store = AuthGatewayProfileStore.open({
		documentPath: path.join(root, "auth-gateways.json"),
		tokenDir: path.join(root, "tokens"),
	});
	connection = {
		profile: { name: "prod", url: "https://gateway.example.com/omp", tokenSource: { type: "file" } },
		token: "managed-token",
	};
	fake = new FakeGatewayClient();
});

afterEach(async () => {
	vi.useRealTimers();
	setSystemTime();
	vi.restoreAllMocks();
	unregisterOAuthProviders(OAUTH_SOURCE_ID);
	resetSettingsForTest();
	await removeWithRetries(root);
});

async function flushAsync(): Promise<void> {
	await Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

function controller(): AuthGatewayConsoleController {
	return new AuthGatewayConsoleController({
		connection,
		client: fake as unknown as AuthGatewayAdminClientType,
		requestRender: () => {},
	});
}

function plain(component: { render(width: number): readonly string[] }, width = 120): string {
	return component
		.render(width)
		.map(line => Bun.stripANSI(line).replaceAll("\x1b_pi:c\x07", ""))
		.join("\n");
}

const COPY_URL_LABEL = "Copy URL:";
const SHORTCUT_LABEL = "Local shortcut (this machine only):";
const LINEAR_AUTH_URL =
	"https://auth.example.com/oauth/authorize?response_type=code&client_id=abcdefghij0123456789ABCDEFGHIJ0123456789&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&scope=read%20write%20mcp%3Aall&state=0123456789abcdef0123456789abcdef&code_challenge=5MlkJfN2GhX9uP0rQ7sT8vB1oCwDeFgHiJkLmNoPqRsTuVwXyZ&code_challenge_method=S256";

function reassembleUrl(plainLines: string[], label: string): string {
	const start = plainLines.findIndex(line => line.startsWith(` ${label}`));
	if (start < 0) return "";
	const first = plainLines[start]!;
	const inlineMatch = first.match(new RegExp(`^ ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (.*)$`));
	if (inlineMatch) return inlineMatch[1]!;
	let joined = "";
	for (let i = start + 1; i < plainLines.length; i++) {
		const line = plainLines[i]!;
		if (line.startsWith(" ") || line.trim().length === 0) break;
		joined += line;
	}
	return joined;
}

function typeAndSubmit(component: { handleInput(data: string): void }, value: string): void {
	for (const char of value) component.handleInput(char);
	component.handleInput("\n");
}
async function waitUntil(condition: () => boolean | Promise<boolean>, message: string | (() => string)): Promise<void> {
	for (let attempt = 0; attempt < 2_000; attempt++) {
		if (await condition()) return;
		await flushAsync();
	}
	throw new Error(typeof message === "string" ? message : message());
}

async function chatContent(response: Response): Promise<string> {
	const body = (await response.json()) as unknown;
	if (!body || typeof body !== "object") return "";
	const choices = (body as Record<string, unknown>).choices;
	if (!Array.isArray(choices)) return "";
	const first = choices[0];
	if (!first || typeof first !== "object") return "";
	const message = (first as Record<string, unknown>).message;
	if (!message || typeof message !== "object") return "";
	const content = (message as Record<string, unknown>).content;
	return typeof content === "string" ? content : "";
}

async function advanceTimers(ms: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	await flushAsync();
}

describe("AuthGatewayConsoleController", () => {
	it("loads overview immediately and polls the visible tab every three seconds without overlapping", async () => {
		vi.useFakeTimers();
		const first = deferred<AuthGatewayAdminStatus>();
		fake.statusQueue.push(first);
		const ctl = controller();
		void ctl.start();
		await flushAsync();
		expect(fake.statusCalls).toBe(1);
		await advanceTimers(ACTIVE_POLL_MS);
		expect(fake.statusCalls).toBe(1);
		first.resolve(STATUS);
		await flushAsync();
		expect(ctl.state.overview.data?.version).toBe("test-version");
		await advanceTimers(ACTIVE_POLL_MS - 1);
		expect(fake.statusCalls).toBe(1);
		await advanceTimers(1);
		expect(fake.statusCalls).toBe(2);
		ctl.close();
	});

	it("loads only the selected tab resource and caches selected user and pool details until refresh", async () => {
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("users");
		expect(fake.listUsersCalls).toBe(1);
		expect(fake.getUserCalls).toEqual([1]);
		expect(fake.usageCalls).toEqual([{ userId: 1, since: undefined }]);
		ctl.selectNext();
		await flushAsync();
		expect(fake.getUserCalls).toEqual([1, 2]);
		await ctl.refresh();
		expect(fake.listUsersCalls).toBe(2);
		await ctl.switchTab("pools");
		expect(fake.listPoolsCalls).toBe(1);
		expect(fake.listPoolUsersCalls).toEqual([10]);
		expect(fake.listCredentialsCalls).toBe(1);
		await ctl.switchTab("accounts");
		expect(fake.listCredentialsCalls).toBe(2);
		ctl.close();
	});

	it("refetches immediately after pessimistic mutations and exposes one-time rotate tokens", async () => {
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("users");
		ctl.selectNext();
		await flushAsync();
		await ctl.deleteSelectedUser("bob");
		expect(fake.deleteUserCalls).toEqual([2]);
		expect(fake.listUsersCalls).toBe(2);
		await ctl.rotateSelectedUserTokens("rotate alice");
		expect(fake.rotateUserCalls).toEqual([1]);
		expect(ctl.state.oneTimeToken?.value).toBe(SECRET_TOKEN);
		ctl.closeOneTimeToken();
		expect(ctl.state.oneTimeToken).toBeNull();
		expect(JSON.stringify(ctl.state)).not.toContain(SECRET_TOKEN);
		ctl.close();
	});

	it("backs off failed polling by 3, 6, 12, then 30 seconds while retaining stale snapshots", async () => {
		vi.useFakeTimers();
		const ctl = controller();
		await ctl.start();
		expect(ctl.state.overview.status).toBeDefined();
		fake.nextStatusError = new Error("gateway down");
		await advanceTimers(ACTIVE_POLL_MS);
		expect(ctl.state.overview.data?.version).toBe("test-version");
		expect(ctl.state.overview.stale).toBe(true);
		expect(ctl.state.errorBanner).toContain("gateway down");
		for (const delay of POLL_ERROR_BACKOFF_MS.slice(0, 3)) {
			fake.nextStatusError = new Error(`still down ${delay}`);
			await advanceTimers(delay - 1);
			expect(fake.statusCalls).toBeLessThanOrEqual(4);
			await advanceTimers(1);
		}
		fake.nextStatusError = null;
		await advanceTimers(POLL_ERROR_BACKOFF_MS[3]);
		expect(ctl.state.overview.stale).toBe(false);
		expect(ctl.state.errorBanner).toBeNull();
		ctl.close();
	});

	it("clears failed visible-load health after a successful retry", async () => {
		const ctl = controller();
		await ctl.start();
		fake.nextUsersError = new Error("users temporarily unavailable");

		await ctl.switchTab("users");

		expect(ctl.state.health).toBe("Error");
		expect(ctl.state.errorBanner).toContain("users temporarily unavailable");
		expect(ctl.state.errorBannerSource).toBe("visible-load");
		expect(ctl.state.users.status).toBe("error");
		expect(ctl.state.users.data).toEqual([]);

		fake.users = [user(9, "carol")];
		await ctl.refresh();

		expect(ctl.state.health).toBe("Connected");
		expect(ctl.state.errorBanner).toBeNull();
		expect(ctl.state.errorBannerSource).toBeNull();
		expect(ctl.state.users.status).toBe("ready");
		expect(ctl.state.users.error).toBeNull();
		expect(ctl.state.users.stale).toBe(false);
		expect(ctl.state.users.data.map(item => item.name)).toEqual(["carol"]);
		ctl.close();
	});

	it("clears credential refresh feedback as soon as the retry starts", async () => {
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("accounts");
		fake.nextCredentialRefreshError = new Error("credential refresh failed");

		expect(await ctl.refreshSelectedCredential()).toBe(false);
		expect(ctl.state.errorBanner).toContain("credential refresh failed");
		expect(ctl.state.errorBannerSource).toBe("transient");
		expect(ctl.state.health).toBe("Connected");

		const retrying = ctl.refreshSelectedCredential();
		expect(ctl.state.busyAction).toBe("refresh-credential");
		expect(ctl.state.errorBanner).toBeNull();
		expect(ctl.state.errorBannerSource).toBeNull();

		expect(await retrying).toBe(true);
		expect(ctl.state.health).toBe("Connected");
		expect(ctl.state.errorBanner).toBeNull();
		expect(ctl.state.errorBannerSource).toBeNull();
		expect(ctl.state.accounts.status).toBe("ready");
		ctl.close();
	});

	it("clears pools auxiliary credential failures after a complete retry", async () => {
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("pools");
		const failingCredentials = deferred<AuthGatewayCredentialSummary[]>();
		fake.credentialListQueue.push(failingCredentials);

		const partial = ctl.refresh();
		failingCredentials.reject(new Error("credential list unavailable"));
		expect(await partial).toBe(true);

		expect(ctl.state.health).toBe("Error");
		expect(ctl.state.errorBanner).toContain("credential list unavailable");
		expect(ctl.state.errorBannerSource).toBe("visible-load");
		expect(ctl.state.accounts.error).toContain("credential list unavailable");
		expect(ctl.state.accounts.stale).toBe(true);

		fake.credentials = [credential(21, "anthropic")];
		await ctl.refresh();

		expect(ctl.state.health).toBe("Connected");
		expect(ctl.state.errorBanner).toBeNull();
		expect(ctl.state.errorBannerSource).toBeNull();
		expect(ctl.state.accounts.error).toBeNull();
		expect(ctl.state.accounts.stale).toBe(false);
		expect(ctl.state.accounts.data.map(item => item.id)).toEqual([21]);
		ctl.close();
	});

	it("retries ACL suggestion loading without changing resource health", async () => {
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("users");
		const failingModels = deferred<AuthGatewayModelSummary[]>();
		fake.modelListQueue.push(failingModels);

		const failedSuggestions = ctl.loadAclSuggestions();
		failingModels.reject(new Error("suggestion helper unavailable"));

		expect(await failedSuggestions).toBeNull();
		expect(ctl.state.health).toBe("Connected");
		expect(ctl.state.errorBanner).toContain("suggestion helper unavailable");
		expect(ctl.state.errorBannerSource).toBe("transient");

		const retrying = ctl.loadAclSuggestions();
		expect(ctl.state.errorBanner).toBeNull();
		expect(ctl.state.errorBannerSource).toBeNull();
		const suggestions = await retrying;

		expect(ctl.state.health).toBe("Connected");
		expect(ctl.state.errorBanner).toBeNull();
		expect(ctl.state.errorBannerSource).toBeNull();
		expect(suggestions?.providers).toContain("openai");
		ctl.close();
	});

	it("pauses polling for modals and older audit pages, rejects stale generations, and aborts on close", async () => {
		vi.useFakeTimers();
		const first = deferred<AuthGatewayAdminStatus>();
		const stale = deferred<AuthGatewayAdminStatus>();
		fake.statusQueue.push(first, stale);
		const ctl = controller();
		void ctl.start();
		await flushAsync();
		const staleLoad = ctl.refresh();
		ctl.close();
		expect(fake.abortedSignals.some(signal => signal.aborted)).toBe(true);
		stale.resolve({ ...STATUS, version: "stale-version" });
		first.resolve(STATUS);
		await staleLoad.catch(() => {});
		await flushAsync();
		expect(ctl.state.overview.data).toBeNull();

		const auditCtl = controller();
		await auditCtl.start();
		await auditCtl.switchTab("audit");
		expect(fake.listAuditQueries).toEqual([{ limit: 50 }]);
		await auditCtl.nextAuditPage();
		expect(fake.listAuditQueries.at(-1)).toEqual({ limit: 50, before: 50 });
		await advanceTimers(ACTIVE_POLL_MS * 3);
		expect(fake.listAuditQueries).toHaveLength(2);
		auditCtl.setModalOpen(true);
		await advanceTimers(ACTIVE_POLL_MS * 2);
		expect(fake.listAuditQueries).toHaveLength(2);
		auditCtl.setModalOpen(false);
		await auditCtl.previousAuditPage();
		await advanceTimers(ACTIVE_POLL_MS);
		expect(fake.listAuditQueries.length).toBeGreaterThan(2);
		auditCtl.close();
	});

	it("aborts in-flight mutations on close and ignores post-close mutation completions", async () => {
		const pendingDelete = deferred<void>();
		fake.deleteUserQueue.push(pendingDelete);
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("users");
		ctl.selectNext();
		await flushAsync();
		const deleting = ctl.deleteSelectedUser("bob");
		await flushAsync();
		expect(fake.deleteUserCalls).toEqual([2]);
		ctl.close();
		expect(fake.abortedSignals.some(signal => signal.aborted)).toBe(true);
		pendingDelete.resolve();
		expect(await deleting).toBe(false);
		expect(ctl.state.users.data).toEqual([]);
		expect(ctl.state.errorBanner).toBeNull();
	});

	it("aborts and generation-rejects selected detail responses after tab switch and close", async () => {
		const pendingDetail = deferred<AuthGatewayUserDetails>();
		fake.userDetailQueue.set(2, pendingDetail);
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("users");
		ctl.selectNext();
		await flushAsync();
		expect(fake.getUserCalls).toEqual([1, 2]);
		await ctl.switchTab("accounts");
		expect(fake.abortedSignals.some(signal => signal.aborted)).toBe(true);
		pendingDetail.resolve({ user: user(2, "bob"), tokens: [], acl: [], poolBindings: [] });
		await flushAsync();
		expect(ctl.state.userDetails[2]).toBeUndefined();
		ctl.close();
	});

	it("supports full user lifecycle mutations and refetches users", async () => {
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("users");
		expect(await ctl.createUser({ name: "carol", description: "desc", owner: "owner", role: "admin" })).toBe(true);
		expect(fake.createUserCalls).toEqual([{ name: "carol", description: "desc", owner: "owner", role: "admin" }]);
		expect(fake.listUsersCalls).toBe(2);
		expect(await ctl.updateSelectedUser({ description: "new desc", owner: "new owner", role: "user" })).toBe(true);
		expect(fake.updateUserCalls.at(-1)).toEqual({
			userId: 1,
			input: { description: "new desc", owner: "new owner", role: "user" },
		});
		expect(await ctl.setSelectedUserEnabled(false, "wrong")).toBe(false);
		expect(fake.updateUserCalls).toHaveLength(1);
		ctl.selectNext();
		await flushAsync();
		expect(await ctl.setSelectedUserEnabled(false, "y")).toBe(true);
		expect(fake.updateUserCalls.at(-1)).toEqual({ userId: 2, input: { enabled: false } });
		expect(await ctl.createSelectedUserToken("cli")).toBe(true);
		expect(fake.addUserTokenCalls).toEqual([{ userId: 2, label: "cli" }]);
		expect(ctl.state.oneTimeToken?.value).toBe(SECRET_TOKEN);
		ctl.closeOneTimeToken();
		expect(await ctl.revokeSelectedUserToken(501, "y")).toBe(true);
		expect(fake.revokeUserTokenCalls).toEqual([{ userId: 2, tokenId: 501 }]);
		expect(await ctl.addSelectedUserAcl({ effect: "deny", kind: "provider", pattern: "anthropic" })).toBe(true);
		expect(fake.addAclRuleCalls).toEqual([
			{ userId: 2, input: { effect: "deny", kind: "provider", pattern: "anthropic" } },
		]);
		expect(await ctl.deleteSelectedUserAcl(301)).toBe(true);
		expect(fake.deleteAclRuleCalls).toEqual([{ userId: 2, ruleId: 301 }]);
		expect(await ctl.bindSelectedUserPool(10)).toBe(true);
		expect(fake.bindUserPoolCalls).toEqual([{ userId: 2, poolId: 10 }]);
		expect(await ctl.unbindSelectedUserPool(10, "y")).toBe(true);
		expect(fake.unbindUserPoolCalls).toEqual([{ userId: 2, poolId: 10 }]);
		ctl.close();
	});

	it("keeps successful mutations complete when their post-refresh hits a visible outage", async () => {
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("users");
		ctl.selectNext();
		await flushAsync();
		fake.nextUsersError = new Error("post-mutation users outage");

		expect(await ctl.setSelectedUserEnabled(false, "y")).toBe(true);

		expect(fake.updateUserCalls.at(-1)).toEqual({ userId: 2, input: { enabled: false } });
		expect(ctl.state.health).toBe("Stale");
		expect(ctl.state.errorBanner).toContain("post-mutation users outage");
		expect(ctl.state.errorBannerSource).toBe("visible-load");
		ctl.close();
	});

	it("requires disconnect confirmation for disabling or deleting the current admin and closes after success", async () => {
		const closes: string[] = [];
		const ctl = new AuthGatewayConsoleController({
			connection,
			client: fake as unknown as AuthGatewayAdminClient,
			requestRender: () => {},
			onDisconnect: () => closes.push("closed"),
		});
		await ctl.start();
		await ctl.switchTab("users");
		expect(ctl.currentUserDisconnectWarning()).toBe("This will disconnect the current console");
		expect(await ctl.deleteSelectedUser("alice")).toBe(false);
		expect(fake.deleteUserCalls).toEqual([]);
		expect(await ctl.deleteSelectedUser("disconnect alice")).toBe(true);
		expect(fake.deleteUserCalls).toEqual([1]);
		expect(closes).toEqual(["closed"]);
		expect(ctl.state.users.data).toEqual([]);

		fake = new FakeGatewayClient();
		const disableCtl = new AuthGatewayConsoleController({
			connection,
			client: fake as unknown as AuthGatewayAdminClient,
			requestRender: () => {},
			onDisconnect: () => closes.push("closed-disable"),
		});
		await disableCtl.start();
		await disableCtl.switchTab("users");
		expect(await disableCtl.setSelectedUserEnabled(false, "alice")).toBe(false);
		expect(fake.updateUserCalls).toEqual([]);
		expect(await disableCtl.setSelectedUserEnabled(false, "disconnect alice")).toBe(true);
		expect(fake.updateUserCalls).toEqual([{ userId: 1, input: { enabled: false } }]);
		expect(closes).toContain("closed-disable");
	});

	it("supports full typed pool lifecycle mutations and reorders the selected member", async () => {
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("pools");
		expect(await ctl.createPool({ name: "backup", strategy: "failover" })).toBe(true);
		expect(fake.createPoolCalls).toEqual([{ name: "backup", strategy: "failover" }]);
		expect(fake.listPoolsCalls).toBe(2);
		expect(await ctl.updateSelectedPool({ name: "primary-renamed", strategy: "failover" })).toBe(true);
		expect(fake.updatePoolCalls.at(-1)).toEqual({
			poolId: 10,
			input: { name: "primary-renamed", strategy: "failover" },
		});
		expect(await ctl.addSelectedPoolCredential(13)).toBe(true);
		expect(fake.addPoolCredentialCalls).toEqual([{ poolId: 10, credentialId: 13 }]);
		expect(await ctl.removeSelectedPoolCredential(13, "y")).toBe(true);
		expect(fake.removePoolCredentialCalls).toEqual([{ poolId: 10, credentialId: 13 }]);
		ctl.selectPoolMember(1);
		expect(await ctl.moveSelectedPoolCredential(-1)).toBe(true);
		expect(fake.setPoolCredentialOrderCalls.at(-1)).toEqual({ poolId: 10, credentialIds: [12, 11] });
		expect(await ctl.deleteSelectedPool("primary-renamed")).toBe(true);
		expect(fake.deletePoolCalls).toEqual([10]);
		ctl.close();
	});

	it("passes least-used pool strategy through typed controller methods", async () => {
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("pools");
		expect(await ctl.createPool({ name: "least", strategy: "least-used" })).toBe(true);
		expect(fake.createPoolCalls.at(-1)).toEqual({ name: "least", strategy: "least-used" });
		expect(await ctl.updateSelectedPool({ name: "primary-least", strategy: "least-used" })).toBe(true);
		expect(fake.updatePoolCalls.at(-1)).toEqual({
			poolId: 10,
			input: { name: "primary-least", strategy: "least-used" },
		});
		ctl.close();
	});

	it("returns only non-secret account identifiers for the copy action", async () => {
		fake.credentials = [
			{
				...credential(99),
				identityKey: "identity-99",
				email: "safe@example.com",
				accountId: "acct-99",
				projectId: "project-99",
				apiEndpoint: "https://api.example.com",
			},
		];
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("accounts");
		const payload = ctl.copySelectedCredentialIdentifiers();
		expect(payload).toContain("safe@example.com");
		expect(payload).toContain("acct-99");
		expect(payload).toContain("project-99");
		expect(payload).toContain("https://api.example.com");
		expect(payload).not.toContain(API_KEY);
		expect(payload).not.toContain(OAUTH_ACCESS);
		ctl.close();
	});

	it("aborts an in-flight visible load at mutation start and forces a fresh post-mutation refetch", async () => {
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("accounts");
		expect(fake.listCredentialsCalls).toBe(1);
		const staleLoad = deferred<AuthGatewayCredentialSummary[]>();
		fake.credentialListQueue.push(staleLoad);
		const loading = ctl.refresh();
		await flushAsync();
		expect(fake.listCredentialsCalls).toBe(2);
		const inFlightSignal = fake.abortedSignals.findLast(signal => !signal.aborted);
		const removing = ctl.removeSelectedCredential("11");
		await flushAsync();
		expect(inFlightSignal?.aborted).toBe(true);
		expect(fake.removeCredentialCalls).toEqual([11]);
		expect(fake.listCredentialsCalls).toBe(3);
		staleLoad.resolve([credential(999, "stale")]);
		await loading;
		expect(await removing).toBe(true);
		expect(ctl.state.accounts.data.map(item => item.id)).toEqual([12]);
		ctl.close();
	});

	it("aborts manual audit pagination and ignores stale pages after tab switch or close", async () => {
		const pendingPage = deferred<{ events: AuthGatewayAuditEvent[]; nextBefore: number | null }>();
		fake.auditQueue.set(50, pendingPage);
		const ctl = controller();
		await ctl.start();
		await ctl.switchTab("audit");
		const loadingPage = ctl.nextAuditPage();
		await flushAsync();
		expect(fake.listAuditQueries.at(-1)).toEqual({ limit: 50, before: 50 });
		await ctl.switchTab("users");
		expect(fake.abortedSignals.some(signal => signal.aborted)).toBe(true);
		pendingPage.resolve({ events: [auditEvent(900, 50)], nextBefore: null });
		await loadingPage;
		await flushAsync();
		expect(ctl.state.audit.data.map(event => event.id)).toEqual([1, 2]);

		const closeCtl = controller();
		await closeCtl.start();
		await closeCtl.switchTab("audit");
		const closingPage = deferred<{ events: AuthGatewayAuditEvent[]; nextBefore: number | null }>();
		fake.auditQueue.set(50, closingPage);
		const loadAndClose = closeCtl.nextAuditPage();
		await flushAsync();
		closeCtl.close();
		closingPage.resolve({ events: [auditEvent(901, 50)], nextBefore: null });
		await loadAndClose;
		expect(closeCtl.state.audit.data).toEqual([]);
	});
});

describe("AuthGatewayConsole", () => {
	function makeConsole(): AuthGatewayConsole {
		return new AuthGatewayConsole({
			connection,
			profileStore: store,
			createClient: () => fake as unknown as AuthGatewayAdminClient,
			host: { ui: new TUI(new VirtualTerminal(120, 32)), openInBrowser: () => {}, close: () => {} },
		});
	}

	function clickRenderedLine(component: AuthGatewayConsole, text: string, col = 4): void {
		const rowIndex = component.render(120).findIndex(line => Bun.stripANSI(line).includes(text));
		expect(rowIndex).toBeGreaterThanOrEqual(0);
		component.handleInput(`\x1b[<0;${col};${rowIndex + 1}M`);
	}

	it("renders five sanitized tabs with overview, list/detail, empty, loading, error, and stale states", async () => {
		const component = makeConsole();
		await component.ready;
		let rendered = plain(component, 120);
		expect(rendered).toContain("Auth Gateway Console");
		expect(rendered).toContain("Overview");
		expect(rendered).toContain("Users");
		expect(rendered).toContain("Pools");
		expect(rendered).toContain("Accounts");
		expect(rendered).toContain("Audit");
		expect(rendered).toContain("Connected");
		fake.users = [user(3, "bad\tname\r\nnext")];
		component.handleInput("2");
		await flushAsync();
		rendered = plain(component, 120);
		expect(rendered).toContain("bad   name  next");
		expect(rendered).not.toContain("bad\tname");
		expect(rendered).not.toContain("\r");
		expect(rendered).not.toContain("\nnext");
		fake.nextUsersError = new Error("temporary outage");
		component.handleInput("r");
		await flushAsync();
		rendered = plain(component, 120);
		expect(rendered).toContain("Stale");
		expect(rendered).toContain("temporary outage");
		fake.users = [];
		fake.nextUsersError = null;
		component.handleInput("r");
		await flushAsync();
		expect(plain(component, 120)).toContain("No users found");
		component.dispose?.();
	});

	it("preserves visible outage banners for dialogs but clears transient retry feedback", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		fake.nextUsersError = new Error("visible users outage");
		component.handleInput("r");
		await flushAsync();

		expect(component.controller.state.health).toBe("Stale");
		expect(plain(component, 120)).toContain("visible users outage");

		component.handleInput("/");
		expect(plain(component, 120)).toContain("visible users outage");
		component.handleInput("\x1b");
		component.handleInput("c");
		expect(plain(component, 120)).toContain("visible users outage");
		component.handleInput("\x1b");

		component.handleInput("4");
		await flushAsync();
		fake.nextCredentialRefreshError = new Error("oauth refresh failed");
		component.handleInput("o");
		await flushAsync();
		expect(component.controller.state.health).toBe("Connected");
		expect(plain(component, 120)).toContain("oauth refresh failed");

		component.handleInput("l");

		expect(plain(component, 120)).not.toContain("oauth refresh failed");
		expect(component.controller.state.health).toBe("Connected");
		component.dispose?.();
	});

	it("keeps the active Overview connection when candidate switch status fails without rendering secrets", async () => {
		vi.useFakeTimers();
		const badSwitchToken = "bad-switch-token-never-render";
		const resolvedBroken: ResolvedAuthGatewayConnection = {
			profile: { name: "broken", url: "https://broken.example.com/omp", tokenSource: { type: "file" } },
			token: badSwitchToken,
		};
		const resolveCalls: Array<string | undefined> = [];
		const switchStore = {
			async resolve(name?: string): Promise<ResolvedAuthGatewayConnection> {
				resolveCalls.push(name);
				return resolvedBroken;
			},
		};
		const prodClient = fake;
		const brokenClient = new FakeGatewayClient();
		brokenClient.nextStatusError = new Error(
			`401 unauthorized for ${badSwitchToken}\r\nX-Api-Key:\t${badSwitchToken}`,
		);
		const createdClients: string[] = [];
		const component = new AuthGatewayConsole({
			connection,
			profileStore: switchStore as unknown as AuthGatewayProfileStore,
			createClient: resolved => {
				createdClients.push(`${resolved.profile.name}:${resolved.token}`);
				return (resolved.profile.name === "broken"
					? brokenClient
					: prodClient) as unknown as AuthGatewayAdminClient;
			},
			host: { ui: new TUI(new VirtualTerminal(120, 32)), openInBrowser: () => {}, close: () => {} },
		});
		await component.ready;
		const originalController = component.controller;
		const originalOverview = component.controller.state.overview.data;

		component.handleInput("s");
		typeAndSubmit(component, "broken");
		await flushAsync();
		await flushAsync();

		expect(resolveCalls).toEqual(["broken"]);
		expect(createdClients).toEqual(["prod:managed-token", `broken:${badSwitchToken}`]);
		expect(brokenClient.statusCalls).toBe(1);
		expect(prodClient.statusCalls).toBe(1);
		expect(component.controller).toBe(originalController);
		expect(component.controller.state.connectionName).toBe("prod");
		expect(component.controller.state.health).toBe("Connected");
		expect(component.controller.state.overview.status).toBe("ready");
		expect(component.controller.state.overview.data).toBe(originalOverview);
		expect(component.controller.state.errorBanner).toBeNull();
		expect(component.controller.state.modalOpen).toBe(true);
		expect(JSON.stringify(component.controller.state)).not.toContain(badSwitchToken);
		const rendered = plain(component, 120);
		expect(rendered).toContain("prod");
		expect(rendered).toContain("401 unauthorized");
		expect(rendered).toContain("Connection name:");
		expect(rendered).not.toContain("broken");
		expect(rendered).not.toContain(badSwitchToken);
		expect(rendered).not.toContain("managed-token");
		expect(rendered).not.toContain("\r");
		expect(rendered).not.toContain("\t");
		await advanceTimers(ACTIVE_POLL_MS);
		expect(prodClient.statusCalls).toBe(1);
		component.dispose?.();
	});

	it("blocks keyboard and mouse input while an Overview switch probe is pending", async () => {
		const resolvedStaging: ResolvedAuthGatewayConnection = {
			profile: { name: "staging", url: "https://staging.example.com/omp", tokenSource: { type: "file" } },
			token: "staging-token-never-render",
		};
		const switchStore = {
			async resolve(): Promise<ResolvedAuthGatewayConnection> {
				return resolvedStaging;
			},
		};
		const prodClient = fake;
		const stagingClient = new FakeGatewayClient();
		const pendingStatus = deferred<AuthGatewayAdminStatus>();
		stagingClient.statusQueue.push(pendingStatus);
		const component = new AuthGatewayConsole({
			connection,
			profileStore: switchStore as unknown as AuthGatewayProfileStore,
			createClient: resolved =>
				(resolved.profile.name === "staging" ? stagingClient : prodClient) as unknown as AuthGatewayAdminClient,
			host: { ui: new TUI(new VirtualTerminal(120, 32)), openInBrowser: () => {}, close: () => {} },
		});
		await component.ready;
		const initialProdStatusCalls = prodClient.statusCalls;

		component.handleInput("s");
		typeAndSubmit(component, "staging");
		await flushAsync();
		expect(component.controller.state.modalOpen).toBe(true);
		expect(stagingClient.statusCalls).toBe(1);
		expect(plain(component, 120)).toContain("Switching connection…");

		component.render(120);
		component.handleInput("2");
		component.handleInput("r");
		component.handleInput("\t");
		component.handleInput("\x1b[<0;25;2M");
		await flushAsync();

		expect(component.controller.state.activeTab).toBe("overview");
		expect(component.controller.state.connectionName).toBe("prod");
		expect(prodClient.statusCalls).toBe(initialProdStatusCalls);
		expect(fake.listUsersCalls).toBe(0);
		expect(fake.listPoolsCalls).toBe(0);

		pendingStatus.resolve({ ...STATUS, version: "staging-version" });
		await flushAsync();
		await flushAsync();
		expect(component.controller.state.connectionName).toBe("staging");
		expect(component.controller.state.modalOpen).toBe(false);
		component.dispose?.();
	});

	it("keeps a failed Overview switch prompt open for a corrected retry", async () => {
		const resolvedBroken: ResolvedAuthGatewayConnection = {
			profile: { name: "broken", url: "https://broken.example.com/omp", tokenSource: { type: "file" } },
			token: "broken-token-never-render",
		};
		const resolvedStaging: ResolvedAuthGatewayConnection = {
			profile: { name: "staging", url: "https://staging.example.com/omp", tokenSource: { type: "file" } },
			token: "staging-token-never-render",
		};
		const switchStore = {
			async resolve(name?: string): Promise<ResolvedAuthGatewayConnection> {
				return name === "staging" ? resolvedStaging : resolvedBroken;
			},
		};
		const prodClient = fake;
		const brokenClient = new FakeGatewayClient();
		const stagingClient = new FakeGatewayClient();
		stagingClient.statusResponse = { ...STATUS, version: "staging-version" };
		const pendingStatus = deferred<AuthGatewayAdminStatus>();
		brokenClient.statusQueue.push(pendingStatus);
		const component = new AuthGatewayConsole({
			connection,
			profileStore: switchStore as unknown as AuthGatewayProfileStore,
			createClient: resolved => {
				if (resolved.profile.name === "broken") return brokenClient as unknown as AuthGatewayAdminClient;
				if (resolved.profile.name === "staging") return stagingClient as unknown as AuthGatewayAdminClient;
				return prodClient as unknown as AuthGatewayAdminClient;
			},
			host: { ui: new TUI(new VirtualTerminal(120, 32)), openInBrowser: () => {}, close: () => {} },
		});
		await component.ready;
		const initialProdStatusCalls = prodClient.statusCalls;

		component.handleInput("s");
		typeAndSubmit(component, "broken");
		await flushAsync();
		expect(component.controller.state.modalOpen).toBe(true);
		component.render(120);
		component.handleInput("3");
		component.handleInput("r");
		component.handleInput("\x1b[<0;25;2M");
		await flushAsync();
		expect(component.controller.state.activeTab).toBe("overview");
		expect(prodClient.statusCalls).toBe(initialProdStatusCalls);

		pendingStatus.reject(new Error("probe failed"));
		await flushAsync();
		await flushAsync();
		expect(component.controller.state.connectionName).toBe("prod");
		expect(component.controller.state.modalOpen).toBe(true);
		expect(component.controller.state.errorBanner).toBeNull();
		let rendered = plain(component, 120);
		expect(rendered).toContain("probe failed");
		expect(rendered).toContain("Connection name:");

		typeAndSubmit(component, "staging");
		await flushAsync();
		await flushAsync();
		rendered = plain(component, 120);
		expect(component.controller.state.connectionName).toBe("staging");
		expect(component.controller.state.modalOpen).toBe(false);
		expect(rendered).not.toContain("probe failed");
		component.dispose?.();
	});

	it("switches Overview connections through the profile store without rendering tokens", async () => {
		const resolvedStaging: ResolvedAuthGatewayConnection = {
			profile: { name: "staging", url: "https://staging.example.com/omp", tokenSource: { type: "file" } },
			token: "staging-token-never-render",
		};
		const resolveCalls: Array<string | undefined> = [];
		const switchStore = {
			async resolve(name?: string): Promise<ResolvedAuthGatewayConnection> {
				resolveCalls.push(name);
				return resolvedStaging;
			},
		};
		const prodClient = fake;
		const stagingClient = new FakeGatewayClient();
		stagingClient.statusResponse = {
			...STATUS,
			version: "staging-version",
			principal: { ...STATUS.principal, name: "staging-admin" },
		};
		const pendingProdRefresh = deferred<AuthGatewayAdminStatus>();
		const createdClients: string[] = [];
		const component = new AuthGatewayConsole({
			connection,
			profileStore: switchStore as unknown as AuthGatewayProfileStore,
			createClient: resolved => {
				createdClients.push(`${resolved.profile.name}:${resolved.token}`);
				return (resolved.profile.name === "staging"
					? stagingClient
					: prodClient) as unknown as AuthGatewayAdminClient;
			},
			host: { ui: new TUI(new VirtualTerminal(120, 32)), openInBrowser: () => {}, close: () => {} },
		});
		await component.ready;
		prodClient.statusQueue.push(pendingProdRefresh);
		component.handleInput("r");
		await flushAsync();
		expect(prodClient.statusCalls).toBe(2);
		component.handleInput("s");
		expect(plain(component, 120)).toContain("Connection name:");
		typeAndSubmit(component, "staging");
		await flushAsync();
		await flushAsync();
		await flushAsync();
		await flushAsync();
		expect(resolveCalls).toEqual(["staging"]);
		expect(createdClients).toEqual(["prod:managed-token", "staging:staging-token-never-render"]);
		expect(prodClient.abortedSignals.some(signal => signal.aborted)).toBe(true);
		expect(component.controller.state.connectionName).toBe("staging");
		expect(component.controller.state.overview.data?.version).toBe("staging-version");
		const rendered = plain(component, 120);
		expect(rendered).toContain("staging");
		expect(rendered).not.toContain("managed-token");
		expect(rendered).not.toContain("staging-token-never-render");
		pendingProdRefresh.resolve(STATUS);
		await flushAsync();
		expect(component.controller.state.connectionName).toBe("staging");
		component.dispose?.();
	});

	it("handles keyboard and mouse tab selection, slash filtering, help, refresh, and responsive layouts", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		component.handleInput("/");
		typeAndSubmit(component, "bob");
		expect(plain(component, 120)).toContain("bob");
		expect(plain(component, 120)).not.toContain("alice");
		component.handleInput("?");
		expect(plain(component, 120)).toContain("Help");
		component.handleInput("\x1b");
		component.handleInput("r");
		await flushAsync();
		expect(fake.listUsersCalls).toBeGreaterThan(1);
		expect(plain(component, 120)).toContain("Details");
		expect(plain(component, 80)).toContain("Press Enter for details");
		component.handleInput("\n");
		expect(plain(component, 80)).toContain("Detail view");
		component.handleInput("\x1b");
		expect(plain(component, 80)).not.toContain("Detail view");
		expect(plain(component, 50)).toContain("Ovr");
		component.render(120);
		component.handleInput("\x1b[<0;22;2M");
		await flushAsync();
		expect(plain(component, 120)).toContain("Pools");
		component.dispose?.();
	});

	it("keeps arrow selection working when a mouse tab click shares an input chunk", async () => {
		const component = makeConsole();
		await component.ready;
		component.render(120);
		component.handleInput("\x1b[<0;15;2M");
		await flushAsync();
		expect(component.controller.state.activeTab).toBe("users");
		component.handleInput("\x1b[<0;15;2m\x1b[B");
		expect(component.controller.state.selected.users).toBe(1);
		component.dispose?.();
	});

	it("ignores body mouse clicks below the last row", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		component.render(120);
		component.handleInput("\x1b[<0;5;25M");
		expect(component.controller.state.selected.users).toBe(0);
		component.dispose?.();
	});

	it("maps user row mouse clicks to the rendered row instead of the row above", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		component.render(120);
		component.handleInput("\x1b[<0;5;7M");
		expect(component.controller.state.selected.users).toBe(1);
		component.dispose?.();
	});

	it("maps account row mouse clicks to the rendered row instead of the row above", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("4");
		await flushAsync();
		component.render(120);
		component.handleInput("\x1b[<0;5;7M");
		expect(component.controller.state.selected.accounts).toBe(1);
		component.dispose?.();
	});

	it("ignores account row-height clicks outside the list column", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("4");
		await flushAsync();
		component.render(120);
		component.handleInput("\x1b[<0;90;7M");
		expect(component.controller.state.selected.accounts).toBe(0);
		component.dispose?.();
	});

	it("handles large coalesced mouse drag bursts without recursive input crashes", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("4");
		await flushAsync();
		component.render(120);
		const dragChunk = Array.from({ length: 20_000 }, (_, index) => `\x1b[<32;5;${7 + (index % 3)}M`).join("");
		component.handleInput(dragChunk);
		expect(component.controller.state.activeTab).toBe("accounts");
		component.dispose?.();
	});

	it("performs action confirmations and never sends mismatched destructive requests", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		component.handleInput("d");
		typeAndSubmit(component, "wrong");
		await flushAsync();
		expect(fake.deleteUserCalls).toEqual([]);
		expect(plain(component, 120)).toContain("Confirmation did not match");
		component.handleInput("\x1b");
		component.handleInput("\x1b[B");
		component.handleInput("d");
		typeAndSubmit(component, "bob");
		await flushAsync();
		expect(fake.deleteUserCalls).toEqual([2]);
		component.handleInput("4");
		await flushAsync();
		fake.nextCredentialRemoveError = new AuthGatewayAdminClientError(
			409,
			"credential_in_use",
			"Credential 11 is assigned",
			{
				credentialId: 11,
				pools: [{ id: 10, name: "primary" }],
			},
		);
		component.handleInput("d");
		typeAndSubmit(component, "11");
		await flushAsync();
		expect(plain(component, 120)).toContain("primary");
		expect(fake.removeCredentialCalls).toEqual([11]);
		component.dispose?.();
	});

	it("closes the console host after confirmed current-admin self-disconnect actions", async () => {
		const closes: string[] = [];
		const component = new AuthGatewayConsole({
			connection,
			profileStore: store,
			createClient: () => fake as unknown as AuthGatewayAdminClient,
			host: {
				ui: new TUI(new VirtualTerminal(120, 32)),
				openInBrowser: () => {},
				close: () => closes.push("closed"),
			},
		});
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		component.handleInput("d");
		typeAndSubmit(component, "disconnect alice");
		await flushAsync();
		expect(fake.deleteUserCalls).toEqual([1]);
		expect(closes).toEqual(["closed"]);
		component.dispose?.();
	});

	it("warns and accepts the displayed public id when revoking the current token", async () => {
		const closes: string[] = [];
		const component = new AuthGatewayConsole({
			connection,
			profileStore: store,
			createClient: () => fake as unknown as AuthGatewayAdminClient,
			host: {
				ui: new TUI(new VirtualTerminal(120, 32)),
				openInBrowser: () => {},
				close: () => closes.push("closed"),
			},
		});
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		component.handleInput("v");
		let rendered = plain(component, 120);
		expect(rendered).toContain("This will disconnect the current console");
		expect(rendered).toContain("tok-current");
		typeAndSubmit(component, "77|wrong");
		await flushAsync();
		expect(fake.revokeUserTokenCalls).toEqual([]);
		rendered = plain(component, 120);
		expect(rendered).toContain("Confirmation did not match");
		component.handleInput("\x1b");
		component.handleInput("v");
		typeAndSubmit(component, "77|tok-current");
		await flushAsync();
		expect(fake.revokeUserTokenCalls).toEqual([{ userId: 1, tokenId: 77 }]);
		expect(closes).toEqual(["closed"]);
		component.dispose?.();
	});

	it("sets an Audit user filter through a dedicated prompt and sends userId in listAudit queries", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("5");
		await flushAsync();
		expect(fake.listAuditQueries.at(-1)).toEqual({ limit: 50 });
		component.handleInput("u");
		typeAndSubmit(component, "2");
		await flushAsync();
		expect(component.controller.state.audit.userFilter).toBe(2);
		expect(fake.listAuditQueries.at(-1)).toEqual({ limit: 50, userId: 2 });
		component.dispose?.();
	});

	it("reloads selected user usage with a prompted since timestamp", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		expect(fake.usageCalls.at(-1)).toEqual({ userId: 1, since: undefined });
		component.handleInput("U");
		typeAndSubmit(component, String(NOW - 5_000));
		await flushAsync();
		expect(fake.usageCalls.at(-1)).toEqual({ userId: 1, since: NOW - 5_000 });
		expect(component.controller.state.userUsage[1]?.since).toBe(NOW - 5_000);
		component.dispose?.();
	});

	it("moves account selection up with Up Arrow without opening the API-key prompt", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("4");
		await flushAsync();
		component.handleInput("\x1b[B");
		expect(component.controller.state.selected.accounts).toBe(1);
		component.handleInput("\x1b[A");
		expect(component.controller.state.selected.accounts).toBe(0);
		expect(component.controller.state.modalOpen).toBe(false);
		expect(plain(component, 120)).not.toContain("Provider id:");
		component.dispose?.();
	});

	it("clears one-time managed tokens after the modal closes and omits raw credentials from render", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		component.handleInput("R");
		typeAndSubmit(component, "rotate alice");
		await flushAsync();
		let rendered = plain(component, 120);
		expect(rendered).toContain(SECRET_TOKEN);
		component.handleInput("\n");
		rendered = plain(component, 120);
		expect(rendered).not.toContain(SECRET_TOKEN);
		component.handleInput("4");
		await flushAsync();
		component.handleInput("k");
		for (const char of "openai") component.handleInput(char);
		component.handleInput("\n");
		for (const char of API_KEY) component.handleInput(char);
		expect(plain(component, 120)).not.toContain(API_KEY);
		component.handleInput("\n");
		await flushAsync();
		expect(JSON.stringify(component.controller.state)).not.toContain(API_KEY);
		expect(plain(component, 120)).not.toContain(API_KEY);
		component.dispose?.();
	});

	it("keeps submitted one-time-token prompts busy until the token result appears", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();

		const createToken = deferred<AuthGatewayIssuedTokenValue>();
		fake.addUserTokenQueue.push(createToken);
		component.handleInput("T");
		typeAndSubmit(component, "cli");
		await flushAsync();

		expect(fake.addUserTokenCalls).toEqual([{ userId: 1, label: "cli" }]);
		expect(plain(component, 120)).toContain("Creating token…");
		component.handleInput("\x1b");
		component.handleInput("\x03");
		expect(plain(component, 120)).toContain("Creating token…");

		createToken.resolve({ id: 502, value: SECRET_TOKEN, label: "cli" });
		await waitUntil(() => plain(component, 120).includes("One-time token"), "created token dialog did not open");
		component.handleInput("\n");
		await flushAsync();

		const rotatedToken = deferred<AuthGatewayIssuedTokenValue>();
		fake.rotateUserTokenQueue.push(rotatedToken);
		component.handleInput("R");
		typeAndSubmit(component, "rotate alice");
		await flushAsync();

		expect(fake.rotateUserCalls).toEqual([1]);
		expect(plain(component, 120)).toContain("Rotating tokens…");
		component.handleInput("\x1b");
		expect(plain(component, 120)).toContain("Rotating tokens…");

		rotatedToken.resolve({ id: 503, value: SECRET_TOKEN, label: null });
		await waitUntil(() => plain(component, 120).includes("One-time token"), "rotated token dialog did not open");
		component.dispose?.();
	});

	it("opens one-time token modals once while failed post-mutation refetches mark stale", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		const actions = [
			{
				open: "T",
				input: "cli",
				promptLabel: "Token label",
				refetchError: "token refetch failed",
				calls: () => fake.addUserTokenCalls.length,
			},
			{
				open: "R",
				input: "rotate alice",
				promptLabel: "Type rotate alice",
				refetchError: "rotate refetch failed",
				calls: () => fake.rotateUserCalls.length,
			},
		];

		for (const action of actions) {
			const refetch = deferred<AuthGatewayUser[]>();
			fake.userListQueue.push(refetch);
			const expectedCalls = action.calls() + 1;
			component.handleInput(action.open);
			typeAndSubmit(component, action.input);
			await waitUntil(
				() => action.calls() === expectedCalls,
				() => `${action.open} mutation was not sent`,
			);
			await waitUntil(
				() => plain(component, 120).includes(SECRET_TOKEN),
				() => `${action.open} token modal did not open`,
			);
			let rendered = plain(component, 120);
			expect(Array.from(rendered.matchAll(new RegExp(SECRET_TOKEN, "g")))).toHaveLength(1);
			expect(rendered).toContain("One-time token");
			expect(rendered).not.toContain(action.promptLabel);
			refetch.reject(new Error(action.refetchError));
			await flushAsync();
			rendered = plain(component, 120);
			expect(Array.from(rendered.matchAll(new RegExp(SECRET_TOKEN, "g")))).toHaveLength(1);
			expect(rendered).toContain("Stale");
			expect(rendered).toContain(action.refetchError);
			component.handleInput("\n");
			await flushAsync();
			expect(plain(component, 120)).not.toContain(SECRET_TOKEN);
			expect(JSON.stringify(component.controller.state)).not.toContain(SECRET_TOKEN);
		}
		component.dispose?.();
	});

	it("guides user form creation, preserves one-time tokens once, and keeps Escape reversible", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();

		component.handleInput("c");
		let rendered = plain(component, 120);
		expect(rendered).toContain("Create user name");
		expect(rendered).toContain("Lowercase letters, digits, _ and -; must start with a letter; 1–64 characters.");
		typeAndSubmit(component, "carol");
		expect(plain(component, 120)).toContain("Create user description");
		typeAndSubmit(component, "Batch runner");
		expect(plain(component, 120)).toContain("Create user owner");
		typeAndSubmit(component, "ops");
		rendered = plain(component, 120);
		expect(rendered).toContain("Create user role");
		expect(rendered).toContain("ACLs and ordered pool bindings apply");
		expect(rendered).toContain("Bypasses ACLs and cannot bind pools");
		component.handleInput("\n");
		rendered = plain(component, 120);
		expect(rendered).toContain("Review user");
		expect(rendered).toContain("Name: carol");
		expect(rendered).toContain("Save user");
		component.handleInput("\n");
		await waitUntil(() => fake.createUserCalls.length === 1, "create user was not submitted");
		expect(fake.createUserCalls).toEqual([
			{ name: "carol", description: "Batch runner", owner: "ops", role: "user" },
		]);
		await waitUntil(() => plain(component, 120).includes("One-time token"), "create user token modal did not open");
		rendered = plain(component, 120);
		expect(rendered).toContain("One-time token");
		expect(Array.from(rendered.matchAll(new RegExp(SECRET_TOKEN, "g")))).toHaveLength(1);
		component.handleInput("\n");
		await flushAsync();
		expect(JSON.stringify(component.controller.state)).not.toContain(SECRET_TOKEN);

		component.handleInput("c");
		typeAndSubmit(component, "dana");
		expect(plain(component, 120)).toContain("Create user description");
		component.handleInput("\x1b");
		expect(plain(component, 120)).toContain("Create user name");
		component.handleInput("\x1b");
		expect(component.controller.state.modalOpen).toBe(false);
		expect(plain(component, 120)).not.toContain("Create user");
		component.dispose?.();
	});

	it("guides user form edit with current values and exact nullable update input", async () => {
		fake.users = [{ ...user(1, "alice", "admin"), description: "Current desc", owner: "infra" }, user(2, "bob")];
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		component.handleInput("e");
		let rendered = plain(component, 120);
		expect(rendered).toContain("Edit user description");
		expect(rendered).toContain("Current desc");
		component.handleInput("\x15");
		component.handleInput("\n");
		rendered = plain(component, 120);
		expect(rendered).toContain("Edit user owner");
		expect(rendered).toContain("infra");
		component.handleInput("\x15");
		typeAndSubmit(component, "platform");
		rendered = plain(component, 120);
		expect(rendered).toContain("Edit user role");
		expect(rendered).toContain("Current role: admin");
		component.handleInput("\n");
		rendered = plain(component, 120);
		expect(rendered).toContain("Save changes");
		component.handleInput("\n");
		await waitUntil(() => fake.updateUserCalls.length === 1, "update user was not submitted");
		expect(fake.updateUserCalls).toEqual([
			{ userId: 1, input: { description: null, owner: "platform", role: "admin" } },
		]);
		component.dispose?.();
	});

	it("guides pool form create and edit without provider or model fields", async () => {
		fake.pools = [{ ...pool(10, "primary", [11, 12]), strategy: "least-used" }];
		const component = makeConsole();
		await component.ready;
		component.handleInput("3");
		await flushAsync();
		expect(fake.listCredentialsCalls).toBeGreaterThan(0);
		expect(plain(component, 120)).toContain("primary · least-used · 2 accounts");

		component.handleInput("c");
		let rendered = plain(component, 120);
		expect(rendered).toContain("Create pool name");
		expect(rendered).toContain("Lowercase letters, digits, _ and -; must start with a letter; 1–64 characters.");
		expect(rendered).not.toContain("provider");
		typeAndSubmit(component, "overflow");
		rendered = plain(component, 120);
		expect(rendered).toContain("Pool strategy");
		expect(rendered).toContain("least-used ranks live OAuth usage for new/replacement sessions");
		clickRenderedLine(component, "least-used");
		expect(plain(component, 120)).toContain("Review pool");
		component.handleInput("\n");
		await waitUntil(() => fake.createPoolCalls.length === 1, "create pool was not submitted");
		await waitUntil(() => !plain(component, 120).includes("Review pool"), "create pool flow did not close");
		expect(fake.createPoolCalls).toEqual([{ name: "overflow", strategy: "least-used" }]);

		component.handleInput("e");
		rendered = plain(component, 120);
		expect(rendered).toContain("Edit pool name");
		expect(rendered).toContain("primary");
		component.handleInput("\x15");
		typeAndSubmit(component, "primary-renamed");
		expect(plain(component, 120)).toContain("Current strategy: least-used");
		component.handleInput("\n");
		component.handleInput("\n");
		await waitUntil(() => fake.updatePoolCalls.length === 1, "update pool was not submitted");
		expect(fake.updatePoolCalls).toEqual([
			{ poolId: 10, input: { name: "primary-renamed", strategy: "least-used" } },
		]);
		component.dispose?.();
	});

	it("uses redacted pool account pickers for add and removable unavailable members", async () => {
		fake.pools = [pool(10, "primary", [11, 99])];
		fake.credentials = [credential(11, "anthropic"), credential(12, "openai", "api_key")];
		const component = makeConsole();
		await component.ready;
		component.handleInput("3");
		await flushAsync();
		let rendered = plain(component, 120);
		expect(rendered).toContain("#11 · anthropic · oauth");
		expect(rendered).toContain("#99 · unavailable");

		component.handleInput("a");
		await waitUntil(
			() => plain(component, 120).includes("#12 · openai · api_key"),
			"pool account picker did not load",
		);
		rendered = plain(component, 120);
		expect(rendered).toContain("Add pool account");
		expect(rendered).toContain("#12 · openai · api_key");
		expect(rendered).not.toContain("#11 · anthropic");
		clickRenderedLine(component, "#12 · openai · api_key");
		await waitUntil(() => fake.addPoolCredentialCalls.length === 1, "add pool account was not submitted");
		expect(fake.addPoolCredentialCalls).toEqual([{ poolId: 10, credentialId: 12 }]);
		await waitUntil(() => !plain(component, 120).includes("Add pool account"), "add pool account flow did not close");

		component.handleInput("x");
		expect(plain(component, 120)).toContain("#99 · unavailable");
		clickRenderedLine(component, "#99 · unavailable");
		expect(plain(component, 120)).toContain("Remove pool account #99?");
		component.handleInput("\n");
		expect(fake.removePoolCredentialCalls).toEqual([]);
		clickRenderedLine(component, "#99 · unavailable");
		fake.nextRemovePoolCredentialError = new AuthGatewayAdminClientError(
			500,
			"internal_error",
			"managed-token remove failed",
		);
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await waitUntil(() => fake.removePoolCredentialCalls.length === 1, "remove pool account was not submitted");
		rendered = plain(component, 120);
		expect(rendered).toContain("remove failed");
		expect(rendered).toContain("[redacted]");
		expect(rendered).toContain("Remove pool account #99?");
		component.dispose?.();
	});

	it("uses pool binding pickers and exact order permutations for user binding reorder", async () => {
		fake.pools = [pool(10, "primary", [11]), pool(20, "secondary", [12]), pool(30, "tertiary", [])];
		fake.userPoolIds.set(1, [10, 20]);
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		let rendered = plain(component, 120);
		expect(rendered).toContain("1. primary · round-robin · 1 accounts");
		expect(rendered).toContain("2. secondary · round-robin · 1 accounts");

		component.handleInput("]");
		expect(component.controller.state.selectedUserPoolBindingIndex).toBe(1);
		component.handleInput("-");
		await waitUntil(() => fake.setUserPoolOrderCalls.length === 1, "pool order was not submitted");
		expect(fake.setUserPoolOrderCalls).toEqual([{ userId: 1, poolIds: [20, 10] }]);
		expect(component.controller.state.selectedUserPoolBindingIndex).toBe(0);

		component.handleInput("b");
		await waitUntil(() => plain(component, 120).includes("tertiary"), "bind pool picker did not load");
		rendered = plain(component, 120);
		expect(rendered).toContain("Bind pool");
		expect(rendered).toContain("tertiary");
		expect(rendered).not.toContain("primary");
		fake.nextBindUserPoolError = new AuthGatewayAdminClientError(409, "conflict", "managed-token bind failed");
		clickRenderedLine(component, "tertiary");
		await waitUntil(() => fake.bindUserPoolCalls.length === 1, "bind pool was not submitted");
		await waitUntil(() => plain(component, 120).includes("bind failed"), "bind error did not render");
		rendered = plain(component, 120);
		expect(rendered).toContain("bind failed");
		expect(rendered).toContain("[redacted]");
		expect(rendered).toContain("Bind pool");
		component.handleInput("\x1b");
		await waitUntil(() => component.controller.state.modalOpen === false, "bind flow did not close after Escape");

		component.handleInput("u");
		await waitUntil(() => plain(component, 120).includes("Unbind pool"), "unbind pool picker did not load");
		rendered = plain(component, 120);
		expect(rendered).toContain("Unbind pool");
		expect(rendered).toContain("secondary");
		clickRenderedLine(component, "secondary");
		expect(plain(component, 120)).toContain("Unbind secondary?");
		component.handleInput("\n");
		expect(fake.unbindUserPoolCalls).toEqual([]);
		clickRenderedLine(component, "secondary");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await waitUntil(() => fake.unbindUserPoolCalls.length === 1, "unbind pool was not submitted");
		expect(fake.unbindUserPoolCalls).toEqual([{ userId: 1, poolId: 20 }]);
		component.dispose?.();
	});

	it("keeps user pool binding unbind load failures reversible", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		delete component.controller.state.userDetails[1];
		const detail = deferred<AuthGatewayUserDetails>();
		fake.userDetailQueue.set(1, detail);

		component.handleInput("u");
		expect(component.controller.state.modalOpen).toBe(true);
		expect(plain(component, 120)).toContain("Loading user pools…");

		detail.reject(new AuthGatewayAdminClientError(500, "internal_error", "managed-token details failed"));
		await waitUntil(() => plain(component, 120).includes("details failed"), "unbind detail error did not render");
		const rendered = plain(component, 120);
		expect(rendered).toContain("[redacted]");
		expect(rendered).toContain("Unbind pool");
		expect(component.controller.state.modalOpen).toBe(true);
		component.handleInput("\x1b");
		expect(component.controller.state.modalOpen).toBe(false);
		expect(fake.unbindUserPoolCalls).toEqual([]);
		component.dispose?.();
	});

	it("wires advertised audit, pool, and account controls to implemented actions", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("5");
		await flushAsync();
		component.handleInput("n");
		await flushAsync();
		expect(fake.listAuditQueries.at(-1)).toEqual({ limit: 50, before: 50 });
		component.handleInput("p");
		await flushAsync();
		expect(fake.listAuditQueries.at(-1)).toEqual({ limit: 50, before: 50 });

		component.handleInput("3");
		await flushAsync();
		component.handleInput("+");
		await flushAsync();
		expect(fake.setPoolCredentialOrderCalls).toEqual([{ poolId: 10, credentialIds: [12, 11] }]);

		component.handleInput("4");
		await flushAsync();
		component.handleInput("o");
		await flushAsync();
		expect(fake.refreshCredentialCalls).toEqual([11]);
		expect(plain(component, 120)).toContain("c copy identifiers");
		expect(plain(component, 120)).toContain("OAuth credentials can be refreshed");
		component.dispose?.();
	});

	it("does not pause polling with hidden modal state when destructive actions have no selected row", async () => {
		const component = makeConsole();
		await component.ready;
		fake.users = [];
		component.handleInput("2");
		await flushAsync();
		component.handleInput("d");
		expect(component.controller.state.modalOpen).toBe(false);
		expect(plain(component, 120)).not.toContain("Type ");
		fake.credentials = [];
		component.handleInput("4");
		await flushAsync();
		component.handleInput("d");
		expect(component.controller.state.modalOpen).toBe(false);
		expect(plain(component, 120)).not.toContain("Type ");
		component.dispose?.();
	});

	it("opens the /login provider picker from Accounts and cancels without starting login", async () => {
		let loginStarts = 0;
		registerOAuthProvider({
			id: "task6-picker-login",
			name: "Task 6 Picker Login",
			sourceId: OAUTH_SOURCE_ID,
			async login() {
				loginStarts++;
				return API_KEY;
			},
		});
		let hostCloseCalls = 0;
		const component = new AuthGatewayConsole({
			connection,
			profileStore: store,
			createClient: () => fake as unknown as AuthGatewayAdminClient,
			host: { ui: new TUI(new VirtualTerminal(120, 32)), openInBrowser: () => {}, close: () => hostCloseCalls++ },
		});
		await component.ready;
		component.handleInput("4");
		await flushAsync();
		component.handleInput("l");
		let rendered = plain(component, 120);
		expect(rendered).toContain("Select provider to login:");
		expect(rendered).not.toContain("Provider id:");
		for (const char of "task6-picker-login") component.handleInput(char);
		rendered = plain(component, 120);
		expect(rendered).toContain("Task 6 Picker Login");
		component.handleInput("\x1b");
		await flushAsync();
		expect(loginStarts).toBe(0);
		expect(hostCloseCalls).toBe(0);
		expect(component.controller.state.modalOpen).toBe(false);

		component.handleInput("l");
		for (const char of "provider-with-no-match") component.handleInput(char);
		component.handleInput("\n");
		await flushAsync();
		expect(loginStarts).toBe(0);
		expect(fake.uploadCredentialCalls).toEqual([]);
		expect(component.controller.state.modalOpen).toBe(true);

		component.handleInput("\x1b");
		await flushAsync();
		rendered = plain(component, 120);
		expect(hostCloseCalls).toBe(0);
		expect(component.controller.state.modalOpen).toBe(false);
		expect(rendered).not.toContain("Select provider to login:");
		component.dispose?.();
	});

	it("clears account-login cancellation when the provider retry UI opens", async () => {
		let attempts = 0;
		registerOAuthProvider({
			id: "task6-retry-login",
			name: "Task 6 Retry Login",
			sourceId: OAUTH_SOURCE_ID,
			async login() {
				attempts++;
				return attempts === 1 ? "" : API_KEY;
			},
		});
		const component = makeConsole();
		await component.ready;
		component.handleInput("4");
		await flushAsync();
		const listCredentialsCallsBeforeLogin = fake.listCredentialsCalls;

		component.handleInput("l");
		typeAndSubmit(component, "task6-retry-login");
		await waitUntil(
			() => plain(component, 120).includes("Account login cancelled"),
			"cancelled login did not render",
		);
		expect(component.controller.state.errorBanner).toBe("Account login cancelled");
		expect(component.controller.state.health).toBe("Connected");

		component.handleInput("l");

		expect(plain(component, 120)).toContain("Select provider to login:");
		expect(plain(component, 120)).not.toContain("Account login cancelled");
		typeAndSubmit(component, "task6-retry-login");
		await waitUntil(() => fake.uploadCredentialCalls.length === 1, "retry login did not upload credential");

		expect(fake.uploadCredentialCalls).toEqual([
			{ provider: "task6-retry-login", credential: { type: "api_key", key: API_KEY } },
		]);
		expect(fake.listCredentialsCalls).toBe(listCredentialsCallsBeforeLogin + 1);
		expect(component.controller.state.health).toBe("Connected");
		expect(component.controller.state.errorBanner).toBeNull();
		component.dispose?.();
	});

	it("routes Accounts provider-picker mouse selection through console body offsets", async () => {
		registerOAuthProvider({
			id: "task6-picker-mouse",
			name: "Task 6 Picker Mouse",
			sourceId: OAUTH_SOURCE_ID,
			async login() {
				return API_KEY;
			},
		});
		const component = makeConsole();
		await component.ready;
		component.handleInput("4");
		await flushAsync();
		const listCredentialsCallsBeforeLogin = fake.listCredentialsCalls;

		component.handleInput("l");
		for (const char of "task6-picker-mouse") component.handleInput(char);
		component.render(120);
		component.handleInput("\x1b[<0;4;9M");
		await waitUntil(() => fake.uploadCredentialCalls.length === 1, "provider-picker mouse did not select provider");

		expect(fake.uploadCredentialCalls).toEqual([
			{ provider: "task6-picker-mouse", credential: { type: "api_key", key: API_KEY } },
		]);
		expect(fake.listCredentialsCalls).toBe(listCredentialsCallsBeforeLogin + 1);
		expect(component.controller.state.modalOpen).toBe(false);
		component.dispose?.();
	});

	it("renders the full authorization URL as a clickable width-safe link", async () => {
		const opened: string[] = [];
		const pendingLogin = deferred<string>();
		registerOAuthProvider({
			id: "task6-link-oauth",
			name: "Task 6 Link OAuth",
			sourceId: OAUTH_SOURCE_ID,
			async login(callbacks) {
				callbacks.onAuth({
					url: LINEAR_AUTH_URL,
					launchUrl: "http://localhost:14570/launch",
					instructions: "Use the browser to authorize",
				});
				callbacks.onProgress?.("Waiting for authorization");
				return await pendingLogin.promise;
			},
		});
		const component = new AuthGatewayConsole({
			connection,
			profileStore: store,
			createClient: () => fake as unknown as AuthGatewayAdminClient,
			host: { ui: new TUI(new VirtualTerminal(120, 32)), openInBrowser: url => opened.push(url), close: () => {} },
		});
		await component.ready;
		component.handleInput("4");
		await flushAsync();
		component.handleInput("l");
		typeAndSubmit(component, "task6-link-oauth");
		await flushAsync();

		const rawLines = component.render(80);
		const innerPlainLines = rawLines.map(line =>
			Bun.stripANSI(line).replace(/^│ ?/, "").replace(/ ?│$/, "").trimEnd(),
		);
		for (const line of innerPlainLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
		expect(opened).toEqual([LINEAR_AUTH_URL]);
		expect(rawLines.join("\n").match(/\x1b\]8;[^;]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/)?.[1]).toBe(LINEAR_AUTH_URL);
		expect(reassembleUrl(innerPlainLines, COPY_URL_LABEL)).toBe(LINEAR_AUTH_URL);
		expect(reassembleUrl(innerPlainLines, COPY_URL_LABEL)).toEndWith("&code_challenge_method=S256");
		expect(reassembleUrl(innerPlainLines, SHORTCUT_LABEL)).toBe("http://localhost:14570/launch");
		expect(plain(component, 120)).not.toContain(OAUTH_ACCESS);
		pendingLogin.resolve(API_KEY);
		await waitUntil(() => fake.uploadCredentialCalls.length === 1, "link OAuth login did not finish");
		component.dispose?.();
	});

	it("keeps the ACL add flow reversible from pattern to Users without stale prompts", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();

		component.handleInput("a");
		expect(plain(component, 120)).toContain("Add ACL effect");
		expect(component.controller.state.modalOpen).toBe(true);
		component.handleInput("\n");
		expect(plain(component, 120)).toContain("Add ACL kind");
		component.handleInput("\n");
		await flushAsync();
		expect(plain(component, 120)).toContain("Add ACL provider pattern");
		expect(plain(component, 120)).toContain("Custom pattern…");

		component.handleInput("\x1b");
		expect(plain(component, 120)).toContain("Add ACL kind");
		expect(plain(component, 120)).not.toContain("ACL pattern:");
		component.handleInput("\x1b");
		expect(plain(component, 120)).toContain("Add ACL effect");
		component.handleInput("\x1b");
		const rendered = plain(component, 120);
		expect(rendered).toContain("Users");
		expect(rendered).not.toContain("Add ACL");
		expect(rendered).not.toContain("ACL pattern:");
		expect(component.controller.state.modalOpen).toBe(false);
		component.dispose?.();
	});

	it("closes the ACL flow with Ctrl-C from every depth", async () => {
		for (const depth of ["effect", "kind", "pattern"] as const) {
			const component = makeConsole();
			await component.ready;
			component.handleInput("2");
			await flushAsync();
			component.handleInput("a");
			if (depth === "kind" || depth === "pattern") component.handleInput("\n");
			if (depth === "pattern") component.handleInput("\n");

			component.handleInput("\x03");

			expect(component.controller.state.modalOpen).toBe(false);
			expect(plain(component, 120)).not.toContain("Add ACL");
			component.dispose?.();
		}
	});

	it("renders catalog-backed ACL provider, model, and route suggestions", async () => {
		fake.credentials = [credential(21, "zed"), credential(22, "anthropic"), credential(23, "openai", "api_key")];
		fake.models = [
			modelSummary("claude-3-5-sonnet", "anthropic"),
			modelSummary("gemini-2.0-flash", "google"),
			modelSummary("gpt-4o", "openai"),
		];
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();

		component.handleInput("a");
		component.handleInput("\n");
		component.handleInput("\n");
		await flushAsync();
		let rendered = plain(component, 120);
		expect(rendered).toContain("Add ACL provider pattern");
		for (const provider of ["*", "anthropic", "google", "openai", "zed", "Custom pattern…"]) {
			expect(rendered).toContain(provider);
		}
		expect(fake.listCredentialsCalls).toBeGreaterThan(0);
		expect(fake.listModelsCalls).toBe(1);

		component.handleInput("\x1b");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await flushAsync();
		rendered = plain(component, 120);
		expect(rendered).toContain("Add ACL model pattern");
		for (const pattern of [
			"*",
			"anthropic/*",
			"google/*",
			"openai/*",
			"anthropic/claude-3-5-sonnet",
			"google/gemini-2.0-flash",
			"openai/gpt-4o",
			"Custom pattern…",
		]) {
			expect(rendered).toContain(pattern);
		}

		component.handleInput("\x1b");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		rendered = plain(component, 120);
		expect(rendered).toContain("Add ACL route pattern");
		expect(rendered).toContain("Basic routes");
		expect(rendered).toContain(AUTH_GATEWAY_BASIC_ROUTES.join(", "));
		expect(rendered).toContain("All routes (*)");
		for (const route of AUTH_GATEWAY_ACL_ROUTES) expect(rendered).toContain(route);
		component.dispose?.();
	});

	it("routes ACL flow mouse selections through console body offsets", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		component.handleInput("a");
		component.render(120);

		clickRenderedLine(component, "Deny");

		expect(plain(component, 120)).toContain("Add ACL kind");
		component.dispose?.();
	});

	it("submits Basic routes as one busy ACL batch and rejects duplicate submissions", async () => {
		const pendingAdd = deferred<Array<{ rule: AuthGatewayAclRule; created: boolean }>>();
		fake.addAclRulesQueue.push(pendingAdd);
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		component.handleInput("a");
		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\n");
		await flushAsync();

		expect(plain(component, 120)).toContain("Adding ACL rules…");
		expect(fake.addAclRulesCalls).toEqual([
			{
				userId: 1,
				rules: AUTH_GATEWAY_BASIC_ROUTES.map(pattern => ({ effect: "allow", kind: "route", pattern })),
			},
		]);
		component.handleInput("\n");
		clickRenderedLine(component, "Basic routes");
		expect(fake.addAclRulesCalls).toHaveLength(1);

		pendingAdd.resolve([]);
		await flushAsync();
		component.dispose?.();
	});

	it("guides custom ACL provider input through the same batch API", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		component.handleInput("a");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		component.handleInput("\n");
		await flushAsync();
		clickRenderedLine(component, "Custom pattern…");
		expect(plain(component, 120)).toContain("ACL provider pattern:");

		typeAndSubmit(component, "   ");
		await flushAsync();
		expect(fake.addAclRulesCalls).toEqual([]);
		expect(plain(component, 120)).toContain("ACL pattern is required");

		component.handleInput("\x15");
		typeAndSubmit(component, "anthropic");
		await flushAsync();
		expect(fake.addAclRulesCalls).toEqual([
			{ userId: 1, rules: [{ effect: "deny", kind: "provider", pattern: "anthropic" }] },
		]);
		component.dispose?.();
	});

	it("loads ACL rules for deletion, defaults confirmation to No, and lets Escape/No return to the picker", async () => {
		const pendingDetails = deferred<AuthGatewayUserDetails>();
		fake.userDetailQueue.set(1, pendingDetails);
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();

		component.handleInput("x");
		expect(fake.getUserCalls.filter(id => id === 1).length).toBeGreaterThan(0);
		pendingDetails.resolve({ user: user(1, "alice", "admin"), tokens: [], acl: [aclRule(301, 1)], poolBindings: [] });
		await waitUntil(() => plain(component, 120).includes("#301"), "ACL delete picker did not load details");
		expect(plain(component, 120)).toContain("allow route /v1/chat/*");

		component.handleInput("\n");
		expect(plain(component, 120)).toContain("Delete ACL rule #301?");
		component.handleInput("\n");
		expect(fake.deleteAclRuleCalls).toEqual([]);
		expect(plain(component, 120)).toContain("Delete ACL rule");
		expect(plain(component, 120)).toContain("#301");

		component.handleInput("\n");
		component.handleInput("\x1b");
		pendingDetails.resolve({ user: user(1, "alice", "admin"), tokens: [], acl: [aclRule(301, 1)], poolBindings: [] });
		expect(plain(component, 120)).toContain("Delete ACL rule");
		expect(plain(component, 120)).toContain("#301");
		component.dispose?.();
	});

	it("keeps ACL deletion feedback in the dialog until success refreshes the picker or closes the last rule", async () => {
		fake.acl.set(1, [aclRule(301, 1), { ...aclRule(302, 1), pattern: "models" }]);
		const pendingDelete = deferred<void>();
		fake.deleteAclRuleQueue.push(pendingDelete);
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();

		component.handleInput("x");
		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await flushAsync();
		expect(plain(component, 120)).toContain("Deleting ACL rule #301…");
		expect(fake.deleteAclRuleCalls).toEqual([{ userId: 1, ruleId: 301 }]);

		pendingDelete.resolve();
		await waitUntil(
			() => !plain(component, 120).includes("#301") && plain(component, 120).includes("#302"),
			"ACL picker did not refresh after delete",
		);
		expect(component.controller.state.modalOpen).toBe(true);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await waitUntil(() => component.controller.state.modalOpen === false, "last ACL delete did not close dialog");
		expect(plain(component, 120)).toContain("Deleted ACL rule #302");
		component.dispose?.();
	});

	it("keeps failed ACL deletion confirmation open with the sanitized error", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		fake.nextAclDeleteError = new AuthGatewayAdminClientError(404, "not_found", "managed-token missing");

		component.handleInput("x");
		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await flushAsync();

		expect(component.controller.state.modalOpen).toBe(true);
		expect(plain(component, 120)).toContain("not_found");
		expect(plain(component, 120)).not.toContain("managed-token");
		expect(plain(component, 120)).toContain("Delete ACL rule #301?");
		component.dispose?.();
	});

	it("closes ACL deletion confirmation when the post-delete visible refresh fails", async () => {
		fake.acl.set(1, [aclRule(301, 1), { ...aclRule(302, 1), pattern: "models" }]);
		const component = makeConsole();
		await component.ready;
		component.handleInput("2");
		await flushAsync();

		component.handleInput("x");
		component.handleInput("\n");
		component.handleInput("\x1b[B");
		const pendingRefresh = deferred<AuthGatewayUserDetails>();
		fake.userDetailQueue.set(1, pendingRefresh);
		component.handleInput("\n");
		await flushAsync();
		expect(fake.deleteAclRuleCalls).toEqual([{ userId: 1, ruleId: 301 }]);

		pendingRefresh.reject(new Error("refresh failed for managed-token"));
		await waitUntil(
			() => component.controller.state.errorBanner?.includes("refresh failed") === true,
			"refresh error did not reach controller state",
		);

		const rendered = plain(component, 120);
		expect(component.controller.state.modalOpen).toBe(false);
		expect(component.controller.state.errorBannerSource).toBe("visible-load");
		expect(rendered).toContain("refresh failed");
		expect(rendered).toContain("[redacted]");
		expect(rendered).not.toContain("managed-token");
		expect(rendered).not.toContain("Delete ACL rule #301?");
		expect(rendered).not.toContain("Deleted ACL rule #301");
		expect(rendered).not.toContain("Choose an ACL rule to delete.");
		component.dispose?.();
	});

	it("clears list filters before closing the console", async () => {
		let hostCloseCalls = 0;
		const component = new AuthGatewayConsole({
			connection,
			profileStore: store,
			createClient: () => fake as unknown as AuthGatewayAdminClient,
			host: { ui: new TUI(new VirtualTerminal(120, 32)), openInBrowser: () => {}, close: () => hostCloseCalls++ },
		});
		await component.ready;
		component.handleInput("2");
		await flushAsync();
		component.handleInput("/");
		typeAndSubmit(component, "bob");
		expect(plain(component, 120)).toContain("filter: bob");
		expect(plain(component, 120)).toContain("Esc clear filter");

		component.handleInput("\x1b");
		await flushAsync();
		expect(component.controller.state.filter).toBe("");
		expect(hostCloseCalls).toBe(0);
		expect(plain(component, 120)).toContain("Esc close");
		expect(plain(component, 120)).toContain("alice");

		component.handleInput("\x1b");
		expect(hostCloseCalls).toBe(1);
		component.dispose?.();
	});

	it("clears Audit text and user filters together before closing", async () => {
		let hostCloseCalls = 0;
		const component = new AuthGatewayConsole({
			connection,
			profileStore: store,
			createClient: () => fake as unknown as AuthGatewayAdminClient,
			host: { ui: new TUI(new VirtualTerminal(120, 32)), openInBrowser: () => {}, close: () => hostCloseCalls++ },
		});
		await component.ready;
		component.handleInput("5");
		await flushAsync();
		component.handleInput("u");
		typeAndSubmit(component, "2");
		await flushAsync();
		component.handleInput("/");
		typeAndSubmit(component, "req-1");
		expect(plain(component, 120)).toContain("text: req-1");
		expect(plain(component, 120)).toContain("user: 2");
		const queriesBeforeClear = fake.listAuditQueries.length;

		component.handleInput("\x1b");
		await flushAsync();
		expect(component.controller.state.audit.textFilter).toBe("");
		expect(component.controller.state.audit.userFilter).toBeNull();
		expect(hostCloseCalls).toBe(0);
		expect(fake.listAuditQueries).toHaveLength(queriesBeforeClear + 1);
		expect(fake.listAuditQueries.at(-1)).toEqual({ limit: 50 });

		component.handleInput("\x1b");
		expect(hostCloseCalls).toBe(1);
		component.dispose?.();
	});

	it("blocks normal console shortcuts while account login waits without a prompt and cancels with Esc or Ctrl-C", async () => {
		const loginWaits = [deferred<string>(), deferred<string>()];
		let loginCount = 0;
		let abortCount = 0;
		const provider: OAuthProviderInterface = {
			id: "task6-waiting-login",
			name: "Task 6 Waiting Login",
			sourceId: OAUTH_SOURCE_ID,
			async login(callbacks) {
				const wait = loginWaits[loginCount++]!;
				callbacks.onProgress?.("Waiting for browser authorization");
				callbacks.signal?.addEventListener(
					"abort",
					() => {
						abortCount++;
						wait.resolve("");
					},
					{ once: true },
				);
				return await wait.promise;
			},
		};
		registerOAuthProvider(provider);
		let hostCloseCalls = 0;
		const component = new AuthGatewayConsole({
			connection,
			profileStore: store,
			createClient: () => fake as unknown as AuthGatewayAdminClient,
			host: { ui: new TUI(new VirtualTerminal(120, 32)), openInBrowser: () => {}, close: () => hostCloseCalls++ },
		});
		await component.ready;
		component.handleInput("4");
		await flushAsync();
		const listCredentialsCallsBeforeLogin = fake.listCredentialsCalls;
		component.handleInput("l");
		typeAndSubmit(component, "task6-waiting-login");
		await flushAsync();
		expect(plain(component, 120)).toContain("Waiting for browser authorization");

		component.handleInput("1");
		component.handleInput("r");
		component.handleInput("\t");
		component.handleInput("o");
		component.handleInput("d");
		component.handleInput("/");
		await flushAsync();
		expect(component.controller.state.activeTab).toBe("accounts");
		expect(fake.listCredentialsCalls).toBe(listCredentialsCallsBeforeLogin);
		expect(fake.refreshCredentialCalls).toEqual([]);
		expect(fake.removeCredentialCalls).toEqual([]);
		expect(plain(component, 120)).not.toContain("Provider id:");
		expect(plain(component, 120)).not.toContain("Type 11 to remove");
		expect(plain(component, 120)).not.toContain("Filter:");

		component.handleInput("\x1b");
		await flushAsync();
		expect(abortCount).toBe(1);
		expect(hostCloseCalls).toBe(0);
		expect(component.controller.state.modalOpen).toBe(false);
		expect(plain(component, 120)).not.toContain("Account login");

		component.handleInput("l");
		typeAndSubmit(component, "task6-waiting-login");
		await flushAsync();
		expect(plain(component, 120)).toContain("Waiting for browser authorization");
		component.handleInput("\x03");
		await flushAsync();
		expect(abortCount).toBe(2);
		expect(hostCloseCalls).toBe(0);
		expect(component.controller.state.modalOpen).toBe(false);
		expect(plain(component, 120)).not.toContain("Account login");
		expect(fake.uploadCredentialCalls).toEqual([]);
		component.dispose?.();
	});
	it("ignores mouse routing while account login waits and keeps post-login refresh on Accounts", async () => {
		const loginWait = deferred<string>();
		const provider: OAuthProviderInterface = {
			id: "task6-mouse-waiting-login",
			name: "Task 6 Mouse Waiting Login",
			sourceId: OAUTH_SOURCE_ID,
			async login(callbacks) {
				callbacks.onProgress?.("Waiting for browser authorization");
				return await loginWait.promise;
			},
		};
		registerOAuthProvider(provider);
		const component = makeConsole();
		await component.ready;

		component.render(120);
		component.handleInput("\x1b[<0;25;2M");
		await flushAsync();
		expect(component.controller.state.activeTab).toBe("pools");

		component.handleInput("4");
		await flushAsync();
		const listCredentialsCallsBeforeLogin = fake.listCredentialsCalls;
		const listPoolsCallsBeforeLogin = fake.listPoolsCalls;
		component.handleInput("l");
		typeAndSubmit(component, "task6-mouse-waiting-login");
		await flushAsync();
		expect(plain(component, 120)).toContain("Waiting for browser authorization");

		component.render(120);
		component.handleInput("\x1b[<0;25;2M");
		await flushAsync();
		expect(component.controller.state.activeTab).toBe("accounts");
		expect(fake.listCredentialsCalls).toBe(listCredentialsCallsBeforeLogin);
		expect(fake.listPoolsCalls).toBe(listPoolsCallsBeforeLogin);
		expect(fake.uploadCredentialCalls).toEqual([]);

		loginWait.resolve(API_KEY);
		await waitUntil(() => fake.uploadCredentialCalls.length === 1, "account login did not upload");
		expect(fake.uploadCredentialCalls).toEqual([
			{ provider: "task6-mouse-waiting-login", credential: { type: "api_key", key: API_KEY } },
		]);
		expect(component.controller.state.activeTab).toBe("accounts");
		expect(fake.listCredentialsCalls).toBe(listCredentialsCallsBeforeLogin + 1);
		expect(fake.listPoolsCalls).toBe(listPoolsCallsBeforeLogin);
		expect(component.controller.state.modalOpen).toBe(false);
		component.dispose?.();
	});

	it("runs account login with browser and manual-code prompts and shows upload failure after clearing credentials", async () => {
		const opened: string[] = [];
		const provider: OAuthProviderInterface = {
			id: "task6-oauth",
			name: "Task 6 OAuth",
			sourceId: OAUTH_SOURCE_ID,
			async login(callbacks) {
				callbacks.onAuth({
					url: "https://auth.example.com/full",
					launchUrl: "https://auth.example.com/launch",
					instructions: "Enter the displayed code",
				});
				callbacks.onProgress?.("Waiting for authorization");
				const manualCode = (await callbacks.onManualCodeInput?.()) ?? "";
				return { access: OAUTH_ACCESS, refresh: manualCode, expires: NOW };
			},
		};
		registerOAuthProvider(provider);
		fake.nextCredentialUploadError = new Error("indeterminate upload");
		const component = new AuthGatewayConsole({
			connection,
			profileStore: store,
			createClient: () => fake as unknown as AuthGatewayAdminClient,
			host: { ui: new TUI(new VirtualTerminal(120, 32)), openInBrowser: url => opened.push(url), close: () => {} },
		});
		await component.ready;
		component.handleInput("4");
		await flushAsync();
		component.handleInput("l");
		typeAndSubmit(component, "task6-oauth");
		await flushAsync();
		expect(opened).toEqual(["https://auth.example.com/full"]);
		expect(plain(component, 120)).toContain("Enter the displayed code");
		expect(plain(component, 120)).toContain("Waiting for authorization");
		typeAndSubmit(component, "manual-code");
		await flushAsync();
		expect(fake.uploadCredentialCalls).toHaveLength(1);
		expect(plain(component, 120)).toContain("Credential upload failed; run account login again");
		expect(JSON.stringify(component.controller.state)).not.toContain(OAUTH_ACCESS);
		expect(plain(component, 120)).not.toContain(OAUTH_ACCESS);
		component.dispose?.();
	});

	it("masks provider login prompts that collect API keys while still submitting the secret once", async () => {
		const provider: OAuthProviderInterface = {
			id: "task6-api-prompt",
			name: "Task 6 API Prompt",
			sourceId: OAUTH_SOURCE_ID,
			async login(callbacks) {
				return (
					(await callbacks.onPrompt?.({
						message: "Paste provider API key:",
						placeholder: "sk-...",
					})) ?? ""
				);
			},
		};
		registerOAuthProvider(provider);
		const component = new AuthGatewayConsole({
			connection,
			profileStore: store,
			createClient: () => fake as unknown as AuthGatewayAdminClient,
			host: { ui: new TUI(new VirtualTerminal(120, 32)), openInBrowser: () => {}, close: () => {} },
		});
		await component.ready;
		component.handleInput("4");
		await flushAsync();
		component.handleInput("l");
		typeAndSubmit(component, "task6-api-prompt");
		await flushAsync();
		expect(plain(component, 120)).toContain("Paste provider API key");
		for (const char of API_KEY) component.handleInput(char);
		const renderedDuringPrompt = plain(component, 120);
		expect(renderedDuringPrompt).not.toContain(API_KEY);
		expect(renderedDuringPrompt).toContain("••••");
		component.handleInput("\n");
		await flushAsync();
		expect(fake.uploadCredentialCalls).toEqual([
			{ provider: "task6-api-prompt", credential: { type: "api_key", key: API_KEY } },
		]);
		expect(plain(component, 120)).not.toContain(API_KEY);
		expect(JSON.stringify(component.controller.state)).not.toContain(API_KEY);
		component.dispose?.();
	});

	it("sanitizes the generic masked API-key prompt before upload", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("4");
		await flushAsync();
		component.handleInput("k");
		typeAndSubmit(component, "openai");
		expect(plain(component, 120)).toContain("API key:");

		component.handleInput("discard");
		component.handleInput("\x15");
		component.handleInput("sk-live");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[1;5C");
		component.handleInput("\t");
		component.handleInput("\x01");
		component.handleInput("\x1b[200~-ok\x1b[201~");
		const renderedDuringPrompt = plain(component, 120);
		expect(renderedDuringPrompt).toContain("••••");
		expect(renderedDuringPrompt).not.toContain("sk-live-ok");
		component.handleInput("\n");
		await flushAsync();

		expect(fake.uploadCredentialCalls).toEqual([
			{ provider: "openai", credential: { type: "api_key", key: "sk-live-ok" } },
		]);
		expect(plain(component, 120)).not.toContain("sk-live-ok");
		component.dispose?.();
	});

	it("cancels generic prompts with Esc or Ctrl-C without submitting prompt bytes", async () => {
		const component = makeConsole();
		await component.ready;
		component.handleInput("4");
		await flushAsync();

		component.handleInput("k");
		typeAndSubmit(component, "openai");
		component.handleInput("sk-cancelled");
		component.handleInput("\x1b");
		await flushAsync();
		expect(component.controller.state.modalOpen).toBe(false);
		expect(fake.uploadCredentialCalls).toEqual([]);
		expect(plain(component, 120)).not.toContain("sk-cancelled");

		component.handleInput("k");
		component.handleInput("cancel-provider");
		component.handleInput("\x03");
		await flushAsync();
		expect(component.controller.state.modalOpen).toBe(false);
		expect(plain(component, 120)).not.toContain("cancel-provider");
		component.dispose?.();
	});

	it("ignores account-login continuations after disposal without rendering or uploading late secrets", async () => {
		const resumeLogin = deferred<string>();
		const provider: OAuthProviderInterface = {
			id: "task6-dispose-login",
			name: "Task 6 Dispose Login",
			sourceId: OAUTH_SOURCE_ID,
			async login(callbacks) {
				callbacks.onProgress?.("Waiting before dispose");
				const value = await resumeLogin.promise;
				callbacks.onProgress?.("Late progress after dispose");
				return value;
			},
		};
		registerOAuthProvider(provider);
		const tui = new TUI(new VirtualTerminal(120, 32));
		let renderCount = 0;
		vi.spyOn(tui, "requestRender").mockImplementation(() => {
			renderCount++;
		});
		const component = new AuthGatewayConsole({
			connection,
			profileStore: store,
			createClient: () => fake as unknown as AuthGatewayAdminClient,
			host: { ui: tui, openInBrowser: () => {}, close: () => {} },
		});
		await component.ready;
		component.handleInput("4");
		await flushAsync();
		component.handleInput("l");
		typeAndSubmit(component, "task6-dispose-login");
		await flushAsync();
		expect(plain(component, 120)).toContain("Waiting before dispose");
		component.dispose?.();
		const rendersAfterDispose = renderCount;
		resumeLogin.resolve(API_KEY);
		await flushAsync();
		await flushAsync();
		expect(fake.uploadCredentialCalls).toEqual([]);
		expect(component.controller.state.modalOpen).toBe(false);
		expect(component.controller.state.errorBanner).toBeNull();
		expect(JSON.stringify(component.controller.state)).not.toContain(API_KEY);
		expect(plain(component, 120)).not.toContain(API_KEY);
		expect(renderCount).toBe(rendersAfterDispose);
	});

	it("runs broker-backed account login through the console and serves the uploaded credential to a managed user", async () => {
		const sourceId = "task-8-auth-gateway-tui-e2e";
		const brokerToken = "task-8-broker-token";
		const bootstrapToken = "task-8-bootstrap-token";
		const accessSecret = "task-8-oauth-access-never-render";
		const refreshSecret = "task-8-oauth-refresh-never-render";
		let brokerStore: SqliteAuthCredentialStore | null = null;
		const providerId = "task8-provider";
		let brokerStorage: AuthStorage | null = null;
		let remoteStore: RemoteAuthCredentialStore | null = null;
		let gatewayStorage: AuthStorage | null = null;
		let accessStore: SqliteAuthGatewayAccessStore | null = null;
		let brokerHandle: { url: string; close(): Promise<void> } | null = null;
		let gatewayHandle: { url: string; close(): Promise<void> } | null = null;
		let component: AuthGatewayConsole | null = null;
		try {
			const e2eRoot = path.join(root, "task-8-e2e");
			await fs.mkdir(e2eRoot, { recursive: true });
			brokerStore = await SqliteAuthCredentialStore.open(path.join(e2eRoot, "broker.db"));
			brokerStorage = new AuthStorage(brokerStore);
			await brokerStorage.reload();
			brokerHandle = startAuthBroker({
				storage: brokerStorage,
				bind: "127.0.0.1:0",
				bearerTokens: [brokerToken],
				disableRefresher: true,
			});
			const brokerClient = new AuthBrokerClient({ url: brokerHandle.url, token: brokerToken });
			const snapshot = await brokerClient.fetchSnapshot();
			if (snapshot.status !== 200) throw new Error("expected broker snapshot");
			remoteStore = new RemoteAuthCredentialStore({
				client: brokerClient,
				initialSnapshot: snapshot.snapshot,
				streamSnapshots: false,
			});
			gatewayStorage = new AuthStorage(remoteStore);
			await gatewayStorage.reload();
			accessStore = await SqliteAuthGatewayAccessStore.open(path.join(e2eRoot, "access.db"));
			const servedKeys: string[] = [];
			const model = createMockModel({
				provider: providerId,
				id: "model-a",
				handler: (_ctx, opts) => {
					const apiKey = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
					servedKeys.push(apiKey);
					return { content: [`used:${apiKey}`] };
				},
			});
			registerMockApi(sourceId);
			registerOAuthProvider({
				id: providerId,
				name: "Task 8 Mock OAuth",
				sourceId,
				async login(callbacks) {
					callbacks.onProgress?.("Task 8 provider returned credential");
					return {
						access: accessSecret,
						refresh: refreshSecret,
						expires: NOW + 60_000,
						email: "task8@example.com",
						accountId: "acct-task8",
					};
				},
				async refreshToken(credentials) {
					return credentials;
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			});
			const admin = accessStore.createUser({ name: "task8-admin", role: "admin" });
			gatewayHandle = startAuthGateway({
				bind: "127.0.0.1:0",
				bearerTokens: [bootstrapToken],
				accessStore,
				storage: gatewayStorage,
				resolveModel: id => (id === "model-a" ? model.model : undefined),
				listModels: () => [model.model],
				version: "task8-e2e",
			});
			await store.upsert(
				{ name: "local", url: gatewayHandle.url, tokenSource: { type: "file" } },
				admin.token.value,
			);
			const resolved = await store.resolve("local");
			const client = new AuthGatewayAdminClient({ url: resolved.profile.url, token: resolved.token });
			component = new AuthGatewayConsole({
				connection: resolved,
				profileStore: store,
				createClient: () => client,
				host: { ui: new TUI(new VirtualTerminal(120, 32)), openInBrowser: () => {}, close: () => {} },
			});
			await component.ready;
			component.handleInput("4");
			await waitUntil(() => component?.controller.state.accounts.status === "ready", "accounts did not load");
			component.handleInput("l");
			typeAndSubmit(component, providerId);
			await waitUntil(
				() => component?.controller.state.accounts.data.some(account => account.provider === providerId) ?? false,
				() =>
					`uploaded account did not appear: banner=${component?.controller.state.errorBanner ?? "none"} accounts=${component?.controller.state.accounts.error ?? "none"} status=${component?.controller.state.accounts.status ?? "missing"} rows=${component?.controller.state.accounts.data.length ?? -1} brokerRows=${brokerStore?.listAuthCredentials(providerId).length ?? -1} active=${component?.controller.state.activeTab ?? "missing"} modal=${component?.controller.state.modalOpen ? "open" : "closed"} render=${component ? plain(component, 80).slice(0, 500) : "missing"}`,
			);
			const accountsRender = plain(component, 120);
			expect(accountsRender).toContain("task8@example.com");
			expect(accountsRender).not.toContain(accessSecret);
			expect(accountsRender).not.toContain(refreshSecret);
			const account = component.controller.state.accounts.data.find(candidate => candidate.provider === providerId);
			if (!account) throw new Error("expected uploaded account");
			await component.controller.switchTab("pools");
			expect(await component.controller.createPool({ name: "task8-pool", strategy: "round-robin" })).toBe(true);
			component.controller.setFilter("task8-pool");
			const pool = component.controller.selectedPool();
			if (!pool) throw new Error("expected created pool");
			expect(await component.controller.addSelectedPoolCredential(account.id)).toBe(true);
			await component.controller.switchTab("users");
			expect(await component.controller.createUser({ name: "task8-user", role: "user" })).toBe(true);
			const managedToken = component.controller.state.oneTimeToken?.value;
			if (!managedToken) throw new Error("expected managed user token");
			component.controller.closeOneTimeToken();
			await waitUntil(
				() => component?.controller.state.users.data.some(item => item.name === "task8-user") ?? false,
				"created managed user was not refetched",
			);
			component.controller.setFilter("task8-user");
			expect(
				await component.controller.addSelectedUserAcl({ effect: "allow", kind: "route", pattern: "chat" }),
			).toBe(true);
			component.controller.setFilter("task8-user");
			expect(
				await component.controller.addSelectedUserAcl({ effect: "allow", kind: "provider", pattern: providerId }),
			).toBe(true);
			component.controller.setFilter("task8-user");
			expect(
				await component.controller.addSelectedUserAcl({
					effect: "allow",
					kind: "model",
					pattern: `${providerId}/model-a`,
				}),
			).toBe(true);
			component.controller.setFilter("task8-user");
			expect(await component.controller.bindSelectedUserPool(pool.id)).toBe(true);
			const response = await fetch(`${gatewayHandle.url}/v1/chat/completions`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${managedToken}`,
				},
				body: JSON.stringify({ model: "model-a", messages: [{ role: "user", content: "hello" }] }),
			});
			expect(response.status).toBe(200);
			expect(await chatContent(response)).toBe(`used:${accessSecret}`);
			expect(servedKeys).toEqual([accessSecret]);
			const profileMetadata = await fs.readFile(path.join(root, "auth-gateways.json"), "utf8");
			const statusResponse = JSON.stringify(await client.status());
			const credentialsResponse = JSON.stringify(await client.listCredentials());
			const renderedState = `${plain(component, 120)}\n${JSON.stringify(component.controller.state.accounts.data)}`;
			for (const secret of [admin.token.value, accessSecret, refreshSecret]) {
				expect(profileMetadata).not.toContain(secret);
				expect(statusResponse).not.toContain(secret);
				expect(credentialsResponse).not.toContain(secret);
				expect(renderedState).not.toContain(secret);
			}
		} finally {
			component?.dispose();
			await gatewayHandle?.close();
			gatewayStorage?.close();
			remoteStore?.close();
			await brokerHandle?.close();
			brokerStorage?.close();
			brokerStore?.close();
			accessStore?.close();
			unregisterOAuthProviders(sourceId);
			unregisterCustomApis(sourceId);
			vi.useRealTimers();
			vi.restoreAllMocks();
		}
	});

	it("uses a fullscreen VirtualTerminal overlay lifecycle", async () => {
		const term = new VirtualTerminal(100, 20);
		const tui = new TUI(term);
		const component = new AuthGatewayConsole({
			connection,
			profileStore: store,
			createClient: () => fake as unknown as AuthGatewayAdminClient,
			host: { ui: tui, openInBrowser: () => {}, close: () => {} },
		});
		tui.start();
		const handle = tui.showOverlay(component, { fullscreen: true });
		await component.ready;
		await term.waitForRender();
		expect(term.getScrollBuffer().join("\n")).toContain("Auth Gateway Console");
		handle.hide();
		tui.requestRender();
		await term.waitForRender();
		tui.stop();
		component.dispose?.();
	});
});

describe("auth-gateway dialogs and account login", () => {
	it("one-time token dialogs clear raw values after close", async () => {
		const dialog = createOneTimeTokenDialog({ id: 1, value: SECRET_TOKEN, label: null });
		expect(dialog.value).toBe(SECRET_TOKEN);
		closeOneTimeTokenDialog(dialog);
		expect(dialog.value).toBe("");
		expect(JSON.stringify(dialog)).not.toContain(SECRET_TOKEN);
	});

	it("one-time token copy resets copied state before a failed retry", async () => {
		const dialog = createOneTimeTokenDialog({ id: 1, value: SECRET_TOKEN, label: null });
		const copySpy = vi
			.spyOn(clipboard, "copyToClipboard")
			.mockResolvedValueOnce()
			.mockRejectedValueOnce(new Error("clipboard unavailable"));

		await copyOneTimeTokenDialogValue(dialog);
		expect(dialog.copied).toBe(true);

		const failedCopy = copyOneTimeTokenDialogValue(dialog);
		expect(dialog.copied).toBe(false);
		await expect(failedCopy).rejects.toThrow("clipboard unavailable");
		expect(dialog.copied).toBe(false);
		expect(copySpy).toHaveBeenCalledTimes(2);
	});

	it("uploads acquired credentials exactly once and clears local references in finally", async () => {
		const uploaded = await uploadAcquiredAuthGatewayCredential({
			provider: "openai",
			client: fake as unknown as AuthGatewayAdminClient,
			acquire: async () => ({ provider: "openai", credential: { type: "api_key", key: API_KEY } }),
		});
		expect(uploaded.ok).toBe(true);
		expect(fake.uploadCredentialCalls).toHaveLength(1);
		expect(fake.uploadCredentialCalls[0]?.credential).toEqual({ type: "api_key", key: API_KEY });
		expect(JSON.stringify(uploaded)).not.toContain(API_KEY);

		const failed = await uploadAcquiredAuthGatewayCredential({
			provider: "openai",
			client: fake as unknown as AuthGatewayAdminClient,
			acquire: async () => ({
				provider: "openai",
				credential: { type: "oauth", access: OAUTH_ACCESS, refresh: "refresh", expires: NOW },
			}),
			upload: async () => {
				throw new Error("network unsure");
			},
		});
		expect(failed.ok).toBe(false);
		expect(failed.message).toBe("Credential upload failed; run account login again");
		expect(JSON.stringify(failed)).not.toContain(OAUTH_ACCESS);
	});

	it("account-login manual-code prompts ignore control/navigation input and submit only printable text", async () => {
		const controller = new AuthGatewayAccountLoginController({
			openInBrowser: () => {},
			requestRender: () => {},
		});
		const submitted = controller.oauthController.onManualCodeInput?.();
		expect(controller.state.prompt?.masked).toBe(false);

		controller.handleInput("code");
		controller.handleInput("\x1b[B");
		controller.handleInput("\x1bOP");
		controller.handleInput("\t");
		controller.handleInput("\x01");
		controller.handleInput("\x1b[200~-ok\x1b[201~");
		expect(controller.state.prompt?.value).toBe("code-ok");

		controller.handleInput("\n");
		expect(await submitted).toBe("code-ok");
	});

	it("account-login masked API-key prompts ignore controls and Ctrl-C cancels without corrupting credentials", async () => {
		const controller = new AuthGatewayAccountLoginController({
			openInBrowser: () => {},
			requestRender: () => {},
		});
		const submitted = controller.oauthController.onPrompt?.({ message: "Paste provider API key:" });
		controller.oauthController.onAuth?.({
			url: "https://auth.example/start",
			launchUrl: "https://auth.example/launch",
			instructions: "Enter code ABCD",
		});
		controller.oauthController.onProgress?.("Waiting for browser authentication...");
		expect(controller.state.prompt?.masked).toBe(true);

		controller.handleInput("sk-live");
		controller.handleInput("\x1b[1;5C");
		controller.handleInput("\t");
		controller.handleInput("\x7f");
		controller.handleInput("x");
		expect(controller.state.prompt?.value).toBe("sk-livx");

		controller.handleInput("\x03");
		expect(controller.state).toEqual({
			authUrl: null,
			launchUrl: null,
			instructions: null,
			progress: [],
			prompt: null,
		});
		expect(controller.oauthController.signal?.aborted).toBe(true);
		controller.handleInput("\n");
		expect(await submitted).toBe("");
	});
});
