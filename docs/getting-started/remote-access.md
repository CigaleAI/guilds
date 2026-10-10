# Remote access

The stack listens on loopback and does not authenticate. Whoever
reaches the port is the operator. That is right for one person on
one machine.

There are two ways to reach the box from elsewhere. A tailnet lets a
set of devices in, and everyone it lets in is the same operator. An
authenticating proxy gives each person an account of their own.

Both start the same way: put your own gate in front and tell the
orchestrator the name it is reached by:

```text
PUBLIC_BASE_URL=https://<the name people open>
```

The orchestrator serves a request only for a loopback host or that
one.

A state-changing request or a WebSocket handshake that carries an
`Origin` is served only when that origin is:

- the host the request names
- the origin of `PUBLIC_BASE_URL`
- or a loopback origin to a loopback host

A request with no `Origin` is not a browser's and passes
([Security register](../architecture/security-register.md), SEC-15).

Connector sign-ins return to
`<PUBLIC_BASE_URL>/api/mcp/oauth/callback`. Register that URI on the
Google Cloud client; **Create the GitHub App** registers it on the
App itself, and an App registered by hand needs it too
([Gmail and Drive](../tools-and-connectors/google.md),
[GitHub](../tools-and-connectors/github.md)).

The provider does not need a path to the box. Only the operator's
browser does.

## A tailnet

With Tailscale on the machine and on your devices:

```text
tailscale serve --bg localhost:8080
```

That publishes the app at `https://<machine>.<tailnet>.ts.net` to the
tailnet's members and to no one else.

Keep Funnel off. Membership of the tailnet is the gate. Everyone it
lets through acts as the same operator.

## An authenticating proxy

`AUTH_MODE=trusted-header` takes each person's identity from the
proxy instead.

The proxy authenticates them, then sends:

- their email in a header (`TRUSTED_HEADER_EMAIL`, default
  `X-Forwarded-Email`)
- a shared secret in `X-Guilds-Proxy-Secret`
  (`TRUSTED_PROXY_SECRET`)

A request without the secret is 401.

The mode needs three more lines in `.env` and does not start without
them:

- `PUBLIC_BASE_URL`
- the secret
- `OPERATOR_EMAIL` — the address the proxy sends for you, which boot
  gives the box's first user

Boot refuses to start when another user already holds that address.

An email that belongs to no user is 401. The proxy letting someone
through is not enough. You give each other person an account by their
email.

The app has no screen for it. It is one request through the proxy,
signed in as you:

```text
POST /api/users   {"name": "ada", "email": "ada@example.com"}
```

The request creates the user and a personal organisation they own.

- `PATCH /api/users/<id>` with `{"email": …}` changes a user's
  address. `null` takes it away.
- `DELETE /api/users/<id>` removes them.

In this mode the user directory answers the instance administrator, an
owner of the organisation `Home`. It is 404 to anyone else
([Users and organisations](../concepts/users-and-organisations.md)).
