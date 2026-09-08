import sys
import json
import io
import ast
import tokenize
from decimal import Decimal
from sympy import latex, Symbol, Lambda, Function, Integral, Derivative, Limit, Sum, Product
from sympy.parsing.sympy_parser import (parse_expr,standard_transformations,implicit_multiplication_application,
                                        convert_xor)

# Needed for accepting calculator-style input such as 2x and x^2 (not just python x**2 or 2*x)
transformations = (standard_transformations+ (implicit_multiplication_application,convert_xor))

_cached_key = None
_cached_values = None
_cached_error = None


def resolve_globals(definitions):
    global _cached_key, _cached_values, _cached_error
    key = json.dumps(definitions, sort_keys=True)
    if key != _cached_key:
        _cached_key = key
        _cached_values = None
        _cached_error = None
        try:
            _cached_values = _resolve(definitions)
        except Exception as error:
            _cached_error = str(error)
    if _cached_error is not None:
        raise ValueError(_cached_error)
    return tuple(part.copy() for part in _cached_values)


def _resolve(definitions):
    if not isinstance(definitions, list):
        raise ValueError("Global definitions must be a list.")
    by_name = {}
    errors = {}
    for definition in definitions:
        location = f"{definition.get('notePath', '?')}:{definition.get('line', '?')}"
        if "error" in definition:
            name = definition.get("name")
            if name:
                errors[name] = f"Global '{name}' ({location}): {definition['error']}"
            continue
        kind = definition.get("type")
        name = definition.get("variable" if kind == "assignment" else "name")
        if kind not in ("assignment", "function") or not isinstance(name, str) or not name.isidentifier():
            raise ValueError(f"Invalid global definition at {location}.")
        if name in by_name:
            other = by_name[name]
            errors[name] = f"Duplicate global '{name}': {other['notePath']}:{other['line']} and {location}."
        by_name[name] = definition

    values = {}
    visiting = []

    def resolve(name):
        if name in errors:
            raise ValueError(errors[name])
        if name in values:
            return
        if name in visiting:
            raise ValueError("Circular global definitions: " + " -> ".join(visiting + [name]))
        definition = by_name[name]
        visiting.append(name)
        try:
            parameters = definition.get("parameters", [])
            if not isinstance(parameters, list) or not all(isinstance(p, str) and p.isidentifier() for p in parameters):
                raise ValueError("Function parameters must be names.")
            if len(set(parameters)) != len(parameters):
                raise ValueError("Function parameters must be unique.")
            source = definition["expression"]
            # Resolve references first, regardless of file order. Parameters are local.
            names = {token.string for token in tokenize.generate_tokens(io.StringIO(source).readline)
                     if token.type == tokenize.NAME}
            for dependency in sorted((names & (by_name.keys() | errors.keys())) - set(parameters)):
                resolve(dependency)
            symbols = [Symbol(parameter) for parameter in parameters]
            context = {**values, **dict(zip(parameters, symbols))}
            body = parse_expr(source, local_dict=context, transformations=transformations)
            unknown = body.free_symbols - set(symbols)
            if unknown:
                raise ValueError("Undefined global names: " + ", ".join(sorted(str(s) for s in unknown)))
            values[name] = Lambda(tuple(symbols), body) if definition["type"] == "function" else body
        except Exception as error:
            errors[name] = f"Global '{name}' ({definition['notePath']}:{definition['line']}): {explain_error(error, definition.get('expression', ''))}"
            raise ValueError(errors[name]) from error
        finally:
            visiting.pop()

    for name in by_name:
        try:
            resolve(name)
        except ValueError:
            pass
    return values, errors


def display_value(value, request):
    precision = request.get("precision", 12)
    if type(precision) is not int or not 2 <= precision <= 30:
        precision = 12
    # Round only the presentation, never the stored mathematical value.
    if (getattr(value, "is_number", False) and getattr(value, "is_finite", None) is True
            and not getattr(value, "is_Integer", False)):
        approximate = value.evalf(precision)
        if approximate != value:
            return approximate, True
    return value, False


def number_latex(value, request):
    mode = request.get("numberFormat", "automatic")
    places = request.get("decimalPlaces")
    fixed = type(places) is int and 0 <= places <= 20
    if isinstance(value, (list, tuple)):
        left, right = (r"\left[", r"\right]") if isinstance(value, list) else (r"\left(", r"\right)")
        return left + ", ".join(number_latex(item, request) for item in value) + right
    if getattr(value, "is_real", None) is not True or getattr(value, "is_finite", None) is not True:
        displayed, _ = display_value(value, request)
        return latex(displayed)
    magnitude = Decimal(str(value.evalf(15))).adjusted() if value != 0 else 0
    scientific = mode == "scientific" or (mode == "automatic" and value != 0 and (magnitude < -4 or magnitude >= 6))
    if fixed:
        digits = max(30, places + max(0, magnitude) + 15)
        decimal = Decimal(str(value.evalf(digits)))
    else:
        displayed, _ = display_value(value, request)
        decimal = Decimal(str(displayed))
    if scientific and decimal:
        text = format(decimal, f'.{places}E' if fixed else 'E')
        mantissa, exponent = text.split('E')
        if not fixed and '.' in mantissa:
            mantissa = mantissa.rstrip('0').rstrip('.')
        # Multiplying by 10^0 adds no information, even in scientific mode.
        return mantissa if int(exponent) == 0 else mantissa + r" \times 10^{" + str(int(exponent)) + "}"
    text = format(decimal, f'.{places}f' if fixed else 'f')
    if not fixed and '.' in text:
        text = text.rstrip('0').rstrip('.')
    return text[1:] if text.startswith('-') and Decimal(text) == 0 else text



def calculus_latex(source, variables, value, request):
    """Build notation from the outer call without changing evaluation or stored values."""
    constructors = {"integrate": Integral, "diff": Derivative, "limit": Limit,
                    "summation": Sum, "product": Product}
    try:
        normalized = source.replace("^", "**")
        call = ast.parse(normalized, mode="eval").body
        if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name):
            return None
        name = call.func.id
        # A local/global function with this name retains its ordinary call display.
        if name not in constructors or name in variables:
            return None
        def argument(node):
            return parse_expr(ast.get_source_segment(normalized, node),
                              local_dict=variables.copy(), transformations=transformations)
        args = [argument(node) for node in call.args]
        kwargs = {item.arg: argument(item.value) for item in call.keywords if item.arg}
        if any(item.arg is None for item in call.keywords):
            return None
        if name == "diff":
            kwargs["evaluate"] = False
        written = constructors[name](*args, **kwargs)
        operation = latex(written)
        result = number_latex(value, request)
        # An unresolved integral/derivative is already its own result.
        return operation if written == value or operation == result else operation + " = " + result
    except Exception:
        # Display enrichment must never turn a successful calculation into an error.
        return None


def explain_error(error, source):
    detail = str(error)
    if isinstance(error, (SyntaxError, tokenize.TokenError, IndexError)):
        stack = []
        pairs = {')': '(', ']': '[', '}': '{'}
        try:
            for token in tokenize.generate_tokens(io.StringIO(source).readline):
                if token.type != tokenize.OP:
                    continue
                if token.string in ('(', '[', '{'):
                    stack.append(token.string)
                elif token.string in pairs:
                    if not stack or stack.pop() != pairs[token.string]:
                        return f"Unexpected or mismatched closing bracket '{token.string}'. Details: {detail}"
        except (tokenize.TokenError, SyntaxError):
            pass
        if stack:
            closing = {'(': ')', '[': ']', '{': '}'}[stack[-1]]
            return f"Missing closing bracket '{closing}'. Details: {detail}"
        if isinstance(error, (SyntaxError, tokenize.TokenError)):
            return f"Invalid expression. Check operators, quotes and punctuation. Details: {detail}"
    if isinstance(error, TypeError) and ('arguments' in detail or 'argument' in detail):
        return f"Check the function's arguments. Details: {detail}"
    return detail


def render_plot(request, variables, failures):
    if request.get("error"):
        raise ValueError(request["error"])
    independent = request.get("variable")
    if not isinstance(independent, str) or not independent.isidentifier():
        raise ValueError("The plot range needs a valid variable name.")
    symbol = Symbol(independent)
    curves = request.get("curves") or [request]
    if not isinstance(curves, list) or not 1 <= len(curves) <= 10:
        raise ValueError("Use between one and ten plot expressions.")
    context = {**variables, independent: symbol}
    def curve_expression(curve):
        source = curve.get("expression", "")
        referenced = {token.string for token in tokenize.generate_tokens(io.StringIO(source).readline) if token.type == tokenize.NAME}
        for name in sorted((referenced - {independent}) & failures.keys()):
            raise ValueError(f"Cannot use '{name}': {failures[name]}")
        expression = parse_expr(source, local_dict=context.copy(), transformations=transformations)
        if not hasattr(expression, "free_symbols"):
            raise ValueError("Plot one scalar expression per curve.")
        unknown = expression.free_symbols - {symbol}
        if unknown:
            raise ValueError("Undefined plot values: " + ", ".join(sorted(str(item) for item in unknown)))
        return expression
    for key in ("rangeStart", "rangeEnd"):
        referenced = {token.string for token in tokenize.generate_tokens(io.StringIO(request.get(key, "")).readline) if token.type == tokenize.NAME}
        for name in sorted(referenced & failures.keys()):
            raise ValueError(f"Cannot use '{name}': {failures[name]}")
    bounds = []
    for key in ("rangeStart", "rangeEnd"):
        value = parse_expr(request.get(key, ""), local_dict=variables.copy(), transformations=transformations)
        if value.is_real is not True or value.is_finite is not True or value.free_symbols:
            raise ValueError("Plot bounds must be finite real numbers.")
        bounds.append(float(value))
    import math
    if not all(math.isfinite(value) for value in bounds) or bounds[0] >= bounds[1]:
        raise ValueError("The plot minimum must be less than the maximum; both must be finite.")
    try:
        import os
        # Keep Matplotlib's font cache with the plugin, not in a user directory.
        os.environ.setdefault("MPLCONFIGDIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), ".matplotlib-cache"))
        import numpy as np
        from matplotlib.figure import Figure
        from matplotlib.backends.backend_agg import FigureCanvasAgg
        from sympy import lambdify
    except ImportError as error:
        raise ValueError("Plotting requires Matplotlib. Install matplotlib in the Python executable selected in PyMath settings.") from error
    xs = np.linspace(bounds[0], bounds[1], 801)
    if not np.all(np.isfinite(xs)):
        raise ValueError("The plot range is too large to sample.")
    def sample(curve):
        try:
            expression = curve_expression(curve)
            with np.errstate(all="ignore"):
                raw = np.asarray(lambdify(symbol, expression, modules="numpy")(xs), dtype=complex)
            ys = np.broadcast_to(raw, xs.shape).real.copy()
            invalid = ~np.isfinite(raw) | (np.abs(raw.imag) > 1e-12)
            ys[np.broadcast_to(invalid, xs.shape)] = np.nan
        except Exception as error:
            raise ValueError("Could not sample this expression as a real-valued curve: " + str(error)) from error
        if np.count_nonzero(np.isfinite(ys)) < 2:
            raise ValueError("No real, finite curve values in this range.")
        # Avoid joining common poles such as 1/x across opposite infinities.
        differences = np.abs(np.diff(ys))
        finite = differences[np.isfinite(differences)]
        if finite.size:
            threshold = max(float(np.median(finite)) * 100, float(np.percentile(finite, 90)) * 10, 1e-12)
            ys[1:][differences > threshold] = np.nan
        return ys
    sampled = []
    for curve in curves:
        try:
            sampled.append(sample(curve))
        except Exception as error:
            raise ValueError(f"Curve {curve.get('tag') or curve.get('expression')} (line {curve.get('sourceLine', '?')}): {error}") from error
    options = request.get("options") or {}
    size = options.get("size", [8, 4.5])
    if (not isinstance(size, list) or len(size) != 2 or
            not all(isinstance(n, (int, float)) and math.isfinite(n) for n in size) or
            not 2 <= size[0] <= 16 or not 2 <= size[1] <= 12 or size[0] * size[1] > 120):
        raise ValueError("Invalid plot size. Use width 2–16, height 2–12 inches, area at most 120.")
    positions = {"auto": "best", "top-right": "upper right", "top-left": "upper left", "bottom-right": "lower right", "bottom-left": "lower left", "center": "center"}
    legend_option = options.get("legend", "auto")
    if legend_option not in positions and legend_option != "off":
        raise ValueError("Invalid legend position.")
    figure = Figure(figsize=size, dpi=140, layout="constrained")
    canvas = FigureCanvasAgg(figure)
    try:
        axes = figure.add_subplot(111)
        colors = ["#738fe6", "#e69851", "#53b59d", "#d775a2", "#ad8bd4", "#c3b24f", "#65afce", "#c97463", "#8aa866", "#a0a0a0"]
        for index, (curve, ys) in enumerate(zip(curves, sampled)):
            from matplotlib.colors import is_color_like
            color, style, width = curve.get("color", colors[index]), curve.get("style", "solid"), curve.get("width", 2)
            if not is_color_like(color):
                raise ValueError(f"Curve {index + 1}: unknown color '{color}'.")
            if style not in ("solid", "dashed", "dotted", "dashdot"):
                raise ValueError(f"Curve {index + 1}: invalid line style.")
            if not isinstance(width, (int, float)) or not 0.25 <= width <= 8:
                raise ValueError(f"Curve {index + 1}: line width must be between 0.25 and 8 points.")
            axes.plot(xs, ys, color=color, linestyle=style, linewidth=width, label=curve.get("tag") or curve["expression"])
        if legend_option != "off" and (len(curves) > 1 or "legend" in options):
            legend = axes.legend(loc=positions[legend_option], framealpha=0, labelcolor="#999999")
            for text in legend.get_texts():
                text.set_parse_math(False)
        axes.set_xlim(*bounds)
        axes.set_xlabel(options.get("xlabel", independent), color="#999999", parse_math=False)
        axes.set_ylabel(options.get("ylabel") or (curves[0].get("unit") if all(curve.get("unit") == curves[0].get("unit") for curve in curves) else None) or "value", color="#999999", parse_math=False)
        title = options.get("title", request.get("tag") if len(curves) == 1 else None)
        if title:
            axes.set_title(title, color="#999999", parse_math=False)
        axes.tick_params(colors="#999999")
        for spine in axes.spines.values():
            spine.set_color("#888888")
        if options.get("grid", True):
            axes.grid(True, alpha=0.25)
        else:
            axes.grid(False)
        figure.patch.set_alpha(0)
        axes.patch.set_alpha(0)
        buffer = io.BytesIO()
        canvas.print_png(buffer)
        import base64
        return base64.b64encode(buffer.getvalue()).decode("ascii")
    finally:
        figure.clear()


note_variable = {}
note_globals = {}
note_errors = {}

for line in sys.stdin:
    # If the line is empty or contains only whitespace skip it
    if not line.strip():
        continue

    request = {}
    source = ""
    target = None
    is_global = False
    request_id = None
    try:

        request = json.loads(line)
        # Validate the request before attempting to parse the expression.
        # If not a dict object raise error

        if not isinstance(request, dict):
            raise ValueError("Expected a JSON object.")

        request_id = request.get("requestId")
        if not isinstance(request_id,str) or not request_id:
            request_id = None
            raise ValueError(" A request needs a request ID. Internal error.")
        
        line_type = request.get("type")

        note_path = request.get("notePath") 
        if not isinstance(note_path, str) or not note_path.strip():
            raise ValueError("A request needs a note path.")

        if line_type == "reset-note":
            # Clear only this note's variables and functions.
            note_errors.pop(note_path, None)
            note_variable.pop(note_path, None)
            note_globals.pop(note_path, None)
            note_globals[note_path] = resolve_globals(request.get("globals", []))

            print(json.dumps({
                "requestId": request_id,
                "result": "",
            }), flush=True)

            continue

        # Dictionary containing this note's assigned values.
        note_values = note_variable.setdefault(note_path, {})
        global_values, global_errors = note_globals.get(note_path, ({}, {}))
        local_errors = note_errors.setdefault(note_path, {})
        is_global = request.get("scope") == "global"
        # Global declarations never capture or overwrite note-local values.
        variables = global_values.copy() if is_global else {**global_values, **note_values}

        if line_type == "invalid":
            target = request.get("target")
            if target is not None and not isinstance(target, str):
                target = None
            raise ValueError(request.get("error", "Invalid calculation."))

        if line_type == "plot":
            source = request.get("expression", "")
            failures = {**{key: value for key, value in global_errors.items() if key not in note_values}, **local_errors}
            png = render_plot(request, variables, failures)
            print(json.dumps({"requestId": request_id, "result": "", "image": png}), flush=True)
            continue

        if line_type not in ("expression","assignment","function"):
            raise ValueError("Unsupported line type.")
        # Declare variable in scope
        variable = None


        if line_type == "assignment":
            # get the variable associated with the line
            variable = request.get("variable") 


            if not isinstance(variable, str) or not variable:
                raise ValueError("An assignment needs a variable name.")



        # Source looks for the expression inside json.loads
        source = request.get("expression")

        if not isinstance(source,str) or not source.strip():
            raise ValueError("Enter a mathematical expression.")


        target = request.get("variable" if line_type == "assignment" else "name") if line_type != "expression" else None
        failures = global_errors.copy() if is_global else {
            **{key: value for key, value in global_errors.items() if key not in note_values}, **local_errors,
        }
        if is_global and target in failures:
            raise ValueError(failures[target])
        referenced = {token.string for token in tokenize.generate_tokens(io.StringIO(source).readline)
                      if token.type == tokenize.NAME}
        if line_type == "function":
            referenced -= set(request.get("parameters", []))
        for dependency in sorted(referenced & failures.keys()):
            raise ValueError(f"Cannot use '{dependency}': {failures[dependency]}")

        if line_type == "function":
            name = request.get("name")
            parameters = request.get("parameters")

            if not isinstance(name, str) or not name:
                raise ValueError("A function needs a name.")
            if not isinstance(parameters, list) or not all(isinstance(parameter,str) and parameter for parameter in parameters):
                raise ValueError("Function parameters must be names.")

            if len(set(parameters)) != len(parameters):
                raise ValueError("Function parameters must be unique.") ##
            ## So something like f(x,x) doesnt work. Doesnt make sense either

            # Create symbolic placeholrders for the function's parameters.
            parameter_symbols = [Symbol(parameter) for parameter in parameters]

            # Start with the note's values, the override parameter names
            # Thus a stored x = 5 does not replace the x inside f(x).

            local_values = variables.copy()
            local_values.update(zip(parameters, parameter_symbols))

            body = parse_expr(
                source, 
                local_dict=local_values,
                transformations=transformations
            )

            # Store a callable mathematical functon in this note's dictionary
            if not is_global:
                note_values[name] = Lambda(tuple(parameter_symbols), body)

            # Format the definition as f(x) = ...
            signature = Function(name)(*parameter_symbols)
            calculation = calculus_latex(source, local_values, body, request)
            result_latex = f"{latex(signature)} = {calculation or latex(body)}"

        else:

            expression = parse_expr(
                source,
                local_dict=variables.copy(),
                transformations=transformations
            )

            displayed, approximated = display_value(expression, request)
            relation = " = "
            calculation = calculus_latex(source, variables, expression, request)
            if variable is not None:
                result_latex = latex(Symbol(variable)) + relation + number_latex(expression, request)

                if request.get("showSubstitutionSteps") is True:
                    # Preserve variable names and function calls for display.
                    symbolic_values = {
                        name: Function(name) if isinstance(value, Lambda)
                        else Symbol(name)
                        for name, value in variables.items()
                    }

                    original = parse_expr(
                        source,
                        local_dict=symbolic_values,
                        transformations=transformations,
                        evaluate=False,
                    )

                    # Substitute without simplifying ordinary arithmetic.
                    substituted = parse_expr(
                        source,
                        local_dict=variables.copy(),
                        transformations=transformations,
                        evaluate=False,
                    )

                    steps = []
                    for value in ((original, substituted) if approximated else (original, substituted, expression)):
                        formatted = number_latex(expression, request) if value is expression else latex(value, order="none", mul_symbol="dot")
                        # Avoid repeated adjacent steps such as x = 5 = 5.
                        if not steps or steps[-1] != formatted:
                            steps.append(formatted)

                    result_latex = f"{latex(Symbol(variable))} = " + " = ".join(steps)
                    if approximated:
                        result_latex += " = " + number_latex(expression, request)

                if calculation:
                    result_latex = latex(Symbol(variable)) + " = " + calculation

                # Format using the previous values before storing the new one.
                if not is_global:
                    note_values[variable] = expression
            else:
                result_latex = calculation or number_latex(expression, request)
                # Display a standalone user-defined call without evaluating
                # away its name or substituting its written arguments.
                try:
                    call = ast.parse(source.replace('^', '**'), mode='eval').body
                except SyntaxError:
                    call = None
                if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and isinstance(variables.get(call.func.id), Lambda):
                    symbolic = {key: Function(key) if isinstance(value, Lambda) else Symbol(key)
                                for key, value in variables.items()}
                    written = parse_expr(source, local_dict=symbolic, transformations=transformations, evaluate=False)
                    result_latex = latex(written) + " = " + result_latex
            
        escapes = {"\\": r"\textbackslash{}", "{": r"\{", "}": r"\}",
                   "$": r"\$", "&": r"\&", "%": r"\%", "#": r"\#",
                   "_": r"\_", "^": r"\textasciicircum{}", "~": r"\textasciitilde{}"}
        unit = request.get("unit")
        if isinstance(unit, str) and unit:
            result_latex += r"\,\text{" + "".join(escapes.get(char, char) for char in unit) + "}"
        tag = request.get("tag")

        if target and not is_global:
            local_errors.pop(target, None)
        response = {
            "result": result_latex,
            **({"tag": tag} if isinstance(tag, str) and tag else {}),
            "requestId": request_id
            }
        

    except Exception as error:
        message = explain_error(error, source)
        source_line = request.get("sourceLine") if isinstance(request, dict) else None
        if isinstance(source_line, int) and source_line > 0 and request.get("type") != "invalid":
            message = f"Line {source_line}: {message}"
        if target and not is_global:
            note_errors.setdefault(note_path, {})[target] = message
            note_variable.setdefault(note_path, {}).pop(target, None)
        # Report this request's failure and keep listening for new requests.
        response = {
            "error":message,
            "requestId": request_id
            }

    print(json.dumps(response), flush = True)
