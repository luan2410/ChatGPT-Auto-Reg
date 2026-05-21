
    const state = {
      lists: [],
      selectedListId: null,
      selectedAccountId: null,
      lastResult: null,
      runStatusTimer: null
    };

    const elements = {
      newListName: document.getElementById('newListName'),
      createListBtn: document.getElementById('createListBtn'),
      deleteListBtn: document.getElementById('deleteListBtn'),
      exportBtn: document.getElementById('exportBtn'),
      reloadListsBtn: document.getElementById('reloadListsBtn'),
      runAllBtn: document.getElementById('runAllBtn'),
      clearAllBtn: document.getElementById('clearAllBtn'),
      listsDebug: document.getElementById('listsDebug'),
      listsContainer: document.getElementById('listsContainer'),
      importText: document.getElementById('importText'),
      importBtn: document.getElementById('importBtn'),
      clearImportBtn: document.getElementById('clearImportBtn'),
      accountsContainer: document.getElementById('accountsContainer'),
      accountsCount: document.getElementById('accountsCount'),
      listSessions: document.getElementById('listSessions'),
      detailHeader: document.getElementById('detailHeader'),
      accountDetail: document.getElementById('accountDetail'),
      accountMeta: document.getElementById('accountMeta'),
      runBtn: document.getElementById('runBtn'),
      getCodeBtn: document.getElementById('getCodeBtn'),
      copyCodeBtn: document.getElementById('copyCodeBtn'),
      deleteAccountBtn: document.getElementById('deleteAccountBtn'),
      savedSession: document.getElementById('savedSession'),
      debugSummary: document.getElementById('debugSummary'),
      debugSteps: document.getElementById('debugSteps'),
      status: document.getElementById('status')
    };

    function showStatus(type, message) {
      elements.status.className = 'status show ' + type;
      elements.status.textContent = message;
    }

    function clearStatus() {
      elements.status.className = 'status';
      elements.status.textContent = '';
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function getSelectedList() {
      return state.lists.find(item => item.id === state.selectedListId) || null;
    }

    function getSelectedAccount() {
      const list = getSelectedList();
      if (!list) return null;
      return list.accounts.find(item => item.id === state.selectedAccountId) || null;
    }

    function pickDefaultListId(lists) {
      if (!Array.isArray(lists) || lists.length === 0) return null;
      const firstWithAccounts = lists.find(item => Array.isArray(item.accounts) && item.accounts.length > 0);
      return firstWithAccounts?.id || lists[0]?.id || null;
    }

    function getConvertedSessionsForSelectedList() {
      const list = getSelectedList();
      if (!list) return [];
      return list.accounts
        .map(account => {
          try {
            return account.session_raw ? JSON.parse(account.session_raw) : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }

    function formatDate(value) {
      if (!value) return '-';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat('vi-VN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        day: '2-digit', month: '2-digit', year: 'numeric'
      }).format(date);
    }

    function statusClass(status) {
      if (status === 'success') return 'status-success';
      if (status === 'inprocess') return 'status-inprocess';
      return 'status-pending';
    }

    function statusLabel(status) {
      if (status === 'success') return 'success';
      if (status === 'inprocess') return 'inprocess';
      return 'pending';
    }

    function formatStepLogs(steps = []) {
      return steps.map(step => ({
        ...step,
        at_text: formatDate(step.at)
      }));
    }

    function renderDebugPanel(result) {
      const steps = Array.isArray(result?.steps) ? result.steps : [];
      const summary = [
        { label: 'Status', value: result?.running ? 'Running' : (result?.error ? 'Error' : (result?.message ? 'Success' : 'Idle')) },
        { label: 'Steps', value: String(steps.length) },
        { label: 'Message', value: result?.message || result?.error || '-' },
        { label: 'URL', value: result?.url || '-' }
      ];

      elements.debugSummary.innerHTML = summary.map(item => `
        <div class="debug-card">
          <div class="debug-title">${escapeHtml(item.label)}</div>
          <div class="debug-value">${escapeHtml(item.value)}</div>
        </div>
      `).join('');

      if (steps.length === 0) {
        elements.debugSteps.innerHTML = '<div class="empty">Ch?a c? step debug cho t?i kho?n n?y.</div>';
        return;
      }

      elements.debugSteps.innerHTML = steps.map(step => `
        <div class="debug-step">
          <div class="debug-step-time">${escapeHtml(step.at_text || formatDate(step.at) || '-')}</div>
          <div class="debug-step-message">${escapeHtml(step.message || '-')}</div>
        </div>
      `).join('');
    }

    async function pollRunStatus(accountId) {
      if (state.runStatusTimer) clearInterval(state.runStatusTimer);
      state.runStatusTimer = setInterval(async () => {
        try {
          const data = await api(`/api/accounts/${accountId}/run-status`);
          if (!data) return;
          state.lastResult = {
            ...(state.lastResult || {}),
            message: data.message || state.lastResult?.message || '',
            error: data.error || '',
            steps: formatStepLogs(data.steps || []),
            running: Boolean(data.running)
          };
          renderAccountDetail();
          if (!data.running) {
            clearInterval(state.runStatusTimer);
            state.runStatusTimer = null;
          }
        } catch {}
      }, 1000);
    }

    function stopRunStatusPolling() {
      if (state.runStatusTimer) {
        clearInterval(state.runStatusTimer);
        state.runStatusTimer = null;
      }
    }
    async function fetchListsRaw() {
      const response = await fetch('/api/lists', { cache: 'no-store' });
      const text = await response.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error('Kh?ng parse ???c d? li?u danh s?ch.');
      }
      if (!response.ok) throw new Error(data.error || `Request th?t b?i. HTTP ${response.status}`);
      return Array.isArray(data.lists) ? data.lists : [];
    }

    async function bootstrapListsOnly() {
      const lists = await fetchListsRaw();
      state.lists = lists;
      if (!state.lists.some(item => item.id === state.selectedListId)) {
        state.selectedListId = pickDefaultListId(state.lists);
      }
      const selectedList = getSelectedList();
      if (!selectedList?.accounts.some(item => item.id === state.selectedAccountId)) {
        state.selectedAccountId = selectedList?.accounts[0]?.id || null;
      }
      elements.listsDebug.textContent = `Loaded lists: ${state.lists.length}`;
      renderLists();
    }

    async function api(url, options = {}) {
      const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options
      });
      const text = await response.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error('Phản hồi server không hợp lệ.');
      }
      if (!response.ok) {
        if (data.lists) {
          state.lists = data.lists;
        }
        const error = new Error(data.error || `Request th?t b?i. HTTP ${response.status}`);
        error.payload = data;
        throw error;
      }
      return data;
    }

    async function loadLists() {
      if (!state.lists.some(item => item.id === state.selectedListId)) {
        state.selectedListId = pickDefaultListId(state.lists);
      }
      const selectedList = getSelectedList();
      if (!selectedList && state.lists.length > 0) {
        state.selectedListId = pickDefaultListId(state.lists);
      }
      const resolvedList = getSelectedList();
      if (!resolvedList?.accounts.some(item => item.id === state.selectedAccountId)) {
        state.selectedAccountId = resolvedList?.accounts[0]?.id || null;
      }

      renderLists();

      try {
        renderAccounts();
        renderAccountDetail();
      } catch (error) {
        renderLists();
        showStatus('error', error.message || 'Render UI th?t b?i.');
      }
    }


    function parseImportText(input) {
      return input
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const parts = line.split('|');
          if (parts.length < 4) return null;
          return {
            email: parts[0].trim(),
            password: parts[1].trim(),
            refresh_token: parts[2].trim(),
            client_id: parts[3].trim()
          };
        })
        .filter(Boolean);
    }

    async function createList() {
      const name = elements.newListName.value.trim();
      if (!name) return showStatus('error', 'Bạn chưa nhập tên danh sách.');
      const data = await api('/api/lists', { method: 'POST', body: JSON.stringify({ name }) });
      state.lists = data.lists || [];
      state.selectedListId = Number(data.id);
      state.selectedAccountId = null;
      elements.newListName.value = '';
      render();
      showStatus('success', 'Đã tạo danh sách mới.');
    }

    async function deleteSelectedList() {
      const list = getSelectedList();
      if (!list) return showStatus('error', 'Chưa có danh sách nào được chọn.');
      if (!confirm(`Xóa danh sách "${list.name}"?`)) return;
      const data = await api(`/api/lists/${list.id}`, { method: 'DELETE' });
      state.lists = data.lists || [];
      state.selectedListId = state.lists[0]?.id || null;
      state.selectedAccountId = getSelectedList()?.accounts[0]?.id || null;
      state.lastResult = null;
      render();
      showStatus('success', 'Đã xóa danh sách.');
    }

    async function clearAll() {
      if (!confirm('Xóa toàn bộ dữ liệu trong DB?')) return;
      const data = await api('/api/data', { method: 'DELETE' });
      state.lists = data.lists || [];
      state.selectedListId = null;
      state.selectedAccountId = null;
      state.lastResult = null;
      render();
      showStatus('success', 'Đã xóa toàn bộ dữ liệu.');
    }

    async function importAccounts() {
      const list = getSelectedList();
      if (!list) return showStatus('error', 'Hãy tạo hoặc chọn một danh sách trước.');
      const rows = parseImportText(elements.importText.value.trim());
      if (rows.length === 0) return showStatus('error', 'Không đọc được dữ liệu import hợp lệ.');
      const data = await api(`/api/lists/${list.id}/import`, { method: 'POST', body: JSON.stringify({ rows }) });
      state.lists = data.lists || [];
      state.selectedListId = list.id;
      state.selectedAccountId = getSelectedList()?.accounts[0]?.id || null;
      elements.importText.value = '';
      render();
      showStatus('success', `Đã import ${rows.length} tài khoản. Tất cả được đặt trạng thái pending.`);
    }

    async function deleteSelectedAccount() {
      const account = getSelectedAccount();
      if (!account) return showStatus('error', 'Chưa chọn tài khoản.');
      if (!confirm(`Xóa tài khoản ${account.email}?`)) return;
      const data = await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
      state.lists = data.lists || [];
      state.selectedAccountId = getSelectedList()?.accounts[0]?.id || null;
      state.lastResult = null;
      render();
      showStatus('success', 'Đã xóa tài khoản.');
    }

    async function fetchLatestCode() {
      const account = getSelectedAccount();
      if (!account) return showStatus('error', 'Chưa chọn tài khoản.');
      showStatus('info', `Đang lấy code cho ${account.email} ...`);
      account.status = 'inprocess';
      renderAccountDetail();
      renderAccounts();

      try {
        const data = await api(`/api/accounts/${account.id}/get-code`, { method: 'POST' });
        state.lists = data.lists || [];
        state.lastResult = data.raw || null;
        render();
        showStatus('success', `Đã lấy code mới nhất cho ${account.email}`);
      } catch (error) {
        state.lastResult = null;
        await loadLists();
        showStatus('error', error.message || 'Lấy code thất bại.');
      }
    }

    async function runAllAccountsInList() {
      const list = getSelectedList();
      if (!list) return showStatus('error', 'Ch?a ch?n list.');
      if (!list.accounts.length) return showStatus('error', 'List n?y ch?a c? t?i kho?n.');

      stopRunStatusPolling();
      const accounts = [...list.accounts];
      let completed = 0;
      let successCount = 0;
      const total = accounts.length;

      for (const account of accounts) {
        state.selectedListId = list.id;
        state.selectedAccountId = account.id;
        state.lastResult = { message: '', error: '', steps: [], running: true, url: '' };
        render();
        showStatus('info', `?ang ch?y ${completed + 1}/${total}: ${account.email}`);
        await pollRunStatus(account.id);

        try {
          const data = await api(`/api/accounts/${account.id}/run`, { method: 'POST' });
          stopRunStatusPolling();
          state.lastResult = {
            message: data.message || '',
            steps: formatStepLogs(data.steps || []),
            url: data.url || '',
            running: false
          };
          successCount += 1;
        } catch (error) {
          stopRunStatusPolling();
          state.lastResult = {
            error: error.message || 'Kh?ng m? ???c browser.',
            steps: formatStepLogs(error.payload?.steps || state.lastResult?.steps || []),
            running: false
          };
        }


        completed += 1;
        await loadLists();
        state.selectedListId = list.id;
        state.selectedAccountId = account.id;
        render();
        elements.listSessions.textContent = JSON.stringify(getConvertedSessionsForSelectedList(), null, 2);
      }

      showStatus('success', `?? ch?y xong ${completed}/${total} t?i kho?n trong list.`);
    }

    async function runAccount() {
      const account = getSelectedAccount();
      if (!account) return showStatus('error', 'Ch?a ch?n t?i kho?n.');
      stopRunStatusPolling();
      state.lastResult = { message: '', error: '', steps: [], running: true, url: '' };
      renderAccountDetail();
      showStatus('info', `Dang chay flow OpenAI va se tu nhap email ${account.email} ...`);
      await pollRunStatus(account.id);
      try {
        const data = await api(`/api/accounts/${account.id}/run`, { method: 'POST' });
        stopRunStatusPolling();
        state.lastResult = {
          message: data.message || '',
          steps: formatStepLogs(data.steps || []),
          url: data.url || '',
          running: false
        };
        await loadLists();
        state.selectedAccountId = data.account?.id || account.id;
        renderAccountDetail();
        showStatus('success', data.message || 'Da chay flow OpenAI va nhap email vao form signup.');
      } catch (error) {
        stopRunStatusPolling();
        state.lastResult = {
          error: error.message || 'Kh?ng m? ???c browser.',
          steps: formatStepLogs(error.payload?.steps || state.lastResult?.steps || []),
          running: false
        };
        render();
        showStatus('error', error.message || 'Kh?ng m? ???c browser.');
      }
    }

    async function copyCode() {
      const code = getSelectedAccount()?.last_code || '';
      if (!code) return showStatus('error', 'Chưa có code để copy.');
      try {
        await navigator.clipboard.writeText(code);
        showStatus('success', `Đã copy code ${code}`);
      } catch {
        showStatus('error', 'Copy code thất bại.');
      }
    }

    function exportData() {
      const blob = new Blob([JSON.stringify(state.lists, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'account-lists.json';
      link.click();
      URL.revokeObjectURL(url);
      showStatus('success', 'Đã export dữ liệu JSON.');
    }

    function renderLists() {
      if (state.lists.length === 0) {
        elements.listsContainer.innerHTML = '<div class="empty">Chưa có danh sách nào.</div>';
        return;
      }
      elements.listsContainer.innerHTML = state.lists.map(list => `
        <div class="list-item ${list.id === state.selectedListId ? 'active' : ''}" data-list-id="${list.id}">
          <div class="list-name">${escapeHtml(list.name)}</div>
          <div class="meta">${list.accounts.length} tài khoản</div>
        </div>
      `).join('');
      elements.listsContainer.querySelectorAll('[data-list-id]').forEach(node => {
        node.addEventListener('click', () => {
          state.selectedListId = Number(node.getAttribute('data-list-id'));
          state.selectedAccountId = getSelectedList()?.accounts[0]?.id || null;
          state.lastResult = null;
          render();
        });
      });
    }

    function renderAccounts() {
      const list = getSelectedList();
      const count = list?.accounts.length || 0;
      elements.accountsCount.textContent = `${count} tài khoản`;
      if (!list) {
        elements.accountsContainer.innerHTML = '<div class="empty">Chọn hoặc tạo danh sách trước.</div>';
        return;
      }
      if (count === 0) {
        elements.accountsContainer.innerHTML = '<div class="empty">Danh sách này chưa có tài khoản.</div>';
        return;
      }
      elements.accountsContainer.innerHTML = list.accounts.map(account => `
        <div class="account-item ${account.id === state.selectedAccountId ? 'active' : ''}" data-account-id="${account.id}">
          <div class="account-email">${escapeHtml(account.email)}</div>
          <div class="meta">Pass: ${escapeHtml(account.password || '-')}</div>
          <div class="meta">Trạng thái: <span class="status-pill ${statusClass(account.status)}">${statusLabel(account.status)}</span></div>
          <div class="meta">Code gần nhất: ${escapeHtml(account.last_code || '-')}</div>
          <div class="meta">Lần cập nhật: ${escapeHtml(account.last_fetched_at ? formatDate(account.last_fetched_at) : '-')}</div>
        </div>
      `).join('');
      elements.accountsContainer.querySelectorAll('[data-account-id]').forEach(node => {
        node.addEventListener('click', () => {
          state.selectedAccountId = Number(node.getAttribute('data-account-id'));
          renderAccounts();
          renderAccountDetail();
        });
      });
    }

    function renderAccountDetail() {
      const account = getSelectedAccount();
      if (!account) {
        elements.detailHeader.style.display = 'block';
        elements.accountDetail.style.display = 'none';
        elements.detailHeader.textContent = 'Chọn một tài khoản để xem chi tiết và lấy code.';
        return;
      }
      elements.detailHeader.style.display = 'none';
      elements.accountDetail.style.display = 'block';
      elements.accountMeta.innerHTML = [
        { label: 'Email', value: account.email },
        { label: 'Password', value: account.password || '-' },
        { label: 'Client ID', value: account.client_id || '-' },
        { label: 'Status', value: statusLabel(account.status) },
        { label: 'Refresh Token', value: account.refresh_token || '-' },
        { label: 'Last Fetched', value: account.last_fetched_at ? formatDate(account.last_fetched_at) : '-' },
        { label: 'Session Saved', value: account.session_fetched_at ? formatDate(account.session_fetched_at) : '-' }
      ].map(item => `
        <div class="meta-box">
          <div class="meta-label">${escapeHtml(item.label)}</div>
          <div class="meta-value">${escapeHtml(item.value)}</div>
        </div>
      `).join('');
      elements.savedSession.textContent = account.session_raw || '-';
      renderDebugPanel(state.lastResult);
    }

    function render() {
      renderLists();
      renderAccounts();
      renderAccountDetail();
    }

    async function bootstrapApp() {
      try {
        await loadLists();
        if (!state.lists.length) {
          await new Promise(resolve => setTimeout(resolve, 300));
          await loadLists();
        }
      } catch (error) {
        showStatus('error', error.message || 'Kh?ng t?i ???c d? li?u t? DB.');
      }
    }

    elements.createListBtn.addEventListener('click', () => createList().catch(err => showStatus('error', err.message)));
    elements.deleteListBtn.addEventListener('click', () => deleteSelectedList().catch(err => showStatus('error', err.message)));
    elements.importBtn.addEventListener('click', () => importAccounts().catch(err => showStatus('error', err.message)));
    elements.clearImportBtn.addEventListener('click', () => { elements.importText.value = ''; });
    elements.clearAllBtn.addEventListener('click', () => clearAll().catch(err => showStatus('error', err.message)));
    async function hardReloadLists(options = {}) {
      const attempts = options.attempts || 6;
      const delayMs = options.delayMs || 500;
      let lastError = null;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          await bootstrapListsOnly();
          await loadLists();
          elements.listsDebug.textContent = 'Loaded lists: ' + state.lists.length + ' | Attempt: ' + attempt + '/' + attempts;
          if (state.lists.length > 0 || attempt === attempts) return;
        } catch (error) {
          lastError = error;
          elements.listsDebug.textContent = 'Loaded lists: 0 | Attempt: ' + attempt + '/' + attempts;
        }

        if (attempt < attempts) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      if (lastError) throw lastError;
    }


    elements.exportBtn.addEventListener('click', exportData);
    elements.reloadListsBtn.addEventListener('click', () => hardReloadLists().catch(err => showStatus('error', err.message)));
    elements.runAllBtn.addEventListener('click', () => runAllAccountsInList().catch(err => showStatus('error', err.message)));
    elements.runBtn.addEventListener('click', () => runAccount().catch(err => showStatus('error', err.message)));
    elements.getCodeBtn.addEventListener('click', () => fetchLatestCode().catch(err => showStatus('error', err.message)));
    elements.copyCodeBtn.addEventListener('click', copyCode);
    elements.deleteAccountBtn.addEventListener('click', () => deleteSelectedAccount().catch(err => showStatus('error', err.message)));

    const startListBootstrap = () => {
      hardReloadLists({ attempts: 6, delayMs: 500 }).catch(err => showStatus('error', err.message || 'Kh?ng t?i ???c d? li?u t? DB.'));
    };

    startListBootstrap();

    let startupRetryCount = 0;
    const startupRetryTimer = setInterval(() => {
      startupRetryCount += 1;
      if (state.lists.length > 0 || startupRetryCount >= 8) {
        clearInterval(startupRetryTimer);
        return;
      }
      hardReloadLists({ attempts: 2, delayMs: 300 }).catch(() => {});
    }, 700);

    document.addEventListener('DOMContentLoaded', startListBootstrap, { once: true });
    window.addEventListener('pageshow', () => {
      hardReloadLists({ attempts: 2, delayMs: 300 }).catch(() => {});
    });
  