# Chat Completions API

Creates a model response for the given chat conversation.

## Request body

`messages` (array, required): a list of messages comprising the conversation so far.

```json
{
  "model": "gpt-4.1",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "What's the weather in Paris?"}
  ],
  "tools": [{"type": "function", "function": {"name": "get_weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}}}]
}
```

## Response

When the model decides to call a function, the assistant message contains `tool_calls`:

```json
{"role": "assistant", "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\": \"Paris\"}"}}]}
```

Send the function result back with `{"role": "tool", "tool_call_id": "call_1", "content": "18°C, cloudy"}` and call the API again.

## Developer messages

For reasoning models, use `{"role": "developer"}` instead of `system`. Developer messages take priority over user messages.
