import type { AuthCredential, ResetCreditRedeemOutcome } from "../auth-storage";
import type { Api } from "../types";
import type { UsageReport } from "../usage";
import type {
	AuthGatewayAclBatchResult,
	AuthGatewayAclRule,
	AuthGatewayAclRuleInput,
	AuthGatewayAuditEvent,
	AuthGatewayPool,
	AuthGatewayPoolStrategy,
	AuthGatewayPrincipal,
	AuthGatewayRole,
	AuthGatewayToken,
	AuthGatewayUsageSummary,
	AuthGatewayUser,
	AuthGatewayUserPoolBinding,
} from "./access-control";

export interface AuthGatewayAdminStatus {
	ok: true;
	version: string;
	serverTime: number;
	principal: Pick<AuthGatewayPrincipal, "kind" | "userId" | "name" | "role" | "tokenId">;
	counts: {
		users: number;
		activeTokens: number;
		pools: number;
		credentials: number;
	};
}

export interface AuthGatewayCredentialSummary {
	id: number;
	provider: string;
	type: "oauth" | "api_key";
	identityKey: string | null;
	email: string | null;
	accountId: string | null;
	projectId: string | null;
	enterpriseUrl: string | null;
	apiEndpoint: string | null;
	expiresAt: number | null;
}

export interface AuthGatewayAuditPage {
	events: AuthGatewayAuditEvent[];
	nextBefore: number | null;
}

export interface AuthGatewayIssuedTokenValue {
	id: number;
	value: string;
	label: string | null;
}

export interface AuthGatewayUserDetails {
	user: AuthGatewayUser;
	tokens: AuthGatewayToken[];
	acl: AuthGatewayAclRule[];
	poolBindings: AuthGatewayUserPoolBinding[];
}

export interface CreateUserInput {
	name: string;
	description?: string;
	owner?: string;
	role?: AuthGatewayRole;
}

export interface UpdateUserInput {
	description?: string | null;
	owner?: string | null;
	role?: AuthGatewayRole;
	enabled?: boolean;
}

export type AddAclRuleInput = AuthGatewayAclRuleInput;

export interface AddAclRulesInput {
	rules: AddAclRuleInput[];
}

export interface CreatePoolInput {
	name: string;
	strategy?: AuthGatewayPoolStrategy;
}

export interface UpdatePoolInput {
	name?: string;
	strategy?: AuthGatewayPoolStrategy;
}

export interface SetPoolCredentialOrderInput {
	credentialIds: number[];
}

export interface SetUserPoolOrderInput {
	poolIds: number[];
}

export interface AuthGatewayModelSummary {
	id: string;
	provider: string;
	api: Api;
}

export interface AuthGatewayAdminStatusResponse {
	status: AuthGatewayAdminStatus;
}

export interface AuthGatewayUsersResponse {
	users: AuthGatewayUser[];
}

export interface AuthGatewayUserResponse {
	user: AuthGatewayUser;
}

export interface AuthGatewayUserDetailsResponse extends AuthGatewayUserDetails {}

export interface AuthGatewayTokenResponse {
	token: AuthGatewayIssuedTokenValue;
}

export interface AuthGatewayAclResponse {
	acl: AuthGatewayAclRule[];
}

export interface AuthGatewayAclRuleResponse {
	rule: AuthGatewayAclRule;
}

export interface AuthGatewayUserPoolsResponse {
	bindings: AuthGatewayUserPoolBinding[];
}

export interface AuthGatewayPoolBindResponse {
	binding: AuthGatewayUserPoolBinding;
	created: boolean;
}

export interface AuthGatewayAclBatchResponse {
	results: AuthGatewayAclBatchResult[];
}

export interface AuthGatewayUsageResponse {
	usage: AuthGatewayUsageSummary;
}

export interface AuthGatewaySelfUsageResponse extends AuthGatewayUsageResponse {
	principal: Pick<AuthGatewayPrincipal, "kind" | "userId" | "name" | "role" | "tokenId">;
}

export interface AuthGatewayUsageReportsResponse {
	generatedAt: number;
	reports: UsageReport[];
	principal?: Pick<AuthGatewayPrincipal, "kind" | "userId" | "name" | "role" | "tokenId">;
}

export interface AuthGatewayPoolsResponse {
	pools: AuthGatewayPool[];
}

export interface AuthGatewayPoolResponse {
	pool: AuthGatewayPool;
}

export interface AuthGatewayPoolUsersResponse {
	users: AuthGatewayUser[];
}

export interface AuthGatewayCredentialsResponse {
	credentials: AuthGatewayCredentialSummary[];
}

export interface AuthGatewayCredentialResponse {
	credential: AuthGatewayCredentialSummary;
}

export interface AuthGatewayCredentialResetResponse {
	outcome: ResetCreditRedeemOutcome;
}

export interface AuthGatewayCredentialUploadRequest {
	provider: string;
	credential: AuthCredential;
}

export interface AuthGatewayCredentialInUseDetails {
	credentialId: number;
	pools: Array<{ id: number; name: string }>;
}

export interface AuthGatewayManagementErrorResponse {
	error: {
		code: string;
		message: string;
		details?: AuthGatewayCredentialInUseDetails;
	};
}
