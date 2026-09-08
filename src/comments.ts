// A hash inside a quoted string belongs to the expression, not a comment.
// PyMath parses one physical line at a time; multiline strings are unsupported.
export function stripComment(source: string): string {
    let quote = "";
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (quote) {
            if (character === "\\") {
                index++;
            } else if (source.startsWith(quote, index)) {
                index += quote.length - 1;
                quote = "";
            }
        } else if (character === "#") {
            return source.slice(0, index);
        } else if (character === "'" || character === '"') {
            quote = source.startsWith(character.repeat(3), index) ? character.repeat(3) : character;
            index += quote.length - 1;
        }
    }
    return source;
}
