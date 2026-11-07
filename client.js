/*
 * dsh-daily-review — browser half.
 *
 * Registers one row in `sidebar.panellist` and the matching `main` panel.
 * Every byte of data lives on disk behind the host's loopback routes; this
 * module only renders React and calls those routes with fetch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-daily-review',
  factory: function dailyReviewFactory(require) {
    'use strict';

    let React = null;
    try {
      React = require('react');
    } catch {
      return { inject: [], apply() {} };
    }
    if (React === null || typeof React.createElement !== 'function') {
      return { inject: [], apply() {} };
    }

    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useMemo = React.useMemo;
    const useRef = React.useRef;
    const useCallback = React.useCallback;

    const PANEL_ID = 'daily-review';
    const API = '/api/dsh-daily-review/';
    const MAX_BODY_BYTES_HINT = 200 * 1024;
    const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const MONTH_LABEL = ['', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

    /* ---------------------------------------------------------------- */
    /* panel navigation memory (survives panel switching)                */
    /* ---------------------------------------------------------------- */

    const nav = { view: { kind: 'overview' } };

    /* ---------------------------------------------------------------- */
    /* api                                                              */
    /* ---------------------------------------------------------------- */

    async function api(action, options) {
      const settings = options || {};
      const response = await fetch(API + action, {
        method: settings.method || 'GET',
        headers: settings.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const message = payload !== null && typeof payload.error === 'string' ? payload.error : '请求失败（' + response.status + '）';
        const error = new Error(message);
        error.code = payload !== null && typeof payload.code === 'string' ? payload.code : 'http-error';
        throw error;
      }
      return payload;
    }

    const post = (action, body) => api(action, { method: 'POST', body: body || {} });
    const get = (action, params) => {
      const search = new URLSearchParams();
      for (const key of Object.keys(params || {})) {
        const value = params[key];
        if (value === undefined || value === null || value === '') continue;
        search.set(key, String(value));
      }
      const query = search.toString();
      return api(action + (query === '' ? '' : '?' + query));
    };

    /* ---------------------------------------------------------------- */
    /* formatting helpers                                               */
    /* ---------------------------------------------------------------- */

    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    function todayKey() {
      const now = new Date();
      return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function parseDateKey(key) {
      const parts = String(key || '').split('-').map(Number);
      if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
      return new Date(parts[0], parts[1] - 1, parts[2]);
    }

    function weekdayOf(key) {
      const date = parseDateKey(key);
      return date === null ? '' : WEEKDAYS[date.getDay()];
    }

    function groupTitle(key) {
      const date = parseDateKey(key);
      if (date === null) return String(key);
      return (date.getMonth() + 1) + '月' + date.getDate() + '日 · ' + WEEKDAYS[date.getDay()];
    }

    function timeOf(stamp) {
      const text = String(stamp || '');
      const match = /T(\d{2}):(\d{2})/.exec(text);
      return match === null ? '' : match[1] + ':' + match[2];
    }

    function relativeLabel(key) {
      const today = todayKey();
      if (key === today) return '今天';
      const yesterday = parseDateKey(today);
      if (yesterday !== null) {
        yesterday.setDate(yesterday.getDate() - 1);
        if (key === yesterday.getFullYear() + '-' + pad2(yesterday.getMonth() + 1) + '-' + pad2(yesterday.getDate())) return '昨天';
      }
      return '';
    }

    function escapeRegExp(text) {
      return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function splitBody(text) {
      const source = String(text || '').replace(/\r\n/g, '\n');
      const lines = source.split('\n');
      const preface = [];
      const blocks = [];
      let current = null;
      for (const line of lines) {
        const match = /^##[ ]+(.+?)[ ]*$/.exec(line);
        if (match !== null) {
          current = { name: match[1].trim(), content: '' , buffer: [] };
          blocks.push(current);
          continue;
        }
        if (current === null) preface.push(line);
        else current.buffer.push(line);
      }
      for (const block of blocks) {
        block.content = block.buffer.join('\n');
        delete block.buffer;
      }
      return { preface: preface.join('\n'), blocks };
    }

    function joinBody(parts) {
      const chunks = [];
      const preface = String(parts.preface || '').replace(/^\n+/, '').replace(/\n+$/, '');
      if (preface.trim() !== '') chunks.push(preface);
      for (const block of parts.blocks) {
        const content = String(block.content || '').replace(/^\n+/, '').replace(/\n+$/, '');
        chunks.push('## ' + block.name + (content === '' ? '' : '\n\n' + content));
      }
      return chunks.length === 0 ? '' : chunks.join('\n\n') + '\n';
    }

    function skeletonOf(sections) {
      const names = (sections || []).map(section => (typeof section === 'string' ? section : section.name)).filter(Boolean);
      if (names.length === 0) return '';
      return names.map(name => '## ' + name + '\n\n').join('').replace(/\n+$/, '\n');
    }

    function hasRealContent(text) {
      const source = String(text || '');
      const withoutHeadings = source.replace(/^##[ ]+.*$/gm, '').replace(/\s+/g, '');
      return withoutHeadings !== '';
    }

    function caretAfterFirstSection(text) {
      const match = /^##[ ]+.*\n+/.exec(String(text || ''));
      if (match === null) return String(text || '').length;
      return match[0].length;
    }

    /** Rebuild a complete .md document (frontmatter + body) for export. */
    function buildEntryMarkdown(entry) {
      const sections = Array.isArray(entry.sections) ? entry.sections : [];
      const lines = ['---', 'date: ' + entry.date, 'title: ' + (entry.title || ''), 'folder: ' + entry.folder];
      if (sections.length === 0) lines.push('sections: []');
      else {
        lines.push('sections:');
        for (const section of sections) lines.push('  - ' + section);
      }
      lines.push('created: ' + (entry.created || ''), 'updated: ' + (entry.updated || ''), '---', '');
      return lines.join('\n') + (entry.body || '');
    }

    /** Save a text file through the browser; returns false when unsupported. */
    function downloadText(fileName, text) {
      try {
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return true;
      } catch {
        return false;
      }
    }

    /* ---------------------------------------------------------------- */
    /* markdown renderer (small, dependency free)                        */
    /* ---------------------------------------------------------------- */

    function renderInline(text, keyPrefix) {
      const nodes = [];
      const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)]+)/g;
      let cursor = 0;
      let index = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
        const token = match[0];
        const key = keyPrefix + '-' + index++;
        if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
          nodes.push(h('strong', { key }, token.slice(2, -2)));
        } else if (token.startsWith('__') && token.endsWith('__') && token.length > 4) {
          nodes.push(h('strong', { key }, token.slice(2, -2)));
        } else if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
          nodes.push(h('code', { key, className: 'dr-code' }, token.slice(1, -1)));
        } else if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
          nodes.push(h('em', { key }, token.slice(1, -1)));
        } else if (token.startsWith('_') && token.endsWith('_') && token.length > 2) {
          nodes.push(h('em', { key }, token.slice(1, -1)));
        } else if (token.startsWith('[')) {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
          if (link !== null) {
            nodes.push(h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer noopener', className: 'dr-link' }, link[1]));
          } else nodes.push(token);
        } else if (token.startsWith('http')) {
          nodes.push(h('a', { key, href: token, target: '_blank', rel: 'noreferrer noopener', className: 'dr-link' }, token));
        } else nodes.push(token);
        cursor = match.index + token.length;
      }
      if (cursor < text.length) nodes.push(text.slice(cursor));
      return nodes;
    }

    function renderMarkdown(source) {
      const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
      const out = [];
      let index = 0;
      let listBuffer = [];
      let listOrdered = false;

      const flushList = () => {
        if (listBuffer.length === 0) return;
        const items = listBuffer.map((item, position) =>
          h('li', { key: 'li-' + index + '-' + position }, renderInline(item, 'li-' + index + '-' + position)));
        out.push(h(listOrdered ? 'ol' : 'ul', { key: 'list-' + index++, className: 'dr-list' }, items));
        listBuffer = [];
      };

      while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trim();

        if (/^```/.test(trimmed)) {
          flushList();
          const codeLines = [];
          index += 1;
          while (index < lines.length && !/^```/.test(lines[index].trim())) {
            codeLines.push(lines[index]);
            index += 1;
          }
          if (index < lines.length) index += 1;
          out.push(h('pre', { key: 'pre-' + index, className: 'dr-pre' }, h('code', null, codeLines.join('\n'))));
          continue;
        }

        if (trimmed === '') {
          flushList();
          index += 1;
          continue;
        }

        if (/^(---|\*\*\*|___)$/.test(trimmed)) {
          flushList();
          out.push(h('hr', { key: 'hr-' + index, className: 'dr-hr' }));
          index += 1;
          continue;
        }

        const heading = /^(#{1,6})[ ]+(.*)$/.exec(trimmed);
        if (heading !== null) {
          flushList();
          const level = Math.min(6, heading[1].length);
          const size = level <= 2 ? 'dr-h2' : level === 3 ? 'dr-h3' : 'dr-h4';
          out.push(h('div', { key: 'head-' + index, className: 'dr-heading ' + size }, renderInline(heading[2], 'head-' + index)));
          index += 1;
          continue;
        }

        if (/^>[ ]?/.test(trimmed)) {
          flushList();
          const quoteLines = [];
          while (index < lines.length && /^>[ ]?/.test(lines[index].trim())) {
            quoteLines.push(lines[index].trim().replace(/^>[ ]?/, ''));
            index += 1;
          }
          out.push(h('blockquote', { key: 'quote-' + index, className: 'dr-quote' }, renderInline(quoteLines.join(' '), 'quote-' + index)));
          continue;
        }

        const ordered = /^\d+\.[ ]+(.*)$/.exec(trimmed);
        if (ordered !== null) {
          if (listBuffer.length > 0 && !listOrdered) flushList();
          listOrdered = true;
          listBuffer.push(ordered[1]);
          index += 1;
          continue;
        }

        const bullet = /^[-+*][ ]+(.*)$/.exec(trimmed);
        if (bullet !== null) {
          if (listBuffer.length > 0 && listOrdered) flushList();
          listOrdered = false;
          listBuffer.push(bullet[1]);
          index += 1;
          continue;
        }

        flushList();
        out.push(h('p', { key: 'p-' + index, className: 'dr-para' }, renderInline(line, 'p-' + index)));
        index += 1;
      }
      flushList();
      return out;
    }

    /* ---------------------------------------------------------------- */
    /* styles                                                           */
    /* ---------------------------------------------------------------- */

    const CSS = `
.dr-panel {
  position: relative;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 1.6;
  overflow: hidden;
}
.dr-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.dr-page { max-width: 980px; margin: 0 auto; padding: 32px; box-sizing: border-box; }
.dr-pageWide { max-width: 1180px; }

.dr-topbar {
  display: flex; align-items: center; gap: 12px;
  padding: 20px 32px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: none;
}
.dr-topbarMain { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dr-title { font-size: 17px; font-weight: 600; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dr-sub { color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.dr-spacer { flex: 1; }

.dr-btn {
  appearance: none; box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 34px; padding: 0 14px;
  border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2);
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13.5px; cursor: pointer;
  transition: background 150ms ease, border-color 150ms ease, color 150ms ease;
  white-space: nowrap;
}
.dr-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.dr-btn:disabled { opacity: .45; cursor: not-allowed; }
.dr-btnPrimary {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  color: #fff;
}
.dr-btnPrimary:hover { filter: brightness(1.05); background: var(--dsw-alias-brand-primary); }
.dr-btnQuiet { border-color: transparent; padding: 0 10px; height: 30px; }
.dr-btnQuiet:hover { background: var(--dsw-alias-bg-layer-2); }
.dr-btnDanger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dr-btnDanger:hover { background: var(--dsw-alias-bg-layer-2); }

.dr-iconBtn {
  appearance: none; border: 1px solid transparent; background: transparent; cursor: pointer;
  width: 32px; height: 32px; border-radius: 12px; color: var(--dsw-alias-label-secondary);
  display: inline-flex; align-items: center; justify-content: center;
  transition: background 150ms ease, color 150ms ease;
}
.dr-iconBtn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }

.dr-grid {
  display: grid; gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
}
.dr-card {
  position: relative; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 20px;
  cursor: pointer;
  transition: border-color 150ms ease, background 150ms ease, transform 150ms ease;
  text-align: left; color: inherit; font: inherit;
  display: flex; flex-direction: column; gap: 10px; min-height: 128px;
}
.dr-card:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.dr-cardDragging { opacity: .5; }
.dr-cardDropTarget { border-color: var(--dsw-alias-brand-primary); }
.dr-cardHead { display: flex; align-items: center; gap: 9px; min-width: 0; }
.dr-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.dr-cardName { font-size: 15px; font-weight: 600; letter-spacing: .01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dr-cardMeta { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.dr-cardFooter { display: flex; align-items: center; gap: 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: auto; }
.dr-cardMenu {
  position: absolute; top: 10px; right: 10px;
  opacity: .55; transition: opacity 150ms ease;
}
.dr-card:hover .dr-cardMenu, .dr-cardMenuOpen, .dr-cardMenu:focus-within { opacity: 1; }

.dr-menu {
  position: absolute; right: 0; top: 36px; z-index: 40; min-width: 148px;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px; padding: 6px;
}
.dr-menuItem {
  appearance: none; width: 100%; text-align: left; background: transparent; border: 0;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer;
  padding: 8px 10px; border-radius: 8px; transition: background 150ms ease;
}
.dr-menuItem:hover { background: var(--dsw-alias-bg-layer-2); }
.dr-menuItemDanger { color: var(--dsw-alias-state-error-primary); }

.dr-empty {
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  padding: 64px 24px; color: var(--dsw-alias-label-secondary); text-align: center;
}
.dr-emptyText { font-size: 14px; }

.dr-group { margin-bottom: 24px; }
.dr-groupHead {
  display: flex; align-items: baseline; gap: 8px;
  padding: 6px 2px 10px;
}
.dr-groupTitle { font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dr-groupHint { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dr-groupFlash { animation: drFlash 1.5s ease forwards; }
@keyframes drFlash {
  0% { background: var(--dsw-alias-bg-layer-2); }
  100% { background: transparent; }
}

.dr-entry {
  display: flex; flex-direction: column; gap: 6px;
  width: 100%; text-align: left; font: inherit; color: inherit;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px; padding: 14px 16px; margin-bottom: 12px;
  background: var(--dsw-alias-bg-layer-1); cursor: pointer;
  transition: border-color 150ms ease, background 150ms ease;
}
.dr-entry:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.dr-entryTop { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dr-entryTitle { font-size: 14.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dr-entryTime { color: var(--dsw-alias-label-secondary); font-size: 12px; flex: none; }
.dr-entryBody { color: var(--dsw-alias-label-secondary); font-size: 13px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.dr-badge {
  font-size: 11px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary);
}
.dr-badgeWarn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }

.dr-reader { max-width: 68ch; }
.dr-readerHead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.dr-readerTitle { font-size: 20px; font-weight: 650; margin: 0; }
.dr-readerMeta { color: var(--dsw-alias-label-secondary); font-size: 12.5px; display: flex; gap: 10px; flex-wrap: wrap; }
.dr-readerBody { font-size: 15px; line-height: 1.75; margin-top: 22px; }
.dr-heading { font-weight: 600; margin: 24px 0 10px; color: var(--dsw-alias-label-primary); }
.dr-h2 { font-size: 18px; }
.dr-h3 { font-size: 15.5px; }
.dr-h4 { font-size: 14.5px; }
.dr-para { margin: 0 0 12px; }
.dr-list { margin: 0 0 14px; padding-left: 22px; }
.dr-list li { margin: 3px 0; }
.dr-quote {
  margin: 0 0 14px; padding: 2px 0 2px 14px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.dr-hr { border: 0; border-top: 1px solid var(--dsw-alias-border-l1); margin: 20px 0; }
.dr-code {
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace;
  font-size: 12.5px; padding: 1px 5px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
}
.dr-pre {
  margin: 0 0 14px; padding: 12px 14px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2); overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace;
  font-size: 12.5px; line-height: 1.6;
}
.dr-link { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.dr-link:hover { text-decoration: underline; }

.dr-editor { display: flex; flex-direction: column; gap: 20px; max-width: 900px; }
.dr-field { display: flex; flex-direction: column; gap: 7px; }
.dr-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dr-input, .dr-textarea, .dr-select {
  box-sizing: border-box; width: 100%;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13.5px; padding: 9px 12px;
  transition: border-color 150ms ease;
}
.dr-input:focus, .dr-textarea:focus, .dr-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dr-textarea {
  min-height: 340px; resize: vertical; line-height: 1.7;
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace;
  font-size: 13px;
}
.dr-row { display: flex; gap: 12px; flex-wrap: wrap; }
.dr-row > .dr-field { flex: 1 1 180px; }

.dr-chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dr-chip {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px; padding: 4px 6px 4px 12px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12.5px; color: var(--dsw-alias-label-primary);
  transition: border-color 150ms ease, background 150ms ease;
  cursor: grab;
}
.dr-chip:hover { border-color: var(--dsw-alias-brand-primary); }
.dr-chipDragging { opacity: .45; }
.dr-chipDrop { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dr-chipName { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dr-chipX {
  appearance: none; border: 0; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary); width: 20px; height: 20px; border-radius: 999px;
  display: inline-flex; align-items: center; justify-content: center; font-size: 13px;
}
.dr-chipX:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-error-primary); }
.dr-chipInput {
  border: 1px solid var(--dsw-alias-brand-primary); border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; font-size: 12.5px;
  padding: 3px 10px; width: 140px;
}
.dr-toolsRow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

.dr-modalBackdrop {
  position: fixed; inset: 0; z-index: 200;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.dr-modal {
  box-sizing: border-box; width: min(560px, 100%); max-height: 86vh; overflow-y: auto;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 16px; padding: 24px;
  display: flex; flex-direction: column; gap: 18px;
}
.dr-modalWide { width: min(900px, 100%); }
.dr-modalTitle { font-size: 16px; font-weight: 650; margin: 0; }
.dr-modalActions { display: flex; justify-content: flex-end; gap: 10px; }
.dr-modalHint { color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.65; }

.dr-palette { display: flex; flex-wrap: wrap; gap: 10px; }
.dr-color {
  width: 26px; height: 26px; border-radius: 999px; border: 2px solid transparent; cursor: pointer;
  transition: transform 150ms ease, border-color 150ms ease; padding: 0;
}
.dr-colorActive { border-color: var(--dsw-alias-label-primary); transform: scale(1.06); }

.dr-similarity { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.dr-preview {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 12px 14px;
  background: var(--dsw-alias-bg-layer-1);
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace;
  font-size: 12px; line-height: 1.7; white-space: pre-wrap; color: var(--dsw-alias-label-secondary);
  max-height: 240px; overflow-y: auto; margin: 0;
}

.dr-calendar { position: relative; }
.dr-calPopover {
  position: absolute; right: 0; top: 40px; z-index: 60; width: 268px;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 16px; padding: 14px;
}
.dr-calHead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.dr-calTitle { font-size: 13px; font-weight: 600; }
.dr-calGrid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.dr-calCell {
  position: relative; aspect-ratio: 1 / 1; border: 0; background: transparent; cursor: pointer;
  border-radius: 8px; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px;
  display: flex; align-items: center; justify-content: center;
  transition: background 150ms ease;
}
.dr-calCell:hover { background: var(--dsw-alias-bg-layer-2); }
.dr-calMuted { color: var(--dsw-alias-label-secondary); opacity: .45; }
.dr-calToday { border: 1px solid var(--dsw-alias-brand-primary); }
.dr-calSelected { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.dr-calDot {
  position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%);
  width: 3px; height: 3px; border-radius: 50%; background: var(--dsw-alias-brand-primary);
}
.dr-calDow { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; margin-bottom: 4px; }
.dr-calDowCell { text-align: center; font-size: 11px; color: var(--dsw-alias-label-secondary); }

.dr-searchWrap { position: relative; flex: 0 1 260px; min-width: 120px; }
.dr-searchInput {
  box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
}
.dr-searchInput:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dr-searchScope { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; overflow: hidden; }
.dr-scopeBtn {
  appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; padding: 6px 10px; cursor: pointer;
}
.dr-scopeBtnActive { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }

.dr-hit {
  width: 100%; text-align: left; font: inherit; color: inherit; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; margin-bottom: 10px;
}
.dr-hit:hover { background: var(--dsw-alias-bg-layer-2); }
.dr-hitHead { display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--dsw-alias-label-secondary); margin-bottom: 5px; }
.dr-hitSnippet { font-size: 13px; line-height: 1.65; }
.dr-mark { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent); border-radius: 3px; padding: 0 1px; color: var(--dsw-alias-label-primary); }

.dr-notice {
  display: flex; align-items: center; gap: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 12px; padding: 10px 14px; margin-bottom: 20px;
  font-size: 12.5px; color: var(--dsw-alias-label-secondary);
}
.dr-noticeText { flex: 1; }
.dr-error {
  border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
  border-radius: 12px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px;
}
.dr-loading { color: var(--dsw-alias-label-secondary); font-size: 13px; padding: 32px 0; text-align: center; }
.dr-hstack { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dr-vstack { display: flex; flex-direction: column; gap: 12px; }
`;

    /* ---------------------------------------------------------------- */
    /* shared bits                                                      */
    /* ---------------------------------------------------------------- */

    function Icon(props) {
      const size = props !== null && typeof props.size === 'number' ? props.size : 16;
      return h(
        'svg',
        {
          'data-dsh-panel-entry': PANEL_ID,
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { key: 'book', d: 'M3.2 2.4h7.1a1.6 1.6 0 0 1 1.6 1.6v9.6H4.8a1.6 1.6 0 0 0-1.6 1.6z' }),
        h('path', { key: 'spine', d: 'M3.2 13.2V2.4' }),
        h('path', { key: 'l1', d: 'M5.6 5.4h4.4M5.6 8h4.4M5.6 10.6h2.6' }),
      );
    }

    function EmptyState(props) {
      return h(
        'div',
        { className: 'dr-empty' },
        h(
          'svg',
          { viewBox: '0 0 96 72', width: '88', height: '66', fill: 'none', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
          h('path', { key: 'a', d: 'M22 14h36a6 6 0 0 1 6 6v40H28a6 6 0 0 0-6 6z' }),
          h('path', { key: 'b', d: 'M22 60V14' }),
          h('path', { key: 'c', d: 'M32 26h24M32 34h24M32 42h14' }),
          h('path', { key: 'd', d: 'M70 40l4 4 8-9', strokeDasharray: '0' }),
        ),
        h('div', { className: 'dr-emptyText' }, props.text || '这里还没有记录，写第一条？'),
        props.action || null,
      );
    }

    function Modal(props) {
      useEffect(() => {
        function onKey(event) {
          if (event.key === 'Escape') props.onClose();
        }
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [props.onClose]);
      return h(
        'div',
        {
          className: 'dr-modalBackdrop',
          onMouseDown: event => {
            if (event.target === event.currentTarget) props.onClose();
          },
        },
        h('div', { className: 'dr-modal' + (props.wide === true ? ' dr-modalWide' : ''), role: 'dialog', 'aria-modal': 'true' }, props.children),
      );
    }

    function colorDot(color) {
      return h('span', { className: 'dr-dot', style: { background: color } });
    }

    function highlightSnippet(text, query) {
      const source = String(text || '');
      const needle = String(query || '').trim();
      if (needle === '') return source;
      const parts = source.split(new RegExp('(' + escapeRegExp(needle) + ')', 'gi'));
      return parts.map((part, index) =>
        part.toLowerCase() === needle.toLowerCase()
          ? h('mark', { key: 'm-' + index, className: 'dr-mark' }, part)
          : part);
    }

    /* ---------------------------------------------------------------- */
    /* template editor (folder create / folder template settings)        */
    /* ---------------------------------------------------------------- */

    const PALETTE = ['#6C8EBF', '#B8865B', '#7FA05B', '#A06B9F', '#C97B63', '#5FA3A6', '#8C8C99', '#C2A24A', '#6F8FB8', '#9B7B6B', '#6BA292', '#A8627B'];
    const DEFAULT_SECTIONS = ['今日学习与总结', '今日感恩和收获', '明日时间规划', 'DDL'];

    function TemplateEditor(props) {
      const [sections, setSections] = useState(props.sections);
      const [dragIndex, setDragIndex] = useState(null);
      const [dropIndex, setDropIndex] = useState(null);

      useEffect(() => {
        props.onChange(sections.map(section => section.name).filter(name => name.trim() !== ''));
      }, [sections]);

      function rename(index, name) {
        setSections(current => current.map((section, position) => position === index ? { ...section, name } : section));
      }
      function remove(index) {
        setSections(current => current.length <= 1 ? current : current.filter((_section, position) => position !== index));
      }
      function add() {
        setSections(current => current.concat([{ id: 's' + (Date.now().toString(36)), name: '' }]));
      }
      function move(from, to) {
        if (from === null || to === null || from === to) return;
        setSections(current => {
          const next = current.slice();
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          return next;
        });
      }

      const preview = skeletonOf(sections.map(section => section.name.trim() === '' ? '（未命名板块）' : section.name));

      return h(
        'div',
        { className: 'dr-similarity' },
        h(
          'div',
          { className: 'dr-vstack' },
          sections.map((section, index) =>
            h(
              'div',
              {
                key: section.id,
                className: 'dr-hstack',
                draggable: true,
                onDragStart: () => setDragIndex(index),
                onDragOver: event => { event.preventDefault(); setDropIndex(index); },
                onDragEnd: () => { move(dragIndex, dropIndex); setDragIndex(null); setDropIndex(null); },
              },
              h('span', { className: 'dr-sub', style: { width: '18px', flex: 'none', cursor: 'grab' } }, '⋮⋮'),
              h('input', {
                className: 'dr-input',
                value: section.name,
                placeholder: '板块名，例如「今日学习与总结」',
                onChange: event => rename(index, event.target.value),
              }),
              h('button', {
                type: 'button',
                className: 'dr-iconBtn',
                title: '删除这个板块',
                disabled: sections.length <= 1,
                onClick: () => remove(index),
              }, '×'),
            )),
          h(
            'div',
            { className: 'dr-hstack' },
            h('button', { type: 'button', className: 'dr-btn', onClick: add }, '+ 添加板块'),
            h('span', { className: 'dr-sub' }, '至少保留 1 个板块'),
          ),
        ),
        h(
          'div',
          { className: 'dr-vstack' },
          h('div', { className: 'dr-label' }, '实时预览'),
          h('pre', { className: 'dr-preview' }, preview === '' ? '（还没有板块，新建的条目正文会是空的）' : preview),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* folder creation                                                  */
    /* ---------------------------------------------------------------- */

    function CreateFolderModal(props) {
      const [name, setName] = useState('');
      const [color, setColor] = useState(PALETTE[props.nextOrder % PALETTE.length] || PALETTE[0]);
      const [sections, setSections] = useState(DEFAULT_SECTIONS.map((section, index) => ({ id: 's' + index, name: section })));
      const [names, setNames] = useState(DEFAULT_SECTIONS);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);

      const duplicate = props.existing.some(existing => existing === name.trim());
      const canCreate = name.trim() !== '' && names.length >= 1 && !duplicate && !busy;

      async function submit() {
        if (!canCreate) return;
        setBusy(true);
        setError('');
        try {
          const payload = await post('folders/create', {
            name: name.trim(),
            color,
            sections: names.map((sectionName, index) => ({ id: 's' + index, name: sectionName })),
          });
          props.onCreated(payload.folder);
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy(false);
        }
      }

      return h(
        Modal,
        { onClose: props.onClose, wide: true },
        h('h2', { className: 'dr-modalTitle' }, '新建文件夹'),
        h(
          'div',
          { className: 'dr-row' },
          h('div', { className: 'dr-field', style: { flex: '2 1 240px' } },
            h('label', { className: 'dr-label' }, '名称'),
            h('input', {
              className: 'dr-input',
              value: name,
              placeholder: '例如「学习」',
              autoFocus: true,
              onChange: event => setName(event.target.value),
            }),
            duplicate ? h('div', { className: 'dr-sub', style: { color: 'var(--dsw-alias-state-error-primary)' } }, '已经有同名文件夹了') : null,
          ),
          h('div', { className: 'dr-field', style: { flex: '1 1 160px' } },
            h('label', { className: 'dr-label' }, '颜色'),
            h('div', { className: 'dr-palette' },
              PALETTE.map(presetColor =>
                h('button', {
                  key: presetColor,
                  type: 'button',
                  className: 'dr-color' + (presetColor === color ? ' dr-colorActive' : ''),
                  style: { background: presetColor },
                  title: presetColor,
                  onClick: () => setColor(presetColor),
                }))),
          ),
        ),
        h('div', { className: 'dr-field' },
          h('label', { className: 'dr-label' }, '板块模板（新条目的初始骨架）'),
          h(TemplateEditor, { sections, onChange: setNames }),
        ),
        error === '' ? null : h('div', { className: 'dr-error' }, error),
        h(
          'div',
          { className: 'dr-modalActions' },
          h('button', { type: 'button', className: 'dr-btn', onClick: props.onClose }, '取消'),
          h('button', { type: 'button', className: 'dr-btn dr-btnPrimary', disabled: !canCreate, onClick: submit }, busy ? '创建中…' : '创建'),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* folder overview                                                  */
    /* ---------------------------------------------------------------- */

    function FolderCard(props) {
      const [menuOpen, setMenuOpen] = useState(false);
      const [dragOver, setDragOver] = useState(false);
      const ref = useRef(null);

      useEffect(() => {
        if (!menuOpen) return undefined;
        function onDown(event) {
          if (ref.current !== null && ref.current.contains(event.target)) return;
          setMenuOpen(false);
        }
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [menuOpen]);

      const folder = props.folder;
      const recent = folder.lastDate === '' ? '还没有记录' : '最近 ' + folder.lastDate;

      return h(
        'div',
        {
          ref,
          className: 'dr-card' + (props.dragging ? ' dr-cardDragging' : '') + (dragOver ? ' dr-cardDropTarget' : ''),
          role: 'button',
          tabIndex: 0,
          draggable: true,
          onClick: () => props.onOpen(folder),
          onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') props.onOpen(folder); },
          onDragStart: event => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', folder.id);
            props.onDragStart(folder.id);
          },
          onDragOver: event => { event.preventDefault(); setDragOver(true); },
          onDragLeave: () => setDragOver(false),
          onDrop: event => {
            event.preventDefault();
            setDragOver(false);
            props.onDrop(folder.id);
          },
          onDragEnd: () => { setDragOver(false); props.onDragEnd(); },
        },
        h(
          'div',
          { className: 'dr-cardHead' },
          colorDot(folder.color),
          h('span', { className: 'dr-cardName' }, folder.name),
        ),
        h(
          'div',
          { className: 'dr-cardMeta' },
          h('span', null, folder.count + ' 篇'),
          h('span', null, recent),
          h('span', null, '本月写了 ' + folder.monthDays + ' 天'),
        ),
        h('div', { className: 'dr-cardFooter' }, h('span', null, folder.sections.join(' · ') || '（模板没有板块）')),
        h(
          'div',
          { className: 'dr-cardMenu' + (menuOpen ? ' dr-cardMenuOpen' : '') },
          h(
            'button',
            {
              type: 'button',
              className: 'dr-iconBtn',
              title: '文件夹设置',
              onClick: event => { event.stopPropagation(); setMenuOpen(value => !value); },
            },
            '⋯',
          ),
          menuOpen
            ? h(
              'div',
              { className: 'dr-menu', onClick: event => event.stopPropagation() },
              h('button', { type: 'button', className: 'dr-menuItem', onClick: () => { setMenuOpen(false); props.onRename(folder); } }, '改名'),
              h('button', { type: 'button', className: 'dr-menuItem', onClick: () => { setMenuOpen(false); props.onColor(folder); } }, '改颜色'),
              h('button', { type: 'button', className: 'dr-menuItem', onClick: () => { setMenuOpen(false); props.onTemplate(folder); } }, '编辑模板'),
              h('button', { type: 'button', className: 'dr-menuItem', onClick: () => { setMenuOpen(false); props.onExport(folder); } }, '导出全部'),
              h('button', { type: 'button', className: 'dr-menuItem dr-menuItemDanger', onClick: () => { setMenuOpen(false); props.onDelete(folder); } }, '删除'),
            )
            : null,
        ),
      );
    }

    /** The folder's own settings menu, available from inside the folder too. */
    function FolderMenuButton(props) {
      const [open, setOpen] = useState(false);
      const ref = useRef(null);
      useEffect(() => {
        if (!open) return undefined;
        function onDown(event) {
          if (ref.current !== null && ref.current.contains(event.target)) return;
          setOpen(false);
        }
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [open]);
      const items = [
        ['rename', '改名'],
        ['color', '改颜色'],
        ['template', '编辑模板'],
        ['export', '导出全部'],
        ['delete', '删除'],
      ];
      return h(
        'div',
        {
          ref,
          className: 'dr-cardMenu' + (open ? ' dr-cardMenuOpen' : ''),
          style: { position: 'relative', top: 'auto', right: 'auto', opacity: 1 },
        },
        h('button', {
          type: 'button',
          className: 'dr-iconBtn',
          title: '文件夹设置：改名 / 改颜色 / 编辑模板 / 导出全部 / 删除',
          onClick: () => setOpen(value => !value),
        }, '⋯'),
        open
          ? h('div', { className: 'dr-menu', style: { right: 0, top: '34px' } }, items.map(([kind, label]) =>
            h('button', {
              key: kind,
              type: 'button',
              className: 'dr-menuItem' + (kind === 'delete' ? ' dr-menuItemDanger' : ''),
              onClick: () => {
                setOpen(false);
                props.onAction(kind);
              },
            }, label)))
          : null,
      );
    }

    function Overview(props) {
      const data = props.data;
      return h(
        'div',
        { className: 'dr-scroll' },
        h(
          'div',
          { className: 'dr-page' },
          h(
            'div',
            { className: 'dr-hstack', style: { justifyContent: 'space-between', marginBottom: '24px' } },
            h(
              'div',
              null,
              h('h1', { className: 'dr-title', style: { fontSize: '20px' } }, '日精进'),
              h('div', { className: 'dr-sub', style: { marginTop: '4px' } },
                data === null
                  ? '正在读取存档…'
                  : '共 ' + data.stats.total + ' 篇 · 本月 ' + data.stats.monthEntries + ' 篇 / ' + data.stats.monthDays + ' 天' +
                    (typeof data.stats.streak === 'number' && data.stats.streak > 0 ? ' · 连续 ' + data.stats.streak + ' 天' : '')),
            ),
            h('button', { type: 'button', className: 'dr-btn dr-btnPrimary', onClick: props.onCreate }, '+ 新建文件夹'),
          ),
          props.error === '' ? null : h('div', { className: 'dr-error' }, props.error),
          props.loading && data === null
            ? h('div', { className: 'dr-loading' }, '正在读取…')
            : data === null
              ? null
              : data.folders.length === 0
                ? h(EmptyState, { text: '还没有文件夹，先建一个？', action: h('button', { type: 'button', className: 'dr-btn dr-btnPrimary', onClick: props.onCreate }, '+ 新建文件夹') })
                : h(
                  'div',
                  { className: 'dr-grid' },
                  data.folders.map(folder =>
                    h(FolderCard, {
                      key: folder.id,
                      folder,
                      dragging: props.dragId === folder.id,
                      onOpen: props.onOpen,
                      onDragStart: props.onDragStart,
                      onDrop: props.onDrop,
                      onDragEnd: props.onDragEnd,
                      onRename: props.onRename,
                      onColor: props.onColor,
                      onTemplate: props.onTemplate,
                      onExport: props.onExport,
                      onDelete: props.onDelete,
                    })),
                ),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* calendar                                                         */
    /* ---------------------------------------------------------------- */

    function monthGrid(monthKey) {
      const parts = String(monthKey || '').split('-').map(Number);
      const year = parts[0];
      const month = parts[1];
      if (!Number.isFinite(year) || !Number.isFinite(month)) return [];
      const first = new Date(year, month - 1, 1);
      const startDow = first.getDay();
      const daysInMonth = new Date(year, month, 0).getDate();
      const cells = [];
      for (let index = 0; index < startDow; index += 1) cells.push(null);
      for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
      while (cells.length % 7 !== 0) cells.push(null);
      return cells;
    }

    function shiftMonth(monthKey, delta) {
      const parts = String(monthKey || '').split('-').map(Number);
      const date = new Date(parts[0], parts[1] - 1 + delta, 1);
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1);
    }

    function CalendarPopover(props) {
      const ref = useRef(null);
      useEffect(() => {
        function onDown(event) {
          if (ref.current !== null && ref.current.contains(event.target)) return;
          const anchor = ref.current !== null ? ref.current.parentElement : null;
          if (anchor !== null && anchor.contains(event.target)) return;
          props.onClose();
        }
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [props.onClose]);

      const cells = monthGrid(props.month);
      const parts = props.month.split('-').map(Number);
      const today = todayKey();

      return h(
        'div',
        { className: 'dr-calPopover', ref },
        h(
          'div',
          { className: 'dr-calHead' },
          h('button', { type: 'button', className: 'dr-iconBtn', onClick: () => props.onMonthChange(shiftMonth(props.month, -1)) }, '‹'),
          h('span', { className: 'dr-calTitle' }, parts[0] + ' 年 ' + (MONTH_LABEL[parts[1]] || parts[1] + '月')),
          h('button', { type: 'button', className: 'dr-iconBtn', onClick: () => props.onMonthChange(shiftMonth(props.month, 1)) }, '›'),
        ),
        h('div', { className: 'dr-calDow' }, ['日', '一', '二', '三', '四', '五', '六'].map(label => h('div', { key: label, className: 'dr-calDowCell' }, label))),
        h(
          'div',
          { className: 'dr-calGrid' },
          cells.map((day, index) => {
            if (day === null) return h('div', { key: 'blank-' + index });
            const key = parts[0] + '-' + pad2(parts[1]) + '-' + pad2(day);
            const count = props.days[key] || 0;
            return h(
              'button',
              {
                key: key,
                type: 'button',
                className: 'dr-calCell' + (key === today ? ' dr-calToday' : ''),
                title: count > 0 ? key + ' · ' + count + ' 篇' : key,
                onClick: () => props.onPick(key, count),
              },
              String(day),
              count > 0 ? h('span', { className: 'dr-calDot' }) : null,
            );
          }),
        ),
        h('div', { className: 'dr-sub', style: { marginTop: '10px' } }, '有记录的日期带小圆点'),
      );
    }

    /* ---------------------------------------------------------------- */
    /* folder view: grouped list, search, calendar                      */
    /* ---------------------------------------------------------------- */

    function groupEntries(entries) {
      const groups = [];
      const index = new Map();
      for (const entry of entries) {
        if (!index.has(entry.date)) {
          index.set(entry.date, groups.length);
          groups.push({ date: entry.date, entries: [] });
        }
        groups[index.get(entry.date)].entries.push(entry);
      }
      return groups;
    }

    function EntryCard(props) {
      const entry = props.entry;
      const label = relativeLabel(entry.date);
      return h(
        'button',
        { type: 'button', className: 'dr-entry', onClick: () => props.onOpen(entry) },
        h(
          'div',
          { className: 'dr-entryTop' },
          entry.title !== '' ? h('span', { className: 'dr-entryTitle' }, entry.title) : h('span', { className: 'dr-entryTitle', style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 } }, entry.firstLine || '（无标题）'),
          label !== '' ? h('span', { className: 'dr-badge' }, label) : null,
          entry.broken ? h('span', { className: 'dr-badge dr-badgeWarn' }, '格式异常') : null,
          h('span', { className: 'dr-spacer' }),
          h('span', { className: 'dr-entryTime' }, timeOf(entry.created) || timeOf(entry.updated)),
        ),
        h('div', { className: 'dr-entryBody' }, entry.excerpt || '（空）'),
        h('div', { className: 'dr-entryTime' }, entry.words + ' 字 · ' + entry.sections.length + ' 个板块'),
      );
    }

    function FolderView(props) {
      const folder = props.folder;
      const [entries, setEntries] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [query, setQuery] = useState('');
      const [scope, setScope] = useState('folder');
      const [hits, setHits] = useState(null);
      const [searching, setSearching] = useState(false);
      const [calendarOpen, setCalendarOpen] = useState(false);
      const [calendarMonth, setCalendarMonth] = useState(() => todayKey().slice(0, 7));
      const [calendarDays, setCalendarDays] = useState({});
      const [flashDate, setFlashDate] = useState(null);
      const [noticeVisible, setNoticeVisible] = useState(() => {
        try {
          return window.localStorage.getItem('dsh-daily-review:template-notice') !== '1';
        } catch {
          return true;
        }
      });
      const groupRefs = useRef({});

      function dismissNotice() {
        setNoticeVisible(false);
        try {
          window.localStorage.setItem('dsh-daily-review:template-notice', '1');
        } catch {
          /* private mode: the notice simply shows again next time */
        }
      }

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          const payload = await get('entries', { folder: folder.name });
          setEntries(payload.entries);
        } catch (failure) {
          setError(failure.message);
        } finally {
          setLoading(false);
        }
      }, [folder.name]);

      useEffect(() => { void load(); }, [load]);

      useEffect(() => {
        const needle = query.trim();
        if (needle === '') {
          setHits(null);
          setSearching(false);
          return undefined;
        }
        setSearching(true);
        const timer = setTimeout(async () => {
          try {
            const payload = await get('search', {
              q: needle,
              folder: folder.name,
              scope: scope === 'all' ? 'all' : 'folder',
            });
            setHits(payload.hits);
          } catch (failure) {
            setError(failure.message);
            setHits([]);
          } finally {
            setSearching(false);
          }
        }, 250);
        return () => clearTimeout(timer);
      }, [query, scope, folder.name]);

      useEffect(() => {
        if (!calendarOpen) return;
        let live = true;
        get('calendar', { folder: folder.name, month: calendarMonth })
          .then(payload => { if (live) setCalendarDays(payload.days || {}); })
          .catch(() => { if (live) setCalendarDays({}); });
        return () => { live = false; };
      }, [calendarOpen, calendarMonth, folder.name]);

      useEffect(() => {
        if (flashDate === null) return undefined;
        const target = groupRefs.current[flashDate];
        if (target !== undefined && target !== null && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        const timer = setTimeout(() => setFlashDate(null), 1600);
        return () => clearTimeout(timer);
      }, [flashDate, entries]);

      const groups = entries === null ? [] : groupEntries(entries);
      const todayHasEntry = entries !== null && entries.some(entry => entry.date === todayKey());

      function jumpToToday() {
        if (todayHasEntry) {
          setFlashDate(todayKey());
          return;
        }
        props.onNew(todayKey());
      }

      function pickDay(day, count) {
        setCalendarOpen(false);
        if (count > 0) setFlashDate(day);
        else props.onNew(day);
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dr-topbar' },
          h('button', { type: 'button', className: 'dr-iconBtn', title: '返回文件夹总览', onClick: props.onBack }, '←'),
          h('div', { className: 'dr-topbarMain' },
            colorDot(folder.color),
            h('h1', { className: 'dr-title' }, folder.name),
            h('span', { className: 'dr-sub' }, (entries === null ? '' : entries.length + ' 篇')),
          ),
          h('span', { className: 'dr-spacer' }),
          h(
            'div',
            { className: 'dr-searchWrap' },
            h('input', {
              className: 'dr-searchInput',
              value: query,
              placeholder: '搜索这篇文件夹的正文…',
              onChange: event => setQuery(event.target.value),
            }),
          ),
          query.trim() === ''
            ? null
            : h(
              'div',
              { className: 'dr-searchScope' },
              h('button', { type: 'button', className: 'dr-scopeBtn' + (scope === 'folder' ? ' dr-scopeBtnActive' : ''), onClick: () => setScope('folder') }, '当前'),
              h('button', { type: 'button', className: 'dr-scopeBtn' + (scope === 'all' ? ' dr-scopeBtnActive' : ''), onClick: () => setScope('all') }, '全部'),
            ),
          h('button', { type: 'button', className: 'dr-btn', onClick: jumpToToday }, '今天'),
          h(
            'div',
            { className: 'dr-calendar' },
            h('button', { type: 'button', className: 'dr-iconBtn', title: '按日期跳转', onClick: () => setCalendarOpen(value => !value) }, '🗓'),
            calendarOpen
              ? h(CalendarPopover, {
                month: calendarMonth,
                days: calendarDays,
                onMonthChange: setCalendarMonth,
                onPick: pickDay,
                onClose: () => setCalendarOpen(false),
              })
              : null,
          ),
          h(FolderMenuButton, {
            onAction: kind => {
              if (kind === 'export') {
                props.onExport(folder);
                return;
              }
              props.onFolderAction(kind);
            },
          }),
          h('button', { type: 'button', className: 'dr-btn dr-btnPrimary', onClick: () => props.onNew(todayKey()) }, '+ 新建'),
        ),
        h(
          'div',
          { className: 'dr-scroll' },
          h(
            'div',
            { className: 'dr-page' },
            error === '' ? null : h('div', { className: 'dr-error' }, error),
            noticeVisible
              ? h(
                'div',
                { className: 'dr-notice' },
                h('span', { className: 'dr-noticeText' }, '这个文件夹的模板可以在右上角的「⋯ → 编辑模板」里改；只影响之后新建的条目。'),
                h('button', { type: 'button', className: 'dr-iconBtn', title: '知道了', onClick: dismissNotice }, '×'),
              )
              : null,
            hits !== null
              ? h(
                'div',
                null,
                h('div', { className: 'dr-label', style: { marginBottom: '12px' } },
                  searching ? '搜索中…' : hits.length + ' 条命中' + (scope === 'all' ? '（全部文件夹）' : '')),
                hits.length === 0
                  ? h(EmptyState, { text: '没有搜到匹配的内容。' })
                  : hits.map(hit =>
                    h(
                      'button',
                      {
                        key: hit.id,
                        type: 'button',
                        className: 'dr-hit',
                        onClick: async () => {
                          setQuery('');
                          try {
                            await props.onOpenById(hit.id);
                          } catch (failure) {
                            setError(failure.message);
                          }
                        },
                      },
                      h('div', { className: 'dr-hitHead' },
                        h('span', null, hit.date),
                        h('span', null, hit.folder),
                        hit.title !== '' ? h('span', null, hit.title) : null,
                        h('span', null, hit.field === 'title' ? '标题命中' : '正文命中'),
                      ),
                      h('div', { className: 'dr-hitSnippet' }, highlightSnippet(hit.snippet, query)),
                    )),
              )
              : loading && entries === null
                ? h('div', { className: 'dr-loading' }, '正在读取…')
                : entries !== null && entries.length === 0
                  ? h(EmptyState, {
                    text: '这里还没有记录，写第一条？',
                    action: h('button', { type: 'button', className: 'dr-btn dr-btnPrimary', onClick: () => props.onNew(todayKey()) }, '+ 新建'),
                  })
                  : groups.map(group =>
                    h(
                      'div',
                      {
                        key: group.date,
                        className: 'dr-group' + (flashDate === group.date ? ' dr-groupFlash' : ''),
                        ref: node => { groupRefs.current[group.date] = node; },
                      },
                      h('div', { className: 'dr-groupHead' },
                        h('span', { className: 'dr-groupTitle' }, groupTitle(group.date)),
                        h('span', { className: 'dr-groupHint' }, group.entries.length + ' 篇'),
                        h('span', { className: 'dr-spacer' }),
                        h('span', { className: 'dr-groupHint' }, group.date),
                      ),
                      group.entries.map(entry =>
                        h(EntryCard, { key: entry.id, entry, onOpen: props.onOpen })),
                    )),
          ),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* reading                                                          */
    /* ---------------------------------------------------------------- */

    function Reader(props) {
      const entry = props.entry;
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dr-topbar' },
          h('button', { type: 'button', className: 'dr-iconBtn', title: '返回列表', onClick: props.onBack }, '←'),
          h('div', { className: 'dr-topbarMain' },
            h('h1', { className: 'dr-title' }, entry.title === '' ? entry.date : entry.title),
            h('span', { className: 'dr-sub' }, entry.folder + ' · ' + entry.date),
          ),
          h('span', { className: 'dr-spacer' }),
          h('button', {
            type: 'button',
            className: 'dr-btn',
            onClick: () => {
              const ok = downloadText(entry.file, buildEntryMarkdown(entry));
              if (!ok && typeof window.alert === 'function') window.alert('导出失败：当前环境不支持下载。');
            },
          }, '导出'),
          h('button', { type: 'button', className: 'dr-btn', onClick: props.onCopy }, props.copied ? '已复制' : '复制全文'),
          h('button', { type: 'button', className: 'dr-btn', onClick: props.onDelete }, '删除'),
          h('button', { type: 'button', className: 'dr-btn dr-btnPrimary', onClick: props.onEdit }, '编辑'),
        ),
        h(
          'div',
          { className: 'dr-scroll' },
          h(
            'div',
            { className: 'dr-page' },
            h(
              'div',
              { className: 'dr-reader' },
              h('div', { className: 'dr-readerHead' },
                h('h2', { className: 'dr-readerTitle' }, entry.title === '' ? groupTitle(entry.date) : entry.title),
                entry.broken ? h('span', { className: 'dr-badge dr-badgeWarn' }, '格式异常：frontmatter 可能被手改坏了，内容按文件名日期读出') : null,
              ),
              h('div', { className: 'dr-readerMeta' },
                h('span', null, entry.date + ' ' + weekdayOf(entry.date)),
                h('span', null, entry.words + ' 字'),
                h('span', null, '更新于 ' + (timeOf(entry.updated) || '—')),
              ),
              h('div', { className: 'dr-readerBody' }, renderMarkdown(entry.body)),
            ),
          ),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* editing                                                          */
    /* ---------------------------------------------------------------- */

    function ConfirmDialog(props) {
      return h(
        Modal,
        { onClose: props.onClose },
        h('h2', { className: 'dr-modalTitle' }, props.title),
        h('div', { className: 'dr-modalHint' }, props.message),
        h(
          'div',
          { className: 'dr-modalActions' },
          (props.actions || []).map((action, index) =>
            h('button', {
              key: 'action-' + index,
              type: 'button',
              className: 'dr-btn' + (action.primary ? ' dr-btnPrimary' : '') + (action.danger ? ' dr-btnDanger' : ''),
              onClick: action.onClick,
            }, action.label)),
          h('button', { type: 'button', className: 'dr-btn', onClick: props.onClose }, '取消'),
        ),
      );
    }

    function Editor(props) {
      const folder = props.folder;
      const draft = props.draft;
      const [date, setDate] = useState(draft.date);
      const [title, setTitle] = useState(draft.title);
      const [text, setText] = useState(draft.text);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [openConfirm, setOpenConfirm] = useState(null);
      const [renaming, setRenaming] = useState(-1);
      const [renameValue, setRenameValue] = useState('');
      const [adding, setAdding] = useState(false);
      const [addValue, setAddValue] = useState('');
      const [dragIndex, setDragIndex] = useState(null);
      const [dropIndex, setDropIndex] = useState(null);
      const [hint, setHint] = useState('');
      const [loadSource, setLoadSource] = useState('');
      const textareaRef = useRef(null);

      const parts = splitBody(text);
      const blocks = parts.blocks;

      useEffect(() => {
        const node = textareaRef.current;
        if (node === null) return;
        if (draft.caret !== null && draft.caret !== undefined) {
          node.focus();
          try {
            node.setSelectionRange(draft.caret, draft.caret);
          } catch {
            /* older engines */
          }
        }
      }, [draft.caret]);

      useEffect(() => {
        if (hint === '') return undefined;
        const timer = setTimeout(() => setHint(''), 3200);
        return () => clearTimeout(timer);
      }, [hint]);

      function commit(nextParts) {
        setText(joinBody(nextParts));
      }

      function renameSection(index, name) {
        const clean = name.trim();
        if (clean === '') return;
        const next = blocks.map((block, position) => position === index ? { name: clean, content: block.content } : block);
        commit({ preface: parts.preface, blocks: next });
      }

      function removeSection(index, keepBody) {
        const next = blocks.slice();
        const removed = next.splice(index, 1)[0];
        let preface = parts.preface;
        if (keepBody !== false) {
          const body = String(removed.content || '').trim();
          if (body !== '') {
            if (index > 0) {
              const previous = next[index - 1];
              previous.content = previous.content.trim() === '' ? body : previous.content.replace(/\s+$/, '') + '\n\n' + body;
            } else {
              preface = (preface.trim() === '' ? '' : preface.replace(/\s+$/, '') + '\n\n') + body;
            }
          }
        }
        commit({ preface, blocks: next });
      }

      function requestRemove(index) {
        const block = blocks[index];
        const hasContent = String(block.content || '').replace(/\s+/g, '') !== '';
        if (!hasContent) {
          removeSection(index, false);
          return;
        }
        setOpenConfirm({
          title: '删除板块「' + block.name + '」',
          message: '这个板块下面还有正文。默认只删标题、正文并入上一段；取消则什么都不改。',
          actions: [
            { label: '只删标题，保留正文', onClick: () => { setOpenConfirm(null); removeSection(index, true); } },
            { label: '连正文一起删', danger: true, onClick: () => { setOpenConfirm(null); removeSection(index, false); } },
          ],
        });
      }

      function moveSection(from, to) {
        if (from === null || to === null || from === to) return;
        const next = blocks.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        if (String(moved.content || '').replace(/\s+/g, '') !== '') {
          setHint('已按新顺序移动板块，它下面的正文跟着一起走了');
        }
        commit({ preface: parts.preface, blocks: next });
      }

      function addSection(name) {
        const clean = name.trim();
        if (clean === '') return;
        const next = blocks.concat([{ name: clean, content: '' }]);
        commit({ preface: parts.preface, blocks: next });
        setAdding(false);
        setAddValue('');
      }

      async function save() {
        if (!hasRealContent(text)) {
          setError('正文是空的，先写点内容再保存。');
          return;
        }
        setBusy(true);
        setError('');
        try {
          const sections = blocks.map(block => block.name);
          const payload = await post('entry/save', {
            id: draft.entryId === null || draft.entryId === undefined ? undefined : draft.entryId,
            folder: folder.name,
            date,
            title,
            body: text,
            sections,
          });
          props.onSaved(payload.entry);
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy(false);
        }
      }

      const length = text.length;
      const long = length > MAX_BODY_BYTES_HINT;

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dr-topbar' },
          h('button', { type: 'button', className: 'dr-iconBtn', title: '取消并返回', onClick: props.onCancel }, '←'),
          h('div', { className: 'dr-topbarMain' },
            h('h1', { className: 'dr-title' }, draft.entryId === null || draft.entryId === undefined ? '新建日精进' : '编辑日精进'),
            h('span', { className: 'dr-sub' }, folder.name),
          ),
          h('span', { className: 'dr-spacer' }),
          h('button', { type: 'button', className: 'dr-btn', onClick: props.onCancel }, '取消'),
          h('button', { type: 'button', className: 'dr-btn dr-btnPrimary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
        ),
        h(
          'div',
          { className: 'dr-scroll' },
          h(
            'div',
            { className: 'dr-page' },
            h(
              'div',
              { className: 'dr-editor' },
              error === '' ? null : h('div', { className: 'dr-error' }, error),
              hint === '' ? null : h('div', { className: 'dr-notice' }, h('span', { className: 'dr-noticeText' }, hint)),
              h(
                'div',
                { className: 'dr-row' },
                h('div', { className: 'dr-field' },
                  h('label', { className: 'dr-label' }, '日期'),
                  h('input', { className: 'dr-input', type: 'date', value: date, onChange: event => setDate(event.target.value) }),
                ),
                h('div', { className: 'dr-field', style: { flex: '2 1 260px' } },
                  h('label', { className: 'dr-label' }, '标题（可空）'),
                  h('input', { className: 'dr-input', value: title, placeholder: '例如「阶段汇报」', onChange: event => setTitle(event.target.value) }),
                ),
              ),
              h(
                'div',
                { className: 'dr-field' },
                h('div', { className: 'dr-hstack' },
                  h('span', { className: 'dr-label' }, '本篇板块'),
                  h('span', { className: 'dr-sub' }, '双击改名 · 拖动排序 · 只影响这一篇'),
                ),
                h(
                  'div',
                  { className: 'dr-chips' },
                  blocks.map((block, index) =>
                    h(
                      'div',
                      {
                        key: block.name + '-' + index,
                        className: 'dr-chip' + (dragIndex === index ? ' dr-chipDragging' : '') + (dropIndex === index && dragIndex !== index ? ' dr-chipDrop' : ''),
                        draggable: renaming !== index,
                        onDragStart: event => { event.dataTransfer.effectAllowed = 'move'; setDragIndex(index); },
                        onDragOver: event => { event.preventDefault(); setDropIndex(index); },
                        onDrop: event => { event.preventDefault(); moveSection(dragIndex, index); setDragIndex(null); setDropIndex(null); },
                        onDragEnd: () => { setDragIndex(null); setDropIndex(null); },
                        onDoubleClick: () => { setRenaming(index); setRenameValue(block.name); },
                        title: block.name,
                      },
                      renaming === index
                        ? h('input', {
                          className: 'dr-chipInput',
                          value: renameValue,
                          autoFocus: true,
                          onChange: event => setRenameValue(event.target.value),
                          onBlur: () => { renameSection(index, renameValue); setRenaming(-1); },
                          onKeyDown: event => {
                            if (event.key === 'Enter') { renameSection(index, renameValue); setRenaming(-1); }
                            if (event.key === 'Escape') setRenaming(-1);
                          },
                        })
                        : h('span', { className: 'dr-chipName' }, block.name),
                      h('button', {
                        type: 'button',
                        className: 'dr-chipX',
                        title: '删除这个板块',
                        onClick: event => { event.stopPropagation(); requestRemove(index); },
                      }, '×'),
                    )),
                  adding
                    ? h('input', {
                      className: 'dr-chipInput',
                      value: addValue,
                      autoFocus: true,
                      placeholder: '板块名',
                      onChange: event => setAddValue(event.target.value),
                      onBlur: () => { if (addValue.trim() !== '') addSection(addValue); else setAdding(false); },
                      onKeyDown: event => {
                        if (event.key === 'Enter') addSection(addValue);
                        if (event.key === 'Escape') { setAdding(false); setAddValue(''); }
                      },
                    })
                    : h('button', { type: 'button', className: 'dr-btn dr-btnQuiet', onClick: () => setAdding(true) }, '+ 添加板块'),
                ),
                h(
                  'div',
                  { className: 'dr-toolsRow' },
                  h('select', {
                    className: 'dr-select',
                    style: { width: 'auto', minWidth: '190px' },
                    value: loadSource,
                    onChange: event => {
                      const value = event.target.value;
                      setLoadSource(value);
                      if (value !== '') applyTemplateWithConfirm(value);
                    },
                  },
                    h('option', { value: '' }, '从其他文件夹模板载入…'),
                    props.folders.filter(candidate => candidate.name !== folder.name).map(candidate =>
                      h('option', { key: candidate.id, value: candidate.name }, candidate.name)),
                  ),
                  h('span', { className: 'dr-sub' }, '只改这一篇，不会写回文件夹模板，也不影响其他条目'),
                  h('span', { className: 'dr-spacer' }),
                  h('button', {
                    type: 'button',
                    className: 'dr-btn dr-btnQuiet',
                    title: '把本篇的板块结构存成这个文件夹的默认模板',
                    onClick: async () => {
                      setError('');
                      try {
                        await post('folders/update', {
                          id: folder.id,
                          sections: blocks.map((block, index) => ({ id: 's' + (index + 1), name: block.name })),
                        });
                        setHint('已存为该文件夹的默认模板：只影响之后新建的条目，已有条目一个都不改');
                      } catch (failure) {
                        setError(failure.message);
                      }
                    },
                  }, '存为该文件夹模板'),
                ),
              ),
              h(
                'div',
                { className: 'dr-field' },
                h('label', { className: 'dr-label' }, '正文（Markdown，等宽字体）'),
                h('textarea', {
                  ref: textareaRef,
                  className: 'dr-textarea',
                  value: text,
                  spellCheck: false,
                  onChange: event => setText(event.target.value),
                }),
                h('div', { className: 'dr-sub' },
                  length + ' 字符' + (long ? ' · 超过 200KB，列表摘要只会取前 200 字' : '') + ' · 每个板块用「## 板块名」开头'),
              ),
            ),
          ),
        ),
        openConfirm === null ? null : h(ConfirmDialog, {
          title: openConfirm.title,
          message: openConfirm.message,
          actions: openConfirm.actions,
          onClose: () => setOpenConfirm(null),
        }),
      );

      /* `loadSource` needs the (possibly confirming) template apply body with
         the selected name; declared below to keep the JSX-equivalent compact. */
      function applyTemplateWithConfirm(folderName) {
        const source = props.folders.find(candidate => candidate.name === folderName);
        if (source === undefined) return;
        const names = source.template.sections.map(section => section.name);
        if (names.length === 0) {
          setHint('这个文件夹的模板没有板块，载入后不会改变本篇');
          setLoadSource('');
          return;
        }
        const run = () => {
          const byName = new Map(blocks.map(block => [block.name, block.content]));
          const next = names.map(name => ({ name, content: byName.get(name) || '' }));
          for (const block of blocks) {
            if (!names.includes(block.name)) next.push({ name: block.name, content: block.content });
          }
          commit({ preface: parts.preface, blocks: next });
          setLoadSource('');
        };
        if (hasRealContent(text)) {
          setOpenConfirm({
            title: '从「' + source.name + '」载入板块',
            message: '会按这个模板重排本篇的板块（同名板块的正文保留，模板里没有的板块留在末尾）。确定载入？',
            actions: [{ label: '确定载入', primary: true, onClick: () => { setOpenConfirm(null); run(); } }],
          });
          return;
        }
        run();
      }
    }

    /* ---------------------------------------------------------------- */
    /* folder dialogs                                                   */
    /* ---------------------------------------------------------------- */

    function FolderDialog(props) {
      const folder = props.folder;
      const [name, setName] = useState(folder.name);
      const [color, setColor] = useState(folder.color);
      const [names, setNames] = useState(folder.template.sections.map(section => section.name));
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');

      const duplicate = props.folders.some(candidate => candidate.id !== folder.id && candidate.name === name.trim());
      const canSave = name.trim() !== '' && !duplicate && !busy;
      const templateEmpty = names.length < 1;

      async function submit(patch) {
        setBusy(true);
        setError('');
        try {
          await post('folders/update', Object.assign({ id: folder.id }, patch));
          props.onDone();
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy(false);
        }
      }

      if (props.kind === 'delete') {
        return h(
          Modal,
          { onClose: props.onClose },
          h('h2', { className: 'dr-modalTitle' }, '删除文件夹「' + folder.name + '」'),
          h('div', { className: 'dr-modalHint' },
            '只删除记录和索引，你的 .md 文件会进回收站（.daily-review/trash），不会消失。',
            h('br'),
            '这个文件夹下共有 ' + folder.count + ' 篇记录，会一起移入回收站，保留 7 天。'),
          error === '' ? null : h('div', { className: 'dr-error' }, error),
          h('div', { className: 'dr-modalActions' },
            h('button', { type: 'button', className: 'dr-btn', onClick: props.onClose }, '取消'),
            h('button', {
              type: 'button',
              className: 'dr-btn dr-btnDanger',
              disabled: busy,
              onClick: async () => {
                setBusy(true);
                setError('');
                try {
                  await post('folders/delete', { id: folder.id });
                  props.onDone();
                } catch (failure) {
                  setError(failure.message);
                } finally {
                  setBusy(false);
                }
              },
            }, busy ? '处理中…' : '删除'),
          ),
        );
      }

      if (props.kind === 'template') {
        return h(
          Modal,
          { onClose: props.onClose, wide: true },
          h('h2', { className: 'dr-modalTitle' }, '编辑「' + folder.name + '」的模板'),
          h('div', { className: 'dr-modalHint' }, '模板只决定新建时的初始骨架，不会改你已经写好的内容。'),
          h(TemplateEditor, { sections: folder.template.sections, onChange: setNames }),
          error === '' ? null : h('div', { className: 'dr-error' }, error),
          h('div', { className: 'dr-modalActions' },
            h('button', { type: 'button', className: 'dr-btn', onClick: props.onClose }, '取消'),
            h('button', {
              type: 'button',
              className: 'dr-btn dr-btnPrimary',
              disabled: templateEmpty || busy,
              onClick: () => submit({ sections: names.map((sectionName, index) => ({ id: 's' + index, name: sectionName })) }),
            }, busy ? '保存中…' : '保存模板'),
          ),
        );
      }

      return h(
        Modal,
        { onClose: props.onClose },
        h('h2', { className: 'dr-modalTitle' }, props.kind === 'color' ? '改颜色' : '改文件名'),
        h('div', { className: 'dr-field' },
          h('label', { className: 'dr-label' }, '名称'),
          h('input', { className: 'dr-input', value: name, autoFocus: true, onChange: event => setName(event.target.value) }),
          duplicate ? h('div', { className: 'dr-sub', style: { color: 'var(--dsw-alias-state-error-primary)' } }, '已经有同名文件夹了') : null,
          h('div', { className: 'dr-sub' }, '改名会移动目录；已有 .md 里的 folder 字段不追改，以目录为准。'),
        ),
        h('div', { className: 'dr-field' },
          h('label', { className: 'dr-label' }, '颜色'),
          h('div', { className: 'dr-palette' }, PALETTE.map(presetColor =>
            h('button', {
              key: presetColor,
              type: 'button',
              className: 'dr-color' + (presetColor === color ? ' dr-colorActive' : ''),
              style: { background: presetColor },
              onClick: () => setColor(presetColor),
            }))),
        ),
        error === '' ? null : h('div', { className: 'dr-error' }, error),
        h('div', { className: 'dr-modalActions' },
          h('button', { type: 'button', className: 'dr-btn', onClick: props.onClose }, '取消'),
          h('button', { type: 'button', className: 'dr-btn dr-btnPrimary', disabled: !canSave, onClick: () => submit({ name: name.trim(), color }) }, busy ? '保存中…' : '保存'),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* root                                                             */
    /* ---------------------------------------------------------------- */

    function Root() {
      const [view, setView] = useState(nav.view);
      const [overview, setOverview] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [dragId, setDragId] = useState(null);
      const [createOpen, setCreateOpen] = useState(false);
      const [dialog, setDialog] = useState(null);
      const [current, setCurrent] = useState(null);
      const [draft, setDraft] = useState(null);
      const [copied, setCopied] = useState(false);

      const goto = useCallback(next => {
        nav.view = next;
        setView(next);
      }, []);

      const loadOverview = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          setOverview(await get('overview'));
        } catch (failure) {
          setError(failure.message);
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => { void loadOverview(); }, [loadOverview]);

      const folders = overview === null ? [] : overview.folders;
      const activeFolder = (view.kind === 'folder' || view.kind === 'read' || view.kind === 'edit')
        ? folders.find(candidate => candidate.name === view.folderName) || null
        : null;

      async function openEntry(entry) {
        setError('');
        try {
          const payload = await get('entry', { id: entry.id });
          setCurrent(payload.entry);
          goto({ kind: 'read', folderName: payload.entry.folder, entryId: payload.entry.id });
        } catch (failure) {
          setError(failure.message);
        }
      }

      async function openById(id) {
        const payload = await get('entry', { id });
        setCurrent(payload.entry);
        goto({ kind: 'read', folderName: payload.entry.folder, entryId: payload.entry.id });
      }

      function newEntry(folderName, date) {
        const target = folders.find(candidate => candidate.name === folderName);
        if (target === undefined) return;
        const text = skeletonOf(target.template.sections);
        setDraft({
          token: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
          entryId: null,
          date,
          title: '',
          text,
          caret: caretAfterFirstSection(text),
        });
        goto({ kind: 'edit', folderName, entryId: null });
      }

      function editCurrent() {
        if (current === null) return;
        setDraft({
          token: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
          entryId: current.id,
          date: current.date,
          title: current.title,
          text: current.body,
          caret: null,
        });
        goto({ kind: 'edit', folderName: current.folder, entryId: current.id });
      }

      async function handleSaved(entry) {
        setCurrent(entry);
        setError('');
        await loadOverview();
        goto({ kind: 'read', folderName: entry.folder, entryId: entry.id });
      }

      async function copyCurrent() {
        if (current === null) return;
        try {
          await navigator.clipboard.writeText(current.body);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setError('复制失败：浏览器拒绝了剪贴板权限。');
        }
      }

      /** Export every entry of one folder into a single Markdown file. */
      async function exportFolder(folder) {
        setError('');
        try {
          const list = await get('entries', { folder: folder.name });
          const full = await Promise.all(list.entries.map(entry => get('entry', { id: entry.id })));
          const markdown = full.map(item => buildEntryMarkdown(item.entry)).join('\n\n---\n\n');
          const name = folder.name + '-日精进-' + todayKey() + '.md';
          const ok = downloadText(name, '# ' + folder.name + ' · 日精进导出\n\n' + markdown);
          if (!ok) setError('导出失败：当前环境不支持下载。');
        } catch (failure) {
          setError(failure.message);
        }
      }

      function handleDrop(targetId) {
        if (dragId === null || overview === null) return;
        const ids = overview.folders.map(folder => folder.id);
        const from = ids.indexOf(dragId);
        const to = ids.indexOf(targetId);
        setDragId(null);
        if (from < 0 || to < 0 || from === to) return;
        const nextIds = ids.slice();
        nextIds.splice(from, 1);
        nextIds.splice(to, 0, dragId);
        const byId = new Map(overview.folders.map(folder => [folder.id, folder]));
        setOverview({
          ...overview,
          folders: nextIds.map((id, index) => ({ ...byId.get(id), order: index })),
        });
        post('folders/reorder', { ids: nextIds })
          .then(() => loadOverview())
          .catch(failure => setError(failure.message));
      }

      let body = null;
      if (view.kind === 'read' && current !== null) {
        body = h(Reader, {
          entry: current,
          copied,
          onBack: () => goto({ kind: 'folder', folderName: current.folder }),
          onEdit: editCurrent,
          onCopy: copyCurrent,
          onDelete: () => setDialog({ kind: 'entry-delete' }),
        });
      } else if (view.kind === 'edit' && draft !== null && activeFolder !== null) {
        body = h(Editor, {
          key: draft.token,
          folder: activeFolder,
          folders,
          draft,
          onCancel: () => {
            if (current !== null && current.id === draft.entryId) goto({ kind: 'read', folderName: current.folder, entryId: current.id });
            else goto({ kind: 'folder', folderName: activeFolder.name });
          },
          onSaved: handleSaved,
        });
      } else if (view.kind === 'folder' && activeFolder !== null) {
        body = h(FolderView, {
          folder: activeFolder,
          onBack: () => { void loadOverview(); goto({ kind: 'overview' }); },
          onOpen: openEntry,
          onOpenById: openById,
          onNew: date => newEntry(activeFolder.name, date),
          onExport: exportFolder,
          onFolderAction: kind => setDialog({ kind, folder: activeFolder }),
        });
      } else {
        body = h(Overview, {
          data: overview,
          loading,
          error,
          dragId,
          onCreate: () => setCreateOpen(true),
          onOpen: folder => goto({ kind: 'folder', folderName: folder.name }),
          onDragStart: setDragId,
          onDrop: handleDrop,
          onDragEnd: () => setDragId(null),
          onRename: folder => setDialog({ kind: 'rename', folder }),
          onColor: folder => setDialog({ kind: 'color', folder }),
          onTemplate: folder => setDialog({ kind: 'template', folder }),
          onExport: exportFolder,
          onDelete: folder => setDialog({ kind: 'delete', folder }),
        });
      }

      return h(
        'div',
        { className: 'dr-panel' },
        body,
        createOpen
          ? h(CreateFolderModal, {
            existing: folders.map(folder => folder.name),
            nextOrder: folders.length,
            onClose: () => setCreateOpen(false),
            onCreated: async () => {
              setCreateOpen(false);
              await loadOverview();
            },
          })
          : null,
        dialog === null
          ? null
          : dialog.kind === 'entry-delete'
            ? h(ConfirmDialog, {
              title: '删除这条记录',
              message: '文件会移入 .daily-review/trash（保留 7 天），不会立刻消失。确定删除？',
              actions: [{
                label: '删除',
                danger: true,
                onClick: async () => {
                  try {
                    await post('entry/delete', { id: current.id });
                    setDialog(null);
                    setCurrent(null);
                    await loadOverview();
                    goto({ kind: 'folder', folderName: current.folder });
                  } catch (failure) {
                    setError(failure.message);
                    setDialog(null);
                  }
                },
              }],
              onClose: () => setDialog(null),
            })
            : h(FolderDialog, {
              kind: dialog.kind,
              folder: dialog.folder,
              folders,
              onClose: () => setDialog(null),
              onDone: async () => {
                const kind = dialog.kind;
                const previousName = dialog.folder.name;
                setDialog(null);
                await loadOverview();
                if ((kind === 'delete' || kind === 'rename') && view.folderName === previousName) {
                  goto({ kind: 'overview' });
                }
              },
            }),
      );
    }

    function Panel() {
      return h('div', { className: 'dr-panel' }, h(Root, null));
    }

    /* ---------------------------------------------------------------- */
    /* plugin                                                           */
    /* ---------------------------------------------------------------- */

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-dsh-daily-review', '1');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => { style.remove(); };
      }, 'daily-review: styles');

      const disposers = [];
      disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        label: () => '日精进',
      }, Icon)));
      disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({}),
      }, Panel)));
      return () => {
        for (const dispose of disposers.splice(0)) dispose();
      };
    }

    return { name: 'daily-review-client', inject: ['slots'], apply };
  },
});
