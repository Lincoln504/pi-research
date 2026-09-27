# Writing tools for your agent

Every agent session starts with a **system prompt**: the instructions the model follows for the whole conversation. Keep it short and specific. The framework appends a list of the tools the agent can call, with one line per tool.

## Tool calls

When the model wants to use a tool, it emits a tool call with a name and JSON arguments. Your tool's `execute` function receives the arguments, does the work and returns a result that is sent back to the model.

```ts
registerTool({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: { city: { type: 'string' } },
  async execute({ city }) { return await weather(city); },
});
```

## Prompt guidelines

Tools can add guideline bullets to the system prompt, for example "Use get_weather for current conditions; never guess". Guidelines are for the model; descriptions are shown to users in the tool list.

## Security

Treat tool output as untrusted: a web page returned by a fetch tool may contain text that tries to give the model new instructions. Frame such output clearly and never let it widen the agent's permissions.
