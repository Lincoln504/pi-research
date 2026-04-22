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

**DEFAULT:** Omit depth parameter (uses `depth: 0` - Quick mode, 1 researcher)

**Higher depths** (only when user asks for thoroughness):
- `depth: 1` — Normal: 2 researchers, up to 2 rounds
- `depth: 2` — Deep: 3 researchers, up to 3 rounds
- `depth: 3` — Ultra: 5 researchers, up to 5 rounds


**Trigger words:** "exhaustive", "deep-dive", "ultra", "comprehensive" → use higher depth
**IMPORTANT:** When processing topics with depth keywords ("level one/quick mode", "level two/normal mode", "level three/deep mode", "ultra mode"), EXTRACT the depth parameter from each topic individually. Example: "cyprus level one" → research({ query: "cyprus", depth: 0 }). Do NOT include depth keywords in the query string.

---

#### ONE OR MULTIPLE RESEARCH CALLS?

**Use multiple parallel `research` calls when: different/unrelated topics**

**Use one `research` call with higher depth when: single complex topic**

**Rule of thumb:** Different scopes = parallel calls. Same scope (even if broad or multifaceted) = one deep call.
