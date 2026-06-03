const https = require('https');

// ===== CONFIGURACIÓN =====
const ODOO_DOMINIO  = process.env.ODOO_URL      || 'kintechgt-capouilliez-staging-2026-05-28-32806697.dev.odoo.com';
const ODOO_DB       = process.env.ODOO_DB       || 'kintechgt-capouilliez-staging-2026-05-28-32806697';
const ODOO_USER     = process.env.ODOO_USER     || 'admin';
const ODOO_PASSWORD = process.env.ODOO_PASSWORD || 'Pru3B4#2026';

let _uid = null;

// ===== JSON-RPC =====
function jsonrpc(service, method, args) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0', method: 'call',
      params: { service, method, args },
      id: Date.now()
    });

    const req = https.request({
      hostname: ODOO_DOMINIO,
      path: '/jsonrpc',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Host': ODOO_DOMINIO
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.error) { console.error('❌ ODOO:', r.error.data?.message); resolve(null); }
          else resolve(r.result);
        } catch(e) { resolve(null); }
      });
    });

    req.on('error', (e) => { console.error('❌ Error:', e.message); resolve(null); });
    req.write(payload);
    req.end();
  });
}

// ===== AUTENTICACIÓN =====
async function getUID() {
  if (_uid) return _uid;
  console.log('🔑 Autenticando en Odoo...');
  const uid = await jsonrpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_PASSWORD, {}]);
  if (!uid) { console.error('❌ Autenticación fallida'); return null; }
  _uid = uid;
  console.log(`✅ UID: ${uid}`);
  return uid;
}

// ===== EXECUTE_KW — SOLO LECTURA =====
async function odooRead(model, domain, fields, limit = 10) {
  const uid = await getUID();
  if (!uid) return null;
  return jsonrpc('object', 'execute_kw', [
    ODOO_DB, uid, ODOO_PASSWORD,
    model, 'search_read', [domain], { fields, limit }
  ]);
}

// ===== CONSULTAS DE SOLO LECTURA =====

async function getLeads(limit = 20) {
  return odooRead('crm.lead', [['type', '=', 'opportunity']], 
    ['name', 'phone', 'email_from', 'stage_id', 'team_id', 'probability', 'create_date'], 
    limit);
}

async function getStages() {
  return odooRead('crm.stage', [], ['id', 'name', 'sequence'], 50);
}

async function getTeams() {
  return odooRead('crm.team', [['active', '=', true]], ['id', 'name'], 20);
}

async function testConexion() {
  console.log('🔄 Probando conexión con Odoo...');
  const info = await jsonrpc('common', 'version', []);
  if (info) {
    console.log(`✅ Odoo ${info.server_version} conectado`);
    return info;
  }
  return null;
}

// ===== STUB — NO ESCRIBE NADA AÚN =====
async function procesarMensajeWhatsApp(telefono, nombre, mensaje) {
  console.log(`📱 [FASE 1 - Solo lectura] Tel: ${telefono} | Nombre: ${nombre}`);
  return null; // No escribe nada todavía
}

module.exports = { 
  procesarMensajeWhatsApp,
  testConexion,
  getLeads,
  getStages,
  getTeams
};
