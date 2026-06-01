const https = require('https');

const ODOO_URL = 'https://alba.capouilliez.edu.gt/jsonrpc';
const ODOO_BASE_URL = 'https://odoo-botly.skysize.io';
const ODOO_DB = process.env.ODOO_DB|| 'main-xv8crc';
const ODOO_UID = 2;
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

const PRODUCTO_ID = 3;
const CURRENCY_GTQ = 166;

// ===== CORE =====
function odooCall(model, method, args, kwargs = {}) {
  return new Promise((resolve) => {

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'object',
        method: 'execute_kw',
        args: [ODOO_DB, ODOO_UID, ODOO_PASSWORD, model, method, args, kwargs]
      },
      id: Date.now()
    });

    const url = new URL(ODOO_URL);

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {

      let body = '';

      res.on('data', chunk => body += chunk);

      res.on('end', () => {
        try {
          const json = JSON.parse(body);

          if (json.error) {
            console.error('❌ ODOO:', json.error.data?.message);
            return resolve(null);
          }

          resolve(json.result);

        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

// ===== HELPERS =====
function limpiarTelefono(tel) {
  return tel?.replace(/\D/g, '').slice(-12);
}

function detectarIntencion(texto) {
  const t = (texto || '').toLowerCase();

  return {
    interes: /cotiz|precio|propuesta|cu[aá]nto|servicio|bot/.test(t),
    compra: /comprar|contratar|plan/.test(t)
  };
}

// ===== TEAM =====
async function getTeam() {
  const res = await odooCall('crm.team', 'search_read',
    [[['name', '=', 'Botly Ventas']]],
    { fields: ['id'], limit: 1 }
  );

  if (res?.length) return res[0].id;

  const id = await odooCall('crm.team', 'create', [{
    name: 'Botly Ventas'
  }]);

  console.log('🆕 TEAM creado:', id);
  return id;
}

// ===== STAGE =====
async function getStage() {
  const res = await odooCall('crm.stage', 'search_read',
    [[['name', '=', 'Botly Nuevo']]],
    { fields: ['id'], limit: 1 }
  );

  if (res?.length) return res[0].id;

  const id = await odooCall('crm.stage', 'create', [{
    name: 'Botly Nuevo'
  }]);

  console.log('🆕 STAGE creado:', id);
  return id;
}

// ===== CLIENTE =====
async function getCliente(nombre, telefono) {
  const res = await odooCall('res.partner', 'search_read',
    [[['phone', '=', telefono]]],
    { fields: ['id'], limit: 1 }
  );

  if (res?.length) return res[0].id;

  const id = await odooCall('res.partner', 'create', [{
    name: nombre || telefono,
    phone: telefono
  }]);

  console.log('👤 Cliente creado:', id);
  return id;
}

// ===== COTIZACIÓN (FIX IMPORTANTE) =====
async function crearCotizacion(partnerId, leadId) {

  const existe = await odooCall('sale.order', 'search_read',
    [[['opportunity_id', '=', leadId]]],
    { fields: ['id'], limit: 1 }
  );

  // 🔥 SI YA EXISTE → DEVUELVE LINK
  if (existe?.length) {
    const orderId = existe[0].id;
    const link = `${ODOO_BASE_URL}/web#id=${orderId}&model=sale.order&view_type=form`;

    console.log('♻️ Reutilizando cotización:', link);
    return link;
  }

  // 🔥 CREAR NUEVA
  const orderId = await odooCall('sale.order', 'create', [{
    partner_id: partnerId,
    opportunity_id: leadId,
    currency_id: CURRENCY_GTQ
  }]);

  if (!orderId) {
    console.log('❌ Error creando cotización');
    return null;
  }

  await odooCall('sale.order.line', 'create', [{
    order_id: orderId,
    product_id: PRODUCTO_ID,
    product_uom_qty: 1
  }]);

  const link = `${ODOO_BASE_URL}/web#id=${orderId}&model=sale.order&view_type=form`;

  console.log('💰 COTIZACIÓN OK:', link);

  return link;
}

// ===== MAIN =====
async function procesarMensajeWhatsApp(telefono, nombre, mensaje) {

  const limpio = limpiarTelefono(telefono);
  if (!limpio) return null;

  const intent = detectarIntencion(mensaje);
  console.log('🎯 INTENCIONES:', intent);

  const teamId = await getTeam();
  const stageId = await getStage();

  let lead = await odooCall('crm.lead', 'search_read',
    [[['phone', '=', limpio]]],
    { fields: ['id'], limit: 1 }
  );

  let leadId = lead?.[0]?.id;

  if (!leadId) {

    leadId = await odooCall('crm.lead', 'create', [{
      name: `Lead - ${nombre}`,
      phone: limpio,
      type: 'opportunity',

      team_id: teamId,
      user_id: ODOO_UID,

      active: true,
      probability: 10,
      expected_revenue: 100,

      description: mensaje
    }]);

    console.log('🆕 Lead creado:', leadId);

    // 🔥 FORZAR VISIBILIDAD
    await odooCall('crm.lead', 'write', [[leadId], {
      stage_id: stageId
    }]);
  }

  console.log('📊 Lead FINAL:', { leadId, teamId, stageId });

  await odooCall('crm.lead', 'message_post', [[leadId]], {
    body: mensaje
  });

  let link = null;

  if (intent.interes || intent.compra) {
    const partnerId = await getCliente(nombre, limpio);
    link = await crearCotizacion(partnerId, leadId);
  }

  return { linkCotizacion: link };
}

module.exports = { procesarMensajeWhatsApp };
