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
      reasoning: true                # thinks before answering; default false
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
`;
