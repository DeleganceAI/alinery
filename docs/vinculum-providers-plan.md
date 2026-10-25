# Vinculum providers

Status: implemented. API-key login, OAuth and multi-field login, and custom OpenAI-compatible endpoints are on the Vinculum socket (`PROTOCOL_VERSION` 19). Alinery hosted models stay the `alinery` provider. This note is not a product contract.

This is a working note, not a product contract. `README.md` is human-edited and is not the place for it.

## What each side actually supports

OMP v18.1.13 (`can1357/oh-my-pi`, `docs/providers.md`) was the previous harness. Vinculum talks to `@earendil-works/pi-ai` 1.3.0, the same generation of Pi that pi-durable uses. They are not the same catalog.

OMP assembled a catalog from its bundled providers, `models.yml`, live discovery (Ollama, llama.cpp, LM Studio), and extensions. A model was selectable only when the provider was not disabled and was either keyless or had a credential. Credentials lived in `~/.omp/agent/agent.db` (relocated by `PI_CODING_AGENT_DIR`). Login was `/login` inside the OMP process.

Pi 1.3.0 has these built-in provider ids, from `packages/ai/src/providers/` at tag `v1.3.0`:

`amazon-bedrock`, `anthropic`, `ant-ling`, `azure`, `baseten`, `cerebras`, `cloudflare-ai-gateway`, `cloudflare-workers-ai`, `deepseek`, `fireworks`, `github-copilot`, `google`, `google-vertex`, `groq`, `huggingface`, `kimi-coding`, `meta`, `minimax`, `minimax-cn`, `mistral`, `moonshotai`, `moonshotai-cn`, `nvidia`, `openai`, `openai-codex`, `opencode`, `opencode-go`, `openrouter`, `qwen-token-plan`, `qwen-token-plan-cn`, `qwen-token-plan-individual`, `radius`, `together`, `typesafe`, `vercel-ai-gateway`, `xai`, `xiaomi`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`, `zai`, `zai-coding-cn`.

Most of those resolve one environment variable through `envApiKeyAuth`, which also has a login that asks for that one secret. These also have an OAuth login on the same provider id: `anthropic`, `openai` (ChatGPT subscription), `openai-codex` (OAuth only), `openrouter`, `xai` (SuperGrok / X Premium), `github-copilot`, `kimi-coding`, `meta`, `radius`. `amazon-bedrock` and `google-vertex` have their own multi-step login (token, profile, ADC, service-account file). Cloudflare and Azure need more than one value (account id, gateway id, or a base URL).

OMP had, and Pi 1.3.0 does not: `ollama`, `llama.cpp`, `lm-studio`, and `vllm` as auto-discovered engines; `cursor`, `xai-oauth` as its own id, `google-gemini-cli`, `google-antigravity`, `gitlab-duo`, `cline-pass`, `kilo`, `litellm`, `venice`, `novita`, `nanogpt`, `qianfan`, `qwen-portal`, `synthetic`, `sakana`, `coreweave`, `siliconflow`, `deepinfra`, `devin`, `gmi-cloud`, `wafer-serverless`, `yolo-auto`, `umans`, `aimlapi`, `alibaba-token-plan`, `alibaba-coding-plan`, `zhipu-coding-plan`, `zenmux`, `bedrock-mantle`, `ollama-cloud`, `aiand`, `firepass`. Do not port those. A later custom OpenAI-compatible endpoint covers a local server or a missing gateway. It is not a promise to recreate OMP's catalog.

## What Vinculum does now

`installAlineryProvider` registers one provider, `alinery`. Hosted catalog rows come from `inference.json`. Grok rows are copied off `xaiProvider()` and relabeled `alinery`. `openSession` / `ensureModel` always configure `{ provider: "alinery", modelId }` after stripping an `alinery/` or `xai/` prefix. The UI adds `xai/grok-4.3` through `xai/grok-4.7` only when Settings has a Grok key. That key is `experiments.grok_api_key`, injected as `XAI_API_KEY` when the daemon is spawned. No other provider key is injected. The daemon does not inherit the shell, which is the same rule `OMP_ENV_ALLOWLIST` existed for.

The Accounts tab still renders `ChatModelDialog`, but `ProviderSetupDialog` no longer opens a session, and `SessionView.startChatLogin` returns immediately for Vinculum. Sign-in on a provider row says there is no OMP login session.

## How sign-in used to work

Alinery did not implement provider OAuth. It spawned OMP under an isolated `PI_CODING_AGENT_DIR` and talked RPC:

- `get_login_providers` filled the Accounts list (`id`, `name`, `available`, `authenticated`).
- `get_available_models` filled the Models tab. OMP also cached a catalog for providers with no credential, so the UI treated "has models" as auth only when the provider had no login row.
- `login` with a `providerId` started OMP's flow. OMP then pushed extension UI: `open_url`, `select`, `confirm`, `input`, `editor`. The app opened the first browser URL itself and rendered the rest in the dialog.
- Providers whose login needed a prompt before any URL (`baseten`, `coreweave`, `sakana`, `cloudflare-ai-gateway`) were sent to Advanced, and Advanced offered to switch the session to Terminal and type `/login`.

Chat was not allowed to collect an API key. The key was typed into OMP. The Grok field in Settings is a separate, later path and the only key Vinculum reads.

The hosted Alinery account is not one of these rows. It stays the account chip, `inference.json`, and the `alinery` provider.

## What to reuse

Keep the dialog. `ChatModelDialog`, the Accounts / Models tabs, favorites, hosted account row, cost bands, and model roles already match the job. `needsProviderSetup` and `shouldOfferProviderSetup` stay the decision for the unprompted offer. `partitionProviders` stays, with the RPC-incompatible set removed once those ids are either normal API-key rows or explicitly unsupported.

Keep the hosted provider as `alinery`. Do not register Pi's built-ins under that id.

Keep one credential file for this app config, owner-only, not the user's shell and not `~/.omp`. Pi's `CredentialStore` is the interface (`read`, `list`, `modify`, `delete`, one credential per provider, refresh inside `modify`). Put it beside the app config under a new name. Do not write it into the account `auth.json`. Do not read OMP's `agent.db` or `models.yml`. The formats are not the same, and a second process still owns that directory.

Keep the Grok setting working. `XAI_API_KEY` on the daemon is the env fallback Pi's `xai` provider already resolves. A stored `xai` credential wins over it, so a later sign-in replaces the setting without a migration. Do not add a Settings field per provider.

Keep shell isolation. The daemon's `AuthContext.env` may see `XAI_API_KEY` that the app injected. It must not see `ANTHROPIC_API_KEY` and the rest from the launching shell.

## What has to change

Register Pi's built-ins on the same `Models` collection as `alinery`, with that credential store. `builtinModels({ credentials, authContext })` is the right call in this daemon. The bundle-size warning in Pi's README is about browser apps. Then `setProvider` replaces nothing: `alinery` is an extra id.

A session model is `provider/modelId` again. `ensureModel` passes both. `resolveModelId` stops deleting the provider. An existing meta that says `alinery/grok-4.*` still resolves as `xai` for that id. Do not rewrite those files.

The model list for the picker is `getAvailable()`, not the full static catalog. Pi keeps models for a provider that has no credential, which is the same trap OMP's `models.db` was. The Accounts list is the built-in providers that have a login, with `authenticated` from `list()` plus `checkAuth()`. That replaces `get_login_providers`. Nothing here is an OMP RPC command.

Login does not go back through `login` / extension UI / Terminal `/login`. Pi's `Models.login(providerId, type, interaction)` is the flow. The socket is request/response, so the first slice does not grow a prompt stream.

## Slices

**1. API keys.** One new socket op. The dialog asks for the secret and sends it. The daemon stores `{ type: "api_key", key }` through the credential store. That is enough for every provider whose login is `envApiKeyAuth`: `anthropic`, `openai`, `google`, `groq`, `mistral`, `xai`, `openrouter`, `deepseek`, `cerebras`, `together`, `fireworks`, `nvidia`, `huggingface`, `moonshotai`, `moonshotai-cn`, `minimax`, `minimax-cn`, `baseten`, `opencode`, `opencode-go`, `vercel-ai-gateway`, `qwen-token-plan`, `qwen-token-plan-cn`, `qwen-token-plan-individual`, `xiaomi`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`, `zai`, `zai-coding-cn`, `ant-ling`, `typesafe`, `radius`, `kimi-coding`, `meta`, `github-copilot` (a pasted token, not the browser flow). Logout is one op and `delete`. The copy "Chat never collects API keys" becomes "the key is entered here and stored for this app, not in the transcript." `ProviderSetupDialog.startLogin` and `SessionView.startChatLogin` call this op instead of refusing. This is a reply-format and op-set change, so bump `PROTOCOL_VERSION`.

**2. OAuth and multi-field login.** Same `Models.login`, now with `AuthInteraction`. `prompt` is `text`, `secret`, `select`, or `manual_code`. `notify` carries `auth_url`, `device_code`, `info`, and `progress`. Run the login off the socket read loop. The UI polls one status op and posts the answer back. Map `auth_url` through the opener that already exists. This covers subscription sign-in for `anthropic`, `openai`, `openai-codex`, `openrouter`, `xai`, `github-copilot`, `kimi-coding`, `meta`, and `radius`, plus `amazon-bedrock`, `google-vertex`, `azure` (key plus base URL), and both Cloudflare providers. Do not offer Terminal `/login`. There is no OMP process behind that PTY.

**3. Custom endpoints, only if asked.** One file of OpenAI-compatible providers (`baseUrl`, `api`, `apiKey` or `auth: none`), registered with `createProvider`. That is how Ollama, LM Studio, vLLM, and a gateway Pi does not ship get back. No live discovery, no `models.yml` import, no extension registry.

## Not in this work

No OMP binary, no `get_login_providers`, no extension-UI login, no read of `agent.db`. No second naming of the harness. No change to hosted account sign-in. Image and classifier models stay out of the picker. Providers Pi does not ship stay absent until slice 3, and only as an explicit custom endpoint.
