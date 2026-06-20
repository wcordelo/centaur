#!/bin/bash

# Simple script to demonstrate Goose agent setup
# Usage: ./scripts/run-demo.sh

set -e

DEMO_DIR="contrib/goose-exploration/centaur-goose-demo"

echo "=== Centaur Goose Exploration Demo ==="

# Check for goose installation
if ! command -v goose &> /dev/null; then
    echo "Error: 'goose' CLI not found. Please install it from https://goose-docs.ai"
    exit 1
fi

echo "1. Registering Centaur MCP extension..."
# Note: This is an example command, actual config management might vary by goose version
goose configure add-extension --name centaur-tools --cmd "python3 $DEMO_DIR/agent/tools/describe_centaur.py"

echo "2. Starting Goose session with Centaur instructions..."
echo "Ask: 'How does Centaur's architecture work?'"
goose session --instructions "$DEMO_DIR/agent/instructions.md"
