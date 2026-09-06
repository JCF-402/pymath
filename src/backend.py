import sys
import json

for line in sys.stdin:
    request = json.loads(line)

    x = request["x"]

    response = {
        "result": x**2
    }

    print(json.dumps(response), flush = True)