#!/usr/bin/env bash
# Passes when the whole suite passes. Runs in the agent's working copy.
exec python3 -m unittest discover -s tests -v
