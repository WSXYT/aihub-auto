# Deployment Port and Console Password Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the live `aihub-auto` service from port `10000` to `10001` and set the console password to `Qazwsx01@` without losing credentials or route state.

**Architecture:** Back up the live binary, JSON configuration, and systemd unit on the server, deploy the binary that accepts the requested password, update both port sources atomically, restart the existing hardened service, and validate local plus public HTTP behavior. On failure, restore all three backups and restart on the original port.

**Tech Stack:** Linux systemd, Bun compiled binary, SSH, PowerShell, curl, `ss`.

## Global Constraints

- Keep the `/opt/aihub-auto/aihub-auto` path, AIHub credentials, route state, and API token unchanged; replace only the binary bytes needed for the 9-character password schema.
- Preserve service user `easytunnel-deploy`, hardening options, and file permissions.
- Use port `10001`; current occupied ports in the requested range are `10000`, `10010`, `10080`, `10081`, and `10085`.
- Console password must be exactly `Qazwsx01@`.
- The application schema must accept 9-character console passwords; passwords shorter than 9 remain invalid.

### Task 0: Update Password Validation and Build

**Files:**
- Modify: `apps/router/src/config.ts`
- Test: `apps/router/tests/startup.test.ts`

- [x] Change `ConfigSchema.uiPassword` minimum from 12 to 9 and update the non-loopback validation message.
- [x] Add tests proving `Qazwsx01@` is accepted and an 8-character password is rejected.
- [x] Run `bun run check` and build the Linux x64 baseline executable with the available Bun runtime package.

### Task 1: Back Up Live Deployment Files

**Files:**
- Remote: `/opt/aihub-auto/aihub-auto`
- Remote: `/var/lib/aihub-auto/config.json`
- Remote: `/etc/systemd/system/aihub-auto.service`

- [x] Create rollback directory `/var/lib/aihub-auto/rollback-20260804-125035`, owned by `easytunnel-deploy`, with mode `0700`.
- [x] Copy the current binary, config, and unit into that directory with modes `0755`, `0600`, and `0644` respectively.
- [x] Verify all three backups exist before changing the live files.

### Task 2: Update Port and Console Password

**Files:**
- Replace remote `/opt/aihub-auto/aihub-auto` with the verified Linux x64 baseline build.
- Modify remote `/var/lib/aihub-auto/config.json`.
- Modify remote `/etc/systemd/system/aihub-auto.service`.

- [x] Deploy binary SHA-256 `52b074632beb2b81ccd4a11113d36e85fef531df9c52bb612a519f56561054db` at the existing path with `root:root` ownership and mode `0755`.
- [x] Parse the existing JSON and change only `listen.port` to `10001` and `uiPassword` to `Qazwsx01@`; preserve `proxyToken` and all existing fields.
- [x] Change only the `ExecStart` argument from `--port 10000` to `--port 10001` in the unit.
- [x] Restore ownership and modes: config `easytunnel-deploy:easytunnel-deploy`, `0600`; unit `root:root`, `0644`.

### Task 3: Restart and Verify

**Files:**
- Remote service `aihub-auto.service`.

- [x] Run `systemctl daemon-reload` and restart the service.
- [x] Confirm the service is `active`, port `10001` is listening, and port `10000` is closed.
- [x] From the deployment client, verify `/healthz` and `/ui` return `200`.
- [x] Verify `/ctl/status` without `x-ui-password` returns `401`, with `Qazwsx01@` returns `200`, and `/v1/models` without the preserved API token returns `401`.

### Task 4: Roll Back on Failure

- [x] Confirm the rollback directory contains the prior binary, config, and unit. No rollback was required because all startup and HTTP verification passed.
