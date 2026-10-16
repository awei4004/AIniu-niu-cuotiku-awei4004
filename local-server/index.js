const fs = require('fs');
const path = require('path');
const http = require('http');
const { createAdapter } = require('../cloudfunctions/api/ai-adapter');
const { createService } = require('./service');

function createServer(service) {
  return http.createServer(async (request, response) => {
    const send = (status, value) => {
      if (!response.destroyed) {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(value));
      }
    };
    // Only the local simulator is supported; refuse browser origins and DNS rebinding hosts.
    if (request.headers.origin || !/^(127\.0\.0\.1|localhost):\d+$/.test(request.headers.host || '')) {
      request.resume();
      send(403, { ok: false, error: { code: 'FORBIDDEN', message: '仅允许本机小程序请求' } });
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      send(200, { ok: true, data: { service: 'local-ai', ...await service.call('generation.config') } });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/api') {
      request.resume();
      send(404, { ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' } });
      return;
    }
    if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      request.resume();
      send(415, { ok: false, error: { code: 'VALIDATION_ERROR', message: '请使用 JSON 请求' } });
      return;
    }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 128 * 1024) {
          send(413, { ok: false, error: { code: 'VALIDATION_ERROR', message: '请求内容过大' } });
          return;
        }
        chunks.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (ignored) { send(400, { ok: false, error: { code: 'VALIDATION_ERROR', message: '请求不是有效 JSON' } }); return; }
      if (!payload || typeof payload.action !== 'string' || payload.data !== undefined
        && (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data))) {
        send(400, { ok: false, error: { code: 'VALIDATION_ERROR', message: '请求格式不正确' } });
        return;
      }
      const data = await service.call(payload.action, payload.data);
      send(200, { ok: true, data });
    } catch (failure) {
      const allowed = ['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT', 'AI_NOT_CONFIGURED'];
      send(allowed.includes(failure.code) ? 400 : 500, { ok: false, error: {
        code: allowed.includes(failure.code) ? failure.code : 'LOCAL_AI_FAILED',
        message: allowed.includes(failure.code) ? failure.message : '本地服务异常，请检查电脑端服务'
      } });
    }
  });
}

function main() {
  const configFile = path.join(__dirname, 'config.local.json');
  if (!fs.existsSync(configFile)) fs.copyFileSync(path.join(__dirname, 'config.example.json'), configFile);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const env = Object.assign({}, config, process.env);
  const port = Number(env.LOCAL_AI_PORT || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid port');
  const adapter = createAdapter({ env });
  const service = createService({ adapter, directory: path.join(__dirname, 'data') });
  const server = createServer(service);
  server.requestTimeout = 15000;
  server.on('error', (failure) => {
    console.error(failure.code === 'EADDRINUSE'
      ? '端口已占用，请修改 LOCAL_AI_PORT，并同步修改 miniprogram/config/env.js 的端口。'
      : '本地服务启动失败，请检查端口配置。');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`本地 AI 服务：http://127.0.0.1:${port}`);
    console.log(adapter.status().ready ? 'AI 配置已读取，真实联通及题目质量仍需验证。'
      : 'AI 待配置：请填写 local-server/config.local.json，保存后重启服务。');
  });
}

if (require.main === module) {
  try { main(); } catch (ignored) { console.error('本地服务启动失败，请检查配置 JSON 和任务文件是否有效。'); process.exitCode = 1; }
}

module.exports = { createServer };
