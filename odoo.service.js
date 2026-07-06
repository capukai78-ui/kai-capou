const https = require('https');

const ODOO_DOMINIO  = process.env.ODOO_URL;
const ODOO_DB       = process.env.ODOO_DB;
const ODOO_USER     = process.env.ODOO_USER;
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

let _uid = null;

function jsonrpc(service, method, args) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0', method: 'call',
      params: { service, method, args },
      id: Date.now()
    });
    const req = https.request({
      hostname: ODOO_DOMINIO, path: '/jsonrpc', method: 'POST',
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

async function getUID() {
  if (_uid) return _uid;
  console.log('🔑 Autenticando en Odoo Capouilliez producción...');
  const uid = await jsonrpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_PASSWORD, {}]);
  if (!uid) { console.error('❌ Autenticación fallida'); return null; }
  _uid = uid;
  console.log(`✅ UID: ${uid}`);
  return uid;
}

async function odooRead(model, domain, fields, limit = 100, offset = 0) {
  const uid = await getUID();
  if (!uid) return null;
  return jsonrpc('object', 'execute_kw', [
    ODOO_DB, uid, ODOO_PASSWORD,
    model, 'search_read', [domain],
    { fields, limit, offset, order: 'create_date desc' }
  ]);
}

async function getLeads(limit = 100) {
  return odooRead('crm.lead',
    [['type','=','opportunity']],
    ['name','phone','email_from','stage_id','user_id','tag_ids',
     'create_date','date_closed','active','lost_reason_id','partner_name'],
    limit
  );
}

async function getLeadsPerdidos(limit = 100) {
  return odooRead('crm.lead',
    [['type','=','opportunity'],['active','=',false]],
    ['name','phone','stage_id','user_id','lost_reason_id','create_date','date_closed','tag_ids'],
    limit
  );
}

async function getStages() {
  // 'probability' removido de crm.stage en Odoo 16+
  return odooRead('crm.stage', [], ['id','name','sequence'], 100);
}

async function getTeams() {
  return odooRead('crm.team', [['active','=',true]], ['id','name'], 20);
}

async function getLostReasons() {
  return odooRead('crm.lost.reason', [], ['id','name'], 50);
}

async function getTags() {
  return odooRead('crm.tag', [], ['id','name'], 100);
}

async function getUsuarios() {
  return odooRead('res.users', [['active','=',true]], ['id','name','login'], 50);
}

async function testConexion() {
  console.log('🔄 Probando conexión con Odoo Capouilliez...');
  const info = await jsonrpc('common', 'version', []);
  if (info) { console.log(`✅ Odoo ${info.server_version} — ${ODOO_DOMINIO}`); return info; }
  return null;
}

async function procesarMensajeWhatsApp(telefono, nombre, mensaje) {
  console.log(`📱 [FASE 1] Tel: ${telefono} | Nombre: ${nombre}`);
  return null;
}

module.exports = {
  procesarMensajeWhatsApp, testConexion,
  getLeads, getLeadsPerdidos, getStages,
  getTeams, getLostReasons, getTags, getUsuarios
};
