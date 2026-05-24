# Documentation Standards

This document defines the standards and guidelines for creating and maintaining documentation in the pi-research project.

---

## Table of Contents

- [Documentation Structure](#documentation-structure)
- [Markdown Style Guide](#markdown-style-guide)
- [Documentation Types](#documentation-types)
- [Templates](#templates)
- [Review Process](#review-process)
- [Maintenance](#maintenance)

---

## Documentation Structure

### Directory Layout

```
pi-research/
├── README.md                          # Project overview
├── DEVELOPMENT_ROADMAP.md             # Development priorities
├── docs/
│   ├── api/                           # API documentation
│   │   ├── research-tool.md
│   │   ├── health-check.md
│   │   └── knowledge-store.md
│   ├── guides/                        # User and developer guides
│   │   ├── deployment.md
│   │   ├── troubleshooting.md
│   │   ├── performance-tuning.md
│   │   └── testing.md
│   ├── architecture/                  # Architecture documentation
│   │   ├── overview.md
│   │   ├── decisions.md               # ADRs
│   │   └── scope-boundaries.md
│   ├── development/                   # Development documentation
│   │   ├── roadmap.md
│   │   ├── contributing.md
│   │   └── documentation-standards.md
│   └── archive/                       # Archived temporary docs
│       └── [archived phase reports]
└── src/
    └── prompts/                       # System prompts (considered code)
```

### File Naming

- Use kebab-case for all filenames
- Use lowercase letters only
- Use descriptive names
- Avoid abbreviations unless well-known

Examples:
```
✅ research-tool.md
✅ performance-tuning.md
✅ architecture-decisions.md

❌ ResearchTool.md
❌ perf-tuning.md
❌ arch-dec.md
```

---

## Markdown Style Guide

### Headings

- Use ATX-style headings (`#` not `=` or `-`)
- One space between `#` and heading text
- Start at H1 (`#`) for document title
- Skip heading levels (e.g., H1 → H3 is bad)

```markdown
✅ # Heading 1
✅ ## Heading 2
✅ ### Heading 3

❌ Heading 1
   ========
❌ #Heading 1
❌ # Heading 1
### Heading 3
```

### Paragraphs

- One blank line between paragraphs
- No trailing spaces
- Wrap at ~80 characters (soft wrap)

### Lists

- Use `-` for unordered lists
- Use `1.` for ordered lists
- Indent with 2 spaces
- Leave blank line before and after lists

```markdown
✅ Unordered list:
  - Item one
  - Item two
    - Nested item

✅ Ordered list:
  1. First item
  2. Second item
```

### Code Blocks

- Use fenced code blocks (``` not indentation)
- Specify language when possible
- Include descriptive text before code blocks

```markdown
✅ Here's an example:

```typescript
const store = new KnowledgeStore(config);
```

❌ Example:

    const store = new KnowledgeStore(config);
```

### Inline Code

- Use backticks for inline code
- Use for: function names, variables, file paths, commands

```markdown
✅ Use the `search()` function
✅ Set `MAX_RETRIES` to 3
✅ Run `npm install`

❌ Use the search() function
❌ Set MAX_RETRIES to 3
❌ Run npm install
```

### Links

- Use descriptive link text
- Prefer relative links for internal docs
- Absolute links for external resources

```markdown
✅ See [Architecture Decisions](./decisions.md)
✅ Visit [Node.js website](https://nodejs.org)

❌ See the ADR here
❌ Go to https://nodejs.org
```

### Emphasis

- Use `**bold**` for emphasis
- Use `*italic*` for secondary emphasis
- Avoid `***bold italic***`
- Use `_` for variable placeholders

```markdown
✅ This is **important**
✅ This is *less important*
✅ Replace _YOUR_API_KEY_

❌ This is ***critical***
❌ Replace YOUR_API_KEY
```

### Emojis

- Use sparingly
- Only in user-facing documentation
- Not in API or architecture docs
- Consistent usage within a document

```markdown
✅ User guides: ✅ ❌ 🎯
❌ API docs: Use ✅ ❌
❌ Architecture docs: No emojis
```

### Horizontal Rules

- Use `---` for section breaks
- Three dashes minimum
- Blank line before and after

```markdown
✅ Text above

---

Text below

❌ Text above
---
Text below
```

### Blockquotes

- Use `>` for blockquotes
- Use for notes, warnings, callouts
- Single space after `>`

```markdown
✅ > **Note:** This is important information.

✅ > **Warning:** This could cause issues.

❌ >Note: No space after >
```

### Tables

- Use GitHub-flavored markdown tables
- Left-align text columns
- Right-align numeric columns
- Include header row

```markdown
✅ | Feature | Status | Priority |
   |---------|--------|----------|
   | Search  | ✅ Done | High     |
   | Export  | 📋 Plan | Medium   |
```

---

## Documentation Types

### 1. API Documentation

**Purpose:** Document public APIs for external consumers

**Location:** `docs/api/`

**Structure:**
```markdown
# [API Name]

## Overview
Brief description of the API

## Installation
How to install and configure

## Quick Start
Simple example usage

## API Reference
Detailed API documentation

### Methods/Functions
Each method with:
- Description
- Parameters
- Return type
- Exceptions
- Example

## Examples
Real-world usage examples

## Best Practices
Recommended usage patterns
```

### 2. User Guides

**Purpose:** Help users accomplish specific tasks

**Location:** `docs/guides/`

**Structure:**
```markdown
# [Guide Title]

## Overview
What this guide covers
Who should read it
Prerequisites

## Step-by-Step Instructions
Numbered steps with code examples

## Troubleshooting
Common issues and solutions

## Additional Resources
Links to related documentation
```

### 3. Architecture Documentation

**Purpose:** Document design decisions and system architecture

**Location:** `docs/architecture/`

**Structure:**
```markdown
# [Architecture Topic]

## Context
Problem or situation
Constraints
Current state

## Decision
What was decided and why

## Consequences
Positive impacts
Negative impacts

## Alternatives
Other options considered
Why they were rejected

## Related
Links to related ADRs or docs
```

### 4. Development Documentation

**Purpose:** Help contributors work on the project

**Location:** `docs/development/`

**Structure:**
```markdown
# [Development Topic]

## Overview
What this covers

## Setup
Prerequisites and installation

## Workflow
How to work with this component

## Standards
Coding or documentation standards

## Common Tasks
How to perform common operations
```

---

## Templates

### API Documentation Template

```markdown
# [API Name]

## Overview
[Brief description of what this API does]

## Installation
```bash
npm install @lincoln504/pi-research
```

## Quick Start
```typescript
import { [API] } from '@lincoln504/pi-research';

const instance = new [API]();
await instance.[method]();
```

## API Reference

### [ClassName]

#### Constructor
```typescript
constructor(options: [Options])
```
- **options:** Configuration options
  - `property1`: Description
  - `property2`: Description (optional, default: value)

#### [methodName]
```typescript
async [methodName](param1: Type1, param2: Type2): Promise<ReturnType>
```
Performs [action].

- **param1:** Description
- **param2:** Description (optional)
- **Returns:** Description of return value
- **Throws:** [ErrorType] - When condition

**Example:**
```typescript
const result = await instance.[methodName]('value');
console.log(result);
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| option1 | string | 'default' | Description |
| option2 | number | 42 | Description |

## Examples

### Basic Usage
```typescript
// Example code
```

### Advanced Usage
```typescript
// Example code
```

## Best Practices

1. **Tip 1:** Description
2. **Tip 2:** Description

## Related

- [Related API](./other-api.md)
- [Architecture](../architecture/overview.md)
```

### User Guide Template

```markdown
# [Guide Title]

## Overview
This guide explains how to [accomplish task].

## Prerequisites
- [ ] Prerequisite 1
- [ ] Prerequisite 2

## Step 1: [Step Title]

[Explanation]

```bash
# Code or command
```

## Step 2: [Step Title]

[Explanation]

```typescript
// Code example
```

[Continue for all steps...]

## Verification

To verify your setup:

```bash
# Verification command
```

Expected output:
```
Expected result
```

## Troubleshooting

### Issue: [Problem description]

**Symptom:** What you see
**Cause:** Why it happens
**Solution:** How to fix it

### Issue: [Another problem]

[Same structure...]

## Additional Resources

- [Related documentation](link)
- [External resource](link)
```

### ADR Template

```markdown
## ADR-XXX: [Decision Title]

**Status:** Proposed/Accepted/Deprecated/Superseded
**Date:** YYYY-MM-DD
**Context:**
- [Problem statement]
- [Constraints]
- [Current state]

**Decision:**
[Description of decision]

**Consequences:**

**Positive:**
- [Benefit 1]
- [Benefit 2]

**Negative:**
- [Drawback 1]
- [Drawback 2]

**Alternatives Considered:**
- [Alternative 1] (rejected: reason)
- [Alternative 2] (rejected: reason)

**Related:**
- [Link to related docs]
- [Phase or issue references]
```

---

## Review Process

### Before Submitting Documentation

1. **Self-Review:**
   - [ ] Follows markdown style guide
   - [ ] Uses appropriate template
   - [ ] All code examples tested
   - [ ] All links work
   - [ ] No typos or grammar errors

2. **Peer Review:**
   - Request review from maintainer
   - Address feedback
   - Update as needed

3. **Final Check:**
   - [ ] Documented in right location
   - [ ] Linked from related docs
   - [ ] Update table of contents if needed
   - [ ] Archive outdated docs

### Documentation Review Checklist

- [ ] Follows style guide
- [ ] Uses appropriate template
- [ ] Code examples work
- [ ] Links are valid
- [ ] No broken references
- [ ] Spelling and grammar correct
- [ ] In appropriate directory
- [ ] Linked from related docs
- [ ] Outdated docs archived

---

## Maintenance

### Regular Tasks

**Weekly:**
- Check for broken links
- Review recent changes for doc updates needed

**Monthly:**
- Archive temporary phase reports
- Update roadmap if needed
- Review and update outdated docs

**Per Release:**
- Update changelog
- Update version numbers in docs
- Review all docs for accuracy
- Update migration guides if needed

### Updating Documentation

When code changes:

1. **Identify affected docs:**
   - API changes → update API docs
   - Architecture changes → update architecture docs
   - New features → update guides

2. **Make updates:**
   - Update affected sections
   - Add new sections if needed
   - Remove outdated information

3. **Verify:**
   - All links work
   - Code examples still work
   - Consistency maintained

### Archiving Documentation

When to archive:
- Phase reports older than 3 months
- Temporary investigation reports
- Outdated planning documents
- Superseded design docs

How to archive:
1. Move to `docs/archive/`
2. Add index file with descriptions
3. Update cross-references
4. Document why it was archived

### Removing Documentation

When to remove (not archive):
- Duplicate documents
- Documents with no value
- Documents with incorrect information (that can't be fixed)

Process:
1. Get maintainer approval
2. Check for references
3. Remove or update references
4. Commit with clear message

---

## Tools

### Recommended Tools

- **Editor:** Any markdown-compatible editor
- **Linter:** markdownlint
- **Link Checker:** markdown-link-check
- **Spell Check:** cspell or editor built-in

### VS Code Extensions

- Markdown All in One
- markdownlint
- Code Spell Checker

---

**Last Updated:** 2026-05-23