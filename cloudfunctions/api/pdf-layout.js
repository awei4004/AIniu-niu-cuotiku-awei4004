const { MAX_PAGES, error } = require('./export-domain');
const WIDTH = 595.28;
const HEIGHT = 841.89;
const MARGIN = 42;
const CONTENT_WIDTH = WIDTH - MARGIN * 2;
const BOTTOM = HEIGHT - 48;

function wrap(text, size, measure) {
  const lines = [];
  for (const paragraph of String(text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    let line = '';
    for (const character of Array.from(paragraph)) {
      if (line && measure(line + character, size) > CONTENT_WIDTH) { lines.push(line); line = ''; }
      line += character;
    }
    lines.push(line);
  }
  return lines;
}

function layout(snapshot, measure, images = {}) {
  const pages = [];
  let page;
  let y;
  function addPage() {
    if (pages.length >= MAX_PAGES) throw error('EXPORT_LIMIT', '资料超过 60 页，请减少题目后分批导出');
    page = [];
    pages.push(page);
    y = 42;
    for (const line of wrap(snapshot.title, 18, measure)) {
      page.push({ type: 'text', text: line, x: MARGIN, y, size: 18 });
      y += 25;
    }
    const subjects = [...new Set(snapshot.questions.map((q) => q.subject === 'math' ? '数学' : '语文'))].join(' / ');
    for (const line of wrap(`${snapshot.student.name}  |  ${snapshot.student.grade}年级  |  ${subjects}  |  ${snapshot.template === 'practice' ? '练习版' : '解析版'}`, 10, measure)) {
      page.push({ type: 'text', text: line, x: MARGIN, y, size: 10 });
      y += 16;
    }
    page.push({ type: 'line', x: MARGIN, y: y + 3, width: CONTENT_WIDTH });
    y += 24;
  }
  function ensure(height) { if (y + height > BOTTOM) addPage(); }
  function text(value, size = 11, gap = 8) {
    const lineHeight = size * 1.65;
    for (const line of wrap(value, size, measure)) {
      ensure(lineHeight);
      page.push({ type: 'text', text: line, x: MARGIN, y, size });
      y += lineHeight;
    }
    y += gap;
  }
  addPage();
  snapshot.questions.forEach((question, index) => {
    ensure(80);
    text(`${index + 1}. ${question.subject === 'math' ? '数学' : '语文'}${question.questionType ? ' / ' + question.questionType : ''}`, 12, 5);
    text(question.questionText);
    if (snapshot.template === 'analysis') {
      if (question.sourceFileId) {
        const image = images[question.sourceFileId];
        if (!image || !image.width || !image.height) throw error('FILE_INVALID', '原图无法读取，请关闭附带原图或重新上传后导出');
        const ratio = Math.min(CONTENT_WIDTH / image.width, 330 / image.height, 1);
        const width = image.width * ratio;
        const height = image.height * ratio;
        ensure(height + 16);
        page.push({ type: 'image', id: question.sourceFileId, x: MARGIN, y, width, height });
        y += height + 16;
      }
      const labels = { correctAnswer: '参考答案', studentAnswer: '学生原答案', errorReason: '错误原因', knowledgePoints: '知识点', analysis: '解析' };
      Object.entries(labels).forEach(([key, label]) => {
        if (question[key]) text(`${label}：${question[key]}`, 10, 6);
      });
      if (!question.correctAnswer) text('参考答案：未填写', 10, 6);
    } else {
      for (let line = 0; line < snapshot.answerLines; line += 1) {
        ensure(24);
        page.push({ type: 'line', x: MARGIN, y: y + 20, width: CONTENT_WIDTH, light: true });
        y += 24;
      }
    }
    y += 14;
  });
  pages.forEach((operations, index) => operations.push({ type: 'text', text: `${index + 1} / ${pages.length}`, x: WIDTH / 2 - 15, y: HEIGHT - 31, size: 9 }));
  return { width: WIDTH, height: HEIGHT, pages };
}

module.exports = { layout, wrap, WIDTH, HEIGHT, MARGIN, CONTENT_WIDTH, BOTTOM };
