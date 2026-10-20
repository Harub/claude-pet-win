// 훅/상태줄이 보내는 데이터를 받는 로컬 전용(127.0.0.1) HTTP 서버
//   POST /event       훅 이벤트 JSON
//   POST /statusline  상태줄 입력 JSON (rate_limits 포함)
//   GET  /status      현재 펫 상태(디버깅용)
const http = require('http');

const MAX_BODY = 256 * 1024;

function startServer(port, { onEvent, onStatusline, getStatus, onQuit }) {
  const server = http.createServer((req, res) => {
    const handler =
      req.method === 'POST' && req.url === '/event'
        ? onEvent
        : req.method === 'POST' && req.url === '/statusline'
        ? onStatusline
        : null;

    if (handler) {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        try {
          handler(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStatus()));
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { startServer };
