import { stripComment } from "./comments";
import type { ParsedLine, BlockLine } from "./types";

    // Recognize a variable name followed by a single assignment sign.
    // Names can contain letters, numbers and underscores,
    // but cannot begin with a number.
    // There are functions f(x) = something, variables x = something and expressions x
    const namePattern = String.raw`[\p{L}_][\p{L}\p{M}\p{N}_]*`;
    const validName = new RegExp(`^${namePattern}$`, "u");

    const functionDefinition = new RegExp(`^(${namePattern})\\s*\\(([^()]*)\\)\\s*=(?!=)(.*)$`, "u",);

    const variableAssignment = new RegExp(`^(${namePattern})\\s*=(?!=)(.*)$`,"u",);


export function parseLine(source: string): ParsedLine {
    const cleaned = stripComment(source).trim();
    // Require a separating space and a letter-led label to avoid treating
    // ordinary indexing, such as values[0], as a display unit.
    const label = /\s+\[([\p{L}°µΩ][^[\]\r\n]*)\]$/u.exec(cleaned);
    const text = label ? cleaned.slice(0, label.index).trim() : cleaned;
    const unit = label ? { unit: label[1]!.trim() } : {};
    if (/^@global(?:\s|$)/u.test(text)) {
        const definition = parseLocalLine(text.slice(7));
        if (definition.type === "expression") {
            throw new Error("@global needs a variable or function definition.");
        }
        return { ...definition, ...unit, scope: "global" };
    }
    return { ...parseLocalLine(text), ...unit };
}

function parseLocalLine(source: string): ParsedLine {
    const text = source.trim();

    if (!text) {
        throw new Error("Enter a mathematical expression.");
    }

    const functionMatch = functionDefinition.exec(text); // Exec returns match details like so
    // exec(x = 5)
    // match[0] = x = 5
    // match[1] = x
    // match[2] = 5
    // Depending on the regex before .exec

    // Parsing functions
    if (functionMatch) {
        const name = functionMatch[1]!;
        const parameterText = functionMatch[2]!.trim();
        const expression = functionMatch[3]!.trim();

        const parameters = parameterText ? parameterText.split(",").map(parameter => parameter.trim()) : [];

        if (parameters.some(parameter => !validName.test(parameter))) {
            throw new Error("Each function parameter must be a valid name.")
        }
        if (new Set(parameters).size !== parameters.length) {
            throw new Error("Function parameters must have unique names.");
        }
        if (!expression){
            throw new Error("Enter an expression after =.")
        }
        return {
            type: "function",
            name,
            parameters,
            expression,
        };
    }

    // Parsing Assignments
    const assignmentMatch = variableAssignment.exec(text);

    if (assignmentMatch) {
        const variable = assignmentMatch[1]!;
        const expression = assignmentMatch[2]!.trim();

        if (!expression) {
            throw new Error("Enter an expression after=.");
        }

        return {
            type: "assignment",
            variable: variable,
            expression: expression

        }
    }
    // Default value essentially
    return {
        type: "expression",
        expression: text,
    };
}

export function parseBlock(source: string): ParsedLine[] {
    const lines = source.split(/\r?\n/);
    const parsedLines: ParsedLine[] = []


    for (const [index, line] of lines.entries()) {
        // Allow blank lines between calculations.

        if (!stripComment(line).trim()) continue;

        try {
            parsedLines.push(parseLine(line));

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            // Report the original line number , including blank lines
            throw new Error(`Line ${index + 1}: ${message}`);
        }
    }

    return parsedLines;
}


// Preserve every calculation's position even when a neighboring line is incomplete.
export function parseBlockLines(source: string): BlockLine[] {
    const results: BlockLine[] = [];
    for (const [index, raw] of source.split(/\r?\n/).entries()) {
        const expression = stripComment(raw).trim();
        if (!expression) continue;
        try {
            results.push(parseLine(expression));
        } catch (error) {
            const global = /^@global(?:\s|$)/u.test(expression);
            const definition = expression.replace(/^@global\s*/u, "");
            const target = new RegExp(`^(${namePattern})\\s*(?:=(?!=)|\\([^=]*\\)\\s*=(?!=))`, "u").exec(definition)?.[1];
            results.push({ type: "invalid", expression,
                error: `Line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
                ...(target ? { target } : {}), ...(global ? { scope: "global" as const } : {}),
            });
        }
    }
    return results;
}
