import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const moduleUrl = new URL("./processes.mjs", import.meta.url).href;
function run(setup, action) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    ${setup}
    syncBuiltinESMExports();
    const processes = await import(${JSON.stringify(moduleUrl)});
    ${action}
  `,
    ],
    { encoding: "utf8" },
  );
}
for (const body of ['"broken"', '"{}"']) {
  test(`process identification refuses invalid package metadata: ${body}`, () => {
    const result = run(`fs.readFileSync = () => ${body};`, "");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SyntaxError|must define scripts.dev/);
  });
}
test("process identification reports an unreadable package", () => {
  const result = run(
    "fs.readFileSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };",
    "",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EACCES/);
});
test("malformed Windows process output fails instead of claiming no processes", () => {
  const result = run(
    `Object.defineProperty(process, 'platform', { value: 'win32' });
    childProcess.execFileSync = () => 'invalid json';`,
    "processes.commandOf(123);",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SyntaxError/);
});
test("Windows process output accepts a single object and an empty list", () => {
  const result = run(
    `Object.defineProperty(process, 'platform', { value: 'win32' });
    let output = JSON.stringify({ ProcessId: 123, ParentProcessId: 1, CommandLine: 'node server' });
    childProcess.execFileSync = () => output;`,
    `
    assert.equal(processes.commandOf(123), 'node server');
    output = '[]'; processes.refreshProcesses();
    assert.equal(processes.commandOf(123), undefined);`,
  );
  assert.equal(result.status, 0, result.stderr);
});
for (const code of ["ESRCH", "EPERM"]) {
  test(`Unix cleanup continues to children after ${code}`, () => {
    const result = run(
      `Object.defineProperty(process, 'platform', { value: 'linux' });
      childProcess.execFileSync = () => '100 1 parent\\n101 100 child\\n';
      const killed = [];
      process.kill = (pid) => { killed.push(pid); if (pid === 100) throw Object.assign(new Error('kill failed'), { code: '${code}' }); };`,
      `
      assert.equal(processes.stopTree(100), ${code === "ESRCH"});
      assert.deepEqual(killed, [100, 101]);`,
    );
    assert.equal(result.status, 0, result.stderr);
    if (code === "EPERM") assert.match(result.stderr, /Could not stop process 100: EPERM/);
    else assert.equal(result.stderr, "");
  });
}
