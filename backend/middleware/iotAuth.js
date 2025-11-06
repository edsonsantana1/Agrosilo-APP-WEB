 // * Autenticação simples para dispositivos IoT via header x-api-key.
 // * Use SOMENTE para rotas públicas de ingestão/consulta de thresholds.
 // * Não mistura com JWT do usuário.
 
module.exports = function iotAuth(req, res, next) {
  const token = req.header('x-api-key');
  const expected = process.env.IOT_INGEST_TOKEN;

  if (!expected) {
    return res.status(500).json({ error: 'IOT_INGEST_TOKEN não configurado no .env' });
  }
  if (!token || token !== expected) {
    return res.status(401).json({ error: 'x-api-key inválido' });
  }
  next();
};
