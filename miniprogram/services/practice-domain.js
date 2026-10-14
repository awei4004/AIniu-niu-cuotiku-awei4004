// Copied to the cloud function by scripts/sync-domain.js for independent deployment.
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function generationOptions(data) {
  const count = data.count === undefined ? 1 : Number(data.count);
  if (!Number.isInteger(count) || count < 1 || count > 3) fail('VALIDATION_ERROR', '生成数量应为 1 至 3 道');
  return { count, difficulty: difficultyValue(data.difficulty) };
}

function difficultyValue(value) {
  const mapped = { 1: 'easy', 2: 'normal', 3: 'hard' };
    const result = value === undefined ? 'normal' : (mapped[value] || value);
  if (!['easy', 'normal', 'hard'].includes(result)) fail('VALIDATION_ERROR', '请选择基础、一般或提高难度');
  return result;
}

function sourceVersion(source) {
  return JSON.stringify([source.version || 1, source.questionText, source.correctAnswer,
    source.analysis, source.studentId, source.subject, source.knowledgePoints, source.difficulty, source.questionType]);
}

function checkSource(generated, source) {
  if (generated.sourceVersion !== sourceVersion(source)) {
    fail('SOURCE_CHANGED', '原错题已修改，请重新生成同类题');
  }
}

function text(value, label, max, required = true) {
  if (typeof value !== 'string') fail('VALIDATION_ERROR', `${label}格式不正确`);
  const result = value.trim();
  if ((required && !result) || result.length > max) fail('VALIDATION_ERROR', `${label}不能为空或超过 ${max} 字`);
  return result;
}

function generatedFields(data) {
  if (!['objective', 'open'].includes(data.answerType)) fail('VALIDATION_ERROR', '请选择判题方式');
  return {
    questionText: text(data.questionText, '题目', 5000),
    correctAnswer: text(data.correctAnswer, '答案', 3000),
    analysis: text(data.analysis, '解析', 5000),
    knowledgePoints: text(data.knowledgePoints || '', '知识点', 500, false),
    questionType: text(data.questionType || '其他', '题型', 30),
    difficulty: difficultyValue(data.difficulty),
    answerType: data.answerType
  };
}

function validateOutput(raw, source, options) {
  let output;
  try { output = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (error) {
    fail('INVALID_AI_OUTPUT', '出题结果不是有效 JSON，请重试');
  }
  if (!output || output.sourceVersion !== sourceVersion(source)
    || !Array.isArray(output.questions) || output.questions.length !== options.count) {
    fail('INVALID_AI_OUTPUT', '出题数量或来源版本不正确，请重试');
  }
  const seen = new Set();
  return output.questions.map((item) => {
    let fields;
    try { fields = generatedFields(item); } catch (error) {
      fail('INVALID_AI_OUTPUT', '出题结果缺少有效的题目、答案或解析');
    }
    if (seen.has(fields.questionText) || fields.questionText === source.questionText.trim()) {
      fail('INVALID_AI_OUTPUT', '生成题与原题或其他生成题重复，请重试');
    }
    if (fields.difficulty !== options.difficulty) fail('INVALID_AI_OUTPUT', '生成题难度不符合配置');
    seen.add(fields.questionText);
    return fields;
  });
}

function demoGenerate(source, options) {
  const base = source.questionText.trim();
  const questions = [];
  const offset = 1 + Math.floor(Math.random() * 6);
  // Only a complete, single integer expression is safe for this template adapter.
  const expression = base.match(/^(\d{1,4})\s*([+\-−×xX*÷/])\s*(\d{1,4})\s*(?:=\s*(?:[?？]|[（(]\s*[）)]|_{1,})?)?\s*[?？]?$/);
  const context = `${base} ${source.knowledgePoints || ''}`;
  for (let i = 0; i < options.count; i += 1) {
    const step = offset + i;
    const fields = { difficulty: options.difficulty, questionType: '填空题', answerType: 'open',
      knowledgePoints: source.knowledgePoints || '' };
    if (source.subject === 'math' && expression) {
      const op = expression[2].replace(/[xX*]/, '×').replace('/', '÷').replace('−', '-');
      const scale = { easy: 1, normal: 2, hard: 4 }[options.difficulty];
      let a = Number(expression[1]) + step * scale;
      let b = Number(expression[3]) + step;
      if (op === '-' && a < b) [a, b] = [b, a];
      if (op === '÷') a = b * (step + scale + 1);
      const answer = { '+': a + b, '-': a - b, '×': a * b, '÷': a / b }[op];
      Object.assign(fields, { questionType: '计算题', answerType: 'objective',
        questionText: `${a} ${op} ${b} =`, correctAnswer: String(answer),
        analysis: `${a} ${op} ${b} = ${answer}。${op === '×' ? '把乘数按数位拆分，相乘后相加，注意进位。' : op === '÷' ? `用 ${answer} × ${b} = ${a} 验算。` : '按数位对齐计算，注意进位或退位。'}`,
        knowledgePoints: source.knowledgePoints || '整数基础计算' });
    } else if (source.subject === 'math' && source.questionType === '应用题'
      && /一共|还剩|每|平均/.test(base) && !/面积|体积|速度|百分|分数|小数/.test(context)) {
      const a = 10 + step * 2;
      const b = 3 + step;
      const divide = /平均/.test(base);
      const multiply = !divide && /每/.test(base);
      const subtract = !divide && !multiply && /还剩/.test(base);
      const answer = divide ? a : multiply ? a * b : subtract ? a - b : a + b;
      Object.assign(fields, { questionType: '应用题', answerType: 'open',
        questionText: divide ? `把 ${a * b} 支铅笔平均分给 ${b} 位同学，每人分到多少支？`
          : multiply ? `每盒彩笔有 ${a} 支，${b} 盒彩笔一共有多少支？`
            : subtract ? `小明有 ${a} 支铅笔，送给同学 ${b} 支，还剩多少支？`
              : `小明有 ${a} 支铅笔，又买了 ${b} 支，现在一共有多少支？`,
        correctAnswer: `${answer} 支`,
        analysis: divide ? `${a * b} ÷ ${b} = ${answer}（支），平均分用除法。`
          : `${a} ${multiply ? '×' : subtract ? '-' : '+'} ${b} = ${answer}（支），先确定数量关系，再列式计算。`,
        knowledgePoints: source.knowledgePoints || '一步应用题' });
    } else if (source.subject === 'chinese' && /反义|近义/.test(context)) {
      const antonym = /反义/.test(context);
      const pairs = antonym ? [['高', '低'], ['快', '慢'], ['远', '近'], ['大', '小'], ['多', '少'], ['长', '短'], ['早', '晚'], ['冷', '热'], ['开', '关']]
        : [['美丽', '漂亮'], ['马上', '立刻'], ['认真', '仔细'], ['高兴', '开心'], ['安静', '宁静'], ['明亮', '光亮'], ['喜爱', '喜欢'], ['温暖', '暖和'], ['困难', '艰难']];
      const pair = pairs[(step - 1) % pairs.length];
      Object.assign(fields, { questionText: `写出“${pair[0]}”的${antonym ? '反义' : '近义'}词。`,
        correctAnswer: pair[1], analysis: `参考答案为“${pair[1]}”，它与“${pair[0]}”的意思${antonym ? '相反' : '相近'}。其他合理答案也可由家长判定。`,
        knowledgePoints: source.knowledgePoints || (antonym ? '反义词' : '近义词') });
    } else if (source.subject === 'chinese' && /拼音|字词|看拼音|组词/.test(context)) {
      const words = [['山', 'shān'], ['水', 'shuǐ'], ['花', 'huā'], ['树', 'shù'], ['书', 'shū'], ['天', 'tiān'], ['风', 'fēng'], ['云', 'yún'], ['雨', 'yǔ']];
      const pair = words[(step - 1) % words.length];
      Object.assign(fields, { questionText: `写出汉字“${pair[0]}”的拼音，并用它组一个词。`,
        correctAnswer: `${pair[0]}：${pair[1]}；组词答案合理即可。`,
        analysis: `“${pair[0]}”读作 ${pair[1]}，注意声调；组词需符合词义。`, knowledgePoints: source.knowledgePoints || '拼音和字词' });
    } else {
      fail('UNSUPPORTED_GENERATION', '演示出题暂支持整数单步计算、简单一步应用题、拼音字词及近反义词，请选择相应错题');
    }
    questions.push(fields);
  }
  return JSON.stringify({ sourceVersion: sourceVersion(source), questions });
}

function answerText(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 3000) {
    fail('VALIDATION_ERROR', '请填写答案，最多 3000 字');
  }
  return value.trim();
}

function grade(question, answer) {
  if (question.answerType === 'open') return 'ungraded';
  // Preserve decimal points, punctuation and signs so 3.2 can never equal 32.
  const normalize = (value) => value.trim().replace(/\s+/g, '').toLowerCase();
  const actual = normalize(answer);
  const expected = normalize(question.correctAnswer);
  const numeric = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
  return (numeric.test(actual) && numeric.test(expected) ? Number(actual) === Number(expected) : actual === expected)
    ? 'correct' : 'wrong';
}

function snapshot(question) {
  const keys = ['_id', 'studentId', 'grade', 'subject', 'questionType', 'difficulty', 'questionText',
    'correctAnswer', 'analysis', 'knowledgePoints', 'answerType', 'sourceQuestionId', 'sourceVersion', 'updatedAt', 'version'];
  const result = {};
  keys.forEach((key) => { if (question[key] !== undefined) result[key] = question[key]; });
  return JSON.parse(JSON.stringify(result));
}

function publicQuestion(question) {
  return { _id: question._id, studentId: question.studentId, subject: question.subject,
    questionType: question.questionType, difficulty: question.difficulty, questionText: question.questionText,
    answerType: question.answerType, version: question.version || 1 };
}

function gradeValue(record, value) {
  if (record.questionSnapshot.answerType !== 'open') fail('INVALID_STATUS', '客观题由系统判定');
  if (!['correct', 'wrong', 'ungraded'].includes(value)) fail('VALIDATION_ERROR', '判题结果不正确');
  return value;
}

module.exports = { generationOptions, sourceVersion, checkSource, generatedFields, validateOutput,
  demoGenerate, answerText, grade, snapshot, publicQuestion, gradeValue };
