# PyMath

PyMath evaluates mathematical expressions in Obsidian `pymath` blocks using a local Python process with SymPy. Variables and functions normally belong to their note and are evaluated in block order.

## Global variables and functions

Prefix a definition with `@global` to make it available throughout the vault:

````markdown
```pymath
@global c = 299792458
@global energy(m) = m*c^2
```
````

Use it in a PyMath block in any other note:

````markdown
```pymath
energy(2)
```
````

- The defining note does not need to be open. PyMath reads Markdown notes once at startup, then maintains the index from note changes.
- Changes, deletions, and renames automatically refresh calculated notes. Python restarts restore globals from the index.
- Definitions must be in root-level fenced `pymath` blocks. Ordinary prose, LaTeX math blocks, and nested list/callout blocks are not indexed.
- Each global name must be unique across the vault. Globals can reference other globals regardless of note order. Function parameters are local to the function.
- Global definitions cannot depend on ordinary note-local variables. Mark dependencies `@global` too, or pass them as function arguments.
- An ordinary local definition overrides a global of the same name within that note. Global functions retain their global dependencies even when the calling note overrides those names.
- Invalid global definitions, duplicate names, undefined dependencies, or circular dependencies produce source-note errors on the affected definitions and their consumers. Independent calculations continue, and correcting the definition automatically restores dependent results. Failed local assignments also invalidate their previous values and propagate the error to later consumers. Malformed lines display individual errors with their original block line numbers; independent lines in the same block continue evaluating. An identifiable failed variable or function definition invalidates that name until a valid redefinition.
- Removing a global removes its value. As with other unassigned names, subsequent expressions may become symbolic.

Globals are indexed in memory from the notes themselves; there is no separate constants file or settings copy to maintain. Updates are debounced, unchanged output retains its rendered DOM, and Python caches resolved global definitions. Global changes rebuild notes with direct or indirect references to the changed definitions. Dependency detection is conservative: shadowed names or implicit multiplication can cause an extra rebuild. Comment-only edits reuse calculated results; notes displaying errors refresh when global source locations move so diagnostics stay accurate.

## Comments

Use `#` for full-line or trailing comments inside PyMath blocks:

````markdown
```pymath
# Shared constant
@global c = 299792458 # metres per second
mass = 2 # kilograms
energy = mass*c^2
```
````

Comments remain in the editor but are omitted from rendered results and evaluation. Blank and comment-only blocks render empty. Commenting out a definition removes its value on the next rebuild, including globals. Hashes inside quoted strings are preserved. Errors retain their original source line numbers.

## Autocomplete

Inside a root-level `pymath` block, start typing a variable or function name to see matching suggestions. Suggestions include earlier local definitions from the current editor buffer, global definitions from other notes, and parameters within a function body. Matching is case-sensitive and supports Unicode names such as `φ1` and `π_1`.

Function suggestions show their parameter names; globals show the source note. Selecting a function inserts `name()` and places the cursor inside the parentheses, while existing call arguments are preserved. Local names take precedence over globals. Built-in SymPy functions are not included in this first autocomplete version.

## Development

```sh
npm install
npm run build
PYMATH_PYTHON=/path/to/python-with-sympy node --test tests/*.test.mjs
npm run lint
```

For local installation, place `main.js`, `manifest.json`, `styles.css`, and **`src/backend.py` as `backend.py`** in the vault's plugin folder. Select the Python executable in PyMath settings. Both the JavaScript bundle and Python script must be updated for this feature; reload the plugin once after installing the update. Defining notes do not need to be reopened afterward.

Calculations and vault indexing run locally. PyMath requires desktop Obsidian and Python with SymPy installed. Its existing expression parser is not a sandbox for untrusted code.

Python evaluation errors include the original block line number. Common bracket and function-argument mistakes receive a clearer explanation with the original technical details retained. Moving an error by adding comments refreshes its location.
