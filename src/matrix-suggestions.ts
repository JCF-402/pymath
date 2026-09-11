import type { MathSuggestion } from "./autocomplete";

// Member suggestions are syntax hints, not inferred runtime types.
export const matrixSuggestions: MathSuggestion[] = [
    { name: "rhs", description: "Right-hand side of an equation (property)" },
    { name: "lhs", description: "Left-hand side of an equation (property)" },
    { name: "subs", parameters: ["symbol", "value"], description: "Substitute in an expression; derivative.subs(t,0) for initial conditions" },
    { name: "diff", parameters: ["variable", "order (optional)"], description: "Differentiate an expression" },
    { name: "T", description: "Transpose (property; no parentheses)" },
    { name: "inv", parameters: [], description: "Matrix inverse; requires a nonsingular square matrix" },
    { name: "det", parameters: [], description: "Determinant" },
    { name: "trace", parameters: [], description: "Sum of diagonal entries" },
    { name: "rank", parameters: [], description: "Matrix rank" },
    { name: "dot", parameters: ["other"], description: "Vector dot product" },
    { name: "cross", parameters: ["other"], description: "Cross product of three-component vectors" },
    { name: "norm", parameters: [], description: "Vector Euclidean norm (default)" },
    { name: "eigenvals", parameters: [], description: "Eigenvalues and algebraic multiplicities" },
    { name: "eigenvects", parameters: [], description: "Eigenvalue, multiplicity, and basis-vector triples" },
    { name: "LUsolve", parameters: ["b"], description: "Solve A*x = b" },
].map(item => ({ ...item, scope: "builtin" }));
