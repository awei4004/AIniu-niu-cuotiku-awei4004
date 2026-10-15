const { PDFDocument } = require('../vendor/pdf-lib');
const { layout } = require('./pdf-layout');
const { error } = require('./export-domain');

function bytesFromImage(value) {
  if (value instanceof Uint8Array) return value;
  try {
    if (value && typeof value.byteLength === 'number') {
      return new Uint8Array(value.buffer || value, Number(value.byteOffset) || 0, value.byteLength);
    }
  } catch (failure) {
    throw error('EXPORT_RUNTIME', `canvas-capture：截图数据格式无法识别（${failure.message || '未知错误'}）`);
  }
  throw error('EXPORT_RUNTIME', 'canvas-capture：微信未返回有效的截图字节，请重试');
}

function embedImage(document, bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return document.embedJpg(bytes);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return document.embedPng(bytes);
  throw error('EXPORT_RUNTIME', 'canvas-capture：截图不是有效的 JPG 或 PNG 文件，请重试');
}

async function render(snapshot, { canvas, loadImage, capture, onProgress = () => {} }) {
  const measureContext = canvas && canvas.getContext && canvas.getContext('2d');
  if (!measureContext) throw error('EXPORT_RUNTIME', 'pdf-render：微信 Canvas 2D 上下文不可用，请升级基础库后重试');
  const images = {};
  for (const question of snapshot.questions) {
    if (question.sourceFileId && !images[question.sourceFileId]) images[question.sourceFileId] = await loadImage(question.sourceFileId);
  }
  const plan = layout(snapshot, (text, size) => {
    measureContext.font = `${size}px sans-serif`;
    return measureContext.measureText(text).width;
  }, images);
  const document = await PDFDocument.create();
  const scale = 2.5;
  canvas.width = Math.ceil(plan.width * scale);
  canvas.height = Math.ceil(plan.height * scale);
  if (!canvas.width || !canvas.height) throw error('EXPORT_RUNTIME', 'pdf-render：无法设置打印画布尺寸，请重试');
  const context = canvas.getContext('2d');
  if (!context) throw error('EXPORT_RUNTIME', 'pdf-render：无法获取打印画布上下文，请重试');
  let imageBytes = 0;
  for (let index = 0; index < plan.pages.length; index += 1) {
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, plan.width, plan.height);
    context.textBaseline = 'top';
    for (const op of plan.pages[index]) {
      if (op.type === 'text') {
        context.fillStyle = '#171717';
        context.font = `${op.size}px sans-serif`;
        context.fillText(op.text, op.x, op.y);
      }
      if (op.type === 'line') {
        context.strokeStyle = op.light ? '#d4d4d4' : '#808080';
        context.lineWidth = 0.5;
        context.beginPath(); context.moveTo(op.x, op.y); context.lineTo(op.x + op.width, op.y); context.stroke();
      }
      if (op.type === 'image') context.drawImage(images[op.id], op.x, op.y, op.width, op.height);
    }
    const bytes = bytesFromImage(await capture(canvas));
    if (!bytes.byteLength) throw error('EXPORT_RUNTIME', 'canvas-capture：截图内容为空，请重试');
    imageBytes += bytes.byteLength;
    if (imageBytes > 20 * 1024 * 1024) throw error('EXPORT_LIMIT', 'PDF 超过 20 MB，请减少题目或关闭原图后分批导出');
    const image = await embedImage(document, bytes);
    document.addPage([plan.width, plan.height]).drawImage(image, { x: 0, y: 0, width: plan.width, height: plan.height });
    onProgress(Math.round((index + 1) / plan.pages.length * 95));
  }
  document.setTitle(snapshot.title);
  document.setProducer('Wrong Question Library / pdf-lib / canvas');
  return { bytes: await document.save(), pageCount: plan.pages.length };
}

module.exports = { render };
