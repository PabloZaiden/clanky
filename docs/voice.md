# Voice input, Live conversations and spoken playback

Clanky uses the configured OpenAI-compatible provider for audio transcription
and for generating concise spoken summaries. Text-to-speech runs locally on the
Clanky server with Piper.

## Provider settings

In user settings, configure the provider URL and API key, a transcription
model, and a text model. These are needed for voice input and summary playback;
full-response speech does not need a provider or a remote TTS model. Validate
the transcription and text capabilities after changing their settings.

The `languageHints` setting applies to provider-backed transcription. Piper
detects the speech text's language locally and does not use those hints.

The text model must support **Responses API**. Capability validation and spoken
summaries use `/v1/responses` (Azure: `/openai/v1/responses`), with the model or
deployment name in the request body. Clanky does not fall back to Chat
Completions. Transcription routing is unchanged.

## Live voice

Live voice is a separate option from **Talk** (record, transcribe, send) and
Piper read aloud. Open any chat with a native Codex or Copilot agent and select
**Message actions → Live voice**. The agent can already be working when you
start the call. Quick Chat uses the same chat and voice workflows; its agent
additionally receives the Clanky control tools. Enabling Live in another chat
does not grant those tools. ACP chats are not supported.

In **Settings → Voice → Live voice**, configure a base API URL, a Live
model/deployment and a delegated Responses model/deployment. Reuse the existing
voice provider URL and saved key, or configure an independent HTTPS endpoint and
encrypted key. A blank delegated model uses the ordinary text model. Both
models must be accessible from the **same Live endpoint**.

The endpoint must implement GPT-Live with WebRTC, authenticated sideband and
Responses delegation, not merely offer a compatible `/responses` route.
Compatible URL roots include `https://api.openai.com/v1` and an Azure OpenAI
resource with `/openai/v1`. There is no Azure-only model or workspace setting.
For Azure, use the deployment names; for example, `gpt-live-1` with `gpt-6-luna`.
Starting a call checks session and sideband access; function access is exercised
when the delegated model uses a tool.

The browser keeps the microphone open and plays Live audio automatically.
The compact panel shows listening/speaking, captions and the independent agent
status. **Mute** stops microphone input but keeps the call and spoken output
active. **End call** immediately releases the microphone, closes the Live
session and saves a separate conversation summary. Leaving the linked chat
also ends the call. Neither speaking over Live, muting nor ending the call
stops the workspace agent. Ask explicitly to stop the agent, or use its normal
interrupt control. Browser microphone permission, HTTPS (or localhost), network
access to the provider and audio playback permission are required.

Live delegates requests to the textual model, which has only linked-chat
functions: send/queue, steer an existing queued instruction, get status, answer
a question and explicitly interrupt work. Repository execution and Clanky
tools remain with the existing workspace agent. Permission approvals remain in
the chat UI. Accepted or queued input is not proof of completed work. Clanky
feeds authoritative state and confirmed results back to Live while the normal
chat continues updating.

### Privacy, limits and recovery

Clanky creates the session and attaches its server-owned sideband using the
private configured key. It returns only the WebRTC SDP answer and an owned
Clanky call ID, not the provider key or a reusable provider token. Browser audio
travels **directly to the provider** over WebRTC; the server observes captions
and executes functions through sideband. The provider sees microphone audio
while input is unmuted and the client's network connection. Audio, delegated
reasoning and call summarization can incur provider charges.

Clanky stores agent instructions/results as usual and a separate voice-call
summary, not recordings or a full voice transcript. Live captions are partial
fragments, not authoritative completed turns. Summary generation uses bounded
fragments and confirmed chat state; a missing transcript, failed summary or
unconfirmed provider close is reported explicitly. Earlier fragments may be
discarded in a long call and the summary identifies that limitation.

There is one active call per user/chat, a server capacity of eight calls and a
limit of ten session openings per minute per endpoint/key. Provider `429`
responses establish a cooldown and expose `Retry-After`; the browser does not
automatically retry. Start a new call after a connection failure, checking the
chat first if an instruction's outcome is unclear. A browser lease allows the
server to close abandoned calls without cancelling agent work.

### Public call endpoints

`POST /api/chats/:id/live-voice` accepts `{ "sdp": "...", "clientId": "UUID" }`
and returns `201` with `{ "call": { "id", "status", "error", "summarySaved" },
"sdp": "..." }`. The server attaches sideband before returning the SDP answer.
Use `POST /api/chats/:id/live-voice/:callId/heartbeat` to renew the call lease
and read its state, and `POST /api/chats/:id/live-voice/:callId/close` to finalize
the call and persist the summary. These routes require an authenticated user
and the normal same-origin mutation policy. Calls and functions are bound to
the user's linked chat; provider session IDs are not accepted as authority.

### Validation scope

The compiled-app journeys exercise both URL roots with an external deterministic
Live peer, including parallel/duplicate functions, native steering and questions,
closing without interrupting the agent, provider cuts and summary persistence.
Azure `gpt-live-1` with `gpt-6-luna` was also exercised through Bun.WebView with
synthesized microphone input: bidirectional audio, native Clanky tool execution,
spoken confirmed results, mute and graceful close. Desktop and mobile-width
screenshots cover the panel and settings. Physical microphone/speaker quality,
mobile operating-system suspension and a live OpenAI-hosted call still require
device/provider-specific validation.

## Local Piper speech

Piper selects `es_AR-daniela-high` for Spanish and `en_US-ljspeech-medium` for
English. Language detection runs locally with a lightweight language detector;
short or ambiguous text falls back to Spanish. Markdown code and links are
excluded from detection when possible. No LLM request is made to select a
voice.

On the first spoken response, Clanky downloads the Piper runtime and the
selected voice model and configuration. The other voice is downloaded only
when first selected. Downloads use pinned upstream versions and SHA-256
verification, then are installed atomically under:

```text
$CLANKY_DATA_DIR/piper/
```

The Spanish voice model is about 114 MB, the English model about 64 MB, and
the runtime about 26 MB.

When `CLANKY_DATA_DIR` is unset, this is inside Clanky's default application
data directory. The selected runtime and voice remain there across restarts.
The first use needs outbound access to GitHub Releases and Hugging Face; later
speech synthesis uses the cached files.

Supported server targets are Linux x64/arm64, macOS x64/arm64, and Windows
x64. `/api/voice/settings` reports this platform support as `piper.available`;
it does not indicate whether the runtime or models have already been
downloaded.

## API behavior

`POST /api/voice/speech` accepts JSON such as:

```json
{
  "text": "The change is ready to review.",
  "mode": "full"
}
```

`mode` can be `full` or `summary` and defaults to `full`. The endpoint returns
`audio/wav`. Full mode synthesizes the supplied text locally without calling
the provider. Summary mode first uses the configured text model to summarize
the supplied text, then speaks that summary locally. The
`/api/voice/transcribe` endpoint continues to use the configured transcription
provider.

## Upstream voice assets

- [Piper runtime release](https://github.com/rhasspy/piper/releases/tag/2023.11.14-2)
- [Argentinian Spanish voice files](https://huggingface.co/rhasspy/piper-voices/tree/c10ece1aade47bb51c153c893d14e5bf8e5b7117/es/es_AR/daniela/high)
- [US English voice files](https://huggingface.co/rhasspy/piper-voices/tree/c10ece1aade47bb51c153c893d14e5bf8e5b7117/en/en_US/ljspeech/medium)

The Spanish voice model card identifies its license as CC BY-SA 4.0. The
LJSpeech card states that its training dataset is public domain. Review the
upstream model cards and runtime notices for their full attribution and
redistribution terms.
