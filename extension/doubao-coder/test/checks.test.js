/**
 * 工程自检运行器（src/agent/checks.ts）离线单测。
 * 用法：node test/checks.test.js
 *
 * 覆盖：detectChecks 优先级/缺失容错、runChecks 成功/失败/超时（含子进程树清理）/
 * 截断/AbortSignal、parseDiagnostics（TS + ESLint）、formatCheckReport（PASS/FAIL/上限/ANSI）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  detectChecks,
  runChecks,
  parseDiagnostics,
  formatCheckReport,
} = require(path.join(__dirname, '..', 'out', 'agent', 'checks.js'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS  ' + name);
  } else {
    fail += 1;
    console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : ''));
  }
}

const tempDirs = [];
function makeTemp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-checks-' + label + '-'));
  tempDirs.push(dir);
  return dir;
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
function writePackage(dir, scripts) {
  writeJson(path.join(dir, 'package.json'), { name: 'tmp-checks', private: true, scripts: scripts });
}
function writeTsconfig(dir) {
  writeJson(path.join(dir, 'tsconfig.json'), { compilerOptions: { strict: true } });
}
function nodeCheck(id, label, code, extra) {
  const command = { id: id, label: label, command: process.execPath, args: ['-e', code] };
  return Object.assign(command, extra || {});
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  try {
    /* ---------------- detectChecks ---------------- */
    const allDir = makeTemp('all');
    writeTsconfig(allDir);
    writePackage(allDir, {
      typecheck: 'tsc --noEmit',
      compile: 'tsc -p .',
      lint: 'eslint .',
      test: 'node test.js',
    });
    const allChecks = await detectChecks(allDir);
    check(
      'detect：四个脚本齐全时按 typecheck -> compile -> lint -> test 排序',
      allChecks.map((c) => c.id).join(',') === 'typecheck,compile,lint,test',
      allChecks.map((c) => c.id).join(','),
    );
    check(
      'detect：命令只生成 argv（无 shell 元字符拼接）',
      allChecks.every(
        (c) =>
          typeof c.command === 'string' &&
          Array.isArray(c.args) &&
          !c.args.some((a) => /[|&;<>]/.test(a)),
      ),
    );
    check(
      'detect：cwd 指向项目根',
      allChecks.every((c) => c.cwd === path.resolve(allDir)),
    );

    const onlyTsDir = makeTemp('only-tsconfig');
    writeTsconfig(onlyTsDir);
    const onlyTsChecks = await detectChecks(onlyTsDir);
    check(
      'detect：仅有 tsconfig.json 时回退 npx --no-install tsc --noEmit',
      onlyTsChecks.length === 1 &&
        onlyTsChecks[0].id === 'typecheck' &&
        onlyTsChecks[0].command === 'npx' &&
        onlyTsChecks[0].args.join(' ') === '--no-install tsc --noEmit',
      JSON.stringify(onlyTsChecks),
    );

    const emptyDir = makeTemp('empty');
    const emptyChecks = await detectChecks(emptyDir);
    check('detect：无 package.json / tsconfig 时返回空数组', Array.isArray(emptyChecks) && emptyChecks.length === 0);

    const partialDir = makeTemp('partial');
    writePackage(partialDir, { lint: 'eslint .', test: 'node t.js' });
    const partialChecks = await detectChecks(partialDir);
    check(
      'detect：缺失的脚本不生成，保留 lint/test',
      partialChecks.map((c) => c.id).join(',') === 'lint,test',
      partialChecks.map((c) => c.id).join(','),
    );
    check('detect：无 compile 且无 tsconfig 时不生成 typecheck', !partialChecks.some((c) => c.id === 'typecheck'));

    const onlyTestDir = makeTemp('only-test');
    writePackage(onlyTestDir, { test: 'node t.js' });
    const onlyTestChecks = await detectChecks(onlyTestDir);
    check(
      'detect：只有 test 脚本时只生成 test',
      onlyTestChecks.length === 1 && onlyTestChecks[0].id === 'test' && onlyTestChecks[0].args.join(' ') === 'run test',
      JSON.stringify(onlyTestChecks),
    );

    const brokenDir = makeTemp('broken-json');
    writeTsconfig(brokenDir);
    fs.writeFileSync(path.join(brokenDir, 'package.json'), '{ not valid json', 'utf8');
    const brokenChecks = await detectChecks(brokenDir);
    check(
      'detect：package.json 损坏时不抛错并回退 tsconfig',
      brokenChecks.length === 1 && brokenChecks[0].id === 'typecheck',
      JSON.stringify(brokenChecks),
    );

    const tsScriptDir = makeTemp('ts-script');
    writeTsconfig(tsScriptDir);
    writePackage(tsScriptDir, { typecheck: 'tsc --noEmit' });
    const tsScriptChecks = await detectChecks(tsScriptDir);
    check(
      'detect：已有 typecheck 脚本时不再重复追加 npx',
      tsScriptChecks.length === 1 && tsScriptChecks[0].args.join(' ') === 'run typecheck',
      JSON.stringify(tsScriptChecks),
    );

    /* ---------------- runChecks ---------------- */
    const runDir = makeTemp('run');

    const success = await runChecks(runDir, {
      checks: [nodeCheck('ok', '成功命令', 'console.log("out-line"); console.error("err-line");')],
      maxOutputChars: 8000,
    });
    check(
      'run：成功命令 ok=true / exitCode=0',
      success.ok === true &&
        success.results.length === 1 &&
        success.results[0].ok === true &&
        success.results[0].exitCode === 0,
      JSON.stringify({ ok: success.ok, exitCode: success.results[0] && success.results[0].exitCode }),
    );
    check(
      'run：同时捕获 stdout 与 stderr',
      success.results[0].output.includes('out-line') && success.results[0].output.includes('err-line'),
      success.results[0].output,
    );
    check(
      'run：报告带 startedAt（ISO）与 durationMs',
      typeof success.startedAt === 'string' &&
        !Number.isNaN(Date.parse(success.startedAt)) &&
        success.durationMs >= 0,
      success.startedAt,
    );

    const tsErrorLine =
      "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.";
    const failure = await runChecks(runDir, {
      checks: [
        nodeCheck(
          'tsc',
          '类型检查',
          'console.error(' + JSON.stringify(tsErrorLine) + '); process.exitCode = 1;',
        ),
      ],
    });
    check(
      'run：失败命令 ok=false / 保留退出码 1',
      failure.ok === false &&
        failure.results.length === 1 &&
        failure.results[0].ok === false &&
        failure.results[0].exitCode === 1,
      JSON.stringify({ ok: failure.results[0].ok, exitCode: failure.results[0].exitCode }),
    );
    const failureDiags = parseDiagnostics(failure.results[0].output);
    check(
      'run：失败输出可解析出 TS 诊断',
      failureDiags.length === 1 &&
        failureDiags[0].file === 'src/app.ts' &&
        failureDiags[0].line === 3 &&
        failureDiags[0].column === 7 &&
        failureDiags[0].code === 'TS2322',
      JSON.stringify(failureDiags),
    );

    const truncation = await runChecks(runDir, {
      checks: [
        nodeCheck('long', '长输出', 'process.stdout.write("A".repeat(5000) + "TAIL-MARK");'),
      ],
      maxOutputChars: 500,
    });
    const truncatedResult = truncation.results[0];
    check(
      'run：输出尾部截断并标记原长（5009 字符）',
      truncatedResult.truncated === true &&
        truncatedResult.output.includes('TAIL-MARK') &&
        truncatedResult.output.includes('5009') &&
        !truncatedResult.output.startsWith('A'.repeat(600)),
      'len=' + truncatedResult.output.length + ', truncated=' + truncatedResult.truncated,
    );

    const timeoutRun = await runChecks(runDir, {
      checks: [nodeCheck('slow', '慢命令', 'setInterval(() => {}, 1000);', { timeoutMs: 500 })],
    });
    check(
      'run：超时标记 timedOut=true 且 ok=false',
      timeoutRun.ok === false &&
        timeoutRun.results[0].timedOut === true &&
        timeoutRun.results[0].ok === false,
      JSON.stringify({
        ok: timeoutRun.ok,
        timedOut: timeoutRun.results[0].timedOut,
        output: timeoutRun.results[0].output.slice(-120),
      }),
    );
    check(
      'run：超时不会等待默认 120s',
      timeoutRun.durationMs < 5000,
      'duration=' + timeoutRun.durationMs,
    );

    /* 超时杀进程树：父进程拉起的孙进程若存活，会在 1.6s 后写标记文件。 */
    const treeDir = makeTemp('tree');
    const marker = path.join(treeDir, 'orphan-marker.txt');
    const childCode =
      'setTimeout(() => { require("fs").writeFileSync(' +
      JSON.stringify(marker) +
      ', "orphan"); }, 1600);';
    const parentCode =
      'require("node:child_process").spawn(process.execPath, ["-e", ' +
      JSON.stringify(childCode) +
      '], { stdio: "ignore" }); setInterval(() => {}, 1000);';
    await runChecks(treeDir, {
      checks: [nodeCheck('tree', '进程树清理', parentCode, { timeoutMs: 500 })],
    });
    await delay(1900);
    check(
      'run：超时后杀掉整个子进程树（孙进程未能写标记）',
      !fs.existsSync(marker),
      marker,
    );

    const controller = new AbortController();
    const abortStarted = Date.now();
    const abortPromise = runChecks(runDir, {
      checks: [
        nodeCheck('slow-abort', '等待中止', 'setInterval(() => {}, 1000);'),
        nodeCheck('after', '不应执行', 'console.log("AFTER");'),
      ],
      signal: controller.signal,
    });
    await delay(250);
    controller.abort();
    const aborted = await abortPromise;
    check(
      'run：AbortSignal 中止当前命令',
      aborted.ok === false &&
        aborted.results.length === 1 &&
        aborted.results[0].ok === false &&
        aborted.results[0].timedOut === false,
      JSON.stringify({ ok: aborted.ok, count: aborted.results.length }),
    );
    check(
      'run：中止后不再执行剩余检查',
      aborted.results.length === 1 && !aborted.results.some((r) => r.id === 'after'),
      aborted.results.map((r) => r.id).join(','),
    );
    check(
      'run：中止响应及时',
      Date.now() - abortStarted < 5000,
      'elapsed=' + (Date.now() - abortStarted),
    );

    /* ---------------- parseDiagnostics ---------------- */
    const diagnosticText = [
      'src/a.ts(10,5): error TS2322: Type ...',
      '  src/b.ts(2,1): warning TS6133: unused',
      'C:\\proj\\c.js:7:3 - error Unexpected var  no-var',
      'D:/proj/d.ts:9:2 - warning Prefer const',
      '\u001b[31msrc/e.ts(1,2): error TS1000: colored\u001b[0m',
      '随便一行不是诊断',
      '',
    ].join('\n');
    const parsed = parseDiagnostics(diagnosticText);
    check(
      'parse：解析 TS 错误（file/line/column/severity/code）',
      parsed.some(
        (d) =>
          d.file === 'src/a.ts' &&
          d.line === 10 &&
          d.column === 5 &&
          d.severity === 'error' &&
          d.code === 'TS2322',
      ),
      JSON.stringify(parsed),
    );
    check(
      'parse：解析 TS 警告',
      parsed.some((d) => d.file === 'src/b.ts' && d.line === 2 && d.severity === 'warning' && d.code === 'TS6133'),
    );
    check(
      'parse：解析 ESLint 行（Windows 路径）',
      parsed.some(
        (d) =>
          d.file === 'C:\\proj\\c.js' &&
          d.line === 7 &&
          d.column === 3 &&
          d.severity === 'error' &&
          d.message.includes('Unexpected var'),
      ),
      JSON.stringify(parsed),
    );
    check(
      'parse：ANSI 颜色行也能解析',
      parsed.some((d) => d.file === 'src/e.ts' && d.code === 'TS1000' && d.message === 'colored'),
    );
    check('parse：跳过无关行', parsed.length === 5, 'len=' + parsed.length);

    /* ---------------- formatCheckReport ---------------- */
    const passReport = {
      ok: true,
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1234,
      results: [
        {
          id: 'typecheck',
          label: '类型检查',
          ok: true,
          exitCode: 0,
          durationMs: 800,
          output: '\u001b[32mtypecheck clean\u001b[0m',
          truncated: false,
          timedOut: false,
        },
        {
          id: 'test',
          label: '测试',
          ok: true,
          exitCode: 0,
          durationMs: 434,
          output: 'all good',
          truncated: false,
          timedOut: false,
        },
      ],
    };
    const passMd = formatCheckReport(passReport);
    check('format：PASS 报告', passMd.includes('PASS') && !passMd.includes('FAIL'), passMd);
    check(
      'format：PASS 列出每条命令与耗时',
      passMd.includes('typecheck') &&
        passMd.includes('test') &&
        passMd.includes('800ms') &&
        passMd.includes('1.2s'),
      passMd,
    );
    check('format：PASS 报告无 ANSI 颜色码', !/\u001b\[/.test(passMd));

    const diagLines = [];
    for (let i = 0; i < 25; i += 1) {
      diagLines.push('src/f' + i + '.ts(' + (i + 1) + ',1): error TS1000: err-' + i);
    }
    const failReport = {
      ok: false,
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 4321,
      results: [
        {
          id: 'typecheck',
          label: '类型检查',
          ok: false,
          exitCode: 1,
          durationMs: 2100,
          output: '\u001b[31m' + diagLines.join('\n') + '\u001b[0m\n' + 'B'.repeat(5000) + 'TAIL',
          truncated: true,
          timedOut: false,
        },
        {
          id: 'test',
          label: '测试',
          ok: false,
          exitCode: null,
          durationMs: 900,
          output: '\u001b[33mboom\u001b[0m\n' + 'C'.repeat(3000) + 'TEST-TAIL',
          truncated: false,
          timedOut: true,
        },
        {
          id: 'lint',
          label: '代码检查',
          ok: true,
          exitCode: 0,
          durationMs: 100,
          output: 'PASS-OUTPUT-SHOULD-NOT-APPEAR',
          truncated: false,
          timedOut: false,
        },
      ],
    };
    const failMd = formatCheckReport(failReport);
    check('format：FAIL 报告', failMd.includes('FAIL') && !failMd.startsWith('## 自检结果：PASS'), failMd);
    check(
      'format：诊断最多 20 条',
      (failMd.match(/\n- \`src\/f\d+\.ts/g) || []).length === 20,
      'count=' + (failMd.match(/\n- \`src\/f\d+\.ts/g) || []).length,
    );
    check(
      'format：首条错误摘要',
      failMd.includes('首条错误：') && failMd.includes('TS1000'),
      failMd.slice(0, 500),
    );
    check(
      'format：每命令输出尾部最多 2000 字',
      (failMd.match(/B/g) || []).length <= 2000 && (failMd.match(/C/g) || []).length <= 2000,
      'B=' + (failMd.match(/B/g) || []).length + ', C=' + (failMd.match(/C/g) || []).length,
    );
    check(
      'format：保留失败输出的尾部内容',
      failMd.includes('TAIL') && failMd.includes('TEST-TAIL'),
    );
    check(
      'format：不包含通过命令的输出',
      !failMd.includes('PASS-OUTPUT-SHOULD-NOT-APPEAR'),
    );
    check('format：失败报告也无 ANSI 颜色码', !/\u001b\[/.test(failMd));
    check('format：标注超时', failMd.includes('超时'));

    const emptyMd = formatCheckReport({
      ok: false,
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
      results: [],
    });
    check('format：无检查时说明原因', emptyMd.includes('没有运行任何检查'), emptyMd);

    /* ---------------- 集成：detect -> run 真正执行 npm script ---------------- */
    const integDir = makeTemp('integ');
    fs.writeFileSync(path.join(integDir, 'ok.js'), 'console.log("integration-ok");\n', 'utf8');
    writePackage(integDir, { test: 'node ok.js' });
    const integChecks = await detectChecks(integDir);
    const integReport = await runChecks(integDir, { checks: integChecks, maxOutputChars: 4000 });
    check(
      '集成：detectChecks 生成的 npm run test 可由 runChecks 执行',
      integChecks.length === 1 &&
        integChecks[0].id === 'test' &&
        integReport.ok === true &&
        integReport.results[0].ok === true &&
        integReport.results[0].output.includes('integration-ok'),
      JSON.stringify({
        detected: integChecks.map((c) => c.id),
        ok: integReport.ok,
        exitCode: integReport.results[0] && integReport.results[0].exitCode,
        output: integReport.results[0] && integReport.results[0].output.slice(-300),
      }),
    );
  } catch (err) {
    fail += 1;
    console.error('  FAIL  未捕获异常:', err && err.stack ? err.stack : err);
  } finally {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响测试结论。
      }
    }
  }

  console.log('\n[结果] pass=' + pass + ' fail=' + fail);
  process.exitCode = fail === 0 ? 0 : 1;
})();
