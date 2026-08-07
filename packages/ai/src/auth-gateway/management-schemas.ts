import { type } from "@oh-my-pi/omptype";
import { credentialUploadRequestSchema } from "../auth-broker/wire-schemas";
import { usageReportSchema } from "../usage";

export const authGatewayRoleSchema = type("'user' | 'admin'");
export const authGatewayAclEffectSchema = type("'allow' | 'deny'");
export const authGatewayAclKindSchema = type("'provider' | 'model' | 'route'");
export const authGatewayPoolStrategySchema = type("'sticky-session' | 'least-used' | 'round-robin' | 'failover'");
export const authGatewayPrincipalKindSchema = type("'managed' | 'legacy' | 'no-auth'");
export const authGatewayAuditOutcomeSchema = type(
	"'success' | 'unauthorized' | 'denied_by_acl' | 'invalid_request' | 'unknown_model' | 'no_eligible_credential' | 'usage_limit' | 'upstream_error' | 'request_aborted' | 'not_found' | 'internal_error'",
);
export const authGatewayRouteFamilySchema = type(
	"'chat' | 'messages' | 'responses' | 'pi-native' | 'models' | 'usage' | 'check' | 'management' | 'unknown'",
);

export const authGatewayUserSchema = type({
	"+": "reject",
	id: "number.integer",
	name: "string",
	description: "string | null",
	owner: "string | null",
	role: authGatewayRoleSchema,
	enabled: "boolean",
	createdAt: "number",
	updatedAt: "number",
	lastUsedAt: "number | null",
});

export const authGatewayTokenSchema = type({
	"+": "reject",
	id: "number.integer",
	userId: "number.integer",
	publicId: "string",
	label: "string | null",
	createdAt: "number",
	lastUsedAt: "number | null",
	revokedAt: "number | null",
});

export const authGatewayIssuedTokenValueSchema = type({
	"+": "reject",
	id: "number.integer",
	value: "string",
	label: "string | null",
});

export const authGatewayAclRuleSchema = type({
	"+": "reject",
	id: "number.integer",
	userId: "number.integer",
	effect: authGatewayAclEffectSchema,
	kind: authGatewayAclKindSchema,
	pattern: "string",
	createdAt: "number",
});

export const authGatewayPoolMemberSchema = type({
	"+": "reject",
	credentialId: "number.integer",
	position: "number.integer",
	createdAt: "number",
});

export const authGatewayPoolSchema = type({
	"+": "reject",
	id: "number.integer",
	name: "string",
	strategy: authGatewayPoolStrategySchema,
	createdAt: "number",
	updatedAt: "number",
	members: authGatewayPoolMemberSchema.array(),
});

export const authGatewayUserPoolBindingSchema = type({
	"+": "reject",
	poolId: "number.integer",
	position: "number.integer",
	createdAt: "number",
	pool: authGatewayPoolSchema,
});

export const authGatewayPrincipalSummarySchema = type({
	"+": "reject",
	kind: authGatewayPrincipalKindSchema,
	userId: "number.integer | null",
	name: "string",
	role: authGatewayRoleSchema,
	tokenId: "number.integer | null",
});

export const authGatewayAdminStatusSchema = type({
	"+": "reject",
	ok: "true",
	version: "string",
	serverTime: "number",
	principal: authGatewayPrincipalSummarySchema,
	counts: {
		"+": "reject",
		users: "number.integer",
		activeTokens: "number.integer",
		pools: "number.integer",
		credentials: "number.integer",
	},
});

export const authGatewayCredentialSummarySchema = type({
	"+": "reject",
	id: "number.integer",
	provider: "string",
	type: "'oauth' | 'api_key'",
	identityKey: "string | null",
	email: "string | null",
	accountId: "string | null",
	projectId: "string | null",
	orgId: "string | null",
	orgName: "string | null",
	enterpriseUrl: "string | null",
	apiEndpoint: "string | null",
	expiresAt: "number | null",
});

export const authGatewayAuditEventSchema = type({
	"+": "reject",
	id: "number.integer",
	requestId: "string",
	startedAt: "number",
	completedAt: "number",
	userId: "number.integer | null",
	userName: "string | null",
	tokenId: "number.integer | null",
	method: "string",
	path: "string",
	routeFamily: authGatewayRouteFamilySchema,
	requestedModel: "string | null",
	resolvedProvider: "string | null",
	resolvedModel: "string | null",
	credentialId: "number.integer | null",
	outcome: authGatewayAuditOutcomeSchema,
	statusCode: "number.integer",
	inputTokens: "number",
	outputTokens: "number",
	cacheReadTokens: "number",
	cacheWriteTokens: "number",
	totalTokens: "number",
	costUsd: "number",
	errorCode: "string | null",
});

export const authGatewayAuditPageSchema = type({
	"+": "reject",
	events: authGatewayAuditEventSchema.array(),
	nextBefore: "number.integer | null",
});

export const authGatewayUsageSummarySchema = type({
	"+": "reject",
	userId: "number.integer",
	since: "number",
	generatedAt: "number",
	totals: {
		"+": "reject",
		requests: "number",
		inputTokens: "number",
		outputTokens: "number",
		cacheReadTokens: "number",
		cacheWriteTokens: "number",
		totalTokens: "number",
		costUsd: "number",
	},
	byProviderModel: type({
		"+": "reject",
		provider: "string",
		model: "string",
		requests: "number",
		totalTokens: "number",
		costUsd: "number",
	}).array(),
});

export const createUserInputSchema = type({
	"+": "reject",
	name: "string",
	"description?": "string",
	"owner?": "string",
	"role?": authGatewayRoleSchema,
});

export const updateUserInputSchema = type({
	"+": "reject",
	"description?": "string | null",
	"owner?": "string | null",
	"role?": authGatewayRoleSchema,
	"enabled?": "boolean",
});

export const addAclRuleInputSchema = type({
	"+": "reject",
	effect: authGatewayAclEffectSchema,
	kind: authGatewayAclKindSchema,
	pattern: "string",
});

export const addAclRulesInputSchema = type({
	"+": "reject",
	rules: addAclRuleInputSchema.array(),
});

export const createPoolInputSchema = type({
	"+": "reject",
	name: "string",
	"strategy?": authGatewayPoolStrategySchema,
});

export const updatePoolInputSchema = type({
	"+": "reject",
	"name?": "string",
	"strategy?": authGatewayPoolStrategySchema,
});

export const addPoolCredentialInputSchema = type({
	"+": "reject",
	credentialId: "number.integer",
});

export const setPoolCredentialOrderInputSchema = type({
	"+": "reject",
	credentialIds: "number.integer[]",
});

export const bindUserPoolInputSchema = type({
	"+": "reject",
	poolId: "number.integer",
});

export const setUserPoolOrderInputSchema = type({
	"+": "reject",
	poolIds: "number.integer[]",
});

export const authGatewayAdminStatusResponseSchema = type({
	"+": "reject",
	status: authGatewayAdminStatusSchema,
});

export const authGatewayUsersResponseSchema = type({
	"+": "reject",
	users: authGatewayUserSchema.array(),
});

export const authGatewayUserResponseSchema = type({
	"+": "reject",
	user: authGatewayUserSchema,
});

export const authGatewayUserDetailsResponseSchema = type({
	"+": "reject",
	user: authGatewayUserSchema,
	tokens: authGatewayTokenSchema.array(),
	acl: authGatewayAclRuleSchema.array(),
	poolBindings: authGatewayUserPoolBindingSchema.array(),
});

export const authGatewayTokenResponseSchema = type({
	"+": "reject",
	token: authGatewayIssuedTokenValueSchema,
});

export const authGatewayAclResponseSchema = type({
	"+": "reject",
	acl: authGatewayAclRuleSchema.array(),
});

export const authGatewayAclRuleResponseSchema = type({
	"+": "reject",
	rule: authGatewayAclRuleSchema,
});

export const authGatewayAclBatchResponseSchema = type({
	"+": "reject",
	results: type({
		"+": "reject",
		rule: authGatewayAclRuleSchema,
		created: "boolean",
	}).array(),
});

export const authGatewayUserPoolsResponseSchema = type({
	"+": "reject",
	bindings: authGatewayUserPoolBindingSchema.array(),
});

export const authGatewayPoolBindResponseSchema = type({
	"+": "reject",
	binding: authGatewayUserPoolBindingSchema,
	created: "boolean",
});

export const authGatewayUsageResponseSchema = type({
	"+": "reject",
	usage: authGatewayUsageSummarySchema,
});

export const authGatewaySelfUsageResponseSchema = type({
	"+": "reject",
	usage: authGatewayUsageSummarySchema,
	principal: authGatewayPrincipalSummarySchema,
});

export const authGatewayUsageReportsResponseSchema = type({
	"+": "reject",
	generatedAt: "number",
	"principal?": authGatewayPrincipalSummarySchema,
	reports: usageReportSchema.array(),
});

export const authGatewayPoolsResponseSchema = type({
	"+": "reject",
	pools: authGatewayPoolSchema.array(),
});

export const authGatewayPoolResponseSchema = type({
	"+": "reject",
	pool: authGatewayPoolSchema,
});

export const authGatewayPoolUsersResponseSchema = type({
	"+": "reject",
	users: authGatewayUserSchema.array(),
});

export const authGatewayAuditPageResponseSchema = authGatewayAuditPageSchema;

export const authGatewayCredentialsResponseSchema = type({
	"+": "reject",
	credentials: authGatewayCredentialSummarySchema.array(),
});

export const authGatewayCredentialResponseSchema = type({
	"+": "reject",
	credential: authGatewayCredentialSummarySchema,
});

export const authGatewayCredentialResetResponseSchema = type({
	"+": "reject",
	outcome: {
		"+": "reject",
		ok: "boolean",
		code: type("string").atLeastLength(1),
		"accountId?": "string",
		"email?": "string",
		"creditId?": "string",
	},
});

export const authGatewayCredentialInUseDetailsSchema = type({
	"+": "reject",
	credentialId: "number.integer",
	pools: type({
		"+": "reject",
		id: "number.integer",
		name: "string",
	}).array(),
});

export const authGatewayManagementErrorResponseSchema = type({
	"+": "reject",
	error: {
		"+": "reject",
		code: "string",
		message: "string",
		"details?": authGatewayCredentialInUseDetailsSchema,
	},
});

export { credentialUploadRequestSchema as authGatewayCredentialUploadRequestSchema };
