#!/usr/bin/env python3
"""Verify EU AI Act fields are present in ai_action steps."""
import json
import os
import sys

playbooks_dir = "playbooks"
files = sorted(f for f in os.listdir(playbooks_dir) if f.endswith(".json"))

for filename in files:
    path = os.path.join(playbooks_dir, filename)
    data = json.load(open(path))
    steps = data.get("steps", [])
    for step in steps:
        if step.get("type") == "ai_action":
            if "human_approval_required" not in step and "risk_level" not in step:
                print(f"FAIL: {filename}: ai_action step missing human_approval_required or risk_level")
                sys.exit(1)

print(f"EU AI Act check passed for {len(files)} playbook(s)")
