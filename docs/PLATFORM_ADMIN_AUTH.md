# Platform Super Admin authentication operations

This document describes the production boundary for the Platform API authentication foundation. It is not a claim that a production identity provider or key-management service has been deployed.

## Runtime composition

Create the Platform API only after a dedicated `PLATFORM_DB_*` pool and the following dependencies are available:

- `mfaEncryption.encrypt/decrypt`: envelope encryption backed by deployment KMS/HSM.
- `recoveryCodePepper` and `loginRateLimitHmacKey`: independent secrets of at least 32 bytes from a secret manager.
- `signingKeyProvider` / `verificationKeyProvider`: platform-only signing and rotation-aware verification keys.
- `issuer`: canonical HTTPS control-plane issuer.

The runtime fails startup if security dependencies are absent. It has no development-key or legacy-database fallback.

## Authentication and MFA

1. Password login returns only a short-lived MFA challenge.
2. Successful TOTP/recovery verification consumes the challenge and creates a persisted server-side session.
3. Platform JWTs are platform-audience-only, short-lived, session-bound and checked against current admin state.
4. Sensitive mutations require fresh step-up MFA.
5. Logout revokes the exact server-side session.
6. Admin disable requires `platform:admins:write` plus fresh step-up MFA, refuses self-disable/last-active-admin disable, and revokes every session for the target in one transaction.
7. Admin MFA reset requires `platform:admins:write`, fresh step-up MFA and an 8–500 character operator reason. It disables the target factor, deletes pending enrollment and recovery-code hashes, revokes all target sessions, and writes the audit event in one transaction. **The reset endpoint is not production-ready as a standalone recovery flow:** the target cannot complete normal MFA login after the factor is disabled. A separate trusted-channel, one-time enrollment grant and delivery/identity-proofing process must be implemented before enabling this operation in production.
8. Enrollment and recovery-code rotation require a recent MFA-verified session; plaintext recovery codes are returned once and never stored.

## Persistent security audit

Migration `011_platform_admin_audit.sql` creates the platform-only security event ledger. The API records login, MFA challenge verification, enrollment, recovery-code rotation, administrator MFA reset, step-up and logout outcomes. The event schema intentionally excludes usernames, IP addresses, passwords, MFA codes, raw recovery codes, bearer tokens and encrypted secret envelopes. Event action/outcome/code fields are allowlisted and all values are SQL-bound parameters.

Audit writes on successful security lifecycle operations happen before returning success. If persistence is unavailable, the operation fails closed rather than silently reporting an unaudited success. Failure events are best-effort so an audit outage does not replace the original authentication error.

## First-admin bootstrap and remaining production controls

The one-time first-admin bootstrap is provided by `npm run bootstrap:platform-admin`. It requires an interactive TTY, an absolute `PLATFORM_SECURITY_PROVIDER_MODULE` path exporting `createBootstrapDependencies({env})`, and a dedicated `PLATFORM_DB_*` connection. The provider must return KMS-backed `mfaEncryption` and a 32-byte-or-longer `recoveryCodePepper`. The CLI reads the password without echo, requires 16+ characters, obtains a database advisory lock, refuses to run if any platform admin exists, and atomically inserts the first admin, an already-enabled KMS-encrypted TOTP factor, ten single-use recovery-code hashes, and the bootstrap audit event. The TOTP secret and recovery codes are shown once after commit; store them in an approved password manager. There is no HTTP bootstrap endpoint, default credential, or password command-line argument. Never run this command with shell tracing or terminal/session recording enabled.

Still required before production activation:
- Admin re-enable is now a two-person workflow: an active administrator with fresh step-up submits a reasoned request, and a different active administrator with fresh step-up approves it. Approval requires the target to retain an enabled MFA factor and atomically restores the account with audit history. Production identity-proofing, emergency break-glass and key-rotation runbooks still require deployment-specific approval.
- Trusted-channel MFA recovery enrollment grant, identity proofing and secure delivery; do not use the current MFA reset endpoint operationally until this is implemented.
- Production KMS/HSM provisioning, key rotation and denied-key drills.
- Real Secret Manager and least-privilege tenant DB provisioning adapters. The new adapter composition provides a MariaDB database/user adapter with grants scoped to that tenant database, a Secret Manager write/delete wrapper, migration/verifier wrappers, and platform-registry lifecycle persistence; production must inject actual Secret Manager, migration executor and isolation-verifier implementations.
- Rental/Hotel/Property historical data migration and isolation verification.
- Backup/restore, rollback, load and clean-host deployment drills.

## Operational acceptance

Run platform migrations against disposable MariaDB, verify schema versioning, KMS round trips, key rotation, concurrent rate limiting, challenge expiry/replay/lockout, recovery-code single use, session revocation, permission refresh and step-up expiry. Confirm logs contain no authentication secrets. Keep PR in Draft until all production acceptance gates and review are complete.

The legacy runtime remains the production entrypoint until the migration and cutover plan is completed.


MFA reset HTTP route is fail-closed and returns `503 PLATFORM_MFA_RECOVERY_UNAVAILABLE` until trusted-channel identity verification, a short-lived single-use enrollment grant, and secure delivery are integrated into the production runtime. The underlying transactional reset store method is not exposed by the HTTP route.
