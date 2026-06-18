import { defineTool } from "eve/tools";
import { z } from "zod";

const TOPICS = {
  overview:
    "Centaur is a self-hosted agent platform for teams. Users talk to agents in Slack or via API; each thread gets an isolated Kubernetes sandbox running a harness (Amp, Claude Code, Codex).",
  architecture:
    "Slack/API -> Centaur API (Rust api-rs) -> Postgres durable state -> Kubernetes sandbox -> harness CLI -> tools via REST back to API.",
  api:
    "Durable control plane: POST /api/session/{thread_key} (spawn), POST .../messages, POST .../execute, GET .../events. Legacy /agent/* paths are deprecated.",
  services:
    "api-rs (control plane), slackbotv2 (Slack), sandbox (agent image), tools/ (Python plugins), workflows, iron-proxy (credential injection).",
  eve_comparison:
    "Eve: filesystem agent/ directory, Vercel Workflow durability, deploy with vercel deploy. Centaur: repo + Helm/K8s, Postgres durability, Slack-native with sandbox pods per thread.",
} as const;

type Topic = keyof typeof TOPICS;

export default defineTool({
  description:
    "Return factual information about the Centaur platform: overview, architecture, api, services, or eve_comparison.",
  inputSchema: z.object({
    topic: z
      .enum(["overview", "architecture", "api", "services", "eve_comparison"])
      .describe("Which Centaur topic to describe."),
  }),
  async execute({ topic }: { topic: Topic }) {
    return {
      topic,
      summary: TOPICS[topic],
      repository: "github.com/wcordelo/centaur",
    };
  },
});
