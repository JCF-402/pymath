import type { MathSuggestion } from "./autocomplete";

// Names are case-sensitive and match SymPy's expression namespace.
export const builtinSuggestions: MathSuggestion[] = [
    { name: "sin", parameters: ["x"], description: "Sine; angle in radians" },
    { name: "cos", parameters: ["x"], description: "Cosine; angle in radians" },
    { name: "tan", parameters: ["x"], description: "Tangent; angle in radians" },
    { name: "asin", parameters: ["x"], description: "Inverse sine; result in radians" },
    { name: "acos", parameters: ["x"], description: "Inverse cosine; result in radians" },
    { name: "atan", parameters: ["x"], description: "Inverse tangent; result in radians" },
    { name: "sqrt", parameters: ["x"], description: "Principal square root" },
    { name: "exp", parameters: ["x"], description: "Exponential, E raised to x" },
    { name: "log", parameters: ["x", "base (optional)"], description: "Natural logarithm, or logarithm to a specified base" },
    { name: "Abs", parameters: ["x"], description: "Absolute value" },
    { name: "factorial", parameters: ["n"], description: "Factorial of n" },
    { name: "floor", parameters: ["x"], description: "Round down to an integer" },
    { name: "ceiling", parameters: ["x"], description: "Round up to an integer" },
    { name: "simplify", parameters: ["expr"], description: "Simplify an expression" },
    { name: "expand", parameters: ["expr"], description: "Expand products and powers" },
    { name: "factor", parameters: ["expr"], description: "Factor a polynomial" },
    { name: "diff", parameters: ["expr", "variable"], description: "Differentiate an expression" },
    { name: "integrate", parameters: ["expr", "variable"], description: "Integrate an expression" },
    { name: "pi", description: "Circle constant π" },
    { name: "E", description: "Euler's number, the natural logarithm base" },
    { name: "I", description: "Imaginary unit; I² = −1" },
    { name: "oo", description: "Positive infinity" },
].map(item => ({ ...item, scope: "builtin" }));
