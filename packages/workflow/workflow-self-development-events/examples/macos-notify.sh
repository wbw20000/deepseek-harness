#!/bin/sh
# macOS local notification bridge for @deepseek-ai/dsh-workflow-self-development-events.
#
# The events service spawns this script once per event and writes one unified
# event JSON document to stdin:
#
#   { "taskId", "kind", "sessionId", "title", "occurredAt", "revision" }
#
# python3 reads the JSON, escapes the two fields the notification carries, and
# assembles the osascript argv itself, so quotes, backticks, and $() command
# substitutions inside the event text stay inert: no shell ever re-interprets
# a field. The event content is title-level only; nothing else is read from
# stdin. This file is a template: review it and point the service's
# `localNotificationCommand` at your copy.
exec python3 -c '
import json, subprocess, sys

event = json.load(sys.stdin)

def apple_string(text):
    return chr(34) + text.replace(chr(92), chr(92) + chr(92)).replace(chr(34), chr(92) + chr(34)) + chr(34)

body = apple_string(str(event.get("title", "")))
heading = apple_string(str(event.get("taskId", "")))
subprocess.run(["osascript", "-e", "display notification " + body + " with title " + heading], check=False)
'
