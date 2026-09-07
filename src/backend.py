import sys
import json
from sympy import  latex, Symbol, Lambda, Function
from sympy.parsing.sympy_parser import (parse_expr,standard_transformations,implicit_multiplication_application,
                                        convert_xor)

# Needed for accepting calculator-style input such as 2x and x^2 (not just python x**2 or 2*x)
transformations = (standard_transformations+ (implicit_multiplication_application,convert_xor))

note_variable = {}

for line in sys.stdin:
    # If the line is empty or contains only whitespace skip it
    if not line.strip():
        continue

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

        # Dictionary containing this note's assigned values.
        variables = note_variable.setdefault(note_path, {})

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
            variables[name] = Lambda(tuple(parameter_symbols), body)

            # Format the definition as f(x) = ...
            signature = Function(name)(*parameter_symbols)
            result_latex = f"{latex(signature)} = {latex(body)}"

        else:

            expression = parse_expr(
                source,
                local_dict=variables.copy(),
                transformations=transformations
            )

            # Variable is added into dictionary
            if variable is not None:
                variables[variable] = expression

                # Format the variable name and its evaluated value.
                result_latex = f"{latex(Symbol(variable))} = {latex(expression)}"
            else: 
                result_latex = latex(expression)
            
        response = {
            "result": result_latex,
            "requestId": request_id
            }
        

    except Exception as error:
        # Report this request's failure and keep listening for new requests.
        response = {
            "error":str(error),
            "requestId": request_id
            }

    print(json.dumps(response), flush = True)


