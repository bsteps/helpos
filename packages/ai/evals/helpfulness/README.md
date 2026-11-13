# Reply-helpfulness eval

Measures how helpful `draftReply()` drafts are, so prompts and models can be compared. The safety evals next door (`../*.json`) check that a reply is safe; this one checks that it's useful.

- `cases.json`: 80 support emails. Inline cases use a knowledge set from `knowledge.json`; cases with `from` reuse the input of an eval next door. Each case lists the points a helpful draft covers.
- `flow.mjs`: runs the real `draftReply()` (no tools, as in production) and grades each draft against its points plus four checks: answers every question, no invented facts, no leaks or obeyed planted instructions, finished tone. A draft is helpful only if everything passes.
- `sub-judges.mjs`: two judges from different companies, Claude Opus (`claude` CLI) and GPT Sol (`codex` CLI), both on their subscriptions with no API spend. Both must pass a draft. `EVAL_JUDGE=api` uses one judge over the API instead (`EVAL_JUDGE_PROVIDER`, `EVAL_JUDGE_MODEL`, `EVAL_JUDGE_API_KEY`).
- `run-eval.mjs`: the runner. It writes results, traces and cost per variant under `--flow` (default `.claude/hillclimb/reply-helpfulness`, ignored by git).

Run from the repo root (drafting uses `AI_PROVIDER`, `AI_MODEL` and `AI_API_KEY`):

```bash
node --env-file=.env packages/ai/evals/helpfulness/run-eval.mjs --variant baseline --reps 2 --approve-harness
node --env-file=.env packages/ai/evals/helpfulness/run-eval.mjs --variant v1 --model claude-sonnet-5-5 --reps 2
```

`--approve-harness` records a hash of the runner, judges and cases; later runs refuse if any of them changed, so results stay comparable. Pass it again after you review a change to them. `--cases id,id` runs a subset.

For prompt tuning, list `train_ids` and `test_ids` in the flow's `_state.json`, read failures from the train split only, and judge changes on the test split. With 45 test cases at 2 runs each, differences under about 8 points are noise.
