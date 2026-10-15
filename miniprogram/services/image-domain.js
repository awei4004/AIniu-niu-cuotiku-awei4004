const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 5000;
const TASK_TIMEOUT = 60000;

function error(code, message) {
  const result = new Error(message);
  result.code = code;
  return result;
}

function requestId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(value)) {
    throw error('VALIDATION_ERROR', '请求编号格式不正确');
  }
  return value;
}

function uploadFields(data) {
  const format = String(data.format || '').toLowerCase().replace('jpeg', 'jpg');
  const size = Number(data.size);
  if (!['jpg', 'png'].includes(format)) throw error('FILE_INVALID', '请选择 JPG 或 PNG 图片');
  if (!Number.isInteger(size) || size < 1 || size > MAX_BYTES) {
    throw error('FILE_INVALID', '单张图片不能超过 5 MB');
  }
  return { format, size, purpose: 'question_image' };
}

function checkImage(bytes, file) {
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  const format = bytes && bytes.length >= 8 && png.every((value, index) => bytes[index] === value) ? 'png'
    : bytes && bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg' : '';
  if (!format || format !== file.format || bytes.length !== file.size || bytes.length > MAX_BYTES) {
    throw error('FILE_INVALID', '图片内容、格式或大小与登记信息不一致，请重新选择');
  }
}

function subject(value) {
  if (!['chinese', 'math'].includes(value)) throw error('VALIDATION_ERROR', '请选择语文或数学');
  return value;
}

function ocrResult(result) {
  if (!result || typeof result.text !== 'string' || !result.text.trim()) {
    throw error('OCR_EMPTY', '没有识别到文字，请换一张清晰图片或手动录入');
  }
  if (result.text.trim().length > MAX_TEXT) throw error('OCR_TOO_LONG', '识别文字超过 5000 字，请裁剪到单道题后重试');
  return { text: result.text.trim(), provider: result.provider === 'demo' ? 'demo' : 'tencent' };
}

function demoRecognize(value) {
  return ocrResult({ provider: 'demo', text: subject(value) === 'math' ? '23 × 14 ='
    : '请写出“美丽”的近义词，并用这个词造句。' });
}

function checkBinding(task, file, reviewed) {
  if (!file || task.fileId !== file._id || task.type !== 'ocr' || task.status !== 'completed') {
    throw error('VALIDATION_ERROR', '识别任务与原图不匹配');
  }
  if (reviewed !== true) throw error('VALIDATION_ERROR', '请先校对识别结果再保存');
}

function failureMessage(failure) {
  const known = ['OCR_NOT_CONFIGURED', 'OCR_EMPTY', 'OCR_TOO_LONG', 'PROVIDER_TIMEOUT', 'PROVIDER_FAILED',
    'FILE_INVALID', 'NOT_FOUND', 'VALIDATION_ERROR'];
  return known.includes(failure.code) ? failure.message : '识别服务暂时不可用，可手动录入或稍后重试';
}

module.exports = { MAX_BYTES, MAX_TEXT, TASK_TIMEOUT, error, requestId, uploadFields, checkImage,
  subject, ocrResult, demoRecognize, checkBinding, failureMessage };
