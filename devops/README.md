# VPS deployment

Aurora is a Vite client plus a small Node WebSocket relay. The root route (`/`) is the current v2
world; the legacy prototype remains available at `/v1`. The VPS uses one Caddy site and one
systemd service per tenant.

## First time on this VPS

1. Copy `deploy.env.example` to `deploy.env` and set the host, domain, and a free `APP_PORT`.
2. Point the domain's DNS A/AAAA record at the VPS.
3. Run the shared setup once (safe on a multitenant host):

   ```sh
   ./devops/host-setup.sh
   ```

4. Provision Aurora's isolated user, directory, registry entry, and Caddy site:

   ```sh
   ./devops/provision.sh
   ```

5. Build locally and publish:

   ```sh
   ./devops/deploy.sh
   ```

`host-setup.sh` is host-wide and should not be run casually: it installs shared packages, leaves
firewall policy untouched, and ensures Caddy imports `/etc/caddy/sites/*.caddy`. It does not remove
existing UFW rules, tenant site files, or tenant services. `provision.sh` refuses a domain or port already
registered to another app. `deploy.sh` uses rsync only inside this app's `REMOTE_DIR/dist` and
`REMOTE_DIR/server`, installs the relay's production dependencies as `SERVICE_USER`, then restarts
only Aurora's unit.

## Later netplay work

The relay logs each client's join and leave (address, id's head, user agent) and its diag lines (creature pops, the clock offset) to the unit's journal: `ssh racknerd1 journalctl -u aurora --since today | grep -E 'join|leave|diag'`.

The relay carries pose, hand presence and the avatar id each client wears, nothing else. Its versioned
message envelope leaves room for later ordered world events; it deliberately has no persistence. `APP_PORT` is bound to localhost and
must never be opened publicly.

For local headset testing, run `npm run relay`, then start Vite with
`VITE_WS_URL=ws://localhost:3004/ws npm run dev` and use `adb reverse tcp:5173 tcp:5173` plus
`adb reverse tcp:3004 tcp:3004`.

The recommended order is static deployment first, then the relay and head-only presence, then hand
poses. That gives us a known-good VPS/DNS/TLS baseline and lets the relay be tested independently
with the fake-client check described in `_notes/netplay.md`.
