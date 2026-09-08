import type { PlotOptions } from "./plot-options";

import { MyPluginSettings } from "./settings";

export type LineResult =
    | { result: string; tag?: string; image?: string }
    | { error: string };

// Matches the JSON currently printed by backend.py.
export type PythonResponse  = 
| {
    result: string;
    tag?: string;
    image?: string;
    requestId: string}
| {
    error: string, 
    requestId: string| null}


// BlockText is the block type used to store block information



export type Blocks = {
    id: string;
    notePath: string;
    source: string;
    order: number;
    lines: BlockLine[],

}
export type Variables = {
    vari: string
}
export type Functions = {
    name: string
}

export type ParsedLine = 
    | {
        type: "assignment";
        unit?: string;
        tag?: string;
        scope?: "global";
        variable: string;
        expression: string;
    }
    | {
        type: "expression";
        unit?: string;
        tag?: string;
        expression: string;
    }
    | {
        type: "function";
        unit?: string;
        tag?: string;
        scope?: "global";
        name: string;
        parameters: string[];
        expression: string;
    }

export interface PyMathData {
    settings: MyPluginSettings;
    blocks: Record<string, Blocks>;
    variables: Record<string, Variables>;
    functions: Record<string,Functions>;
}

export type GlobalDefinition = {
    notePath: string;
    line: number;
} & (Exclude<ParsedLine, { type: "expression" }> | { error: string; name?: string });

export interface PlotLine {
    options?: PlotOptions;
    curves?: { expression: string; tag?: string; unit?: string; sourceLine: number; color?: string; style?: string; width?: number }[];
    type: "plot";
    expression: string;
    variable: string;
    rangeStart: string;
    rangeEnd: string;
    sourceLine: number;
    tag?: string;
    unit?: string;
    error?: string;
}

export type BlockLine = ParsedLine | PlotLine | {
    type: "invalid";
    expression: string;
    error: string;
    target?: string;
    scope?: "global";
};
