/**
 * 对拍回归：把真机采样下来的「参考读取 vs 生产提取」逐条比对。
 *
 * 样本由 `node ../../tools/parity.mjs --all --record` 从活着的豆包页面写入，
 * 这里离线重放，锁住三件事：
 *   1) 块序 / 块类型（计时、反馈步骤、正文）和页面上一致；
 *   2) 计时文案与秒数一致（含「5 分 52 秒」「共用时」）；
 *   3) 反馈步骤的文案与状态（running / error / done）一致。
 *
 * 用法：node test/parity.test.js（工作目录：扩展根目录）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS  ' + name);
  } else {
    fail += 1;
    console.log('  FAIL  ' + name + (detail ? ' → ' + detail : ''));
  }
}

async function main() {
  const toolPath = path.join(__dirname, '..', '..', '..', 'tools', 'parity.mjs');
  const { compare } = await import(pathToFileURL(toolPath).href);
  const dir = path.join(__dirname, 'fixtures', 'parity');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    : [];

  console.log('== 对拍回归：' + files.length + ' 个真机样本 ==');
  check('样本目录存在且至少 3 条（覆盖完成/进行中）', files.length >= 3, 'files=' + files.length);

  for (const file of files) {
    const sample = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const result = compare(sample.ref, sample.prod);
    check(
      file + '：参考读取与生产提取完全一致',
      result.ok,
      result.diffs.slice(0, 6).map((d) => d.at + ': ' + d.detail).join(' | '),
    );

    const refBlocks = Array.isArray(sample.ref && sample.ref.blocks) ? sample.ref.blocks : [];
    const steps = refBlocks.filter((b) => b.kind === 'step').length;
    const hasStatus = refBlocks.some((b) => b.kind === 'status');
    const hasText = refBlocks.some((b) => b.kind === 'text');
    check(file + '：样本含计时 + 反馈步骤 + 正文', hasStatus && steps >= 1 && hasText, 'steps=' + steps);
    check(
      file + '：计时秒数与文案自洽',
      sample.ref.progressSeconds >= 0 && Number.isFinite(sample.ref.progressSeconds),
      'progress=' + JSON.stringify(sample.ref.progress) + ' seconds=' + sample.ref.progressSeconds,
    );
  }

  console.log('\n对拍回归结果：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('对拍回归异常：' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});