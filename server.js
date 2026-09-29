'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const auth = require('./auth');
const { CONFIG } = auth;

const PUBLIC_DIR = path.resolve(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const CHAT_FILES_DIR = path.join(DATA_DIR, 'chat_files');
try { fs.mkdirSync(CHAT_FILES_DIR, { recursive: true }); } catch {}
const HOST = CONFIG.host || '0.0.0.0';
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || CONFIG.port || 3000;
const BODY_LIMIT = 1_000_000;
const CHAT_FILE_LIMIT = 1024 * 1024 * 1024 * 2; // 2GB — effectively unlimited

/* ---------- storage ---------- */

function todayStr(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

function seedState() {
  const now = Date.now();
  const id = () => crypto.randomUUID();
  const p1 = id(), p2 = id();
  const s1 = id(), s2 = id(), s3 = id();
  let n = 0;
  return {
    projects: [
      {
        id: p1,
        name: 'Работа',
        color: '#f06a6a',
        description: '',
        scheme: { nodes: [] },
        graph: { nodes: [], edges: [] },
        sections: [
          { id: s1, name: 'В работе', schemeRoot: null },
          { id: s2, name: 'Готово', schemeRoot: null },
        ],
      },
      {
        id: p2,
        name: 'Личное',
        color: '#4573d2',
        description: '',
        scheme: { nodes: [] },
        graph: { nodes: [], edges: [] },
        sections: [{ id: s3, name: 'Идеи', schemeRoot: null }],
      },
    ],
    tasks: [
      { id: id(), projectId: p1, sectionId: s1, parentId: null, title: 'Разобрать входящие письма', notes: '', done: false, due: todayStr(1), createdAt: now + n++, order: 0 },
      { id: id(), projectId: p1, sectionId: s1, parentId: null, title: 'Подготовить отчёт за неделю', notes: 'Свести цифры из таблицы.', done: false, due: todayStr(3), createdAt: now + n++, order: 1 },
      { id: id(), projectId: p1, sectionId: s1, parentId: null, title: 'Позвонить поставщику', notes: '', done: false, due: todayStr(-1), createdAt: now + n++, order: 2 },
      { id: id(), projectId: p1, sectionId: s2, parentId: null, title: 'Отправить счёт клиенту', notes: '', done: true, due: todayStr(-2), createdAt: now + n++, order: 0 },
      { id: id(), projectId: p2, sectionId: s3, parentId: null, title: 'Прочитать книгу по менеджменту', notes: '', done: false, due: null, createdAt: now + n++, order: 0 },
    ],
    comments: [],
    chat: [],
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const state = JSON.parse(raw);
    if (!state || !Array.isArray(state.projects) || !Array.isArray(state.tasks)) throw new Error('bad shape');
    if (!Array.isArray(state.comments)) state.comments = [];
    for (const p of state.projects) {
      if (!p.scheme) p.scheme = { nodes: [] };
      if (!p.graph) p.graph = { nodes: [], edges: [] };
      if (!Array.isArray(p.graph.nodes)) p.graph.nodes = [];
      if (!Array.isArray(p.graph.edges)) p.graph.edges = [];
      if (p.description === undefined) p.description = '';
      for (const s of p.sections) if (s.schemeRoot === undefined) s.schemeRoot = null;
    }
    for (const t of state.tasks) if (t.parentId === undefined) t.parentId = null;
    if (!Array.isArray(state.invites)) state.invites = [];
    if (!Array.isArray(state.chat)) state.chat = [];
    return state;
  } catch {
    const state = seedState();
    saveState(state);
    return state;
  }
}

function saveState(state) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

let state = loadState();

/* ---------- helpers ---------- */

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function findProject(pid) {
  const p = state.projects.find((x) => x.id === pid);
  if (!p) throw new ApiError(404, 'Проект не найден');
  return p;
}

function findSection(sid) {
  for (const p of state.projects) {
    const s = p.sections.find((x) => x.id === sid);
    if (s) return { project: p, section: s };
  }
  throw new ApiError(404, 'Секция не найдена');
}

function findTask(tid) {
  const t = state.tasks.find((x) => x.id === tid);
  if (!t) throw new ApiError(404, 'Задача не найдена');
  return t;
}

function cleanText(v, max, field) {
  if (typeof v !== 'string') throw new ApiError(400, `${field}: ожидается строка`);
  const t = v.trim();
  if (!t) throw new ApiError(400, `${field}: не может быть пустым`);
  if (t.length > max) throw new ApiError(400, `${field}: не длиннее ${max} символов`);
  return t;
}

function cleanLongText(v, max, field) {
  if (typeof v !== 'string') throw new ApiError(400, `${field}: ожидается строка`);
  if (v.length > max) throw new ApiError(400, `${field}: не длиннее ${max} символов`);
  return v;
}

function cleanDue(v) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ApiError(400, 'due: ожидается дата YYYY-MM-DD или null');
  if (Number.isNaN(new Date(v).getTime())) throw new ApiError(400, 'due: некорректная дата');
  return v;
}

function cleanColor(v) {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new ApiError(400, 'color: ожидается hex вида #rrggbb');
  return v.toLowerCase();
}

function groupOf(task) {
  return task.parentId || null;
}

function tasksInSection(sectionId) {
  return state.tasks.filter((t) => t.sectionId === sectionId);
}

function orderedGroup(sectionId, parentId) {
  return tasksInSection(sectionId)
    .filter((t) => groupOf(t) === parentId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

function renumberSection(sectionId) {
  const groups = new Map();
  for (const t of tasksInSection(sectionId)) {
    const g = groupOf(t);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    list.forEach((t, i) => { t.order = i; });
  }
}

function validateParent(parentId, sectionId) {
  if (parentId == null) return null;
  const parent = findTask(parentId);
  if (parent.sectionId !== sectionId) throw new ApiError(400, 'parentId: родитель из другой секции');
  if (parent.parentId) throw new ApiError(400, 'parentId: вложенность глубже двух уровней запрещена');
  return parent.id;
}

/* ---------- scheme ---------- */

function cleanSchemeNodes(raw) {
  if (!Array.isArray(raw)) throw new ApiError(400, 'nodes: ожидается массив');
  if (raw.length > 300) throw new ApiError(400, 'nodes: не больше 300 узлов');
  const seen = new Set();
  const nodes = raw.map((n) => {
    if (!n || typeof n !== 'object') throw new ApiError(400, 'nodes: неверный узел');
    const id = cleanText(String(n.id ?? ''), 64, 'node.id');
    if (seen.has(id)) throw new ApiError(400, 'nodes: дублирующийся id');
    seen.add(id);
    return {
      id,
      parentId: n.parentId == null ? null : String(n.parentId),
      title: cleanText(n.title ?? '', 200, 'node.title'),
      desc: cleanLongText(n.desc ?? '', 2000, 'node.desc'),
      order: Number.isInteger(n.order) && n.order >= 0 ? n.order : 0,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (n.parentId === null) continue;
    if (!byId.has(n.parentId)) throw new ApiError(400, 'nodes: parentId ссылается на несуществующий узел');
    let cur = n;
    const walked = new Set([n.id]);
    while (cur.parentId) {
      if (walked.has(cur.parentId)) throw new ApiError(400, 'nodes: цикл в дереве');
      walked.add(cur.parentId);
      cur = byId.get(cur.parentId);
    }
  }
  return nodes;
}

function deployScheme(project) {
  const nodes = project.scheme && Array.isArray(project.scheme.nodes) ? project.scheme.nodes : [];
  const byParent = new Map();
  for (const n of [...nodes].sort((a, b) => a.order - b.order)) {
    const key = n.parentId || null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(n);
  }
  const roots = byParent.get(null) || [];
  if (!roots.length) throw new ApiError(400, 'Схема пуста — нечего разворачивать');

  const created = { sections: 0, tasks: 0, subtasks: 0 };
  for (const root of roots) {
    let section = project.sections.find((s) => s.schemeRoot === root.id);
    if (!section) {
      section = { id: crypto.randomUUID(), name: root.title.slice(0, 200), schemeRoot: root.id };
      project.sections.push(section);
      created.sections++;
    }
    state.tasks = state.tasks.filter((t) => t.sectionId !== section.id);
    const now = Date.now();
    let order = 0;
    const children = byParent.get(root.id) || [];
    for (const node of children) {
      const task = {
        id: crypto.randomUUID(),
        projectId: project.id,
        sectionId: section.id,
        parentId: null,
        title: node.title,
        notes: '',
        done: false,
        due: null,
        createdAt: now + order,
        order,
      };
      state.tasks.push(task);
      created.tasks++;
      order++;
      const grand = byParent.get(node.id) || [];
      let subOrder = 0;
      for (const sub of grand) {
        const subTask = {
          id: crypto.randomUUID(),
          projectId: project.id,
          sectionId: section.id,
          parentId: task.id,
          title: sub.title,
          notes: '',
          done: false,
          due: null,
          createdAt: now + order * 100 + subOrder,
          order: subOrder,
        };
        state.tasks.push(subTask);
        created.subtasks++;
        subOrder++;
        const deep = byParent.get(sub.id) || [];
        if (deep.length) {
          const lines = deep.map((d) => '- ' + d.title + (d.desc ? ' — ' + d.desc : ''));
          subTask.notes = lines.join('\n').slice(0, 10000);
        }
      }
    }
  }
  return created;
}

function cleanGraph(raw) {
  if (!raw || typeof raw !== 'object') throw new ApiError(400, 'graph: ожидается объект');
  const nodesRaw = Array.isArray(raw.nodes) ? raw.nodes : [];
  const edgesRaw = Array.isArray(raw.edges) ? raw.edges : [];
  if (nodesRaw.length > 400) throw new ApiError(400, 'graph.nodes: не больше 400');
  if (edgesRaw.length > 800) throw new ApiError(400, 'graph.edges: не больше 800');
  const seen = new Set();
  const nodes = nodesRaw.map((n) => {
    if (!n || typeof n !== 'object') throw new ApiError(400, 'graph: неверный узел');
    const id = cleanText(String(n.id ?? ''), 64, 'graph node id');
    if (seen.has(id)) throw new ApiError(400, 'graph: дублирующийся id узла');
    seen.add(id);
    const type = n.type === 'text' ? 'text' : 'task';
    const title = cleanLongText(String(n.title ?? ''), 300, 'graph node title').trim() || (type === 'task' ? 'Новая задача' : 'Заметка');
    const text = cleanLongText(String(n.text ?? ''), 5000, 'graph node text');
    const x = Number.isFinite(Number(n.x)) ? Math.max(-10000, Math.min(10000, Number(n.x))) : 0;
    const y = Number.isFinite(Number(n.y)) ? Math.max(-10000, Math.min(10000, Number(n.y))) : 0;
    const w = Number.isFinite(Number(n.w)) ? Math.max(120, Math.min(800, Number(n.w))) : 220;
    const h = Number.isFinite(Number(n.h)) ? Math.max(60, Math.min(600, Number(n.h))) : 110;
    let color = '#ffffff';
    if (typeof n.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(n.color)) color = n.color.toLowerCase();
    else color = type === 'task' ? '#ffffff' : '#fff9c4';
    return { id, type, title, text, x, y, w, h, color };
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = [];
  const edgeSeen = new Set();
  for (const e of edgesRaw) {
    if (!e || typeof e !== 'object') throw new ApiError(400, 'graph: неверное ребро');
    const id = String(e.id ?? crypto.randomUUID()).slice(0, 64);
    const from = String(e.from ?? '');
    const to = String(e.to ?? '');
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
    if (from === to) continue;
    const key = from + '->' + to;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    edges.push({ id, from, to });
  }
  return { nodes, edges };
}

/* ---------- chat ---------- */

function cleanChatText(v) {
  if (typeof v !== 'string') throw new ApiError(400, 'text: ожидается строка');
  const t = v.trim();
  if (!t) throw new ApiError(400, 'text: не может быть пустым');
  if (t.length > 2000) throw new ApiError(400, 'text: не длиннее 2000 символов');
  return t;
}

function chatFilePath(fileId) {
  return path.join(CHAT_FILES_DIR, fileId);
}

function safeFileName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200) || 'file';
}

/* ---------- invites (только владелец) ---------- */

function isOwner(session) {
  return Boolean(session && CONFIG.ownerSub && session.sub === CONFIG.ownerSub);
}

let saTokenCache = { token: null, exp: 0 };

async function kcAdminToken() {
  if (saTokenCache.token && Date.now() < saTokenCache.exp - 30_000) return saTokenCache.token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
  });
  const res = await fetch(`${CONFIG.kcBaseUrl}/realms/${CONFIG.realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new ApiError(500, 'Keycloak: не получен сервисный токен');
  saTokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 60) * 1000 };
  return saTokenCache.token;
}

async function kcFindUser(username) {
  const token = await kcAdminToken();
  const res = await fetch(`${CONFIG.kcBaseUrl}/admin/realms/${CONFIG.realm}/users?username=${encodeURIComponent(username)}&exact=true`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new ApiError(500, 'Keycloak: поиск пользователя недоступен');
  return res.json();
}

async function kcCreateUser(username, password) {
  const existing = await kcFindUser(username);
  if (Array.isArray(existing) && existing.length) throw new ApiError(400, 'Такой логин уже существует');
  const token = await kcAdminToken();
  const body = {
    username,
    enabled: true,
    emailVerified: true,
    firstName: username.split('@')[0].slice(0, 50) || username,
    lastName: '-',
    credentials: [{ type: 'password', value: password, temporary: false }],
  };
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(username)) body.email = username;
  else body.email = username + '@local';
  const res = await fetch(`${CONFIG.kcBaseUrl}/admin/realms/${CONFIG.realm}/users`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 409) throw new ApiError(400, 'Такой логин уже существует');
  if (!res.ok) throw new ApiError(500, 'Keycloak: не удалось создать пользователя (' + res.status + ')');
  return true;
}

function cleanRedeemLogin(v) {
  if (typeof v !== 'string') throw new ApiError(400, 'login: ожидается строка');
  const t = v.trim().toLowerCase();
  if (!/^[a-z0-9._@+-]{3,100}$/.test(t)) throw new ApiError(400, 'login: 3-100 символов, буквы/цифры/._@+-');
  return t;
}

function cleanRedeemPassword(v) {
  if (typeof v !== 'string') throw new ApiError(400, 'password: ожидается строка');
  if (v.length < 8 || v.length > 100) throw new ApiError(400, 'password: от 8 до 100 символов');
  return v;
}

async function redeemInvite(code, username, password) {
  const inv = state.invites.find((x) => x.code === code);
  if (!inv) throw new ApiError(404, 'Приглашение не найдено');
  if (inv.usedBy) throw new ApiError(400, 'Приглашение уже использовано');
  const login = cleanRedeemLogin(username);
  const pass = cleanRedeemPassword(password);
  await kcCreateUser(login, pass);
  inv.usedBy = login;
  inv.usedAt = Date.now();
  saveState(state);
  return { ok: true };
}

/* ---------- API ---------- */

const api = {
  'GET /api/state': () => state,

  'GET /api/auth-info': (b, _pid, session) => ({
    accountUrl: `${CONFIG.kcBaseUrl}/realms/${CONFIG.realm}/account`,
    realm: CONFIG.realm,
    isOwner: isOwner(session),
    name: session.name,
    sub: session.sub,
  }),

  'GET /api/invites': (b, _pid, session) => {
    if (!isOwner(session)) throw new ApiError(403, 'Только владелец');
    return state.invites;
  },

  'POST /api/invites': (b, _pid, session) => {
    if (!isOwner(session)) throw new ApiError(403, 'Только владелец');
    const inv = {
      id: crypto.randomUUID(),
      code: crypto.randomBytes(16).toString('hex'),
      createdAt: Date.now(),
      createdBy: session.name,
      usedBy: null,
      usedAt: null,
    };
    state.invites.push(inv);
    return inv;
  },

  'DELETE /api/invites/:id': (b, iid, session) => {
    if (!isOwner(session)) throw new ApiError(403, 'Только владелец');
    const inv = state.invites.find((x) => x.id === iid);
    if (!inv) throw new ApiError(404, 'Приглашение не найдено');
    if (inv.usedBy) throw new ApiError(400, 'Использованное приглашение удалить нельзя');
    state.invites = state.invites.filter((x) => x.id !== iid);
    return { ok: true };
  },

  'POST /api/projects': (b) => {
    const name = cleanText(b.name, 200, 'name');
    const color = b.color !== undefined ? cleanColor(b.color) : '#f06a6a';
    const p = { id: crypto.randomUUID(), name, color, description: '', scheme: { nodes: [] }, graph: { nodes: [], edges: [] }, sections: [] };
    state.projects.push(p);
    return p;
  },

  'PATCH /api/projects/:id': (b, pid) => {
    const p = findProject(pid);
    if (b.name !== undefined) p.name = cleanText(b.name, 200, 'name');
    if (b.color !== undefined) p.color = cleanColor(b.color);
    if (b.description !== undefined) p.description = cleanLongText(b.description, 5000, 'description');
    return p;
  },

  'DELETE /api/projects/:id': (b, pid) => {
    const p = findProject(pid);
    state.projects = state.projects.filter((x) => x.id !== pid);
    const ids = new Set(p.sections.map((s) => s.id));
    const deadTasks = new Set(state.tasks.filter((t) => ids.has(t.sectionId)).map((t) => t.id));
    state.tasks = state.tasks.filter((t) => !deadTasks.has(t.id));
    state.comments = state.comments.filter((c) =>
      !(c.targetType === 'project' && c.targetId === pid) &&
      !(c.targetType === 'task' && deadTasks.has(c.targetId)));
    return { ok: true };
  },

  'POST /api/projects/:id/sections': (b, pid) => {
    const p = findProject(pid);
    const name = cleanText(b.name, 200, 'name');
    const s = { id: crypto.randomUUID(), name, schemeRoot: null };
    p.sections.push(s);
    return s;
  },

  'PATCH /api/sections/:id': (b, sid) => {
    const { section } = findSection(sid);
    if (b.name !== undefined) section.name = cleanText(b.name, 200, 'name');
    return section;
  },

  'DELETE /api/sections/:id': (b, sid) => {
    const { project } = findSection(sid);
    project.sections = project.sections.filter((s) => s.id !== sid);
    state.tasks = state.tasks.filter((t) => t.sectionId !== sid);
    return { ok: true };
  },

  'PUT /api/projects/:id/scheme': (b, pid) => {
    const p = findProject(pid);
    p.scheme = { nodes: cleanSchemeNodes(b.nodes), updatedAt: Date.now() };
    return p.scheme;
  },

  'POST /api/projects/:id/deploy-scheme': (b, pid) => {
    const p = findProject(pid);
    const created = deployScheme(p);
    saveState(state);
    return { ok: true, ...created };
  },

  'PUT /api/projects/:id/graph': (b, pid) => {
    const p = findProject(pid);
    p.graph = cleanGraph(b);
    return p.graph;
  },

  'POST /api/tasks': (b) => {
    const { section } = findSection(b.sectionId);
    const owner = state.projects.find((p) => p.sections.includes(section));
    if (!owner) throw new ApiError(500, 'Целостность данных нарушена: секция без проекта');
    const title = cleanText(b.title, 500, 'title');
    let parentId = null;
    if (b.parentId != null) parentId = validateParent(b.parentId, section.id);
    const list = orderedGroup(section.id, parentId);
    const t = {
      id: crypto.randomUUID(),
      projectId: owner.id,
      sectionId: section.id,
      parentId,
      title,
      notes: '',
      done: false,
      due: null,
      createdAt: Date.now(),
      order: list.length,
    };
    state.tasks.push(t);
    return t;
  },

  'PATCH /api/tasks/:id': (b, tid) => {
    const t = findTask(tid);
    if (b.title !== undefined) t.title = cleanText(b.title, 500, 'title');
    if (b.notes !== undefined) t.notes = cleanLongText(b.notes, 10000, 'notes');
    if (b.done !== undefined) {
      if (typeof b.done !== 'boolean') throw new ApiError(400, 'done: ожидается boolean');
      t.done = b.done;
    }
    if (b.due !== undefined) t.due = cleanDue(b.due);
    return t;
  },

  'DELETE /api/tasks/:id': (b, tid) => {
    const t = findTask(tid);
    const doomed = new Set([t.id]);
    for (const c of state.tasks) if (c.parentId === t.id) doomed.add(c.id);
    state.tasks = state.tasks.filter((x) => !doomed.has(x.id));
    state.comments = state.comments.filter((c) => !(c.targetType === 'task' && doomed.has(c.targetId)));
    return { ok: true };
  },

  'POST /api/tasks/move': (b) => {
    const t = findTask(b.taskId);
    const dst = findSection(b.sectionId);
    t.projectId = dst.project.id;
    t.sectionId = dst.section.id;
    let parentId = null;
    if (b.parentId != null) {
      const parent = findTask(b.parentId);
      if (parent.sectionId !== dst.section.id) throw new ApiError(400, 'parentId: родитель из другой секции');
      if (parent.parentId) throw new ApiError(400, 'parentId: вложенность глубже двух уровней запрещена');
      if (parent.id === t.id) throw new ApiError(400, 'parentId: нельзя родить себя');
      parentId = parent.id;
    }
    t.parentId = parentId;
    const list = orderedGroup(dst.section.id, parentId).filter((x) => x.id !== t.id);
    let index = list.length;
    if (typeof b.beforeTaskId === 'string') {
      const i = list.findIndex((x) => x.id === b.beforeTaskId);
      if (i === -1) throw new ApiError(400, 'beforeTaskId: задача не найдена рядом');
      index = i;
    }
    list.splice(index, 0, t);
    list.forEach((x, i) => { x.order = i; });
    renumberSection(dst.section.id);
    return t;
  },

  'POST /api/comments': (b, _pid, session) => {
    const targetType = b.targetType;
    if (targetType !== 'project' && targetType !== 'task') throw new ApiError(400, 'targetType: project|task');
    const targetId = cleanText(b.targetId, 64, 'targetId');
    if (targetType === 'project') findProject(targetId); else findTask(targetId);
    const text = cleanText(b.text, 2000, 'text');
    const c = {
      id: crypto.randomUUID(),
      targetType,
      targetId,
      author: session.name,
      text,
      createdAt: Date.now(),
    };
    state.comments.push(c);
    return c;
  },

  'DELETE /api/comments/:id': (b, cid) => {
    const c = state.comments.find((x) => x.id === cid);
    if (!c) throw new ApiError(404, 'Комментарий не найден');
    state.comments = state.comments.filter((x) => x.id !== cid);
    return { ok: true };
  },

  'GET /api/chat': () => state.chat.slice(-200),

  'POST /api/chat': (b, _pid, session) => {
    const text = cleanChatText(b.text);
    const m = {
      id: crypto.randomUUID(),
      author: session.name,
      authorSub: session.sub,
      text,
      createdAt: Date.now(),
    };
    state.chat.push(m);
    if (state.chat.length > 500) state.chat.splice(0, state.chat.length - 500);
    return m;
  },

  'DELETE /api/chat/:id': (b, cid, session) => {
    const m = state.chat.find((x) => x.id === cid);
    if (!m) throw new ApiError(404, 'Сообщение не найдено');
    if (m.authorSub !== session.sub && !isOwner(session)) throw new ApiError(403, 'Можно удалить только своё сообщение');
    state.chat = state.chat.filter((x) => x.id !== cid);
    if (m.file && m.file.fileId) {
      try { fs.unlinkSync(chatFilePath(m.file.fileId)); } catch {}
      try { fs.unlinkSync(chatFilePath(m.file.fileId + '.meta')); } catch {}
    }
    return { ok: true };
  },
};

function matchApi(method, pathname) {
  const exact = api[`${method} ${pathname}`];
  if (exact) return (b, session) => exact(b, undefined, session);
  for (const key of Object.keys(api)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const seg = pattern.split('/');
    const cur = pathname.split('/');
    if (seg.length !== cur.length) continue;
    let captured = null;
    let ok = true;
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] === ':id') { captured = cur[i]; continue; }
      if (seg[i] !== cur[i]) { ok = false; break; }
    }
    if (ok && captured && /^[0-9a-fA-F-]{6,64}$/.test(captured)) {
      return (b, session) => api[key](b, captured, session);
    }
  }
  return null;
}

/* ---------- static ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function setSecHeaders(res) {
  try {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'interest-cohort=()');
    res.removeHeader('X-Powered-By');
  } catch {}
}
function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  setSecHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function redirect(res, url) {
  setSecHeaders(res);
  res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
  res.end();
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return sendJson(res, 400, { error: 'Некорректный URL' });
  }
  if (decoded.includes('\0')) return sendJson(res, 400, { error: 'Некорректный URL' });
  const filePath = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'Доступ запрещён' });
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'Не найдено' });
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    setSecHeaders(res);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        if (!finished) {
          finished = true;
          reject(new ApiError(413, 'Тело запроса слишком большое'));
          req.pause();
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError(400, 'Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ---------- auth routes ---------- */

function appOriginOf(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${CONFIG.port}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

async function handleLogin(req, res) {
  // уже вошли — не гоняем по кругу через Keycloak
  const existing = auth.getSession(req);
  if (existing) return redirect(res, '/');

  const appOrigin = appOriginOf(req);
  const kcOrigin = auth.kcPublicOrigin(appOrigin);
  const stateVal = crypto.randomBytes(16).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = auth.b64url(crypto.createHash('sha256').update(verifier).digest());
  auth.setCookie(res, auth.OIDC_COOKIE, JSON.stringify({ state: stateVal, nonce, verifier, appOrigin, kcOrigin }), { maxAge: 600_000 });
  redirect(res, auth.authorizeUrl(kcOrigin, appOrigin + '/callback', stateVal, nonce, challenge));
}

async function handleCallback(req, res, url) {
  let pending = null;
  try {
    pending = JSON.parse(auth.parseCookies(req).get(auth.OIDC_COOKIE) || 'null');
  } catch { pending = null; }
  auth.setCookie(res, auth.OIDC_COOKIE, '', { expire: true });
  const err = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  // устаревшая/чужая попытка (вторая вкладка, старая ссылка) — просто начинаем заново
  if (err || !pending || !code || !returnedState || returnedState !== pending.state) {
    return redirect(res, '/login');
  }
  try {
    const tokens = await auth.exchangeCode(code, pending.verifier, pending.appOrigin + '/callback');
    const payload = await auth.verifyIdToken(tokens.id_token, pending.nonce, pending.kcOrigin + '/realms/' + CONFIG.realm);
    const sid = auth.newSession({ sub: payload.sub, name: payload.preferred_username || payload.sub, idToken: tokens.id_token });
    auth.setCookie(res, auth.SESSION_COOKIE, sid, { maxAge: 7 * 24 * 3600 * 1000 });
    redirect(res, '/');
  } catch (e) {
    sendJson(res, 401, { error: 'Вход не удался: ' + e.message + '. Начните заново с ' + (pending && pending.appOrigin ? pending.appOrigin + '/' : '/') });
  }
}

function handleLogout(req, res) {
  const session = auth.getSession(req);
  if (session) auth.destroySession(session.sid);
  auth.setCookie(res, auth.SESSION_COOKIE, '', { expire: true });
  redirect(res, auth.logoutUrl(session && session.idToken));
}

/* ---------- server ---------- */

process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {    if (pathname === '/login') return handleLogin(req, res);
    if (pathname === '/callback') return handleCallback(req, res, url);
    if (pathname === '/logout') return handleLogout(req, res);

    // публичная страница и API приглашения (код = пропуск)
    if (req.method === 'GET' && pathname.startsWith('/invite/')) {
      return serveStatic(req, res, '/invite.html');
    }
    if (req.method === 'POST' && pathname === '/api/invite-redeem') {
      const body = await readBody(req);
      const result = await redeemInvite(String(body.code || ''), body.username, body.password);
      return sendJson(res, 200, result);
    }

    const session = auth.getSession(req);
    if (!session) {
      if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Требуется вход' });
      return redirect(res, '/login');
    }

    if (pathname.startsWith('/api/')) {
      // chat file download — мгновенно, без задержки
      if (req.method === 'GET' && pathname.startsWith('/api/chat/file/')) {
        const fileId = pathname.slice('/api/chat/file/'.length).split('/')[0];
        if (!/^[0-9a-fA-F-]{6,64}$/.test(fileId)) return sendJson(res, 400, { error: 'Неверный id файла' });
        const metaPath = chatFilePath(fileId + '.meta');
        const filePath = chatFilePath(fileId);
        try {
          const metaRaw = fs.readFileSync(metaPath, 'utf8');
          const meta = JSON.parse(metaRaw);
          const stat = fs.statSync(filePath);
          setSecHeaders(res);
          res.writeHead(200, {
            'Content-Type': meta.type || 'application/octet-stream',
            'Content-Length': stat.size,
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name).replace(/'/g, '%27')}`,
            'Cache-Control': 'private, max-age=31536000',
            'X-Content-Type-Options': 'nosniff',
          });
          return fs.createReadStream(filePath).pipe(res);
        } catch {
          return sendJson(res, 404, { error: 'Файл не найден' });
        }
      }
      // chat file upload — без лимитов (до 2GB), стриминг, мгновенно
      if (req.method === 'POST' && pathname === '/api/chat/file') {
        const rawName = req.headers['x-filename'] ? String(req.headers['x-filename']) : 'file';
        let name;
        try { name = safeFileName(decodeURIComponent(rawName)); } catch { name = safeFileName(rawName); }
        const type = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 200);
        const fileId = crypto.randomUUID();
        const filePath = chatFilePath(fileId);
        const metaPath = chatFilePath(fileId + '.meta');
        let size = 0;
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(filePath);
          req.on('data', (chunk) => {
            size += chunk.length;
            if (size > CHAT_FILE_LIMIT) {
              ws.destroy();
              try { fs.unlinkSync(filePath); } catch {}
              reject(new ApiError(413, 'Файл слишком большой (лимит 2GB)'));
            }
          });
          req.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
          req.on('error', reject);
        });
        const meta = { name, type, size, uploadedBy: session.name, uploadedAt: Date.now() };
        fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
        let text = '';
        const rawText = req.headers['x-text'];
        if (rawText) {
          try { text = decodeURIComponent(String(rawText)); } catch { text = String(rawText); }
          if (text) text = cleanLongText(text, 2000, 'text');
        }
        const m = {
          id: crypto.randomUUID(),
          author: session.name,
          authorSub: session.sub,
          text: text || '',
          file: { fileId, name, size, type, url: '/api/chat/file/' + fileId },
          createdAt: Date.now(),
        };
        state.chat.push(m);
        if (state.chat.length > 500) {
          const removed = state.chat.splice(0, state.chat.length - 500);
          for (const r of removed) if (r.file && r.file.fileId) { try { fs.unlinkSync(chatFilePath(r.file.fileId)); } catch {} try { fs.unlinkSync(chatFilePath(r.file.fileId + '.meta')); } catch {} }
        }
        saveState(state);
        return sendJson(res, 200, m);
      }
      const cleanPath = pathname.endsWith('/') && pathname !== '/api/' ? pathname.slice(0, -1) : pathname;
      const handler = matchApi(req.method, cleanPath);
      if (!handler) return sendJson(res, 404, { error: 'Метод API не найден' });
      if (req.method === 'GET') {
        return sendJson(res, 200, handler(undefined, session));
      }
      const body = await readBody(req);
      const result = handler(body, session);
      saveState(state);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }
    return sendJson(res, 405, { error: 'Метод не поддерживается' });
  } catch (err) {
    if (err instanceof ApiError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    return sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request' + String.fromCharCode(13,10,13,10));

});

function start(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      start(port + 1, attemptsLeft - 1);
    } else {
      console.error('Не удалось запустить сервер:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    console.log(`Asana Lite запущен: http://${HOST}:${port}`);
    console.log('Вход через Keycloak (' + CONFIG.kcBaseUrl + '), realm ' + CONFIG.realm);
    console.log('Остановить: Ctrl+C.');
  });
}

start(PORT, 10);
