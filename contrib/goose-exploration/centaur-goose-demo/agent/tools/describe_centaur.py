import sys
import json

# Minimal MCP-like tool implementation for the demo
# In a real Goose setup, this would use the mcp python library

TOPICS = {
    "overview": "Centaur is a self-hosted agent platform for teams. Users talk to agents in Slack or via API; each thread gets an isolated Kubernetes sandbox running a harness.",
    "architecture": "Slack/API -> Centaur API (Rust api-rs) -> Postgres durable state -> Kubernetes sandbox -> harness CLI -> tools via REST back to API.",
    "api": "Durable control plane: POST /api/session/{thread_key} (spawn), POST .../messages, POST .../execute, GET .../events.",
    "services": "api-rs (control plane), slackbotv2 (Slack), sandbox (agent image), tools/ (Python plugins), workflows, iron-proxy.",
    "comparison": "Goose: MCP-native, local/cli focus, developer extensible. Centaur: K8s-native, Slack focus, durable session threads in Postgres."
}

def describe_centaur(topic):
    summary = TOPICS.get(topic, "Topic not found. Available: " + ", ".join(TOPICS.keys()))
    return {
        "topic": topic,
        "summary": summary,
        "repository": "github.com/wcordelo/centaur"
    }

if __name__ == "__main__":
    # Simulate a simple CLI interface for Goose to call
    if len(sys.argv) > 1:
        topic = sys.argv[1]
        print(json.dumps(describe_centaur(topic)))
    else:
        print("Usage: describe_centaur.py <topic>")
