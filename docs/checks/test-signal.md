# Check: test signal

What the test-signal check looks for in a diff. Follow it when you write tests too. The reasons are in [ADR 0005](../adr/0005-verification-over-manual-testing.md): tests are our proof that a change works, and flaky tests are bugs.

**This check asks only for fewer or better tests, never for more coverage.** A test that can't fail, or fails at random, is worse than no test.

## Flag

1. **Sleeps and fixed waits.** `setTimeout` or `sleep` in a test, `page.waitForTimeout`, a loop that waits a fixed time. Wait for the condition instead: Playwright's auto-waiting assertions, `expect.poll`, or fake timers.
2. **Retries that hide flakiness.** `retries` in a config, `test.retry`, `{ retry: n }`, or a retry loop around a test step. Fix the cause or delete the test.
3. **Timeouts raised to make a test pass.** A larger `timeout` or `testTimeout` without a stated reason.
4. **Tests that can't fail.** No assertion, an assertion on a mock the test just set up, `expect(true)`, a try/catch that swallows the failure, or a snapshot of a whole response where one field matters.
5. **Mocks where the rules want the real thing.** A mocked database in an integration test (we test against real Postgres in a throwaway container), or mocking the very code under test.
6. **Skipped or focused tests committed.** `.skip`, `.only`, `.todo`, `test.fixme`.
7. **Duplicates.** Two tests that prove the same thing. Suggest which one to delete.
8. **Testing how instead of what.** Asserting call counts or private internals where the behaviour could be asserted.
9. **Hidden dependencies.** Tests that depend on order, shared mutable state, the wall clock, unseeded randomness, or a real network service. AI evals in CI use the mock model.
10. **Real data in fixtures.** Real customer data, real email addresses or real secrets. Fixtures are synthetic.

## Don't flag

- Missing tests or coverage. Never ask for an extra test.
- Code outside tests, naming, or style.
