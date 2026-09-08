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

Function suggestions show their parameter names; globals show the source note. Selecting a function inserts `name()` and places the cursor inside the parentheses, while existing call arguments are preserved. Local names take precedence over globals. A curated set of built-in SymPy functions and constants is also suggested, with signatures and short descriptions: trigonometry, roots, logarithms, algebra, differentiation, integration, `pi`, `E`, `I`, and `oo`. Function parameters and local/global definitions take precedence over built-ins. Trigonometric angles use radians; matching remains case-sensitive.

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

Fully numeric, finite results such as `sin(5000)`, `sqrt(2)`, and fractions display decimal approximations using the configured precision (12 significant digits by default). Integers remain integers and expressions with unknown symbols remain symbolic. Substitution steps retain their exact expressions, and stored variables/functions retain exact values for subsequent calculations. Trigonometric inputs remain in radians.

In PyMath settings, **Precision** accepts 2–30 significant digits. **Number format** offers Automatic, Decimal, and Scientific. Changing either setting refreshes tracked blocks immediately while retaining exact internal values. Integers stay exact; explicit decimal/scientific formatting applies to finite real results. Symbolic, complex and infinite values retain SymPy formatting.

**Decimal places** sets 0–20 digits after the decimal point, including trailing zeros. Leave it blank to use significant-digit precision. It overrides precision for finite real output; scientific notation applies it to the mantissa. Changes refresh existing blocks and do not round stored values.

## Unit labels

Append a label separated by a space, such as `speed = distance/time [m/s]`. Labels appear in upright text after the final result and can precede a trailing comment. They also work on expressions and global/function definitions. These are literal display labels: units are not calculated, converted, or inherited by later expressions. Labels begin with a letter or a unit symbol such as `°`; ordinary indexing such as `values[0]` is preserved.

## Equation tags

Append `{Outlet velocity}` to an equation, for example `v = 20 [m/s] {Outlet velocity}`. Tags render as right-aligned parenthesized labels beside the equation and appear in autocomplete descriptions for local/global variables and functions. Unit and tag suffixes may appear in either order before a trailing comment. Tags are literal text, not executable LaTeX or alternative variable names; use the original variable/function name in calculations.

## CSV dataset autocomplete

One vault CSV can supply numeric autocomplete entries. Configure **Dataset CSV path**, **Dataset name template**, **Dataset value column**, **Dataset description template**, and **Dataset display unit**, then run **PyMath: Reload datasets**. The configured dataset also loads at startup; editing a CSV does not change previously inserted numbers or automatically reload the file.

Defaults match `N,Z,A,El,mass_u` headers: name `{El}_{A}_{Z}`, value column `mass_u`, description `{El}-{A}, Z={Z}, N={N}`, and display unit `u`. Type `He` in a PyMath block to see matching rows. Selecting a row inserts only its numeric text, retaining the digits from the CSV. Labels and units are shown in the suggestion, not inserted into the equation.

Copy `examples/isotopes-sample.csv` into your vault, for example as `Data/isotopes.csv`, to try it. These three example rows were transcribed from the supplied image and are test data, not a verified reference dataset.

CSV supports comma delimiters, quoted fields, escaped quotes, CRLF and UTF-8 BOM. Headers must be unique; values must be decimal/scientific numeric literals. A malformed dataset shows a notice and supplies no suggestions. Files are limited to 5 MB. This version supports one dataset; JSON and multiple datasets are not yet implemented.

Automatic number format uses scientific notation for nonzero magnitudes below `0.0001` or at least `1,000,000`, including when decimal places are set. Other values use decimal notation. Scientific output omits a redundant `× 10^0` factor.

Long equations scroll horizontally within their result rather than widening the note. Tags wrap and move below their equation when the result is 480 px wide or narrower. Short equations remain centered. This layout uses the result container's width, so it responds to split panes independently of the overall window size.

## Matplotlib plots

A block containing `@plot` renders as one responsive chart in place of all equation output:

````markdown
```pymath
f(x) = sin(x)
@plot f(x) {Sine curve}
@range x = -10, 10
```
````

You can also plot an existing local or global function, or a direct expression such as `@plot x^2`. Use one to ten `@plot` lines and exactly one `@range variable = minimum, maximum` per block. Bounds may reference defined values (for example `-pi, pi`); both must be finite real values with minimum below maximum. For one curve, a trailing tag becomes the chart title. For multiple curves, tags become legend labels (or the expression is used if untagged), with distinct colors. A unit becomes the vertical-axis label when all curves share it; otherwise the axis reads “value”.

Definitions in the block are evaluated in their usual order before the plot is generated. The plot's independent variable shadows a note variable of the same name without changing its stored value. Function/global/range changes refresh the chart, while comment-only edits reuse it. If any calculation in the plot block fails, the block displays an error instead of a chart.

Matplotlib must be installed in the selected Python environment (`python -m pip install matplotlib`, using that environment's executable). Ordinary calculations do not import or require it. Plots use the noninteractive Agg renderer and return an in-memory PNG; no separate plot window or image file is created. Matplotlib's font cache is kept in `.matplotlib-cache` beside `backend.py` unless `MPLCONFIGDIR` is configured.

Plots support up to ten real-valued curves, 801 samples per curve, and a static image. Complex/nonfinite samples are omitted; a jump heuristic breaks common discontinuities but does not guarantee detection of every pole or feature. Interactive zoom, configurable sampling, and export commands are not implemented yet. Deploy updated `main.js`, `backend.py`, and `styles.css` together.

For a comparison plot:

````markdown
```pymath
@plot sin(x) {Sine}
@plot cos(x) {Cosine}
@range x = -10, 10
```
````

## Python paths across devices

**Python executable** is the primary path or command. **Fallback Python executable** is an optional second path, useful when these settings sync between devices. On load and on **Restart Python**, PyMath tries the primary and waits for a backend response; if startup fails, it stops that process and tries the fallback. Identical paths are tried only once. The selected path is not written back over the synced settings. If both fail, settings remain accessible so the paths can be corrected.

Both fields accept an executable path or command, not shell arguments. A working primary is always preferred. This startup check verifies the SymPy backend; Matplotlib is still loaded only when plotting, so install it in the environment used for plots. Run **Restart Python** after changing either path.
