import sys
import json
import io
import tokenize
from sympy import  latex, Symbol, Lambda, Function
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
            result_latex = f"{latex(signature)} = {latex(body)}"

        else:

            expression = parse_expr(
                source,
                local_dict=variables.copy(),
                transformations=transformations
            )

            if variable is not None:
                result_latex = f"{latex(Symbol(variable))} = {latex(expression)}"

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
                    for value in (original, substituted, expression):
                        formatted = latex(value, order="none", mul_symbol="dot")
                        # Avoid repeated adjacent steps such as x = 5 = 5.
                        if not steps or steps[-1] != formatted:
                            steps.append(formatted)

                    result_latex = (
                        f"{latex(Symbol(variable))} = " + " = ".join(steps)
                    )

                # Format using the previous values before storing the new one.
                if not is_global:
                    note_values[variable] = expression
            else: 
                result_latex = latex(expression)
            
        if target and not is_global:
            local_errors.pop(target, None)
        response = {
            "result": result_latex,
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
