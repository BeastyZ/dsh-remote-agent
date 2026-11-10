import { React, h, setLocale, setReact, t } from './runtime.js';
import './i18n.js';
import { setReactDOM } from './ui.jsx';
import { ServerIcon } from './icons.jsx';
import { Workbench } from './Workbench.jsx';
import { SessionRenameAction } from './SessionRenameAction.jsx';
import xtermCss from '@xterm/xterm/css/xterm.css';
import baseCss from './style.css';

const CSS = xtermCss + '\n' + baseCss;

export function createPlugin(ReactRuntime, ReactDOMRuntime) {
  setReact(ReactRuntime);
  if (ReactDOMRuntime) setReactDOM(ReactDOMRuntime);

  function PanelIcon({ size = 20, active }) {
    return h('span', {
      className: 'ra-panel-icon' + (active ? ' is-active' : ''),
      style: { width: size, height: size },
    }, h(ServerIcon, { size: Math.max(14, size - 2) }));
  }

  return {
    inject: ['slots', 'locale', 'layout'],
    apply(ctx) {
      function WorkbenchWithCtx() {
        return h(Workbench, { ctx });
      }

      ctx.effect(() => {
        const el = document.createElement('style');
        el.setAttribute('data-plugin', 'dsh-remote-agent');
        el.textContent = CSS;
        document.head.appendChild(el);
        return () => el.remove();
      });

      ctx.effect(() => {
        const onKey = (event) => {
          if ((event.metaKey || event.ctrlKey) && event.altKey && (event.code === 'KeyR' || event.key.toLowerCase() === 'r')) {
            event.preventDefault();
            try { ctx.layout.selectPanel('remote-agent'); } catch { /* older shell */ }
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      });

      ctx.effect(() => {
        const applyLocale = () => {
          try { setLocale(ctx.locale.getSnapshot().active); } catch { /* keep English */ }
        };
        applyLocale();
        return ctx.locale.subscribe(applyLocale);
      });

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'remote-agent',
        order: 20,
        label: () => t('panel.title'),
      }, PanelIcon));

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'remote-agent',
      }, WorkbenchWithCtx));

      ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.row.action',
        id: 'remote-agent-session-rename',
        order: 150,
        label: () => t('chatRename.action'),
      }, SessionRenameAction));

      // DEBUG verification hook: open the workbench once after boot.

    },
  };
}
