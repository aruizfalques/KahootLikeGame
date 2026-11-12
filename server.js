// ClassQuiz — a tiny live quiz server for classrooms.
// No dependencies: just run `node server.js` (Node 18+).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const READY_MS = 4000;              // "get ready" screen before answers open
const GAME_IDLE_MS = 3 * 60 * 60e3; // forget games idle for 3 hours
const MAX_PLAYERS = 200;

const games = new Map(); // pin -> game

// ---------- helpers ----------
const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
function newPin() {
  let pin;
  do { pin = String(100000 + crypto.randomInt(900000)); } while (games.has(pin));
  return pin;
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 500e3) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

function validateQuiz(q) {
  if (!q || !Array.isArray(q.questions) || q.questions.length === 0) throw new Error('The quiz has no questions.');
  if (q.questions.length > 100) throw new Error('Max 100 questions.');
  return {
    title: clean(q.title, 120) || 'Quiz',
    questions: q.questions.map((x, i) => {
      const options = (x.options || []).map(o => clean(o, 120)).filter(Boolean).slice(0, 4);
      if (!clean(x.text, 300)) throw new Error(`Question ${i + 1} has no text.`);
      if (options.length < 2) throw new Error(`Question ${i + 1} needs at least 2 answers.`);
      const correct = Number(x.correct);
      if (!(correct >= 0 && correct < options.length)) throw new Error(`Question ${i + 1} needs a correct answer.`);
      const time = Math.min(240, Math.max(5, Number(x.time) || 20));
      return { text: clean(x.text, 300), options, correct, time };
    }),
  };
}

// ---------- game logic ----------
function createGame(quiz) {
  const game = {
    pin: newPin(), hostKey: rid(), quiz,
    phase: 'lobby', qIndex: -1, phaseEndsAt: 0, qOpenAt: 0,
    players: new Map(), hostClients: new Set(), playerClients: new Map(),
    timer: null, lastActivity: Date.now(), prevRanks: new Map(),
  };
  games.set(game.pin, game);
  return game;
}

function ranked(game) {
  return [...game.players.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function setPhase(game, phase, ms) {
  clearTimeout(game.timer);
  game.phase = phase;
  game.phaseEndsAt = ms ? Date.now() + ms : 0;
  game.lastActivity = Date.now();
  if (phase === 'ready') game.timer = setTimeout(() => openQuestion(game), ms);
  if (phase === 'question') game.timer = setTimeout(() => reveal(game), ms);
  broadcast(game);
}

function startQuestion(game, idx) {
  game.qIndex = idx;
  game.prevRanks = new Map(ranked(game).map((p, i) => [p.id, i + 1]));
  setPhase(game, 'ready', READY_MS);
}
function openQuestion(game) {
  const q = game.quiz.questions[game.qIndex];
  game.qOpenAt = Date.now();
  setPhase(game, 'question', q.time * 1000);
}
function reveal(game) {
  if (game.phase !== 'question') return;
  const q = game.quiz.questions[game.qIndex];
  for (const p of game.players.values()) {
    const a = p.answers[game.qIndex];
    if (!a) { p.streak = 0; p.last = { answered: false, correct: false, points: 0 }; continue; }
    p.last = { answered: true, correct: a.correct, points: a.points, choice: a.choice };
  }
  setPhase(game, 'reveal');
  void q;
}
function next(game) {
  const last = game.qIndex >= game.quiz.questions.length - 1;
  switch (game.phase) {
    case 'lobby': return startQuestion(game, 0);
    case 'ready': return openQuestion(game);
    case 'question': return reveal(game);
    case 'reveal': return setPhase(game, last ? 'final' : 'leaderboard');
    case 'leaderboard': return startQuestion(game, game.qIndex + 1);
  }
}

function answer(game, player, choice) {
  if (game.phase !== 'question' || player.answers[game.qIndex]) return false;
  const q = game.quiz.questions[game.qIndex];
  if (!(choice >= 0 && choice < q.options.length)) return false;
  const elapsed = Math.max(0, Date.now() - game.qOpenAt);
  const limit = q.time * 1000;
  const correct = choice === q.correct;
  let points = 0;
  if (correct) {
    player.streak = (player.streak || 0) + 1;
    // 500–1000 points depending on speed, plus up to +200 for a streak
    points = Math.round(1000 * (1 - Math.min(elapsed, limit) / limit / 2));
    points += Math.min(player.streak - 1, 4) * 50;
  } else {
    player.streak = 0;
  }
  player.score += points;
  player.answers[game.qIndex] = { choice, correct, points, ms: elapsed };
  game.lastActivity = Date.now();
  // everyone (still connected) has answered -> reveal now
  const active = [...game.players.values()].filter(p => isConnected(game, p.id));
  if (active.length && active.every(p => p.answers[game.qIndex])) reveal(game);
  else broadcast(game);
  return true;
}

const isConnected = (game, id) => (game.playerClients.get(id)?.size || 0) > 0;

// ---------- views sent to screens ----------
function questionView(game, withAnswer) {
  const q = game.quiz.questions[game.qIndex];
  if (!q) return null;
  return {
    text: q.text, options: q.options, time: q.time,
    correct: withAnswer ? q.correct : undefined,
  };
}
function common(game) {
  return {
    phase: game.phase, pin: game.pin, title: game.quiz.title,
    qIndex: game.qIndex, total: game.quiz.questions.length,
    remainingMs: game.phaseEndsAt ? Math.max(0, game.phaseEndsAt - Date.now()) : 0,
  };
}
function hostView(game) {
  const ranks = ranked(game);
  const showAnswer = ['reveal', 'leaderboard', 'final'].includes(game.phase);
  const v = {
    ...common(game), role: 'host',
    question: game.phase === 'lobby' ? null : questionView(game, showAnswer),
    players: ranks.map((p, i) => ({
      id: p.id, name: p.name, score: p.score, streak: p.streak, rank: i + 1,
      prevRank: game.prevRanks.get(p.id) || null,
      connected: isConnected(game, p.id), answered: !!p.answers[game.qIndex],
      correctCount: Object.values(p.answers).filter(a => a.correct).length,
    })),
  };
  if (game.qIndex >= 0) {
    const q = game.quiz.questions[game.qIndex];
    const counts = q.options.map(() => 0);
    let answered = 0;
    for (const p of game.players.values()) {
      const a = p.answers[game.qIndex];
      if (a) { answered++; if (showAnswer) counts[a.choice]++; }
    }
    v.answered = answered;
    if (showAnswer) v.counts = counts;
  }
  return v;
}
function playerView(game, p) {
  const ranks = ranked(game);
  const rank = ranks.findIndex(x => x.id === p.id) + 1;
  const showAnswer = ['reveal', 'leaderboard', 'final'].includes(game.phase);
  const ahead = rank > 1 ? ranks[rank - 2] : null;
  return {
    ...common(game), role: 'player',
    me: { id: p.id, name: p.name, score: p.score, streak: p.streak, rank, of: ranks.length },
    ahead: ahead ? { name: ahead.name, gap: ahead.score - p.score } : null,
    question: ['ready', 'lobby'].includes(game.phase) ? (game.phase === 'ready' ? { text: questionView(game).text } : null) : questionView(game, showAnswer),
    myAnswer: p.answers[game.qIndex] ? { choice: p.answers[game.qIndex].choice } : null,
    last: showAnswer ? p.last : null,
    podium: game.phase === 'final' ? ranks.slice(0, 3).map(x => ({ name: x.name, score: x.score })) : null,
  };
}

function push(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
function broadcast(game) {
  const hv = hostView(game);
  for (const res of game.hostClients) push(res, hv);
  for (const [id, set] of game.playerClients) {
    const p = game.players.get(id);
    if (!p) continue;
    const pv = playerView(game, p);
    for (const res of set) push(res, pv);
  }
}
function sendKicked(game, id) {
  for (const res of game.playerClients.get(id) || []) { push(res, { phase: 'kicked' }); res.end(); }
  game.playerClients.delete(id);
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '/host' || pathname === '/play') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function openStream(req, res, game, register) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 20e3);
  const unregister = register(res);
  req.on('close', () => { clearInterval(ping); unregister(); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) return serveStatic(req, res, p);

    if (p === '/api/info' && req.method === 'GET') {
      return send(res, 200, { lan: lanAddresses(), port: PORT });
    }

    if (p === '/api/games' && req.method === 'POST') {
      const body = await readBody(req);
      const quiz = validateQuiz(body.quiz);
      const game = createGame(quiz);
      return send(res, 200, { pin: game.pin, hostKey: game.hostKey });
    }

    const game = games.get(url.searchParams.get('pin') || '');

    if (p === '/api/join' && req.method === 'POST') {
      const body = await readBody(req, 5e3);
      const g = games.get(String(body.pin || '').trim());
      if (!g) return send(res, 404, { error: 'No game with that PIN.' });
      if (g.phase === 'final') return send(res, 400, { error: 'That game has already finished.' });
      const name = clean(body.name, 20);
      if (!name) return send(res, 400, { error: 'Please enter a nickname.' });
      const taken = [...g.players.values()].some(x => x.name.toLowerCase() === name.toLowerCase());
      if (taken) return send(res, 400, { error: 'That nickname is taken — try another.' });
      if (g.players.size >= MAX_PLAYERS) return send(res, 400, { error: 'This game is full.' });
      const id = rid(8);
      g.players.set(id, { id, name, score: 0, streak: 0, answers: {}, last: null });
      g.lastActivity = Date.now();
      broadcast(g);
      return send(res, 200, { playerId: id, pin: g.pin });
    }

    if (!game) return send(res, 404, { error: 'Game not found (it may have ended).' });

    if (p === '/api/stream' && req.method === 'GET') {
      const hostKey = url.searchParams.get('hostKey');
      const playerId = url.searchParams.get('playerId');
      if (hostKey) {
        if (hostKey !== game.hostKey) return send(res, 403, { error: 'Not the host.' });
        return openStream(req, res, game, r => {
          game.hostClients.add(r); push(r, hostView(game));
          return () => game.hostClients.delete(r);
        });
      }
      const player = game.players.get(playerId);
      if (!player) return send(res, 404, { error: 'Player not found.' });
      return openStream(req, res, game, r => {
        if (!game.playerClients.has(player.id)) game.playerClients.set(player.id, new Set());
        game.playerClients.get(player.id).add(r);
        push(r, playerView(game, player));
        broadcast(game); // host sees them come online
        return () => {
          const set = game.playerClients.get(player.id);
          if (set) { set.delete(r); if (!set.size) game.playerClients.delete(player.id); }
          if (games.has(game.pin)) setTimeout(() => broadcast(game), 50);
        };
      });
    }

    if (p === '/api/answer' && req.method === 'POST') {
      const body = await readBody(req, 2e3);
      const player = game.players.get(body.playerId);
      if (!player) return send(res, 404, { error: 'Player not found.' });
      const ok = answer(game, player, Number(body.choice));
      return send(res, 200, { ok });
    }

    if (p === '/api/host' && req.method === 'POST') {
      const body = await readBody(req, 5e3);
      if (body.hostKey !== game.hostKey) return send(res, 403, { error: 'Not the host.' });
      if (body.action === 'next') next(game);
      else if (body.action === 'kick') {
        game.players.delete(body.playerId); sendKicked(game, body.playerId); broadcast(game);
      } else if (body.action === 'end') {
        clearTimeout(game.timer);
        for (const set of game.playerClients.values()) for (const r of set) { push(r, { phase: 'ended' }); r.end(); }
        for (const r of game.hostClients) r.end();
        games.delete(game.pin);
      }
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Unknown endpoint.' });
  } catch (e) {
    send(res, 400, { error: e.message || 'Bad request' });
  }
});

// forget idle games
setInterval(() => {
  const now = Date.now();
  for (const [pin, g] of games) if (now - g.lastActivity > GAME_IDLE_MS) { clearTimeout(g.timer); games.delete(pin); }
}, 10 * 60e3).unref();

server.listen(PORT, () => {
  console.log(`\n  ClassQuiz is running!\n`);
  console.log(`  Teacher (host):  http://localhost:${PORT}/host`);
  for (const ip of lanAddresses()) console.log(`  Students join:   http://${ip}:${PORT}   (same Wi-Fi)`);
  console.log('');
});
