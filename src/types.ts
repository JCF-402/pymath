
import { MyPluginSettings } from "./settings";
// BlockText is the block type used to store block information
export type Blocks = {
    text: string,

}
export type Variables = {
    vari: string
}


export interface PyMathData {
    settings: MyPluginSettings;
    blocks: Record<string, Blocks>;
    variables: Record<string, Variables>;
}

