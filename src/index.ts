#!/usr/bin/env node
// meltslicer-mcp: the Melt3D Slicer API as an MCP server over stdio.
// MELT3D_API_KEY is the API key; MELT3D_API_URL replaces
// https://api.melt3d.eu, for testing.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from './server.js';

const server = createServer({
    apiUrl: process.env.MELT3D_API_URL || 'https://api.melt3d.eu',
    apiKey: process.env.MELT3D_API_KEY?.trim() || undefined,
});
await server.connect(new StdioServerTransport());
