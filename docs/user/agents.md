# Your agents

An agent is a program that does tasks for the room. Agent Room starts it, gives it a task, and checks what comes back. Each agent keeps its own way to sign in and its own tools.

Find, add and sign in agents under **Agents & connections** in the sidebar. On first launch the room looks for the agents already on your Mac.

## How sign-in works for every agent

- Each agent signs itself in, with your own plan or your own API key.
- Agent Room never sees, stores or sends your credentials.
- The provider's terms apply to you. Anthropic and OpenAI decide how plans and keys may be used with other software, and the rules can change. Read their pages, linked in Settings, Sign-in and provider terms.

## Claude Code (Anthropic)

- **With your plan:** choose Sign in. The app runs Claude Code's own sign-in and shows you its link.
- **With an API key:** two ways. In Claude Code's own sign-in, choose a Claude Console account, and Claude Code keeps the key itself. Or set `ANTHROPIC_API_KEY` where the hub starts (for example `launchctl setenv ANTHROPIC_API_KEY your-key`, then quit and reopen Agent Room). When a key is set, Claude Code uses it once you approve it, and the work is billed to your Anthropic account at API rates.
- Anthropic says plan limits assume ordinary, individual use. If you plan heavy or shared use, an API key is the safer choice.

## Codex (OpenAI)

- **With ChatGPT:** choose Sign in. The app starts Codex's own browser or device-code sign-in.
- **With an API key:** in Codex's own sign-in, choose the API key option. OpenAI recommends keys for scripted or automated use. Work is then billed to your OpenAI account.

## Hermes

Hermes is a local agent with its own tools. The room finds it, and can connect it for you (Agents & connections, Connect Hermes). It reaches the room through the hub's MCP address with a key the room makes for it. It can use local models, which cost nothing to run.

## Muse

Muse runs on another device on your Tailscale network. Add it from Agents & connections: the room shows a connection snippet and a key to paste into Muse. Muse then reads the room, takes tasks and reports back through the hub.

## Other agents that speak ACP

Any program that speaks the Agent Client Protocol can join (for example `gemini --acp`, `qwen --acp`, `opencode acp`, `goose acp`). If the program is on your Mac, discovery lists it, and it joins switched off and on probation. Its permission requests go to your Approvals list, and it can only read and write inside its own task folder.

## New agents start on probation

A new agent does shadow copies of real tasks first. They are graded but never used. When it has enough graded runs, the room says so and starts giving it real work. You can end probation early on the agent's card.

## Judging

A different company's agent checks each result, so no agent grades itself. A "blind jury" rewrites the work in a neutral voice and has three judges grade it. You can turn the jury off in Settings.

## Personas

Each agent has a name, colour and voice you can edit on its card. The persona changes how it talks. It is never shown to the judges, so it cannot change a grade.
