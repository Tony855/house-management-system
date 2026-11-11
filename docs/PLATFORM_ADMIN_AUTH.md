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
6. Enrollment and recovery-code rotation require a recent MFA-verified session; plaintext recovery codes are returned once and never stored.

## Persistent security audit

Migration `011_platform_admin_audit.sql` creates the platform-only security event ledger. The API records login, MFA challenge verification, enrollment, recovery-code rotation, step-up and logout outcomes. The event schema intentionally excludes usernames, IP addresses, passwords, MFA codes, raw recovery codes, bearer tokens and encrypted secret envelopes. Event action/outcome/code fields are allowlisted and all values are SQL-bound parameters.

Audit writes on successful security lifecycle operations happen before returning success. If persistence is unavailable, the operation fails closed rather than silently reporting an unaudited success. Failure events are best-effort so an audit outage does not replace the original authentication error.

## First-admin bootstrap and remaining production controls

A safe one-time first-admin bootstrap command is not yet implemented. Do not seed production with a shared/default password or expose an unauthenticated bootstrap HTTP endpoint. The bootstrap must run only from a trusted host/operator channel, be one-time and concurrency-safe, require explicit credential input, force MFA enrollment, and never print secrets into logs or shell history.

Still required before production activation:
- First-admin bootstrap and forced initial MFA enrollment.
- Admin disablement, global session revocation and audited recovery procedures.
- Production KMS/HSM provisioning, key rotation and denied-key drills.
- Real Secret Manager and least-privilege tenant DB provisioning adapters.
- Rental/Hotel/Property historical data migration and isolation verification.
- Backup/restore, rollback, load and clean-host deployment drills.

## Operational acceptance

Run platform migrations against disposable MariaDB, verify schema versioning, KMS round trips, key rotation, concurrent rate limiting, challenge expiry/replay/lockout, recovery-code single use, session revocation, permission refresh and step-up expiry. Confirm logs contain no authentication secrets. Keep PR in Draft until all production acceptance gates and review are complete.

The legacy runtime remains the production entrypoint until the migration and cutover plan is completed.
