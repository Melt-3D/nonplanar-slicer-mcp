# Melt3D Slicer MCP server

An [MCP](https://modelcontextprotocol.io) server that lets AI agents (Claude,
Cursor, VS Code and other MCP clients) slice 3D models into G-code for FDM 3D
printers, on Melt3D's servers, through the
[Melt3D Slicer API](https://melt3d.eu/api).

The agent names an STL file on your computer; the server sends it to the API
and writes the G-code beside it, then tells the agent the layer count and the
estimated print time and filament. Neither file passes through the
conversation.

## Tools

| Tool | What it does |
|---|---|
| `slice_model` | Slices an STL file into a G-code file. Settings: `engine` (PrusaSlicer, CuraEngine, OrcaSlicer), `layer_height`, `first_layer_height`, `perimeters`, `infill_density`, `infill_pattern`, `nozzle_temp`, `bed_temp`, `brim_width`, `supports` |
| `slicer_settings` | Describes the settings, the key kinds, the limits and where pricing is |

## Getting a key

Create one at [auth.melt3d.eu/developers](https://auth.melt3d.eu/developers).
A test key (`m3d_test_…`) is free and returns a preview of the G-code (the
toolpath, not printable). A live key (`m3d_live_…`) returns printable G-code
and is billed per slice. See the [API terms](https://melt3d.eu/api/terms).

## Setup

Claude Code:

```sh
claude mcp add melt3d-slicer --env MELT3D_API_KEY=m3d_test_… -- npx -y @melt3d/slicer-mcp
```

Claude Desktop, Cursor and other clients that read an `mcpServers` config:

```json
{
  "mcpServers": {
    "melt3d-slicer": {
      "command": "npx",
      "args": ["-y", "@melt3d/slicer-mcp"],
      "env": { "MELT3D_API_KEY": "m3d_test_…" }
    }
  }
}
```

Then ask, for example: "Slice ~/models/bracket.stl at 0.2 mm layers with 20%
gyroid infill."

## Behaviour

- Only STL files, up to 100 MiB. Export other formats as STL first.
- The G-code goes beside the model (`bracket.stl` to `bracket.gcode`) unless
  `output_path` says otherwise, and an existing file is replaced only with
  `overwrite: true`.
- A busy server (503) or a rate limit (429) is retried up to three times,
  as `Retry-After` says, with one `Idempotency-Key`: a retry is never billed
  twice.
- Refusals reach the agent in the API's own words, such as a spending cap
  reached or a setting out of range.

`MELT3D_API_URL` replaces `https://api.melt3d.eu`, for testing.

## Development

`npm ci && npm test` builds it and runs its tests against a stand-in for the
API (`src/server.test.ts`). It wraps `POST /v1/slices`
(`crates/meltslicer-server/API.md`), so a change to that route's contract
comes here in the same PR.

Releasing: bump `version` in `package.json`, `src/server.ts` and
`server.json`, then `npm publish --access public` and publish `server.json`
to the MCP Registry with `mcp-publisher publish`.
