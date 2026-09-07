
import { MyPluginSettings } from "./settings";

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
    source: string,
    lines: ParsedLine[],

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
        variable: string;
        expression: string;
    }
    | {
        type: "expression";
        expression: string;
    }
    | {
        type: "function";
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
