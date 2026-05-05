---
argument-hint: <query> [depth:0|1|2|3] [model:<id>]
---

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

**Always specify a depth.** Judge it from the user's language and task complexity.

**User says a depth word (highest priority):**
- "quick" / "brief" / "simple" → `depth: 0`
- "normal" / "moderate" / "standard" → `depth: 1`
- "deep" / "thorough" / "in-depth" → `depth: 2` (never depth 3)
- "ultra" / "exhaustive" / "comprehensive" / "deep-dive" → `depth: 3`

**User says nothing about depth — judge complexity:**
- `depth: 0` — Simple facts, lookups, news, definitions, "what is X". This covers ~85%+ of queries. Single session: runs 20–30 targeted search queries then scrapes the best sources.
- `depth: 1` — Moderate scope: comparisons, overviews, background research.
- `depth: 2` — Complex multi-faceted topics: policy analysis, tech evaluations, academic-style research.
- `depth: 3` — Never without explicit user request.

**How depth works internally:**
- `depth: 0` (Quick) — One direct agent session. Fast, definitive answers for simple queries.
- `depth: 1-3` — AI-orchestrated: coordinator plans a team, researchers execute, evaluator decides whether to continue deeper. Team size and number of rounds scale with complexity. The coordinator and evaluator dynamically determine how many researchers are needed each round — it's not a fixed number.

**Max siblings per round by depth:**
- `depth: 1` — up to {MAX_TEAM_SIZE_L1} researchers per round
- `depth: 2` — up to {MAX_TEAM_SIZE_L2} researchers per round
- `depth: 3` — up to {MAX_TEAM_SIZE_L3} researchers per round

The coordinator will plan as many researchers as needed (up to the max). You do not need to use the maximum — just enough to cover the topic thoroughly.

**Special keyword handling:**
- "level one/1" through "level three/3" and "ultra mode" in the query ARE depth instructions. Extract depth from them, strip them from the query text.
- "deep dive" as part of a topic phrase ("python deep dive") is NOT a depth instruction — it's topic content.

---

#### MULTIPLE RESEARCH CALLS

**Different/unrelated topics:** Use multiple parallel `research` calls. The research tool can be called simultaneously if required.

**One topic with multiple aspects:** Do NOT decompose a single user query into multiple research calls — the coordinator inside the tool handles decomposition into sub-topics internally. A single call with appropriate depth handles multi-faceted topics.

**Do NOT escalate depth just because a topic is broad or has multiple aspects** — depth 0 (quick mode) handles most cases well, and the higher depths have their own internal decomposition.

**Direct Execution:** `pi-research` (this research tool for web research) should be called directly by you and not embedded in subagent calls. Do not use `invoke_agent` or delegate to subagents to perform research on your behalf.
