'use strict';

/* ---------- state ---------- */

let state = { projects: [], tasks: [], comments: [] };
let current = { view: 'mytasks', projectId: null, tab: 'list' };
let pane = { type: null, id: null }; // 'task' | 'project'
let searchQuery = '';
let showDoneInMy = false;
let collapsedSections = new Set(JSON.parse(localStorage.getItem('al-collapsed') || '[]'));
let collapsedTasks = new Set(JSON.parse(localStorage.getItem('al-tcollapsed') || '[]'));
let isOwnerUser = false;
let currentUser = { name: '', sub: '' };
let graphState = { pan: { x: 0, y: 0 }, zoom: 1, selected: null, connecting: null, dragging: null };
const PALETTE = ['#f06a6a', '#4573d2', '#58a182', '#f1bd2c', '#a95db2', '#646f79'];

let chatMessages = [];
let chatUnread = 0;
let chatOpen = false;
let chatPollTimer = null;
let chatLastIds = new Set();
let chatSoundEnabled = JSON.parse(localStorage.getItem('al-chat-sound') ?? 'true');
let selectedVoiceURI = localStorage.getItem('al-chat-voice') || '';
let themeMode = localStorage.getItem('al-theme') || 'light';
let chatMode = localStorage.getItem('al-chat-mode') || 'panel'; // panel | window | page
let chatSoundMode = localStorage.getItem('al-chat-sound-mode') || 'both'; // both | classic | anime | off
let customAccent = localStorage.getItem('al-custom-accent') || '';
let customBg = localStorage.getItem('al-custom-bg') || '';
let customText = localStorage.getItem('al-custom-text') || '';
let customFont = localStorage.getItem('al-custom-font') || '';
let accountUrl = '';

function uuid() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch(e) {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8);
    return v.toString(16);
  });
}

function persistUi() {
  localStorage.setItem('al-current', JSON.stringify(current));
  localStorage.setItem('al-collapsed', JSON.stringify([...collapsedSections]));
  localStorage.setItem('al-tcollapsed', JSON.stringify([...collapsedTasks]));
}

/* ---------- theme ---------- */

function applyTheme(mode) {
  themeMode = mode;
  localStorage.setItem('al-theme', mode);
  let effective = mode;
  if (mode === 'auto') effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', effective);
  const sel = document.getElementById('theme-select');
  if (sel) sel.value = mode;
  applyCustomColors();
}

function applyCustomColors() {
  const root = document.documentElement;
  if (customAccent) root.style.setProperty('--accent', customAccent);
  else root.style.removeProperty('--accent');
  if (customBg) root.style.setProperty('--bg', customBg);
  else root.style.removeProperty('--bg');
  if (customText) root.style.setProperty('--text', customText);
  else root.style.removeProperty('--text');
  if (customFont) root.style.setProperty('--font', customFont);
  else root.style.removeProperty('--font');
  // heading follows font unless custom
  if (customFont) root.style.setProperty('--font-heading', customFont);
  else root.style.removeProperty('--font-heading');
}

(function initThemeEarly() {
  applyTheme(themeMode);
  applyCustomColors();
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themeMode === 'auto') applyTheme('auto'); });
  } catch {}
})();

/* ---------- api ---------- */

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('Нет связи с сервером');
  }
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Требуется вход');
  }
  let data = {};
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) throw new Error(data.error || ('Ошибка ' + res.status));
  return data;
}

const getState = () => api('GET', '/api/state');

async function act(fn) {
  try {
    await fn();
    await refresh();
    return true;
  } catch (e) {
    showToast(e.message || 'Неизвестная ошибка');
    return false;
  }
}

async function refresh() {
  state = await getState();
  if (Array.isArray(state.chat)) {
    const prevLast = chatMessages.length ? chatMessages[chatMessages.length - 1]?.id : null;
    chatMessages = state.chat.slice(-200);
    // detect new from others even via /api/state poll (rare)
    const newOnes = chatMessages.filter(m => !chatLastIds.has(m.id));
    if (newOnes.length) {
      const hasNewFromOthers = newOnes.some(m => m.authorSub !== currentUser.sub && m.author !== currentUser.name);
      for (const m of newOnes) chatLastIds.add(m.id);
      if (hasNewFromOthers && !chatOpen) {
        chatUnread += newOnes.filter(m => m.authorSub !== currentUser.sub && m.author !== currentUser.name).length;
        playChatSound();
        showToast('New message: ' + newOnes.find(m => m.authorSub !== currentUser.sub).author);
      }
      if (chatOpen) renderChat();
      else if (chatUnread) { const b = document.getElementById('chat-badge'); if (b) { b.textContent = String(chatUnread > 99 ? '99+' : chatUnread); b.hidden = false; } }
    }
  }
  render();
}

/* ---------- dom helpers ---------- */

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const SVG = {
  check: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  caret: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  home: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2.5 7L8 2.5L13.5 7V13A0.9 0.9 0 0 1 12.6 13.9H9.8V10H6.2V13.9H3.4A0.9 0.9 0 0 1 2.5 13V7Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
};

/* ---------- misc ---------- */

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._tm);
  showToast._tm = setTimeout(() => { t.hidden = true; }, 3200);
}

function localISO(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function dueInfo(due, done) {
  if (!due) return null;
  const today = localISO(new Date());
  const diff = Math.round((new Date(due + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
  let txt;
  if (diff === 0) txt = 'Сегодня';
  else if (diff === 1) txt = 'Завтра';
  else if (diff === -1) txt = 'Вчера';
  else txt = new Date(due + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  let cls = 'due';
  if (!done && diff < 0) cls += ' overdue';
  else if (!done && diff === 0) cls += ' today';
  return { txt, cls };
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function matchesSearch(task) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return true;
  return task.title.toLowerCase().includes(q) || task.notes.toLowerCase().includes(q);
}

function childrenOf(taskId) {
  return state.tasks
    .filter((t) => t.parentId === taskId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

function sectionTopTasks(sectionId) {
  return state.tasks
    .filter((t) => t.sectionId === sectionId && !t.parentId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

function subBadge(task) {
  const kids = childrenOf(task.id);
  if (!kids.length) return null;
  const done = kids.filter((k) => k.done).length;
  return { done, total: kids.length };
}

function findProject(pid) { return state.projects.find((p) => p.id === pid); }
function firstSectionOf(pid) { const p = findProject(pid); return p && p.sections[0]; }

/* ---------- menus ---------- */

function closeMenus() { document.getElementById('menu-layer').replaceChildren(); }

function openMenu(anchor, items) {
  const layer = document.getElementById('menu-layer');
  closeMenus();
  const rect = anchor.getBoundingClientRect();
  const menu = el('div', { class: 'menu' });
  for (const item of items) {
    if (item.sep) { menu.append(el('div', { class: 'menu-sep' })); continue; }
    if (item.palette) {
      menu.append(el('div', { class: 'palette' },
        ...PALETTE.map((color) =>
          el('button', {
            type: 'button',
            style: 'background:' + color,
            class: color === item.current ? 'sel' : '',
            onclick: () => { closeMenus(); item.action(color); },
          }))));
      continue;
    }
    menu.append(el('button', {
      type: 'button',
      class: 'menu-item' + (item.danger ? ' danger' : ''),
      onclick: () => { closeMenus(); item.action(); },
    }, item.label));
  }
  layer.append(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = Math.min(rect.left, window.innerWidth - mw - 8);
  let y = rect.bottom + 6;
  if (y + mh > window.innerHeight - 8) y = Math.max(8, rect.top - mh - 6);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu')) closeMenus();
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.querySelector('#menu-layer .menu')) { closeMenus(); return; }
    closePane();
  }
});

/* ---------- check button ---------- */

function checkBtn(task) {
  return el('button', {
    type: 'button',
    class: 'check' + (task.done ? ' checked' : ''),
    title: task.done ? 'Отметить невыполненной' : 'Отметить выполненной',
    html: task.done ? SVG.check : '',
    onclick: (e) => { e.stopPropagation(); act(() => api('PATCH', '/api/tasks/' + task.id, { done: !task.done })); },
  });
}

function dueChip(task) {
  const info = dueInfo(task.due, task.done);
  return info ? el('span', { class: info.cls }, info.txt) : null;
}

/* ---------- drag & drop ---------- */

function clearDropMarks(root) {
  root.querySelectorAll('.drop-before,.drop-after,.drop-end').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-end'));
}

function nextTopTaskIdAfter(row) {
  const group = row.closest('.top-group');
  if (!group) return null;
  let n = group.nextElementSibling;
  while (n) {
    const r = n.querySelector && n.querySelector(':scope > .task-row');
    if (r) return r.dataset.taskId;
    n = n.nextElementSibling;
  }
  return null;
}

function nextSubTaskIdAfter(row) {
  let n = row.nextElementSibling;
  while (n) {
    if (n.classList && n.classList.contains('task-row')) return n.dataset.taskId;
    n = n.nextElementSibling;
  }
  return null;
}

function wireDragRow(row, ctxFn, isSub) {
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', row.dataset.taskId);
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => row.classList.add('dragging'));
  });
  row.addEventListener('dragend', () => { row.classList.remove('dragging'); clearDropMarks(document.getElementById('content')); });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = row.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    clearDropMarks(document.getElementById('content'));
    row.classList.add(before ? 'drop-before' : 'drop-after');
    row._dropPos = before ? 'before' : 'after';
  });
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ctx = ctxFn();
    const before = row._dropPos === 'before';
    const beforeTaskId = isSub
      ? (before ? row.dataset.taskId : nextSubTaskIdAfter(row))
      : (before ? row.dataset.taskId : nextTopTaskIdAfter(row));
    handleDrop(e, ctx, beforeTaskId);
  });
}

function wireDropZone(zone, ctxFn) {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks(document.getElementById('content'));
    zone.classList.add('drop-end');
  });
  zone.addEventListener('dragleave', (e) => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('drop-end');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    handleDrop(e, ctxFn(), null);
  });
}

function handleDrop(e, ctx, beforeTaskId) {
  clearDropMarks(document.getElementById('content'));
  const taskId = e.dataTransfer.getData('text/plain');
  if (!taskId || !ctx || !ctx.sectionId) return;
  if (taskId === beforeTaskId) return;
  act(() => api('POST', '/api/tasks/move', {
    taskId,
    sectionId: ctx.sectionId,
    parentId: ctx.parentId,
    beforeTaskId,
  }));
}

/* ---------- rows & cards ---------- */

function taskRow(task, isSub) {
  const row = el('div', {
    class: 'task-row' + (task.done ? ' done' : '') + (isSub ? ' sub' : ''),
    draggable: 'true',
    dataset: { taskId: task.id },
    onclick: () => openTask(task.id),
  },
    checkBtn(task),
    el('span', { class: 't-title' }, task.title),
    dueChip(task),
    el('button', {
      type: 'button', class: 'icon-btn t-del', title: 'Удалить задачу', html: '&#10005;',
      onclick: (e) => {
        e.stopPropagation();
        if (pane.type === 'task' && pane.id === task.id) closePane();
        act(() => api('DELETE', '/api/tasks/' + task.id));
      },
    }));
  wireDragRow(row, () => ({ sectionId: task.sectionId, parentId: isSub ? task.parentId : null }), isSub);
  return row;
}

function topGroup(task) {
  const kids = childrenOf(task.id);
  const isCollapsed = collapsedTasks.has(task.id) && !searchQuery.trim();
  const group = el('div', { class: 'top-group' }, taskRow(task, false));
  if (!kids.length) return group;

  const head = group.firstChild;
  const caret = el('button', {
    type: 'button',
    class: 'caret mini' + (isCollapsed ? ' collapsed' : ''),
    html: SVG.caret,
    title: isCollapsed ? 'Показать подзадачи' : 'Скрыть подзадачи',
    onclick: (e) => {
      e.stopPropagation();
      collapsedTasks.has(task.id) ? collapsedTasks.delete(task.id) : collapsedTasks.add(task.id);
      persistUi();
      renderMain();
      if (pane.type === 'task' && pane.id === task.id) renderPane();
    },
  });
  head.insertBefore(caret, head.firstChild);
  head.querySelector('.t-title').classList.add('has-kids');

  if (isCollapsed) return group;

  const wrap = el('div', { class: 'sub-wrap' });
  for (const k of kids) {
    if (searchQuery.trim() && !matchesSearch(k) && !matchesSearch(task)) continue;
    wrap.append(taskRow(k, true));
  }
  if (wrap.childNodes.length) {
    wireDropZone(wrap, () => ({ sectionId: task.sectionId, parentId: task.id }));
    group.append(wrap);
  }
  return group;
}

function cardNode(task) {
  const badge = subBadge(task);
  const card = el('div', {
    class: 'card' + (task.done ? ' done' : ''),
    draggable: 'true',
    dataset: { taskId: task.id },
    onclick: () => openTask(task.id),
  },
    el('div', { class: 'card-top' },
      checkBtn(task),
      el('span', { class: 'card-title' }, task.title)),
    el('div', { class: 'card-meta' },
      badge ? el('span', { class: 'sub-badge' + (badge.done === badge.total ? ' all' : '') }, '☑ ' + badge.done + '/' + badge.total) : null,
      dueChip(task)));
  wireDragRow(card, () => ({ sectionId: task.sectionId, parentId: null }), false);
  return card;
}

/* ---------- inline inputs ---------- */

function inlineInput(opts) {
  const input = el('input', { class: opts.class || '', placeholder: opts.placeholder || '', autocomplete: 'off' });
  let busy = false;
  async function commit() {
    const value = input.value.trim();
    if (busy) return;
    if (!value) { if (opts.onCancel) opts.onCancel(); return; }
    busy = true;
    const ok = await act(() => opts.onSubmit(value));
    busy = false;
    if (ok && opts.refocusSelector) {
      const again = document.querySelector(opts.refocusSelector);
      if (again) again.focus();
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape' && opts.onCancel) opts.onCancel();
  });
  if (opts.blurCommit !== false) input.addEventListener('blur', () => commit());
  if (opts.autofocus) setTimeout(() => input.focus(), 30);
  return input;
}

function addTaskRow(sectionId, parentId, refocusSel) {
  const input = inlineInput({
    class: 'add-task-input',
    placeholder: parentId ? '+ Добавить подзадачу' : '+ Добавить задачу',
    autofocus: !!refocusSel,
    onSubmit: (title) => api('POST', '/api/tasks', { sectionId, parentId, title }),
    refocusSelector: refocusSel,
  });
  return el('div', { class: 'plus-row' + (parentId ? ' in-sub' : '') }, input);
}

function addSectionControl(projectId, asColumn) {
  const btnText = '+ Добавить секцию';
  function start() {
    wrap.replaceChildren(inlineInput({
      class: 'add-task-input',
      placeholder: 'Название секции',
      autofocus: true,
      onCancel: () => rebuild(),
      onSubmit: (name) => api('POST', '/api/projects/' + projectId + '/sections', { name }),
    }));
    const input = wrap.firstChild;
    input.style.maxWidth = asColumn ? '240px' : '300px';
  }
  function rebuild() {
    wrap.replaceChildren(asColumn
      ? el('div', { style: 'padding:20px;' }, el('button', { type: 'button', class: 'ghost-btn', onclick: start }, btnText))
      : el('button', { type: 'button', class: 'ghost-btn', onclick: start }, btnText));
  }
  const wrap = asColumn ? el('div', { class: 'add-col' }) : el('div', { class: 'bottom-actions' });
  rebuild();
  return wrap;
}

/* ---------- comments ---------- */

function commentsFor(targetType, targetId) {
  return state.comments
    .filter((c) => c.targetType === targetType && c.targetId === targetId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function commentsBlock(targetType, targetId) {
  const list = commentsFor(targetType, targetId);
  const holder = el('div', { class: 'comments' });

  function rebuild() {
    holder.replaceChildren(
      el('div', { class: 'notes-label' }, 'Обсуждение (' + list.length + ')'),
      ...list.map((c) =>
        el('div', { class: 'comment' },
          el('div', { class: 'comment-head' },
            el('span', { class: 'comment-author' }, c.author),
            el('span', { class: 'comment-time' }, fmtTime(c.createdAt)),
            el('button', {
              type: 'button', class: 'icon-btn', title: 'Удалить комментарий', html: '&#10005;',
              onclick: () => act(() => api('DELETE', '/api/comments/' + c.id)).then(rebuild),
            })),
          el('div', { class: 'comment-text' }, c.text))),
      ...(list.length ? [] : [el('div', { class: 'comment-empty' }, 'Комментариев пока нет.')]));
  }
  rebuild();

  const input = el('textarea', { class: 'comment-input', placeholder: 'Добавить комментарий...' });
  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const ok = await act(() => api('POST', '/api/comments', { targetType, targetId, text }));
    if (ok) {
      const fresh = commentsFor(targetType, targetId);
      holder.replaceChildren();
      holder.append(...commentsBlockInner(fresh, () => rebuild()));
      holder.prepend(el('div', { class: 'notes-label' }, 'Обсуждение (' + fresh.length + ')'));
      if (!fresh.length) holder.append(el('div', { class: 'comment-empty' }, 'Комментариев пока нет.'));
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  const sendBtn = el('button', { type: 'button', class: 'ghost-btn send', title: 'Отправить', html: '&#10148;', onclick: send });

  return el('div', { class: 'comments-wrap' }, holder, el('div', { class: 'comment-row' }, input, sendBtn));
}

function commentsBlockInner(list, rebuild) {
  return list.map((c) =>
    el('div', { class: 'comment' },
      el('div', { class: 'comment-head' },
        el('span', { class: 'comment-author' }, c.author),
        el('span', { class: 'comment-time' }, fmtTime(c.createdAt)),
        el('button', {
          type: 'button', class: 'icon-btn', title: 'Удалить комментарий', html: '&#10005;',
          onclick: () => act(() => api('DELETE', '/api/comments/' + c.id)).then(rebuild),
        })),
      el('div', { class: 'comment-text' }, c.text)));
}

/* ---------- scheme view ---------- */

function schemeOf(project) {
  if (!project.scheme || !Array.isArray(project.scheme.nodes)) project.scheme = { nodes: [] };
  return project.scheme;
}

let schemeSaveTimer = null;

function scheduleSchemeSave(project) {
  const ind = document.getElementById('save-ind');
  if (ind) { ind.textContent = 'Сохранение...'; ind.hidden = false; }
  clearTimeout(schemeSaveTimer);
  schemeSaveTimer = setTimeout(async () => {
    try {
      await api('PUT', '/api/projects/' + project.id + '/scheme', { nodes: schemeOf(project).nodes });
      if (ind) { ind.textContent = 'Сохранено ✓'; setTimeout(() => { if (ind) ind.hidden = true; }, 1500); }
    } catch (e) {
      showToast(e.message);
      if (ind) ind.hidden = true;
    }
  }, 700);
}

function schemeChildren(project, nodeId) {
  return schemeOf(project).nodes
    .filter((n) => n.parentId === nodeId)
    .sort((a, b) => a.order - b.order || 0);
}

function schemeNodeOps(project, node) {
  const nodes = schemeOf(project).nodes;
  const siblings = () => schemeChildren(project, node.parentId);
  return {
    addChild() {
      nodes.push({ id: uuid(), parentId: node.id, title: 'Новый шаг', desc: '', order: schemeChildren(project, node.id).length });
      scheduleSchemeSave(project);
      renderMain();
    },
    addSibling() {
      const sib = siblings();
      nodes.push({ id: uuid(), parentId: node.parentId, title: 'Новый шаг', desc: '', order: sib.length });
      scheduleSchemeSave(project);
      renderMain();
    },
    move(dir) {
      const sib = siblings();
      const i = sib.findIndex((x) => x.id === node.id);
      const j = i + dir;
      if (j < 0 || j >= sib.length) return;
      [sib[i], sib[j]] = [sib[j], sib[i]];
      sib.forEach((x, k) => { x.order = k; });
      scheduleSchemeSave(project);
      renderMain();
    },
    remove() {
      if (!confirm('Удалить узел «' + node.title + '» и все его подшаги?')) return;
      const doomed = new Set([node.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of nodes) {
          if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) { doomed.add(n.id); grew = true; }
        }
      }
      schemeOf(project).nodes = nodes.filter((n) => !doomed.has(n.id));
      scheduleSchemeSave(project);
      renderMain();
    },
  };
}

function schemeNodeEl(project, node, depth) {
  const ops = schemeNodeOps(project, node);
  const kids = schemeChildren(project, node.id);

  const titleEl = el('span', {
    class: 'node-title',
    title: 'Нажмите, чтобы изменить',
    onclick: () => {
      const input = el('input', { class: 'rename-input', value: node.title });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = node.title; input.blur(); }
      });
      input.addEventListener('blur', () => {
        const v = input.value.trim();
        if (v && v !== node.title) { node.title = v; scheduleSchemeSave(project); }
        renderMain();
      });
      titleEl.replaceWith(input);
      input.focus();
      input.select();
    },
  }, node.title);

  const descEl = el('div', {
    class: 'node-desc' + (node.desc ? '' : ' empty'),
    onclick: () => {
      const ta = el('textarea', { class: 'node-desc-edit', placeholder: 'Что и как делается на этом шаге...' });
      ta.value = node.desc || '';
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) ta.blur(); });
      ta.addEventListener('blur', () => {
        const v = ta.value.trim();
        if (v !== (node.desc || '')) { node.desc = v; scheduleSchemeSave(project); }
        renderMain();
      });
      descEl.replaceWith(ta);
      ta.focus();
    },
  }, node.desc || 'описать: что и как делается...');

  const row = el('div', { class: 'node-row' },
    el('button', { type: 'button', class: 'icon-btn tiny', title: 'Добавить подшаг', html: '&#65291;', onclick: ops.addChild }),
    el('div', { class: 'node-body' }, titleEl, descEl),
    el('div', { class: 'node-ops' },
      el('button', { type: 'button', class: 'icon-btn tiny', title: 'Вверх', html: '&uarr;', onclick: () => ops.move(-1) }),
      el('button', { type: 'button', class: 'icon-btn tiny', title: 'Вниз', html: '&darr;', onclick: () => ops.move(1) }),
      el('button', { type: 'button', class: 'icon-btn tiny', title: 'Добавить шаг рядом', html: '&#43;&#43;', onclick: ops.addSibling }),
      el('button', { type: 'button', class: 'icon-btn tiny danger', title: 'Удалить', html: '&#10005;', onclick: ops.remove })));

  const wrap = el('div', { class: 'scheme-node depth-' + Math.min(depth, 5) }, row);
  if (kids.length) {
    wrap.append(el('div', { class: 'scheme-children' }, ...kids.map((k) => schemeNodeEl(project, k, depth + 1))));
  }
  return wrap;
}

function schemeView(project) {
  const nodes = schemeOf(project).nodes;
  const roots = schemeChildren(project, null);

  const toolbar = el('div', { class: 'scheme-toolbar' },
    el('span', { class: 'save-ind', id: 'save-ind', hidden: true }),
    el('span', { class: 'scheme-hint' }, 'Схема не обязательна: опишите шаги «что за чем и как», либо просто ведите задачи списком и комментируйте.'),
    el('button', {
      type: 'button', class: 'ghost-btn',
      onclick: () => {
        nodes.push({ id: uuid(), parentId: null, title: 'Этап ' + (roots.length + 1), desc: '', order: roots.length });
        scheduleSchemeSave(project);
        renderMain();
      },
    }, '+ Добавить корневой узел'),
    el('button', {
      type: 'button',
      class: 'primary-btn',
      disabled: !roots.length,
      onclick: async () => {
        if (!confirm('Развернуть схему в задачи? Корень станет секцией, узлы — задачами, подшаги — подзадачами. Повторный запуск обновит созданные секции.')) return;
        const ok = await act(() => api('POST', '/api/projects/' + project.id + '/deploy-scheme'));
        if (ok) {
          showToast('Схема развёрнута в задачи');
          current.tab = 'list';
          persistUi();
          await refresh();
        }
      },
    }, 'Развернуть в задачи'));

  const tree = el('div', { class: 'scheme-tree' });
  if (roots.length) {
    for (const r of roots) tree.append(schemeNodeEl(project, r, 0));
  } else {
    tree.append(el('div', { class: 'empty-state' },
      el('h2', {}, 'Схема процесса'),
      el('div', {}, 'Добавьте корневой узел (например, «Производство»), внутри — шаги, внутри шагов — подшаги. У каждого шага можно описать, что и как делается.'),
      el('button', {
        type: 'button', class: 'primary-btn', style: 'margin-top:14px;',
        onclick: () => {
          nodes.push({ id: uuid(), parentId: null, title: 'Процесс 1', desc: '', order: 0 });
          scheduleSchemeSave(project);
          renderMain();
        },
      }, 'Создать первый узел')));
  }

  return el('div', {}, toolbar, tree);
}

/* ---------- graph (Miro) ---------- */

function graphOf(project) {
  if (!project.graph) project.graph = { nodes: [], edges: [] };
  if (!Array.isArray(project.graph.nodes)) project.graph.nodes = [];
  if (!Array.isArray(project.graph.edges)) project.graph.edges = [];
  return project.graph;
}

let graphSaveTimer = null;
function scheduleGraphSave(project) {
  clearTimeout(graphSaveTimer);
  graphSaveTimer = setTimeout(async () => {
    try { await api('PUT', '/api/projects/' + project.id + '/graph', graphOf(project)); }
    catch (e) { showToast(e.message); }
  }, 600);
}

function graphView(project) {
  const g = graphOf(project);
  const wrap = el('div', { class: 'graph-wrap' });
  const toolbar = el('div', { class: 'graph-toolbar' },
    el('button', { type: 'button', class: 'primary-btn', onclick: () => addGraphNode(project, 'task') }, '+ Задача'),
    el('button', { type: 'button', class: 'ghost-btn', onclick: () => addGraphNode(project, 'text') }, '+ Текст'),
    el('span', { class: 'hint' }, 'Двойной клик — новый текст · Перетащите ручку справа для связи · Колёсико — масштаб'),
    el('button', { type: 'button', class: 'ghost-btn', onclick: () => { g.nodes = []; g.edges = []; scheduleGraphSave(project); renderMain(); } }, 'Очистить'),
  );
  const viewport = el('div', { class: 'graph-viewport' });
  const world = el('div', { class: 'graph-world' });
  const svg = el('svg', { class: 'graph-svg', html: '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" class="graph-edge-arrow"/></marker></defs>' });
  world.append(svg);
  viewport.append(world);

  // zoom controls
  const zoomCtrl = el('div', { class: 'zoom-controls' },
    el('button', { type: 'button', class: 'zoom-btn', html: '+', onclick: () => setGraphZoom(graphState.zoom * 1.2) }),
    el('button', { type: 'button', class: 'zoom-btn', html: '−', onclick: () => setGraphZoom(graphState.zoom / 1.2) }),
    el('button', { type: 'button', class: 'zoom-btn', html: '⤢', title: 'Сбросить вид', onclick: () => { graphState.pan = { x: 0, y: 0 }; graphState.zoom = 1; applyGraphTransform(world, svg); } }),
  );
  viewport.append(zoomCtrl);

  function setGraphZoom(z) { graphState.zoom = Math.max(0.3, Math.min(2.5, z)); applyGraphTransform(world, svg); }
  function applyGraphTransform(w, s) {
    w.style.transform = `translate(${graphState.pan.x}px, ${graphState.pan.y}px) scale(${graphState.zoom})`;
    s.style.transform = `translate(${graphState.pan.x}px, ${graphState.pan.y}px) scale(${graphState.zoom})`;
  }

  // render nodes
  function renderGraph() {
    world.querySelectorAll('.graph-node').forEach(n => n.remove());
    svg.querySelectorAll('.graph-edge-path').forEach(e => e.remove());
    for (const n of g.nodes) {
      const nodeEl = el('div', {
        class: 'graph-node ' + n.type + (graphState.selected === n.id ? ' selected' : ''),
        style: `left:${n.x}px;top:${n.y}px;width:${n.w}px;min-height:${n.h}px;background:${n.color};`,
        dataset: { id: n.id },
      },
        el('div', { class: 'node-title', html: escapeHtml(n.title), title: 'Двойной клик — редактировать' }),
        n.text ? el('div', { class: 'node-text', html: escapeHtml(n.text) }) : null,
        el('div', { class: 'handle', title: 'Тяните для связи' }),
        el('div', { class: 'del', html: '×', title: 'Удалить' }),
      );
      // events
      nodeEl.addEventListener('mousedown', (e) => startNodeDrag(e, n, nodeEl));
      nodeEl.addEventListener('click', (e) => { e.stopPropagation(); graphState.selected = n.id; renderGraph(); });
      nodeEl.querySelector('.handle').addEventListener('mousedown', (e) => startEdgeDrag(e, n));
      nodeEl.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deleteGraphNode(project, n.id); });
      nodeEl.addEventListener('dblclick', (e) => { e.stopPropagation(); editGraphNode(project, n); });
      world.append(nodeEl);
    }
    // edges
    for (const ed of g.edges) {
      const from = g.nodes.find(x => x.id === ed.from);
      const to = g.nodes.find(x => x.id === ed.to);
      if (!from || !to) continue;
      const path = el('svg', { html: '' }); // placeholder to keep svg namespace
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const x1 = from.x + from.w, y1 = from.y + from.h / 2;
      const x2 = to.x, y2 = to.y + to.h / 2;
      const mx = (x1 + x2) / 2;
      p.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
      p.setAttribute('class', 'graph-edge-path' + (graphState.selected === ed.id ? ' selected' : ''));
      p.setAttribute('marker-end', 'url(#arrow)');
      p.style.cursor = 'pointer';
      p.addEventListener('click', () => { graphState.selected = ed.id; renderGraph(); });
      p.addEventListener('dblclick', () => { g.edges = g.edges.filter(x => x.id !== ed.id); scheduleGraphSave(project); renderGraph(); });
      svg.appendChild(p);
    }
  }

  function addGraphNode(project, type) {
    const g2 = graphOf(project);
    const id = uuid();
    const cx = (-graphState.pan.x + viewport.clientWidth / 2) / graphState.zoom;
    const cy = (-graphState.pan.y + viewport.clientHeight / 2) / graphState.zoom;
    g2.nodes.push({ id, type, title: type === 'task' ? 'Новая задача' : 'Заметка', text: type === 'task' ? 'Что и как делаем' : 'Двойной клик — редактировать', x: cx - 110, y: cy - 55, w: 220, h: 110, color: type === 'task' ? '#ffffff' : '#fff9c4' });
    scheduleGraphSave(project);
    graphState.selected = id;
    renderGraph();
  }

  function deleteGraphNode(project, id) {
    const g2 = graphOf(project);
    g2.nodes = g2.nodes.filter(n => n.id !== id);
    g2.edges = g2.edges.filter(e => e.from !== id && e.to !== id);
    if (graphState.selected === id) graphState.selected = null;
    scheduleGraphSave(project);
    renderGraph();
  }

  function editGraphNode(project, node) {
    const t = prompt('Заголовок:', node.title);
    if (t === null) return;
    const txt = prompt('Текст (что и как):', node.text);
    if (txt === null) return;
    node.title = t.trim() || node.title;
    node.text = (txt || '').trim();
    scheduleGraphSave(project);
    renderGraph();
  }

  function startNodeDrag(e, node, elNode) {
    if (e.target.classList.contains('handle') || e.target.classList.contains('del')) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const origX = node.x, origY = node.y;
    function onMove(ev) {
      const dx = (ev.clientX - startX) / graphState.zoom;
      const dy = (ev.clientY - startY) / graphState.zoom;
      node.x = origX + dx;
      node.y = origY + dy;
      elNode.style.left = node.x + 'px';
      elNode.style.top = node.y + 'px';
      // update edges live
      svg.querySelectorAll('.graph-edge-path').forEach(p => p.remove());
      for (const ed of g.edges) {
        const from = g.nodes.find(x => x.id === ed.from);
        const to = g.nodes.find(x => x.id === ed.to);
        if (!from || !to) continue;
        const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const x1 = from.x + from.w, y1 = from.y + from.h / 2;
        const x2 = to.x, y2 = to.y + to.h / 2;
        const mx = (x1 + x2) / 2;
        p2.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
        p2.setAttribute('class', 'graph-edge-path');
        p2.setAttribute('marker-end', 'url(#arrow)');
        svg.appendChild(p2);
      }
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      scheduleGraphSave(project);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function startEdgeDrag(e, fromNode) {
    e.preventDefault(); e.stopPropagation();
    const startX = fromNode.x + fromNode.w, startY = fromNode.y + fromNode.h / 2;
    const temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    temp.setAttribute('class', 'graph-edge-path');
    temp.setAttribute('stroke-dasharray', '6 4');
    temp.setAttribute('marker-end', 'url(#arrow)');
    svg.appendChild(temp);
    function onMove(ev) {
      const rect = viewport.getBoundingClientRect();
      const x = (ev.clientX - rect.left - graphState.pan.x) / graphState.zoom;
      const y = (ev.clientY - rect.top - graphState.pan.y) / graphState.zoom;
      const mx = (startX + x) / 2;
      temp.setAttribute('d', `M ${startX} ${startY} C ${mx} ${startY}, ${mx} ${y}, ${x} ${y}`);
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      temp.remove();
      const rect = viewport.getBoundingClientRect();
      const x = (ev.clientX - rect.left - graphState.pan.x) / graphState.zoom;
      const y = (ev.clientY - rect.top - graphState.pan.y) / graphState.zoom;
      const target = g.nodes.find(n => x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h);
      if (target && target.id !== fromNode.id) {
        if (!g.edges.some(ed => ed.from === fromNode.id && ed.to === target.id)) {
          g.edges.push({ id: uuid(), from: fromNode.id, to: target.id });
          scheduleGraphSave(project);
          renderGraph();
        }
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // pan & zoom & double-click to create
  let panning = false, panStart = { x: 0, y: 0 }, panOrig = { x: 0, y: 0 };
  viewport.addEventListener('mousedown', (e) => {
    if (e.target !== viewport && e.target !== world && e.target !== svg) return;
    panning = true;
    viewport.classList.add('panning');
    panStart = { x: e.clientX, y: e.clientY };
    panOrig = { ...graphState.pan };
  });
  viewport.addEventListener('mousemove', (e) => {
    if (!panning) return;
    graphState.pan.x = panOrig.x + (e.clientX - panStart.x);
    graphState.pan.y = panOrig.y + (e.clientY - panStart.y);
    applyGraphTransform(world, svg);
  });
  window.addEventListener('mouseup', () => { panning = false; viewport.classList.remove('panning'); });
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = viewport.getBoundingClientRect();
    const wx = (e.clientX - rect.left - graphState.pan.x) / graphState.zoom;
    const wy = (e.clientY - rect.top - graphState.pan.y) / graphState.zoom;
    graphState.zoom = Math.max(0.3, Math.min(2.5, graphState.zoom * delta));
    graphState.pan.x = e.clientX - rect.left - wx * graphState.zoom;
    graphState.pan.y = e.clientY - rect.top - wy * graphState.zoom;
    applyGraphTransform(world, svg);
  }, { passive: false });
  viewport.addEventListener('dblclick', (e) => {
    if (e.target !== viewport && e.target !== world && e.target !== svg) return;
    const rect = viewport.getBoundingClientRect();
    const x = (e.clientX - rect.left - graphState.pan.x) / graphState.zoom;
    const y = (e.clientY - rect.top - graphState.pan.y) / graphState.zoom;
    const id = uuid();
    g.nodes.push({ id, type: 'text', title: 'Заметка', text: '', x: x - 110, y: y - 55, w: 220, h: 110, color: '#fff9c4' });
    scheduleGraphSave(project);
    graphState.selected = id;
    renderGraph();
  });
  viewport.addEventListener('click', (e) => {
    if (e.target === viewport || e.target === world || e.target === svg) { graphState.selected = null; renderGraph(); }
  });

  function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  renderGraph();
  applyGraphTransform(world, svg);
  wrap.append(toolbar, viewport);
  return wrap;
}

/* ---------- list view ---------- */

function renameInline(currentNode, initial, onCommit) {
  const input = el('input', { class: 'rename-input', value: initial });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = initial; input.blur(); }
  });
  input.addEventListener('blur', () => {
    const v = input.value.trim();
    if (v && v !== initial) onCommit(v);
    else input.replaceWith(currentNode);
  });
  currentNode.replaceWith(input);
  input.focus();
  input.select();
}

function sectionMenuItems(section, ctx) {
  return [
    { label: 'Переименовать', action: ctx.rename },
    { sep: true },
    {
      label: 'Удалить секцию',
      danger: true,
      action: () => {
        if (!confirm('Удалить секцию «' + section.name + '» и её задачи?')) return;
        collapsedSections.delete(section.id);
        persistUi();
        act(() => api('DELETE', '/api/sections/' + section.id));
      },
    },
  ];
}

function sectionHead(section, count, nameEl, ctx) {
  const isCollapsed = collapsedSections.has(section.id) && !searchQuery.trim();
  return el('div', { class: 'sec-head' },
    el('button', {
      type: 'button',
      class: 'caret' + (isCollapsed ? ' collapsed' : ''),
      html: SVG.caret,
      title: isCollapsed ? 'Развернуть' : 'Свернуть',
      onclick: () => {
        collapsedSections.has(section.id) ? collapsedSections.delete(section.id) : collapsedSections.add(section.id);
        persistUi();
        renderMain();
      },
    }),
    nameEl,
    el('span', { class: 'count' }, '(' + count + ')'),
    el('span', { class: 'spacer' }),
    el('button', {
      type: 'button', class: 'icon-btn menu', title: 'Меню секции', html: '&#8943;',
      onclick: (e) => { e.stopPropagation(); openMenu(e.currentTarget, sectionMenuItems(section, ctx)); },
    }));
}

function sectionBlockList(project, section, topTasks) {
  const isCollapsed = collapsedSections.has(section.id) && !searchQuery.trim();
  const nameSpan = el('span', {
    class: 'sec-name',
    ondblclick: () => renameInline(nameSpan, section.name, (v) => act(() => api('PATCH', '/api/sections/' + section.id, { name: v }))),
  }, section.name);
  const ctx = { rename: () => renameInline(nameSpan, section.name, (v) => act(() => api('PATCH', '/api/sections/' + section.id, { name: v }))) };

  const head = sectionHead(section, topTasks.length, nameSpan, ctx);
  const body = el('div', { class: 'sec-body' });
  if (!isCollapsed) {
    for (const t of topTasks) body.append(topGroup(t));
  }

  const block = el('section', { class: 'sec', dataset: { sectionId: section.id } }, head, body,
    isCollapsed ? null : addTaskRow(section.id, null, '.sec[data-section-id="' + section.id + '"] > .plus-row .add-task-input'));

  wireDropZone(body, () => ({ sectionId: section.id, parentId: null }));
  return block;
}

function visibleTopTasks(topTasks) {
  if (!searchQuery.trim()) return topTasks;
  return topTasks.filter((t) =>
    matchesSearch(t) || childrenOf(t.id).some(matchesSearch));
}

function listView(project) {
  const frag = document.createDocumentFragment();
  const searching = !!searchQuery.trim();
  let anyVisible = false;

  for (const section of project.sections) {
    const tasks = visibleTopTasks(sectionTopTasks(section.id));
    if (searching && !tasks.length) continue;
    anyVisible = true;
    frag.append(sectionBlockList(project, section, tasks));
  }

  frag.append(addSectionControl(project.id, false));

  if (!anyVisible) {
    frag.prepend(el('div', { class: 'empty-state' },
      el('h2', {}, project.sections.length ? 'Ничего не найдено' : 'В проекте пока пусто'),
      el('div', {}, project.sections.length
        ? 'По запросу «' + searchQuery + '» совпадений нет.'
        : 'Создайте первую секцию и добавляйте задачи.')));
  }
  return frag;
}

/* ---------- board view ---------- */

function sectionCol(project, section, topTasks) {
  const nameSpan = el('span', {
    class: 'sec-name',
    ondblclick: () => renameInline(nameSpan, section.name, (v) => act(() => api('PATCH', '/api/sections/' + section.id, { name: v }))),
  }, section.name);
  const ctx = { rename: () => renameInline(nameSpan, section.name, (v) => act(() => api('PATCH', '/api/sections/' + section.id, { name: v }))) };

  const colBody = el('div', { class: 'col-body' }, ...topTasks.map(cardNode));

  const col = el('div', { class: 'col', dataset: { sectionId: section.id } },
    sectionHead(section, topTasks.length, nameSpan, ctx),
    colBody,
    addTaskRow(section.id, null, '.col[data-section-id="' + section.id + '"] .add-task-input'));

  wireDropZone(colBody, () => ({ sectionId: section.id, parentId: null }));
  return col;
}

function boardView(project) {
  const frag = document.createDocumentFragment();
  const board = el('div', { class: 'board' });
  const searching = !!searchQuery.trim();
  let anyVisible = false;

  for (const section of project.sections) {
    const tasks = visibleTopTasks(sectionTopTasks(section.id));
    if (searching && !tasks.length) continue;
    anyVisible = true;
    board.append(sectionCol(project, section, tasks));
  }

  board.append(addSectionControl(project.id, true));
  frag.append(board);

  if (!anyVisible && searching) {
    frag.append(el('div', { class: 'empty-state' },
      el('h2', {}, 'Ничего не найдено'),
      el('div', {}, 'По запросу «' + searchQuery + '» совпадений нет.')));
  }
  return frag;
}

/* ---------- my tasks view ---------- */

function myTasksView() {
  const frag = document.createDocumentFragment();

  const toolbar = el('div', { class: 'my-toolbar' },
    el('label', {},
      el('input', {
        type: 'checkbox',
        ...(showDoneInMy ? { checked: true } : {}),
        onchange: (e) => { showDoneInMy = e.target.checked; renderMain(); },
      }),
      'Показывать выполненные'));
  frag.append(toolbar);

  const q = searchQuery.trim().toLowerCase();
  let total = 0;

  for (const project of state.projects) {
    let tasks = state.tasks.filter((t) => t.projectId === project.id && !t.parentId && matchesSearch(t));
    if (!showDoneInMy) tasks = tasks.filter((t) => !t.done);
    tasks.sort((a, b) => {
      if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
      if (a.due) return -1;
      if (b.due) return 1;
      return a.createdAt - b.createdAt;
    });
    if (!tasks.length) continue;
    total += tasks.length;

    frag.append(el('div', { class: 'group-head', onclick: () => selectProject(project.id) },
      el('span', { class: 'p-dot', style: 'background:' + project.color }),
      project.name,
      el('span', { class: 'count' }, '(' + tasks.length + ')')));

    for (const t of tasks) frag.append(topGroup(t));
  }

  if (!total) {
    frag.append(el('div', { class: 'empty-state' },
      el('h2', {}, q ? 'Ничего не найдено' : 'Задач нет'),
      el('div', {}, q ? 'По запросу «' + searchQuery + '» совпадений нет.' : 'Создайте проект и добавьте задачи — они появятся здесь.')));
  }
  return frag;
}

/* ---------- sidebar ---------- */

function renderSidebar() {
  const nav = document.getElementById('side-nav');
  nav.replaceChildren();

  nav.append(el('button', {
    type: 'button',
    class: 'nav-item' + (current.view === 'mytasks' ? ' active' : ''),
    onclick: () => { current.view = 'mytasks'; persistUi(); renderMain(); closeSidebarMobile(); },
  }, el('span', { html: SVG.home }), 'Мои задачи'));

  const headerRow = el('div', { class: 'nav-header' },
    'Проекты',
    el('button', { type: 'button', class: 'icon-btn add-project', title: 'Новый проект', html: '&#65291;', onclick: startProjectCreate }));

  const formHolder = el('div');
  const listEl = el('div', { id: 'project-list' });

  for (const p of state.projects) {
    const nameSpan = el('span', { class: 'p-name' }, p.name);
    const item = el('button', {
      type: 'button',
      class: 'nav-item project-item' + (current.view === 'project' && current.projectId === p.id ? ' active' : ''),
      dataset: { projectId: p.id },
      onclick: () => selectProject(p.id),
    },
      el('span', { class: 'p-dot', style: 'background:' + p.color }),
      nameSpan,
      el('button', {
        type: 'button', class: 'icon-btn', html: '&#8943;', title: 'Меню проекта',
        onclick: (e) => {
          e.stopPropagation();
          openMenu(e.currentTarget, [
            { label: 'Описание и обсуждение', action: () => openProjectPane(p.id) },
            { label: 'Переименовать', action: () => renameInline(nameSpan, p.name, (v) => act(() => api('PATCH', '/api/projects/' + p.id, { name: v }))) },
            {
              label: 'Цвет',
              palette: true,
              current: p.color,
              action: (color) => act(() => api('PATCH', '/api/projects/' + p.id, { color })),
            },
            { sep: true },
            {
              label: 'Удалить проект',
              danger: true,
              action: () => {
                if (!confirm('Удалить проект «' + p.name + '» со всеми задачами?')) return;
                if (current.projectId === p.id) { current.view = 'mytasks'; current.projectId = null; }
                if (pane.type === 'project' && pane.id === p.id) closePane();
                persistUi();
                act(() => api('DELETE', '/api/projects/' + p.id));
              },
            },
          ]);
        },
      }));
    listEl.append(item);
  }

  function startProjectCreate() {
    formHolder.replaceChildren(el('div', { class: 'side-form' },
      inlineInput({
        placeholder: 'Название проекта',
        autofocus: true,
        onCancel: () => formHolder.replaceChildren(),
        onSubmit: async (name) => {
          const created = await api('POST', '/api/projects', { name });
          current.view = 'project';
          current.projectId = created.id;
          persistUi();
        },
        blurCommit: false,
      }),
      el('button', {
        type: 'button', class: 'icon-btn', title: 'Создать', html: '&#10003;',
        onclick: () => { const i = formHolder.querySelector('input'); if (i) i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); },
      }),
      el('button', {
        type: 'button', class: 'icon-btn', title: 'Отмена', html: '&#10005;',
        onclick: () => formHolder.replaceChildren(),
      })));
  }

  nav.append(headerRow, formHolder, listEl);

  if (!state.projects.length) {
    nav.append(el('div', { style: 'padding:8px 12px;color:var(--muted);font-size:13px;' }, 'Пока ни одного проекта'));
  }
}

function selectProject(pid) {
  current.view = 'project';
  current.projectId = pid;
  persistUi();
  renderMain();
  closeSidebarMobile();
}

function closeSidebarMobile() {
  document.body.classList.remove('sidebar-open');
  document.getElementById('side-overlay').hidden = true;
}

function chatPageView() {
  const wrap = el('div', { id: 'chat-page-wrap', style: 'display:flex;flex-direction:column;height:calc(100vh - 90px);max-width:800px;margin:0 auto;width:100%;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg);' });
  const head = el('div', { id: 'chat-page-head', style: 'padding:12px 14px;background:var(--chat-head-bg);color:#fff;font-weight:700;display:flex;align-items:center;gap:8px;' }, 'Чат команды', el('span', { id: 'chat-page-count', style: 'margin-left:auto;font-weight:400;font-size:12px;opacity:.8;' }, chatMessages.length + ' сообщений'));
  const msgs = el('div', { id: 'chat-page-messages', style: 'flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:8px;background:var(--chat-bg);' });
  const inputRow = el('div', { style: 'display:flex;gap:8px;padding:10px;border-top:1px solid var(--border);background:var(--bg);align-items:flex-end;' },
    el('button', { id: 'chat-page-attach', type: 'button', title: 'Прикрепить файл', style: 'width:38px;height:38px;border-radius:50%;background:var(--bg-soft);border:1px solid var(--border);font-size:18px;flex-shrink:0;display:flex;align-items:center;justify-content:center;' }, '📎'),
    el('textarea', { id: 'chat-page-input', placeholder: 'Сообщение... Enter — отправить', rows: '2', style: 'flex:1;resize:none;border:1px solid var(--border);border-radius:18px;padding:10px 14px;outline:none;font:inherit;font-size:13.5px;max-height:110px;background:var(--bg);color:var(--text);' }),
    el('button', { id: 'chat-page-send', type: 'button', style: 'width:38px;height:38px;border-radius:50%;background:#2b5278;color:#fff;font-size:16px;flex-shrink:0;display:flex;align-items:center;justify-content:center;' }, '➤'));
  const fileInput = el('input', { id: 'chat-page-file-input', type: 'file', hidden: true, multiple: true });
  wrap.append(head, msgs, inputRow, fileInput);
  setTimeout(() => {
    const inp = document.getElementById('chat-page-input');
    const send = document.getElementById('chat-page-send');
    const attach = document.getElementById('chat-page-attach');
    const fin = document.getElementById('chat-page-file-input');
    const box = document.getElementById('chat-page-messages');
    const doSend = async () => {
      const t = inp.value.trim(); if (!t) return; inp.value = '';
      const ok = await act(() => api('POST', '/api/chat', { text: t }));
      if (ok) await fetchChat(true); else inp.value = t;
    };
    if (send) send.addEventListener('click', doSend);
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
    if (attach && fin) { attach.addEventListener('click', () => fin.click()); fin.addEventListener('change', () => { if (fin.files.length) { uploadChatFiles([...fin.files]); fin.value = ''; } }); }
    if (box) {
      box.addEventListener('dragover', e => { e.preventDefault(); box.style.outline = '2px dashed #4573d2'; });
      box.addEventListener('dragleave', e => { if (!box.contains(e.relatedTarget)) box.style.outline = ''; });
      box.addEventListener('drop', e => { e.preventDefault(); box.style.outline = ''; const files = [...(e.dataTransfer.files || [])]; if (files.length) uploadChatFiles(files); });
    }
    renderChatPage();
  }, 30);
  return wrap;
}
function renderChatPage() {
  const box = document.getElementById('chat-page-messages');
  if (!box) return;
  box.replaceChildren();
  for (const m of chatMessages) {
    const mine = currentUser.sub ? m.authorSub === currentUser.sub : m.author === currentUser.name;
    const row = document.createElement('div');
    row.className = 'chat-msg ' + (mine ? 'mine' : 'theirs');
    row.style.cssText = 'max-width:76%;padding:8px 10px 6px;border-radius:12px;font-size:13.5px;line-height:1.38;word-break:break-word;white-space:pre-wrap;box-shadow:0 1px 2px rgba(0,0,0,.08);align-self:' + (mine ? 'flex-end' : 'flex-start') + ';background:' + (mine ? '#effdde' : '#fff') + ';' + (mine ? 'border-bottom-right-radius:4px;' : 'border-bottom-left-radius:4px;border:1px solid rgba(0,0,0,.04);');
    if (document.documentElement.getAttribute('data-theme') === 'dark') { row.style.background = mine ? '#2b5278' : '#182533'; row.style.color = mine ? '#fff' : '#e8e8e8'; row.style.borderColor = mine ? '#2b5278' : '#1e2e3e'; }
    const head = document.createElement('div'); head.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:3px;';
    const author = document.createElement('span'); author.style.cssText = 'font-weight:700;font-size:11.5px;color:#2b5278;'; author.textContent = m.author; if (mine) author.style.display = 'none';
    const time = document.createElement('span'); time.style.cssText = 'font-size:11px;color:#6a6a6a;margin-left:auto;white-space:nowrap;'; time.textContent = fmtTime(m.createdAt);
    const del = document.createElement('button'); del.textContent = '×'; del.title = 'Удалить'; del.style.cssText = 'margin-left:6px;visibility:hidden;font-size:11px;color:#9a9a9a;background:none;border:none;cursor:pointer;'; if (!mine && !isOwnerUser) del.style.display = 'none'; del.onclick = async () => { if (!confirm('Удалить сообщение?')) return; try { await api('DELETE', '/api/chat/' + m.id); await fetchChat(true); } catch(e){ showToast(e.message); } };
    row.addEventListener('mouseenter', () => del.style.visibility = 'visible'); row.addEventListener('mouseleave', () => del.style.visibility = 'hidden');
    head.append(author, time, del); row.append(head);
    if (m.text) { const t = document.createElement('div'); t.textContent = m.text; row.append(t); }
    if (m.file) {
      const fr = document.createElement('div'); fr.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;padding:7px 9px;background:rgba(0,0,0,.04);border-radius:8px;border:1px solid #edeae9;';
      if (document.documentElement.getAttribute('data-theme') === 'dark') fr.style.background = 'rgba(255,255,255,.07)';
      const icon = document.createElement('span'); icon.textContent = m.file.type && m.file.type.startsWith('image/') ? '🖼️' : '📄';
      const a = document.createElement('a'); a.href = m.file.url; a.download = m.file.name; a.target = '_blank'; a.textContent = m.file.name; a.style.cssText = 'color:#4573d2;text-decoration:none;font-weight:600;font-size:13px;word-break:break-all;';
      const sz = document.createElement('span'); sz.textContent = formatFileSize(m.file.size || 0); sz.style.cssText = 'font-size:11px;color:#6a6a6a;white-space:nowrap;';
      fr.append(icon, a, sz); row.append(fr);
    }
    box.append(row);
  }
  if (!chatMessages.length) { const e = document.createElement('div'); e.style.cssText = 'text-align:center;padding:20px;color:#6a6a6a;'; e.textContent = 'Пока нет сообщений'; box.append(e); }
  box.scrollTop = box.scrollHeight;
  const cnt = document.getElementById('chat-page-count'); if (cnt) cnt.textContent = chatMessages.length + ' сообщений';
}

/* ---------- main area ---------- */

function renderMain() {
  const title = document.getElementById('view-title');
  const tabs = document.getElementById('tabs');
  const content = document.getElementById('content');
  content.replaceChildren();

  if (current.view === 'project') {
    const project = findProject(current.projectId);
    if (!project) {
      current.view = 'mytasks';
      persistUi();
      renderMain();
      return;
    }
    const titleBtn = el('span', {
      class: 'title-click',
      title: 'Описание и обсуждение проекта',
      onclick: () => openProjectPane(project.id),
    }, project.name);
    title.replaceChildren(
      el('span', { class: 'title-dot', style: 'background:' + project.color }),
      titleBtn);
    tabs.hidden = false;
    tabs.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === current.tab));
    content.append(
      current.tab === 'board' ? boardView(project)
        : current.tab === 'scheme' ? schemeView(project)
        : current.tab === 'graph' ? graphView(project)
          : listView(project));
  } else if (current.view === 'chat') {
    title.replaceChildren('Чат команды');
    tabs.hidden = true;
    content.append(chatPageView());
    renderChatPage();
    document.getElementById('chat-nav-btn')?.classList.add('active');
  } else {
    title.replaceChildren('Мои задачи');
    tabs.hidden = true;
    content.append(myTasksView());
    document.getElementById('chat-nav-btn')?.classList.remove('active');
  }
  // hide floating panel when in page mode
  if (chatMode === 'page' && current.view === 'chat') {
    const p = document.getElementById('chat-panel');
    if (p) p.hidden = true;
    chatOpen = false;
  }
}

/* ---------- right pane ---------- */

function openTask(taskId) {
  pane = { type: 'task', id: taskId };
  renderPane();
}

function openProjectPane(projectId) {
  pane = { type: 'project', id: projectId };
  renderPane();
}

function closePane() {
  if (pane.type == null) return;
  pane = { type: null, id: null };
  renderPane();
}

function renderPane() {
  const elPane = document.getElementById('detail');
  if (pane.type == null) {
    elPane.hidden = true;
    elPane.replaceChildren();
    return;
  }
  if (pane.type === 'invite') {
    if (!isOwnerUser) { pane = { type: null, id: null }; elPane.hidden = true; return; }
    elPane.hidden = false;
    elPane.replaceChildren(...buildInvitePane());
    return;
  }
  if (pane.type === 'settings') {
    elPane.hidden = false;
    elPane.replaceChildren(...buildSettingsPane());
    return;
  }
  if (pane.type === 'task') {
    const task = state.tasks.find((t) => t.id === pane.id);
    if (!task) { pane = { type: null, id: null }; elPane.hidden = true; return; }
    elPane.hidden = false;
    elPane.replaceChildren(...buildTaskPane(task));
    return;
  }
  const project = findProject(pane.id);
  if (!project) { pane = { type: null, id: null }; elPane.hidden = true; return; }
  elPane.hidden = false;
  elPane.replaceChildren(...buildProjectPane(project));
}

function subtasksBlock(task) {
  const kids = childrenOf(task.id);
  const wrap = el('div', { class: 'subtasks-wrap' },
    el('div', { class: 'notes-label' }, 'Подзадачи (' + kids.length + ')'));

  for (const k of kids) {
    wrap.append(el('div', { class: 'subtask-row' + (k.done ? ' done' : '') },
      checkBtn(k),
      el('span', { class: 'st-title', onclick: () => openTask(k.id) }, k.title),
      el('button', {
        type: 'button', class: 'icon-btn', html: '&#10005;', title: 'Удалить подзадачу',
        onclick: () => act(() => api('DELETE', '/api/tasks/' + k.id)),
      })));
  }
  if (!kids.length) wrap.append(el('div', { class: 'comment-empty' }, 'Подзадач нет.'));

  wrap.append(addTaskRow(task.sectionId, task.id, '.subtasks-wrap .add-task-input'));
  return wrap;
}

function buildTaskPane(task) {
  const titleInput = el('input', {
    class: 'd-title',
    value: task.title,
    disabled: task.done ? true : null,
    autocomplete: 'off',
  });
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleInput.blur(); });
  titleInput.addEventListener('blur', () => {
    const v = titleInput.value.trim();
    if (!v) { titleInput.value = task.title; return; }
    if (v !== task.title) act(() => api('PATCH', '/api/tasks/' + task.id, { title: v }));
  });

  const dateInput = el('input', { type: 'date', value: task.due || '' });
  dateInput.addEventListener('change', () =>
    act(() => api('PATCH', '/api/tasks/' + task.id, { due: dateInput.value || null })));

  const projSelect = el('select', {},
    ...state.projects.map((p) =>
      el('option', { value: p.id, ...(p.id === task.projectId ? { selected: true } : {}) }, p.name)));
  projSelect.addEventListener('change', async () => {
    const sec = firstSectionOf(projSelect.value);
    if (!sec) { showToast('В этом проекте пока нет секций — создайте их там сначала'); renderPane(); return; }
    await act(() => api('POST', '/api/tasks/move', { taskId: task.id, sectionId: sec.id, parentId: null, beforeTaskId: null }));
    renderPane();
  });

  const notesArea = el('textarea', { class: 'd-notes', placeholder: 'Что и как делается. Опишите шаги или прикрепите смысл задачи...' });
  notesArea.value = task.notes || '';
  notesArea.addEventListener('blur', () => {
    if (notesArea.value !== (task.notes || '')) {
      act(() => api('PATCH', '/api/tasks/' + task.id, { notes: notesArea.value }));
    }
  });

  const project = findProject(task.projectId);
  return [
    el('div', { class: 'detail-top' },
      checkBtn(task),
      titleInput,
      el('button', { type: 'button', class: 'd-close', title: 'Закрыть', html: '&#10005;', onclick: closePane })),
    el('div', { class: 'pane-context' },
      el('span', { class: 'p-dot', style: 'background:' + (project ? project.color : '#ccc') }),
      (project ? project.name : '')),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Срок'), dateInput),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Проект'), projSelect),
    el('div', { class: 'notes-wrap' },
      el('div', { class: 'notes-label' }, 'Описание'),
      notesArea),
    subtasksBlock(task),
    commentsBlock('task', task.id),
    el('div', { class: 'detail-footer' },
      el('button', {
        type: 'button', class: 'danger-btn',
        onclick: () => {
          if (!confirm('Удалить задачу «' + task.title + '» и её подзадачи?')) return;
          closePane();
          act(() => api('DELETE', '/api/tasks/' + task.id));
        },
      }, 'Удалить задачу')),
  ];
}

function buildProjectPane(project) {
  const descArea = el('textarea', {
    class: 'd-notes',
    placeholder: 'Опишите проект: цель, актуальность, задачи работы, инструменты — как в OpenProject. Схему процесса можно построить на вкладке «Схема» (необязательно).',
  });
  descArea.value = project.description || '';
  descArea.addEventListener('blur', () => {
    if (descArea.value !== (project.description || '')) {
      act(() => api('PATCH', '/api/projects/' + project.id, { description: descArea.value }));
    }
  });

  return [
    el('div', { class: 'detail-top' },
      el('span', { class: 'title-dot', style: 'background:' + project.color, style: 'background:' + project.color }),
      el('input', { class: 'd-title', value: project.name, readonly: true }),
      el('button', { type: 'button', class: 'd-close', title: 'Закрыть', html: '&#10005;', onclick: closePane })),
    el('div', { class: 'notes-wrap' },
      el('div', { class: 'notes-label' }, 'Описание проекта'),
      descArea),
    commentsBlock('project', project.id),
  ];
}

/* ---------- global events ---------- */

document.getElementById('search').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderMain();
});

document.querySelectorAll('#tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    current.tab = btn.dataset.tab;
    persistUi();
    renderMain();
  });
});

document.getElementById('burger').addEventListener('click', () => {
  document.body.classList.add('sidebar-open');
  document.getElementById('side-overlay').hidden = false;
});
document.getElementById('side-overlay').addEventListener('click', closeSidebarMobile);
document.getElementById('invite-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  pane = { type: 'invite', id: null };
  renderPane();
  closeSidebarMobile();
});

/* ---------- invites pane (владелец) ---------- */

function buildInvitePane() {
  const invites = [...state.invites].sort((a, b) => b.createdAt - a.createdAt);
  const out = [
    el('div', { class: 'detail-top' },
      el('input', { class: 'd-title', value: 'Приглашения', readonly: true }),
      el('button', { type: 'button', class: 'd-close', title: 'Закрыть', html: '&#10005;', onclick: closePane })),
    el('p', { class: 'invite-hint' },
      'Открытая регистрация выключена. Создайте приглашение и отправьте ссылку человеку — один код равен одному аккаунту. Приглашать можете только вы.'),
    el('button', {
      type: 'button', class: 'primary-btn', style: 'margin-bottom:14px;',
      onclick: () => act(() => api('POST', '/api/invites')),
    }, '+ Создать приглашение'),
  ];

  if (!invites.length) {
    out.push(el('div', { class: 'comment-empty' }, 'Приглашений пока нет.'));
    return out;
  }

  for (const inv of invites) {
    const link = window.location.origin + '/invite/' + inv.code;
    const status = inv.usedBy
      ? el('div', { class: 'invite-status used' }, 'Использовал: ' + inv.usedBy + ' · ' + fmtTime(inv.usedAt))
      : el('div', { class: 'invite-status' }, 'Активно · создано ' + fmtTime(inv.createdAt));
    const row = el('div', { class: 'invite-item' },
      status,
      el('div', { class: 'invite-link-row' },
        el('input', { class: 'invite-link', value: link, readonly: true, onclick: (e) => e.target.select() }),
        el('button', {
          type: 'button', class: 'ghost-btn', title: 'Скопировать ссылку', html: '&#128203;',
          onclick: async (e) => {
            try { await navigator.clipboard.writeText(link); e.currentTarget.html = '&#10003;'; setTimeout(() => { e.currentTarget.html = '&#128203;'; }, 1200); }
            catch { showToast('Скопируйте ссылку вручную'); }
          },
        }),
        ...(inv.usedBy ? [] : [el('button', {
          type: 'button', class: 'ghost-btn', title: 'Отозвать', html: '&#10005;',
          onclick: () => act(() => api('DELETE', '/api/invites/' + inv.id)),
        })])));
    out.push(row);
  }
  return out;
}

/* ---------- chat ---------- */

function getAnimeVoice() {
  try {
    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    if (!voices.length) return null;
    if (selectedVoiceURI) {
      const byUri = voices.find(v => v.voiceURI === selectedVoiceURI);
      if (byUri) return byUri;
    }
    const jaFemale = voices.find(v => v.lang === 'ja-JP' && /female|haruka|hikari|haruna|mizuki|ayumi|nanami|sayaka/i.test(v.name))
      || voices.find(v => v.lang.startsWith('ja'))
      || voices.find(v => /Google 日本語|Microsoft Haruka/i.test(v.name));
    if (jaFemale) return jaFemale;
    const enFemale = voices.find(v => v.lang.startsWith('en') && /female|jenny|aria|samantha|zira|eva|eva/i.test(v.name))
      || voices.find(v => /Google UK English Female|Microsoft Zira/i.test(v.name))
      || voices.find(v => v.name.toLowerCase().includes('female'));
    return enFemale || voices.find(v => v.lang.startsWith('en')) || voices[0];
  } catch { return null; }
}

function populateVoiceSelect() {
  const sel = document.getElementById('chat-voice-select');
  if (!sel || !window.speechSynthesis) return;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return;
  const prev = selectedVoiceURI;
  sel.replaceChildren();
  sel.append(el('option', { value: '' }, 'Авто (аниме-тян)'));
  for (const v of voices) {
    const label = v.name + ' (' + v.lang + ')' + (v.default ? ' — по умолчанию' : '');
    sel.append(el('option', { value: v.voiceURI, ...(v.voiceURI === prev ? { selected: true } : {}) }, label));
  }
  if (prev && !voices.some(v => v.voiceURI === prev)) {
    sel.value = '';
  }
}

function playChatSound() {
  if (!chatSoundEnabled || chatSoundMode === 'off') return;
  const playClassic = chatSoundMode === 'both' || chatSoundMode === 'classic';
  const playAnime = chatSoundMode === 'both' || chatSoundMode === 'anime';
  if (playClassic) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        const now = ctx.currentTime;
        // classic notification: single crisp ding + second harmonic
        const freqs = chatSoundMode === 'classic' ? [1000] : [880, 1320];
        freqs.forEach((freq, i) => {
          const o = ctx.createOscillator(); const g = ctx.createGain();
          o.type = 'sine'; o.frequency.value = freq; g.gain.value = 0.26;
          o.connect(g); g.connect(ctx.destination);
          o.start(now + i * 0.12);
          g.gain.setValueAtTime(0.26, now + i * 0.12);
          g.gain.exponentialRampToValueAtTime(0.01, now + i * 0.12 + 0.24);
          o.stop(now + i * 0.12 + 0.25);
        });
        setTimeout(() => { try { ctx.close(); } catch {} }, 700);
      }
    } catch {}
    // also try HTML5 audio fallback for classic (if AudioContext blocked)
    try {
      const audio = document.getElementById('chat-audio');
      if (audio && chatSoundMode === 'classic') {
        // classic short beep via data URI (440Hz 0.15s) — fallback
        audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';
        audio.volume = 0.5; audio.play().catch(()=>{});
      }
    } catch {}
  }
  if (!playAnime) return;
  try {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const text = 'New message, senpai~ ♡';
      const u = new SpeechSynthesisUtterance(text);
      const v = getAnimeVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'ja-JP';
      u.volume = 0.85;
      u.rate = 1.05;
      u.pitch = 1.65;
      // ensure voices loaded
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) {
        window.speechSynthesis.addEventListener('voiceschanged', () => {
          const vv = getAnimeVoice();
          if (vv) u.voice = vv;
          window.speechSynthesis.speak(u);
        }, { once: true });
        setTimeout(() => window.speechSynthesis.speak(u), 120);
      } else {
        window.speechSynthesis.speak(u);
      }
    }
  } catch {}
}

function formatFileSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function renderChat() {
  const box = document.getElementById('chat-messages');
  const badge = document.getElementById('chat-badge');
  const badgeSide = document.getElementById('chat-badge-side');
  if (!box) return;
  box.replaceChildren();
  for (const m of chatMessages) {
    const mine = currentUser.sub ? m.authorSub === currentUser.sub : m.author === currentUser.name;
    const content = [];
    content.push(el('div', { class: 'chat-msg-head' },
      el('span', { class: 'chat-msg-author' }, m.author),
      el('span', { class: 'chat-msg-time' }, fmtTime(m.createdAt)),
      el('button', {
        type: 'button', class: 'chat-msg-del', title: 'Удалить', html: '&#10005;',
        onclick: async () => {
          if (!confirm('Удалить сообщение?')) return;
          try { await api('DELETE', '/api/chat/' + m.id); await fetchChat(true); }
          catch (e) { showToast(e.message); }
        },
      })));
    if (m.text) content.push(el('div', {}, m.text));
    if (m.file) {
      const isImage = m.file.type && m.file.type.startsWith('image/');
      const fileIcon = isImage ? '🖼️' : '📄';
      const fileRow = el('div', { class: 'chat-msg-file' },
        el('span', { class: 'file-icon' }, fileIcon),
        el('a', { href: m.file.url, download: m.file.name, target: '_blank', rel: 'noopener' }, m.file.name),
        el('span', { class: 'file-size' }, formatFileSize(m.file.size || 0)));
      if (isImage) {
        fileRow.append(el('a', { href: m.file.url, target: '_blank', style: 'margin-left:6px;font-size:11px;color:var(--blue);' }, 'открыть'));
      }
      content.push(fileRow);
    }
    const row = el('div', { class: 'chat-msg ' + (mine ? 'mine' : 'theirs') }, ...content);
    if (!mine && !isOwnerUser) row.querySelector('.chat-msg-del').style.display = 'none';
    box.append(row);
  }
  if (!chatMessages.length) {
    box.append(el('div', { class: 'comment-empty', style: 'text-align:center;padding:20px;' }, 'Пока нет сообщений. Начните общение! Перетащите файл или нажмите 📎'));
  }
  box.scrollTop = box.scrollHeight;
  const badgeText = chatUnread > 0 && !chatOpen ? String(chatUnread > 99 ? '99+' : chatUnread) : null;
  if (badge) { if (badgeText) { badge.textContent = badgeText; badge.hidden = false; } else badge.hidden = true; }
  if (badgeSide) { if (badgeText) { badgeSide.textContent = badgeText; badgeSide.hidden = false; } else badgeSide.hidden = true; }
}

async function fetchChat(forceRender) {
  try {
    const msgs = await api('GET', '/api/chat');
    const prevIds = new Set(chatMessages.map(m => m.id));
    const newOnes = msgs.filter(m => !prevIds.has(m.id) && !chatLastIds.has(m.id));
    const hasNewFromOthers = newOnes.some(m => m.authorSub !== currentUser.sub && m.author !== currentUser.name);
    chatMessages = msgs;
    for (const m of msgs) chatLastIds.add(m.id);
    const isChatVisible = chatOpen || current.view === 'chat' || document.getElementById('chat-page-messages');
    if (hasNewFromOthers && !isChatVisible) {
      chatUnread += newOnes.filter(m => m.authorSub !== currentUser.sub && m.author !== currentUser.name).length;
      playChatSound();
      showToast('New message: ' + (newOnes.find(m => m.authorSub !== currentUser.sub) || newOnes[0]).author);
    } else if (hasNewFromOthers && isChatVisible) {
      // если чат открыт — просто обновляем без звука/тоста, но с плавным скроллом
      // playChatSound только если включено и это не своё сообщение и окно в фоне — выше уже обработали
    }
    if (forceRender || hasNewFromOthers || msgs.length !== prevIds.size || chatOpen) {
      renderChat();
      if (document.getElementById('chat-page-messages')) renderChatPage();
    } else {
      const badgeSide = document.getElementById('chat-badge-side');
      const badge = document.getElementById('chat-badge');
      const t = chatUnread > 0 && !chatOpen ? String(chatUnread > 99 ? '99+' : chatUnread) : null;
      if (t) { if (badge) { badge.textContent = t; badge.hidden = false; } if (badgeSide) { badgeSide.textContent = t; badgeSide.hidden = false; } }
    }
  } catch {}
}

function toggleChat(open) {
  if (chatMode === 'window') {
    window.open('/chat.html', 'asana-chat', 'width=520,height=720');
    return;
  }
  if (chatMode === 'page') {
    if (open === false) { if (current.view === 'chat') { current.view = 'mytasks'; persistUi(); renderMain(); } return; }
    current.view = current.view === 'chat' && open == null ? 'mytasks' : 'chat';
    persistUi();
    renderMain();
    return;
  }
  chatOpen = open != null ? open : !chatOpen;
  const panel = document.getElementById('chat-panel');
  const btn = document.getElementById('chat-nav-btn');
  if (panel) panel.hidden = !chatOpen;
  if (btn) btn.classList.toggle('active', chatOpen);
  if (chatOpen) {
    chatUnread = 0;
    const badge = document.getElementById('chat-badge');
    const badgeSide = document.getElementById('chat-badge-side');
    if (badge) badge.hidden = true;
    if (badgeSide) badgeSide.hidden = true;
    renderChat();
    setTimeout(() => document.getElementById('chat-input')?.focus(), 80);
  }
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  // optimistic: show instantly
  const tmp = { id: 'tmp-' + Date.now(), author: currentUser.name, authorSub: currentUser.sub, text, createdAt: Date.now(), optimistic: true };
  chatMessages = [...chatMessages, tmp];
  renderChat(); if (document.getElementById('chat-page-messages')) renderChatPage();
  input.value = '';
  input.focus();
  try {
    await api('POST', '/api/chat', { text });
    await fetchChat(true);
  } catch (e) {
    chatMessages = chatMessages.filter(m => m.id !== tmp.id);
    renderChat(); if (document.getElementById('chat-page-messages')) renderChatPage();
    showToast(e.message);
    input.value = text;
  }
}

async function uploadChatFiles(files) {
  if (!files || !files.length) return;
  for (const file of files) {
    const caption = document.getElementById('chat-input')?.value.trim() || '';
    try {
      showToast('Отправка ' + file.name + '...');
      const res = await fetch('/api/chat/file', {
        method: 'POST',
        headers: {
          'X-Filename': encodeURIComponent(file.name),
          'X-Text': encodeURIComponent(caption.slice(0, 2000)),
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok) throw new Error(data.error || 'Ошибка загрузки');
      document.getElementById('chat-input').value = '';
      await fetchChat(true);
      showToast('Файл отправлен ✓');
    } catch (e) {
      showToast(e.message || 'Не удалось отправить файл');
    }
  }
}

function buildSettingsPane() {
  const voiceSel = el('select', { id: 'settings-voice-select' });
  // populate after
  setTimeout(() => {
    const src = document.getElementById('chat-voice-select');
    if (src && voiceSel) {
      voiceSel.replaceChildren(...[...src.options].map(o => el('option', { value: o.value, ...(o.value === selectedVoiceURI ? { selected: true } : {}) }, o.textContent)));
    }
  }, 100);

  const themeSel = el('select', {},
    el('option', { value: 'light', ...(themeMode === 'light' ? { selected: true } : {}) }, 'Светлая'),
    el('option', { value: 'dark', ...(themeMode === 'dark' ? { selected: true } : {}) }, 'Тёмная (чёрная)'),
    el('option', { value: 'auto', ...(themeMode === 'auto' ? { selected: true } : {}) }, 'Авто'));

  themeSel.addEventListener('change', () => applyTheme(themeSel.value));
  voiceSel.addEventListener('change', () => {
    selectedVoiceURI = voiceSel.value;
    localStorage.setItem('al-chat-voice', selectedVoiceURI);
    const dst = document.getElementById('chat-voice-select');
    if (dst) dst.value = selectedVoiceURI;
    if (chatSoundEnabled) playChatSound();
  });

  const chatModeSel = el('select', {},
    el('option', { value: 'panel', ...(chatMode === 'panel' ? { selected: true } : {}) }, 'Панель (Telegram)'),
    el('option', { value: 'window', ...(chatMode === 'window' ? { selected: true } : {}) }, 'Отдельное окно'),
    el('option', { value: 'page', ...(chatMode === 'page' ? { selected: true } : {}) }, 'Страница'));
  chatModeSel.addEventListener('change', () => {
    chatMode = chatModeSel.value;
    localStorage.setItem('al-chat-mode', chatMode);
    const dst = document.getElementById('chat-mode-select');
    if (dst) dst.value = chatMode;
    if (chatMode === 'window') {
      window.open('/chat.html', 'asana-chat', 'width=520,height=720');
    } else if (chatMode === 'page') {
      current.view = 'chat'; persistUi(); renderMain();
    }
    // also sync chat panel select if exists
    const c2 = document.getElementById('chat-mode-select');
    if (c2) c2.value = chatMode;
  });

  const soundChk = el('input', { type: 'checkbox', ...(chatSoundEnabled ? { checked: true } : {}) });
  soundChk.addEventListener('change', () => {
    chatSoundEnabled = soundChk.checked;
    localStorage.setItem('al-chat-sound', JSON.stringify(chatSoundEnabled));
    const c = document.getElementById('chat-sound');
    if (c) c.checked = chatSoundEnabled;
    if (chatSoundEnabled) playChatSound();
  });

  const soundModeSel = el('select', {},
    el('option', { value: 'both', ...(chatSoundMode === 'both' ? { selected: true } : {}) }, 'Оба'),
    el('option', { value: 'classic', ...(chatSoundMode === 'classic' ? { selected: true } : {}) }, 'Обычный'),
    el('option', { value: 'anime', ...(chatSoundMode === 'anime' ? { selected: true } : {}) }, 'Только аниме'),
    el('option', { value: 'off', ...(chatSoundMode === 'off' ? { selected: true } : {}) }, 'Выкл'));
  soundModeSel.addEventListener('change', () => {
    chatSoundMode = soundModeSel.value;
    localStorage.setItem('al-chat-sound-mode', chatSoundMode);
    if (chatSoundEnabled && chatSoundMode !== 'off') playChatSound();
  });

  const accentInput = el('input', { type: 'color', value: customAccent || '#f06a6a', style: 'width:40px;height:28px;padding:0;border:none;border-radius:6px;cursor:pointer;' });
  accentInput.addEventListener('input', () => { customAccent = accentInput.value; localStorage.setItem('al-custom-accent', customAccent); applyCustomColors(); });
  const bgInput = el('input', { type: 'color', value: customBg || (themeMode === 'dark' ? '#000000' : '#ffffff'), style: 'width:40px;height:28px;padding:0;border:none;border-radius:6px;cursor:pointer;' });
  bgInput.addEventListener('input', () => { customBg = bgInput.value; localStorage.setItem('al-custom-bg', customBg); applyCustomColors(); });
  const textInput = el('input', { type: 'color', value: customText || (themeMode === 'dark' ? '#e8e8e8' : '#1e1f21'), style: 'width:40px;height:28px;padding:0;border:none;border-radius:6px;cursor:pointer;' });
  textInput.addEventListener('input', () => { customText = textInput.value; localStorage.setItem('al-custom-text', customText); applyCustomColors(); });
  const fontSel = el('select', {},
    el('option', { value: '', ...(customFont === '' ? { selected: true } : {}) }, 'Авто (по теме)'),
    el('option', { value: '"Segoe UI", system-ui, sans-serif', ...(customFont === '"Segoe UI", system-ui, sans-serif' ? { selected: true } : {}) }, 'System'),
    el('option', { value: '"Inter", system-ui, sans-serif', ...(customFont === '"Inter", system-ui, sans-serif' ? { selected: true } : {}) }, 'Inter'),
    el('option', { value: '"Manrope", sans-serif', ...(customFont === '"Manrope", sans-serif' ? { selected: true } : {}) }, 'Manrope'),
    el('option', { value: '"JetBrains Mono", monospace', ...(customFont === '"JetBrains Mono", monospace' ? { selected: true } : {}) }, 'Mono'));
  fontSel.addEventListener('change', () => { customFont = fontSel.value; if (customFont) localStorage.setItem('al-custom-font', customFont); else localStorage.removeItem('al-custom-font'); applyCustomColors(); });
  const resetColorsBtn = el('button', { type: 'button', class: 'ghost-btn', style: 'font-size:12px;' }, 'Сбросить вид');
  resetColorsBtn.addEventListener('click', () => { customAccent=''; customBg=''; customText=''; customFont=''; localStorage.removeItem('al-custom-accent'); localStorage.removeItem('al-custom-bg'); localStorage.removeItem('al-custom-text'); localStorage.removeItem('al-custom-font'); accentInput.value='#f06a6a'; bgInput.value='#ffffff'; textInput.value='#1e1f21'; fontSel.value=''; applyCustomColors(); showToast('Вид сброшен'); });

  const settingsBlocks = [
    el('div', { class: 'detail-top' },
      el('input', { class: 'd-title', value: 'Настройки', readonly: true }),
      el('button', { type: 'button', class: 'd-close', title: 'Закрыть', html: '&#10005;', onclick: closePane })),
    el('div', { class: 'notes-label', style: 'margin-top:12px;' }, 'Чат'),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Звук'), soundChk),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Тип звука'), soundModeSel),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Голос'), voiceSel),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Режим чата'), chatModeSel),
    el('div', { class: 'notes-label', style: 'margin-top:16px;' }, 'Внешний вид'),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Тема'), themeSel),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Акцент'), accentInput),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Фон'), bgInput),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Текст'), textInput),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Шрифт'), fontSel),
    el('div', { style: 'margin-top:6px;' }, resetColorsBtn),
    el('div', { class: 'invite-hint', style: 'margin-top:10px;' }, 'Всё настраивается — звук (обычный/аниме/оба), голос, режим чата, тема и цвета. Тёмная — чёрный как просили.'),
    el('div', { class: 'invite-hint', style: 'margin-top:6px;' }, 'Файлы — без лимитов (до 2GB), мгновенная отгрузка/скачка.'),
  ];

  // Пригласить человека (только владелец) — внутри настроек
  if (isOwnerUser) {
    const invites = [...(state.invites || [])].sort((a, b) => b.createdAt - a.createdAt);
    settingsBlocks.push(el('div', { class: 'notes-label', style: 'margin-top:18px;' }, 'Приглашения'));
    settingsBlocks.push(el('p', { class: 'invite-hint' }, 'Создайте ссылку-приглашение — один код = один аккаунт. Открытая регистрация выключена.'));
    settingsBlocks.push(el('button', {
      type: 'button', class: 'primary-btn', style: 'margin:8px 0 6px;',
      onclick: async () => { await act(() => api('POST', '/api/invites')); renderPane(); },
    }, '+ Создать приглашение'));
    if (!invites.length) {
      settingsBlocks.push(el('div', { class: 'comment-empty' }, 'Приглашений пока нет.'));
    } else {
      for (const inv of invites) {
        const link = window.location.origin + '/invite/' + inv.code;
        const status = inv.usedBy
          ? el('div', { class: 'invite-status used' }, 'Использовал: ' + inv.usedBy + ' · ' + fmtTime(inv.usedAt))
          : el('div', { class: 'invite-status' }, 'Активно · ' + fmtTime(inv.createdAt));
        settingsBlocks.push(el('div', { class: 'invite-item' },
          status,
          el('div', { class: 'invite-link-row' },
            el('input', { class: 'invite-link', value: link, readonly: true, onclick: (e) => e.target.select() }),
            el('button', {
              type: 'button', class: 'ghost-btn', title: 'Скопировать', html: '&#128203;',
              onclick: async (e) => { try { await navigator.clipboard.writeText(link); e.currentTarget.html = '&#10003;'; setTimeout(() => e.currentTarget.html = '&#128203;', 1200); } catch { showToast('Скопируйте вручную'); } },
            }),
            ...(inv.usedBy ? [] : [el('button', {
              type: 'button', class: 'ghost-btn', title: 'Отозвать', html: '&#10005;',
              onclick: async () => { await act(() => api('DELETE', '/api/invites/' + inv.id)); renderPane(); },
            })]))));
      }
    }
  }

  settingsBlocks.push(el('div', { class: 'notes-label', style: 'margin-top:18px;' }, 'Аккаунт'));
  settingsBlocks.push(el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:6px;' },
    el('a', { href: accountUrl || '#', target: '_blank', rel: 'noopener', class: 'ghost-btn', style: 'text-align:left;border:1px solid var(--border);' }, '🔑 Сменить пароль'),
    el('a', { href: '/logout', class: 'danger-btn', style: 'text-align:center;text-decoration:none;display:block;' }, '🚪 Выйти')));

  return settingsBlocks;
}

function initChat() {
  const fab = document.getElementById('chat-fab');
  const panel = document.getElementById('chat-panel');
  const closeBtn = document.getElementById('chat-close');
  const sendBtn = document.getElementById('chat-send');
  const input = document.getElementById('chat-input');
  const soundChk = document.getElementById('chat-sound');
  const voiceSel = document.getElementById('chat-voice-select');
  const themeSel = document.getElementById('theme-select');
  const attachBtn = document.getElementById('chat-attach');
  const fileInput = document.getElementById('chat-file-input');
  const messagesBox = document.getElementById('chat-messages');
  if (soundChk) {
    soundChk.checked = chatSoundEnabled;
    soundChk.addEventListener('change', () => {
      chatSoundEnabled = soundChk.checked;
      localStorage.setItem('al-chat-sound', JSON.stringify(chatSoundEnabled));
      if (chatSoundEnabled) playChatSound();
    });
  }
  if (voiceSel) {
    populateVoiceSelect();
    if (window.speechSynthesis) {
      window.speechSynthesis.addEventListener('voiceschanged', populateVoiceSelect);
      // try again after delay (Chrome async)
      setTimeout(populateVoiceSelect, 800);
    }
    voiceSel.addEventListener('change', () => {
      selectedVoiceURI = voiceSel.value;
      localStorage.setItem('al-chat-voice', selectedVoiceURI);
      if (chatSoundEnabled) playChatSound();
    });
  }
  if (themeSel) {
    themeSel.value = themeMode;
    themeSel.addEventListener('change', () => applyTheme(themeSel.value));
  }
  const chatModeSel = document.getElementById('chat-mode-select');
  if (chatModeSel) {
    chatModeSel.value = chatMode;
    chatModeSel.addEventListener('change', () => {
      chatMode = chatModeSel.value;
      localStorage.setItem('al-chat-mode', chatMode);
      if (chatMode === 'window') window.open('/chat.html', 'asana-chat', 'width=520,height=720');
      else if (chatMode === 'page') { current.view = 'chat'; persistUi(); renderMain(); toggleChat(false); }
      showToast('Режим чата: ' + (chatMode === 'panel' ? 'Панель' : chatMode === 'window' ? 'Окно' : 'Страница'));
    });
  }
  const chatNavBtn = document.getElementById('chat-nav-btn');
  const settingsNavBtn = document.getElementById('settings-nav-btn');
  if (chatNavBtn) chatNavBtn.addEventListener('click', () => { toggleChat(); closeSidebarMobile(); });
  if (settingsNavBtn) settingsNavBtn.addEventListener('click', () => { pane = { type: 'settings', id: null }; renderPane(); closeSidebarMobile(); });
  if (fab) fab.addEventListener('click', () => toggleChat());
  if (closeBtn) closeBtn.addEventListener('click', () => toggleChat(false));
  if (sendBtn) sendBtn.addEventListener('click', sendChat);
  if (input) input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  // file attach
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length) {
        uploadChatFiles([...fileInput.files]);
        fileInput.value = '';
      }
    });
  }
  const panelForDrag = panel || messagesBox;
  if (messagesBox) {
    messagesBox.addEventListener('dragover', (e) => { e.preventDefault(); messagesBox.classList.add('drag-over'); });
    messagesBox.addEventListener('dragleave', (e) => { if (!messagesBox.contains(e.relatedTarget)) messagesBox.classList.remove('drag-over'); });
    messagesBox.addEventListener('drop', (e) => {
      e.preventDefault(); messagesBox.classList.remove('drag-over');
      const files = [...(e.dataTransfer.files || [])];
      if (files.length) uploadChatFiles(files);
    });
  }
  if (panelForDrag && panelForDrag !== messagesBox) {
    panelForDrag.addEventListener('dragover', (e) => { e.preventDefault(); messagesBox?.classList.add('drag-over'); });
    panelForDrag.addEventListener('dragleave', (e) => { if (!panelForDrag.contains(e.relatedTarget)) messagesBox?.classList.remove('drag-over'); });
    panelForDrag.addEventListener('drop', (e) => {
      e.preventDefault(); messagesBox?.classList.remove('drag-over');
      const files = [...(e.dataTransfer.files || [])];
      if (files.length) uploadChatFiles(files);
    });
  }
  // click outside to close
  document.addEventListener('click', (e) => {
    if (!chatOpen || !panel || panel.hidden) return;
    if (fab && fab.contains(e.target)) return;
    if (panel.contains(e.target)) return;
  });
  // initial load and polling — быстро, без перезагрузки страницы
  chatLastIds = new Set(chatMessages.map(m => m.id));
  fetchChat(true);
  clearInterval(chatPollTimer);
  chatPollTimer = setInterval(() => fetchChat(false), 900);
}

/* ---------- init ---------- */

function render() {
  renderSidebar();
  renderMain();
  renderPane();
}

(async function init() {
  try {
    const saved = JSON.parse(localStorage.getItem('al-current') || 'null');
    if (saved && typeof saved === 'object') current = { view: 'mytasks', projectId: null, tab: 'list', ...saved };
  } catch { /* ignore */ }
  try {
    const info = await api('GET', '/api/auth-info');
    accountUrl = info.accountUrl || '';
    isOwnerUser = !!info.isOwner;
    currentUser = { name: info.name || '', sub: info.sub || '' };
  } catch { /* ссылка останется пустой */ }
  try {
    state = await getState();
    if (Array.isArray(state.chat)) { chatMessages = state.chat.slice(-200); chatLastIds = new Set(chatMessages.map(m => m.id)); }
  } catch (e) {
    showToast(e.message || 'Нет связи с сервером.');
    return;
  }
  render();
  initChat();
  // unlock audio on first user interaction (autoplay policy)
  const unlock = () => { try { const AC = window.AudioContext || window.webkitAudioContext; if (AC) { const c = new AC(); c.resume(); c.close(); } } catch {} document.removeEventListener('click', unlock); document.removeEventListener('keydown', unlock); };
  document.addEventListener('click', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });
})();
