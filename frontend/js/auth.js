/**
 * Módulo de Autenticação do Agrosilo
 *
 * Responsável por:
 * - Gerenciar login e logout
 * - Armazenar e validar tokens
 * - Controlar acesso às páginas
 * - Gerenciar dados do usuário
 *
 * Observação:
 *  - A parte de UI (troca de abas Login/Criar conta, ano no rodapé)
 *    está no final deste arquivo, isolada em DOMContentLoaded,
 *    para NÃO interferir nas demais páginas.
 */

class AuthManager {
    constructor() {
        // Tenta recuperar dados já salvos no navegador
        this.token = localStorage.getItem(AUTH_CONFIG.tokenKey);
        this.user = JSON.parse(localStorage.getItem(AUTH_CONFIG.userKey) || 'null');

        // Configura interceptadores globais do Axios (se estiver disponível)
        this.setupAxiosInterceptors();
    }

    /**
     * Configura interceptadores do Axios para incluir token automaticamente
     * em toda requisição HTTP.
     */
    setupAxiosInterceptors() {
        if (typeof axios !== 'undefined') {
            axios.interceptors.request.use(
                (config) => {
                    // Se houver token, adiciona no cabeçalho Authorization
                    if (this.token) {
                        config.headers.Authorization = `Bearer ${this.token}`;
                    }
                    return config;
                },
                (error) => Promise.reject(error)
            );

            axios.interceptors.response.use(
                (response) => response,
                (error) => {
                    // Se o backend responder 401, força logout
                    if (error.response?.status === 401) {
                        this.logout();
                    }
                    return Promise.reject(error);
                }
            );
        }
    }

    /**
     * Realiza login do usuário.
     * @param {string} email
     * @param {string} password
     * @param {string} role
     * @returns {Promise<{success: boolean, user?: object, error?: string}>}
     */
    async login(email, password, role) {
        try {
            const response = await this.makeRequest('/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email, password, role })
            });

            if (response.token && response.user) {
                this.setAuthData(response.token, response.user);
                return { success: true, user: response.user };
            } else {
                throw new Error('Resposta inválida do servidor');
            }
        } catch (error) {
            console.error('Erro no login:', error);
            return {
                success: false,
                error: error.message || MESSAGES.error.login
            };
        }
    }

    /**
     * Registra novo usuário
     * @param {object} userData
     * @returns {Promise<{success: boolean, message?: string, error?: string}>}
     */
    async register(userData) {
        try {
            const response = await this.makeRequest('/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    ...userData,
                    role: 'user' // força role "user" por padrão
                })
            });

            return { success: true, message: response.message };
        } catch (error) {
            console.error('Erro no registro:', error);
            return {
                success: false,
                error: error.message || MESSAGES.error.register
            };
        }
    }

    /**
     * Realiza logout do usuário e redireciona para tela de login
     */
    async logout() {
        const token = this.token;

        // Tenta invalidar o token no backend (opcional)
        try {
            await fetch(`${API_CONFIG.baseURL}/auth/logout`, {
                method: 'POST',
                headers: token ? { Authorization: `Bearer ${token}` } : {}
            });
        } catch (_) {
            // Se o endpoint não existir ou falhar, apenas ignora
        }

        // Limpa os dados locais de autenticação
        this.token = null;
        this.user = null;

        try {
            localStorage.removeItem(AUTH_CONFIG.tokenKey);
            localStorage.removeItem(AUTH_CONFIG.userKey);
            sessionStorage.removeItem?.(AUTH_CONFIG.tokenKey);
            sessionStorage.removeItem?.(AUTH_CONFIG.userKey);
        } catch {
            // Falha ao acessar storage (modo privado, etc.) pode ser ignorada
        }

        // Detecta se está dentro da pasta /pages e ajusta o caminho da tela de login
        const currentPath = window.location.pathname;
        const loginPath = currentPath.includes('/pages/')
            ? '../index.html'
            : 'index.html';

        // Redireciona imediatamente para o login (não permitindo voltar)
        window.location.replace(loginPath);
    }

    /**
     * Verifica se o usuário está autenticado
     */
    isAuthenticated() {
        return !!this.token && !!this.user;
    }

    /**
     * Verifica se o usuário é administrador
     */
    isAdmin() {
        return this.user?.role === 'admin';
    }

    /**
     * Obtém dados do usuário atual
     */
    getCurrentUser() {
        return this.user;
    }

    /**
     * Obtém token atual
     */
    getToken() {
        return this.token;
    }

    /**
     * Define dados de autenticação e persiste no localStorage
     */
    setAuthData(token, user) {
        this.token = token;
        this.user = user;

        localStorage.setItem(AUTH_CONFIG.tokenKey, token);
        localStorage.setItem(AUTH_CONFIG.userKey, JSON.stringify(user));
    }

    /**
     * Faz requisição HTTP com tratamento padronizado de erros.
     * @param {string} endpoint
     * @param {RequestInit} options
     */
    async makeRequest(endpoint, options = {}) {
        const url = `${API_CONFIG.baseURL}${endpoint}`;

        const defaultOptions = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...(this.token && { Authorization: `Bearer ${this.token}` })
            }
        };

        const finalOptions = { ...defaultOptions, ...options };

        try {
            const response = await fetch(url, finalOptions);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            // Erro de rede (backend offline, CORS, etc.)
            if (error.name === 'TypeError' && error.message.includes('fetch')) {
                throw new Error(MESSAGES.error.network);
            }
            throw error;
        }
    }

    /**
     * Verifica se o token JWT está expirado (implementação básica)
     */
    isTokenExpired() {
        if (!this.token) return true;

        try {
            const payloadBase64 = this.token.split('.')[1];
            const payloadJson = atob(payloadBase64);
            const payload = JSON.parse(payloadJson);

            const now = Date.now() / 1000;
            return payload.exp < now;
        } catch (error) {
            // Qualquer erro ao decodificar o token é tratado como expirado
            return true;
        }
    }

    /**
     * Renova o token se necessário
     * (aqui apenas verifica expiração; se tiver refresh token,
     *  este seria o lugar para usá-lo)
     */
    async refreshTokenIfNeeded() {
        if (this.isTokenExpired()) {
            this.logout();
            return false;
        }
        return true;
    }

    /**
     * Protege uma página comum - redireciona se não autenticado
     */
    requireAuth() {
        if (!this.isAuthenticated() || this.isTokenExpired()) {
            this.logout();
            return false;
        }
        return true;
    }

    /**
     * Protege uma página de admin - redireciona se não for admin
     */
    requireAdmin() {
        if (!this.requireAuth()) return false;

        if (!this.isAdmin()) {
            window.location.replace('/pages/dashboard.html');
            return false;
        }
        return true;
    }

    /**
     * Busca todos os usuários (apenas para admins)
     */
    async getUsers() {
        if (!this.isAdmin()) throw new Error('Acesso negado');

        try {
            return await this.makeRequest('/users');
        } catch (error) {
            console.error('Erro ao buscar usuários:', error);
            throw error;
        }
    }

    /**
     * Atualiza um usuário (apenas para admins)
     */
    async updateUser(userId, userData) {
        if (!this.isAdmin()) throw new Error('Acesso negado');

        try {
            return await this.makeRequest(`/users/${userId}`, {
                method: 'PATCH',
                body: JSON.stringify(userData)
            });
        } catch (error) {
            console.error('Erro ao atualizar usuário:', error);
            throw error;
        }
    }

    /**
     * Exclui um usuário (apenas para admins)
     */
    async deleteUser(userId) {
        if (!this.isAdmin()) throw new Error('Acesso negado');

        try {
            return await this.makeRequest(`/users/${userId}`, {
                method: 'DELETE'
            });
        } catch (error) {
            console.error('Erro ao excluir usuário:', error);
            throw error;
        }
    }
}

/* =========================================================================
   Instância global do gerenciador de autenticação
   ========================================================================= */

const authManager = new AuthManager();

// Expõe funções globais de conveniência (mantendo compatibilidade)
window.authManager = authManager;
window.login = (email, password, role) => authManager.login(email, password, role);
window.register = (userData) => authManager.register(userData);
window.logout = () => authManager.logout();
window.isAuthenticated = () => authManager.isAuthenticated();
window.isAdmin = () => authManager.isAdmin();
window.getCurrentUser = () => authManager.getCurrentUser();
window.requireAuth = () => authManager.requireAuth();
window.requireAdmin = () => authManager.requireAdmin();

/* =========================================================================
   LÓGICA DE UI PARA A TELA DE LOGIN/CRIAR CONTA
   - Alterna abas (Login / Criar conta)
   - Atualiza ano no rodapé
   - Tudo protegido por verificações para NÃO quebrar outras telas.
   ========================================================================= */

document.addEventListener('DOMContentLoaded', () => {
    // Seleciona abas e formulários SE existirem na página.
    const tabs = document.querySelectorAll('.auth-tab');
    const forms = document.querySelectorAll('.auth-form');

    // Se não houver elementos de aba, significa que não estamos na tela de login,
    // então não faz nada (evita quebrar outras páginas).
    if (tabs.length > 0 && forms.length > 0) {
        const loginForm = document.getElementById('login-form');
        const registerForm = document.getElementById('register-form');

        const handleTabClick = (event) => {
            const clickedTab = event.currentTarget;
            const target = clickedTab.dataset.target; // "login" ou "register"

            // Remove estado ativo das abas
            tabs.forEach((tab) => {
                tab.classList.remove('auth-tab--active');
                tab.setAttribute('aria-selected', 'false');
            });

            // Esconde todos os formulários
            forms.forEach((form) => {
                form.classList.remove('auth-form--active');
            });

            // Ativa aba clicada
            clickedTab.classList.add('auth-tab--active');
            clickedTab.setAttribute('aria-selected', 'true');

            // Mostra o formulário correto
            if (target === 'login' && loginForm) {
                loginForm.classList.add('auth-form--active');
            } else if (target === 'register' && registerForm) {
                registerForm.classList.add('auth-form--active');
            }
        };

        // Registra eventos de clique nas abas
        tabs.forEach((tab) => {
            tab.addEventListener('click', handleTabClick);
        });
    }

    // Atualiza o ano no rodapé, se o elemento existir
    const yearSpan = document.getElementById('year');
    if (yearSpan) {
        yearSpan.textContent = new Date().getFullYear();
    }
});
