import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { checkOne } from '../src/checker.js';
import { settings } from '../src/config.js';

for (const protocol of ['http', 'https', 'socks4', 'socks5']) {
  test(`${protocol}: repeated stalled handshakes release every TCP socket`, { timeout: 120000 }, async (t) => {
    const sockets = new Set();
    let accepted = 0;
    const server = net.createServer((socket) => {
      accepted++;
      sockets.add(socket);
      socket.on('data', () => {});
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const saved = { ...settings };
    settings.checkTargets = ['https://127.0.0.1/generate_204'];
    settings.checkTimeoutSeconds = 0.08;
    try {
      const waves = Number(process.env.NETWORK_TEST_WAVES || 5);
      for (let wave = 0; wave < waves; wave++) {
        const results = await Promise.all(Array.from({ length: 8 }, () =>
          checkOne(`${protocol}://127.0.0.1:${server.address().port}`)));
        assert.ok(results.every((result) => result.alive === false));
        for (let attempt = 0; attempt < 50 && sockets.size; attempt++) await delay(10);
        assert.equal(sockets.size, 0, `wave ${wave}: abandoned handshake sockets remain open`);
      }
      assert.equal(accepted, waves * 8);
      t.diagnostic(`connections=${accepted} remaining_sockets=${sockets.size}`);
    } finally {
      Object.assign(settings, saved);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test('a proxy that accepts CONNECT but stalls TLS is also closed on timeout', { timeout: 5000 }, async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('data', () => socket.write('HTTP/1.1 200 Connection established\r\n\r\n'));
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const saved = { ...settings };
  settings.checkTargets = ['https://127.0.0.1/generate_204'];
  settings.checkTimeoutSeconds = 0.1;
  try {
    const result = await checkOne(`http://127.0.0.1:${server.address().port}`);
    assert.equal(result.alive, false);
    for (let i = 0; i < 50 && sockets.size; i++) await delay(10);
    assert.equal(sockets.size, 0);
  } finally {
    Object.assign(settings, saved);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
