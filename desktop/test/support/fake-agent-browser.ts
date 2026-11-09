/**
 * Script source for fake agent-browser executables. `listTargets(url)` lists Chrome's targets over the `--cdp` WebSocket,
 * as the native agent does, in the shape of Chrome's /json/list entries.
 */
export const LIST_TARGETS = `const listTargets = (url) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
  socket.onerror = () => reject(new Error('CDP connection failed'));
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    socket.close();
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result.targetInfos.map((t) => ({ id: t.targetId, type: t.type, url: t.url, title: t.title })));
  };
});`;
