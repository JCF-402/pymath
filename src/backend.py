import sys
import json
import io
import ast
import tokenize
import re
from decimal import Decimal
from sympy import latex, Dummy, Symbol, Lambda, Function, Integral, Derivative, Limit, Sum, Product, MatrixBase, Basic, Add, Pow, Rational
from sympy.core.relational import Relational
from sympy.core.function import FunctionClass
from sympy.parsing.sympy_parser import (parse_expr as sympy_parse_expr,standard_transformations,implicit_multiplication_application,
                                        convert_xor)

def implicit_math(tokens, local_dict, global_dict):
    # SymPy's implicit parser tests truthiness to identify callable names.
    # Equations have no truth value; use symbolic placeholders only for
    # token transformation, retaining the real equations for evaluation.
    parsing_context = {name: MathSymbol(name) if isinstance(value, Relational) else value
                       for name, value in local_dict.items()}
    return implicit_multiplication_application(tokens, parsing_context, global_dict)


# Needed for accepting calculator-style input such as 2x and x^2 (not just python x**2 or 2*x)
transformations = (standard_transformations+ (implicit_math,convert_xor))

_quantity_type = None


def has_units(value):
    return _quantity_type is not None and isinstance(value, Basic) and value.has(_quantity_type)


def labeled_value(value, unit):
    if not isinstance(unit, str):
        raise ValueError("A display unit label must be quoted text.")
    return value


def outer_label(source):
    try:
        node = ast.parse(source.replace("^", "**"), mode="eval").body
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == "label" and len(node.args) == 2
                and isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str)):
            return node.args[1].value
    except SyntaxError:
        pass
    return None


def is_numeric_assignment(source):
    # Decimal literals and the common mantissa * 10^exponent notation
    # are values, not calculations whose intermediate steps help the reader.
    try:
        node = ast.parse(source.replace("^", "**"), mode="eval").body
    except SyntaxError:
        return False
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "label" and len(node.args) == 2:
        node = node.args[0]
    def literal(value):
        if isinstance(value, ast.UnaryOp) and isinstance(value.op, (ast.UAdd, ast.USub)):
            return literal(value.operand)
        return isinstance(value, ast.Constant) and type(value.value) in (int, float)
    return literal(node) or (
        isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult)
        and literal(node.left) and isinstance(node.right, ast.BinOp)
        and isinstance(node.right.op, ast.Pow)
        and isinstance(node.right.left, ast.Constant) and node.right.left.value == 10
        and literal(node.right.right)
    )


def display_unit_latex(label):
    escapes = {"\\": r"\textbackslash{}", "{": r"\{", "}": r"\}",
               "$": r"\$", "&": r"\&", "%": r"\%", "#": r"\#",
               "_": r"\_", "^": r"\^{ }", "~": r"\~{ }"}
    def text(value):
        return r"\text{" + "".join(escapes.get(char, char) for char in value) + "}"
    parts, start = [], 0
    for match in re.finditer(r"\^(?:\{([+-]?\d+)\}|([+-]?\d+))", label):
        if match.start() > start:
            parts.append(text(label[start:match.start()]))
        parts.append("^{" + (match.group(1) or match.group(2)) + "}")
        start = match.end()
    if start < len(label):
        parts.append(text(label[start:]))
    return "".join(parts)


# Explicit unit names avoid collisions with note variables such as m, s, or N.
def unit_expression(text):
    from sympy.physics import units
    global _quantity_type
    _quantity_type = units.Quantity
    aliases = dict(zip(
        "m km cm mm um nm s ms min h day kg g mg A K mol cd Hz N Pa kPa J kJ W C V ohm L mL rad deg eV".split(),
        "meter kilometer centimeter millimeter micrometer nanometer second millisecond minute hour day kilogram gram milligram ampere kelvin mole candela hertz newton pascal kilopascal joule kilojoule watt coulomb volt ohm liter milliliter radian degree electronvolt".split()))
    if not isinstance(text, str):
        raise ValueError('Units must be quoted text, such as "m/s".')
    def read(node):
        if isinstance(node, ast.Name) and node.id in aliases:
            if node.id == "kPa": return 1000 * units.pascal
            if node.id == "kJ": return 1000 * units.joule
            return getattr(units, aliases[node.id])
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            return Rational(str(node.value))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            return -read(node.operand)
        if isinstance(node, ast.BinOp):
            left, right = read(node.left), read(node.right)
            if isinstance(node.op, ast.Mult): return left * right
            if isinstance(node.op, ast.Div): return left / right
            if isinstance(node.op, ast.Pow) and right.is_number: return left ** right
        raise ValueError("Unknown unit or unsupported syntax. Use supported unit names with *, /, and powers.")
    try:
        result = read(ast.parse(text.replace("^", "**"), mode="eval").body)
        if result == 0: raise ValueError("A unit scale cannot be zero.")
        return result
    except (SyntaxError, AttributeError) as error:
        raise ValueError("Unknown unit or invalid unit expression.") from error


def checked_units(value):
    if not has_units(value):
        return value
    from sympy.physics.units import Quantity
    from sympy.physics.units.util import check_dimensions, quantity_simplify
    from sympy.physics.units.systems.si import SI
    if not isinstance(value, Basic) or not value.has(Quantity):
        return value
    try:
        check_dimensions(value)
        # Elementary function arguments and exponents must be dimensionless.
        for function in value.atoms(Function):
            for argument in function.args:
                if argument.has(Quantity) and SI.get_dimension_system().get_dimensional_dependencies(SI.get_dimensional_expr(argument)):
                    raise ValueError("Function arguments must be dimensionless.")
        for power in value.atoms(Pow):
            if power.exp.has(Quantity):
                raise ValueError("Exponents must be dimensionless.")
        return quantity_simplify(value)
    except (ValueError, TypeError) as error:
        raise ValueError("Unit mismatch: " + str(error)) from error


def quantity(value, text):
    return checked_units(value * unit_expression(text))


def convert_quantity(value, text):
    from sympy.physics.units import convert_to, Quantity
    from sympy.physics.units.systems.si import SI
    value = checked_units(value)
    target = unit_expression(text)
    dimensions = SI.get_dimension_system()
    if dimensions.get_dimensional_dependencies(SI.get_dimensional_expr(value)) != dimensions.get_dimensional_dependencies(SI.get_dimensional_expr(target)):
        raise ValueError("Unit mismatch: cannot convert to " + text + ".")
    converted = convert_to(value, target)
    coefficient = (converted / target).simplify()
    if coefficient.has(Quantity):
        raise ValueError("Could not convert to " + text + ".")
    return coefficient * target


def quantity_magnitude(value, text):
    return (convert_quantity(value, text) / unit_expression(text)).simplify()


def substitute(expression, *args):
    if len(args) == 2:
        pairs = [(args[0], args[1])]
    elif len(args) == 1 and isinstance(args[0], (list, tuple, dict)):
        pairs = list(args[0].items()) if isinstance(args[0], dict) else args[0]
    else:
        raise ValueError("Use subs(expression, symbol, value) or subs(expression, [(symbol, value), ...]).")
    for pair in pairs:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2 or not isinstance(pair[0], Symbol):
            raise ValueError("Substitution targets must be symbols. Declare them with @symbol before defining the formula.")
    return expression.subs(pairs, simultaneous=True)


def braced_names(source):
    # Scan balanced groups; standalone LaTeX names require a command so Python
    # set/dict literals keep their existing meaning.
    pattern = re.compile(r"[^\W\d]\w*_\{|\{", re.UNICODE)
    index = 0
    while match := pattern.search(source, index):
        start = match.start()
        opening = match.end() - 1
        depth, end = 1, opening + 1
        while end < len(source) and depth:
            if source[end] == "{" and source[end-1] != "\\": depth += 1
            if source[end] == "}" and source[end-1] != "\\": depth -= 1
            end += 1
        if depth:
            index = opening + 1
            continue
        raw = source[start:end]
        if opening > start or "\\" in raw:
            yield start, end, raw
            index = end
        else:
            index = opening + 1


class MathSymbol(Symbol):
    def __new__(cls, name, **assumptions):
        if not name.startswith("{") and "_{" not in name:
            return Symbol(name, **assumptions)
        return super().__new__(cls, name, **assumptions)

    def _latex(self, printer):
        if self.name.startswith("{") and self.name.endswith("}"):
            return self.name[1:-1]
        if "_{" in self.name:
            return self.name
        return printer._print_Symbol(self)


def normalized_names(source):
    # Protect quoted strings: unit labels and Function("name") are literal text.
    protected = set()
    try:
        lines = source.splitlines(keepends=True)
        offsets = [0]
        for line in lines: offsets.append(offsets[-1] + len(line))
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.STRING:
                protected.update(range(offsets[token.start[0]-1]+token.start[1], offsets[token.end[0]-1]+token.end[1]))
    except (tokenize.TokenError, SyntaxError):
        pass
    names, parts, previous = {}, [], 0
    for start, end, raw in braced_names(source):
        if start in protected: continue
        key = "pymathsub_" + "_".join(format(ord(c), "x") for c in raw)
        names[key] = raw
        parts.extend([source[previous:start], key])
        previous = end
    parts.append(source[previous:])
    return "".join(parts), names


def expression_names(source):
    normalized, names = normalized_names(source)
    return {names.get(token.string, token.string)
            for token in tokenize.generate_tokens(io.StringIO(normalized).readline) if token.type == tokenize.NAME}


def valid_math_name(name):
    return isinstance(name, str) and (name.isidentifier() or any(start == 0 and end == len(name) for start, end, raw in braced_names(name)) is not None)


class Eigenvalues(dict):
    """Keep eigenvalue multiplicities distinct from solver assignments."""


def parse_expr(source, local_dict=None, **kwargs):
    source, named = normalized_names(source)
    local_dict = {normalized_names(key)[0]: value for key, value in (local_dict or {}).items()}
    for key, raw in named.items():
        local_dict.setdefault(key, MathSymbol(raw))
    context = {"label": labeled_value, "unit": quantity, "convert": convert_quantity, "magnitude": quantity_magnitude, "subs": substitute, **(local_dict or {})}
    value = sympy_parse_expr(source, local_dict=context, **kwargs)
    try:
        call = ast.parse(source.replace("^", "**"), mode="eval").body
        if isinstance(value, dict) and isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr == "eigenvals":
            return Eigenvalues(value)
    except SyntaxError:
        pass
    return checked_units(value)


def free_symbols(value):
    if isinstance(value, dict):
        return set().union(*(free_symbols(item) for item in value.values()))
    if isinstance(value, (list, tuple, set)):
        return set().union(*(free_symbols(item) for item in value))
    return getattr(value, "free_symbols", set())


def declared_symbol(definition):
    assumptions = definition["assumptions"]
    allowed = {"real", "positive", "negative", "nonnegative", "nonpositive",
               "nonzero", "integer", "rational", "complex", "finite", "even", "odd"}
    if not isinstance(assumptions, list) or any(not isinstance(a, str) or a not in allowed for a in assumptions):
        raise ValueError("Invalid symbol assumptions.")
    try:
        return MathSymbol(definition["variable"], **dict.fromkeys(assumptions, True))
    except ValueError as error:
        raise ValueError("Conflicting symbol assumptions: " + ", ".join(assumptions)) from error


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
        if kind not in ("assignment", "function") or not isinstance(name, str) or not valid_math_name(name):
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
            if "assumptions" in definition:
                values[name] = declared_symbol(definition)
                return
            parameters = definition.get("parameters", [])
            if not isinstance(parameters, list) or not all(isinstance(p, str) and valid_math_name(p) for p in parameters):
                raise ValueError("Function parameters must be names.")
            if len(set(parameters)) != len(parameters):
                raise ValueError("Function parameters must be unique.")
            source = definition["expression"]
            # Resolve references first, regardless of file order. Parameters are local.
            names = expression_names(source)
            for dependency in sorted((names & (by_name.keys() | errors.keys())) - set(parameters)):
                resolve(dependency)
            symbols = [MathSymbol(parameter) for parameter in parameters]
            context = {**values, **dict(zip(parameters, symbols))}
            body = parse_expr(source, local_dict=context, transformations=transformations)
            unknown = free_symbols(body) - set(symbols) - set().union(*(free_symbols(v) for v in values.values()))
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
    if has_units(value):
        from sympy.physics.units import Quantity
        normalized = checked_units(value)
        if isinstance(normalized, Add):
            return latex(normalized)
        coefficient, units = normalized.as_independent(*normalized.atoms(Quantity), as_Add=False)
        if units != 1:
            return number_latex(coefficient, request) + r"\," + latex(units)
        return number_latex(coefficient, request)
    if isinstance(value, Eigenvalues):
        return r"\left\{" + r",\; ".join(number_latex(key, request) + r"\;\text{multiplicity }" + str(item)
                                           for key, item in value.items()) + r"\right\}"
    if isinstance(value, dict):
        return r"\left\{" + r",\; ".join(latex(key) + " = " + number_latex(item, request)
                                           for key, item in value.items()) + r"\right\}"
    if isinstance(value, MatrixBase):
        rows = [" & ".join(number_latex(value[row, col], request) for col in range(value.cols))
                for row in range(value.rows)]
        return r"\left[\begin{matrix}" + r"\\".join(rows) + r"\end{matrix}\right]"
    if isinstance(value, (list, tuple)):
        left, right = (r"\left[", r"\right]") if isinstance(value, list) else (r"\left(", r"\right)")
        return left + ", ".join(number_latex(item, request) for item in value) + right
    if getattr(value, "is_number", False) is not True or getattr(value, "is_real", None) is not True or getattr(value, "is_finite", None) is not True:
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


def apply_pi_ticks(axes, options):
    from matplotlib.ticker import MultipleLocator, FuncFormatter
    from fractions import Fraction
    import math
    def format_tick(value, position):
        multiple = Fraction(value / math.pi).limit_denominator(1000)
        if multiple == 0: return "0"
        sign = "-" if multiple < 0 else ""
        numerator, denominator = abs(multiple.numerator), multiple.denominator
        top = (str(numerator) if numerator != 1 else "") + r"\pi"
        return "$" + sign + (top if denominator == 1 else r"\frac{" + top + "}{" + str(denominator) + "}") + "$"
    for name in ("x", "y"):
        mode = options.get(name + "ticks", "auto")
        if mode not in ("auto", "pi"):
            raise ValueError("Tick format must be auto or pi.")
        if mode == "auto": continue
        if getattr(axes, "get_" + name + "scale")() != "linear":
            raise ValueError("Pi ticks require a linear axis.")
        lower, upper = getattr(axes, "get_" + name + "lim")()
        # Start with pi/2; thin ticks for wide ranges to avoid huge locators.
        step = math.pi / 2 * max(1, math.ceil(abs(upper - lower) / (6 * math.pi)))
        axis = getattr(axes, name + "axis")
        axis.set_major_locator(MultipleLocator(step))
        axis.set_major_formatter(FuncFormatter(format_tick))


def render_plot(request, variables, failures):
    if request.get("error"):
        raise ValueError(request["error"])
    mode = request.get("mode", "plot")
    if mode not in ("plot", "parametric", "polar"):
        raise ValueError("Unknown plot kind.")
    independent = request.get("variable")
    if not isinstance(independent, str) or not independent.isidentifier():
        raise ValueError("The plot range needs a valid variable name.")
    symbol = variables.get(independent) if isinstance(variables.get(independent), Symbol) else MathSymbol(independent)
    curves = request.get("curves") or [request]
    if not isinstance(curves, list) or not 1 <= len(curves) <= 10:
        raise ValueError("Use between one and ten plot expressions.")
    context = {**variables, independent: symbol}
    def curve_expression(curve, coordinate=None):
        source = curve.get("expression", "")
        referenced = expression_names(source)
        for name in sorted((referenced - {independent}) & failures.keys()):
            raise ValueError(f"Cannot use '{name}': {failures[name]}")
        expression = parse_expr(source, local_dict=context.copy(), transformations=transformations)
        if mode == "parametric":
            if not isinstance(expression, tuple) or len(expression) != 2:
                raise ValueError("Use @parametric x-expression, y-expression.")
            expression = expression[coordinate]
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
    options = request.get("options") or {}
    xscale, yscale = options.get("xrangeScale", "linear"), options.get("yrangeScale", "linear")
    aspect = options.get("aspect", "equal" if mode == "polar" else "auto")
    if mode != "plot" and (xscale != "linear" or yscale != "linear"):
        raise ValueError("Parametric and polar plots currently require linear axes.")
    if xscale not in ("linear", "log") or yscale not in ("linear", "log"):
        raise ValueError("Axis scale must be linear or log.")
    if aspect not in ("auto", "equal"):
        raise ValueError("Aspect must be auto or equal.")
    if xscale == "log" and bounds[0] <= 0:
        raise ValueError("A logarithmic x-axis requires positive range bounds.")
    ybounds = options.get("yrange")
    if ybounds is not None:
        if (not isinstance(ybounds, list) or len(ybounds) != 2 or
                not all(type(n) in (int, float) and math.isfinite(n) for n in ybounds) or ybounds[0] >= ybounds[1]):
            raise ValueError("Vertical bounds must be finite numbers with minimum below maximum.")
        if yscale == "log" and ybounds[0] <= 0:
            raise ValueError("A logarithmic y-axis requires positive vertical bounds.")
    xs = (np.geomspace if xscale == "log" else np.linspace)(bounds[0], bounds[1], 801)
    if not np.all(np.isfinite(xs)):
        raise ValueError("The plot range is too large to sample.")
    def sample(curve, coordinate=None):
        try:
            expression = curve_expression(curve, coordinate)
            with np.errstate(all="ignore"):
                raw = np.asarray(lambdify(symbol, expression, modules="numpy")(xs), dtype=complex)
            ys = np.broadcast_to(raw, xs.shape).real.copy()
            invalid = ~np.isfinite(raw) | (np.abs(raw.imag) > 1e-12)
            ys[np.broadcast_to(invalid, xs.shape)] = np.nan
        except Exception as error:
            raise ValueError("Could not sample this expression as a real-valued curve: " + str(error)) from error
        if mode == "polar":
            ys[ys < 0] = np.nan
        if yscale == "log":
            ys[ys <= 0] = np.nan
            if np.count_nonzero(np.isfinite(ys)) < 2:
                raise ValueError("A logarithmic y-axis needs positive, finite curve values.")
        if np.count_nonzero(np.isfinite(ys)) < 2:
            raise ValueError("No real, finite curve values in this range.")
        # Avoid joining common poles such as 1/x across opposite infinities.
        differences = np.abs(np.diff(np.log10(ys) if yscale == "log" else ys))
        finite = differences[np.isfinite(differences)]
        if finite.size:
            threshold = max(float(np.median(finite)) * 100, float(np.percentile(finite, 90)) * 10, 1e-12)
            ys[1:][differences > threshold] = np.nan
        return ys
    sampled = []
    for curve in curves:
        try:
            horizontal = sample(curve, 0) if mode == "parametric" else xs.copy()
            vertical = sample(curve, 1) if mode == "parametric" else sample(curve)
            valid = np.isfinite(horizontal) & np.isfinite(vertical)
            if np.count_nonzero(valid) < 2:
                raise ValueError("Not enough shared finite coordinates to draw this curve.")
            horizontal[~valid] = np.nan
            vertical[~valid] = np.nan
            sampled.append((horizontal, vertical))
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
        axes = figure.add_subplot(111, projection="polar" if mode == "polar" else None)
        colors = ["#738fe6", "#e69851", "#53b59d", "#d775a2", "#ad8bd4", "#c3b24f", "#65afce", "#c97463", "#8aa866", "#a0a0a0"]
        for index, (curve, (horizontal, vertical)) in enumerate(zip(curves, sampled)):
            from matplotlib.colors import is_color_like
            color, style, width = curve.get("color", colors[index]), curve.get("style", "solid"), curve.get("width", 2)
            if not is_color_like(color):
                raise ValueError(f"Curve {index + 1}: unknown color '{color}'.")
            if style not in ("solid", "dashed", "dotted", "dashdot"):
                raise ValueError(f"Curve {index + 1}: invalid line style.")
            if not isinstance(width, (int, float)) or not 0.25 <= width <= 8:
                raise ValueError(f"Curve {index + 1}: line width must be between 0.25 and 8 points.")
            axes.plot(horizontal, vertical, color=color, linestyle=style, linewidth=width, label=curve.get("tag") or curve["expression"])
        if legend_option != "off" and (len(curves) > 1 or "legend" in options):
            legend = axes.legend(loc=positions[legend_option], framealpha=0, labelcolor="#999999")
            for text in legend.get_texts():
                text.set_parse_math(False)
        axes.set_xscale(xscale)
        axes.set_yscale(yscale)
        if mode == "plot":
            axes.set_xlim(*bounds)
        elif mode == "polar" and bounds[1] - bounds[0] < 2 * math.pi:
            axes.set_thetamin(math.degrees(bounds[0]))
            axes.set_thetamax(math.degrees(bounds[1]))
        if ybounds is not None:
            if mode == "polar" and ybounds[0] < 0:
                raise ValueError("Polar radial limits must be nonnegative.")
            axes.set_ylim(*ybounds)
        elif mode == "polar":
            axes.set_ylim(bottom=0)
        axes.set_aspect(aspect, adjustable="box")
        axes.set_xlabel(options.get("xlabel", "x" if mode == "parametric" else "" if mode == "polar" else independent), color="#999999", parse_math=False)
        axes.set_ylabel(options.get("ylabel") or (curves[0].get("unit") if all(curve.get("unit") == curves[0].get("unit") for curve in curves) else None) or ("y" if mode == "parametric" else "" if mode == "polar" else "value"), color="#999999", parse_math=False)
        title = options.get("title", request.get("tag") if len(curves) == 1 else None)
        if title:
            axes.set_title(title, color="#999999", parse_math=False)
        apply_pi_ticks(axes, options)
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
note_units = {}
global_units = {}
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
            note_units[note_path] = {}
            global_units[note_path] = {item.get("variable"): item.get("unit") or outer_label(item.get("expression", "")) for item in request.get("globals", []) if item.get("variable") and (item.get("unit") or outer_label(item.get("expression", "")))}
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

        if not isinstance(source,str) or (not source.strip() and "assumptions" not in request):
            raise ValueError("Enter a mathematical expression.")


        target = request.get("variable" if line_type == "assignment" else "name") if line_type != "expression" else None
        failures = global_errors.copy() if is_global else {
            **{key: value for key, value in global_errors.items() if key not in note_values}, **local_errors,
        }
        if is_global and target in failures:
            raise ValueError(failures[target])
        referenced = expression_names(source)
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
            parameter_symbols = [MathSymbol(parameter) for parameter in parameters]

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

            expression = declared_symbol(request) if "assumptions" in request else parse_expr(
                source,
                local_dict=variables.copy(),
                transformations=transformations
            )

            displayed, approximated = display_value(expression, request)
            relation = " = "
            calculation = calculus_latex(source, variables, expression, request)
            if variable is not None:
                result_latex = latex(MathSymbol(variable)) + relation + number_latex(expression, request)

                if request.get("showSubstitutionSteps") is True and "assumptions" not in request and not is_numeric_assignment(source):
                    # Preserve variable names and function calls for display.
                    symbolic_values = {
                        name: Function(name) if isinstance(value, Lambda)
                        else value if isinstance(value, (MatrixBase, FunctionClass, Relational)) or has_units(value) else MathSymbol(name)
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

                    unit_symbols = {}
                    if request.get("showUnitsInSteps") is True:
                        labels = global_units.get(note_path, {}).copy()
                        if not is_global:
                            # A local assignment also shadows a global label when it has no units.
                            for key in note_values:
                                labels.pop(key, None)
                            labels.update(note_units.get(note_path, {}))
                        annotated = variables.copy()
                        for key, label in labels.items():
                            value = variables.get(key)
                            if getattr(value, "is_number", False) and not has_units(value):
                                marker = Dummy(key)
                                annotated[key] = marker
                                unit_symbols[marker] = r"\left(" + number_latex(value, request) + r"\," + display_unit_latex(label) + r"\right)"
                        def annotate(value, label):
                            marker = Dummy("label")
                            unit_symbols[marker] = r"\left(" + number_latex(value, request) + r"\," + display_unit_latex(label) + r"\right)"
                            return marker
                        # Inline labels belong to the written formula too; do
                        # not introduce a separate step solely to reveal units.
                        if "label" in expression_names(source):
                            original = parse_expr(source, local_dict={**symbolic_values, "label": annotate},
                                                  transformations=transformations, evaluate=False)
                        annotated["label"] = annotate
                        if unit_symbols or "label" in expression_names(source):
                            substituted = parse_expr(source, local_dict=annotated,
                                                     transformations=transformations, evaluate=False)

                    steps = []
                    for value in ((original, substituted) if approximated else (original, substituted, expression)):
                        formatted = number_latex(expression, request) if value is expression else latex(value, order="none", mul_symbol="dot", symbol_names=unit_symbols)
                        # Avoid repeated adjacent steps such as x = 5 = 5.
                        if not steps or steps[-1] != formatted:
                            steps.append(formatted)

                    result_latex = f"{latex(MathSymbol(variable))} = " + " = ".join(steps)
                    if approximated:
                        result_latex += " = " + number_latex(expression, request)

                if calculation:
                    result_latex = latex(MathSymbol(variable)) + " = " + calculation

                if isinstance(expression, FunctionClass):
                    result_latex = ""

                if "assumptions" in request:
                    result_latex = ""
                elif isinstance(expression, Relational):
                    result_latex = latex(expression)

                # Format using the previous values before storing the new one.
                if not is_global:
                    note_values[variable] = expression
                    labels = note_units.setdefault(note_path, {})
                    labels.pop(variable, None)
                    declared_unit = request.get("unit") or outer_label(source)
                    if declared_unit and "assumptions" not in request:
                        labels[variable] = declared_unit
            else:
                result_latex = calculation or number_latex(expression, request)
                # Display a standalone user-defined call without evaluating
                # away its name or substituting its written arguments.
                try:
                    call = ast.parse(source.replace('^', '**'), mode='eval').body
                except SyntaxError:
                    call = None
                if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and isinstance(variables.get(call.func.id), Lambda):
                    symbolic = {key: Function(key) if isinstance(value, Lambda) else MathSymbol(key)
                                for key, value in variables.items()}
                    written = parse_expr(source, local_dict=symbolic, transformations=transformations, evaluate=False)
                    result_latex = latex(written) + " = " + result_latex
            
        unit = request.get("unit") or outer_label(source)
        if result_latex and isinstance(unit, str) and unit:
            result_latex += r"\," + display_unit_latex(unit)
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
