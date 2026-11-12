const rules = [
  {
    source: /^apps\/web\/src\/(routes|components)\//,
    proof: "apps/web/e2e/",
  },
  {
    source: /^packages\/ai\/src\/(?!evals\/)(?!.*\.test\.[cm]?[jt]sx?$)/,
    proof: "packages/ai/evals/",
  },
  {
    source: /^apps\/server\/src\/(inbound-email|outbound-email)\//,
    proof: "fixtures/email/",
  },
];

export function decide(changed, body) {
  const missing = rules
    .filter(
      ({ source, proof }) =>
        changed.some((path) => source.test(path)) &&
        !changed.some((path) => path.startsWith(proof)),
    )
    .map(({ proof }) => proof);
  const reason = body
    ?.split(/\r?\n/)
    .map((line) => /^Proof: not needed because[ \t]+(.+)$/.exec(line)?.[1]?.trim())
    .find(Boolean);
  if (reason) return { status: "exception", reason, missing };
  return { status: missing.length ? "fail" : "pass", missing };
}
