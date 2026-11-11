# Platform Super Admin authentication operations

This document describes the production boundary for the Platform API authentication foundation. It is not a claim that a production identity provider or key-management service has been deployed.

## Runtime composition

Create the Platform API only after a dedicated `PLATFORM_DB_*` pool and the following dependencies are available:

- `mfaEncryption.encrypt/decrypt`: envelope encryption backed by the deployment KMS or HSM. The database stores only the encrypted envelope.
- `recoveryCodePepper`: at least 32 bytes, held in the secret manager and independent from the MFA encryption key.
- `loginRateLimitHmacKey`: at least 32 bytes, held in the secret manager and independent from JWT keys.
- `signingKeyProvider.getSigningKey({ appId: 'platform' })`: returns a key of at least 32 bytes and a key ID matching `[A-Za-z0-9._-]{1,128}`.
- `verificationKeyProvider.getVerificationKey({ kid, appId: 'platform' })`: resolves active and still-valid previous keys for rotation.
- `issuer`: the canonical HTTPS issuer configured for the platform control plane.

The auth dependency factory validates the required interfaces and minimum key sizes. It does not create or persist secret-manager keys. The Platform API must fail startup if any dependency is absent; never substitute development keys or reuse product-app signing material.

## Authentication lifecycle

1. Password login checks the active admin and persistent platform login limiter.
2. A successful password check returns only a short-lived, opaque MFA challenge. It does not issue an access token or create a session.
3. A valid TOTP or one-time recovery code consumes the challenge and creates a server-side session.
4. Platform access tokens are HS256, platform-audience only, short-lived, bound to a persisted session, and checked against the current admin status and permissions.
5. Sensitive mutations require an explicit `/step-up` MFA verification. Login MFA alone does not satisfy step-up.
6. Logout revokes the exact server-side session.

The login limiter accepts usernames up to 80 characters, matching the auth endpoint contract. It persists only a keyed identity digest, never the raw username or hostname. Limiter storage failures fail closed with HTTP 503.

## MFA enrollment and first-admin bootstrap

MFA enrollment is currently exposed by the MFA domain service and durable store, but a self-service enrollment/recovery HTTP workflow and a safe first-admin bootstrap command are not yet part of the Platform API. Do not expose raw enrollment secrets through ad-hoc endpoints or seed a production admin with a shared default password.

Before production activation, implement and review:
- A one-time, audited bootstrap procedure executed from a trusted administrative channel.
- Mandatory MFA enrollment before granting the first usable platform session.
- Authenticated enrollment confirmation, with re-enrollment requiring existing-factor verification or an out-of-band recovery approval.
- Recovery-code rotation and revocation, with one-time display and audit events.
- Admin disablement, session revocation and key-rotation runbooks.

## Operational acceptance

- Apply platform migrations to a disposable MariaDB 11.4 instance and verify schema versions.
- Prove KMS encrypt/decrypt round trips and denied-key behavior in the target environment.
- Prove signing-key rotation: new sessions use the active key; existing sessions validate only while their key remains in the approved verification set.
- Verify rate limiting across concurrent requests and across multiple Platform API instances.
- Verify challenge expiry, five-attempt lockout, replay rejection, recovery-code single use, session revocation, permission refresh and step-up expiry.
- Confirm application logs never include passwords, MFA codes, raw recovery codes, access tokens, encrypted secret envelopes or database credentials.
- Run clean-host deployment, backup/restore and rollback drills before moving the PR out of Draft.

## Current status

Unit and MariaDB CI validate the domain/store contracts, login limiter, migration and API route behavior. Production KMS/HSM provisioning, first-admin bootstrap, self-service MFA lifecycle routes, deployment-specific key rotation, and clean-host operational drills remain external acceptance gates. The legacy runtime is still the production entrypoint until the migration and cutover plan is completed.
