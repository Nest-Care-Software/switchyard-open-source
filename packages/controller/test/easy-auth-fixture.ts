export const DOCUMENTED_EASY_AUTH_SECURITY_CLAIM_TYPES = Object.freeze({
  apiAudience: "aud",
  clientApplicationIdV1: "appid",
  clientApplicationIdV2: "azp",
  identityType: "idtyp",
  roles: "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
  scopes: "http://schemas.microsoft.com/identity/claims/scope",
  tenantId: "http://schemas.microsoft.com/identity/claims/tenantid",
  tokenVersion: "ver",
});

export const DOCUMENTED_EASY_AUTH_ANCILLARY_CLAIM_TYPES = Object.freeze({
  authenticationInfo: "aio",
  clientAuthenticationMethod: "azpacr",
  expiresAt: "exp",
  issuedAt: "iat",
  issuer: "iss",
  notBefore: "nbf",
  objectId: "http://schemas.microsoft.com/identity/claims/objectidentifier",
  refreshTokenHash: "rh",
  subject: "sub",
  tokenIdentifier: "uti",
});

/**
 * Synthetic redacted Easy Auth principal matching Microsoft's documented Entra v2
 * app-only token claims and default mapped tenant, object and role URI shapes. It is
 * not a live mapped-claim capture. Production still requires a separately reviewed
 * redacted live principal and the exact security and ancillary mappings it contains.
 */
export const REDACTED_EASY_AUTH_APP_PRINCIPAL_CLAIMS = Object.freeze([
  { typ: "aud", val: "api://switchyard-control" },
  {
    typ: "iss",
    val: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0",
  },
  { typ: "iat", val: "1787658900" },
  { typ: "nbf", val: "1787658900" },
  { typ: "exp", val: "1787662800" },
  { typ: "aio", val: "redacted-opaque-authentication-information" },
  { typ: "azp", val: "22222222-2222-2222-2222-222222222222" },
  { typ: "azpacr", val: "2" },
  { typ: "idtyp", val: "app" },
  {
    typ: DOCUMENTED_EASY_AUTH_ANCILLARY_CLAIM_TYPES.objectId,
    val: "33333333-3333-3333-3333-333333333333",
  },
  { typ: "rh", val: "redacted-opaque-revalidation-hash" },
  {
    typ: DOCUMENTED_EASY_AUTH_SECURITY_CLAIM_TYPES.roles,
    val: "Switchyard.Allocate",
  },
  { typ: "sub", val: "redacted-service-principal-subject" },
  {
    typ: DOCUMENTED_EASY_AUTH_SECURITY_CLAIM_TYPES.tenantId,
    val: "11111111-1111-1111-1111-111111111111",
  },
  { typ: "uti", val: "redacted-case-sensitive-token-identifier" },
  { typ: "ver", val: "2.0" },
]);

export const REDACTED_EASY_AUTH_APP_PRINCIPAL = Object.freeze({
  auth_typ: "aad",
  claims: REDACTED_EASY_AUTH_APP_PRINCIPAL_CLAIMS,
  name_typ: "name",
  role_typ: DOCUMENTED_EASY_AUTH_SECURITY_CLAIM_TYPES.roles,
});
