# Block Goose exploration (Centaur repo)

Research notes and a working Goose agent demo living inside [wcordelo/centaur](https://github.com/wcordelo/centaur). Intended as source material for a Notion page comparing Goose to Centaur and Eve.

## What is Block Goose?

**Goose** (codename `goose`) is Block’s open-source, extensible AI agent framework designed to run locally or in production. It is built on the **Model Context Protocol (MCP)** and focuses on turning LLM output into real-world action through a robust extension mechanism.

| Aspect | Goose |
|--------|-------|
| Mental model | "The open-source AI agent for your machine" — agent as an extensible toolset |
| Authoring | `instructions.md` (prompt), MCP Servers (tools), Configuration files |
| Extensibility | MCP-native (Model Context Protocol), Python/TypeScript extensions |
| Hosting | Local CLI / Desktop app, or embedded via API |
| Tooling | Built-in shell, file manipulation, and broad MCP server support |
| Model routing | Supports multiple providers (OpenAI, Anthropic, Ollama, etc.) via configuration |
| Subagents | Native support for delegating tasks to isolated subagent sessions |

**Official resources**

- Product/Docs: https://goose-docs.ai
- Source: https://github.com/aaif-goose/goose
- Block Blog: https://block.xyz/inside/block-open-source-introduces-codename-goose

## Centaur vs Goose vs Eve

| | **Centaur** | **Goose** | **Eve** |
|---|-------------|-----------|---------|
| **Hosting** | Self-hosted Kubernetes (Helm) | Local (CLI/Desktop) or Embedded | Vercel Functions + platform services |
| **Tool Runtime** | Sandbox pod per thread (K8s) | Local shell / MCP Servers | Per-agent sandbox (Docker/Vercel) |
| **Extensibility** | Python plugins (`tools/`) | MCP (Model Context Protocol) | TypeScript files under `agent/tools/` |
| **Durability** | Postgres (`api-rs` session) | Session-based (local) | Vercel Workflow |
| **Primary Channel**| Slack (`slackbotv2`) | CLI / Desktop / API | HTTP / Slack / Discord |

While Centaur focuses on team-scale durable agent threads in Kubernetes, Goose provides a high-performance, developer-centric environment that leverages the MCP ecosystem for tool discovery and execution.

## Demo project layout

```
contrib/goose-exploration/
├── README.md                 # this file
├── scripts/run-demo.sh       # reproducible demo script
└── centaur-goose-demo/       # Goose agent exploration scaffold
    ├── GOOSE_CONFIG.yaml     # Goose configuration (models, MCP servers)
    ├── agent/
    │   ├── instructions.md   # Centaur-focused system prompt
    │   └── tools/            # Custom MCP tools (if any)
    │       └── describe_centaur.py
    └── .goosehints           # Agent hints and auto-load instructions
```

## Prerequisites

- **Goose CLI** (`goose` binary)
- **Python 3.10+** (for custom MCP tools)
- Model credentials (e.g., `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`)

## Quick Start

```bash
# Install Goose (macOS example)
curl -fsSL https://goose.ai/install.sh | sh

# Navigate to demo
cd contrib/goose-exploration/centaur-goose-demo

# Configure Goose to use the local Centaur MCP tool
goose configure add-extension --cmd "python3 agent/tools/describe_centaur.py" --name centaur-tools

# Start an interactive session
goose session --instructions agent/instructions.md
```

## Key Source Files

### `agent/instructions.md`

The system prompt used to anchor the Goose agent's behavior. It includes context about the Centaur repository and how to use the available tools to answer architecture questions.

### `agent/tools/describe_centaur.py`

A Python-based MCP tool that provides factual information about Centaur. It replicates the functionality of the `describe_centaur` tool found in the Eve exploration, allowing the agent to provide consistent answers across frameworks.

### `GOOSE_CONFIG.yaml`

Example configuration file demonstrating how to register MCP servers, set default models, and manage agent behavior.
