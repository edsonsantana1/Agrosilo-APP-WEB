/**
 * Login & Register (com MFA) — Agrosilo
 * Depende de: js/config.js (API_CONFIG, AUTH_CONFIG, VALIDATION_CONFIG, MESSAGES, Utils)
 */

(function () {
  // ========= Helpers de storage (respeita AUTH_CONFIG se existir) =========
  const TOKEN_KEY = (window.AUTH_CONFIG && AUTH_CONFIG.tokenKey) || 'token';
  const USER_KEY  = (window.AUTH_CONFIG && AUTH_CONFIG.userKey)  || 'user';

  function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch {} }
  function getToken()  { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
  function setUser(u)  { try { localStorage.setItem(USER_KEY, JSON.stringify(u)); } catch {} }

  function isAuthenticated() { return Boolean(getToken()); }

  // ========= Helper de requisições (centraliza URL base, headers, token, erros) =========
  async function api(path, { method = 'GET', body, auth = false, headers = {}, signal } = {}) {
    if (!window.API_CONFIG || !API_CONFIG.baseURL) {
      throw new Error('API_CONFIG.baseURL não definido. Verifique js/config.js');
    }

    const url = `${API_CONFIG.baseURL}${path}`;
    const h = { 'Content-Type': 'application/json', ...headers };
    if (auth) {
      const t = getToken();
      if (t) h.Authorization = `Bearer ${t}`;
    }

    // Timeout opcional (10s por padrão do seu config)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_CONFIG.timeout || 10000);

    let resp, data;
    try {
      resp = await fetch(url, {
        method,
        headers: h,
        body: body ? JSON.stringify(body) : undefined,
        signal: signal || controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // tenta parsear JSON (se não for JSON, data = {})
    try { data = await resp.json(); } catch { data = {}; }

    if (!resp.ok) {
      const msg = data.detail || data.error || `HTTP ${resp.status}`;
      const err = new Error(msg);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ========= Mensagens/UI =========
  function showMessage(type, text) {
    const container = document.getElementById('messageContainer') || document.getElementById('message-container');
    if (!container) return;
    container.innerHTML = '';
    const div = document.createElement('div');
    div.className = `message message-${type}`;
    const icon = {
      success: 'fas fa-check-circle',
      error:   'fas fa-exclamation-circle',
      info:    'fas fa-info-circle',
      warning: 'fas fa-exclamation-triangle',
    }[type] || 'fas fa-info-circle';
    div.innerHTML = `<i class="${icon}"></i> ${text}`;
    container.appendChild(div);
    setTimeout(() => div.remove(), (window.NOTIFICATION_CONFIG?.duration || 4000));
  }

  function clearMessages() {
    const c1 = document.getElementById('messageContainer');
    const c2 = document.getElementById('message-container');
    if (c1) c1.innerHTML = '';
    if (c2) c2.innerHTML = '';
  }

  function loading(btn, on, textWhenOn) {
    if (!btn) return;
    if (on) {
      btn.dataset.original = btn.innerHTML;
      btn.innerHTML = `<div class="loading"></div> ${textWhenOn || 'Carregando...'}`;
      btn.disabled = true;
    } else {
      btn.innerHTML = btn.dataset.original || btn.innerHTML;
      btn.disabled = false;
    }
  }

  // ========= Validação de campos =========
  function setFieldError(id, msg) {
    const field = document.getElementById(id);
    const box = field?.closest('.form-group');
    if (!box) return;
    box.classList.remove('success');
    box.classList.add('error');
    box.querySelector('.error-message')?.remove();
    const el = document.createElement('div');
    el.className = 'error-message';
    el.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${msg}`;
    box.appendChild(el);
  }

  function setFieldSuccess(id) {
    const field = document.getElementById(id);
    const box = field?.closest('.form-group');
    if (!box) return;
    box.classList.remove('error');
    box.classList.add('success');
    box.querySelector('.error-message')?.remove();
  }

  function validateLoginForm(email, password, role) {
    let ok = true;

    if (!email || !Utils?.validateEmail?.(email)) {
      setFieldError('email', 'Digite um e-mail válido');
      ok = false;
    } else setFieldSuccess('email');

    const minPwd = window.VALIDATION_CONFIG?.password?.minLength || 4;
    if (!password || password.length < minPwd) {
      setFieldError('password', window.VALIDATION_CONFIG?.password?.message || 'Senha muito curta');
      ok = false;
    } else setFieldSuccess('password');

    if (!role) {
      setFieldError('role', 'Selecione o tipo de usuário');
      ok = false;
    } else setFieldSuccess('role');

    return ok;
  }

  function validateRegisterForm(u) {
    let ok = true;

    if (!u.name || u.name.length < 2) { setFieldError('registerName', 'Nome muito curto'); ok = false; }
    else setFieldSuccess('registerName');

    if (!u.email || !Utils?.validateEmail?.(u.email)) { setFieldError('registerEmail', 'E-mail inválido'); ok = false; }
    else setFieldSuccess('registerEmail');

    const minPwd = window.VALIDATION_CONFIG?.password?.minLength || 4;
    if (!u.password || u.password.length < minPwd) { setFieldError('registerPassword', 'Senha muito curta'); ok = false; }
    else setFieldSuccess('registerPassword');

    if (!u.phoneNumber || !Utils?.validatePhone?.(u.phoneNumber)) { setFieldError('phoneNumber', 'Telefone inválido'); ok = false; }
    else setFieldSuccess('phoneNumber');

    return ok;
  }

  // ========= Máscaras e UI da página =========
  function setupPhoneFormatting() {
    const input = document.getElementById('phoneNumber');
    if (!input) return;
    input.addEventListener('input', (e) => {
      let v = e.target.value.replace(/\D/g, '');
      if (v.length > 6) v = `(${v.slice(0,2)}) ${v.slice(2,7)}-${v.slice(7,11)}`;
      else if (v.length > 2) v = `(${v.slice(0,2)}) ${v.slice(2)}`;
      e.target.value = v;
    });
  }

  function setupPasswordToggle() {
    document.querySelectorAll('.password-toggle').forEach((btn) => {
      btn.addEventListener('click', function () {
        const input = this.previousElementSibling;
        const icon = this.querySelector('i');
        const isPass = input.type === 'password';
        input.type = isPass ? 'text' : 'password';
        icon.classList.toggle('fa-eye', !isPass);
        icon.classList.toggle('fa-eye-slash', isPass);
      });
    });
  }

  function setupFormValidation() {
    document.querySelectorAll('input[type="email"]').forEach((el) => {
      el.addEventListener('blur', function () {
        if (this.value && !Utils?.validateEmail?.(this.value)) setFieldError(this.id, 'E-mail inválido');
        else if (this.value) setFieldSuccess(this.id);
      });
    });

    const phone = document.getElementById('phoneNumber');
    if (phone) {
      phone.addEventListener('blur', function () {
        if (this.value && !Utils?.validatePhone?.(this.value)) setFieldError(this.id, 'Telefone inválido');
        else if (this.value) setFieldSuccess(this.id);
      });
    }
  }

  // ========= Fluxo de Login/Register =========
  async function handleLogin(e) {
    e.preventDefault();

    const form = e.target;
    const email = form.email.value.trim();
    const password = form.password.value;
    const role = form.role.value;

    if (!validateLoginForm(email, password, role)) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    loading(submitBtn, true, 'Entrando...');

    try {
      // POST /api/auth/login (Node)
      const data = await api('/auth/login', {
        method: 'POST',
        body: { email, password, role },
      });

      // --- Fluxos MFA vindos do backend Node ---
      // 1) Provisionamento (usuário NUNCA ativou 2FA)
      if (data.mfa === 'provision' && data.tempToken) {
        setToken(data.tempToken); // token curto para /api/auth/mfa/provision (FastAPI via proxy)
        window.location.href = 'pages/mfa.html?mode=provision';
        return;
      }

      // 2) Verificação (usuário JÁ tem 2FA ativo)
      if (data.mfa === 'verify' && data.email) {
        window.location.href = `pages/mfa.html?mode=verify&email=${encodeURIComponent(data.email)}`;
        return;
      }

      // 3) Sem MFA: login completo
      if (data.token && data.user) {
        setToken(data.token);
        setUser(data.user);
        window.location.href = 'pages/dashboard.html';
        return;
      }

      showMessage('error', 'Resposta de login inesperada do servidor.');
    } catch (err) {
      console.error('[login] erro:', err);
      const friendly = err?.message?.includes('Failed to fetch') || err?.name === 'AbortError'
        ? (window.MESSAGES?.error?.network || 'Erro de conexão. Verifique sua internet.')
        : (err?.message || 'Erro ao realizar login.');
      showMessage('error', friendly);
    } finally {
      loading(submitBtn, false);
    }
  }

  async function handleRegister(e) {
    e.preventDefault();

    const form = e.target;
    const userData = {
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      password: form.password.value,
      phoneNumber: form.phoneNumber.value.trim(),
    };

    if (!validateRegisterForm(userData)) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    loading(submitBtn, true, 'Criando conta...');

    try {
      await api('/auth/register', { method: 'POST', body: userData });
      showMessage('success', 'Conta criada com sucesso! Faça login.');
      setTimeout(() => {
        showLoginForm();
        const emailInput = document.getElementById('email');
        if (emailInput) emailInput.value = userData.email;
      }, 900);
    } catch (err) {
      console.error('[register] erro:', err);
      const msg = err?.data?.detail || err?.data?.error || err?.message || 'Falha no cadastro.';
      showMessage('error', msg);
    } finally {
      loading(submitBtn, false);
    }
  }

  // ========= Alternância de formulários =========
  function showRegisterForm() {
    const loginBox = document.querySelector('.login-form-container');
    const regBox = document.getElementById('registerContainer');
    if (loginBox) loginBox.style.display = 'none';
    if (regBox) regBox.style.display = 'block';
    clearMessages();
  }

  function showLoginForm() {
    const loginBox = document.querySelector('.login-form-container');
    const regBox = document.getElementById('registerContainer');
    if (loginBox) loginBox.style.display = 'block';
    if (regBox) regBox.style.display = 'none';
    clearMessages();
  }

  // ========= Inicialização da página =========
  document.addEventListener('DOMContentLoaded', () => {
    // já logado? vai pro dashboard
    if (isAuthenticated()) {
      window.location.href = 'pages/dashboard.html';
      return;
    }
    // precisa existir API_CONFIG
    if (!window.API_CONFIG || !API_CONFIG.baseURL) {
      console.error('API_CONFIG.baseURL não encontrado. Verifique js/config.js');
      showMessage('error', 'Configuração da API ausente.');
      return;
    }
    setupFormHandlers();
    setupPhoneFormatting();
    setupPasswordToggle();
    setupFormValidation();
  });

  // ========= Bind dos handlers =========
  function setupFormHandlers() {
    const loginForm = document.getElementById('loginForm');
    if (loginForm) loginForm.addEventListener('submit', handleLogin);

    const registerForm = document.getElementById('registerForm');
    if (registerForm) registerForm.addEventListener('submit', handleRegister);

    // Expor helpers globais usados no HTML inline (se houver)
    window.showRegisterForm = showRegisterForm;
    window.showLoginForm = showLoginForm;
    window.togglePassword = function togglePassword() {
      const input = document.getElementById('password');
      const icon = document.getElementById('passwordToggleIcon');
      const isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      icon.classList.toggle('fa-eye', !isPass);
      icon.classList.toggle('fa-eye-slash', isPass);
    };
  }
})();
