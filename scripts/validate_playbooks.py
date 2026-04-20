#!/usr/bin/env python3
"""Validate all playbooks in the playbooks/ directory."""
import json
import os
import sys

playbooks_dir = "playbooks"
files = sorted(f for f in os.listdir(playbooks_dir) if f.endswith(".json"))

if not files:
    print("No playbook files found — skipping validation.")
    sys.exit(0)

fail = 0
for filename in files:
    path = os.path.join(playbooks_dir, filename)
    try:
        data = json.load(open(path))
        assert "name" in data, "Missing 'name'"
        assert "steps" in data, "Missing 'steps'"
        assert isinstance(data["steps"], list), "'steps' must be an array"
        assert len(data["steps"]) > 0, "'steps' cannot be empty"
        print(f"OK: {path} ({len(data['steps'])} steps)")
    except (json.JSONDecodeError, AssertionError) as e:
        print(f"FAIL: {path} — {e}")
        fail = 1

sys.exit(fail)
