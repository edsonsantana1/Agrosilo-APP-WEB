// js/users.js (ATUALIZADO)
// - Usa /users (admin) para criar
// - Edita também telegramChatId e notificationsEnabled
// - Mantém requireAuth / requireAdmin e toda a UI existente

document.addEventListener('DOMContentLoaded', async () => {
  // Proteções
  if (!requireAuth()) return;
  if (!requireAdmin()) return;

  // Mostrar item "Usuários" no menu quando for admin
  const menu = document.getElementById('usersMenuItem');
  if (menu) menu.style.display = 'flex';

  // ===== Modal Criar =====
  const createModal      = document.getElementById('createModal');
  const openCreateBtn    = document.getElementById('btnOpenCreate');
  const closeCreateBtn   = document.getElementById('btnCloseCreate');
  const cancelCreateBtn  = document.getElementById('btnCancelCreate');
  const submitCreateBtn  = document.getElementById('btnSubmitCreate');

  const openCreate  = () => createModal && (createModal.style.display = 'flex');
  const closeCreate = () => createModal && (createModal.style.display = 'none');

  if (openCreateBtn)   openCreateBtn.addEventListener('click', openCreate);
  if (closeCreateBtn)  closeCreateBtn.addEventListener('click', closeCreate);
  if (cancelCreateBtn) cancelCreateBtn.addEventListener('click', closeCreate);
  if (createModal) {
    createModal.addEventListener('click', (e) => { if (e.target === createModal) closeCreate(); });
  }
  if (submitCreateBtn) submitCreateBtn.addEventListener('click', onCreateUser);

  // ===== Modal Editar =====
  const editModal     = document.getElementById('editModal');
  const btnCloseEdit  = document.getElementById('btnCloseEdit');
  const btnCancelEdit = document.getElementById('btnCancelEdit');
  const btnSubmitEdit = document.getElementById('btnSubmitEdit');

  const openEdit  = () => editModal && (editModal.style.display = 'flex');
  const closeEdit = () => editModal && (editModal.style.display = 'none');

  if (btnCloseEdit)  btnCloseEdit.addEventListener('click', closeEdit);
  if (btnCancelEdit) btnCancelEdit.addEventListener('click', closeEdit);
  if (editModal) {
    editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEdit(); });
  }
  if (btnSubmitEdit) btnSubmitEdit.addEventListener('click', onSubmitEditUser);

  // Cache local para preencher o modal de edição
  window._usersCache = [];

  // Carrega a lista
  await loadUsers();
});

// ===== Criar usuário (via /users, apenas admin) =====
async function onCreateUser() {
  const name         = document.getElementById('name')?.value.trim();
  const email        = document.getElementById('email')?.value.trim();
  const password     = document.getElementById('password')?.value;
  const role         = document.getElementById('role')?.value || 'user';
  const phoneNumber  = document.getElementById('phoneNumber')?.value.trim();
  const telegramChatId = document.getElementById('telegramChatId')?.value.trim();
  const notificationsEnabled = !!document.getElementById('notificationsEnabled')?.checked;

  if (!name || !email || !password) {
    alert('Preencha nome, e-mail e senha.');
    return;
  }

  try {
    await authManager.makeRequest('/users', {
      method: 'POST',
      body: JSON.stringify({
        name,
        email,
        password,
        role,
        phoneNumber,
        telegramChatId,
        notificationsEnabled
      })
    });

    await loadUsers();
    const modal = document.getElementById('createModal');
    if (modal) modal.style.display = 'none';
  } catch (err) {
    alert(err.message || 'Erro ao criar usuário.');
  }
}

// ===== Abrir modal de edição preenchido =====
function openEditUser(id) {
  const u = (window._usersCache || []).find(x => (x._id || x.id) === id);
  if (!u) {
    alert('Usuário não encontrado na lista carregada.');
    return;
  }

  document.getElementById('edit_name').value            = u.name || '';
  document.getElementById('edit_email').value           = u.email || '';
  document.getElementById('edit_role').value            = u.role || 'user';
  document.getElementById('edit_phoneNumber').value     = u.phoneNumber || '';
  document.getElementById('edit_telegramChatId').value  = u.telegramChatId || '';
  const notifEl = document.getElementById('edit_notificationsEnabled');
  if (notifEl) notifEl.checked = !!u.notificationsEnabled;
  document.getElementById('edit_password').value        = '';

  // guarda o id no modal
  document.getElementById('editModal').dataset.userId = (u._id || u.id);

  document.getElementById('editModal').style.display = 'flex';
}
window.openEditUser = openEditUser; // deixa global para onclick

// ===== Salvar edição =====
async function onSubmitEditUser() {
  const id = document.getElementById('editModal').dataset.userId;
  if (!id) return;

  const payload = {
    name:           document.getElementById('edit_name').value.trim(),
    email:          document.getElementById('edit_email').value.trim(),
    role:           document.getElementById('edit_role').value,
    phoneNumber:    document.getElementById('edit_phoneNumber').value.trim(),
    telegramChatId: document.getElementById('edit_telegramChatId').value.trim(),
    notificationsEnabled: !!document.getElementById('edit_notificationsEnabled').checked
  };

  const newPass = document.getElementById('edit_password').value;
  if (newPass && newPass.trim().length > 0) {
    payload.password = newPass.trim(); // será hasheada no pre-save do model
  }

  if (!payload.name || !payload.email) {
    alert('Preencha nome e e-mail.');
    return;
  }

  try {
    await authManager.updateUser(id, payload);
    document.getElementById('editModal').style.display = 'none';
    await loadUsers();
  } catch (err) {
    alert(err.message || 'Erro ao salvar alterações.');
  }
}

// ===== Excluir usuário =====
async function confirmDeleteUser(id, email) {
  if (!confirm('Excluir o usuário ' + email + '? Esta ação não pode ser desfeita.')) return;
  try {
    await authManager.deleteUser(id);
    await loadUsers();
  } catch (err) {
    alert(err.message || 'Erro ao excluir usuário.');
  }
}
window.confirmDeleteUser = confirmDeleteUser;

// ===== Carregar lista de usuários =====
async function loadUsers() {
  const tbody = document.getElementById('usersTbody');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center">Carregando...</td></tr>';
  try {
    let users = await authManager.getUsers();
    if (!Array.isArray(users) && users?.users) users = users.users;

    window._usersCache = users;

    if (!Array.isArray(users) || users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center">Nenhum usuário encontrado.</td></tr>';
      return;
    }

    tbody.innerHTML = users.map(u => `
      <tr>
        <td>${u.name || '-'}</td>
        <td>${u.email}</td>
        <td>
          <span class="badge ${u.role === 'admin' ? 'badge-admin' : 'badge-user'}">
            ${u.role === 'admin' ? '<i class="fas fa-shield-alt"></i> ADMIN' : '<i class="fas fa-user"></i> USUÁRIO'}
          </span>
        </td>
        <td>${u.phoneNumber || '-'}</td>
        <td>${u.telegramChatId || '-'}</td>
        <td>${u.notificationsEnabled ? 'Ativas' : 'Inativas'}</td>
        <td class="actions-cell">
          <button class="btn btn-outline" title="Editar" onclick="openEditUser('${u._id || u.id}')">
            <i class="fas fa-edit"></i>
          </button>
          <button class="btn btn-outline" title="Excluir" onclick="confirmDeleteUser('${u._id || u.id}', '${u.email}')">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('[Users] erro ao carregar:', err);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--danger-dark)">${err.message || 'Erro ao carregar usuários.'}</td></tr>`;
  }
}
