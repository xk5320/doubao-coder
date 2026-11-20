/** 系统提示词「当前模型」回归：必须跟工具栏/桌面端实际选中的模型一致。 */
'use strict';

const { pickEffectiveModel, describeModel } = require('../out/chat/model-label.js');

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + ' → ' + JSON.stringify(actual) + ' != ' + JSON.stringify(expected)); }
}

const live = {
  mode: 'local',
  taskModel: 'DeepSeek V4.1 Flash',
  taskReasoning: '高',
  desktopModel: '快速',
  desktopReasoning: '',
  configDesktopModel: 'DeepSeek V4.1 Flash',
  configDesktopReasoning: '高',
  configModel: 'doubao-seed-1.6-flash',
  authMode: 'desktop',
};
eq('本地电脑模式：用面板记住的桌面模型，而不是 Ark 模型', pickEffectiveModel(live), { model: 'DeepSeek V4.1 Flash', reasoning: '高' });
eq('面板还没记住时：退回配置里的桌面模型', pickEffectiveModel({ ...live, taskModel: '', taskReasoning: '' }), { model: 'DeepSeek V4.1 Flash', reasoning: '高' });
eq('桌面端全空：才退回 Ark 模型', pickEffectiveModel({ ...live, taskModel: '', taskReasoning: '', configDesktopModel: '', configDesktopReasoning: '' }), { model: 'doubao-seed-1.6-flash', reasoning: '' });
eq('对话模式：用桌面端当前模型', pickEffectiveModel({ ...live, mode: 'chat', desktopModel: '快速', desktopReasoning: '' }), { model: '快速', reasoning: '' });
eq('Ark 通道：用配置模型且不带推理强度', pickEffectiveModel({ ...live, authMode: 'ark' }), { model: 'doubao-seed-1.6-flash', reasoning: '' });

eq('提示词文案：模型 + 推理强度', describeModel('DeepSeek V4.1 Flash', '高'), '当前模型：DeepSeek V4.1 Flash（推理强度：高）');
eq('提示词文案：没有推理强度', describeModel('快速', ''), '当前模型：快速');
eq('提示词文案：空模型显示未指定', describeModel('', ''), '当前模型：未指定');

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);