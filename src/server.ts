// The MCP server: tools an agent calls to slice models with the Melt3D
// Slicer API. It reads models from, and writes G-code to, the local disk, so
// neither has to pass through the conversation.

import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { ApiError, slice } from './api.js';
import { formatDuration, summarize } from './gcode.js';

export const VERSION = '0.1.0';

/** The largest model the API takes, once inflated. */
const MAX_MODEL_BYTES = 100 * 1024 * 1024;

export interface Config {
    apiUrl: string;
    /** `undefined` when MELT3D_API_KEY is not set: every slice says how to get one. */
    apiKey: string | undefined;
}

const SETTINGS_HELP = `Melt3D is the most advanced nonplanar slicing: besides flat layers, this API
slices conical layers, which print overhangs leaning outwards (or inwards)
without support. The server bends the part, slices it and maps the G-code
back onto the bed itself.

Layers (optional):
- layers: planar (default) or conical
- cone_angle: with layers=conical, how far the layers lean from horizontal,
  degrees, 5 to 85 either way (default 15). Positive leans them outwards, for
  overhangs that widen upwards; negative inwards. Conical layers need a
  binary STL and take no supports.

Print settings (all optional; left out, the engine's default):
- engine: prusaslicer (default), curaengine or orcaslicer
- layer_height, first_layer_height: mm, 0.01 to 2 (0.2 is typical)
- perimeters: wall count, 0 to 20
- infill_density: percent, 0 to 100
- infill_pattern: grid, gyroid or honeycomb
- nozzle_temp: °C, 0 to 500; bed_temp: °C, 0 to 200
- brim_width: mm, 0 to 50
- supports: none or bed (supports from the bed only)

Billing: every slice returns printable G-code and is billed per slice. New
accounts start with 1 EUR of free credit; after that a payment method is
needed. Limits per key: 4 slices at once, 120 a minute. A slice that cannot
answer within 95 seconds is stopped and not billed.
Keys and pricing: https://melt3d.eu/api`;

export function createServer(config: Config): McpServer {
    const server = new McpServer(
        { name: 'melt3d-slicer', title: 'Melt3D Slicer', version: VERSION },
        {
            instructions:
                'The most advanced nonplanar slicing: slices 3D models (STL files on this computer) into G-code ' +
                "for FDM 3D printers on Melt3D's servers, in flat layers or in nonplanar conical layers that print " +
                "overhangs without support. Call slice_model with the STL's path; the G-code is written beside it. " +
                'For an overhang that would need support, try layers: "conical" (a positive cone_angle for one that ' +
                'widens upwards). Call slicer_settings to learn the settings, limits and pricing.',
        },
    );

    server.registerTool(
        'slice_model',
        {
            title: 'Slice a 3D model into G-code',
            description:
                "Slices an STL file on this computer into G-code on Melt3D's servers and writes the G-code to a file, " +
                'in flat layers or in nonplanar conical layers (layers: "conical"), which print overhangs without ' +
                'support. ' +
                'Returns where it was written, whether its layers are conical, the layer count, and the estimated print time ' +
                'and filament. A live API key is billed once per successful slice; failed slices are free.',
            inputSchema: {
                model_path: z.string().describe('Path to the STL file to slice.'),
                output_path: z
                    .string()
                    .optional()
                    .describe('Where to write the G-code. Default: beside the model, with the extension .gcode.'),
                overwrite: z.boolean().default(false).describe('Replace output_path if it exists.'),
                engine: z.enum(['prusaslicer', 'curaengine', 'orcaslicer']).optional(),
                layer_height: z.number().min(0.01).max(2).optional().describe('mm'),
                first_layer_height: z.number().min(0.01).max(2).optional().describe('mm'),
                perimeters: z.number().int().min(0).max(20).optional(),
                infill_density: z.number().min(0).max(100).optional().describe('percent'),
                infill_pattern: z.enum(['grid', 'gyroid', 'honeycomb']).optional(),
                nozzle_temp: z.number().min(0).max(500).optional().describe('°C'),
                bed_temp: z.number().min(0).max(200).optional().describe('°C'),
                brim_width: z.number().min(0).max(50).optional().describe('mm'),
                supports: z.enum(['none', 'bed']).optional(),
                layers: z
                    .enum(['planar', 'conical'])
                    .optional()
                    .describe('planar (default), or conical: nonplanar layers that print overhangs without support'),
                cone_angle: z
                    .number()
                    .min(-85)
                    .max(85)
                    .optional()
                    .describe(
                        'With layers "conical": degrees from horizontal, at least 5 either way (default 15). ' +
                            'Positive leans the layers outwards, negative inwards.',
                    ),
            },
            outputSchema: {
                output_path: z.string(),
                conical: z.boolean().describe('Sliced in nonplanar conical layers.'),
                gcode_bytes: z.number(),
                layers: z.number(),
                print_seconds: z.number().optional(),
                filament_grams: z.number().optional(),
                filament_meters: z.number().optional(),
                rate_limit_remaining: z.number().optional(),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async ({ model_path, output_path, overwrite, ...settings }): Promise<CallToolResult> => {
            if (!config.apiKey) {
                return failure(
                    'MELT3D_API_KEY is not set. Create a key at https://auth.melt3d.eu/developers (new accounts ' +
                        'start with free credit) and set MELT3D_API_KEY in this MCP server\'s environment.',
                );
            }
            const model = resolve(model_path);
            let size: number;
            try {
                const info = await stat(model);
                if (!info.isFile()) return failure(`${model} is not a file.`);
                size = info.size;
            } catch {
                return failure(`Cannot read ${model}: no such file.`);
            }
            if (size === 0) return failure(`${model} is empty.`);
            if (size > MAX_MODEL_BYTES) return failure(`${model} is over the API's 100 MiB limit.`);
            if (extname(model).toLowerCase() !== '.stl') {
                return failure(`${model} is not an STL file. The API slices STL; export the model as STL first.`);
            }
            const output = resolve(output_path ?? join(dirname(model), `${basename(model, extname(model))}.gcode`));
            if (!overwrite && (await exists(output))) {
                return failure(`${output} exists. Pass overwrite: true to replace it, or another output_path.`);
            }

            let sliced;
            try {
                sliced = await slice({
                    apiUrl: config.apiUrl,
                    apiKey: config.apiKey,
                    stl: await readFile(model),
                    filename: basename(model),
                    settings,
                });
            } catch (e) {
                if (e instanceof ApiError) return failure(`The Melt3D Slicer API refused the slice (${e.message}).`);
                return failure(`Could not reach the Melt3D Slicer API at ${config.apiUrl}: ${String(e)}`);
            }
            await writeFile(output, sliced.gcode);

            const summary = summarize(sliced.gcode);
            const conical = sliced.kind === 'mapped';
            const what = conical ? 'printable nonplanar (conical) G-code' : 'printable G-code';
            const lines = [
                `Wrote ${what} to ${output}.`,
                `${summary.layers} layers, ${(sliced.gcode.length / 1024).toFixed(0)} KiB.`,
            ];
            if (summary.printSeconds !== undefined) lines.push(`Estimated print time: ${formatDuration(summary.printSeconds)}.`);
            if (summary.filamentGrams !== undefined) lines.push(`Filament: ${summary.filamentGrams.toFixed(1)} g.`);
            else if (summary.filamentMeters !== undefined) lines.push(`Filament: ${summary.filamentMeters.toFixed(2)} m.`);
            return {
                content: [{ type: 'text', text: lines.join('\n') }],
                structuredContent: {
                    output_path: output,
                    conical,
                    gcode_bytes: Buffer.byteLength(sliced.gcode),
                    layers: summary.layers,
                    print_seconds: summary.printSeconds,
                    filament_grams: summary.filamentGrams,
                    filament_meters: summary.filamentMeters,
                    rate_limit_remaining: sliced.rateLimitRemaining,
                },
            };
        },
    );

    server.registerTool(
        'slicer_settings',
        {
            title: 'Slicer settings, limits and pricing',
            description: 'Describes the print settings slice_model takes, the API key kinds, limits and where pricing is.',
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (): Promise<CallToolResult> => ({ content: [{ type: 'text', text: SETTINGS_HELP }] }),
    );

    return server;
}

function failure(text: string): CallToolResult {
    return { content: [{ type: 'text', text }], isError: true };
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}
