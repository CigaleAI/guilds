# Remote access

The box listens on this host only. It does not ask anyone to sign
in. Whoever reaches the port is the operator. That is right for one
person on one machine.

There are two ways to reach the box from elsewhere:

- A **tailnet** lets a set of devices in. Everyone it lets in is the
  same operator.
- An **authenticating proxy** gives each person an account of their
  own.

Both start the same way. Put your own gate in front of the box. Then
tell the server the name people open:

```text
PUBLIC_BASE_URL=https://<the name people open>
```

The server answers a request only when it names a loopback host or
that name.

A browser sends an `Origin` header with a request that changes state
or opens a WebSocket. The server serves such a request only when that
origin is one of:

- the host the request names
- the origin of `PUBLIC_BASE_URL`
- a loopback origin, for a request to a loopback host

A request with no `Origin` does not come from a browser, and passes
([Security register](../architecture/security-register.md), SEC-15).

Connector sign-ins return to
`<PUBLIC_BASE_URL>/api/mcp/oauth/callback`. **Create the GitHub App**
registers that address on the App itself. Register it yourself on
the Google Cloud client and on a GitHub App registered by hand
([Gmail and Drive](../tools-and-connectors/google.md),
[GitHub](../tools-and-connectors/github.md#registering-the-app-by-hand)).
The provider needs no path to the box. Only the operator's browser
does.

## A tailnet

Install Tailscale on the machine and on your devices. Then run this
on the machine:

```text
tailscale serve --bg localhost:8080
```

Use the `ORCHESTRATOR_PORT` value when it is not `8080`.

The app is now at `https://<machine>.<tailnet>.ts.net`. Members of
the tailnet can open it. No one else can.

Keep Funnel off. Membership of the tailnet is the gate. Everyone it
lets through acts as the same operator.

## An authenticating proxy

Set `AUTH_MODE=trusted-header`. The server then takes each person's
identity from the proxy.

The proxy signs the person in. Then it sends two headers with each
request:

- the person's email, in the header named by `TRUSTED_HEADER_EMAIL`
  (default `X-Forwarded-Email`)
- a shared secret, in `X-Guilds-Proxy-Secret`, equal to
  `TRUSTED_PROXY_SECRET`

A request without the secret gets a 401.

This mode needs three more lines in `.env`. The server does not start
without them:

- `PUBLIC_BASE_URL`
- `TRUSTED_PROXY_SECRET`
- `OPERATOR_EMAIL`, the address the proxy sends for you. Boot gives
  it to the box's first user.

Boot refuses to start when another user already holds that address.

An email that belongs to no user gets a 401. The proxy letting
someone through is not enough. You give each person an account, by
their email.

**Admin**, **Users** does it
([Instance admin](../concepts/instance-admin.md)). **New user** takes
their name and email. It creates the user and a personal organisation they own. The
pencil on a user's row changes their address, or removes it.

To let them work in your organisation, add them by name in
**Settings**, **Members**. A guild admin then adds them to the guild
in its **Settings**, **Operators** ([Operators](../concepts/operators.md)).

`DELETE /api/users/<id>`, through the proxy signed in as you, removes
a user. There is no control for it.

In this mode the user directory answers the instance administrator
only. That is an owner of the organisation `Home`. Anyone else gets a
404 ([Users](../concepts/users.md)).
