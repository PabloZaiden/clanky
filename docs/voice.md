# Voice input and spoken playback

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
