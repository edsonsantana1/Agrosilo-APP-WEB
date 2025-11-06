/**
 * utils.js (versão idempotente)
 * Helpers globais do frontend Agrosilo.
 * - Não redeclara variáveis globais se o arquivo for incluído mais de uma vez.
 * - Anexa tudo em window.* com guards.
 */
(function () {
  const g = (typeof window !== "undefined") ? window : globalThis;

  // ---------------- Configs globais ----------------
  // Define apenas se ainda não existir (evita "already been declared")
  g.NOTIFICATION_CONFIG = g.NOTIFICATION_CONFIG || { duration: 5000 };

  g.API_CONFIG = g.API_CONFIG || {
    baseURL: (typeof g.API_BASE_URL !== "undefined")
      ? g.API_BASE_URL
      : "http://localhost:4000/api"
  };

  g.AUTH_CONFIG = g.AUTH_CONFIG || { tokenKey: "jwtToken", userKey: "currentUser" };

  g.MESSAGES = g.MESSAGES || {
    error: {
      network: "Erro de conexão. Verifique sua internet ou o servidor.",
      login: "Email ou senha inválidos.",
      register: "Erro ao registrar usuário. Tente novamente.",
      unauthorized: "Sessão expirada ou não autorizado. Faça login novamente."
    },
    success: {
      login: "Login realizado com sucesso!",
      register: "Usuário registrado com sucesso!",
      logout: "Logout realizado com sucesso."
    }
  };

  // ---------------- Parâmetros de segurança (espelha o backend) -----------
  g.SAFETY_PARAMETERS = g.SAFETY_PARAMETERS || {
    humidity: { acceptable: 14, safe: 13, insect_limit: 10, fungus_risk: 16 },
    temperature: {
      slow_fungus: 15,
      medium_growth_min: 20,
      medium_growth_max: 30,
      high_risk_min: 40,
      high_risk_max: 55
    }
  };

  // ---------------- Utils namespace ----------------
  g.Utils = g.Utils || {};

  // Helpers de domínio (sensores/alertas) — define só se não existir
  if (!g.Utils.getSensorDisplayName) {
    g.Utils.getSensorDisplayName = function getSensorDisplayName(sensorType) {
      switch (sensorType) {
        case "temperature": return "Temperatura";
        case "humidity":    return "Umidade";
        case "pressure":    return "Pressão Atmosférica";
        case "co2":         return "Gás CO2";
        default:            return sensorType;
      }
    };
  }

  if (!g.Utils.getSensorUnit) {
    g.Utils.getSensorUnit = function getSensorUnit(sensorType) {
      switch (sensorType) {
        case "temperature": return "°C";
        case "humidity":    return "%";
        case "pressure":    return "hPa";
        case "co2":         return "ppm";
        default:            return "";
      }
    };
  }

  if (!g.Utils.getSensorIcon) {
    g.Utils.getSensorIcon = function getSensorIcon(sensorType) {
      switch (sensorType) {
        case "temperature": return "fas fa-thermometer-half";
        case "humidity":    return "fas fa-tint";
        case "pressure":    return "fas fa-gauge-high";
        case "co2":         return "fas fa-smog";
        default:            return "fas fa-circle";
      }
    };
  }

  if (!g.Utils.getAlertLevel) {
    g.Utils.getAlertLevel = function getAlertLevel(sensorType, rawValue) {
      const v = (typeof rawValue === "number") ? rawValue : parseFloat(rawValue);
      if (!Number.isFinite(v)) return "normal";

      if (sensorType === "humidity") {
        if (v > g.SAFETY_PARAMETERS.humidity.fungus_risk) return "critical";
        if (v > g.SAFETY_PARAMETERS.humidity.acceptable)  return "warning";
        if (v > g.SAFETY_PARAMETERS.humidity.safe)        return "caution";
        return "normal";
      }

      if (sensorType === "temperature") {
        const T = g.SAFETY_PARAMETERS.temperature;
        if (v >= T.high_risk_min && v <= T.high_risk_max) return "critical";
        if (v >  T.high_risk_max)                         return "critical";
        if (v >= T.medium_growth_min && v <= T.medium_growth_max) return "warning";
        return "normal";
      }

      return "normal";
    };
  }

  // ---------------- Helpers de UI genéricos ----------------
  if (!g.Utils.formatDate) {
    g.Utils.formatDate = function formatDate(dateInput, options = {}) {
      try {
        const date = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
        const defaults = {
          year: "numeric", month: "long", day: "numeric",
          hour: "2-digit", minute: "2-digit", second: "2-digit"
        };
        return new Intl.DateTimeFormat("pt-BR", { ...defaults, ...options }).format(date);
      } catch {
        return String(dateInput);
      }
    };
  }

  if (!g.getNotificationIcon) {
    g.getNotificationIcon = function getNotificationIcon(type) {
      const icons = {
        success: "fas fa-check-circle",
        error:   "fas fa-exclamation-circle",
        warning: "fas fa-exclamation-triangle",
        info:    "fas fa-info-circle"
      };
      return icons[type] || icons.info;
    };
  }

  if (!g.showNotification) {
    g.showNotification = function showNotification(type, message) {
      const container = document.getElementById("notificationContainer");
      if (!container) return;
      const el = document.createElement("div");
      el.className = `notification ${type}`;
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;">
          <i class="${g.getNotificationIcon(type)}"></i>
          <span>${message}</span>
        </div>`;
      container.appendChild(el);
      setTimeout(() => el.remove(), g.NOTIFICATION_CONFIG.duration);
    };
  }

  // ---------------- Re-exporta no escopo global (idempotente) ----------------
  // (Se já existirem, permanecem as existentes)
  // Mantemos Utils com os métodos acima, e anexamos refs úteis:
  g.Utils.SAFETY_PARAMETERS = g.Utils.SAFETY_PARAMETERS || g.SAFETY_PARAMETERS;

})();
