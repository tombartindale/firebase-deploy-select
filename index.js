#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

// ── Project discovery ──────────────────────────────────────────────────────

function findFirebaseRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, 'firebase.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findIndexFile(firebaseRoot) {
  const candidates = [
    path.join(firebaseRoot, 'functions', 'src', 'index.ts'),
    path.join(firebaseRoot, 'functions', 'src', 'index.js'),
    path.join(firebaseRoot, 'functions', 'index.ts'),
    path.join(firebaseRoot, 'functions', 'index.js'),
  ];
  return candidates.find(fs.existsSync) || null;
}

function resolveProject() {
  const argIndex = process.argv.indexOf('--index');
  if (argIndex !== -1 && process.argv[argIndex + 1]) {
    const p = path.resolve(process.argv[argIndex + 1]);
    if (!fs.existsSync(p)) { console.error(`File not found: ${p}`); process.exit(1); }
    return { indexFile: p, firebaseRoot: findFirebaseRoot(path.dirname(p)) || process.cwd() };
  }

  const firebaseRoot = findFirebaseRoot(process.cwd());
  if (!firebaseRoot) { console.error('No firebase.json found in this directory or any parent.'); process.exit(1); }

  const indexFile = findIndexFile(firebaseRoot);
  if (!indexFile) { console.error(`No index.ts/index.js found under ${firebaseRoot}/functions/`); process.exit(1); }

  return { indexFile, firebaseRoot };
}

// ── Parsing ────────────────────────────────────────────────────────────────

function parseIndexFile(content) {
  const lines = content.split('\n');
  const requirePaths = {};
  for (const line of lines) {
    const m = line.match(/^\s*(?:const|let|var)\s+(\w+)\s*=\s*require\(['"](.+)['"]\)/);
    if (m) requirePaths[m[1]] = m[2];
  }

  const groups = [];
  const individuals = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\/\//.test(line)) { i++; continue; }

    const m = line.match(/^\s*exports\.(\w+)\s*=\s*(.*)/)
           || line.match(/^\s*export\s+(?:const|let|var|async\s+function|function)\s+(\w+)\s*[=(](.*)/)
           || line.match(/^\s*export\s+\{\s*(\w+)[,\s}]/);
    if (!m) { i++; continue; }

    const [, name, rhs] = m;
    const rhsTrimmed = rhs.trim().replace(/;$/, '').trim();

    if (rhsTrimmed === '{' || (rhsTrimmed.startsWith('{') && !rhsTrimmed.includes('}'))) {
      const members = [];
      i++;
      while (i < lines.length) {
        const ml = lines[i];
        if (/^\s*[}\]]/.test(ml)) break;
        const km = /^\s*\/\//.test(ml) ? null : ml.match(/^\s*(\w+)\s*:/);
        if (km) members.push(km[1]);
        i++;
      }
      groups.push({ name, members, source: 'inline' });
    } else if (requirePaths[rhsTrimmed]) {
      groups.push({ name, members: null, source: 'module', modulePath: requirePaths[rhsTrimmed] });
    } else {
      individuals.push(name);
    }
    i++;
  }

  return { groups, individuals };
}

function parseModuleExports(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const names = [];
  for (const line of content.split('\n')) {
    if (/^\s*\/\//.test(line)) continue;
    const m = line.match(/^\s*exports\.(\w+)\s*=/)
           || line.match(/^\s*export\s+(?:const|let|var|async\s+function|function)\s+(\w+)\s*[=(]/);
    if (m) names.push(m[1]);
  }
  return names;
}

function resolveGroupMembers(groups, indexFile) {
  const srcDir = path.dirname(indexFile);
  return groups.map(g => {
    if (g.source === 'inline') return g;
    const relPath = g.modulePath.replace(/^\.\//, '');
    const candidates = [
      path.join(srcDir, relPath + '.js'),
      path.join(srcDir, relPath + '.ts'),
      path.join(srcDir, relPath, 'index.js'),
    ];
    const filePath = candidates.find(fs.existsSync);
    return { ...g, members: filePath ? parseModuleExports(filePath) : [] };
  });
}

// ── UI ─────────────────────────────────────────────────────────────────────

function buildItems(groups, individuals, filter) {
  const f = filter ? filter.toLowerCase() : '';
  const items = [{ type: 'all' }];

  for (const g of groups) {
    if (f) {
      const groupMatches = g.name.toLowerCase().includes(f);
      const matchingMembers = g.members.filter(m =>
        m.toLowerCase().includes(f) || `${g.name}-${m}`.toLowerCase().includes(f)
      );
      if (!groupMatches && matchingMembers.length === 0) continue;
      items.push({ type: 'gsep', group: g });
      items.push({ type: 'group', group: g });
      const membersToShow = groupMatches ? g.members : matchingMembers;
      for (const m of membersToShow) {
        items.push({ type: 'member', group: g, member: m });
      }
    } else {
      items.push({ type: 'gsep', group: g });
      items.push({ type: 'group', group: g });
      if (g.expanded) {
        for (const m of g.members) {
          items.push({ type: 'member', group: g, member: m });
        }
      }
    }
  }

  if (individuals.length > 0) {
    const indsToShow = f
      ? individuals.filter(ind => ind.name.toLowerCase().includes(f))
      : individuals;
    if (indsToShow.length > 0) {
      items.push({ type: 'isep' });
      for (const ind of indsToShow) {
        items.push({ type: 'individual', ind });
      }
    }
  }

  return items;
}

function isSelectable(item) {
  return item.type !== 'gsep' && item.type !== 'isep';
}

function countSelected(groups, individuals, deployAll) {
  if (deployAll) return 'ALL';
  let n = 0;
  for (const g of groups) {
    if (g.deployAll) n++;
    else n += g.selectedMembers.size;
  }
  for (const ind of individuals) {
    if (ind.selected) n++;
  }
  return n;
}

const R = '\x1b[0m';
const DIM  = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

function renderLine(isCursor, checked, partial, text, dimText) {
  const cur = isCursor ? `${CYAN}❯${R}` : ' ';
  const cb  = checked  ? `${GREEN}[x]${R}`
             : partial  ? `${YELLOW}[-]${R}`
             : `${DIM}[ ]${R}`;
  const label = dimText ? `${DIM}${text}${R}` : isCursor ? `${BOLD}${text}${R}` : text;
  return ` ${cur} ${cb} ${label}`;
}

function renderScreen(groups, individuals, deployAll, filter, cursor, scrollTop, viewHeight) {
  const items = buildItems(groups, individuals, filter);
  const selected = countSelected(groups, individuals, deployAll);
  const out = [];

  out.push(`${BOLD}Firebase Function Deployer${R}`);
  out.push(`${DIM}[↑↓] move  [→] expand  [←] collapse  [space] select  [enter] deploy  [esc] clear filter${R}`);
  const filterDisplay = filter
    ? `Filter: ${CYAN}${filter}${R}█`
    : `${DIM}Filter: (type to search)${R}`;
  out.push(filterDisplay);
  out.push('');

  const visible = items.slice(scrollTop, scrollTop + viewHeight);

  for (let vi = 0; vi < visible.length; vi++) {
    const item = visible[vi];
    const ai = scrollTop + vi;
    const cur = ai === cursor;

    if (item.type === 'gsep') {
      const lbl = ` ── ${item.group.name} `;
      out.push(`${DIM}${lbl}${'─'.repeat(Math.max(0, 46 - lbl.length))}${R}`);
      continue;
    }
    if (item.type === 'isep') {
      out.push(`${DIM} ── Individual functions ${'─'.repeat(23)}${R}`);
      continue;
    }
    if (item.type === 'all') {
      out.push(renderLine(cur, deployAll, false, '★  Deploy ALL functions', false));
      continue;
    }
    if (item.type === 'group') {
      const g = item.group;
      const arrow = g.members.length > 0 ? (g.expanded ? '▼' : '▶') : ' ';
      out.push(renderLine(cur, g.deployAll, g.selectedMembers.size > 0 && !g.deployAll, `${arrow} ${g.name}`, false));
      continue;
    }
    if (item.type === 'member') {
      const sel = item.group.selectedMembers.has(item.member);
      out.push(renderLine(cur, sel, false, `    ${item.group.name}-${item.member}`, !cur && !sel));
      continue;
    }
    if (item.type === 'individual') {
      out.push(renderLine(cur, item.ind.selected, false, item.ind.name, false));
    }
  }

  out.push('');
  const total = items.filter(isSelectable).length;
  out.push(`${DIM} ${cursor + 1}/${items.length}  visible: ${total}  selected: ${selected}${R}`);

  process.stdout.write('\x1b[2J\x1b[H' + out.join('\n'));
}

function buildDeployCommand(groups, individuals, deployAll) {
  if (deployAll) return 'firebase deploy --only "functions"';
  const parts = [];
  for (const g of groups) {
    if (g.deployAll) {
      parts.push(`functions:${g.name}`);
    } else {
      for (const m of g.selectedMembers) {
        parts.push(`functions:${g.name}-${m}`);
      }
    }
  }
  for (const ind of individuals) {
    if (ind.selected) parts.push(`functions:${ind.name}`);
  }
  return parts.length > 0 ? `firebase deploy --only "${parts.join(',')}"` : null;
}

async function runSelector(groups, individuals) {
  let deployAll = false;
  let filter = '';
  let cursor = 0;
  let scrollTop = 0;
  const HEADER = 4;
  const FOOTER = 2;
  const viewHeight = Math.max(5, (process.stdout.rows || 30) - HEADER - FOOTER);

  function getItems() { return buildItems(groups, individuals, filter); }

  function adjustScroll() {
    if (cursor < scrollTop) scrollTop = cursor;
    if (cursor >= scrollTop + viewHeight) scrollTop = cursor - viewHeight + 1;
  }

  function clampCursor() {
    const items = getItems();
    if (items.length === 0) { cursor = 0; return; }
    // If current cursor is out of range or on a separator, find next selectable
    if (cursor >= items.length || !isSelectable(items[cursor])) {
      cursor = items.findIndex(isSelectable);
      if (cursor === -1) cursor = 0;
    }
    adjustScroll();
  }

  function moveCursor(delta) {
    const items = getItems();
    let next = cursor + delta;
    while (next >= 0 && next < items.length && !isSelectable(items[next])) next += delta;
    if (next >= 0 && next < items.length) { cursor = next; adjustScroll(); }
  }

  function draw() { clampCursor(); renderScreen(groups, individuals, deployAll, filter, cursor, scrollTop, viewHeight); }

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  draw();

  return new Promise((resolve) => {
    process.stdin.on('keypress', (str, key) => {
      if (!key) return;
      const items = getItems();
      const item = items[cursor];

      if (key.ctrl && key.name === 'c') {
        cleanup(); console.log('Aborted.'); process.exit(0);
      }

      if (key.name === 'escape') {
        filter = '';
      }
      else if (key.name === 'backspace') {
        filter = filter.slice(0, -1);
      }
      else if (key.name === 'up')   { moveCursor(-1); }
      else if (key.name === 'down') { moveCursor(1); }
      else if (key.name === 'right') {
        if (item?.type === 'group' && item.group.members.length > 0 && !item.group.expanded)
          item.group.expanded = true;
      }
      else if (key.name === 'left') {
        if (item?.type === 'member') {
          item.group.expanded = false;
          const gi = getItems().findIndex(i => i.type === 'group' && i.group === item.group);
          if (gi >= 0) { cursor = gi; adjustScroll(); }
        } else if (item?.type === 'group' && item.group.expanded) {
          item.group.expanded = false;
        }
      }
      else if (key.name === 'space') {
        if      (item?.type === 'all')        deployAll = !deployAll;
        else if (item?.type === 'group')      item.group.deployAll = !item.group.deployAll;
        else if (item?.type === 'member') {
          if (item.group.selectedMembers.has(item.member)) item.group.selectedMembers.delete(item.member);
          else item.group.selectedMembers.add(item.member);
        }
        else if (item?.type === 'individual') item.ind.selected = !item.ind.selected;
      }
      else if (key.name === 'return') {
        cleanup();
        resolve(buildDeployCommand(groups, individuals, deployAll));
        return;
      }
      else if (str && str.length === 1 && !key.ctrl && !key.meta) {
        // Printable character — append to filter
        filter += str;
        cursor = 0;
        scrollTop = 0;
      }

      draw();
    });
  });
}

function cleanup() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[2J\x1b[H');
}

async function confirm(command) {
  process.stdout.write(`  ${command}\n\n  Proceed? [y/N] `);
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise(resolve => {
    process.stdin.once('keypress', (str) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write((str || '') + '\n');
      resolve(str && str.toLowerCase() === 'y');
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { indexFile, firebaseRoot } = resolveProject();

  const content = fs.readFileSync(indexFile, 'utf8');
  const { groups: rawGroups, individuals: rawIndividuals } = parseIndexFile(content);
  const resolvedGroups = resolveGroupMembers(rawGroups, indexFile).map(g => ({
    ...g, expanded: false, deployAll: false, selectedMembers: new Set(),
  }));
  const individuals = rawIndividuals.map(name => ({ name, selected: false }));

  const command = await runSelector(resolvedGroups, individuals);
  if (!command) { console.log('Nothing selected.'); return; }

  const ok = await confirm(command);
  if (ok) {
    execSync(command, { stdio: 'inherit', cwd: firebaseRoot });
  } else {
    console.log('Aborted.');
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
