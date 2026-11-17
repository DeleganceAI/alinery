// The custom endpoint editor's text. The daemon's tests check both against its parser: the reference must read with no
// warning once its key is filled in, and the starter's only error is the key placeholder.

/** Every field Alinery reads, in the shape of an OMP `models.yml` provider block. */
export const CUSTOM_ENDPOINT_REFERENCE = `# The provider id: lowercase letters, digits and dashes. Its models show as <id>/<model id>.
deepinfra:
  name: DeepInfra                    # optional display name
  baseUrl: https://api.deepinfra.com/v1/openai   # the API root, usually ending in /v1
  api: openai-completions            # or openai-responses
  apiKey: <your key>                 # sent as a Bearer token; leave out for a local server
  authHeader: true                   # accepted from OMP; OpenAI APIs always send the key this way
  headers:                           # optional, sent with every request
    X-Title: Alinery
  compat:                            # optional request quirks for every model
    maxTokensField: max_tokens       # or max_completion_tokens
    supportsDeveloperRole: false     # send the system prompt as "system", not "developer"
    supportsUsageInStreaming: true
  models:
    - id: deepseek-ai/DeepSeek-V4-Pro-0813   # exactly as the endpoint names it
      name: DeepSeek V4 Pro          # optional display name
      contextWindow: 1000000         # tokens the model reads; default 128000
      maxTokens: 32000               # tokens it may write per reply; default 8192
      reasoning: true                # thinks before answering, so it gets thinking levels
      input: [text, image]           # default [text]
      supportsTools: true            # cannot be false: the agent works through tool calls
      cost:                          # optional, dollars per million tokens
        input: 0.5
        output: 2
        cacheRead: 0.1
        cacheWrite: 0
      compat:                        # optional, overrides the provider's compat for this model
        thinkingFormat: deepseek
    - id: zai-org/GLM-5.3
      contextWindow: 1000000
      maxTokens: 32000
      reasoning: true
`;

/** What a new endpoint starts from: the fields most endpoints need. */
export const CUSTOM_ENDPOINT_STARTER = `my-endpoint:
  baseUrl: https://api.example.com/v1
  apiKey: <your key>
  compat:
    maxTokensField: max_tokens
  models:
    - id: org/model-name
      contextWindow: 128000
      maxTokens: 8192
      reasoning: false               # true if the model thinks: turns on its thinking levels
`;

/**
 * What Copy agent instructions puts on the clipboard: everything an outside AI needs to write the user's own block for this
 * editor. A daemon test holds its compat list to pi's schema, so a compat key pi adds or drops fails there.
 */
export const CUSTOM_ENDPOINT_AGENT_INSTRUCTIONS = `# Write a custom endpoint config for Alinery

I want to add an OpenAI-compatible model endpoint to Alinery, a desktop app that runs coding agents. Help me write the config I paste into its "Add an OpenAI-compatible endpoint" editor. The endpoint I want to add is: <name the provider, or paste its docs link or its model list here>.

Alinery runs its agents on pi (the pi-ai library). The config is one provider block, the same shape as a provider in an oh-my-pi \`models.yml\` or a pi \`models.json\`. The editor reads YAML or JSON; write YAML.

## What to give me

1. One YAML block: the provider id at the top, its fields indented under it. Nothing else in the block.
2. Leave the key as \`apiKey: <your key>\`. Do not ask me for the key: I paste it into the editor myself.
3. Under the block, a short list of every value you could not confirm from the provider's own docs or API, so I know what to check.

## How to find the values

- **baseUrl**: the API root the provider documents for OpenAI-compatible requests, usually ending in \`/v1\` (for example \`https://api.deepinfra.com/v1/openai\`). Never the full request path: pi appends \`/chat/completions\` or \`/responses\` itself.
- **Model ids**: exactly as the endpoint names them, slashes included (\`deepseek-ai/DeepSeek-V4-Pro-0813\`). \`GET <baseUrl>/models\` with the key lists them on most providers.
- **contextWindow and maxTokens**: from the provider's model page, per model. maxTokens is the most the model may write in one reply, not its context.
- **input**: \`[text, image]\` only if the provider says the model accepts images through this API.
- **reasoning**: \`true\` if the model thinks before answering (a reasoning or thinking model). Without it Alinery offers no thinking levels for the model. Then work out the thinking format (see below).
- **compat**: only the quirks this endpoint actually has. pi detects most of them from well-known provider URLs, so an unfamiliar URL is where they matter.

## Provider fields

- \`name\` (optional): display name.
- \`baseUrl\` (required): http or https, no credentials in the URL.
- \`api\` (optional): \`openai-completions\` (the default, Chat Completions) or \`openai-responses\` (the Responses API). Use responses only if the provider documents \`/v1/responses\`.
- \`apiKey\`: sent as \`Authorization: Bearer <key>\`. Leave it out only for a local server that needs no key. It is the key itself, never an environment variable name.
- \`authHeader\` (optional): accepted from oh-my-pi and has no effect; the key always goes in the Authorization header.
- \`headers\` (optional): extra headers sent with every request, as a map of text values.
- \`compat\` (optional): request quirks for every model of this provider. A model's own \`compat\` overrides it key by key.
- \`models\` (required): 1 to 50 models. A plain id (\`- some/model\`) is allowed but then every default applies, so prefer the full form.

The provider id is a short name: lowercase letters, digits and dashes, starting with a letter, at most 32 characters. It cannot be a provider pi already has built in (\`openai\`, \`anthropic\`, \`deepseek\`, \`together\`, \`openrouter\`, \`zai\` and so on): pick a name like \`my-deepinfra\`. Models show in Alinery as \`<provider id>/<model id>\`.

## Model fields

- \`id\` (required): no spaces, not listed twice.
- \`name\` (optional): display name.
- \`contextWindow\`: whole number of tokens. Default 128000.
- \`maxTokens\`: whole number of tokens, no larger than contextWindow. Default 8192.
- \`reasoning\`: \`true\` or \`false\`. Set it either way; the editor warns when it is missing.
- \`input\`: \`[text]\` (default) or \`[text, image]\`.
- \`supportsTools\`: may be \`true\` or left out. It cannot be \`false\`: Alinery's agent works through tool calls, so a model without tool calling cannot run it. Leave such a model out.
- \`cost\` (optional): dollars per million tokens, all four of \`input\`, \`output\`, \`cacheRead\`, \`cacheWrite\` as numbers.
- \`headers\` (optional): extra headers for this model's requests.
- \`compat\` (optional): overrides the provider's compat for this model.

Alinery does not read \`thinkingLevelMap\` or any field not listed here; the editor warns that it ignores them.

## Thinking (reasoning models)

Set \`reasoning: true\` on the model, then tell pi how this endpoint takes the thinking setting with \`compat.thinkingFormat\`. With no thinkingFormat, pi guesses from the URL, which works for the providers it knows and usually not for others.

- Start with \`thinkingFormat: openai\` (sends \`reasoning_effort\`) and \`supportsReasoningEffort: true\` if the provider documents \`reasoning_effort\`.
- If the endpoint refuses that, match the model family or the server:
  - DeepSeek models: \`deepseek\` (\`thinking.type\`, plus \`reasoning_effort\` when supported). DeepSeek-style endpoints may also need \`requiresReasoningContentOnAssistantMessages: true\`.
  - GLM / Z.ai models: \`zai\` (\`thinking.type\`).
  - Qwen models: \`qwen\` (top-level \`enable_thinking\`) or \`qwen-chat-template\`.
  - A self-hosted vLLM or SGLang server: \`chat-template\` with \`chatTemplateKwargs\`, using \`$var\` for pi's values, for example \`chatTemplateKwargs: { enable_thinking: { $var: thinking.enabled } }\`.
  - Behind OpenRouter: \`openrouter\`. Behind Together: \`together\`.
- If the reply comes back with the thinking inside the answer text, try \`requiresThinkingAsText: true\`.

## Every compat key

For \`api: openai-completions\`. Leave a key out unless the endpoint needs it.

- supportsStore (true/false): whether the endpoint accepts the \`store\` field.
- supportsDeveloperRole (true/false): \`false\` sends the system prompt as role \`system\` instead of \`developer\`. Most non-OpenAI endpoints need \`false\`.
- supportsReasoningEffort (true/false): whether the endpoint accepts \`reasoning_effort\`.
- supportsUsageInStreaming (true/false): whether it accepts \`stream_options.include_usage\` for token counts while streaming.
- supportsFinishReason (true/false): \`false\` when streamed replies carry no \`finish_reason\`; pi then infers it.
- maxTokensField (\`max_tokens\` or \`max_completion_tokens\`): which field carries the reply limit. Most non-OpenAI endpoints want \`max_tokens\`.
- requiresToolResultName (true/false): tool results must carry the tool's \`name\`.
- requiresAssistantAfterToolResult (true/false): a user message after tool results needs an assistant message between them.
- requiresThinkingAsText (true/false): send earlier thinking back as text in \`<thinking>\` tags.
- requiresReasoningContentOnAssistantMessages (true/false): every replayed assistant message needs an empty \`reasoning_content\` when thinking is on.
- thinkingFormat (\`openai\`, \`openrouter\`, \`deepseek\`, \`together\`, \`baseten\`, \`zai\`, \`qwen\`, \`chat-template\`, \`qwen-chat-template\`, \`string-thinking\`, \`ant-ling\`): how the thinking setting is sent (see Thinking).
- chatTemplateKwargs (map): sent as \`chat_template_kwargs\` with thinkingFormat \`chat-template\`. A value may be \`{ $var: thinking.enabled }\`, \`thinking.effort\` or \`thinking.budget\`.
- chatTemplateArgs (map): sent as \`chat_template_args\` with thinkingFormat \`baseten\`, with the same \`$var\` values.
- thinkingTokenBudgetField (\`thinking_token_budget\`, \`thinking_budget\` or \`thinking_budget_tokens\`): the top-level field that caps thinking tokens: vLLM, Qwen/DashScope/SGLang, or llama.cpp.
- supportsThinkingTokenBudget (true/false): older spelling of \`thinkingTokenBudgetField: thinking_token_budget\`.
- openRouterRouting (map): OpenRouter's \`provider\` routing preferences (order, only, ignore, sort, and so on).
- vercelGatewayRouting (map): Vercel AI Gateway routing (\`only\`, \`order\`).
- zaiToolStream (true/false): the endpoint accepts Z.ai's top-level \`tool_stream\`.
- supportsOpenAIGrammarTools (true/false): accepts OpenAI custom tools with grammar formats; otherwise plain function tools are sent.
- supportsMidConvoSystemMessages (true/false): accepts system messages after the conversation started; otherwise they are folded into the first one.
- supportsMidConvoToolAdditions (true/false): system messages may add tools mid-conversation (needs the key above).
- supportsStrictMode (true/false): accepts \`strict\` in tool definitions.
- cacheControlFormat (\`anthropic\`): mark prompt-cache points the Anthropic way.
- sendSessionAffinityHeaders (true/false): send session-affinity headers.
- sessionAffinityFormat (\`openai\`, \`openai-nosession\` or \`openrouter\`): which session-affinity headers.
- supportsLongCacheRetention (true/false): accepts long prompt-cache retention.
- vllmPriority (number): vLLM scheduler priority; only with \`--scheduling-policy priority\`.

For \`api: openai-responses\`, only these apply: supportsDeveloperRole, supportsMidConvoSystemMessages, sessionAffinityFormat, supportsLongCacheRetention, supportsStrictMode, supportsOpenAIGrammarTools, and:

- supportsAdditionalTools (true/false): accepts message-anchored \`additional_tools\` items.
- supportsToolSearch (true/false): supports client-run tool search.
- supportsExplicitPromptCacheMode (true/false): accepts \`prompt_cache_options\`.
- supportsMidConvoEffort (true/false): a thinking-level change is sent as a \`configuration_update\` item.
- supportsMaxOutputTokens (true/false): \`false\` when the endpoint refuses \`max_output_tokens\`.

## How the editor checks it

As I type, the editor names each problem by field; errors block saving. "Test and save" then sends each model one short request with one tool declared and shows the endpoint's own error for a model that fails. Common failures and the fix:

- 401 or 403: the key, or a header the provider requires.
- 404 or "model not found": the model id, or a baseUrl missing a path segment such as \`/openai\`.
- 400 naming \`max_completion_tokens\`: \`maxTokensField: max_tokens\`.
- 400 naming the \`developer\` role: \`supportsDeveloperRole: false\`.
- 400 naming \`stream_options\`: \`supportsUsageInStreaming: false\`.
- 400 naming \`store\`: \`supportsStore: false\`.
- 400 naming \`tools\` or tool calling: the model cannot call tools and cannot run Alinery's agent.
- An error about \`reasoning_effort\`, \`thinking\` or \`enable_thinking\` once in a session: another thinkingFormat, or \`supportsReasoningEffort: false\`.

## A complete example, with every field

\`\`\`yaml
${CUSTOM_ENDPOINT_REFERENCE}\`\`\`

A minimal block for a provider with one non-thinking model:

\`\`\`yaml
${CUSTOM_ENDPOINT_STARTER}\`\`\`
`;
