import os
import re
import json

def scan_websockets(index_file):
    events = []
    with open(index_file, 'r') as f:
        content = f.read()

        # Match socket.on('event', ...)
        matches = re.finditer(r"socket\.on\(\s*['\"]([^'\"]+)['\"]\s*,\s*(?:async\s*)?\((.*?)\)\s*=>", content)
        for match in matches:
            event_name = match.group(1)
            params = match.group(2)
            events.append({
                "type": "incoming",
                "event": event_name,
                "params": params.strip()
            })

        # Match io.emit('event', ...) or socket.emit or io.to(...).emit
        emit_matches = re.finditer(r"(?:io|socket|req\.app\.get\(['\"]io['\"]\))\.(?:to\(.*?\)\.)?emit\(\s*['\"]([^'\"]+)['\"]\s*,\s*(.*?)\)", content)
        for match in emit_matches:
            event_name = match.group(1)
            payload = match.group(2)
            events.append({
                "type": "outgoing",
                "event": event_name,
                "payload": payload.strip()
            })

    return events

def main():
    index_file = 'index.js'
    events = scan_websockets(index_file)
    print(json.dumps(events, indent=2))

if __name__ == "__main__":
    main()
