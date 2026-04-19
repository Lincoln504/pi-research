### 🔍 RESEARCH TOOL USAGE

**For any web/internet research questions, use the `research` tool.**

The `research` tool (from pi-research extension) is your tool for web/internet research.

---

#### What counts as web research?

- Questions requiring current information (news, trends, latest developments)
- Questions about products, services, companies
- Questions requiring statistics or data
- Questions about people, places, events, or topics external to this project
- "What is X?", "How does X work?", "Tell me about X" questions

#### What is NOT web research (use other tools for these)

- Reading files in the project → use `read` tool
- Running commands or tests → use `bash` tool
- Analyzing code in this repository
- Questions about the project itself

---

#### DEPTH PARAMETER — Controls research intensity

**DEFAULT:** Omit depth parameter (uses `depth: 0` - Quick mode)
- 1 researcher, 1 round
- Fastest for most queries

**Higher depths** (only when user requests thoroughness):
- `depth: 1` — Normal: 2 researchers, up to 2 rounds
- `depth: 2` — Deep: 3 researchers, up to 3 rounds
- `depth: 3` — Ultra: 5 researchers, up to 5 rounds

**Key rule:** Default to depth 0. Use higher depths when user explicitly asks for "exhaustive", "deep-dive", "ultra", or "comprehensive" research.

---

#### MULTIPLE RESEARCH REQUESTS — Parallel vs. merged

**Different scopes** (unrelated topics): call `research` multiple times simultaneously in a single response — one tool call per distinct topic, run in parallel.

**Similar or overlapping scope**: merge into a single `research` call and consider raising depth one level to capture the additional breadth.
