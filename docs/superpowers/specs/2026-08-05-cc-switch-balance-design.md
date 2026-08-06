# CC Switch Balance Endpoint Design

## Goal

Allow a CC Switch Codex provider configured with the Base URL
`http://111.228.17.120:10001/v1` to display the AIHub account balance through
CC Switch's custom usage-query script.

The change must preserve the existing proxy authentication boundary. It must
also make the cause of `401 Unauthorized: 代理口令错误` unambiguous: protected
`/v1/*` requests require the configured router `proxyToken` as the provider API
key.

## Client Contract

Add an exact local route:

```text
GET /v1/usage
Authorization: Bearer <proxyToken>
```

Successful response:

```json
{
  "is_active": true,
  "remaining": 12.34,
  "balance": 12.34,
  "unit": "USD"
}
```

Because the provider Base URL already ends in `/v1`, the CC Switch request URL
must be `{{baseUrl}}/usage`. Using `{{baseUrl}}/v1/usage` would incorrectly
request `/v1/v1/usage` unless a separate root usage Base URL were configured.

## Authentication

`/v1/usage` uses the same client authentication rules as
`/v1/responses` and other proxied `/v1/*` routes:

- when `proxyToken` is configured, accept `Authorization: Bearer <proxyToken>`
  or the existing `x-api-key` equivalent;
- reject a missing or incorrect token with HTTP 401 and the existing
  `代理口令错误` message;
- when proxy authentication is disabled on a loopback-only installation,
  preserve the existing unauthenticated behavior;
- keep the informational `GET /v1` route unauthenticated;
- never accept the token in the URL query string because URLs are commonly
  retained in logs and history.

The CC Switch provider API Key must therefore be the router `proxyToken`, not
an AIHub upstream key. The same value authenticates both Codex traffic and the
balance query, so enabling usage queries does not add another credential.

## Server Behavior

Handle the exact balance route locally before the generic upstream proxy. On
an authorized request, call the existing authenticated AIHub profile API and
normalize its `balance` field with the same helper used by `/ctl/account`.

Error behavior:

- missing or incorrect proxy token: HTTP 401, `代理口令错误`;
- no AIHub access token is available: HTTP 503 with a stable JSON error;
- AIHub rejects its stored access token: HTTP 401 with an account-login error,
  distinct from the proxy-token error;
- upstream profile request fails otherwise: HTTP 502;
- unsupported methods on the exact route: HTTP 405.

All responses use `Cache-Control: no-store` so balance information is not
cached by clients or intermediaries.

## CC Switch Setup

For the Codex provider:

1. Set Base URL to `http://111.228.17.120:10001/v1`.
2. Set API Key to the router `proxyToken`.
3. Open **用量查询**, enable it, and select **自定义模板**.
4. Leave the usage-query API Key and Base URL overrides empty so CC Switch
   reuses the provider credentials, then use this script:

```javascript
({
  request: {
    url: "{{baseUrl}}/usage",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}" }
  },
  extractor: function(response) {
    const remaining = response?.remaining ?? response?.quota?.remaining ?? response?.balance;
    const unit = response?.unit ?? response?.quota?.unit ?? "USD";
    return {
      isValid: response?.is_active ?? response?.isValid ?? true,
      remaining,
      unit
    };
  }
})
```

5. Test the usage query and save it.

CC Switch intentionally does not auto-enable balance queries for arbitrary
third-party providers, so the one-time usage-query toggle is required.

## UI Proxy Token Reveal

The connection-parameters area will continue to hide `proxyToken` by default.
Add a familiar eye icon beside the masked API Key value. Activating it uses the
UI's existing authenticated control request flow, so a user who has not yet
authenticated must enter `uiPassword` before the token can be fetched.

Add an exact control route:

```text
GET /ctl/proxy-token
x-ui-password: <uiPassword>
```

The route returns `{"proxyToken":"..."}` only after normal `/ctl` password
validation. It uses `Cache-Control: no-store` and is not included in
`/ctl/status`, HTML, logs, or error messages.

After a successful request, the UI displays the token in place for ten seconds
and changes the eye control to its hidden-state action. The token is removed
from the DOM and local JavaScript state when any of these occurs:

- the ten-second timer expires;
- the user activates the eye control again;
- the document becomes hidden;
- the UI authentication state is cleared or rejected.

The timer restarts only after a fresh authenticated fetch. The UI does not
persist the token in local storage or session storage. Existing copy behavior
may copy the value only while it is revealed; otherwise it remains disabled.
The icon has a tooltip and accessible label describing its current action.

## Tests

Integration coverage will verify:

- the correct Bearer token returns a normalized balance;
- `x-api-key` remains accepted for parity with proxy requests;
- missing and incorrect tokens return the proxy-auth 401;
- AIHub profile failures map to the documented status codes;
- `/v1/responses` continues to use the same token and is unaffected;
- `/v1` remains available without authentication;
- the balance route is handled locally and is never forwarded upstream.
- `/ctl/proxy-token` rejects a missing or incorrect `uiPassword`;
- `/ctl/proxy-token` returns the configured token after valid UI
  authentication and remains non-cacheable;
- the rendered UI contains masked-by-default reveal controls and the
  ten-second cleanup behavior without embedding the token.

## Deployment Verification

After deploying the new router binary:

- verify `/healthz` and `/v1` remain HTTP 200;
- verify `/v1/responses` without a token is HTTP 401 and with the configured
  token reaches upstream handling;
- verify `/v1/usage` without a token is HTTP 401;
- verify the authorized balance response has finite `balance` and `unit`;
- verify CC Switch's general template displays the same value as the router UI;
- verify service restart count and logs remain healthy.
