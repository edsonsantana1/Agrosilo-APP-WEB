/**
 * JavaScript para a tela de login do Agrosilo
 *
 * Funcionalidades:
 * - Gerenciar formulários de login e cadastro
 * - Validação de campos
 * - Formatação de telefone
 * - Toggle de senha
 * - Notificações e mensagens
 */

document.addEventListener('DOMContentLoaded', function () {
  // Se já estiver logado, vai direto
  if (isAuthenticated()) {
    window.location.href = 'pages/dashboard.html';
    return;
  }

  initializeLoginPage();
});

/** Inicializa a página de login */
function initializeLoginPage() {
  setupFormHandlers();
  setupPhoneFormatting();
  setupPasswordToggle();
  setupFormValidation();
}

/** Configura os manipuladores de formulário */
function setupFormHandlers() {
  const loginForm = document.getElementById('loginForm');
  if (loginForm) loginForm.addEventListener('submit', handleLogin);

  const registerForm = document.getElementById('registerForm');
  if (registerForm) registerForm.addEventListener('submit', handleRegister);
}

/** Envio do formulário de login */
async function handleLogin(event) {
  event.preventDefault();

  const formData = new FormData(event.target);
  const email = formData.get('email');
  const password = formData.get('password');
  const role = formData.get('role');

  if (!validateLoginForm(email, password, role)) return;

  const submitButton = event.target.querySelector('button[type="submit"]');
  const originalText = submitButton.innerHTML;
  submitButton.innerHTML = '<div class="loading"></div> Entrando...';
  submitButton.disabled = true;

  try {
    const result = await login(email, password, role);
    if (result.success) {
      showMessage('success', MESSAGES.success.login);

      // Redireciona SEM modal, independentemente do papel
      setTimeout(() => {
        window.location.href = 'pages/dashboard.html';
      }, 800);
    } else {
      showMessage('error', result.error);
    }
  } catch (error) {
    showMessage('error', MESSAGES.error.network || 'Erro ao realizar login.');
    console.error('Erro no login:', error);
  } finally {
    submitButton.innerHTML = originalText;
    submitButton.disabled = false;
  }
}

/** Envio do formulário de cadastro */
async function handleRegister(event) {
  event.preventDefault();

  const formData = new FormData(event.target);
  const userData = {
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
    phoneNumber: formData.get('phoneNumber')
  };

  if (!validateRegisterForm(userData)) return;

  const submitButton = event.target.querySelector('button[type="submit"]');
  const originalText = submitButton.innerHTML;
  submitButton.innerHTML = '<div class="loading"></div> Criando conta...';
  submitButton.disabled = true;

  try {
    const result = await register(userData);
    if (result.success) {
      showMessage('success', MESSAGES.success.register);
      setTimeout(() => {
        showLoginForm();
        document.getElementById('email').value = userData.email;
      }, 1200);
    } else {
      showMessage('error', result.error);
    }
  } catch (error) {
    showMessage('error', MESSAGES.error.network || 'Erro ao criar conta.');
    console.error('Erro no cadastro:', error);
  } finally {
    submitButton.innerHTML = originalText;
    submitButton.disabled = false;
  }
}

/** Valida o formulário de login */
function validateLoginForm(email, password, role) {
  let isValid = true;

  if (!email || !Utils.validateEmail?.(email)) {
    setFieldError('email', 'Digite um email válido');
    isValid = false;
  } else setFieldSuccess('email');

  if (!password || password.length < (window.VALIDATION_CONFIG?.password?.minLength || 4)) {
    setFieldError('password', window.VALIDATION_CONFIG?.password?.message || 'Senha muito curta');
    isValid = false;
  } else setFieldSuccess('password');

  if (!role) {
    setFieldError('role', 'Selecione o tipo de usuário');
    isValid = false;
  } else setFieldSuccess('role');

  return isValid;
}

/** Valida o formulário de cadastro */
function validateRegisterForm(userData) {
  let isValid = true;

  if (!userData.name || userData.name.trim().length < 2) {
    setFieldError('registerName', 'Nome deve ter pelo menos 2 caracteres');
    isValid = false;
  } else setFieldSuccess('registerName');

  if (!userData.email || !Utils.validateEmail?.(userData.email)) {
    setFieldError('registerEmail', window.VALIDATION_CONFIG?.email?.message || 'Email inválido');
    isValid = false;
  } else setFieldSuccess('registerEmail');

  if (!userData.password || userData.password.length < (window.VALIDATION_CONFIG?.password?.minLength || 4)) {
    setFieldError('registerPassword', window.VALIDATION_CONFIG?.password?.message || 'Senha muito curta');
    isValid = false;
  } else setFieldSuccess('registerPassword');

  if (!userData.phoneNumber || !Utils.validatePhone?.(userData.phoneNumber)) {
    setFieldError('phoneNumber', window.VALIDATION_CONFIG?.phone?.message || 'Telefone inválido');
    isValid = false;
  } else setFieldSuccess('phoneNumber');

  return isValid;
}

/** Marca erro no campo */
function setFieldError(fieldId, message) {
  const field = document.getElementById(fieldId);
  const formGroup = field.closest('.form-group');
  formGroup.classList.remove('success');
  formGroup.classList.add('error');

  const existing = formGroup.querySelector('.error-message');
  if (existing) existing.remove();

  const errorDiv = document.createElement('div');
  errorDiv.className = 'error-message';
  errorDiv.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${message}`;
  formGroup.appendChild(errorDiv);
}

/** Marca sucesso no campo */
function setFieldSuccess(fieldId) {
  const field = document.getElementById(fieldId);
  const formGroup = field.closest('.form-group');
  formGroup.classList.remove('error');
  formGroup.classList.add('success');

  const existing = formGroup.querySelector('.error-message');
  if (existing) existing.remove();
}

/** Formatação do telefone */
function setupPhoneFormatting() {
  const phoneInput = document.getElementById('phoneNumber');
  if (!phoneInput) return;

  phoneInput.addEventListener('input', function (e) {
    let v = e.target.value.replace(/\D/g, '');
    if (v.length > 6) v = `(${v.slice(0, 2)}) ${v.slice(2, 7)}-${v.slice(7)}`;
    else if (v.length > 2) v = `(${v.slice(0, 2)}) ${v.slice(2)}`;
    e.target.value = v;
  });
}

/** Toggle de senha */
function setupPasswordToggle() {
  const btns = document.querySelectorAll('.password-toggle');
  btns.forEach((b) =>
    b.addEventListener('click', function () {
      const input = this.previousElementSibling;
      const icon = this.querySelector('i');
      const isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      icon.classList.toggle('fa-eye', !isPass);
      icon.classList.toggle('fa-eye-slash', isPass);
    })
  );
}

/** Validação em tempo real */
function setupFormValidation() {
  document.querySelectorAll('input[type="email"]').forEach((el) =>
    el.addEventListener('blur', function () {
      if (this.value && !Utils.validateEmail?.(this.value))
        setFieldError(this.id, window.VALIDATION_CONFIG?.email?.message || 'Email inválido');
      else if (this.value) setFieldSuccess(this.id);
    })
  );

  const phoneInput = document.getElementById('phoneNumber');
  if (phoneInput) {
    phoneInput.addEventListener('blur', function () {
      if (this.value && !Utils.validatePhone?.(this.value))
        setFieldError(this.id, window.VALIDATION_CONFIG?.phone?.message || 'Telefone inválido');
      else if (this.value) setFieldSuccess(this.id);
    });
  }
}

/** Ações auxiliares da UI */
function showRegisterForm() {
  document.querySelector('.login-form-container').style.display = 'none';
  document.getElementById('registerContainer').style.display = 'block';
  clearMessages();
}

function showLoginForm() {
  document.querySelector('.login-form-container').style.display = 'block';
  document.getElementById('registerContainer').style.display = 'none';
  clearMessages();
}

function showForgotPassword() {
  showMessage('info', 'Funcionalidade em desenvolvimento. Entre em contato com o administrador.');
}

/** Mensagens */
function showMessage(type, message) {
  const container = document.getElementById('messageContainer');
  container.innerHTML = '';
  const div = document.createElement('div');
  div.className = `message message-${type}`;
  const icon = getMessageIcon(type);
  div.innerHTML = `<i class="${icon}"></i> ${message}`;
  container.appendChild(div);
  setTimeout(() => div.remove(), NOTIFICATION_CONFIG.duration);
}

function getMessageIcon(type) {
  const icons = {
    success: 'fas fa-check-circle',
    error: 'fas fa-exclamation-circle',
    info: 'fas fa-info-circle',
    warning: 'fas fa-exclamation-triangle'
  };
  return icons[type] || icons.info;
}

function clearMessages() {
  document.getElementById('messageContainer').innerHTML = '';
}

/** Toggle de senha global (botão inline no HTML) */
function togglePassword() {
  const input = document.getElementById('password');
  const icon = document.getElementById('passwordToggleIcon');
  const isPass = input.type === 'password';
  input.type = isPass ? 'text' : 'password';
  icon.classList.toggle('fa-eye', !isPass);
  icon.classList.toggle('fa-eye-slash', isPass);
}
