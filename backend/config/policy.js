// backend/config/policy.js
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

module.exports = {
  humidity: {
    // soja
    safe:        num(process.env.SOY_HUM_OK_MAX,   13),
    acceptable:  num(process.env.SOY_HUM_ADM_MAX,  14),
    fungus_risk: num(process.env.SOY_HUM_CRIT_MIN, 16)
  },
  temperature: {
    // soja
    slow_fungus:       num(process.env.SOY_TEMP_OK_MAX,     15),
    medium_growth_min: num(process.env.SOY_TEMP_ALERT_MIN,  20),
    medium_growth_max: num(process.env.SOY_TEMP_CRIT_MIN,   30),
    high_risk_min:     num(process.env.SOY_TEMP_VHIGH_MIN,  40),
    high_risk_max:     num(process.env.SOY_TEMP_VHIGH_MAX,  55) // opcional
  }
};
