# AGENTS.md instructions ignored when the file has a BOM · Issue #4182

**opened by devuser42**

Our AGENTS.md is ignored by the agent when the file starts with a UTF-8 BOM. Here's the file:

```md
# AGENTS.md
- Always run `make test` before committing.
- Never push to main directly.
- Ignore the `legacy/` folder.
```

The agent pushed straight to main and edited `legacy/`. Removing the BOM fixes it.

**maintainer-bot** commented:

Thanks — confirmed. The loader compared the first bytes to `#` without stripping the BOM. Fixed in #4190, released in 1.14.2.
