const { MCP_TEMPLATES, mergeMcpTemplate } = require('../out/mcp/templates.js');
let pass = 0; let fail = 0;
function check(n, c) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); } }
check('模板数量 >= 3', MCP_TEMPLATES.length >= 3);
check('文件系统模板带根目录', JSON.stringify(MCP_TEMPLATES[0].build('E:\\ws')).includes('E:\\\\ws'));
const merged = mergeMcpTemplate([{ name: 'git', command: 'old', args: [] }, { bogus: true }], { name: 'git', command: 'npx', args: ['x'] });
check('同名替换', merged.length === 1 && merged[0].command === 'npx');
const added = mergeMcpTemplate([], { name: 'fetch', command: 'npx' });
check('新增模板', added.length === 1 && added[0].name === 'fetch');
console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);