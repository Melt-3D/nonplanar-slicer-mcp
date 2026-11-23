# Contributing

`npm ci && npm test` builds the server and runs its tests against a stand-in
for the API (`src/server.test.ts`).

It wraps `POST /v1/slices`, described at
[api.melt3d.eu/llms.txt](https://api.melt3d.eu/llms.txt) and
[api.melt3d.eu/v1/openapi.json](https://api.melt3d.eu/v1/openapi.json). A
change to that route's contract comes here too.

Set `MELT3D_API_URL` to use another server instead of
`https://api.melt3d.eu`, such as a local meltslicer-server.

Releasing: bump the version in `package.json`, `src/server.ts` (`VERSION`)
and `server.json` (both places), merge, then tag main with `v<version>` and
push the tag. `.github/workflows/publish.yml` publishes to npm and the MCP
Registry.
