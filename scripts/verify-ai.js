const adapter = require('../cloudfunctions/api/ai-adapter');
const domain = require('../miniprogram/services/practice-domain');

async function main() {
  const status = adapter.status();
  if (!status.ready || status.provider !== 'openai-compatible') {
    console.error('尚未配置真实 AI：请在当前进程设置 AI_PROVIDER、AI_BASE_URL、AI_MODEL、AI_API_KEY。');
    process.exitCode = 1;
    return;
  }
  const source = { subject: 'math', grade: 3, questionType: '计算题', questionText: '23 × 14 =',
    correctAnswer: '322', studentAnswer: '332', errorReason: '乘法进位错误', knowledgePoints: '两位数乘两位数', version: 1 };
  const options = { count: 1, difficulty: 'normal' };
  const started = Date.now();
  const output = await adapter.generate(source, options);
  const questions = domain.validateOutput(output, source, options);
  console.log(`真实 AI 联通及结构校验通过：${questions.length} 道题，耗时 ${Date.now() - started}ms。`);
  console.log('此命令只验证接口和结果结构；题目、答案与教学质量仍需人工验收。');
}

main().catch((failure) => {
  console.error(`${failure.code || 'AI_PROVIDER_FAILED'}：${failure.code ? failure.message : 'AI 联通测试失败'}`);
  process.exitCode = 1;
});
