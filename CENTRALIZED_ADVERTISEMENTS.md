# Centralized SHIP/SLAP advertisements

CARS owns SHIP and SLAP advertisement state for hosted project backends. A
dedicated `cars-advertisement-controller` deployment advertises every active
project capability under one network-specific node identity while retaining
each project's public backend URL in the advertisement.

Project backends are intentionally thin:

- `OverlayExpress.configureEngine(false)` omits `tm_ship`, `tm_slap`,
  `ls_ship`, and `ls_slap`.
- A passive advertiser can parse SHIP records for transaction propagation but
  cannot create, enumerate, or revoke advertisements.
- Project pods do not receive a `SERVER_PRIVATE_KEY`. The constructor key is
  process-local and ephemeral.

After a successful backend rollout, CARS verifies the running topic and lookup
service inventory and atomically replaces that project's desired capability
registry. The controller elects one writer with a MySQL advisory lock, creates
missing advertisements before revoking stale node-owned advertisements, and
records every operation in `cars_advertisement_operations`.

## Migration commands

The deployment image includes two deliberately separate migration tools:

```sh
npm run seed:advertisements
npm run revoke:legacy-advertisements
npm run revoke:legacy-advertisements -- --execute
```

The seed command discovers live backend services and excludes the four
node-owned discovery capabilities. Legacy revocation refuses to proceed unless
the node identity already covers the full active registry. Preview mode is the
default; `--execute` revokes old-key outputs and clears each retired key only
after its identity has no remaining advertisements.

Existing immutable backend images are migrated with the generated
`safe-access-logger.cjs` preload and `CARS_CENTRALIZED_ADVERTISEMENTS=true`.
The preload forces the same thin engine mode without rebuilding application
images.
