import { Hono } from 'hono';
import { html } from 'hono/html';

export function registerUi(app: Hono) {
  app.get('/', async (c) => {
    return c.html(html`<!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Codex Equilibrium</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto,
                Oxygen, Ubuntu, Cantarell, sans-serif;
              margin: 2rem;
            }
            a.button {
              display: inline-block;
              margin: 0.5rem 0.5rem 1rem 0;
              padding: 0.5rem 1rem;
              background: #4f46e5;
              color: white;
              border-radius: 4px;
              text-decoration: none;
            }
            button {
              cursor: pointer;
            }
            table {
              border-collapse: collapse;
              width: 100%;
              margin-top: 1rem;
            }
            th,
            td {
              border: 1px solid #e5e7eb;
              padding: 8px 10px;
              text-align: left;
            }
            th {
              background: #f9fafb;
            }
            .muted {
              color: #6b7280;
            }
            .status.active {
              color: #10b981;
            }
            .status.waiting {
              color: #6b7280;
            }
            .status.frozen,
            .status.expired {
              color: #ef4444;
            }
            .status.expiring-soon {
              color: #f59e0b;
            }
            .actions button {
              margin-right: 8px;
              padding: 4px 10px;
              border-radius: 4px;
              border: 1px solid #d1d5db;
              background: #f3f4f6;
            }
            .actions button:hover {
              background: #e5e7eb;
            }
          </style>
        </head>
        <body>
          <h1>Codex Equilibrium</h1>
          <div>
            <a class="button" href="/oauth/start">Add OpenAI Account</a>
            <button id="toggle-relay" class="button" style="background:#0ea5e9">
              Add Relay
            </button>
            <button id="refresh-all" class="button" style="background:#059669">
              Refresh All
            </button>
          </div>
          <div
            id="relay-form"
            style="display:none; margin: 1rem 0; padding: 1rem; border:1px solid #e5e7eb; border-radius:8px;"
          >
            <h3 style="margin-top:0">Add Relay Proxy</h3>
            <div
              style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;"
            >
              <label
                >Name
                <input
                  id="relay-name"
                  type="text"
                  placeholder="My Relay"
                  style="margin-left:4px"
              /></label>
              <label
                >Base URL
                <input
                  id="relay-base"
                  type="text"
                  style="margin-left:4px; min-width:380px"
                  value="https://xxxx.com/v1"
              /></label>
              <label
                >API Key
                <input
                  id="relay-key"
                  type="password"
                  placeholder="sk-..."
                  style="margin-left:4px; min-width:300px"
              /></label>
              <button id="relay-save" class="button" style="background:#10b981">
                Save Relay
              </button>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Account ID</th>
                <th>Token</th>
                <th>Created</th>
                <th>Last Refresh</th>
                <th>Last Used</th>
                <th>Expire</th>
                <th>Status</th>
                <th>Cooldown Remaining</th>
                <th>Fails</th>
                <th>Last Error</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="acct-body">
              <tr>
                <td colspan="12" class="muted">Loading...</td>
              </tr>
            </tbody>
          </table>
          <script>
            async function fetchAccounts() {
              var res = await fetch('/accounts');
              if (!res.ok) return [];
              var data = await res.json();
              return data.accounts || [];
            }
            function fmt(s) {
              if (!s) return '';
              return new Date(s).toLocaleString();
            }
            function fmtCD(s) {
              if (!s) return '';
              var t = Date.parse(s) - Date.now();
              if (isNaN(t) || t <= 0) return '';
              var sec = Math.floor(t / 1000);
              var m = Math.floor(sec / 60);
              var s2 = sec % 60;
              return m + 'm ' + s2 + 's';
            }
            async function render() {
              var tbody = document.getElementById('acct-body');
              tbody.innerHTML =
                '<tr><td colspan="12" class="muted">Loading...</td></tr>';
              var list = await fetchAccounts();
              if (!list.length) {
                tbody.innerHTML =
                  '<tr><td colspan="12" class="muted">No accounts yet</td></tr>';
                return;
              }
              tbody.innerHTML = list
                .map(function (a) {
                  var statusClass =
                    a.ui_state === 'active'
                      ? 'active'
                      : a.ui_state === 'waiting'
                      ? 'waiting'
                      : 'frozen';
                  return (
                    '<tr>' +
                    '<td>' +
                    (a.email || '') +
                    '</td>' +
                    '<td>' +
                    (a.account_id || '') +
                    '</td>' +
                    '<td>' +
                    (a.token || '') +
                    '</td>' +
                    '<td>' +
                    fmt(a.created_at) +
                    '</td>' +
                    '<td>' +
                    fmt(a.last_refresh) +
                    '</td>' +
                    '<td>' +
                    fmt(a.last_used) +
                    '</td>' +
                    '<td>' +
                    fmt(a.expire) +
                    '</td>' +
                    '<td class="status ' +
                    statusClass +
                    '">' +
                    a.status +
                    '</td>' +
                    '<td>' +
                    fmtCD(a.cooldown_until) +
                    '</td>' +
                    '<td>' +
                    (a.fail_count || 0) +
                    '</td>' +
                    '<td>' +
                    (a.last_error_code || '') +
                    '</td>' +
                    '<td class="actions">' +
                    (a.ui_state === 'active'
                      ? '<button data-action="activate" data-id="' +
                        a.id +
                        '" disabled>Active</button>'
                      : '<button data-action="activate" data-id="' +
                        a.id +
                        '">Activate</button>') +
                    (a.disabled
                      ? '<button data-action="enable" data-id="' +
                        a.id +
                        '">Enable</button>'
                      : '<button data-action="disable" data-id="' +
                        a.id +
                        '">Disable</button>') +
                    '<button data-action="refresh" data-id="' +
                    a.id +
                    '">Refresh</button>' +
                    '<button data-action="delete" data-id="' +
                    a.id +
                    '">Delete</button>' +
                    '</td>' +
                    '</tr>'
                  );
                })
                .join('');
            }
            document.addEventListener('click', async function (e) {
              var t = e.target;
              if (t && t.id === 'toggle-relay') {
                var box = document.getElementById('relay-form');
                box.style.display =
                  box.style.display === 'none' ? 'block' : 'none';
                return;
              }
              if (t && t.id === 'relay-save') {
                t.disabled = true;
                t.textContent = 'Saving...';
                var nameEl = document.getElementById('relay-name');
                var baseEl = document.getElementById('relay-base');
                var keyEl = document.getElementById('relay-key');
                var name = nameEl && nameEl.value ? nameEl.value.trim() : '';
                var base = baseEl && baseEl.value ? baseEl.value.trim() : '';
                var key = keyEl && keyEl.value ? keyEl.value.trim() : '';
                var res = await fetch('/accounts/relay', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    name: name,
                    base_url: base,
                    api_key: key,
                  }),
                });
                t.disabled = false;
                t.textContent = 'Save Relay';
                if (res.ok) {
                  if (nameEl) nameEl.value = '';
                  if (keyEl) keyEl.value = '';
                  await render();
                } else {
                  alert('Failed to add relay');
                }
                return;
              }
              if (t && t.dataset && t.dataset.action === 'delete') {
                var id = t.dataset.id;
                if (!confirm('Delete this account?')) return;
                var res = await fetch('/accounts/' + encodeURIComponent(id), {
                  method: 'DELETE',
                });
                if (res.ok) await render();
              } else if (t && t.dataset && t.dataset.action === 'refresh') {
                var id2 = t.dataset.id;
                t.disabled = true;
                t.textContent = 'Refreshing...';
                var res2 = await fetch(
                  '/accounts/' + encodeURIComponent(id2) + '/refresh',
                  { method: 'POST' }
                );
                t.disabled = false;
                t.textContent = 'Refresh';
                if (res2.ok) await render();
              } else if (t && t.dataset && t.dataset.action === 'activate') {
                var idA = t.dataset.id;
                t.disabled = true;
                var resA = await fetch(
                  '/accounts/' + encodeURIComponent(idA) + '/activate',
                  { method: 'POST' }
                );
                if (!resA.ok) alert('Activate failed');
                await render();
              } else if (t && t.dataset && t.dataset.action === 'disable') {
                var id3 = t.dataset.id;
                t.disabled = true;
                var res3 = await fetch(
                  '/accounts/' + encodeURIComponent(id3) + '/disable',
                  { method: 'POST' }
                );
                t.disabled = false;
                if (res3.ok) await render();
              } else if (t && t.dataset && t.dataset.action === 'enable') {
                var id4 = t.dataset.id;
                t.disabled = true;
                var res4 = await fetch(
                  '/accounts/' + encodeURIComponent(id4) + '/enable',
                  { method: 'POST' }
                );
                t.disabled = false;
                if (res4.ok) await render();
              } else if (t && t.id === 'refresh-all') {
                t.disabled = true;
                t.textContent = 'Refreshing All...';
                var list = await fetchAccounts();
                for (var j = 0; j < list.length; j++) {
                  await fetch(
                    '/accounts/' + encodeURIComponent(list[j].id) + '/refresh',
                    { method: 'POST' }
                  );
                }
                t.disabled = false;
                t.textContent = 'Refresh All';
                await render();
              }
            });
            render();
          </script>
        </body>
      </html>`);
  });
}
