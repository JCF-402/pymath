
import { MyPluginSettings } from "./settings";

export type LineResult =
    | { result: string }
    | { error: string };

// Matches the JSON currently printed by backend.py.
export type PythonResponse  = 
| {
    result: string; 
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
        scope?: "global";
        variable: string;
        expression: string;
    }
    | {
        type: "expression";
        expression: string;
    }
    | {
        type: "function";
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

export type BlockLine = ParsedLine | {
    type: "invalid";
    expression: string;
    error: string;
    target?: string;
    scope?: "global";
};
