const path = require('path');
const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');
const rules = require('../../miniprogram/services/export-domain');
const fontPath = path.resolve(__dirname, '../../cloudfunctions/api/assets/NotoSansSC-Regular.otf');

function fixture(template) {
  GlobalFonts.registerFromPath(fontPath, 'sans-serif');
  const canvas = createCanvas(600, 1200);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 600, 1200);
  context.fillStyle = '#111';
  context.font = '28px sans-serif';
  context.fillText('数学错题原图', 40, 60);
  context.fillText('长方形长 8 厘米，宽 5 厘米。', 40, 130);
  context.fillText('求它的周长和面积。', 40, 180);
  context.strokeStyle = '#111';
  context.lineWidth = 3;
  context.strokeRect(100, 300, 320, 200);
  context.fillText('8 厘米', 220, 280);
  context.fillText('5 厘米', 440, 400);
  context.fillText('解答：', 40, 650);
  for (let y = 730; y < 1150; y += 90) { context.beginPath(); context.moveTo(40, y); context.lineTo(560, y); context.stroke(); }
  const imageBytes = canvas.toBuffer('image/png');
  const student = { _id: 'qa-student', name: '小明', grade: 3 };
  const questions = [
    { _id: 'qa-q1', studentId: student._id, subject: 'math', questionType: '计算题', questionText: '计算下面各题，写出计算过程。\n23 × 14 =\n84 ÷ 7 =\n125 + 276 =',
      correctAnswer: '322；12；401', studentAnswer: '332；12；401', errorReason: '乘法竖式的进位遗漏。', knowledgePoints: '两位数乘两位数', analysis: '23 × 14 = 23 × 10 + 23 × 4 = 230 + 92 = 322。' },
    { _id: 'qa-q2', studentId: student._id, subject: 'chinese', questionType: '阅读理解',
      questionText: '阅读短文，回答问题。\n' + '春天到了，小明和同学们在校园里观察植物。他们看到嫩绿的新芽，也看到花瓣上的露珠。老师说，认真观察，还要用自己的话把看到的景色写清楚。'.repeat(10) + '\n（1）短文描写了哪个季节？\n（2）选择一处景色，用两句话写下来。',
      correctAnswer: '春天；景色描述合理即可。', studentAnswer: '夏天。', errorReason: '没有根据新芽等关键词判断季节。', knowledgePoints: '提取短文信息、景物描写', analysis: '先圈出表示季节的关键词，再联系全文作答。描写景物时可以按照颜色、形状和位置组织语言。' },
    { _id: 'qa-q3', studentId: student._id, subject: 'math', questionType: '几何题', sourceFileId: 'qa-image',
      questionText: '一个长方形长 8 厘米，宽 5 厘米。请分别求出它的周长和面积，并写出单位。',
      correctAnswer: '周长 26 厘米，面积 40 平方厘米。', studentAnswer: '周长 40 厘米。', errorReason: '混淆了周长与面积。', knowledgePoints: '长方形周长与面积', analysis: '周长 =（长 + 宽）× 2 = 26（厘米）；面积 = 长 × 宽 = 40（平方厘米）。' }
  ];
  const options = rules.options({ studentId: student._id, questionIds: questions.map((q) => q._id), template,
    title: '小明 · 语文数学错题复习', answerLines: 6, includeImages: true });
  return { snapshot: rules.snapshot(options, student, questions), imageBytes };
}

async function renderLocal(snapshot, imageBytes, progress) {
  const canvas = createCanvas(1, 1);
  const renderer = require('../../miniprogram/services/pdf-local');
  return renderer.render(snapshot, { canvas, loadImage: () => loadImage(imageBytes),
    capture: async () => canvas.toBuffer('image/jpeg', 95), onProgress: progress });
}

module.exports = { fixture, renderLocal };
