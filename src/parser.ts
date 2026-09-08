import type { ParsedLine } from "./types";

    // Recognize a variable name followed by a single assignment sign.
    // Names can contain letters, numbers and underscores,
    // but cannot begin with a number.
    // There are functions f(x) = something, variables x = something and expressions x
    const namePattern = String.raw`[\p{L}_][\p{L}\p{M}\p{N}_]*`;
    const validName = new RegExp(`^${namePattern}$`, "u");

    const functionDefinition = new RegExp(`^(${namePattern})\\s*\\(([^()]*)\\)\\s*=(?!=)(.*)$`, "u",);

    const variableAssignment = new RegExp(`^(${namePattern})\\s*=(?!=)(.*)$`,"u",);


export function parseLine(source: string): ParsedLine {
    const text = source.trim();
    if (/^@global(?:\s|$)/u.test(text)) {
        const definition = parseLocalLine(text.slice(7));
        if (definition.type === "expression") {
            throw new Error("@global needs a variable or function definition.");
        }
        return { ...definition, scope: "global" };
    }
    return parseLocalLine(text);
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

        if (!line.trim()) continue;

        try {
            parsedLines.push(parseLine(line));

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            // Report the original line number , including blank lines
            throw new Error(`Line ${index + 1}: ${message}`);
        }
    }

    if (parsedLines.length === 0) {
        throw new Error("Enter a mathematical expression.");

    }
    return parsedLines;
}

