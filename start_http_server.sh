#!/bin/bash

# Load .env file if it exists
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

export MCP_MEMORY_STORAGE_BACKEND=sqlite_vec
export MCP_HTTP_ENABLED=true
export MCP_OAUTH_ENABLED=false

cd "$(dirname "$0")"

# Detect Python command
if command -v python3 &> /dev/null; then
    PYTHON_CMD=python3
elif command -v python &> /dev/null; then
    PYTHON_CMD=python
else
    echo "Error: Python not found in PATH"
    exit 1
fi

# Use MCP_HTTP_PORT environment variable, default to 8000
PORT=${MCP_HTTP_PORT:-8000}

$PYTHON_CMD -m uvicorn mcp_memory_service.web.app:app --host 127.0.0.1 --port $PORT --reload
