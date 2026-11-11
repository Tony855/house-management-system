# Production deployment and installer safety

## Important architecture status

The current runtime is still the legacy monolith: one shared `house_sys` identity/configuration database and three shared product databases partitioned by `org_id`. The four-app / database-per-tenant refactor is not yet production-ready. Running this installer does not activate tenant-owned databases or independent frontends/APIs.

## First installation

On a fresh Ubuntu or Debian host, check out the repository and run:

```bash
sudo bash deploy.sh --dry-run
sudo bash deploy.sh
```

Options:

- `--port 16088`: public HTTP listener port.
- `--db-host 127.0.0.1`, `--db-port 3306`: MariaDB endpoint.
- `--non-interactive`: safe defaults without prompt.
- `--skip-firewall`: do not add a UFW rule.
- `--dry-run`: validate the host and print the plan without changing the system.

The script supports Ubuntu and Debian with apt, installs Node.js 20+ and MariaDB, uses `npm ci`, and registers a systemd service under the dedicated unprivileged `house-sys` account.

## Data safety

- The installer checks all four legacy target database names before importing `db/schema.sql`.
- If **any** target database already exists, installation stops before the schema import. This is deliberate because the legacy schema file contains destructive DROP statements.
- There is no `--force` option. Do not bypass this protection to upgrade an existing server.
- Existing deployments require a tested backup, schema migration, and rollback plan. This script is a first-install path, not an in-place migration tool.
- Do not run `db/init.sh` on production: it drops and recreates the legacy databases.

## Credentials and database permissions

- Every installation generates unique random passwords for the super-admin, three product administrators, demo staff identities, and the application DB principal.
- Bootstrap credentials are written to `/root/house-sys-bootstrap-credentials.txt`, owned by root with mode `0600`. Retrieve them through a trusted root session, move them to a password manager, rotate them after first login, then securely delete the file.
- The runtime DB account receives only SELECT/INSERT/UPDATE/DELETE on the four legacy databases. Schema creation and seeding are performed through the local MariaDB root socket during installation.
- The application DB account is not a per-tenant account. The current runtime still shares access across the three product databases; this does not satisfy the final tenant isolation requirement.

## Service operations

```bash
systemctl status house-sys
systemctl restart house-sys
journalctl -u house-sys -f
```

The service runs as `house-sys`, uses a root-owned mode-0600 environment file, and has systemd hardening enabled. Only the uploads directory is writable by the service account.

## Verification

```bash
bash -n deploy.sh
bash scripts/test-deploy.sh
npm ci
npm audit --omit=dev
npm test
```

A successful installer test validates syntax and static safety properties; it is not a substitute for testing installation on clean Ubuntu/Debian VMs and upgrading/restoring a representative MariaDB backup.
