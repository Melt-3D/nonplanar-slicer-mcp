// What an agent wants to know about a G-code file without reading it: the
// engines write it in comments, each in its own words.

export interface GcodeSummary {
    layers: number;
    /** The engine's estimate, in seconds. */
    printSeconds?: number;
    /** Filament the engine says the print uses. */
    filamentGrams?: number;
    filamentMeters?: number;
}

export function summarize(gcode: string): GcodeSummary {
    let layers = 0;
    let printSeconds: number | undefined;
    let filamentGrams: number | undefined;
    let filamentMeters: number | undefined;
    for (const line of gcode.split('\n')) {
        if (!line.startsWith(';')) continue;
        // PrusaSlicer and OrcaSlicer: ;LAYER_CHANGE. CuraEngine: ;LAYER:3.
        if (line.startsWith(';LAYER_CHANGE') || /^;LAYER:\d+/.test(line)) {
            layers++;
            continue;
        }
        const prusaTime = /^; estimated printing time(?: \(normal mode\))? = (.+)$/.exec(line);
        if (prusaTime && printSeconds === undefined) {
            printSeconds = duration(prusaTime[1]);
            continue;
        }
        const curaTime = /^;TIME:(\d+(?:\.\d+)?)/.exec(line);
        if (curaTime) {
            printSeconds = Number(curaTime[1]);
            continue;
        }
        const grams = /^; (?:total )?filament used \[g\] = ([\d.]+)/.exec(line);
        if (grams) {
            filamentGrams = Number(grams[1]);
            continue;
        }
        const millimeters = /^; (?:total )?filament used \[mm\] = ([\d.]+)/.exec(line);
        if (millimeters) {
            filamentMeters = Number(millimeters[1]) / 1000;
            continue;
        }
        const curaMeters = /^;Filament used: ([\d.]+)m/.exec(line);
        if (curaMeters) filamentMeters = Number(curaMeters[1]);
    }
    return { layers, printSeconds, filamentGrams, filamentMeters };
}

/** `1d 2h 3m 4s`, any part left out, in seconds. */
function duration(text: string): number | undefined {
    let seconds = 0;
    let matched = false;
    for (const [, amount, unit] of text.matchAll(/(\d+)\s*([dhms])/g)) {
        matched = true;
        seconds += Number(amount) * { d: 86400, h: 3600, m: 60, s: 1 }[unit as 'd' | 'h' | 'm' | 's'];
    }
    return matched ? seconds : undefined;
}

/** Seconds as `2 h 5 min`, for people. */
export function formatDuration(seconds: number): string {
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
