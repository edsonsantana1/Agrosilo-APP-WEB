/**
 * Módulo de Autenticação do Agrosilo
 * 
 * Responsável por:
 * - Gerenciar login e logout
 * - Armazenar e validar tokens
 * - Controlar acesso às páginas
 * - Gerenciar dados do usuário
 */

class AuthManager {
    constructor() {
        this.token = localStorage.getItem(AUTH_CONFIG.tokenKey);
        this.user = JSON.parse(localStorage.getItem(AUTH_CONFIG.userKey) || 'null');
        this.setupAxiosInterceptors();
    }

    /**
     * Configura interceptadores do Axios para incluir token automaticamente
     */
    setupAxiosInterceptors() {
        if (typeof axios !== 'undefined') {
            axios.interceptors.request.use(
                (config) => {
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
                    if (error.response?.status === 401) {
                        this.logout();
                    }
                    return Promise.reject(error);
                }
            );
        }
    }

    /**
     * Realiza login do usuário
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
     */
    async register(userData) {
        try {
            const response = await this.makeRequest('/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    ...userData,
                    role: 'user'
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
            // ignora se o endpoint não existir
        }

        // Limpa os dados locais
        this.token = null;
        this.user = null;
        try {
            localStorage.removeItem(AUTH_CONFIG.tokenKey);
            localStorage.removeItem(AUTH_CONFIG.userKey);
            sessionStorage.removeItem?.(AUTH_CONFIG.tokenKey);
            sessionStorage.removeItem?.(AUTH_CONFIG.userKey);
        } catch {}

        // Detecta se está dentro da pasta /pages e ajusta o caminho
        const currentPath = window.location.pathname;
        const loginPath = currentPath.includes('/pages/') ? '../index.html' : 'index.html';

        // Redireciona imediatamente para o login (sem permitir "voltar")
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
     * Define dados de autenticação
     */
    setAuthData(token, user) {
        this.token = token;
        this.user = user;
        localStorage.setItem(AUTH_CONFIG.tokenKey, token);
        localStorage.setItem(AUTH_CONFIG.userKey, JSON.stringify(user));
    }

    /**
     * Faz requisição HTTP com tratamento de erros
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
            if (error.name === 'TypeError' && error.message.includes('fetch')) {
                throw new Error(MESSAGES.error.network);
            }
            throw error;
        }
    }

    /**
     * Verifica se o token está expirado (implementação básica)
     */
    isTokenExpired() {
        if (!this.token) return true;
        
        try {
            const payload = JSON.parse(atob(this.token.split('.')[1]));
            const now = Date.now() / 1000;
            return payload.exp < now;
        } catch (error) {
            return true;
        }
    }

    /**
     * Renova o token se necessário
     */
    async refreshTokenIfNeeded() {
        if (this.isTokenExpired()) {
            this.logout();
            return false;
        }
        return true;
    }

    /**
     * Protege uma página - redireciona se não autenticado
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

// Instância global do gerenciador de autenticação
const authManager = new AuthManager();

// Funções utilitárias globais
window.authManager = authManager;

// Funções globais de conveniência
window.login = (email, password, role) => authManager.login(email, password, role);
window.register = (userData) => authManager.register(userData);
window.logout = () => authManager.logout();
window.isAuthenticated = () => authManager.isAuthenticated();
window.isAdmin = () => authManager.isAdmin();
window.getCurrentUser = () => authManager.getCurrentUser();
window.requireAuth = () => authManager.requireAuth();
window.requireAdmin = () => authManager.requireAdmin();
