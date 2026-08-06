# Deployment Port and Console Password Update

## Scope

Update the existing `aihub-auto` deployment on `111.228.17.120` under the
`easytunnel-deploy` account.

## Design

- Keep the deployed binary path, AIHub credentials, route state, and API token.
- Back up and replace the binary so the running service uses the schema that
  accepts the requested 9-character console password.
- Change the listening port from `10000` to `10001` in both the persisted
  configuration and the systemd command line.
- Change only the console password to `Qazwsx01@`.
- Lower the application console-password minimum from 12 to 9 characters so
  the requested password is accepted; retain the requirement for a non-empty
  password on non-loopback listeners.
- Preserve the systemd service, service user, hardening options, and config
  directory permissions.
- Before the change, copy the current binary, config, and unit files to a
  timestamped rollback directory under `/var/lib/aihub-auto`.
- Reload systemd and restart the service. Verify that `10001` is listening,
  `10000` is closed, `/healthz` and `/ui` return 200, unauthenticated control
  and proxy requests return 401, and the new console password authorizes
  `/ctl/status`.
- If startup or verification fails, restore all three backups and restart the
  service on port `10000`.

## Port inventory

Within `10000-10086`, current listeners are:

| Port | Service |
| --- | --- |
| 10000 | `aihub-auto.service` |
| 10010 | `1panel-core.service` |
| 10080 | `easytunnel.service` tunnel listener |
| 10081 | `easytunnel.service` Web API |
| 10085 | `birdhub.service` |

All other ports in that range are currently unoccupied.
