// backend/config/policy.js
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

module.exports = {
  // ===================================
  // 1. UMIDADE (Grão de Soja - %)
  // ===================================
  humidity: {
    // < 13% = Seguro / Ideal
    safe:          num(process.env.SOY_HUM_OK_MAX,   13),
    // <= 14% = Aceitável / Limite de Recepção
    acceptable:    num(process.env.SOY_HUM_ADM_MAX,  14),
    // > 16% = Risco Explosivo de Fungos
    fungus_risk:   num(process.env.SOY_HUM_CRIT_MIN, 16)
  },

  // ===================================
  // 2. TEMPERATURA (Grão de Soja - °C)
  // AJUSTADO CONFORME REGRAS DE RISCO
  // ===================================
  temperature: {
    // Ideal: Desenvolvimento Lento de Fungos (< 15°C)
    slow_fungus_max: num(process.env.SOY_TEMP_OK_MAX, 15),
    
    // Alerta/Warning: Desenvolvimento Médio de Fungos (20°C+)
    // Ajustado para o limite inferior da faixa de 20-30°C
    medium_growth_min: num(process.env.SOY_TEMP_ALERT_MIN, 20),
    
    // Crítico/Critical: Máximo desenvolvimento fúngico (40°C+)
    // Início da faixa crítica (40-55°C)
    max_fungus_min:  num(process.env.SOY_TEMP_CRIT_MIN, 40)
    
    // Nota: As variáveis high_risk_max e medium_growth_max foram removidas 
    // ou renomeadas para simplificar o controle no alertService.js, 
    // focando apenas nos limites de entrada dos riscos.
  },

  // ===================================
  // 3. CO₂ (Atividade Biológica - ppm)
  // NOVO PARÂMETRO PARA ALERTAS
  // ===================================
  co2: {
    // > 400 ppm: Acima do ar ambiente
    ambient_max: num(process.env.SOY_CO2_AMBIENT_MAX, 400),
    
    // 600–1.100 ppm: Deterioração Incipiente (Warning)
    deterioration_min: num(process.env.SOY_CO2_ALERT_MIN, 600),
    
    // > 1.100 ppm: Perdas Severas / Insetos (Critical)
    severe_loss_min: num(process.env.SOY_CO2_CRIT_MIN, 1100)
  }
};