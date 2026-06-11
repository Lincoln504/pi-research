---
argument-hint: <query> [depth:1|2|3] [model:<id>]
---

### 🔍 RESEARCH TOOL USAGE

**For any web/internet research questions, use the `research` tool.**

**CRITICAL: NO SUBAGENTS OR EXTERNAL DELEGATION**
- Use ONLY the `research` tool for internet investigations.
- NEVER invoke `subagent`, delegate to other agents, or use any manual delegation system.
- The `research` tool has its own internal research system that handles all coordination.
- Do NOT try to "parallelize" by using subagents — the `research` tool handles its own internal parallelization via its own coordinator and concurrent researcher agents.

The `research` tool (from pi-research extension) is your tool for web/internet research.

**⚡ KNOWLEDGE SEARCH**
- The `research_knowledge_search` tool searches the research knowledge database for previously researched information.
- **Unified Results**: It searches both your **Project Knowledge Store** and your **User Knowledge Store** simultaneously.
- It is **instant and free** — always try it FIRST before using the live `research` tool.
- If it finds an answer, it returns a clean, cited report with source attribution (e.g., [User Knowledge Store] or [Project Knowledge Store]).
- If it doesn't find an answer, it explicitly tells you to use live web research.
- You do NOT need both — if `research_knowledge_search` succeeds, skip live research for that query.
- Note: This tool is only available if at least one knowledge store is enabled in settings.

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
- "quick" / "brief" / "simple" → `depth: 1`
- "normal" / "moderate" / "standard" → `depth: 1`
- "deep" / "thorough" / "in-depth" → `depth: 2` (never depth 3)
- "ultra" / "exhaustive" / "comprehensive" / "deep-dive" / "maximum" → `depth: 3`

**User says nothing about depth — judge complexity:**
- `depth: 1` — Simple facts, lookups, news, definitions, "what is X", overviews, background research. This covers ~95%+ of queries.
- `depth: 2` — Complex multi-faceted topics: policy analysis, tech evaluations, academic-style research.
- `depth: 3` — **ABSOLUTELY NEVER without explicit user request.** The user MUST use trigger words like "ultra", "exhaustive", "comprehensive deep-dive", or "maximum research". If the user does not explicitly request this level, use depth 1 or depth 2.

**How depth works internally:**
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

**One Topic, One Call:**
- Use a **single `research` call** for each topic.
- Do NOT split a single topic into multiple manual calls — the tool handles its own internal decomposition and parallelization.
- Do NOT use subagents to make multiple simultaneous calls.

**Multiple Topics:**
- If you need to research multiple unrelated topics of **truly distinct scope**, you may emit multiple `research` calls **simultaneously in a single turn**. Each call gets its own isolated research run with its own coordinator and researchers.
- Example: `research("bananas")` and `research("quantum computing")` in the same turn — these have zero overlap.
- **Group related topics**: If topics share ANY scope or could inform each other, combine them into a single `research` call. The internal coordinator will decompose them into parallel researcher agents. Do NOT split related sub-topics into separate calls.
- Example: `research("Python async performance and Rust async performance comparison")` — NOT separate calls for Python and Rust, since the comparison IS the research goal.

**Do NOT escalate depth just because a topic is broad** — depth 1 handles most cases well, and the higher depths have their own internal decomposition.
