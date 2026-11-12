# Token-count fixtures

`token-counts.json` records synthetic English, Chinese, Japanese, emoji and code text
measured with OpenAI tiktoken 0.12.0, using `encode_ordinary` and the
`cl100k_base` and `o200k_base` vocabularies. These are text token counts, not
provider chat framing or billing measurements. The schema test separately
captures the schema passed to the SDK model and checks its reservation.

Regenerate from the repository root in an isolated Python environment:

```sh
python -m venv .helpos/tokenizer
# Windows uses .helpos/tokenizer/Scripts/python below.
.helpos/tokenizer/bin/python -m pip install tiktoken==0.12.0
.helpos/tokenizer/bin/python packages/ai/src/fixtures/generate-token-counts.py
pnpm exec biome format --write packages/ai/src/fixtures/token-counts.json
```

Source: https://github.com/openai/tiktoken/tree/0.12.0 (MIT).
The generator is optional tooling; no tokenizer dependency is shipped or needed
by CI. Both encodings are regression samples, not a proof for every provider or
self-hosted tokenizer.
