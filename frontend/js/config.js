/**
 * Configurações globais do aplicativo Agrosilo
 */
const API_CONFIG = {
  baseURL: 'http://localhost:4000/api',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' }
};
window.API_URL = API_CONFIG.baseURL;

const AUTH_CONFIG = {
  tokenKey: 'agrosilo_token',
  userKey: 'agrosilo_user',
  tokenExpiry: 3600000
};

// ... (demais configs/Utils iguais aos seus)

window.API_CONFIG = API_CONFIG;
window.AUTH_CONFIG = AUTH_CONFIG;

// Configurações de notificação
const NOTIFICATION_CONFIG = {
    duration: 5000, // 5 segundos
    position: 'top-right'
};

// Parâmetros técnicos de segurança dos silos
const SAFETY_PARAMETERS = {
    humidity: {
        acceptable: 14,     // até 14% - recepção aceitável
        safe: 13,          // ≤ 13% - armazenamento seguro
        insect_limit: 10,  // abaixo de 10% - limita desenvolvimento de insetos
        fungus_risk: 16    // acima de 16% - risco explosivo de fungos
    },
    temperature: {
        slow_fungus: 15,        // abaixo de 15°C - crescimento de fungos é lento
        medium_growth_min: 20,  // entre 20°C e 30°C - crescimento médio
        medium_growth_max: 30,
        high_risk_min: 40,      // entre 40°C e 55°C - crescimento máximo (risco alto)
        high_risk_max: 55
    }
};

// Configurações de gráficos
const CHART_CONFIG = {
    colors: {
        temperature: '#FF6B6B',
        humidity: '#4ECDC4',
        pressure: '#45B7D1',
        co2: '#96CEB4'
    },
    refreshInterval: 30000, // 30 segundos
    maxDataPoints: 100
};

// Configurações de validação
const VALIDATION_CONFIG = {
    phone: {
        pattern: /^\(\d{2}\)\s\d{4,5}-?\d{4}$/,
        message: 'Formato: (11) 99999-9999'
    },
    email: {
        pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        message: 'Digite um email válido'
    },
    password: {
        minLength: 6,
        message: 'Senha deve ter pelo menos 6 caracteres'
    }
};

// Mensagens do sistema
const MESSAGES = {
    success: {
        login: 'Login realizado com sucesso!',
        register: 'Conta criada com sucesso!',
        logout: 'Logout realizado com sucesso!',
        save: 'Dados salvos com sucesso!',
        delete: 'Item excluído com sucesso!',
        update: 'Dados atualizados com sucesso!'
    },
    error: {
        login: 'Email ou senha incorretos',
        register: 'Erro ao criar conta. Tente novamente.',
        network: 'Erro de conexão. Verifique sua internet.',
        unauthorized: 'Acesso negado. Faça login novamente.',
        validation: 'Por favor, corrija os campos destacados',
        generic: 'Ocorreu um erro inesperado. Tente novamente.'
    },
    info: {
        loading: 'Carregando...',
        noData: 'Nenhum dado encontrado',
        processing: 'Processando...'
    }
};

// Utilitários globais
const Utils = {
    /**
     * Formata um número para exibição
     */
    formatNumber: (value, decimals = 2) => {
        return parseFloat(value).toFixed(decimals);
    },

    /**
     * Formata data para exibição
     */
    formatDate: (date, options = {}) => {
        const defaultOptions = {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        };
        return new Date(date).toLocaleString('pt-BR', { ...defaultOptions, ...options });
    },

    /**
     * Formata telefone
     */
    formatPhone: (phone) => {
        const cleaned = phone.replace(/\D/g, '');
        if (cleaned.length === 11) {
            return `(${cleaned.slice(0, 2)}) ${cleaned.slice(2, 7)}-${cleaned.slice(7)}`;
        }
        return phone;
    },

    /**
     * Valida email
     */
    validateEmail: (email) => {
        return VALIDATION_CONFIG.email.pattern.test(email);
    },

    /**
     * Valida telefone
     */
    validatePhone: (phone) => {
        return VALIDATION_CONFIG.phone.pattern.test(phone);
    },

    /**
     * Gera ID único
     */
    generateId: () => {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    },

    /**
     * Debounce function
     */
    debounce: (func, wait) => {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },

    /**
     * Determina o nível de alerta baseado no valor do sensor
     */
    getAlertLevel: (sensorType, value) => {
        switch (sensorType) {
            case 'humidity':
                if (value > SAFETY_PARAMETERS.humidity.fungus_risk) return 'critical';
                if (value > SAFETY_PARAMETERS.humidity.acceptable) return 'warning';
                if (value > SAFETY_PARAMETERS.humidity.safe) return 'caution';
                return 'normal';
            
            case 'temperature':
                if (value >= SAFETY_PARAMETERS.temperature.high_risk_min && 
                    value <= SAFETY_PARAMETERS.temperature.high_risk_max) return 'critical';
                if (value > SAFETY_PARAMETERS.temperature.high_risk_max) return 'critical';
                if (value >= SAFETY_PARAMETERS.temperature.medium_growth_min && 
                    value <= SAFETY_PARAMETERS.temperature.medium_growth_max) return 'warning';
                return 'normal';
            
            default:
                return 'normal';
        }
    },

    /**
     * Retorna a cor do alerta
     */
    getAlertColor: (level) => {
        const colors = {
            normal: '#4CAF50',
            caution: '#FF9800',
            warning: '#FF5722',
            critical: '#F44336'
        };
        return colors[level] || colors.normal;
    },

    /**
     * Retorna o ícone do sensor
     */
    getSensorIcon: (sensorType) => {
        const icons = {
            temperature: 'fas fa-thermometer-half',
            humidity: 'fas fa-tint',
            pressure: 'fas fa-gauge-high',
            co2: 'fas fa-smog'
        };
        return icons[sensorType] || 'fas fa-sensor';
    },

    /**
     * Retorna a unidade do sensor
     */
    getSensorUnit: (sensorType) => {
        const units = {
            temperature: '°C',
            humidity: '%',
            pressure: 'hPa',
            co2: 'ppm'
        };
        return units[sensorType] || '';
    }
};

// Exportar configurações para uso global
window.API_CONFIG = API_CONFIG;
window.AUTH_CONFIG = AUTH_CONFIG;
window.NOTIFICATION_CONFIG = NOTIFICATION_CONFIG;
window.SAFETY_PARAMETERS = SAFETY_PARAMETERS;
window.CHART_CONFIG = CHART_CONFIG;
window.VALIDATION_CONFIG = VALIDATION_CONFIG;
window.MESSAGES = MESSAGES;
window.Utils = Utils;

