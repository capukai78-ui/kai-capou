const express = require('express');
const { procesarMensajeWhatsApp, testConexion, getLeads, getLeadsPerdidos, getStages, getTeams, getLostReasons, getTags, getUsuarios } = require('./odoo.service');
const mongoose = require('mongoose');
const https = require('https');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('❌ FATAL: JWT_SECRET no está configurado en las variables de entorno'); process.exit(1); }

// ===== SEGURIDAD =====
// CORS — solo acepta peticiones del panel y del webhook de Meta
const origenesPermitidos = [
  'https://kai-capouilliez.up.railway.app',
  'https://www.capouilliez.edu.gt',
  /\.railway\.app$/
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // peticiones server-to-server (webhook Meta, Odoo)
    const ok = origenesPermitidos.some(o => typeof o === 'string' ? o === origin : o.test(origin));
    ok ? cb(null, true) : cb(new Error('CORS bloqueado: origen no permitido'));
  },
  credentials: true
}));

// Rate limiting manual — máximo 60 peticiones por minuto por IP para el API
const _rateMap = new Map();
app.use('/api/', (req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const ahora = Date.now();
  const ventana = 60 * 1000; // 1 minuto
  const limite = 120; // 120 req/min por IP
  const entry = _rateMap.get(ip) || { count: 0, inicio: ahora };
  if (ahora - entry.inicio > ventana) { entry.count = 1; entry.inicio = ahora; }
  else entry.count++;
  _rateMap.set(ip, entry);
  if (entry.count > limite) return res.status(429).json({ ok: false, error: 'Demasiadas peticiones. Intenta en un momento.' });
  next();
});

// Headers de seguridad básicos (sin helmet, usando solo lo necesario)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));

app.use((req, res, next) => {
  console.log('🌐 Request:', req.method, req.url);
  next();
});

// ===== MONGODB =====
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB conectado ✓'))
  .catch(err => console.log('Error MongoDB:', err));

// ===== SCHEMAS =====
const tenantSchema = new mongoose.Schema({
  nombre: String,
  numero_whatsapp: String,
  activo: { type: Boolean, default: true },
  odoo_team_id: { type: Number, default: 1 },
  config: {
    bienvenida: String,
    sedes: [{ nombre: String, direccion: String, telefono: String, horario: String }],
    menu: [{ opcion: String, respuesta: String }]
  },
  plan: { type: String, default: 'basico', enum: ['basico', 'profesional', 'empresarial'] },
  creado: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
  nombre: String,
  email: { type: String, unique: true },
  password: String,
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  rol: { type: String, default: 'cliente' },
  creado: { type: Date, default: Date.now }
});

const messageLogSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  from: String,
  message: String,
  response: String,
  canal: { type: String, default: 'whatsapp' }, // canal de origen para trazabilidad
  procesado: { type: Boolean, default: true },   // false = llegó pero falló el proceso
  error: { type: String, default: null },        // si procesado=false, aquí está el motivo
  fecha: { type: Date, default: Date.now }
});

const leadSchema = new mongoose.Schema({
  nombre: String,
  negocio: String,
  interes: String,
  telefono: String,
  fecha: { type: Date, default: Date.now }
});

const faqSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  pregunta: String,
  respuesta: String,
  categoria: { type: String, default: 'general' },
  activo: { type: Boolean, default: true },
  creado: { type: Date, default: Date.now }
});

const documentoSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  nombre: String,
  tipo: { type: String, enum: ['info_general','cuotas','admision','programas','faq','restricciones','comunicacion','imagen','general'], default: 'general' },
  contenido: String,
  activo: { type: Boolean, default: true },
  creado: { type: Date, default: Date.now }
});

// ===== MODELO IMAGEN MARKETING — fotos reales para enviar por WhatsApp =====
const imagenMarketingSchema = new mongoose.Schema({
  tenant_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  nombre:      { type: String, required: true }, // ej: "Fachada principal", "Laboratorio de ciencias"
  categoria:   { type: String, enum: ['cuotas','admision','programas','info_general','academia_aha','instalaciones','aulas','deportes','eventos','open_house','graduacion','general'], default: 'general' },
  nivel_educativo: { type: String, enum: ['Jardín','Preprimaria','Kínder','Primaria','Básico','Secundaria','Bachillerato','Todos'], default: 'Todos' },
  imagen_base64: { type: String, required: true }, // imagen codificada, se sube vía panel
  mime_type:   { type: String, default: 'image/jpeg' },
  subida_por:  { type: mongoose.Schema.Types.ObjectId, ref: 'UsuarioPanel' },
  subida_por_nombre: { type: String },
  activo:      { type: Boolean, default: true },
  caption:      { type: String, default: '' }, // texto predefinido para enviar con la imagen
  veces_enviada: { type: Number, default: 0 },
  creado:      { type: Date, default: Date.now }
});
const ImagenMarketing = mongoose.model('ImagenMarketing', imagenMarketingSchema);

const leadDetalladoSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  nombre: String,
  telefono: String,
  correo: String,
  grado_interes: String,
  zona: String,
  colegio_actual: String,
  nombre_alumno: String,
  edad_alumno: String,
  estado: { type: String, enum: ['nuevo', 'contactado', 'visita_agendada', 'inscrito', 'perdido'], default: 'nuevo' },
  quiere_visita: { type: Boolean, default: false },
  quiere_open_house: { type: Boolean, default: false },
  origen: { type: String, default: 'whatsapp' },
  notas: String,
  fecha: { type: Date, default: Date.now },
  ultima_interaccion: { type: Date, default: Date.now }
});

// ===== SCHEMA SEDES =====
const sedeSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  nombre:    String,
  direccion: String,
  telefono:  String,
  activa:    { type: Boolean, default: true },
  creado:    { type: Date, default: Date.now }
});

// ===== SCHEMA USUARIO PANEL (roles por cliente) =====
const usuarioPanelSchema = new mongoose.Schema({
  nombre:    String,
  email:     { type: String, unique: true },
  password:  String,
  role:      { type: String, enum: ['admin', 'vendedor', 'viewer'], default: 'vendedor' },
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  sedes:     [String],  // nombres de sedes asignadas, o ['todas']
  activo:    { type: Boolean, default: true },
  disponible: { type: Boolean, default: true }, // si puede recibir chats en vivo asignados
  disponible_manual: { type: Boolean, default: false }, // true si el agente lo apagó a propósito (no reactivar automático)
  ultima_actividad: { type: Date, default: Date.now }, // última vez que usó el panel — para auto-disponibilidad
  lastLogin: Date,
  creado:    { type: Date, default: Date.now }
});

// ===== MODELO CONVERSACIÓN — para handoff a humano =====
const conversacionSchema = new mongoose.Schema({
  tenant_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  numero:        { type: String, required: true },
  nombre:        String,
  canal:         { type: String, enum: ['whatsapp','instagram','messenger','otro'], default: 'whatsapp' },
  estado:        { type: String, enum: ['bot', 'esperando_agente', 'humano', 'cerrado'], default: 'bot' },
  agente_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'UsuarioPanel', default: null },
  agente_nombre: { type: String, default: null },
  motivo:        { type: String, default: null },
  resumen_kai:   { type: String, default: null },
  resumen_agente:{ type: String, default: null },
  mensajes:      [{
    de:     { type: String, enum: ['padre', 'bot', 'agente'] },
    texto:  String,
    fecha:  { type: Date, default: Date.now }
  }],
  ultimaActividad: { type: Date, default: Date.now },
  creado:        { type: Date, default: Date.now }
});
const Conversacion = mongoose.model('Conversacion', conversacionSchema);

// ===== MODELO CONTACTO — memoria persistente del padre/madre =====
const contactoSchema = new mongoose.Schema({
  tenant_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  numero:         { type: String, required: true },
  nombre:         { type: String, default: null },
  nombre_alumno:  { type: String, default: null },
  nivel_interes:  { type: String, default: null }, // Preprimaria/Primaria/Básico/Bachillerato
  fecha_nacimiento_alumno: { type: String, default: null },
  zona:           { type: String, default: null },
  colegio_actual: { type: String, default: null },
  correo:         { type: String, default: null },
  resumen_ultimo_contacto: { type: String, default: null }, // qué se habló la última vez
  odoo_lead_id:   { type: Number, default: null }, // si ya se creó como candidato en Odoo
  nivel_calor:    { type: Number, default: null }, // 1=Alta Intención, 2=Interesado, 3=Exploratorio
  nivel_calor_etiqueta: { type: String, default: null }, // texto de la etiqueta aplicada en Odoo
  canal_origen:   { type: String, enum: ['whatsapp','instagram','messenger','lead_ads','formulario','otro'], default: 'whatsapp' },
  total_conversaciones: { type: Number, default: 0 },

  // ===== MARKETING Y REACTIVACIÓN =====
  acepta_marketing: { type: Boolean, default: null }, // null = no se le ha preguntado aún
  acepta_marketing_fecha: { type: Date, default: null },
  segmento_reactivacion: { type: String, enum: ['activo', 'seguimiento', 'reactivacion', 'frio'], default: 'activo' },
  ultima_campana_enviada: { type: Date, default: null },
  campanas_recibidas: { type: Number, default: 0 },

  primer_contacto: { type: Date, default: Date.now },
  ultimo_contacto: { type: Date, default: Date.now }
}, { timestamps: true });
contactoSchema.index({ tenant_id: 1, numero: 1 }, { unique: true });
const Contacto = mongoose.model('Contacto', contactoSchema);

const Tenant        = mongoose.model('Tenant', tenantSchema);
const User          = mongoose.model('User', userSchema);
const MessageLog    = mongoose.model('MessageLog', messageLogSchema);
const Lead          = mongoose.model('Lead', leadSchema);
const FAQ           = mongoose.model('FAQ', faqSchema);
const Documento     = mongoose.model('Documento', documentoSchema);
const LeadDetallado = mongoose.model('LeadDetallado', leadDetalladoSchema);
const Sede          = mongoose.model('Sede', sedeSchema);
const UsuarioPanel  = mongoose.model('UsuarioPanel', usuarioPanelSchema);

// ===== MODELO CITA =====
const citaSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  nombre:    { type: String, required: true },
  telefono:  { type: String },
  grado:     { type: String },
  sede:      { type: String, default: 'Sede Central' },
  fecha:     { type: String },
  hora:      { type: String, default: '09:00 AM' },
  tipo:      { type: String, default: 'open_house' },
  estado:    { type: String, enum: ['confirmada','pendiente','cancelada'], default: 'confirmada' },
  creado:    { type: Date, default: Date.now }
});
const Cita = mongoose.model('Cita', citaSchema);

// ===== MIDDLEWARE AUTH =====
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    // Actualizar última actividad del agente (fire-and-forget, no bloquea la respuesta).
    // Si estaba apagado por inactividad automática (no manual), se reactiva al volver al panel.
    UsuarioPanel.findOne({ _id: decoded.id }).then(u => {
      if (!u) return;
      const update = { ultima_actividad: new Date() };
      if (!u.disponible && !u.disponible_manual && ['vendedor','admin'].includes(u.role)) {
        update.disponible = true; // se reactiva solo porque el apagado fue automático, no manual
      }
      UsuarioPanel.findByIdAndUpdate(decoded.id, update).exec();
    }).catch(()=>{});
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Verificador de inactividad — marca como no disponibles a agentes que no han usado el panel en 5 min
const MINUTOS_INACTIVIDAD_AGENTE = 5;
setInterval(async () => {
  try {
    const limite = new Date(Date.now() - MINUTOS_INACTIVIDAD_AGENTE * 60 * 1000);
    const resultado = await UsuarioPanel.updateMany(
      { role: { $in: ['vendedor', 'admin'] }, disponible: true, disponible_manual: false, ultima_actividad: { $lt: limite } },
      { disponible: false }
    );
    if (resultado.modifiedCount > 0) {
      console.log(`⏸️  ${resultado.modifiedCount} agente(s) marcados como no disponibles por inactividad (>${MINUTOS_INACTIVIDAD_AGENTE} min)`);
    }
  } catch (e) { console.error('❌ Error verificando inactividad de agentes:', e.message); }
}, 60 * 1000); // revisa cada minuto

// =============================================
// ===== SISTEMA DE LÍMITES POR PLAN =====
// =============================================

const PLANES = {
  basico:       { nombre: 'Plan Básico',       mensajes_mes: 500,   precio_q: 1200, max_usuarios: 3  },
  profesional:  { nombre: 'Plan Profesional',  mensajes_mes: 2000,  precio_q: 2000, max_usuarios: 5  },
  empresarial:  { nombre: 'Plan Empresarial',  mensajes_mes: 10000, precio_q: 4500, max_usuarios: 15 }
};

async function verificarLimite(tenantId, planNombre) {
  const plan = PLANES[planNombre] || PLANES.basico;
  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);
  const usadoMes = await MessageLog.countDocuments({ tenant_id: tenantId, fecha: { $gte: inicioMes } });
  const limite = plan.mensajes_mes;
  return {
    usadoMes, limite,
    restante: limite - usadoMes,
    porcentaje: Math.round((usadoMes / limite) * 100),
    agotado: usadoMes >= limite,
    plan
  };
}

async function notificarAdminSiNecesario(tenant, limite_info) {
  const { usadoMes, limite, porcentaje } = limite_info;
  if (porcentaje >= 90 && porcentaje < 95) {
    const msg = `⚠️ BOTLY ALERTA: "${tenant.nombre}" llegó al ${porcentaje}% de su plan.\n` +
      `Usó ${usadoMes}/${limite} mensajes este mes.\nPlan: ${PLANES[tenant.plan]?.nombre || tenant.plan}\n💡 Oportunidad de ofrecerles upgrade.`;
    const ownerNumber = process.env.OWNER_WHATSAPP;
    if (ownerNumber) await enviarWhatsAppDirecto(ownerNumber, msg).catch(() => {});
  }
}

function enviarWhatsAppDirecto(numero, mensaje) {
  return new Promise((resolve, reject) => {
    const accountSid = process.env.TWILIO_SID;
    const authToken  = process.env.TWILIO_TOKEN;
    const postData   = new URLSearchParams({ From: 'whatsapp:+14155238886', To: `whatsapp:${numero}`, Body: mensaje }).toString();
    const options = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64') }
    };
    const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(postData); req.end();
  });
}

const conversaciones = new Map();
const MAX_CONVERSACIONES = 5000;
const TIMEOUT_INACTIVIDAD_MS = 3 * 60 * 60 * 1000; // 3 horas

// Limpieza periódica de conversaciones viejas
setInterval(() => {
  const ahora = Date.now();
  for (const [key, val] of conversaciones.entries()) {
    if (ahora - (val.ultimaActividad || 0) > 2 * 60 * 60 * 1000 * 3) conversaciones.delete(key);
  }
  if (conversaciones.size > MAX_CONVERSACIONES) {
    const entries = [...conversaciones.entries()].sort((a,b) => (a[1].ultimaActividad||0)-(b[1].ultimaActividad||0));
    entries.slice(0, conversaciones.size - MAX_CONVERSACIONES).forEach(([k]) => conversaciones.delete(k));
  }
}, 60 * 60 * 1000);

function llamarClaude(systemPrompt, messages, maxTokens = 400) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, system: systemPrompt, messages });
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(postData) }
    };
    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => { try { resolve(JSON.parse(data).content?.[0]?.text || null); } catch(e) { resolve(null); } });
    });
    apiReq.on('error', () => resolve(null)); apiReq.write(postData); apiReq.end();
  });
}

function detectarIndustria(nombreTenant, bienvenida) {
  const texto = (nombreTenant + ' ' + (bienvenida || '')).toLowerCase();
  if (texto.includes('colegio') || texto.includes('escuela') || texto.includes('admision') || texto.includes('alumno')) return 'colegio';
  if (texto.includes('clinic') || texto.includes('doctor') || texto.includes('medic')) return 'clinica';
  if (texto.includes('farmacia')) return 'farmacia';
  if (texto.includes('restaurante') || texto.includes('comida')) return 'restaurante';
  return 'general';
}

function buildSystemPrompt(tenant) {
  const industria = detectarIndustria(tenant.nombre, tenant.config?.bienvenida);
  const base = `Eres el asistente virtual oficial de "${tenant.nombre}", una institución de prestigio en Guatemala.\n\nSOBRE ESTE NEGOCIO:\n${tenant.config?.bienvenida || ''}\n\nSERVICIOS:\n${(tenant.config?.menu || []).map(m => `▸ ${m.opcion}: ${m.respuesta}`).join('\n')}\n\nUBICACIONES:\n${(tenant.config?.sedes || []).map(s => `📍 ${s.nombre}: ${s.direccion} | Tel: ${s.telefono} | Horario: ${s.horario}`).join('\n')}`;
  const instruccionesColegio = `\nERES: Kai, asistente virtual de admisiones. Cálido, profesional, orientado a resultados.\nMISIÓN: Convertir cada conversación en una visita o inscripción.\n\nFLUJO INICIAL:\n1) Saluda y pregunta el nivel ofreciendo un menú numerado:\n   "¿En qué nivel está interesado? Marca el número:\n   1. Preprimaria\n   2. Primaria\n   3. Básico\n   4. Bachillerato en Ciencias y Letras"\n2) Si elige Preprimaria (1): solicita la fecha de nacimiento del niño/a y, con esa fecha, comparte la tabla de edades para confirmar el grado exacto que le corresponde.\n3) Explica beneficios relevantes al nivel elegido.\n4) Captura: nombre del padre/madre, nombre del alumno, grado, zona, colegio actual, correo.\n5) Ofrece agendar una visita o invita al próximo Open House (sin mencionar que es "el primer sábado de cada mes" — la fecha puede variar, siempre confirma la fecha exacta vigente).\n6) Una sola vez por conversación, después de tener el correo o nombre del alumno, pregunta de forma natural y breve si desea recibir noticias del colegio (ej: "¿Te gustaría que te avisemos de nuestro próximo Open House y noticias del colegio? 📩"). Respeta la respuesta — si dice que no, no insistas ni lo vuelvas a preguntar en esta conversación.\n\nCONTACTO Y ASESORES — MUY IMPORTANTE:\n- Tu prioridad es avanzar la conversación hacia la visita/inscripción TÚ MISMO. NO ofrezcas pasar con un asesor como primera opción ni como salida fácil para dudas generales.\n- Solo sugiere hablar con un asesor humano DESPUÉS de haber intentado avanzar el proceso, o cuando el padre necesita algo que tú no puedes resolver (pregunta muy específica, quiere negociar, pide hablar con alguien directamente).\n- CUANDO EL PADRE MUESTRE INTERÉS REAL DE AGENDAR UNA VISITA, OPEN HOUSE, O INSCRIBIR (ej: "quiero agendar", "sí, quiero la visita", "cómo inscribo", "quiero inscribirlo"): NO le des el número de PBX/WhatsApp como si tuviera que llamar él mismo. En su lugar dile que con gusto lo conecta directamente AHORA con un asesor que le ayudará a coordinar todo, y pregúntale si desea que lo transfieras (ej: "¡Perfecto! Te conecto ahora mismo con un asesor que te ayudará a coordinar la visita y confirmar la fecha. ¿Te parece?"). El sistema detecta esto automáticamente y transfiere la conversación.\n- Los números de PBX 2429-1999 y 2429-1908 son SOLO para si el padre prefiere llamar por su cuenta fuera de WhatsApp, no los ofrezcas como la opción principal cuando ya estás conversando con él aquí mismo.\n- NUNCA uses la palabra "mientras tanto" — está prohibida, suena repetitiva. Usa alternativas naturales o reformula sin esa frase.\n\nFORMATO DE RESPUESTA:\n- NUNCA uses asteriscos (**texto**) para negritas ni ningún otro formato de markdown. WhatsApp no lo necesita y se ve mal. Escribe en texto plano natural.\n- No uses guiones para listas si la respuesta es corta — prefiere texto fluido y conversacional.\n\nINACTIVIDAD:\n- Si la conversación lleva más de 3 horas sin actividad ni respuesta del padre, antes de cerrar pregúntale si desea comunicarse con un asesor.\n- Si no responde, informa que se terminará la comunicación por inactividad pero que sigues a las órdenes y que pueden volver a escribir cuando quieran.\n\nLEDS (Liderazgo, Expresión, Deportes y Salud):\n- Alumnos de Primaria y Secundaria reciben 1 vez a la semana un período doble de actividades extracurriculares dentro del horario escolar, sin costo adicional.\n- Actividades disponibles: Fútbol, Baloncesto, Tenis de Mesa, Natación, Artes Visuales, Marimba, Teatro Musical.\n- Los alumnos son quienes eligen a qué actividad inscribirse, y participan en ella durante todo el ciclo escolar (la oferta puede variar cada año).\n\nREGLAS GENERALES:\nResponde de forma natural y cálida como WhatsApp, no como un correo. Si preguntan precios da solo el dato específico que pidieron. Nunca des listas largas ni tablas completas — si quieren más info ellos preguntan. Español guatemalteco. NUNCA inventes datos. NUNCA menciones Claude.`;
  const instruccionesGeneral = `\nINSTRUCCIONES: Responde en español guatemalteco natural. Máximo 4 líneas. Usa emojis con moderación. NUNCA inventes precios. Eres cálido y profesional.`;
  return base + (industria === 'colegio' ? instruccionesColegio : instruccionesGeneral);
}


function buildDocsContext(docs) {
  if (!docs || !docs.length) return '';
  let ctx = '';
  const porCat = { restricciones:[], admision:[], cuotas:[], programas:[], info_general:[], faq:[], comunicacion:[], imagen:[], general:[] };
  docs.forEach(d => { const c = porCat[d.tipo] !== undefined ? d.tipo : 'general'; porCat[c].push(d); });
  if (porCat.restricciones.length)
    ctx += '\n\n⚠️ REGLAS Y RESTRICCIONES (seguir siempre, tienen prioridad):\n' + porCat.restricciones.map(d => d.contenido.substring(0, 4000)).join('\n');
  const orden = ['admision','cuotas','programas','info_general','faq','comunicacion','general'];
  orden.forEach(cat => {
    if (porCat[cat].length)
      ctx += `\n\n=== ${cat.toUpperCase().replace('_',' ')} ===\n` + porCat[cat].map(d => `[${d.nombre}]\n${d.contenido.substring(0, 3000)}`).join('\n\n');
  });
  return ctx;
}
// ===== HANDOFF A HUMANO =====

// Frases que detectan intención de hablar con un agente humano
function detectaSolicitudAgente(texto) {
  const t = (texto || '').toLowerCase();
  return /asesor|agente|persona real|hablar con (alguien|un humano)|atenci[oó]n humana|hablar con alguien/.test(t);
}

// Frases de insistencia — el padre quiere humano YA, sin importar el contexto
function detectaInsistenciaAgente(texto) {
  const t = (texto || '').toLowerCase();
  return /solo (quiero|necesito) (hablar|que me atienda)|no (quiero|m[aá]s) (bot|robot)|ya (te|le) dije que quiero (un asesor|hablar con alguien)|comun[ií]queme con|p[aá]seme con/.test(t);
}

// Busca un agente disponible (round-robin simple: el que tenga menos chats activos)
async function asignarAgenteLibre(tenantId) {
  const agentes = await UsuarioPanel.find({
    tenant_id: tenantId,
    role: { $in: ['vendedor', 'admin'] },
    activo: true,
    disponible: true
  });
  if (!agentes.length) return null;

  // Contar chats activos por agente
  const counts = await Conversacion.aggregate([
    { $match: { tenant_id: tenantId, estado: 'humano', agente_id: { $ne: null } } },
    { $group: { _id: '$agente_id', total: { $sum: 1 } } }
  ]);
  const countMap = {};
  counts.forEach(c => countMap[c._id.toString()] = c.total);

  // Elegir el agente con menos chats activos
  agentes.sort((a, b) => (countMap[a._id.toString()] || 0) - (countMap[b._id.toString()] || 0));
  return agentes[0];
}

// Pasa una conversación a estado "esperando_agente" y le asigna uno si hay disponible
// Genera un resumen breve usando IA del historial de conversación con KAI
async function generarResumenParaAgente(numeroOrigen) {
  const conv = conversaciones.get(numeroOrigen);
  const historial = conv?.historial || [];
  if (!historial.length) return 'El padre/madre acaba de iniciar la conversación, aún no ha compartido información.';

  const textoConversacion = historial.map(m => `${m.role === 'user' ? 'Padre' : 'KAI'}: ${m.content}`).join('\n');
  const promptResumen = `Resume en máximo 3 líneas, en texto plano sin asteriscos, lo que este padre/madre ya preguntó o compartió en la conversación con KAI, para que un asesor humano pueda continuar sin repetir preguntas. Incluye nombre del alumno/nivel si se mencionó, y cuál fue la última duda sin resolver. Conversación:\n\n${textoConversacion}`;

  const resumen = await llamarClaude('Eres un asistente que resume conversaciones de atención al cliente de forma breve y útil.', [{ role: 'user', content: promptResumen }], 200);
  return resumen || 'No se pudo generar resumen automático. Revisa el historial completo del chat.';
}

// Genera un resumen breve usando IA del historial de mensajes con el agente humano
async function generarResumenParaKai(conv) {
  const mensajesAgente = (conv.mensajes || []).filter(m => m.de === 'agente' || m.de === 'padre');
  if (!mensajesAgente.length) return null;

  const textoConversacion = mensajesAgente.map(m => `${m.de === 'padre' ? 'Padre' : 'Asesor'}: ${m.texto}`).join('\n');
  const promptResumen = `Resume en máximo 3 líneas, en texto plano sin asteriscos, lo que ocurrió en esta conversación entre un asesor humano y un padre de familia, para que el asistente KAI pueda retomar la conversación sin repetir lo ya resuelto. Conversación:\n\n${textoConversacion}`;

  const resumen = await llamarClaude('Eres un asistente que resume conversaciones de atención al cliente de forma breve y útil.', [{ role: 'user', content: promptResumen }], 200);
  return resumen || null;
}

async function iniciarHandoff(tenant, numero, nombre, motivoMsg) {
  let conv = await Conversacion.findOne({ tenant_id: tenant._id, numero, estado: { $ne: 'cerrado' } });
  if (!conv) {
    conv = await Conversacion.create({ tenant_id: tenant._id, numero, nombre, estado: 'esperando_agente', motivo: motivoMsg });
  } else {
    conv.estado = 'esperando_agente';
    conv.motivo = motivoMsg;
    conv.ultimaActividad = new Date();
  }

  // Generar resumen de KAI para que el agente vea contexto al entrar
  conv.resumen_kai = await generarResumenParaAgente(numero);

  const agente = await asignarAgenteLibre(tenant._id);
  if (agente) {
    conv.estado = 'humano';
    conv.agente_id = agente._id;
    conv.agente_nombre = agente.nombre;
  }
  await conv.save();
  return { conv, agente };
}

// Frases que indican interés real de avanzar el proceso (no solo curiosidad)
// ===== SISTEMA DE 3 NIVELES DE CALOR DEL LEAD =====
// Nivel 1 — 🔴 Alta Intención: el padre quiere actuar YA (inscribir, agendar, confirmar)
// Nivel 2 — 🟡 Interesado: ya dio datos del alumno y preguntó cuotas/proceso, pero no pidió agendar
// Nivel 3 — ⚪ Exploratorio: solo hizo preguntas generales sin comprometerse a nada
//
// Esta función reemplaza al antiguo detector binario "detectaInteresReal".
// Devuelve { nivel: 1|2|3, etiqueta: string } o null si no hay suficiente señal todavía.
// Detector independiente de Nivel 1 (Alta Intención) — usado para decidir el handoff inmediato,
// sin necesitar el objeto Contacto completo (se evalúa antes de tenerlo actualizado).
function esAltaIntencion(texto, ultimoMensajeBot) {
  const t = (texto || '').toLowerCase().trim();
  const fraseAltaIntencion = /(quiero|quisiera|deseo|me gustar[ií]a|necesito|estoy interesad[oa] en|me interesa)\s+(inscribir|agendar|una visita|el open house|que mi hijo|que mi hija|que (mi|el|la)\s*\w+\s*(estudie|entre|vaya))|c[oó]mo (inscribo|agendo|hago para inscribir)|quiero inscribirlo|quiero inscribirla|aparta(me)? (un cupo|lugar)|inscribir(lo|la)?\s*(a mi hijo|a mi hija)?$/.test(t);
  const esAfirmacionSimple = /^(s[ií]|s[ií] por favor|s[ií] claro|claro|dale|ok|okay|de acuerdo|perfecto|me parece bien|s[ií] me interesa|correcto|exacto|as[ií] es)\.?!?$/.test(t);
  const botPreguntoAgendar = /agendar|visita|asesor|coordinar|conectar(te)? con un asesor/.test((ultimoMensajeBot || '').toLowerCase());
  return fraseAltaIntencion || (esAfirmacionSimple && botPreguntoAgendar);
}

function calcularNivelInteres(texto, ultimoMensajeBot, contacto) {
  const t = (texto || '').toLowerCase().trim();

  // ---- NIVEL 1 — ALTA INTENCIÓN ----
  const fraseAltaIntencion = /(quiero|quisiera|deseo|me gustar[ií]a|necesito|estoy interesad[oa] en|me interesa)\s+(inscribir|agendar|una visita|el open house|que mi hijo|que mi hija|que (mi|el|la)\s*\w+\s*(estudie|entre|vaya))|c[oó]mo (inscribo|agendo|hago para inscribir)|quiero inscribirlo|quiero inscribirla|aparta(me)? (un cupo|lugar)|inscribir(lo|la)?\s*(a mi hijo|a mi hija)?$/.test(t);

  const esAfirmacionSimple = /^(s[ií]|s[ií] por favor|s[ií] claro|claro|dale|ok|okay|de acuerdo|perfecto|me parece bien|s[ií] me interesa|correcto|exacto|as[ií] es)\.?!?$/.test(t);
  const botPreguntoAgendar = /agendar|visita|asesor|coordinar|conectar(te)? con un asesor/.test((ultimoMensajeBot || '').toLowerCase());
  const confirmacionAgendar = esAfirmacionSimple && botPreguntoAgendar;

  if (fraseAltaIntencion || confirmacionAgendar) {
    return { nivel: 1, etiqueta: 'KAI — Alta Intención' };
  }

  // ---- NIVEL 2 — INTERESADO ----
  // Ya tiene datos clave del alumno capturados (nombre del alumno + nivel educativo)
  // y preguntó sobre cuotas, requisitos o proceso de admisión — señal de interés serio sin urgencia de agendar.
  const preguntoProcesoOcuotas = /cuota|colegiatura|precio|costo|requisito|inscripci[oó]n|proceso de admisi[oó]n|c[oó]mo es el proceso/.test(t);
  const tieneDatosClave = !!(contacto?.nombre_alumno && contacto?.nivel_interes);

  if (tieneDatosClave && preguntoProcesoOcuotas) {
    return { nivel: 2, etiqueta: 'KAI — Interesado' };
  }
  // También cuenta como Nivel 2 si ya tiene nombre del alumno + nivel, aunque la pregunta actual sea otra cosa —
  // refleja que ya pasó el filtro inicial de solo curiosear.
  if (tieneDatosClave) {
    return { nivel: 2, etiqueta: 'KAI — Interesado' };
  }

  // ---- NIVEL 3 — EXPLORATORIO ----
  // Si ya dio AL MENOS el nivel educativo de interés, cuenta como lead exploratorio (no solo curiosidad anónima).
  if (contacto?.nivel_interes) {
    return { nivel: 3, etiqueta: 'KAI — Exploratorio' };
  }

  return null; // Aún no hay suficiente señal para clasificar — no crear nada todavía
}

// Extrae datos del padre/alumno del historial usando IA, actualiza Contacto, y crea lead en Odoo si hay interés real
async function actualizarContactoYDetectarInteres(tenant, numero, mensajeUsuario, respuestaBot, historial, contactoExistente) {
  // 1. Extraer datos estructurados con IA (nombre, alumno, nivel, zona, colegio, correo, consentimiento marketing)
  const textoConversacion = historial.map(m => `${m.role === 'user' ? 'Padre' : 'KAI'}: ${m.content}`).join('\n');
  const promptExtraccion = `De esta conversación de WhatsApp entre un padre/madre y un asistente de admisiones escolar, extrae SOLO estos datos si están presentes (responde ÚNICAMENTE un JSON válido, sin texto adicional, sin markdown):
{"nombre":"nombre del padre/madre o null","nombre_alumno":"nombre del hijo/a o null","nivel_interes":"Preprimaria/Primaria/Básico/Bachillerato o null","fecha_nacimiento_alumno":"fecha si la dio o null","zona":"zona o null","colegio_actual":"colegio actual o null","correo":"correo o null","acepta_marketing":"true si el padre aceptó recibir noticias/promociones del colegio, false si lo rechazó explícitamente, o null si no se le ha preguntado o no respondió claro"}

Conversación:
${textoConversacion}`;

  let datosExtraidos = {};
  try {
    const respuestaIA = await llamarClaude('Extraes datos estructurados de conversaciones. Respondes solo JSON válido.', [{ role: 'user', content: promptExtraccion }], 300);
    if (respuestaIA) {
      const jsonLimpio = respuestaIA.replace(/```json|```/g, '').trim();
      datosExtraidos = JSON.parse(jsonLimpio);
    }
  } catch (e) { console.warn('⚠️ No se pudo extraer datos del contacto:', e.message); }

  // 2. Actualizar o crear el Contacto en MongoDB (memoria persistente)
  const update = { ultimo_contacto: new Date(), $inc: { total_conversaciones: contactoExistente ? 0 : 1 } };
  const setFields = {};
  Object.keys(datosExtraidos).forEach(k => {
    const valor = datosExtraidos[k];
    if (valor === null || valor === 'null' || valor === undefined) return;
    if (k === 'acepta_marketing') {
      // Solo registrar el consentimiento si aún no se había guardado uno (no sobrescribir un "no" con ambigüedad futura)
      if (contactoExistente?.acepta_marketing === null || contactoExistente?.acepta_marketing === undefined) {
        setFields.acepta_marketing = (valor === true || valor === 'true');
        setFields.acepta_marketing_fecha = new Date();
      }
      return;
    }
    setFields[k] = valor;
  });
  if (Object.keys(setFields).length) update.$set = setFields;
  if (!update.$set) update.$set = {};
  // Generar resumen corto de en qué quedó la conversación
  try {
    const resumenCorto = await llamarClaude('Resumes en una sola frase corta (máximo 15 palabras) en qué quedó una conversación de atención al cliente.', [{ role: 'user', content: `Última pregunta del padre: "${mensajeUsuario}". Última respuesta de KAI: "${respuestaBot}". Resume en una frase qué se habló.` }], 60);
    if (resumenCorto) update.$set.resumen_ultimo_contacto = resumenCorto.replace(/\*\*/g, '').trim();
  } catch (e) {}

  const contacto = await Contacto.findOneAndUpdate(
    { tenant_id: tenant._id, numero },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // 3. Calcular nivel de calor del lead y crear/actualizar en Odoo según corresponda
  const ultimoMsgBotPrevio = [...historial].reverse().find(m => m.role === 'assistant')?.content || respuestaBot;
  const resultado = calcularNivelInteres(mensajeUsuario, ultimoMsgBotPrevio, contacto);

  if (resultado) {
    const nivelMejoro = !contacto.nivel_calor || resultado.nivel < contacto.nivel_calor; // nivel 1 es "más caliente" que 3
    if (!contacto.odoo_lead_id) {
      // Primera vez que se detecta cualquier nivel — crear el lead en Odoo
      await crearCandidatoEnOdoo(tenant, contacto, numero, resultado);
    } else if (nivelMejoro) {
      // Ya existe el lead pero subió de calor — actualizar etiqueta/nivel en Odoo sin duplicar
      await actualizarNivelCandidatoEnOdoo(tenant, contacto, resultado);
    }
  }

  return contacto;
}

// Crea el lead "Candidato KAI" en Odoo a partir de los datos ya capturados en el Contacto
// Busca el ID de un tag de Odoo por nombre, o lo crea si no existe (cachea en memoria para no repetir consultas)
const _cacheTagsOdoo = {};
async function getOdooTagId(nombreTag) {
  if (_cacheTagsOdoo[nombreTag]) return _cacheTagsOdoo[nombreTag];
  try {
    const existentes = await odooCallLocal('crm.tag', 'search_read', [[['name', '=', nombreTag]]], { fields: ['id'], limit: 1 });
    if (existentes && existentes.length) {
      _cacheTagsOdoo[nombreTag] = existentes[0].id;
      return existentes[0].id;
    }
    const nuevoId = await odooCallLocal('crm.tag', 'create', [{ name: nombreTag }]);
    _cacheTagsOdoo[nombreTag] = nuevoId;
    return nuevoId;
  } catch (e) {
    console.error(`❌ Error obteniendo/creando tag "${nombreTag}":`, e.message);
    return null;
  }
}

// Crea el lead "Candidato KAI" en Odoo con la etiqueta correspondiente a su nivel de calor
async function crearCandidatoEnOdoo(tenant, contacto, numero, resultadoNivel) {
  if (contacto.odoo_lead_id) return contacto.odoo_lead_id; // ya existe en memoria

  // Verificación adicional — buscar directamente en Odoo por teléfono antes de crear
  // Esto evita duplicados cuando dos mensajes llegan casi simultáneamente
  try {
    const telefonoLimpio = numero.replace(/\D/g,'');
    const existentes = await odooCallLocal('crm.lead', 'search_read',
      [[['phone', 'like', telefonoLimpio.slice(-8)], ['active', '=', true]]],
      { fields: ['id', 'name', 'phone'], limit: 1 }
    );
    if (existentes && existentes.length) {
      // Ya existe un lead con ese teléfono — vincularlo al Contacto sin crear otro
      contacto.odoo_lead_id = existentes[0].id;
      await contacto.save();
      console.log(`🔗 Lead existente en Odoo vinculado — #${existentes[0].id} para ${numero}`);
      return existentes[0].id;
    }
  } catch (e) {
    console.warn('⚠️ No se pudo verificar duplicados en Odoo:', e.message);
  }

  try {
    const teamId = tenant?.odoo_team_id || 1;
    const etiqueta = resultadoNivel?.etiqueta || 'KAI — Exploratorio';
    const nivel = resultadoNivel?.nivel || 3;

    const nombreLead = `Lead KAI — ${contacto.nombre || 'Sin nombre'}${contacto.nombre_alumno ? ' (hijo: ' + contacto.nombre_alumno + ')' : ''}`;
    const descripcion = [
      `Nivel de calor: ${etiqueta}`,
      contacto.nivel_interes ? `Nivel educativo de interés: ${contacto.nivel_interes}` : null,
      contacto.zona ? `Zona: ${contacto.zona}` : null,
      contacto.colegio_actual ? `Colegio actual: ${contacto.colegio_actual}` : null,
      `Capturado automáticamente por KAI vía WhatsApp.`
    ].filter(Boolean).join('\n');

    const tagId = await getOdooTagId(etiqueta);

    const leadId = await odooCallLocal('crm.lead', 'create', [{
      name: nombreLead,
      phone: numero,
      partner_name: contacto.nombre || null,
      email_from: contacto.correo || null,
      description: descripcion,
      team_id: teamId,
      type: 'opportunity',
      tag_ids: tagId ? [[6, 0, [tagId]]] : undefined
    }]);

    if (leadId) {
      contacto.odoo_lead_id = leadId;
      contacto.nivel_calor = nivel;
      contacto.nivel_calor_etiqueta = etiqueta;
      await contacto.save();
      console.log(`✅ ${etiqueta} creado en Odoo — lead #${leadId} para ${numero}`);
    }
    return leadId;
  } catch (e) {
    console.error('❌ Error creando candidato en Odoo:', e.message);
    return null;
  }
}

// Cuando un contacto YA tiene lead en Odoo pero subió de nivel de calor (ej: de Exploratorio a Alta Intención),
// actualiza la etiqueta y el nombre del lead existente sin crear uno nuevo.
async function actualizarNivelCandidatoEnOdoo(tenant, contacto, resultadoNivel) {
  if (!contacto.odoo_lead_id) return;
  try {
    const etiqueta = resultadoNivel.etiqueta;
    const tagId = await getOdooTagId(etiqueta);
    const nuevoNombre = `Lead KAI — ${contacto.nombre || 'Sin nombre'}${contacto.nombre_alumno ? ' (hijo: ' + contacto.nombre_alumno + ')' : ''}`;

    await odooCallLocal('crm.lead', 'write', [[contacto.odoo_lead_id], {
      name: nuevoNombre,
      tag_ids: tagId ? [[6, 0, [tagId]]] : undefined
    }]);

    // Dejar registro del cambio de nivel en el chatter del lead
    await odooCallLocal('crm.lead', 'message_post', [[contacto.odoo_lead_id]], {
      body: `🌡️ Nivel de calor actualizado por KAI: ${contacto.nivel_calor_etiqueta || 'Sin nivel previo'} → ${etiqueta}`
    }).catch(()=>{});

    contacto.nivel_calor = resultadoNivel.nivel;
    contacto.nivel_calor_etiqueta = etiqueta;
    await contacto.save();
    console.log(`🌡️ Lead #${contacto.odoo_lead_id} subió de nivel a "${etiqueta}" para ${contacto.numero}`);
  } catch (e) {
    console.error('❌ Error actualizando nivel de candidato en Odoo:', e.message);
  }
}

// Para el caso de handoff inmediato (antes de tener el Contacto actualizado con los últimos datos)
async function crearCandidatoOdooSiNoExiste(tenant, numero, mensajeUsuario, historialPrevio) {
  let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero });
  if (!contacto) {
    contacto = await Contacto.create({ tenant_id: tenant._id, numero, total_conversaciones: 1 });
  }
  if (contacto.odoo_lead_id) return; // ya existe
  // El handoff inmediato siempre implica Nivel 1 — Alta Intención (pidió agendar/inscribir)
  await crearCandidatoEnOdoo(tenant, contacto, numero, { nivel: 1, etiqueta: 'KAI — Alta Intención' });
}

// ===== OMNICHANNEL — funciones de envío por canal =====

// Enviar mensaje por Instagram DMs (requiere token de página con permisos instagram_manage_messages)
function enviarMensajeInstagram(recipientId, texto) {
  return new Promise((resolve) => {
    const TOKEN_PAGE = process.env.INSTAGRAM_PAGE_TOKEN || process.env.WHATSAPP_TOKEN;
    const body = JSON.stringify({
      recipient: { id: recipientId },
      message: { text: texto }
    });
    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/me/messages?access_token=${TOKEN_PAGE}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){resolve(null)} }); });
    req2.on('error', () => resolve(null));
    req2.write(body); req2.end();
  });
}

// Enviar mensaje por Facebook Messenger (requiere token de página con permisos pages_messaging)
function enviarMensajeMessenger(recipientId, texto) {
  return new Promise((resolve) => {
    const TOKEN_PAGE = process.env.MESSENGER_PAGE_TOKEN || process.env.WHATSAPP_TOKEN;
    const body = JSON.stringify({
      recipient: { id: recipientId },
      message: { text: texto },
      messaging_type: 'RESPONSE'
    });
    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/me/messages?access_token=${TOKEN_PAGE}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){resolve(null)} }); });
    req2.on('error', () => resolve(null));
    req2.write(body); req2.end();
  });
}

// Procesa un mensaje de cualquier canal — crea/actualiza Contacto y lead en Odoo con canal_origen
async function procesarMensajeOmnichannel(numero, nombre, mensaje, canal, tenant) {
  try {
    const teamId = tenant?.odoo_team_id || 1;

    // Buscar o crear contacto con el canal de origen registrado
    let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero });
    if (!contacto) {
      contacto = await Contacto.create({
        tenant_id: tenant._id,
        numero,
        nombre: nombre || null,
        canal_origen: canal,
        total_conversaciones: 1,
        ultimo_contacto: new Date(),
        primer_contacto: new Date()
      });
    } else {
      // Si ya existía, registrar canal si no lo tenía
      if (!contacto.canal_origen) contacto.canal_origen = canal;
      if (nombre && !contacto.nombre) contacto.nombre = nombre;
      contacto.ultimo_contacto = new Date();
      await contacto.save();
    }

    // Crear lead en Odoo si no existe aún — con etiqueta de canal
    if (!contacto.odoo_lead_id) {
      const etiquetaCanal = {
        whatsapp:   'Canal — WhatsApp',
        instagram:  'Canal — Instagram',
        messenger:  'Canal — Messenger',
        lead_ads:   'Canal — Lead Ads Facebook',
        formulario: 'Canal — Formulario Web'
      }[canal] || 'Canal — Otro';

      const tagId = await getOdooTagId(etiquetaCanal);
      const leadId = await odooCallLocal('crm.lead', 'create', [{
        name: `Lead KAI — ${nombre || 'Sin nombre'} (${etiquetaCanal})`,
        phone: numero.startsWith('ig_') || numero.startsWith('fb_') ? null : numero,
        partner_name: nombre || null,
        description: `Canal de origen: ${canal}\nCapturado automáticamente por KAI.`,
        team_id: teamId,
        type: 'opportunity',
        tag_ids: tagId ? [[6, 0, [tagId]]] : undefined
      }]);
      if (leadId) {
        contacto.odoo_lead_id = leadId;
        await contacto.save();
        console.log(`✅ Lead Odoo creado desde ${canal} — #${leadId}`);
      }
    }
  } catch (e) {
    console.error(`❌ procesarMensajeOmnichannel [${canal}]:`, e.message);
  }
}

// ===== ENVÍO AUTOMÁTICO DE IMÁGENES SEGÚN CONTEXTO =====
// Detecta qué imagen es relevante para el mensaje del padre y la envía después de la respuesta de texto.
// Solo envía UNA imagen por mensaje para no saturar. Espera 1.5s después del texto para que se vea ordenado.

const REGLAS_IMAGEN = [
  // ── CUOTAS — nombres genéricos sin año, se actualizan desde el panel ──
  { keywords: ['cuota','colegiatura','mensualidad','precio','costo','cuánto cuesta','cuanto cuesta','cuánto es','cuanto es'], nivel: ['preprimaria','jardín','jardin','infantil','kínder','kinder','párvulos','parvulos','preparatoria'], categoria: 'cuotas', nombre_contiene: 'Preprimaria' },
  { keywords: ['cuota','colegiatura','mensualidad','precio','costo','cuánto cuesta','cuanto cuesta','cuánto es','cuanto es'], nivel: ['primaria','primero','segundo','tercero','cuarto','quinto','sexto','1°','2°','3°','4°','5°','6°'], categoria: 'cuotas', nombre_contiene: 'Primaria' },
  { keywords: ['cuota','colegiatura','mensualidad','precio','costo','cuánto cuesta','cuanto cuesta','cuánto es','cuanto es'], nivel: ['secundaria','básico','basico','bachillerato','séptimo','octavo','noveno','décimo','7°','8°','9°','10°'], categoria: 'cuotas', nombre_contiene: 'Secundaria' },

  // ── PROCESO DE ADMISIÓN ──
  { keywords: ['proceso','admisión','admision','inscribir','inscripción','inscripcion','cómo aplico','como aplico','cómo ingreso','como ingreso'], nivel: ['jardín','jardin','infantil','kínder','kinder'], categoria: 'admision', nombre_contiene: 'Jardín' },
  { keywords: ['proceso','admisión','admision','inscribir','inscripción','inscripcion','cómo aplico','como aplico'], nivel: ['párvulos','parvulos','preparatoria'], categoria: 'admision', nombre_contiene: 'Párvulos' },
  { keywords: ['proceso','admisión','admision','inscribir','inscripción','inscripcion','cómo aplico','como aplico'], nivel: ['primaria','secundaria','básico','basico','bachillerato'], categoria: 'admision', nombre_contiene: 'Primaria y Secundaria' },

  // ── PAPELERÍA Y REQUISITOS ──
  { keywords: ['papelería','papeleria','documentos','qué necesito','que necesito','qué piden','que piden','qué documentos','que documentos'], nivel: [], categoria: 'admision', nombre_contiene: 'Papelería' },
  { keywords: ['requisito','nota mínima','nota minima','promedio','calificacion','calificación','aprobado','punteo'], nivel: [], categoria: 'admision', nombre_contiene: 'Requisitos' },

  // ── EDADES ──
  { keywords: ['edad','años tiene','cuántos años','cuantos años','a qué edad','a que edad','qué edad','que edad','tiene que tener'], nivel: [], categoria: 'admision', nombre_contiene: 'Edades' },

  // ── HORARIOS ──
  { keywords: ['horario','hora','a qué hora','a que hora','cuándo entra','cuando entra','cuándo sale','cuando sale','qué hora'], nivel: [], categoria: 'info_general', nombre_contiene: 'Horario' },

  // ── PROGRAMAS ACADÉMICOS ──
  { keywords: ['cómo es','como es','qué enseñan','que enseñan','metodología','metodologia','programa','plan de estudios','cómo trabajan','como trabajan'], nivel: ['preprimaria','jardín','jardin','infantil','kínder','kinder','párvulos','parvulos'], categoria: 'programas', nombre_contiene: 'Preprimaria' },
  { keywords: ['cómo es','como es','qué enseñan','que enseñan','metodología','metodologia','programa'], nivel: ['primaria','1°','2°','3°','4°','5°','6°'], categoria: 'programas', nombre_contiene: 'Primaria' },
  { keywords: ['cómo es','como es','qué enseñan','que enseñan','metodología','metodologia','programa'], nivel: ['secundaria','básico','basico'], categoria: 'programas', nombre_contiene: 'Secundaria' },
  { keywords: ['bachillerato','carrera','ciencias y letras','qué bachillerato','que bachillerato'], nivel: [], categoria: 'programas', nombre_contiene: 'Bachillerato' },

  // ── UBICACIÓN ──
  { keywords: ['dónde están','donde estan','dirección','direccion','ubicación','ubicacion','cómo llego','como llego','zona 11','mapa','dónde queda','donde queda'], nivel: [], categoria: 'info_general', nombre_contiene: 'Ubicación' },

  // ── ACADEMIA AHA ──
  { keywords: ['extraescolar','extracurricular','academia','aha','natación','natacion','danza','teatro','guitarra','piano','ajedrez','arte','actividad fuera','actividades después','actividades despues'], nivel: [], categoria: 'academia_aha', nombre_contiene: 'Academia AHA' },
];

async function detectarYEnviarImagen(tenant, mensajeUsuario, contacto, canal, numeroOrigen, idExterno) {
  try {
    const t = mensajeUsuario.toLowerCase();
    const nivelContacto = (contacto?.nivel_interes || '').toLowerCase();

    for (const regla of REGLAS_IMAGEN) {
      // Verificar si el mensaje contiene alguna keyword de la regla
      const tieneKeyword = regla.keywords.some(k => t.includes(k));
      if (!tieneKeyword) continue;

      // Verificar nivel — si la regla tiene niveles específicos, al menos uno debe coincidir
      // con el mensaje actual O con el nivel de interés ya registrado del contacto
      if (regla.nivel && regla.nivel.length > 0) {
        const textoCompleto = t + ' ' + nivelContacto;
        const coincideNivel = regla.nivel.some(n => textoCompleto.includes(n));
        if (!coincideNivel) continue;
      }

      // Buscar imagen en MongoDB según la regla
      const filtro = { tenant_id: tenant._id, activo: true, categoria: regla.categoria };
      if (regla.nivel_educativo) filtro.nivel_educativo = { $in: [regla.nivel_educativo, 'Todos'] };
      if (regla.nombre_contiene) filtro.nombre = new RegExp(regla.nombre_contiene, 'i');

      const imagen = await ImagenMarketing.findOne(filtro);
      if (!imagen) continue;

      // Esperar 1.5s para que el texto llegue primero
      await new Promise(r => setTimeout(r, 1500));

      // Enviar según canal
      if (canal === 'whatsapp') {
        await enviarImagenDesdeDB(imagen, numeroOrigen, '');
      }
      // Instagram y Messenger en modo lectura — no enviamos imágenes todavía

      console.log(`🖼️ Imagen automática enviada: "${imagen.nombre}" → ${numeroOrigen}`);
      return; // Solo una imagen por mensaje
    }
  } catch (e) {
    console.error('❌ Error enviando imagen automática:', e.message);
  }
}

async function responderConIA(tenant, mensajeUsuario, numeroOrigen) {
  // ===== VERIFICAR SI YA HAY HANDOFF ACTIVO =====
  const convActiva = await Conversacion.findOne({ tenant_id: tenant._id, numero: numeroOrigen, estado: { $in: ['humano', 'esperando_agente'] } });
  if (convActiva) {
    // Calcular hace cuánto fue el último mensaje del AGENTE (no del padre) — si nunca respondió, usar la fecha de creación del handoff
    const ultimoMsgAgente = [...(convActiva.mensajes || [])].reverse().find(m => m.de === 'agente');
    const ultimaRespuestaAgenteFecha = ultimoMsgAgente ? new Date(ultimoMsgAgente.fecha) : convActiva.creado;
    const minutosSinRespuestaAgente = (Date.now() - new Date(ultimaRespuestaAgenteFecha).getTime()) / (1000 * 60);

    const MINUTOS_AUTO_RECUPERACION = 30;

    if (minutosSinRespuestaAgente >= MINUTOS_AUTO_RECUPERACION) {
      // El agente no respondió en 30+ minutos — KAI retoma automáticamente para no dejar al padre sin atención
      console.log(`🔄 Auto-recuperación: KAI retoma conversación de ${numeroOrigen} tras ${Math.round(minutosSinRespuestaAgente)} min sin respuesta del agente`);
      convActiva.mensajes.push({ de: 'padre', texto: mensajeUsuario });

      const resumenAgente = await generarResumenParaKai(convActiva);
      convActiva.resumen_agente = resumenAgente;
      convActiva.estado = 'cerrado';
      await convActiva.save();

      // Inyectar el contexto en la memoria de KAI para que no repita preguntas, igual que en "Devolver a KAI" manual
      if (!conversaciones.has(numeroOrigen)) conversaciones.set(numeroOrigen, { historial: [], ultimaActividad: Date.now() });
      const ctx = conversaciones.get(numeroOrigen);
      if (resumenAgente) {
        ctx.historial.push({ role: 'assistant', content: `(Contexto interno — no mostrar tal cual: mientras hablaba con un asesor humano, esto ocurrió: ${resumenAgente}. El asesor no pudo responder a tiempo, así que retomas tú la conversación. Hazlo con naturalidad, sin mencionar este resumen ni que el asesor no respondió, solo continúa ayudando.)` });
      }
      // No retornar null aquí — dejar que el flujo continúe hacia abajo y KAI genere una respuesta normal
    } else {
      // Todavía dentro del tiempo de espera — el agente puede seguir respondiendo manualmente
      convActiva.mensajes.push({ de: 'padre', texto: mensajeUsuario });
      convActiva.ultimaActividad = new Date();
      await convActiva.save();
      return null; // null = no enviar respuesta automática, el agente responde manualmente desde el panel
    }
  }

  // ===== DETECTAR SOLICITUD DE AGENTE — solo transferir si ya hay contexto o el padre insiste =====
  
  // ── RECUPERAR MEMORIA DESDE MONGODB si el servidor reinició ────────────
  // Si no hay historial en RAM pero el contacto existe en MongoDB, inyectar el contexto
  if (!conversaciones.has(numeroOrigen)) {
    const contactoExistente = await Contacto.findOne({ tenant_id: tenant._id, numero: numeroOrigen });
    if (contactoExistente && contactoExistente.nombre) {
      // El padre ya había conversado antes — inyectar contexto para que KAI lo reconozca
      conversaciones.set(numeroOrigen, { historial: [], ultimaActividad: Date.now() });
      const ctx = conversaciones.get(numeroOrigen);
      const partes = [];
      if (contactoExistente.nombre) partes.push(`nombre del padre: ${contactoExistente.nombre}`);
      if (contactoExistente.nombre_alumno) partes.push(`nombre del alumno: ${contactoExistente.nombre_alumno}`);
      if (contactoExistente.nivel_interes) partes.push(`nivel de interés: ${contactoExistente.nivel_interes}`);
      if (contactoExistente.zona) partes.push(`zona: ${contactoExistente.zona}`);
      if (contactoExistente.correo) partes.push(`correo: ${contactoExistente.correo}`);
      if (contactoExistente.resumen_ultimo_contacto) partes.push(`última conversación: ${contactoExistente.resumen_ultimo_contacto}`);
      if (partes.length) {
        ctx.historial.push({
          role: 'assistant',
          content: `(Contexto interno — ya conoces a este padre/madre. ${partes.join(', ')}. Salúdalo por su nombre directamente, sin volver a pedir datos que ya tienes. Continúa desde donde quedaron.)`
        });
        console.log(`🧠 Memoria recuperada para ${numeroOrigen} — ${contactoExistente.nombre}`);
      }
    }
  }

  const historialPrevio = conversaciones.get(numeroOrigen)?.historial || [];
  const yaHayContexto = historialPrevio.length >= 4; // al menos 2 intercambios (pregunta+respuesta x2)
  const insisteExplicito = detectaInsistenciaAgente(mensajeUsuario);
  const ultimoMsgBot = [...historialPrevio].reverse().find(m => m.role === 'assistant')?.content || '';
  const mostroInteresReal = esAltaIntencion(mensajeUsuario, ultimoMsgBot); // Nivel 1 = quiere agendar/inscribir = transferir directo

  if ((detectaSolicitudAgente(mensajeUsuario) && (yaHayContexto || insisteExplicito)) || mostroInteresReal) {
    const motivoHandoff = mostroInteresReal ? `Interesado en avanzar: ${mensajeUsuario}` : mensajeUsuario;
    const { conv, agente } = await iniciarHandoff(tenant, numeroOrigen, null, motivoHandoff);
    conv.mensajes.push({ de: 'padre', texto: mensajeUsuario });
    let msg;
    if (agente) {
      msg = mostroInteresReal
        ? `¡Perfecto! Te conecto con ${agente.nombre.split(' ')[0]}, quien te ayudará a coordinar la visita y confirmar la fecha disponible 🙋`
        : `¡Claro! Le paso con ${agente.nombre.split(' ')[0]}, quien le atenderá enseguida 🙋`;
    } else {
      msg = 'En este momento todos nuestros asesores están ocupados. En breve uno le atenderá personalmente para coordinar todo. 🙏';
    }
    conv.mensajes.push({ de: 'bot', texto: msg });
    await conv.save();

    // Crear/actualizar el candidato en Odoo también cuando el handoff fue por interés real
    if (mostroInteresReal) {
      crearCandidatoOdooSiNoExiste(tenant, numeroOrigen, mensajeUsuario, historialPrevio)
        .catch(e => console.error('❌ Error creando candidato en handoff:', e.message));
    }

    return msg;
  }
  // Si pidió asesor pero aún no hay contexto suficiente, KAI continúa la conversación normalmente
  // intentando avanzar el proceso (esto se maneja en el system prompt de buildSystemPrompt)

  if (!conversaciones.has(numeroOrigen)) conversaciones.set(numeroOrigen, { historial: [], ultimaActividad: Date.now() });
  const conv = conversaciones.get(numeroOrigen);

  // Si la conversación había sido cerrada por inactividad (1h), reiniciar el historial activo
  // pero la memoria persistente (Contacto) sigue intacta, así que KAI no pierde el contexto del padre.
  const fueRecienCerrada = conv.cerrada === true;
  if (fueRecienCerrada) {
    conv.historial = [];
    conv.cerrada = false;
  }

  const inactivoPor = Date.now() - (conv.ultimaActividad || Date.now());
  const llevaInactivo3h = !fueRecienCerrada && inactivoPor >= (3 * 60 * 60 * 1000) && conv.historial.length > 0;
  conv.ultimaActividad = Date.now();
  const historial = conv.historial;
  historial.push({ role: 'user', content: mensajeUsuario });
  if (historial.length > 16) historial.splice(0, 2);
  const systemPrompt = buildSystemPrompt(tenant);
  let contextoExtra = '';
  if (llevaInactivo3h) {
    contextoExtra += '\n\n⏰ CONTEXTO: Esta conversación estuvo inactiva por más de 3 horas. El padre/madre acaba de volver a escribir. Salúdalo con calidez retomando la conversación, sin mencionar el tiempo de inactividad de forma incómoda.';
  }
  if (fueRecienCerrada) {
    contextoExtra += '\n\n🔄 CONTEXTO: La conversación anterior se cerró automáticamente porque el padre/madre no respondió en un tiempo. Ahora acaba de escribir de nuevo. Salúdalo con calidez como si retomaras la conversación, usando la memoria que tengas de él si aplica, sin mencionar el cierre automático.';
  }

  // ===== MEMORIA PERSISTENTE — cargar contacto de la BD =====
  let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero: numeroOrigen });
  const esPrimeraVezEnEstaSesion = historial.length === 1; // primer mensaje del usuario en esta sesión de memoria
  if (contacto && esPrimeraVezEnEstaSesion) {
    const diasDesdeUltimo = (Date.now() - new Date(contacto.ultimo_contacto).getTime()) / (1000*60*60*24);
    if (diasDesdeUltimo > 0.1) { // si pasó tiempo real desde el último contacto (no la misma sesión activa)
      contextoExtra += `\n\n🧠 MEMORIA DEL CONTACTO: Este número ya escribió antes (${contacto.total_conversaciones} veces). `;
      if (contacto.nombre) contextoExtra += `Se llama ${contacto.nombre}. `;
      if (contacto.nombre_alumno) contextoExtra += `Pregunta por su hijo/a ${contacto.nombre_alumno}. `;
      if (contacto.nivel_interes) contextoExtra += `Interesado en nivel ${contacto.nivel_interes}. `;
      if (contacto.resumen_ultimo_contacto) contextoExtra += `Última vez se habló de: ${contacto.resumen_ultimo_contacto}. `;
      contextoExtra += 'Salúdalo reconociendo que ya hablaron antes, por su nombre si lo sabes, y continúa desde donde quedaron sin repetir preguntas que ya respondió.';
    }
  }

  try {
    const [faqs, docs] = await Promise.all([
      FAQ.find({ tenant_id: tenant._id, activo: true }).limit(20),
      Documento.find({ tenant_id: tenant._id, activo: true }).sort({ tipo: 1, creado: -1 }).limit(15)
    ]);
    if (faqs.length) contextoExtra += '\n\nPREGUNTAS FRECUENTES:\n' + faqs.map(f => `P: ${f.pregunta}\nR: ${f.respuesta}`).join('\n\n');
    contextoExtra += buildDocsContext(docs);
  } catch (e) {}
  const reply = await llamarClaude(systemPrompt + contextoExtra, historial, 600);
  const respuestaLimpia = reply ? reply.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1') : null;
  const respuesta = respuestaLimpia || 'Disculpe, tuve un problema técnico. Por favor llámenos directamente. 📞';
  historial.push({ role: 'assistant', content: respuesta });

  // ===== ACTUALIZAR/CREAR CONTACTO Y DETECTAR INTERÉS REAL (async, no bloquea respuesta) =====
  actualizarContactoYDetectarInteres(tenant, numeroOrigen, mensajeUsuario, respuesta, historial, contacto)
    .catch(e => console.error('❌ Error actualizando contacto:', e.message));

  return respuesta;
}

// ===== WEBHOOK TWILIO =====
// ===== WEBHOOK META WHATSAPP CLOUD API =====

// GET — verificación inicial que pide Meta al guardar el webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook de Meta verificado correctamente');
    return res.status(200).send(challenge);
  }
  console.error('❌ Verificación de webhook fallida — token no coincide');
  res.sendStatus(403);
});

// Enviar mensaje de texto vía Meta WhatsApp Cloud API
function enviarWhatsAppMeta(numeroDestino, texto) {
  return new Promise((resolve) => {
    const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
    const TOKEN_WA = process.env.WHATSAPP_TOKEN;
    if (!PHONE_ID || !TOKEN_WA) { console.error('❌ Falta WHATSAPP_PHONE_ID o WHATSAPP_TOKEN'); return resolve(null); }

    const body = JSON.stringify({
      messaging_product: 'whatsapp',
      to: numeroDestino.replace(/\D/g, ''),
      type: 'text',
      text: { body: texto }
    });

    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/${PHONE_ID}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN_WA}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d }); } });
    });
    req2.on('error', (e) => { console.error('❌ Error enviando WhatsApp:', e.message); resolve(null); });
    req2.write(body);
    req2.end();
  });
}

// Sube una imagen (base64) a los servidores de Meta y devuelve el media_id necesario para enviarla
function subirImagenAMeta(imagenBase64, mimeType) {
  return new Promise((resolve) => {
    const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
    const TOKEN_WA = process.env.WHATSAPP_TOKEN;
    if (!PHONE_ID || !TOKEN_WA) { console.error('❌ Falta WHATSAPP_PHONE_ID o WHATSAPP_TOKEN'); return resolve(null); }

    const buffer = Buffer.from(imagenBase64, 'base64');
    const boundary = '----KaiBoundary' + Date.now();
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="imagen.jpg"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    parts.push(buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/${PHONE_ID}/media`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN_WA}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          resolve(parsed.id || null);
        } catch (e) { resolve(null); }
      });
    });
    req2.on('error', (e) => { console.error('❌ Error subiendo imagen a Meta:', e.message); resolve(null); });
    req2.write(body);
    req2.end();
  });
}

// Envía una imagen ya subida (media_id) a un número de WhatsApp, con texto opcional (caption)
function enviarImagenWhatsAppMeta(numeroDestino, mediaId, caption) {
  return new Promise((resolve) => {
    const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
    const TOKEN_WA = process.env.WHATSAPP_TOKEN;
    if (!PHONE_ID || !TOKEN_WA) { console.error('❌ Falta WHATSAPP_PHONE_ID o WHATSAPP_TOKEN'); return resolve(null); }

    const body = JSON.stringify({
      messaging_product: 'whatsapp',
      to: numeroDestino.replace(/\D/g, ''),
      type: 'image',
      image: { id: mediaId, caption: caption || '' }
    });

    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/${PHONE_ID}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN_WA}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d }); } });
    });
    req2.on('error', (e) => { console.error('❌ Error enviando imagen WhatsApp:', e.message); resolve(null); });
    req2.write(body);
    req2.end();
  });
}

// Sube una imagen como "adjunto reutilizable" a Instagram/Messenger (mismo mecanismo
// para ambos vía Graph API) y devuelve el attachment_id para enviarla después.
function subirImagenAdjuntoMeta(imagenBase64, mimeType, tokenPagina) {
  return new Promise((resolve) => {
    if (!tokenPagina) return resolve(null);
    const buffer = Buffer.from(imagenBase64, 'base64');
    const boundary = '----KaiBoundary' + Date.now();
    const mensajePart = JSON.stringify({ message: { attachment: { type: 'image', payload: { is_reusable: true } } } });
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${mensajePart}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="filedata"; filename="imagen.jpg"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    parts.push(buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/me/message_attachments?access_token=${tokenPagina}`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    }, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{ resolve(JSON.parse(d).attachment_id || null); }catch(e){ resolve(null); } }); });
    req2.on('error', () => resolve(null));
    req2.write(body); req2.end();
  });
}

// Envía una imagen ya subida (attachment_id) por Instagram o Messenger
function enviarImagenAdjuntoMeta(recipientId, attachmentId, tokenPagina, caption) {
  return new Promise((resolve) => {
    if (!tokenPagina) return resolve(null);
    const body = JSON.stringify({
      recipient: { id: recipientId },
      message: { attachment: { type: 'image', payload: { attachment_id: attachmentId } } }
    });
    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/me/messages?access_token=${tokenPagina}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{
      try {
        const parsed = JSON.parse(d);
        // Si hay caption, mandarlo como mensaje de texto aparte (los adjuntos de imagen no llevan texto junto)
        if (caption) enviarMensajeMessenger(recipientId, caption).catch(()=>{});
        resolve(parsed);
      } catch(e){ resolve(null); }
    }); });
    req2.on('error', () => resolve(null));
    req2.write(body); req2.end();
  });
}

// Función de conveniencia: sube + envía una imagen (de la BD o subida ad-hoc) por Instagram/Messenger
async function enviarImagenInstagramOMessenger(canal, imagenBase64, mimeType, recipientId, caption) {
  const tokenPagina = canal === 'instagram'
    ? (process.env.INSTAGRAM_PAGE_TOKEN || process.env.WHATSAPP_TOKEN)
    : (process.env.MESSENGER_PAGE_TOKEN || process.env.WHATSAPP_TOKEN);
  const attachmentId = await subirImagenAdjuntoMeta(imagenBase64, mimeType, tokenPagina);
  if (!attachmentId) return { ok: false, error: 'No se pudo subir la imagen a Meta (revisar token de página)' };
  const resultado = await enviarImagenAdjuntoMeta(recipientId, attachmentId, tokenPagina, caption);
  if (resultado && resultado.message_id) return { ok: true, mensaje_id: resultado.message_id };
  return { ok: false, error: resultado?.error?.message || 'Error desconocido al enviar imagen', detalle: resultado };
}

// Función de conveniencia: sube + envía una imagen de la base de datos a un número, en un solo paso
async function enviarImagenDesdeDB(imagenDoc, numeroDestino, caption) {
  const mediaId = await subirImagenAMeta(imagenDoc.imagen_base64, imagenDoc.mime_type);
  if (!mediaId) return { ok: false, error: 'No se pudo subir la imagen a Meta' };
  const resultado = await enviarImagenWhatsAppMeta(numeroDestino, mediaId, caption);
  if (resultado && resultado.messages) {
    imagenDoc.veces_enviada = (imagenDoc.veces_enviada || 0) + 1;
    await imagenDoc.save().catch(()=>{});
    return { ok: true, mensaje_id: resultado.messages[0]?.id };
  }
  return { ok: false, error: resultado?.error?.message || 'Error desconocido al enviar imagen', detalle: resultado };
}

// ===== CIERRE PROACTIVO POR INACTIVIDAD (1 HORA) =====
const MENSAJE_CIERRE_INACTIVIDAD = 'Gracias por escribirnos 😊 No tuvimos respuesta de tu parte, así que pausamos esta conversación, pero seguimos disponibles cuando quieras continuar — solo escríbenos de nuevo.\n\nMientras tanto, conoce más del Colegio Capouilliez en https://www.capouilliez.edu.gt y síguenos en Instagram y Facebook para no perderte nuestro próximo Open House.';
const MINUTOS_CIERRE_INACTIVIDAD = 60; // 1 hora

// Revisa cada 5 minutos las conversaciones activas con KAI (no las que ya están con un agente humano)
// y cierra con un mensaje de despedida las que llevan 1 hora sin que el padre responda.
setInterval(async () => {
  try {
    const ahora = Date.now();
    const limiteMs = MINUTOS_CIERRE_INACTIVIDAD * 60 * 1000;

    for (const [numero, conv] of conversaciones.entries()) {
      if (conv.cerrada) continue; // ya se cerró, no volver a mandar el mensaje
      if (!conv.historial || !conv.historial.length) continue; // nunca hubo conversación real
      const inactivoPor = ahora - (conv.ultimaActividad || ahora);
      if (inactivoPor < limiteMs) continue; // aún no pasa 1 hora

      // No cerrar si la conversación está en manos de un agente humano (eso lo maneja el agente, no KAI)
      const enHandoff = await Conversacion.findOne({ numero, estado: { $in: ['humano', 'esperando_agente'] } });
      if (enHandoff) { conv.ultimaActividad = ahora; continue; } // reiniciar el contador mientras esté con humano

      // Enviar mensaje de cierre y marcar como cerrada para no repetirlo
      try {
        const tenant = await Tenant.findOne({ activo: true }); // ajustar si hay multi-tenant real
        await enviarWhatsAppMeta(numero, MENSAJE_CIERRE_INACTIVIDAD);
        conv.cerrada = true;
        console.log(`👋 Conversación cerrada por inactividad (${MINUTOS_CIERRE_INACTIVIDAD} min) — ${numero}`);

        // Actualizar el contacto con el resumen de cierre
        if (tenant) {
          await Contacto.findOneAndUpdate(
            { tenant_id: tenant._id, numero },
            { $set: { resumen_ultimo_contacto: 'Conversación cerrada automáticamente por inactividad (1 hora sin respuesta).' } }
          ).catch(()=>{});
        }
      } catch (e) {
        console.error(`❌ Error cerrando conversación inactiva de ${numero}:`, e.message);
      }
    }
  } catch (e) { console.error('❌ Error en verificador de cierre por inactividad:', e.message); }
}, 5 * 60 * 1000); // revisa cada 5 minutos

// ===== MOTOR DE SEGMENTACIÓN PARA REACTIVACIÓN DE MARKETING =====
// Clasifica a cada Contacto en un segmento según hace cuánto fue su última conversación.
// Esto NO envía mensajes — solo etiqueta el segmento para que Campañas WhatsApp pueda filtrar por él.
//
// Segmentos:
//   activo        — conversó en los últimos 7 días, sigue caliente, no necesita reactivación
//   seguimiento   — entre 7 y 30 días sin escribir, candidato a un mensaje de valor (no venta dura)
//   reactivacion  — entre 30 y 60 días sin escribir, necesita un empujón (Open House, fechas límite)
//   frio          — más de 60 días sin escribir, requiere campaña de remarketing fuerte o descartar
const DIAS_SEGUIMIENTO = 7;
const DIAS_REACTIVACION = 30;
const DIAS_FRIO = 60;

async function actualizarSegmentosReactivacion() {
  try {
    const ahora = Date.now();
    const contactos = await Contacto.find({}); // todos los tenants — si hay multi-tenant real, filtrar aquí
    let cambios = 0;

    for (const c of contactos) {
      const diasInactivo = (ahora - new Date(c.ultimo_contacto).getTime()) / (1000 * 60 * 60 * 24);
      let nuevoSegmento = 'activo';
      if (diasInactivo >= DIAS_FRIO) nuevoSegmento = 'frio';
      else if (diasInactivo >= DIAS_REACTIVACION) nuevoSegmento = 'reactivacion';
      else if (diasInactivo >= DIAS_SEGUIMIENTO) nuevoSegmento = 'seguimiento';

      if (c.segmento_reactivacion !== nuevoSegmento) {
        c.segmento_reactivacion = nuevoSegmento;
        await c.save();
        cambios++;
      }
    }
    if (cambios > 0) console.log(`🎯 Segmentación de reactivación actualizada — ${cambios} contacto(s) cambiaron de segmento`);
  } catch (e) { console.error('❌ Error actualizando segmentos de reactivación:', e.message); }
}

// Corre una vez al iniciar el servidor, y luego cada 24 horas
setTimeout(actualizarSegmentosReactivacion, 30 * 1000); // esperar 30s a que MongoDB esté listo
setInterval(actualizarSegmentosReactivacion, 24 * 60 * 60 * 1000);

// ===== MOTOR DE CONTACTO PROACTIVO — KAI revisa Odoo y contacta leads nuevos por WhatsApp =====
// Corre cada 30 minutos. Busca leads en Odoo que tienen teléfono pero KAI nunca contactó.
// Los contacta por WhatsApp, captura respuesta en flujo normal, asigna a Cindy o Vanessa.

const TAG_KAI_CONTACTADO = 'KAI — Contactado';
const TAG_KAI_SIN_WHATSAPP = 'KAI — Sin WhatsApp';

async function motorContactoProactivo() {
  try {
    const tenant = await Tenant.findOne({ activo: true });
    if (!tenant) return;

    const tagContactadoId = await getOdooTagId(TAG_KAI_CONTACTADO);
    const tagSinWAId = await getOdooTagId(TAG_KAI_SIN_WHATSAPP);

    // Leads en Odoo con teléfono que KAI aún no contactó
    // Leads SIN ASIGNAR — igual que la vista "Sin asignar" en Odoo
    const leads = await odooCallLocal('crm.lead', 'search_read',
      [[
        ['active', '=', true],
        ['user_id', '=', false],
      ]],
      { fields: ['id', 'name', 'phone', 'partner_name', 'email_from', 'tag_ids', 'stage_id', 'user_id', 'create_date', 'type'], limit: 100 }
    );

    if (!leads || !leads.length) return;
    console.log(`📡 Motor proactivo: ${leads.length} lead(s) para contactar`);

    for (const lead of leads) {
      try {
        let telefono = String(lead.phone || '').replace(/\D/g, '');
        if (telefono.length === 8) telefono = '502' + telefono;
        if (telefono.length < 10) {
          await odooCallLocal('crm.lead', 'write', [[lead.id], { tag_ids: [[4, tagSinWAId]] }]);
          continue;
        }

        // Crear o vincular contacto en MongoDB
        let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero: telefono });
        if (!contacto) {
          contacto = await Contacto.create({
            tenant_id: tenant._id, numero: telefono,
            nombre: lead.partner_name || null, correo: lead.email_from || null,
            canal_origen: 'lead_ads', odoo_lead_id: lead.id,
            ultimo_contacto: new Date(), primer_contacto: new Date(), total_conversaciones: 0
          });
        } else if (!contacto.odoo_lead_id) {
          contacto.odoo_lead_id = lead.id;
          await contacto.save();
        }

        // Mensaje de primer contacto personalizado
        const nombre = lead.partner_name ? lead.partner_name.split(' ')[0] : null;
        const saludo = nombre ? `Hola ${nombre}` : 'Hola';
        const mensaje = `${saludo} 👋 Te escribimos del *Colegio Capouilliez*.\n\nRecibimos tu información y queremos ayudarte con el proceso de admisiones 🏫\n\n¿Para qué nivel educativo estás buscando información?\n\n1️⃣ Preprimaria (2-6 años)\n2️⃣ Primaria (7-12 años)\n3️⃣ Secundaria (13-16 años)`;

        const resultado = await enviarWhatsAppMeta(telefono, mensaje);

        if (resultado?.messages?.length) {
          // Marcar como contactado en Odoo
          await odooCallLocal('crm.lead', 'write', [[lead.id], { tag_ids: [[4, tagContactadoId]] }]);
          await odooCallLocal('crm.lead', 'message_post', [[lead.id]], {
            body: `📱 KAI contactó por WhatsApp (${telefono}) con mensaje de bienvenida. Esperando respuesta.`
          }).catch(() => {});

          // Asignar asesora con menos carga
          const agentes = await UsuarioPanel.find({ tenant_id: tenant._id, role: 'vendedor', activo: true });
          if (agentes.length) {
            let menorCarga = agentes[0], menorCount = Infinity;
            for (const a of agentes) {
              const c = await Conversacion.countDocuments({ tenant_id: tenant._id, agente_id: a._id, estado: { $in: ['humano','esperando_agente'] } });
              if (c < menorCount) { menorCount = c; menorCarga = a; }
            }
            if (menorCarga.odoo_user_id) {
              await odooCallLocal('crm.lead', 'write', [[lead.id], { user_id: menorCarga.odoo_user_id }]).catch(() => {});
            }
          }

          console.log(`✅ KAI contactó lead #${lead.id} (${nombre || telefono})`);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          await odooCallLocal('crm.lead', 'write', [[lead.id], { tag_ids: [[4, tagSinWAId]] }]);
          console.log(`⚠️ Sin WhatsApp válido — lead #${lead.id} (${telefono})`);
        }
      } catch(e) { console.error(`❌ Lead #${lead.id}:`, e.message); }
    }
  } catch(e) { console.error('❌ Motor proactivo:', e.message); }
}

// Motor proactivo DESHABILITADO hasta validación completa
// Para activar: usar endpoint POST /api/motor/activar desde el panel
// setTimeout(() => motorContactoProactivo(), 2 * 60 * 1000);
// setInterval(() => motorContactoProactivo(), 30 * 60 * 1000);

// POST — mensajes entrantes reales de WhatsApp
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responder rápido a Meta, procesar después

  try {
    const body = req.body;
    const object = body.object; // 'whatsapp_business_account' | 'instagram' | 'page'

    // ── DETECTAR CANAL ──────────────────────────────────────────────────────
    let canal = null;
    let numeroOrigen = null;
    let nombreCliente = null;
    let mensajeUsuario = null;
    let idExterno = null; // id único del remitente en ese canal

    if (object === 'whatsapp_business_account') {
      const value = body.entry?.[0]?.changes?.[0]?.value;
      const mensaje = value?.messages?.[0];
      if (!mensaje || !mensaje.text?.body) return;
      canal = 'whatsapp';
      numeroOrigen = mensaje.from;
      mensajeUsuario = mensaje.text.body;
      nombreCliente = value?.contacts?.[0]?.profile?.name || null;
      idExterno = mensaje.from;

    } else if (object === 'instagram') {
      const messaging = body.entry?.[0]?.messaging?.[0];
      if (!messaging?.message?.text) return;
      canal = 'instagram';
      idExterno = messaging.sender.id;
      mensajeUsuario = messaging.message.text;
      // Instagram no da número de teléfono directamente — usamos su PSID como identificador
      numeroOrigen = `ig_${idExterno}`;
      nombreCliente = null;

    } else if (object === 'page') {
      const messaging = body.entry?.[0]?.messaging?.[0];
      if (!messaging?.message?.text) return;
      canal = 'messenger';
      idExterno = messaging.sender.id;
      mensajeUsuario = messaging.message.text;
      numeroOrigen = `fb_${idExterno}`;
      nombreCliente = null;

    } else {
      return; // evento desconocido
    }

    console.log(`📩 [${canal.toUpperCase()}] de ${nombreCliente || numeroOrigen}: ${mensajeUsuario}`);

    // ── GUARDAR LOG INMEDIATO — antes de cualquier procesamiento ────────────
    const phoneIdRecibido = body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    const tenant = await Tenant.findOne({ whatsapp_phone_id: phoneIdRecibido, activo: true })
                || await Tenant.findOne({ activo: true });
    if (!tenant) return;

    const logEntry = await MessageLog.create({
      tenant_id: tenant._id,
      from: numeroOrigen,
      message: mensajeUsuario,
      canal,
      procesado: false, // se marca true al final si todo salió bien
      fecha: new Date()
    }).catch(() => null);

    // ── TENANT ya declarado arriba ───────────────────────────────────────────
    const limite_info = await verificarLimite(tenant._id, tenant.plan);
    if (limite_info.agotado) return;
    await notificarAdminSiNecesario(tenant, limite_info);

    // ── DEDUPLICACIÓN — buscar si ya existe el contacto por número/id ───────
    // Si el padre escribió por WhatsApp antes y ahora escribe por Instagram,
    // puede que tengamos su teléfono en el Contacto de WhatsApp.
    // La deduplicación busca primero por el idExterno exacto, luego por correo si lo tenemos.
    let contactoExistente = await Contacto.findOne({ tenant_id: tenant._id, numero: numeroOrigen });

    // Registrar el canal de origen si es nuevo
    if (contactoExistente && !contactoExistente.canal_origen) {
      contactoExistente.canal_origen = canal;
      await contactoExistente.save();
    }

    // Actualizar nombre si lo recibimos y no lo teníamos
    if (contactoExistente && nombreCliente && !contactoExistente.nombre) {
      contactoExistente.nombre = nombreCliente;
      await contactoExistente.save();
    }

    // ── FUNCIÓN DE RESPUESTA POR CANAL ──────────────────────────────────────
    // ── CANALES EN MODO LECTURA PARA KAI (el bot NO auto-responde ni crea lead en Odoo) ──
    // Instagram y Messenger: el mensaje SÍ aparece en "Chats en Vivo" para que un agente
    // humano lo atienda manualmente (y sí se le puede responder — ver /api/conversaciones/:id/responder).
    // KAI simplemente no interviene en estos canales todavía, mientras se observa qué piden.
    // Para que KAI empiece a responder solo aquí también, quitar el canal de este array.
    const CANALES_SOLO_LECTURA = ['instagram', 'messenger'];

    const enviarRespuesta = async (numero, texto) => {
      if (CANALES_SOLO_LECTURA.includes(canal)) return;
      if (canal === 'whatsapp') await enviarWhatsAppMeta(numero, texto);
      else if (canal === 'instagram') await enviarMensajeInstagram(idExterno, texto);
      else if (canal === 'messenger') await enviarMensajeMessenger(idExterno, texto);
    };

    // ── PROCESAR CON KAI ────────────────────────────────────────────────────
    await procesarMensajeOmnichannel(numeroOrigen, nombreCliente, mensajeUsuario, canal, tenant);

    // Canales en solo lectura: solo guardar en MongoDB y mostrar en panel — sin Odoo, sin respuesta
    if (CANALES_SOLO_LECTURA.includes(canal)) {
      // Guardar/actualizar contacto en MongoDB (sin tocar Odoo)
      await Contacto.findOneAndUpdate(
        { tenant_id: tenant._id, numero: numeroOrigen },
        {
          $set: { canal_origen: canal, ultimo_contacto: new Date(), nombre: nombreCliente || undefined },
          $inc: { total_conversaciones: 1 },
          $setOnInsert: { primer_contacto: new Date() }
        },
        { upsert: true, new: true }
      ).catch(()=>{});

      // Crear o actualizar conversación en panel para que aparezca en Chats en Vivo
      let conv = await Conversacion.findOne({ tenant_id: tenant._id, numero: numeroOrigen, estado: { $ne: 'cerrado' } });
      if (!conv) {
        conv = await Conversacion.create({
          tenant_id: tenant._id,
          numero: numeroOrigen,
          canal: canal,
          estado: 'esperando_agente',
          mensajes: [{ de: 'padre', texto: mensajeUsuario, fecha: new Date() }],
          ultimaActividad: new Date()
        });
      } else {
        conv.mensajes.push({ de: 'padre', texto: mensajeUsuario, fecha: new Date() });
        conv.ultimaActividad = new Date();
        await conv.save();
      }

      if (logEntry) {
        logEntry.procesado = true;
        logEntry.response = '[modo lectura — visible en panel]';
        await logEntry.save().catch(()=>{});
      }
      console.log(`👁️  [${canal.toUpperCase()}] Mensaje en panel — ${nombreCliente || numeroOrigen}: ${mensajeUsuario}`);
      return;
    }

    const respuesta = await responderConIA(tenant, mensajeUsuario, numeroOrigen);
    if (respuesta === null) {
      console.log(`⏸️  KAI pausado para ${numeroOrigen} — agente humano activo`);
      return;
    }

    if (logEntry) {
      logEntry.response = respuesta;
      logEntry.procesado = true;
      await logEntry.save().catch(()=>{});
    }
    await enviarRespuesta(numeroOrigen, respuesta);
    console.log(`✅ [${canal.toUpperCase()}] Respuesta enviada a ${numeroOrigen}`);

    // Envío automático de imágenes DESHABILITADO — el vendedor las envía manualmente desde el panel
    // Para activar en producción: descomentar las líneas de abajo
    // const contactoActual = await Contacto.findOne({ tenant_id: tenant._id, numero: numeroOrigen }).catch(()=>null);
    // detectarYEnviarImagen(tenant, mensajeUsuario, contactoActual, canal, numeroOrigen, idExterno).catch(()=>{});

  } catch (err) {
    console.error('❌ WEBHOOK error:', err);
    // Si teníamos un logEntry pendiente, marcarlo con el error para que no se pierda el rastro
    if (typeof logEntry !== 'undefined' && logEntry) {
      logEntry.procesado = false;
      logEntry.error = err.message;
      await logEntry.save().catch(()=>{});
    }
  }
});

// ===== DEMO / BOLT =====
app.options('/demo', (req, res) => { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type'); res.sendStatus(200); });
app.post('/demo', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { messages, system, tenant_id } = req.body;
    let contextoExtra = '';
    if (tenant_id) {
      try {
        const [faqs, docs] = await Promise.all([
          FAQ.find({ tenant_id, activo: true }).limit(20),
          Documento.find({ tenant_id, activo: true }).sort({ tipo: 1, creado: -1 }).limit(15)
        ]);
        if (faqs.length) contextoExtra += '\n\nPREGUNTAS FRECUENTES:\n' + faqs.map(f => `P: ${f.pregunta}\nR: ${f.respuesta}`).join('\n\n');
        contextoExtra += buildDocsContext(docs);
      } catch(e) { console.error('Demo docs error:', e.message); }
    }
    const reply = await llamarClaude(system + contextoExtra, messages, 600);
    res.json({ content: [{ type: 'text', text: reply || 'Error interno.' }] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.options('/bolt', (req, res) => { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type'); res.sendStatus(200); });
app.post('/bolt', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { messages, system, sessionId, telefono } = req.body;
    const telefonoFinal = telefono || `web-${sessionId || Date.now()}`;
    const ultimoMensaje = messages[messages.length - 1]?.content || '';
    const palabrasInteres = ['precio','costo','quiero','necesito','demo','contratar','interesa','bot','automatizar'];
    if (palabrasInteres.some(p => ultimoMensaje.toLowerCase().includes(p)) && messages.length >= 2) {
      await Lead.create({ interes: ultimoMensaje, telefono: telefonoFinal }).catch(() => {});
      await procesarMensajeWhatsApp(telefonoFinal, 'Visitante Web', ultimoMensaje, 1, 'KAI Web').catch(() => {});
    }
    const reply = await llamarClaude(system, messages, 800);
    res.json({ content: [{ type: 'text', text: reply || 'Error.' }] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// ===== AUTH — LOGIN + VERIFY =====
// =============================================

app.post('/api/register', async (req, res) => {
  try {
    const { nombre, email, password, tenant_id } = req.body;
    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ error: 'Email ya registrado' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ nombre, email, password: hash, tenant_id });
    res.json({ ok: true, user: { id: user._id, nombre: user.nombre, email: user.email } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// LOGIN — busca primero en UsuarioPanel (nuevo), luego User legacy
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email y contraseña requeridos' });

    let user = await UsuarioPanel.findOne({ email: email.toLowerCase().trim() });
    let isPanel = !!user;
    if (!user) user = await User.findOne({ email }); // fallback legacy

    if (!user) return res.status(401).json({ ok: false, error: 'Usuario no encontrado' });
    if (isPanel && !user.activo) return res.status(403).json({ ok: false, error: 'Usuario desactivado. Contacta al administrador.' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });

    const role = isPanel ? user.role : (user.rol || 'admin');
    const token = jwt.sign(
      { id: user._id, email: user.email, nombre: user.nombre, tenant_id: user.tenant_id, role, sedes: user.sedes || [] },
      JWT_SECRET, { expiresIn: '7d' }
    );

    if (isPanel) await UsuarioPanel.findByIdAndUpdate(user._id, { lastLogin: new Date() });

    res.json({
      ok: true, token,
      user: { nombre: user.nombre, email: user.email, role, sedes: user.sedes || [], tenant_id: user.tenant_id }
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// VERIFY TOKEN
app.post('/api/verify', authMiddleware, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// =============================================
// ===== USUARIOS PANEL =====
// =============================================

// GET /api/usuarios — listar usuarios del tenant
app.get('/api/usuarios', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    const users = await UsuarioPanel.find({ tenant_id: req.user.tenant_id }).select('-password').sort({ creado: 1 });
    const tenant = await Tenant.findById(req.user.tenant_id);
    const maxU = PLANES[tenant?.plan]?.max_usuarios || 3;
    res.json({ ok: true, usuarios: users, total: users.length, max: maxU });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/usuarios — crear usuario
app.post('/api/usuarios', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    const { nombre, email, password, role, sedes } = req.body;
    if (!nombre || !email || !password) return res.status(400).json({ ok: false, error: 'Nombre, email y contraseña requeridos' });
    if (!['admin', 'vendedor', 'viewer'].includes(role)) return res.status(400).json({ ok: false, error: 'Rol inválido' });

    const tenant = await Tenant.findById(req.user.tenant_id);
    const maxU   = PLANES[tenant?.plan]?.max_usuarios || 3;
    const total  = await UsuarioPanel.countDocuments({ tenant_id: req.user.tenant_id, activo: true });
    if (total >= maxU) return res.status(403).json({ ok: false, error: `Límite de ${maxU} usuarios para el plan ${tenant?.plan}` });

    const existe = await UsuarioPanel.findOne({ email: email.toLowerCase().trim() });
    if (existe) return res.status(409).json({ ok: false, error: 'Email ya registrado' });

    const hashed = await bcrypt.hash(password, 10);
    const u = await UsuarioPanel.create({
      nombre, email: email.toLowerCase().trim(), password: hashed,
      role, sedes: sedes || [], tenant_id: req.user.tenant_id
    });
    res.json({ ok: true, id: u._id, mensaje: 'Usuario creado' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// PUT /api/usuarios/:id — editar usuario
app.put('/api/usuarios/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    const { nombre, role, sedes, activo, password } = req.body;
    const update = { nombre, role, sedes: sedes || [], activo };
    if (password) update.password = await bcrypt.hash(password, 10);
    await UsuarioPanel.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, update);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Cambiar mi propia contraseña (cualquier usuario logueado, sin necesitar ser admin)
app.post('/api/mi-cuenta/cambiar-password', authMiddleware, async (req, res) => {
  try {
    const { passwordActual, passwordNueva } = req.body;
    if (!passwordActual || !passwordNueva) return res.status(400).json({ ok: false, error: 'Contraseña actual y nueva requeridas' });
    if (passwordNueva.length < 6) return res.status(400).json({ ok: false, error: 'La nueva contraseña debe tener al menos 6 caracteres' });

    const user = await UsuarioPanel.findById(req.user.id);
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });

    const valid = await bcrypt.compare(passwordActual, user.password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Contraseña actual incorrecta' });

    user.password = await bcrypt.hash(passwordNueva, 10);
    await user.save();
    res.json({ ok: true, mensaje: 'Contraseña actualizada correctamente' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Admin resetea la contraseña de cualquier usuario de su tenant (para cuando un usuario olvida su clave)
app.post('/api/usuarios/:id/resetear-password', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores pueden resetear contraseñas' });
    const { passwordNueva } = req.body;
    if (!passwordNueva || passwordNueva.length < 6) return res.status(400).json({ ok: false, error: 'La nueva contraseña debe tener al menos 6 caracteres' });

    const user = await UsuarioPanel.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.user.tenant_id },
      { password: await bcrypt.hash(passwordNueva, 10) },
      { new: true }
    );
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    res.json({ ok: true, mensaje: `Contraseña de ${user.nombre} reseteada correctamente` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// =============================================
// ===== SEDES =====
// =============================================

app.get('/api/sedes', authMiddleware, async (req, res) => {
  try {
    const sedes = await Sede.find({ tenant_id: req.user.tenant_id, activa: true });
    res.json({ ok: true, sedes });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/sedes', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    const { nombre, direccion, telefono } = req.body;
    if (!nombre) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
    const s = await Sede.create({ nombre, direccion, telefono, tenant_id: req.user.tenant_id });
    res.json({ ok: true, id: s._id });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/sedes/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    await Sede.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, { activa: false });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// =============================================
// ===== SETUP INICIAL DE CLIENTE =====
// Llama UNA VEZ por cliente nuevo con: POST /api/setup-cliente
// Header: x-setup-key: TU_SETUP_KEY (variable Railway)
// =============================================
app.post('/api/setup-cliente', async (req, res) => {
  if (req.headers['x-setup-key'] !== process.env.SETUP_KEY)
    return res.status(403).json({ error: 'Sin autorización' });
  try {
    const { tenantId, adminNombre, adminEmail, adminPassword, sedes } = req.body;
    const tenant = await Tenant.findById(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado. Créalo primero en /tenant' });

    if (sedes?.length) {
      await Sede.insertMany(sedes.map(s => ({
        nombre:    typeof s === 'string' ? s : s.nombre,
        direccion: s.direccion || '',
        telefono:  s.telefono  || '',
        tenant_id: tenant._id
      })));
    }

    const existe = await UsuarioPanel.findOne({ email: adminEmail.toLowerCase() });
    if (existe) return res.status(409).json({ error: 'Admin ya existe para este email' });

    const hashed = await bcrypt.hash(adminPassword, 10);
    await UsuarioPanel.create({
      nombre: adminNombre, email: adminEmail.toLowerCase(),
      password: hashed, role: 'admin',
      tenant_id: tenant._id, sedes: ['todas'], activo: true
    });

    res.json({ ok: true, mensaje: `✅ Setup completo para "${tenant.nombre}". Ya puede iniciar sesión con ${adminEmail}` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// =============================================
// ===== PANEL API =====
// =============================================

app.get('/api/mi-bot', authMiddleware, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.tenant_id);
    if (!tenant) return res.status(404).json({ error: 'Bot no encontrado' });
    res.json(tenant);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/mi-bot', authMiddleware, async (req, res) => {
  try {
    const tenant = await Tenant.findByIdAndUpdate(req.user.tenant_id, req.body, { new: true });
    res.json({ ok: true, tenant });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mis-mensajes', authMiddleware, async (req, res) => {
  try {
    const logs = await MessageLog.find({ tenant_id: req.user.tenant_id }).sort({ fecha: -1 }).limit(50);
    res.json(logs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/estadisticas', authMiddleware, async (req, res) => {
  try {
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
    const totalHoy = await MessageLog.countDocuments({ tenant_id: req.user.tenant_id, fecha: { $gte: hoy } });
    const totalMes  = await MessageLog.countDocuments({ tenant_id: req.user.tenant_id, fecha: { $gte: inicioMes } });
    const tenant = await Tenant.findById(req.user.tenant_id);
    const plan   = PLANES[tenant?.plan] || PLANES.basico;
    res.json({ hoy: totalHoy, mes: totalMes, plan: { nombre: plan.nombre, limite_mensajes: plan.mensajes_mes, usados: totalMes, restantes: Math.max(plan.mensajes_mes - totalMes, 0), porcentaje_usado: Math.min(Math.round((totalMes / plan.mensajes_mes) * 100), 100), agotado: totalMes >= plan.mensajes_mes } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// ===== ODOO =====
// =============================================
const ODOO_URL  = process.env.ODOO_URL  || 'alba.capouilliez.edu.gt';
const ODOO_DB   = process.env.ODOO_DB   || '';
const ODOO_USER_ODOO = process.env.ODOO_USER || 'admin';
const ODOO_PASS_ODOO = process.env.ODOO_PASSWORD || '';
let odooUID = null;

function odooRPC(path, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'call', id: Math.floor(Math.random() * 99999), params });
    const options = { hostname: ODOO_URL, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { const p = JSON.parse(d); if (p.error) reject(new Error(JSON.stringify(p.error))); else resolve(p.result); } catch(e) { reject(e); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function getOdooUID() {
  if (odooUID) return odooUID;
  const uid = await odooRPC('/jsonrpc', { service: 'common', method: 'authenticate', args: [ODOO_DB, ODOO_USER_ODOO, ODOO_PASS_ODOO, {}] });
  if (!uid) throw new Error('Odoo auth fallida — revisa ODOO_DB, ODOO_USER y ODOO_PASSWORD en Railway');
  odooUID = uid; // solo cachear si fue exitoso
  return odooUID;
}

async function odooCallLocal(model, method, args, kwargs = {}) {
  const uid = await getOdooUID();
  return odooRPC('/jsonrpc', { service: 'object', method: 'execute_kw', args: [ODOO_DB, uid, ODOO_PASS_ODOO, model, method, args, kwargs] });
}

app.get('/api/cotizaciones', authMiddleware, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.tenant_id);
    const teamId = tenant?.odoo_team_id || 1;
    const periodo = req.query.periodo || 'mes';
    const ahora = new Date(); let fechaDesde = new Date();
    if (periodo === 'hoy') { fechaDesde.setHours(0,0,0,0); }
    else if (periodo === 'semana') { fechaDesde.setDate(ahora.getDate()-7); }
    else { fechaDesde.setDate(1); fechaDesde.setHours(0,0,0,0); }
    const fechaOdoo = fechaDesde.toISOString().replace('T',' ').substring(0,19);
    const cotizaciones = await odooCallLocal('sale.order','search_read',[[['team_id','=',teamId],['create_date','>=',fechaOdoo]]],{ fields:['name','partner_id','amount_total','state','create_date'], order:'create_date desc', limit:50 });
    const ganadas = cotizaciones.filter(c => c.state==='sale'||c.state==='done');
    const totalVentas = ganadas.reduce((s,c) => s+(c.amount_total||0), 0);
    res.json({ ok:true, periodo, resumen:{ totalVentas: Math.round(totalVentas*100)/100, totalCotizaciones:cotizaciones.length, cotizacionesGanadas:ganadas.length, ticketPromedio: ganadas.length ? Math.round(totalVentas/ganadas.length*100)/100 : 0 }, cotizaciones: cotizaciones.map(c => ({ id:c.id, nombre:c.name, cliente:c.partner_id?.[1]||'Sin nombre', monto:c.amount_total||0, estado:c.state, fecha:c.create_date })) });
  } catch (err) { res.json({ ok:false, error:err.message, resumen:{ totalVentas:0, totalCotizaciones:0, cotizacionesGanadas:0, ticketPromedio:0 }, cotizaciones:[] }); }
});

app.get('/api/crm-leads', authMiddleware, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.tenant_id);
    const leads = await odooCallLocal('crm.lead','search_read',[[['team_id','=',tenant?.odoo_team_id||1],['active','=',true]]],{ fields:['name','phone','stage_id','partner_name','create_date'], order:'create_date desc', limit:100 });
    const porEtapa = {}; leads.forEach(l => { const e = l.stage_id?.[1]||'Sin etapa'; porEtapa[e]=(porEtapa[e]||0)+1; });
    res.json({ ok:true, total:leads.length, porEtapa, leads });
  } catch (err) { res.json({ ok:false, total:0, porEtapa:{}, leads:[] }); }
});

// ===== FAQs =====
app.get('/api/faqs',    authMiddleware, async (req, res) => { try { res.json(await FAQ.find({ tenant_id: req.user.tenant_id, activo: true }).sort({ creado: -1 })); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/faqs',   authMiddleware, async (req, res) => { try { const { pregunta, respuesta, categoria } = req.body; if (!pregunta||!respuesta) return res.status(400).json({ error: 'Pregunta y respuesta requeridas' }); res.json({ ok:true, faq: await FAQ.create({ tenant_id: req.user.tenant_id, pregunta, respuesta, categoria: categoria||'general' }) }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.put('/api/faqs/:id', authMiddleware, async (req, res) => { try { res.json({ ok:true, faq: await FAQ.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, req.body, { new:true }) }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.delete('/api/faqs/:id', authMiddleware, async (req, res) => { try { await FAQ.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, { activo: false }); res.json({ ok:true }); } catch (err) { res.status(500).json({ error: err.message }); } });

// ===== DOCUMENTOS =====
app.get('/api/documentos',     authMiddleware, async (req, res) => { try { res.json(await Documento.find({ tenant_id: req.user.tenant_id, activo: true }).sort({ creado: -1 })); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/documentos',    authMiddleware, async (req, res) => { try { const { nombre, tipo, contenido } = req.body; if (!nombre||!contenido) return res.status(400).json({ error: 'Nombre y contenido requeridos' }); res.json({ ok:true, doc: await Documento.create({ tenant_id: req.user.tenant_id, nombre, tipo: tipo||'general', contenido }) }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.put('/api/documentos/:id', authMiddleware, async (req, res) => { try { res.json({ ok:true, doc: await Documento.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, req.body, { new:true }) }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.delete('/api/documentos/:id', authMiddleware, async (req, res) => { try { await Documento.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, { activo: false }); res.json({ ok:true }); } catch (err) { res.status(500).json({ error: err.message }); } });

// ===== LEADS DETALLADOS =====
app.get('/api/leads-detallados', authMiddleware, async (req, res) => { try { const { estado } = req.query; const filtro = { tenant_id: req.user.tenant_id }; if (estado) filtro.estado = estado; res.json(await LeadDetallado.find(filtro).sort({ fecha: -1 }).limit(100)); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/leads-detallados', authMiddleware, async (req, res) => { try { res.json({ ok:true, lead: await LeadDetallado.create({ tenant_id: req.user.tenant_id, ...req.body }) }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.put('/api/leads-detallados/:id', authMiddleware, async (req, res) => { try { res.json({ ok:true, lead: await LeadDetallado.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, { ...req.body, ultima_interaccion: new Date() }, { new:true }) }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/leads-stats', authMiddleware, async (req, res) => { try { const tid = req.user.tenant_id; const estados = ['nuevo','contactado','visita_agendada','inscrito','perdido']; const counts = await Promise.all(estados.map(e => LeadDetallado.countDocuments({ tenant_id: tid, estado: e }))); const pipeline = {}; estados.forEach((e,i) => pipeline[e] = counts[i]); res.json({ total: counts.reduce((a,b)=>a+b,0), pipeline }); } catch (err) { res.status(500).json({ error: err.message }); } });

// ===== AGENDAR CITA =====
app.post('/api/agendar-cita', async (req, res) => {
  try {
    const { nombre, telefono, grado, fecha, hora, tipo, sede } = req.body;
    if (!nombre||!telefono||!fecha) return res.status(400).json({ error: 'Nombre, teléfono y fecha requeridos' });
    let leadId = null;
    try {
      const leads = await odooCallLocal('crm.lead','search_read',[[['phone','=',telefono],['active','=',true]]],{ fields:['id','name'], limit:1 });
      if (leads.length) { leadId = leads[0].id; }
      else { leadId = await odooCallLocal('crm.lead','create',[{ name:`Open House — ${nombre}`, phone:telefono, partner_name:nombre, description:`Interés: ${grado||'N/A'}\nTipo: ${tipo||'open_house'}`, team_id:1 }]); }
      const fechaHora = `${fecha} ${hora?.replace(' AM','').replace(' PM','')||'09:00'}:00`;
      await odooCallLocal('mail.activity','create',[{ res_model:'crm.lead', res_id:leadId, activity_type_id:1, summary:`Open House — ${grado}`, note:`Padre: ${nombre}\nTel: ${telefono}\nGrado: ${grado}\nFecha: ${fecha} ${hora}`, date_deadline:fecha, user_id:2 }]);
    } catch (odooErr) { console.error('⚠️ Odoo cita:', odooErr.message); }

    // Guardar en MongoDB también
    try {
      const tenantId = req.body.tenant_id;
      await Cita.create({ tenant_id: tenantId, nombre, telefono, grado, sede: sede||'Sede Central', fecha, hora: hora||'09:00 AM', tipo: tipo||'open_house', estado: 'confirmada' });
    } catch(e) { console.warn('Cita MongoDB:', e.message); }

    res.json({ ok:true, odoo_id:leadId, mensaje:`Cita agendada para ${nombre} el ${fecha} a las ${hora}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== CITAS — GET y gestión =====
app.get('/api/citas', authMiddleware, async (req, res) => {
  try {
    const citas = await Cita.find({ tenant_id: req.user.tenant_id }).sort({ creado: -1 }).limit(100);
    res.json({ ok: true, citas });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/citas/:id', authMiddleware, async (req, res) => {
  try {
    const cita = await Cita.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.user.tenant_id },
      req.body, { new: true }
    );
    res.json({ ok: true, cita });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== CAMPAÑA DE PRUEBA — enviar mensaje a un número =====
app.post('/api/campana/prueba', authMiddleware, async (req, res) => {
  try {
    const { telefono, mensaje } = req.body;
    if (!telefono || !mensaje) return res.status(400).json({ error: 'Teléfono y mensaje requeridos' });

    const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
    const TOKEN_WA = process.env.WHATSAPP_TOKEN;

    if (!PHONE_ID || !TOKEN_WA) {
      return res.status(400).json({ error: 'WhatsApp no configurado. Agrega WHATSAPP_PHONE_ID y WHATSAPP_TOKEN en Railway.' });
    }

    const https = require('https');
    const body = JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono.replace(/\D/g,''),
      type: 'text',
      text: { body: mensaje }
    });

    const result = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: 'graph.facebook.com',
        path: `/v19.0/${PHONE_ID}/messages`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TOKEN_WA}`,
          'Content-Length': Buffer.byteLength(body)
        }
      }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d }); } });
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    if (result.messages) {
      res.json({ ok: true, mensaje: 'Mensaje enviado correctamente', id: result.messages[0]?.id });
    } else {
      res.status(400).json({ ok: false, error: result.error?.message || 'Error al enviar', detalle: result });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ===== EXTRACCIÓN DE TEXTO VIA CLAUDE API =====
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/documentos/extraer-texto', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No se recibió archivo' });

    const filename = req.file.originalname.toLowerCase();
    const base64 = req.file.buffer.toString('base64');

    // TXT — leer directo sin Claude
    if (filename.endsWith('.txt')) {
      const texto = req.file.buffer.toString('utf-8');
      return res.json({ ok: true, texto, caracteres: texto.length });
    }

    // PDF o DOCX — usar Claude para extraer texto
    const mediaType = filename.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    const postData = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          {
            type: 'text',
            text: 'Extrae TODO el texto de este documento. Devuelve SOLO el texto extraído, sin comentarios, sin formato markdown, sin explicaciones. Si hay tablas, conviértelas a texto plano. Si hay imágenes con texto, inclúyelo también.'
          }
        ]
      }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const texto = await new Promise((resolve, reject) => {
      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.content?.[0]?.text || null);
          } catch(e) { resolve(null); }
        });
      });
      apiReq.on('error', reject);
      apiReq.write(postData);
      apiReq.end();
    });

    if (!texto) return res.json({ ok: false, error: 'No se pudo extraer texto. Pega el contenido manualmente.' });

    res.json({ ok: true, texto: texto.trim(), caracteres: texto.length });

  } catch(err) {
    console.error('Error extracción:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== ADMIN =====
app.get('/api/leads', async (req, res) => { res.json(await Lead.find().sort({ fecha: -1 }).limit(50)); });
app.get('/tenants', async (req, res) => { res.json(await Tenant.find()); });
app.post('/tenant', async (req, res) => { try { res.json({ ok:true, tenant: await new Tenant(req.body).save() }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.put('/tenant/:id', async (req, res) => { try { res.json({ ok:true, tenant: await Tenant.findByIdAndUpdate(req.params.id, req.body, { new:true }) }); } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/api/admin/limites', async (req, res) => {
  try {
    const tenants = await Tenant.find({ activo: true });
    const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
    const resumen = await Promise.all(tenants.map(async (t) => {
      const usado = await MessageLog.countDocuments({ tenant_id: t._id, fecha: { $gte: inicioMes } });
      const plan  = PLANES[t.plan] || PLANES.basico;
      return { nombre:t.nombre, plan:t.plan, usado, limite:plan.mensajes_mes, porcentaje:Math.round((usado/plan.mensajes_mes)*100), agotado:usado>=plan.mensajes_mes, restante:Math.max(plan.mensajes_mes-usado,0) };
    }));
    res.json({ mes: new Date().toLocaleDateString('es-GT',{ month:'long', year:'numeric' }), tenants: resumen });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/test', (req, res) => res.send('OK'));

// ===== ODOO PRODUCCIÓN — CAPOUILLIEZ =====
app.get('/api/odoo/test', authMiddleware, async (req, res) => {
  try {
    const info = await testConexion();
    if (!info) return res.status(500).json({ ok: false, error: 'No se pudo conectar a Odoo' });
    res.json({ ok: true, version: info.server_version, serie: info.server_serie });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Leer TODOS los campos de un lead específico por ID
// Leer mensajes del chatter de un lead y parsear datos del padre
app.get('/api/odoo/leer-mensajes/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // Leer los mensajes del lead
    const mensajes = await odooCallLocal('mail.message', 'search_read',
      [[['res_id', '=', id], ['model', '=', 'crm.lead'], ['message_type', 'in', ['email', 'comment']]]],
      { fields: ['body', 'date', 'author_id', 'message_type'], limit: 10, order: 'date asc' }
    ) || [];

    // Parsear el cuerpo HTML para extraer datos del formulario
    const datosParseados = {};
    let esAdmisiones = false;
    const TEMAS_ADMISIONES = ['admisiones','inscripcion','inscripción','colegio','primaria','preprimaria','secundaria','bachillerato','kinder','jardin','jardín','cuota','matricula'];

    for (const msg of mensajes) {
      const body = (msg.body || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      const bodyLower = body.toLowerCase();

      // Detectar si es sobre admisiones
      if (TEMAS_ADMISIONES.some(t => bodyLower.includes(t))) esAdmisiones = true;

      // Buscar patrones
      // Parser — el texto viene como "Nombre Carlos Escobar Correo email Teléfono 12345 Tema X Mensaje Y"
      // Separamos por palabras clave conocidas
      const KEYS = ['nombre','correo','n\u00famero de telefono','n\u00famero de tel\u00e9fono','telefono','tel\u00e9fono','celular','tema','asunto','mensaje','nivel','grado','lead'];
      const keysRegex = new RegExp('(' + KEYS.join('|') + ')\\s+', 'gi');
      const partes = body.replace(keysRegex, '|||$1|||').split('|||').filter(Boolean);
      
      for (let i = 0; i < partes.length; i++) {
        const llave = partes[i].trim().toLowerCase();
        const valor = (partes[i+1]||'').trim();
        if (!valor) continue;
        
        if (llave === 'nombre' && !datosParseados.nombre) {
          datosParseados.nombre = valor.replace(/[|]+.*/,'').trim();
          i++;
        } else if ((llave === 'correo' || llave === 'email') && !datosParseados.correo) {
          const em = valor.match(/[\w\.\-]+@[\w\.\-]+\.\w+/);
          if (em && !em[0].includes('capouilliez')) { datosParseados.correo = em[0]; i++; }
        } else if (llave.includes('tel') || llave.includes('n\u00famero') || llave === 'celular') {
          if (!datosParseados.telefono) {
            const num = valor.replace(/\D/g,'');
            if (num.length >= 8) { datosParseados.telefono = num.length === 8 ? '502'+num : num; i++; }
          }
        } else if ((llave === 'tema' || llave === 'asunto') && !datosParseados.tema) {
          datosParseados.tema = valor.replace(/[|]+.*/,'').trim(); i++;
        } else if (llave === 'mensaje' && !datosParseados.mensaje) {
          datosParseados.mensaje = valor.replace(/[|]+.*/,'').trim().substring(0,200); i++;
        } else if ((llave === 'nivel' || llave === 'grado') && !datosParseados.nivel) {
          // Limpiar basura — tomar solo la primera palabra/frase antes de signos de pregunta o undefined
          const nivelLimpio = valor.replace(/[|]+.*/,'').replace(/\s*¿.*$/,'').replace(/undefined/gi,'').trim();
          if (nivelLimpio) { datosParseados.nivel = nivelLimpio; i++; }
        }
      }

      // Fallbacks con regex
      if (!datosParseados.correo) {
        const em = body.match(/[\w\.\-]+@[\w\.\-]+\.\w+/);
        if (em && !em[0].includes('capouilliez')) datosParseados.correo = em[0];
      }
      if (!datosParseados.telefono) {
        const t = body.match(/\b([2345]\d{7})\b/);
        if (t) datosParseados.telefono = '502' + t[1];
      }
    }

    res.json({
      ok: true,
      lead_id: id,
      es_admisiones: esAdmisiones,
      mensajes: mensajes.map(m => ({
        fecha: m.date,
        autor: m.author_id?.[1],
        cuerpo: (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g,' ').trim().substring(0, 500)
      })),
      datos_parseados: datosParseados
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Actualizar lead en Odoo con datos parseados del formulario
// Traduce lo que llegue como "nivel" (español, variantes) al ID real del registro en
// el modelo capouilliez.carrer — el campo visible en pantalla es capo_level_of_interests
// (many2many, plural), NO capo_level_of_interest (singular, que está comentado/oculto
// en la vista y por eso nunca se veía aunque la escritura "funcionara").
// IDs confirmados en Odoo: 1=Preprimaria, 2=Primaria, 3=Básico, 4=Bachillerato en
// Ciencias y Letras, 13=Diversificado. (Se ignoran los duplicados/typos: 5 y 14).
const CARRERA_IDS = {
  PREPRIMARIA: 1,
  PRIMARIA: 2,
  BASICO: 3,
  BACHILLERATO: 4,
  DIVERSIFICADO: 13
};

function normalizarNivelOdoo(valor) {
  const v = String(valor || '').toLowerCase().trim();
  if (/pre.?primaria|preprimaria|kinder|inicial|infantil|maternal|p[aá]rvulos/.test(v)) {
    return { ids: [CARRERA_IDS.PREPRIMARIA], aproximado: false };
  }
  if (/primaria/.test(v)) {
    return { ids: [CARRERA_IDS.PRIMARIA], aproximado: false };
  }
  if (/b[aá]sico/.test(v)) {
    return { ids: [CARRERA_IDS.BASICO], aproximado: false };
  }
  if (/bachillerato/.test(v)) {
    return { ids: [CARRERA_IDS.BACHILLERATO], aproximado: false };
  }
  if (/diversificado/.test(v)) {
    return { ids: [CARRERA_IDS.DIVERSIFICADO], aproximado: false };
  }
  if (/secundaria/.test(v)) {
    // "Secundaria" genérico no distingue Básico/Bachillerato/Diversificado en este
    // colegio — usamos Básico como el más cercano, pero avisamos que es aproximado.
    return { ids: [CARRERA_IDS.BASICO], aproximado: true };
  }
  return null;
}

app.post('/api/odoo/actualizar-lead', authMiddleware, async (req, res) => {
  try {
    const { lead_id, nombre, telefono, correo, nivel, zona } = req.body;
    if (!lead_id) return res.status(400).json({ ok: false, error: 'lead_id requerido' });

    const updates = {};
    if (nombre) updates.contact_name = nombre; // corregido: antes iba a partner_name (Nombre de compañía), no al "Nombre del contacto"
    if (telefono) updates.phone = telefono;
    if (correo) updates.email_from = correo;
    if (zona) updates.x_studio_notas_1 = zona;

    let nivelNoReconocido = null;
    let nivelAproximado = false;
    if (nivel) {
      const resultado = normalizarNivelOdoo(nivel);
      if (resultado) {
        updates.capo_level_of_interests = [[6, 0, resultado.ids]]; // comando many2many: reemplaza con estos IDs
        nivelAproximado = resultado.aproximado;
      } else {
        nivelNoReconocido = nivel; // se avisa en la respuesta, no se escribe para no mandar un valor inválido
      }
    }

    await odooCallLocal('crm.lead', 'write', [[lead_id], updates]);
    await odooCallLocal('crm.lead', 'message_post', [[lead_id]], {
      body: `📋 Datos actualizados desde el panel KAI: ${Object.entries(updates).filter(([k])=>k!=='capo_level_of_interests').map(([k,v])=>`${k}: ${v}`).join(', ')}${updates.capo_level_of_interests ? `, Nivel: ${nivel}` : ''}`
    }).catch(()=>{});

    res.json({
      ok: true,
      mensaje: 'Lead actualizado en Odoo correctamente',
      aviso_nivel: nivelNoReconocido
        ? `El valor de Nivel "${nivelNoReconocido}" no se reconoció (se esperaba algo como Preprimaria/Primaria/Básico/Bachillerato/Diversificado) — no se escribió para evitar un dato inválido.`
        : (nivelAproximado ? `El valor "${nivel}" se guardó como "Básico" por aproximación — este colegio distingue Básico/Bachillerato/Diversificado dentro de Secundaria. Revisar si corresponde.` : null)
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/odoo/leads/:id/detalle', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'ID requerido' });

    // Primero obtener los campos disponibles en el modelo
    const campos = await odooCallLocal('crm.lead', 'fields_get', [], { attributes: ['string', 'type'] });

    // Leer el lead con todos sus campos
    const leads = await odooCallLocal('crm.lead', 'read', [[id]], {});

    if (!leads || !leads.length) return res.status(404).json({ ok: false, error: 'Lead no encontrado' });

    const lead = leads[0];

    // Filtrar campos vacíos para no saturar la respuesta
    const datosFiltrados = {};
    for (const [campo, valor] of Object.entries(lead)) {
      if (valor !== false && valor !== null && valor !== '' && valor !== undefined) {
        datosFiltrados[campo] = {
          valor,
          etiqueta: campos[campo]?.string || campo,
          tipo: campos[campo]?.type || 'unknown'
        };
      }
    }

    res.json({ ok: true, id, total_campos: Object.keys(datosFiltrados).length, datos: datosFiltrados });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/odoo/leads', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const leads = await getLeads(limit);
    if (!leads) return res.status(500).json({ ok: false, error: 'Error al traer leads' });
    res.json({ ok: true, total: leads.length, leads });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/leads/perdidos', authMiddleware, async (req, res) => {
  try {
    const leads = await getLeadsPerdidos(500);
    res.json({ ok: true, total: leads?.length||0, leads: leads||[] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/stages', authMiddleware, async (req, res) => {
  try {
    const stages = await getStages();
    res.json({ ok: true, stages: stages||[] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/teams', authMiddleware, async (req, res) => {
  try {
    const teams = await getTeams();
    res.json({ ok: true, teams: teams||[] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/lost-reasons', authMiddleware, async (req, res) => {
  try {
    const reasons = await getLostReasons();
    res.json({ ok: true, reasons: reasons||[] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/tags', authMiddleware, async (req, res) => {
  try {
    const tags = await getTags();
    res.json({ ok: true, tags: tags||[] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/usuarios', authMiddleware, async (req, res) => {
  try {
    const usuarios = await getUsuarios();
    res.json({ ok: true, usuarios: usuarios||[] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ===== IMÁGENES DE MARKETING — gestión y envío =====

// Subir una imagen nueva (base64 enviado desde el panel)
// Carga masiva de imágenes — solo admin — recibe array de imágenes
// Eliminar TODAS las imágenes (activas e inactivas) y recargar el seed
app.post('/api/imagenes/reset', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const eliminadas = await ImagenMarketing.deleteMany({ tenant_id: req.user.tenant_id });
    // Recargar seed inmediatamente
    await seedImagenes();
    const total = await ImagenMarketing.countDocuments({ tenant_id: req.user.tenant_id, activo: true });
    res.json({ ok: true, eliminadas: eliminadas.deletedCount, recargadas: total });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/imagenes/bulk', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo admin' });
    const { imagenes } = req.body;
    if (!Array.isArray(imagenes) || !imagenes.length) return res.status(400).json({ ok: false, error: 'Array de imágenes requerido' });

    const resultados = [];
    for (const img of imagenes) {
      // Verificar si ya existe una imagen con ese nombre para no duplicar
      const existe = await ImagenMarketing.findOne({ tenant_id: req.user.tenant_id, nombre: img.nombre });
      if (existe) { resultados.push({ nombre: img.nombre, status: 'ya existe' }); continue; }
      await ImagenMarketing.create({
        tenant_id: req.user.tenant_id,
        nombre: img.nombre,
        categoria: img.categoria || 'general',
        nivel_educativo: img.nivel_educativo || 'Todos',
        imagen_base64: img.imagen_base64,
        mime_type: img.mime_type || 'image/jpeg',
        subida_por_nombre: 'Admin — carga masiva'
      });
      resultados.push({ nombre: img.nombre, status: 'creada' });
    }
    const creadas = resultados.filter(r => r.status === 'creada').length;
    res.json({ ok: true, mensaje: `${creadas} imágenes subidas, ${resultados.length - creadas} ya existían`, resultados });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/imagenes', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'vendedor'].includes(req.user.role)) return res.status(403).json({ ok: false, error: 'Sin permisos' });
    const { nombre, categoria, nivel_educativo, imagen_base64, mime_type } = req.body;
    if (!nombre || !imagen_base64) return res.status(400).json({ ok: false, error: 'Nombre e imagen son requeridos' });

    const img = await ImagenMarketing.create({
      tenant_id: req.user.tenant_id,
      nombre, categoria: categoria || 'general', nivel_educativo: nivel_educativo || 'Todos',
      imagen_base64, mime_type: mime_type || 'image/jpeg',
      subida_por: req.user.id, subida_por_nombre: req.user.nombre || req.user.email
    });
    res.json({ ok: true, imagen: { _id: img._id, nombre: img.nombre, categoria: img.categoria, nivel_educativo: img.nivel_educativo } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Listar imágenes (sin el base64 completo, para que la lista cargue rápido)
app.get('/api/imagenes', authMiddleware, async (req, res) => {
  try {
    const { categoria, nivel_educativo } = req.query;
    const filtro = { tenant_id: req.user.tenant_id, activo: true };
    if (categoria) filtro.categoria = categoria;
    if (nivel_educativo) filtro.nivel_educativo = nivel_educativo;
    const imagenes = await ImagenMarketing.find(filtro).select('-imagen_base64').sort({ creado: -1 });
    res.json({ ok: true, imagenes });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Ver una imagen específica (con su base64, para previsualizar)
app.get('/api/imagenes/:id', authMiddleware, async (req, res) => {
  try {
    const img = await ImagenMarketing.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!img) return res.status(404).json({ ok: false, error: 'No encontrada' });
    res.json({ ok: true, imagen: img });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Eliminar (desactivar) una imagen
app.delete('/api/imagenes/:id', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'vendedor'].includes(req.user.role)) return res.status(403).json({ ok: false, error: 'Sin permisos' });
    await ImagenMarketing.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, { activo: false });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ===== ENVÍO DE PRUEBA — manda una imagen y/o texto a un número de prueba antes de la campaña real =====
app.post('/api/campana/prueba-numero', authMiddleware, async (req, res) => {
  try {
    const { numero_prueba, mensaje, imagen_id } = req.body;
    if (!numero_prueba) return res.status(400).json({ ok: false, error: 'Número de prueba requerido' });

    const resultados = {};

    if (mensaje) {
      const r = await enviarWhatsAppMeta(numero_prueba, mensaje);
      resultados.texto = r?.messages ? { ok: true, id: r.messages[0]?.id } : { ok: false, error: r?.error?.message || 'Error enviando texto' };
    }

    if (imagen_id) {
      const img = await ImagenMarketing.findOne({ _id: imagen_id, tenant_id: req.user.tenant_id });
      if (!img) {
        resultados.imagen = { ok: false, error: 'Imagen no encontrada' };
      } else {
        resultados.imagen = await enviarImagenDesdeDB(img, numero_prueba, mensaje && !resultados.texto ? mensaje : '');
      }
    }

    res.json({ ok: true, mensaje: 'Prueba enviada — revisa el WhatsApp del número de prueba', resultados });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ===== CAMPAÑA MASIVA REAL — envía a todos los contactos que cumplan los filtros =====
app.post('/api/campana/enviar', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores pueden enviar campañas masivas' });

    const { mensaje, imagen_id, filtros, confirmar } = req.body;
    if (!mensaje && !imagen_id) return res.status(400).json({ ok: false, error: 'Se requiere mensaje o imagen' });
    if (!confirmar) return res.status(400).json({ ok: false, error: 'Debes confirmar el envío (confirmar:true) — esta acción no se puede deshacer' });

    // Construir el filtro de destinatarios — SIEMPRE exige consentimiento de marketing
    const filtroContactos = { tenant_id: req.user.tenant_id, acepta_marketing: true };
    if (filtros?.nivel_calor) filtroContactos.nivel_calor = filtros.nivel_calor;
    if (filtros?.segmento) filtroContactos.segmento_reactivacion = filtros.segmento;
    if (filtros?.zona) filtroContactos.zona = new RegExp(filtros.zona, 'i');
    if (filtros?.nivel_interes) filtroContactos.nivel_interes = new RegExp(filtros.nivel_interes, 'i');

    const destinatarios = await Contacto.find(filtroContactos).limit(1000);
    if (!destinatarios.length) return res.json({ ok: true, mensaje: 'No hay destinatarios que cumplan los filtros', total_enviados: 0 });

    let imagenDoc = null;
    if (imagen_id) {
      imagenDoc = await ImagenMarketing.findOne({ _id: imagen_id, tenant_id: req.user.tenant_id });
      if (!imagenDoc) return res.status(404).json({ ok: false, error: 'Imagen no encontrada' });
    }

    // Enviar en segundo plano para no bloquear la respuesta HTTP
    res.json({ ok: true, mensaje: `Campaña iniciada — enviando a ${destinatarios.length} contacto(s) en segundo plano`, total_destinatarios: destinatarios.length });

    (async () => {
      let exitosos = 0, fallidos = 0;
      const PAUSA_MS = 3000; // 3 segundos entre envíos — Meta recomienda no más de 20/min para evitar bloqueos
      const TOPE_DIARIO = 200; // nunca más de 200 mensajes por día en un mismo número

      // Verificar tope diario — contar cuántos enviamos hoy ya
      const hoyInicio = new Date(); hoyInicio.setHours(0,0,0,0);
      const enviadosHoy = await Contacto.countDocuments({
        tenant_id: req.user.tenant_id,
        ultima_campana_enviada: { $gte: hoyInicio }
      });
      const disponibles = Math.max(0, TOPE_DIARIO - enviadosHoy);
      if (disponibles === 0) {
        console.log(`⚠️ Tope diario de ${TOPE_DIARIO} mensajes alcanzado — campaña cancelada`);
        return;
      }
      const destinatariosLimitados = destinatarios.slice(0, disponibles);
      if (destinatariosLimitados.length < destinatarios.length) {
        console.log(`⚠️ Campaña limitada a ${disponibles} envíos (tope diario de ${TOPE_DIARIO})`);
      }

      for (const c of destinatariosLimitados) {
        // No enviar a contactos que llevan más de 60 días sin responder (segmento frío) — alto riesgo de bloqueo
        if (c.segmento_reactivacion === 'frio' && !filtros?.segmento) {
          console.log(`⏭️ Saltando ${c.numero} — segmento frío (60+ días sin actividad)`);
          continue;
        }
        try {
          if (imagenDoc) {
            await enviarImagenDesdeDB(imagenDoc, c.numero, mensaje || '');
          } else {
            await enviarWhatsAppMeta(c.numero, mensaje);
          }
          c.ultima_campana_enviada = new Date();
          c.campanas_recibidas = (c.campanas_recibidas || 0) + 1;
          await c.save();
          exitosos++;
        } catch (e) { fallidos++; console.error(`❌ Error enviando campaña a ${c.numero}:`, e.message); }
        await new Promise(r => setTimeout(r, PAUSA_MS)); // pausa entre envíos
      }
      console.log(`📣 Campaña finalizada — ${exitosos} exitosos, ${fallidos} fallidos de ${destinatariosLimitados.length} destinatarios`);
    })();

  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});



// Listar contactos con filtros: nivel de calor, segmento de reactivación, zona, nivel educativo, consentimiento
// ===== LEAD ADS — recibe notificación de Facebook cuando alguien llena un formulario de Lead Ad =====
app.post('/api/lead-ads', async (req, res) => {
  res.sendStatus(200);
  try {
    const { leadgen_id, page_id } = req.body.entry?.[0]?.changes?.[0]?.value || {};
    if (!leadgen_id) return;

    // Consultar los datos del formulario a la Graph API de Meta
    const TOKEN_PAGE = process.env.MESSENGER_PAGE_TOKEN || process.env.WHATSAPP_TOKEN;
    const leadData = await new Promise((resolve) => {
      const req2 = https.request({
        hostname: 'graph.facebook.com',
        path: `/v22.0/${leadgen_id}?access_token=${TOKEN_PAGE}`,
        method: 'GET'
      }, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){resolve(null)} }); });
      req2.on('error', ()=>resolve(null)); req2.end();
    });

    if (!leadData?.field_data) return;

    const campos = {};
    leadData.field_data.forEach(f => { campos[f.name] = f.values?.[0]; });
    const nombre = campos.full_name || campos.first_name || 'Sin nombre';
    const telefono = (campos.phone_number || '').replace(/\D/g,'');
    const correo = campos.email || null;
    const nivel = campos.grado_interes || campos.nivel || null;

    const tenant = await Tenant.findOne({ activo: true });
    if (!tenant) return;

    // Crear/actualizar contacto con canal lead_ads
    const numero = telefono ? `502${telefono.slice(-8)}` : `fb_lead_${leadgen_id}`;
    let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero });
    if (!contacto) {
      contacto = await Contacto.create({
        tenant_id: tenant._id, numero,
        nombre, correo, nivel_interes: nivel,
        canal_origen: 'lead_ads',
        ultimo_contacto: new Date(), primer_contacto: new Date(), total_conversaciones: 1
      });
    }

    // Crear lead en Odoo directamente con los datos del formulario
    if (!contacto.odoo_lead_id) {
      const tagId = await getOdooTagId('Canal — Lead Ads Facebook');
      const leadId = await odooCallLocal('crm.lead', 'create', [{
        name: `Lead Ads — ${nombre}`,
        phone: telefono || null,
        email_from: correo || null,
        partner_name: nombre,
        description: `Formulario de Lead Ad completado.\nNivel de interés: ${nivel || 'No especificado'}\nCapturado automáticamente por KAI.`,
        team_id: tenant?.odoo_team_id || 1,
        type: 'opportunity',
        tag_ids: tagId ? [[6, 0, [tagId]]] : undefined
      }]);
      if (leadId) { contacto.odoo_lead_id = leadId; await contacto.save(); }
    }
    console.log(`✅ Lead Ads procesado — ${nombre} (${telefono})`);
  } catch (e) { console.error('❌ Lead Ads webhook:', e.message); }
});

// ===== FORMULARIO WEB — el webmaster agrega un fetch() al botón de envío del formulario =====
app.post('/api/lead-web', async (req, res) => {
  try {
    const { nombre, telefono, correo, nivel_interes, mensaje } = req.body;
    if (!nombre && !telefono && !correo) return res.status(400).json({ ok: false, error: 'Se requiere al menos nombre, teléfono o correo' });

    const tenant = await Tenant.findOne({ activo: true });
    if (!tenant) return res.status(500).json({ ok: false, error: 'Tenant no encontrado' });

    const numero = telefono ? `502${String(telefono).replace(/\D/g,'').slice(-8)}` : `web_${Date.now()}`;
    let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero });
    if (!contacto) {
      contacto = await Contacto.create({
        tenant_id: tenant._id, numero,
        nombre: nombre || null, correo: correo || null,
        nivel_interes: nivel_interes || null,
        canal_origen: 'formulario',
        ultimo_contacto: new Date(), primer_contacto: new Date(), total_conversaciones: 1
      });
    }

    if (!contacto.odoo_lead_id) {
      const tagId = await getOdooTagId('Canal — Formulario Web');
      const leadId = await odooCallLocal('crm.lead', 'create', [{
        name: `Formulario Web — ${nombre || correo || telefono}`,
        phone: telefono || null,
        email_from: correo || null,
        partner_name: nombre || null,
        description: `Formulario web completado.\n${mensaje ? 'Mensaje: ' + mensaje : ''}\nNivel de interés: ${nivel_interes || 'No especificado'}\nCapturado automáticamente por KAI.`,
        team_id: tenant?.odoo_team_id || 1,
        type: 'opportunity',
        tag_ids: tagId ? [[6, 0, [tagId]]] : undefined
      }]);
      if (leadId) { contacto.odoo_lead_id = leadId; await contacto.save(); }
    }

    res.json({ ok: true, mensaje: 'Contacto registrado correctamente' });
    console.log(`✅ Formulario web — ${nombre} (${telefono || correo})`);
  } catch (e) {
    console.error('❌ Lead web:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/contactos', authMiddleware, async (req, res) => {
  try {
    const { nivel_calor, segmento, zona, nivel_interes, solo_con_consentimiento } = req.query;
    const filtro = { tenant_id: req.user.tenant_id };
    if (nivel_calor) filtro.nivel_calor = parseInt(nivel_calor);
    if (segmento) filtro.segmento_reactivacion = segmento;
    if (zona) filtro.zona = new RegExp(zona, 'i');
    if (nivel_interes) filtro.nivel_interes = new RegExp(nivel_interes, 'i');
    if (solo_con_consentimiento === 'true') filtro.acepta_marketing = true;

    const contactos = await Contacto.find(filtro).sort({ ultimo_contacto: -1 }).limit(500);
    res.json({ ok: true, total: contactos.length, contactos });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Resumen agregado de segmentos — para mostrar tarjetas en el dashboard de Marketing
app.get('/api/contactos/resumen', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const [porSegmento, porNivelCalor, totalConsentimiento, totalContactos, porCanal] = await Promise.all([
      Contacto.aggregate([{ $match: { tenant_id: tenantId } }, { $group: { _id: '$segmento_reactivacion', total: { $sum: 1 } } }]),
      Contacto.aggregate([{ $match: { tenant_id: tenantId, nivel_calor: { $ne: null } } }, { $group: { _id: '$nivel_calor', total: { $sum: 1 } } }]),
      Contacto.countDocuments({ tenant_id: tenantId, acepta_marketing: true }),
      Contacto.countDocuments({ tenant_id: tenantId }),
      Contacto.aggregate([{ $match: { tenant_id: tenantId } }, { $group: { _id: '$canal_origen', total: { $sum: 1 } } }])
    ]);
    res.json({
      ok: true,
      total_contactos: totalContactos,
      con_consentimiento_marketing: totalConsentimiento,
      por_segmento: Object.fromEntries(porSegmento.map(s => [s._id || 'activo', s.total])),
      por_nivel_calor: Object.fromEntries(porNivelCalor.map(n => [n._id, n.total])),
      por_canal: Object.fromEntries(porCanal.map(c => [c._id || 'whatsapp', c.total]))
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Mensajes no procesados — para detectar si algo falló silenciosamente
// ===== LIMPIAR TAGS KAI DE ODOO — para corregir etiquetado incorrecto =====
app.post('/api/odoo/limpiar-tags-kai', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const { tag_id } = req.body;
    if (!tag_id) return res.status(400).json({ ok: false, error: 'tag_id requerido' });

    // Buscar todos los leads que tienen este tag
    const leads = await odooCallLocal('crm.lead', 'search_read',
      [[['tag_ids', 'in', [tag_id]]]],
      { fields: ['id', 'name', 'tag_ids'], limit: 1000 }
    ) || [];

    if (!leads.length) return res.json({ ok: true, mensaje: 'No hay leads con ese tag', total: 0 });

    // Quitar el tag de cada lead (comando 3 = remove)
    const ids = leads.map(l => l.id);
    await odooCallLocal('crm.lead', 'write', [ids, {
      tag_ids: [[3, tag_id]] // comando 3 = quitar este tag sin tocar los demás
    }]);

    res.json({ ok: true, mensaje: `Tag eliminado de ${ids.length} leads correctamente`, total: ids.length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Contactar un lead específico con KAI por WhatsApp
app.post('/api/motor/contactar-lead', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const { lead_id, telefono } = req.body;
    if (!lead_id || !telefono) return res.status(400).json({ ok: false, error: 'lead_id y telefono requeridos' });

    const tenant = await Tenant.findOne({ _id: req.user.tenant_id });
    const tagContactadoId = await getOdooTagId(TAG_KAI_CONTACTADO);
    const tagSinWAId = await getOdooTagId(TAG_KAI_SIN_WHATSAPP);

    // Obtener datos del lead
    const leads = await odooCallLocal('crm.lead', 'read', [[lead_id]], {});
    if (!leads?.length) return res.status(404).json({ ok: false, error: 'Lead no encontrado' });
    const lead = leads[0];

    let telefonoLimpio = String(telefono).replace(/\D/g, '');
    if (telefonoLimpio.length === 8) telefonoLimpio = '502' + telefonoLimpio;

    const nombre = lead.partner_name || lead.contact_name || null;
    const primerNombre = nombre ? nombre.split(' ')[0] : null;
    const saludo = primerNombre ? `Hola ${primerNombre}` : 'Hola';
    const mensaje = `${saludo} 👋 Te escribimos del *Colegio Capouilliez*.\n\nRecibimos tu información y queremos ayudarte con el proceso de admisiones 🏫\n\n¿Para qué nivel educativo estás buscando información?\n\n1️⃣ Preprimaria (2-6 años)\n2️⃣ Primaria (7-12 años)\n3️⃣ Secundaria (13-16 años)`;

    const resultado = await enviarWhatsAppMeta(telefonoLimpio, mensaje);
    if (resultado?.messages?.length) {
      await odooCallLocal('crm.lead', 'write', [[lead_id], { tag_ids: [[4, tagContactadoId]] }]);
      await odooCallLocal('crm.lead', 'message_post', [[lead_id]], {
        body: `📱 KAI contactó por WhatsApp (${telefonoLimpio}) — iniciado manualmente desde el panel.`
      }).catch(() => {});

      // Crear contacto en MongoDB si no existe
      let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero: telefonoLimpio });
      if (!contacto) {
        await Contacto.create({ tenant_id: tenant._id, numero: telefonoLimpio, nombre, odoo_lead_id: lead_id, canal_origen: 'lead_ads', ultimo_contacto: new Date(), primer_contacto: new Date() });
      }
      res.json({ ok: true, mensaje: `KAI contactó a ${nombre||telefonoLimpio} por WhatsApp` });
    } else {
      await odooCallLocal('crm.lead', 'write', [[lead_id], { tag_ids: [[4, tagSinWAId]] }]);
      res.json({ ok: false, error: 'No se pudo enviar el mensaje — número inválido o fuera de la ventana de 24h' });
    }
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Asignar un lead a un vendedor específico
app.post('/api/motor/asignar-vendedor', authMiddleware, async (req, res) => {
  try {
    const { lead_id, vendedor_id } = req.body;
    if (!lead_id || !vendedor_id) return res.status(400).json({ ok: false, error: 'lead_id y vendedor_id requeridos' });

    const vendedor = await UsuarioPanel.findOne({ _id: vendedor_id, tenant_id: req.user.tenant_id });
    if (!vendedor) return res.status(404).json({ ok: false, error: 'Vendedor no encontrado' });

    // Registrar nota en Odoo
    await odooCallLocal('crm.lead', 'message_post', [[lead_id]], {
      body: `👤 Lead asignado manualmente desde el panel KAI a ${vendedor.nombre || vendedor.email}.`
    }).catch(() => {});

    // Si el vendedor tiene odoo_user_id, asignarlo en Odoo también
    if (vendedor.odoo_user_id) {
      await odooCallLocal('crm.lead', 'write', [[lead_id], { user_id: vendedor.odoo_user_id }]).catch(() => {});
    }

    res.json({ ok: true, mensaje: `Lead asignado a ${vendedor.nombre || vendedor.email}` });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== ESCÁNER DE LEADS — ver qué hay en Odoo antes de contactar =====
app.get('/api/motor/escanear', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const tagContactadoId = await getOdooTagId(TAG_KAI_CONTACTADO);
    const tagSinWAId = await getOdooTagId(TAG_KAI_SIN_WHATSAPP);

    // Leads SIN ASIGNAR de los últimos 30 días — igual que vista "Sin asignar" en Odoo
    const hace30d = new Date(Date.now() - 30*24*60*60*1000).toISOString().replace('T',' ').substring(0,19);
    const pendientes = await odooCallLocal('crm.lead', 'search_read',
      [[
        ['active', '=', true],
        ['user_id', '=', false],
        ['create_date', '>=', hace30d],
      ]],
      { fields: ['id','name','phone','mobile','partner_name','contact_name','email_from','stage_id','tag_ids','user_id','create_date','type','team_id','fb_form_id','x_studio_comentarios','x_studio_notas_1'], limit: 200 }
    ) || [];

    const contactados = [];

    // Leads sin WhatsApp válido
    const sinWA = await odooCallLocal('crm.lead', 'search_read',
      [[['type','=','opportunity'],['tag_ids','in',[tagSinWAId]]]],
      { fields: ['id','name','phone','partner_name'], limit: 50 }
    ) || [];

    res.json({
      ok: true,
      resumen: {
        pendientes_de_contactar: pendientes.length,
  
        sin_whatsapp_valido: sinWA.length
      },
      pendientes: pendientes.map(l => ({
        id: l.id,
        nombre: l.name,
        contacto: l.partner_name || l.contact_name || null,
        telefono: (l.mobile && String(l.mobile) !== 'false') ? l.mobile : ((l.phone && String(l.phone) !== 'false') ? l.phone : null),
        email: l.email_from || null,
        nivel: l.x_studio_comentarios || null,
        zona: l.x_studio_notas_1 || null,
        formulario: l.fb_form_id?.[1] || null,
        equipo: l.team_id?.[1] || null,
        tipo: l.type || null,
        fecha_creacion: l.create_date?.substring(0,16)
      })),
      contactados: contactados.map(l => ({ id: l.id, nombre: l.partner_name || l.name, telefono: l.phone })),
      sin_whatsapp: sinWA.map(l => ({ id: l.id, nombre: l.partner_name || l.name, telefono: l.phone }))
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== PRUEBA DEL MOTOR — enviar a UN número específico sin tocar leads reales =====
app.post('/api/motor/prueba', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const { telefono, nombre } = req.body;
    if (!telefono) return res.status(400).json({ ok: false, error: 'Teléfono requerido' });

    const telefonoLimpio = String(telefono).replace(/\D/g,'');
    const tel = telefonoLimpio.length === 8 ? '502' + telefonoLimpio : telefonoLimpio;
    const primerNombre = nombre ? nombre.split(' ')[0] : null;
    const saludo = primerNombre ? `Hola ${primerNombre}` : 'Hola';

    const mensaje = `${saludo} 👋 Te escribimos del *Colegio Capouilliez*.\n\nRecibimos tu información y queremos ayudarte con el proceso de admisiones 🏫\n\n¿Para qué nivel educativo estás buscando información?\n\n1️⃣ Preprimaria (2-6 años)\n2️⃣ Primaria (7-12 años)\n3️⃣ Secundaria (13-16 años)`;

    const resultado = await enviarWhatsAppMeta(tel, mensaje);

    if (resultado?.messages?.length) {
      res.json({ ok: true, mensaje: `✅ Mensaje enviado a ${tel}`, whatsapp_id: resultado.messages[0].id });
    } else {
      res.json({ ok: false, error: 'Meta no confirmó el envío', detalle: resultado });
    }
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== ACTIVAR MOTOR MANUALMENTE — sin esperar los 30 min =====
app.post('/api/motor/activar', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    res.json({ ok: true, mensaje: 'Motor de contacto proactivo iniciado — revisa los logs de Railway' });
    motorContactoProactivo(); // corre en segundo plano
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== DASHBOARD DE MONITOREO — para Sylvia =====
app.get('/api/monitoreo/dashboard', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const ahora = new Date();
    const hace1h = new Date(ahora - 60*60*1000);
    const hace24h = new Date(ahora - 24*60*60*1000);

    // Chats activos por asesora
    const chatsActivos = await Conversacion.aggregate([
      { $match: { tenant_id: tenantId, estado: { $in: ['humano', 'esperando_agente'] } } },
      { $group: { _id: '$agente_nombre', total: { $sum: 1 }, ids: { $push: '$_id' } } }
    ]);

    // Chats sin respuesta hace más de 30 minutos
    const hace30min = new Date(ahora - 30*60*1000);
    const sinRespuesta = await Conversacion.find({
      tenant_id: tenantId,
      estado: { $in: ['humano', 'esperando_agente'] },
      ultimaActividad: { $lt: hace30min }
    }).select('numero nombre agente_nombre ultimaActividad');

    // Tiempo promedio de respuesta por asesora (últimas 24h)
    const convs24h = await Conversacion.find({
      tenant_id: tenantId,
      estado: { $ne: 'bot' },
      creado: { $gte: hace24h }
    }).select('agente_nombre mensajes creado ultimaActividad');

    // Calcular tiempo promedio de primera respuesta por asesora
    const tiemposPorAgente = {};
    convs24h.forEach(conv => {
      if (!conv.agente_nombre || !conv.mensajes?.length) return;
      const primerMsgPadre = conv.mensajes.find(m => m.de === 'padre');
      const primerRespAgente = conv.mensajes.find(m => m.de === 'agente');
      if (primerMsgPadre && primerRespAgente) {
        const espera = new Date(primerRespAgente.fecha) - new Date(primerMsgPadre.fecha);
        if (espera > 0) {
          if (!tiemposPorAgente[conv.agente_nombre]) tiemposPorAgente[conv.agente_nombre] = [];
          tiemposPorAgente[conv.agente_nombre].push(Math.round(espera / 60000)); // en minutos
        }
      }
    });

    const promediosPorAgente = Object.entries(tiemposPorAgente).map(([agente, tiempos]) => ({
      agente,
      promedio_minutos: Math.round(tiempos.reduce((a,b)=>a+b,0) / tiempos.length),
      total_atendidos: tiempos.length
    }));

    // Resumen general
    const totalActivos = await Conversacion.countDocuments({ tenant_id: tenantId, estado: { $in: ['humano','esperando_agente'] } });
    const totalBot = await Conversacion.countDocuments({ tenant_id: tenantId, estado: 'bot' });
    const totalHoy = await Conversacion.countDocuments({ tenant_id: tenantId, creado: { $gte: hace24h } });

    res.json({
      ok: true,
      resumen: {
        chats_activos_total: totalActivos,
        chats_con_kai: totalBot,
        chats_nuevos_24h: totalHoy,
        sin_respuesta_30min: sinRespuesta.length
      },
      por_asesora: chatsActivos.map(a => ({
        asesora: a._id || 'Sin asignar',
        chats_activos: a.total
      })),
      sin_respuesta: sinRespuesta.map(c => ({
        numero: c.numero,
        nombre: c.nombre || 'Sin nombre',
        asesora: c.agente_nombre || 'Sin asignar',
        minutos_sin_respuesta: Math.round((ahora - new Date(c.ultimaActividad)) / 60000)
      })),
      tiempos_respuesta: promediosPorAgente
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== ACRUXLAB CHATROOM — Diagnóstico y lectura de mensajes =====

// Paso 1: Diagnóstico — confirmar que podemos leer acrux.chat.message
app.get('/api/debug/acrux-mensajes', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });

    // Leer los últimos 10 mensajes entrantes (from_me = false = del padre)
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[['from_me', '=', false]]],
      {
        fields: ['id', 'text', 'date_message', 'contact_name', 'contact_number', 'from_me', 'msgid', 'read_date', 'event'],
        limit: 10,
        order: 'date_message desc'
      }
    );

    if (!mensajes) return res.json({ ok: false, error: 'No se pudo leer acrux.chat.message — verificar permisos' });

    res.json({
      ok: true,
      total_leidos: mensajes.length,
      mensaje: 'Lectura exitosa de AcruxLab ChatRoom',
      mensajes: mensajes.map(m => ({
        id: m.id,
        fecha: m.date_message,
        de: m.contact_name || m.contact_number,
        texto: (m.text || '').substring(0, 100),
        leido: !!m.read_date,
        evento: m.event
      }))
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, nota: 'Si el error es "Model not found", AcruxLab no está instalado o el usuario no tiene permisos' });
  }
});

// Paso 2: Leer conversaciones activas del ChatRoom
// Nota: el modelo "acrux.chat.conversation" puede no existir con ese nombre exacto
// en esta instalación de AcruxLab (o el usuario Odoo no tiene permiso sobre él).
// Por eso separamos cada intento en su propio try/catch: si "conversation" falla,
// igual devolvemos algo útil armando conversaciones a partir de acrux.chat.message
// (que ya confirmamos que SÍ funciona), agrupando por contact_number.
app.get('/api/debug/acrux-conversaciones', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });

  const resultado = { ok: true, modelo_conversation: { disponible: false }, fallback_agrupado: null };

  // Intento 1: modelo dedicado acrux.chat.conversation (puede no existir)
  try {
    const campos = await odooCallLocal('acrux.chat.conversation', 'fields_get', [], { attributes: ['string', 'type'] });
    const camposDisponibles = campos ? Object.keys(campos).slice(0, 30) : [];
    const convs = await odooCallLocal('acrux.chat.conversation', 'search_read',
      [[]],
      { fields: ['id', 'create_date', 'write_date'], limit: 5, order: 'write_date desc' }
    );
    resultado.modelo_conversation = {
      disponible: true,
      campos_disponibles: camposDisponibles,
      total: convs ? convs.length : 0,
      conversaciones: convs || []
    };
  } catch (e) {
    resultado.modelo_conversation = {
      disponible: false,
      error: e.message,
      nota: 'No se pudo usar acrux.chat.conversation. Puede que el nombre del modelo sea otro, o que no exista como tal. Usar el fallback agrupado en su lugar.'
    };
  }

  // Intento 2 (fallback confiable): agrupar acrux.chat.message por contact_number
  try {
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[]],
      { fields: ['id', 'text', 'date_message', 'contact_name', 'contact_number', 'from_me'], limit: 200, order: 'date_message desc' }
    );
    const porNumero = {};
    (mensajes || []).forEach(m => {
      const num = m.contact_number || 'sin_numero';
      if (!porNumero[num]) porNumero[num] = { numero: num, nombre: m.contact_name || num, total_mensajes: 0, ultimo_mensaje: null, ultima_fecha: null };
      porNumero[num].total_mensajes++;
      if (!porNumero[num].ultima_fecha || m.date_message > porNumero[num].ultima_fecha) {
        porNumero[num].ultima_fecha = m.date_message;
        porNumero[num].ultimo_mensaje = (m.text || '').substring(0, 100);
      }
    });
    resultado.fallback_agrupado = {
      disponible: true,
      total_conversaciones: Object.keys(porNumero).length,
      conversaciones: Object.values(porNumero).sort((a, b) => (b.ultima_fecha || '').localeCompare(a.ultima_fecha || ''))
    };
  } catch (e) {
    resultado.fallback_agrupado = { disponible: false, error: e.message };
  }

  res.json(resultado);
});

// Paso 3: Método de envío — probar que podemos responder por AcruxLab
app.post('/api/debug/acrux-enviar-prueba', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const { conversation_id, texto } = req.body;
    if (!conversation_id || !texto) return res.status(400).json({ ok: false, error: 'conversation_id y texto requeridos' });

    // Intentar enviar por el método de AcruxLab
    const resultado = await odooCallLocal('acrux.chat.conversation', 'action_send_message',
      [[parseInt(conversation_id)], texto]
    );

    res.json({ ok: true, resultado, nota: 'Si resultado es null pero no hay error, el mensaje se envió' });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, nota: 'El método action_send_message puede tener un nombre diferente en tu versión de AcruxLab' });
  }
});

// ===== ACRUXLAB CHATROOM — Lectura real para el panel (Fase 1: solo lectura) =====
// Estos endpoints NO escriben nada en Odoo. Solo leen acrux.chat.message y arman
// conversaciones agrupando por contact_number, para mostrarlas en "Chats en Vivo".
// Cuando se autorice la Fase 2 (KAI respondiendo por este número), se agregará
// un endpoint de envío aparte — este bloque se queda solo de lectura.

// Extrae el número de WhatsApp del msgid, formato típico: "false_50256338598@c.us_XXXXX"
function extraerNumeroDeMsgid(msgid) {
  const m = String(msgid || '').match(/_(\d{8,15})@/);
  return m ? m[1] : null;
}

// ===== MÉTRICAS DE ATENCIÓN (vista gerencial) — solo lectura =====
// Calcula, a partir de los mensajes reales de AcruxLab:
// - Tiempo de primera respuesta por conversación (desde el primer mensaje del padre
//   hasta la primera respuesta humana), agregado por agente.
// - Volumen de conversaciones atendidas por cada agente.
// - Conversaciones que llevan mensaje del padre sin ninguna respuesta todavía.
// Helper: métricas de AcruxLab para un rango de fechas específico (reutilizable
// para el periodo actual, el periodo anterior de comparación, y la tendencia diaria).
async function calcularMetricasAcruxPeriodo(desdeISO, hastaISO) {
  const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
    [[['date_message', '>=', desdeISO], ['date_message', '<', hastaISO]]],
    { fields: ['contact_id', 'from_me', 'date_message'], limit: 20000, order: 'date_message asc' }
  ) || [];

  const porContacto = {};
  mensajes.forEach(m => {
    if (!m.contact_id) return;
    const id = m.contact_id[0];
    if (!porContacto[id]) porContacto[id] = [];
    porContacto[id].push(m);
  });

  let total = 0, sinResponder = 0;
  const tiempos = [];
  const porDia = {}; // 'YYYY-MM-DD' -> { conversaciones, tiempos: [] }

  Object.values(porContacto).forEach(msgs => {
    total++;
    const primerPadre = msgs.find(m => !m.from_me);
    if (!primerPadre) return;
    const dia = primerPadre.date_message.substring(0, 10);
    if (!porDia[dia]) porDia[dia] = { conversaciones: 0, tiempos: [] };
    porDia[dia].conversaciones++;

    const primeraRespuesta = msgs.find(m => m.from_me && m.date_message > primerPadre.date_message);
    if (!primeraRespuesta) { sinResponder++; return; }
    const minutos = (new Date(primeraRespuesta.date_message.replace(' ', 'T') + 'Z') - new Date(primerPadre.date_message.replace(' ', 'T') + 'Z')) / 60000;
    tiempos.push(minutos);
    porDia[dia].tiempos.push(minutos);
  });

  const promedio = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
  return {
    total_conversaciones: total,
    tiempo_promedio_min: promedio(tiempos),
    sin_responder: sinResponder,
    por_dia: Object.entries(porDia).map(([fecha, d]) => ({ fecha, conversaciones: d.conversaciones, tiempo_promedio_min: promedio(d.tiempos) }))
  };
}

// Helper: métricas de un canal de Meta (whatsapp/instagram/messenger), guardado en Mongo.
async function calcularMetricasMongoPeriodo(canal, desdeDate, hastaDate, tenantId) {
  const conversaciones = await Conversacion.find({
    tenant_id: tenantId, canal, creado: { $gte: desdeDate, $lt: hastaDate }
  }).select('mensajes estado creado').lean();

  let total = 0, sinResponder = 0, cerradas = 0;
  const tiempos = [];
  const porDia = {};

  conversaciones.forEach(conv => {
    total++;
    if (conv.estado === 'cerrado') cerradas++;
    const msgs = (conv.mensajes || []).slice().sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    const primerPadre = msgs.find(m => m.de === 'padre');
    if (!primerPadre) return;
    const dia = new Date(primerPadre.fecha).toISOString().substring(0, 10);
    if (!porDia[dia]) porDia[dia] = { conversaciones: 0, tiempos: [] };
    porDia[dia].conversaciones++;

    const primeraRespuesta = msgs.find(m => m.de === 'agente' && new Date(m.fecha) > new Date(primerPadre.fecha));
    if (!primeraRespuesta) { sinResponder++; return; }
    const minutos = (new Date(primeraRespuesta.fecha) - new Date(primerPadre.fecha)) / 60000;
    tiempos.push(minutos);
    porDia[dia].tiempos.push(minutos);
  });

  const promedio = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
  return {
    total_conversaciones: total,
    tiempo_promedio_min: promedio(tiempos),
    sin_responder: sinResponder,
    cerradas,
    por_dia: Object.entries(porDia).map(([fecha, d]) => ({ fecha, conversaciones: d.conversaciones, tiempo_promedio_min: promedio(d.tiempos) }))
  };
}

// ===== MÉTRICAS GENERALES (todos los canales) — vista gerencial consolidada =====
// Combina AcruxLab (Odoo) + WhatsApp/Instagram/Messenger (Mongo): por canal,
// comparación contra el periodo anterior, y tendencia diaria combinada.
// NOTA sobre "conversión": para WhatsApp/IG/Messenger se usa el estado "cerrado"
// como aproximación (no confirma inscripción real, solo que se marcó resuelta).
// Para AcruxLab todavía no tenemos un campo confiable de "ganado" — falta confirmarlo.
app.get('/api/metricas-generales', authMiddleware, async (req, res) => {
  try {
    const dias = Math.min(parseInt(req.query.dias) || 7, 90);
    const ahora = new Date();
    const desdeActual = new Date(ahora.getTime() - dias * 86400000);
    const desdeAnterior = new Date(desdeActual.getTime() - dias * 86400000);

    const desdeActualISO = desdeActual.toISOString().replace('T', ' ').substring(0, 19);
    const hastaActualISO = ahora.toISOString().replace('T', ' ').substring(0, 19);
    const desdeAnteriorISO = desdeAnterior.toISOString().replace('T', ' ').substring(0, 19);

    const [acruxActual, acruxAnterior, waActual, waAnterior, igActual, igAnterior, fbActual, fbAnterior] = await Promise.all([
      calcularMetricasAcruxPeriodo(desdeActualISO, hastaActualISO),
      calcularMetricasAcruxPeriodo(desdeAnteriorISO, desdeActualISO),
      calcularMetricasMongoPeriodo('whatsapp', desdeActual, ahora, req.user.tenant_id),
      calcularMetricasMongoPeriodo('whatsapp', desdeAnterior, desdeActual, req.user.tenant_id),
      calcularMetricasMongoPeriodo('instagram', desdeActual, ahora, req.user.tenant_id),
      calcularMetricasMongoPeriodo('instagram', desdeAnterior, desdeActual, req.user.tenant_id),
      calcularMetricasMongoPeriodo('messenger', desdeActual, ahora, req.user.tenant_id),
      calcularMetricasMongoPeriodo('messenger', desdeAnterior, desdeActual, req.user.tenant_id)
    ]);

    const promedio = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
    const cambioPct = (actual, anterior) => (anterior && anterior > 0) ? Math.round(((actual - anterior) / anterior) * 1000) / 10 : null;

    const porCanal = [
      { canal: 'AcruxLab (Número Oficial)', ...acruxActual, tasa_cierre_pct: null },
      { canal: 'WhatsApp', ...waActual, tasa_cierre_pct: waActual.total_conversaciones ? Math.round(waActual.cerradas / waActual.total_conversaciones * 1000) / 10 : null },
      { canal: 'Instagram', ...igActual, tasa_cierre_pct: igActual.total_conversaciones ? Math.round(igActual.cerradas / igActual.total_conversaciones * 1000) / 10 : null },
      { canal: 'Messenger', ...fbActual, tasa_cierre_pct: fbActual.total_conversaciones ? Math.round(fbActual.cerradas / fbActual.total_conversaciones * 1000) / 10 : null }
    ];

    const totalActual = acruxActual.total_conversaciones + waActual.total_conversaciones + igActual.total_conversaciones + fbActual.total_conversaciones;
    const totalAnterior = acruxAnterior.total_conversaciones + waAnterior.total_conversaciones + igAnterior.total_conversaciones + fbAnterior.total_conversaciones;
    const tiempoPromActual = promedio([acruxActual, waActual, igActual, fbActual].flatMap(c => c.tiempo_promedio_min != null ? [c.tiempo_promedio_min] : []));
    const tiempoPromAnterior = promedio([acruxAnterior, waAnterior, igAnterior, fbAnterior].flatMap(c => c.tiempo_promedio_min != null ? [c.tiempo_promedio_min] : []));

    // Tendencia diaria combinada (todos los canales juntos, por fecha)
    const combinarPorDia = {};
    [acruxActual, waActual, igActual, fbActual].forEach(c => {
      (c.por_dia || []).forEach(d => {
        if (!combinarPorDia[d.fecha]) combinarPorDia[d.fecha] = { conversaciones: 0, tiempos: [] };
        combinarPorDia[d.fecha].conversaciones += d.conversaciones;
        if (d.tiempo_promedio_min != null) combinarPorDia[d.fecha].tiempos.push(d.tiempo_promedio_min);
      });
    });
    const tendenciaDiaria = Object.entries(combinarPorDia)
      .map(([fecha, d]) => ({ fecha, conversaciones: d.conversaciones, tiempo_promedio_min: promedio(d.tiempos) }))
      .sort((a, b) => a.fecha.localeCompare(b.fecha));

    const cerradasTotal = waActual.cerradas + igActual.cerradas + fbActual.cerradas;
    const totalConCierre = waActual.total_conversaciones + igActual.total_conversaciones + fbActual.total_conversaciones;

    res.json({
      ok: true,
      periodo_dias: dias,
      resumen_general: {
        total_conversaciones: totalActual,
        tiempo_promedio_min: tiempoPromActual,
        sin_responder_aun: acruxActual.sin_responder + waActual.sin_responder + igActual.sin_responder + fbActual.sin_responder
      },
      comparacion_periodo_anterior: {
        conversaciones_cambio_pct: cambioPct(totalActual, totalAnterior),
        tiempo_respuesta_cambio_pct: cambioPct(tiempoPromActual, tiempoPromAnterior)
      },
      por_canal: porCanal,
      tendencia_diaria: tendenciaDiaria,
      tasa_cierre_aproximada: {
        nota: 'Solo disponible para WhatsApp/Instagram/Messenger (estado "cerrado" en el panel). AcruxLab aún no tiene un campo confiable de resultado/ganado confirmado.',
        porcentaje: totalConCierre ? Math.round(cerradasTotal / totalConCierre * 1000) / 10 : null
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/acrux/metricas', authMiddleware, async (req, res) => {
  try {
    const dias = Math.min(parseInt(req.query.dias) || 30, 90);
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[['date_message', '>=', desde]]],
      { fields: ['contact_id', 'from_me', 'date_message', 'user_id', 'ttype'], limit: 20000, order: 'date_message asc' }
    ) || [];

    const porContacto = {};
    mensajes.forEach(m => {
      if (!m.contact_id) return;
      const id = m.contact_id[0];
      if (!porContacto[id]) porContacto[id] = { nombre: m.contact_id[1], mensajes: [] };
      porContacto[id].mensajes.push(m);
    });

    const porAgente = {}; // { nombre: { conversaciones: Set, tiemposRespuestaMin: [], mensajesEnviados: 0 } }
    let sinResponderAun = 0;
    let totalConversaciones = 0;
    const tiemposGenerales = [];

    Object.values(porContacto).forEach(conv => {
      totalConversaciones++;
      const msgs = conv.mensajes; // ya vienen ordenados asc por fecha
      const primerPadre = msgs.find(m => !m.from_me);
      if (!primerPadre) return; // conversación sin ningún mensaje del padre en el rango

      const primeraRespuesta = msgs.find(m => m.from_me && m.date_message > primerPadre.date_message && m.user_id);
      if (!primeraRespuesta) { sinResponderAun++; return; }

      const minutos = (new Date(primeraRespuesta.date_message.replace(' ', 'T') + 'Z') - new Date(primerPadre.date_message.replace(' ', 'T') + 'Z')) / 60000;
      tiemposGenerales.push(minutos);

      const agente = primeraRespuesta.user_id[1];
      if (!porAgente[agente]) porAgente[agente] = { conversaciones: new Set(), tiemposRespuestaMin: [], mensajesEnviados: 0 };
      porAgente[agente].conversaciones.add(conv.nombre);
      porAgente[agente].tiemposRespuestaMin.push(minutos);
    });

    // Volumen total de mensajes enviados por cada agente (no solo la primera respuesta)
    mensajes.forEach(m => {
      if (m.from_me && m.user_id) {
        const agente = m.user_id[1];
        if (!porAgente[agente]) porAgente[agente] = { conversaciones: new Set(), tiemposRespuestaMin: [], mensajesEnviados: 0 };
        porAgente[agente].mensajesEnviados++;
      }
    });

    const promedio = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;

    const resultado = Object.entries(porAgente).map(([agente, d]) => ({
      agente,
      conversaciones_atendidas: d.conversaciones.size,
      tiempo_promedio_primera_respuesta_min: promedio(d.tiemposRespuestaMin),
      mensajes_enviados: d.mensajesEnviados
    })).sort((a, b) => b.conversaciones_atendidas - a.conversaciones_atendidas);

    res.json({
      ok: true,
      periodo_dias: dias,
      resumen_general: {
        total_conversaciones: totalConversaciones,
        tiempo_promedio_primera_respuesta_min: promedio(tiemposGenerales),
        sin_responder_aun: sinResponderAun
      },
      por_agente: resultado
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/acrux/conversaciones', authMiddleware, async (req, res) => {
  try {
    const limite = Math.min(parseInt(req.query.limit) || 300, 1000);
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[]],
      { fields: ['id', 'text', 'date_message', 'contact_id', 'msgid', 'from_me', 'read_date', 'user_id'], limit: limite, order: 'date_message desc' }
    );

    if (!mensajes) return res.json({ ok: false, error: 'No se pudo leer acrux.chat.message' });

    const porContacto = {};
    mensajes.forEach(m => {
      // contact_id viene como [id, "Nombre"] cuando existe, o false si el mensaje no tiene contacto vinculado
      if (!m.contact_id) return;
      const contactoId = m.contact_id[0];
      if (!porContacto[contactoId]) {
        porContacto[contactoId] = {
          contacto_id: contactoId,
          nombre: m.contact_id[1] || 'Sin nombre',
          numero: extraerNumeroDeMsgid(m.msgid),
          total_mensajes: 0,
          no_leidos: 0,
          ultimo_mensaje: null,
          ultima_fecha: null,
          ultimo_de: null,
          agente: null, // último agente humano que respondió (user_id del mensaje saliente más reciente)
          etiquetas: [],
          prioridad: '0',
          nota: null
        };
      }
      const c = porContacto[contactoId];
      c.total_mensajes++;
      if (!m.from_me && !m.read_date) c.no_leidos++;
      if (!c.numero) c.numero = extraerNumeroDeMsgid(m.msgid); // por si el primer mensaje encontrado no traía msgid parseable
      if (!c.ultima_fecha || m.date_message > c.ultima_fecha) {
        c.ultima_fecha = m.date_message;
        c.ultimo_mensaje = (m.text || '').substring(0, 120);
        c.ultimo_de = m.from_me ? 'agente' : 'padre';
      }
      if (m.from_me && m.user_id && (!c._fechaAgente || m.date_message > c._fechaAgente)) {
        c.agente = m.user_id[1];
        c._fechaAgente = m.date_message;
      }
    });
    // Limpiar campo auxiliar interno antes de responder
    Object.values(porContacto).forEach(c => { c.agente_fecha = c._fechaAgente || null; delete c._fechaAgente; });

    // Clasificación real (Prioridad/Etiquetas/Nota) — directo desde acrux.chat.conversation
    // en un solo lote, usando los mismos contacto_id que ya tenemos. Ya no se cruza por
    // teléfono contra crm.lead (eso generaba ambigüedad con leads duplicados).
    try {
      const contactoIds = Object.keys(porContacto).map(Number);
      if (contactoIds.length) {
        const conversacionesOdoo = await odooCallLocal('acrux.chat.conversation', 'read',
          [contactoIds, ['id', 'priority', 'tag_ids', 'note']]
        ) || [];

        const idsTagsUsados = [...new Set(conversacionesOdoo.flatMap(c => c.tag_ids || []))];
        let nombresTag = {};
        if (idsTagsUsados.length) {
          const tags = await odooCallLocal('acrux.chat.conversation.tag', 'read', [idsTagsUsados, ['id', 'name']]);
          (tags || []).forEach(t => { nombresTag[t.id] = t.name; });
        }

        conversacionesOdoo.forEach(co => {
          const c = porContacto[co.id];
          if (!c) return;
          c.etiquetas = (co.tag_ids || []).map(id => nombresTag[id]).filter(Boolean);
          c.prioridad = co.priority || '0';
          c.nota = (co.note || '').trim() || null;
        });
      }
    } catch (e) {
      // Si el cruce con Odoo falla, seguimos mostrando los chats sin etiquetas (no bloqueante)
    }

    let conversaciones = Object.values(porContacto).sort((a, b) => (b.ultima_fecha || '').localeCompare(a.ultima_fecha || ''));

    // Filtro por usuario: admin y viewer supervisan todo; vendedor solo ve lo suyo + lo sin atender
    const esSupervisor = req.user.role === 'admin' || req.user.role === 'viewer';
    if (!esSupervisor) {
      const miNombre = (req.user.nombre || '').trim().toLowerCase();
      conversaciones = conversaciones.filter(c => !c.agente || (c.agente || '').trim().toLowerCase() === miNombre);
    }

    res.json({ ok: true, canal: 'acrux_whatsapp', solo_lectura: false, es_supervisor: esSupervisor, total: conversaciones.length, conversaciones });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/acrux/conversaciones/:contactoId', authMiddleware, async (req, res) => {
  try {
    const contactoId = parseInt(req.params.contactoId);
    if (!contactoId) return res.json({ ok: false, error: 'ID de contacto inválido' });

    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[['contact_id', '=', contactoId]]],
      { fields: ['id', 'text', 'date_message', 'contact_id', 'msgid', 'from_me', 'read_date', 'user_id', 'ttype', 'res_model', 'res_id'], limit: 500, order: 'date_message asc' }
    );

    if (!mensajes) return res.json({ ok: false, error: 'No se pudo leer los mensajes de este contacto' });

    // Las imágenes vienen como ttype='image' apuntando a un ir.attachment (res_id) —
    // las traemos en un solo lote y las adjuntamos en base64 a cada mensaje.
    const idsAdjuntos = mensajes.filter(m => m.ttype === 'image' && m.res_model === 'ir.attachment' && m.res_id).map(m => m.res_id);
    let adjuntosPorId = {};
    if (idsAdjuntos.length) {
      try {
        const adjuntos = await odooCallLocal('ir.attachment', 'read', [idsAdjuntos, ['id', 'datas', 'mimetype']]);
        (adjuntos || []).forEach(a => { adjuntosPorId[a.id] = { base64: a.datas, mime: a.mimetype || 'image/jpeg' }; });
      } catch (e) { /* si falla, los mensajes de imagen se muestran solo con su texto */ }
    }

    const numero = mensajes.map(m => extraerNumeroDeMsgid(m.msgid)).find(Boolean) || null;
    const nombre = mensajes.find(m => m.contact_id)?.contact_id?.[1] || null;

    res.json({
      ok: true,
      canal: 'acrux_whatsapp',
      solo_lectura: false, // Fase 2: el agente ya puede responder (ver /api/acrux/responder)
      contacto_id: contactoId,
      numero,
      nombre: nombre || numero || 'Sin nombre',
      mensajes: mensajes.map(m => {
        const adjunto = m.ttype === 'image' ? adjuntosPorId[m.res_id] : null;
        return {
          de: m.from_me ? 'agente' : 'padre',
          texto: m.text || '',
          fecha: m.date_message,
          leido: !!m.read_date,
          agente: m.from_me ? (m.user_id ? m.user_id[1] : null) : null,
          es_imagen: m.ttype === 'image',
          imagen_base64: adjunto?.base64 || null,
          imagen_mime: adjunto?.mime || null
        };
      })
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== ACRUXLAB — Fase 2: el agente responde de verdad por el número oficial =====
// PRIMERA vez que escribimos algo hacia AcruxLab (todo lo anterior era solo lectura).
// Creamos un registro en acrux.chat.message con from_me=true; si el módulo de AcruxLab
// está bien instalado, su propio create()/write() debería disparar el envío real por
// WhatsApp. Esto hay que probarlo con un mensaje de prueba real antes de confiar en él.
// Diagnóstico: revisar el último mensaje SALIENTE (from_me=true) ya creado para un contacto,
// sin tener que mandar otro — útil para ver por qué el que ya se probó no llegó de verdad.
// Diagnóstico: comparar leads duplicados directamente por ID, para confirmar si
// realmente ninguno tiene la Nota llena (y por eso cae al más reciente) o si hay
// algún otro problema en la selección.
// Diagnóstico: ver los campos reales de acrux.chat.conversation (el modelo de la
// conversación, no del mensaje ni del lead). Sospecha: las etiquetas tipo "Cindy"/
// "Infantil" que se ven en el ChatRoom real viven aquí, no en crm.lead.
app.get('/api/debug/acrux-campos-conversacion/:contactoId', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const contactoId = parseInt(req.params.contactoId);
    const campos = await odooCallLocal('acrux.chat.conversation', 'fields_get', [], { attributes: ['string', 'type', 'relation'] });
    const listaCampos = campos ? Object.entries(campos).map(([tecnico, def]) => ({ campo_tecnico: tecnico, etiqueta: def.string, tipo: def.type, relacion: def.relation || null })) : [];

    let registroCompleto = null;
    let etiquetasResueltas = [];
    if (contactoId) {
      const detalle = await odooCallLocal('acrux.chat.conversation', 'read', [[contactoId], []]);
      registroCompleto = detalle?.[0] || null;
      if (registroCompleto?.tag_ids?.length) {
        const tags = await odooCallLocal('acrux.chat.conversation.tag', 'read', [registroCompleto.tag_ids, ['id', 'name', 'color']]);
        etiquetasResueltas = tags || [];
      }
    }

    res.json({ ok: true, total_campos: listaCampos.length, campos: listaCampos, registro: registroCompleto, etiquetas_resueltas: etiquetasResueltas });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/comparar-leads/:ids', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const ids = req.params.ids.split(',').map(Number).filter(Boolean);
    const leads = await odooCallLocal('crm.lead', 'search_read',
      [[['id', 'in', ids]]],
      { fields: ['id', 'name', 'partner_name', 'contact_name', 'type', 'stage_id', 'phone', 'mobile', 'priority', 'tag_ids', 'x_studio_notas_1', 'x_studio_comentarios', 'write_date', 'create_date'] }
    );
    let etiquetas = {};
    const idsTagsUsados = [...new Set((leads || []).flatMap(l => l.tag_ids || []))];
    if (idsTagsUsados.length) {
      const tags = await odooCallLocal('crm.tag', 'search_read', [[['id', 'in', idsTagsUsados]]], { fields: ['id', 'name'] });
      (tags || []).forEach(t => { etiquetas[t.id] = t.name; });
    }
    res.json({ ok: true, leads: (leads || []).map(l => ({ ...l, tag_ids: (l.tag_ids || []).map(id => etiquetas[id]) })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/acrux-ultimo-saliente/:contactoId', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const contactoId = parseInt(req.params.contactoId);
    const limite = Math.min(parseInt(req.query.limit) || 3, 200);
    const domain = [['contact_id', '=', contactoId]];
    if (req.query.solo_ttype) domain.push(['ttype', '=', req.query.solo_ttype]);
    if (!req.query.todos) domain.push(['from_me', '=', true]);
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [domain],
      { fields: [], limit: limite, order: 'date_message desc' }
    );
    res.json({ ok: true, mensajes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/acrux/responder', authMiddleware, async (req, res) => {
  try {
    const { contacto_id, mensaje } = req.body;
    if (!contacto_id || !mensaje) return res.status(400).json({ ok: false, error: 'contacto_id y mensaje son requeridos' });

    // Llamada real capturada del ChatRoom (Network tab): el envío verdadero es un método
    // propio del modelo acrux.chat.conversation, NO un create() sobre acrux.chat.message.
    // El contexto "is_acrux_chat_room: true" parece ser la bandera que dispara el envío real.
    const resultado = await odooCallLocal(
      'acrux.chat.conversation',
      'send_message',
      [
        [contacto_id],
        {
          text: mensaje,
          from_me: true,
          ttype: 'text',
          res_model: '',
          res_id: 0,
          id: -2,
          date_message: new Date().toISOString().replace('T', ' ').substring(0, 19),
          button_ids: []
        }
      ],
      { context: { lang: 'es_GT', tz: 'America/Guatemala', is_acrux_chat_room: true } }
    );

    // Diagnóstico: releer el último mensaje saliente de este contacto para confirmar
    // que esta vez sí quedó con msgid real (señal de que WhatsApp lo recibió).
    let diagnostico = null;
    try {
      const releido = await odooCallLocal('acrux.chat.message', 'search_read',
        [[['contact_id', '=', contacto_id], ['from_me', '=', true]]],
        { fields: ['id', 'msgid', 'error_msg', 'event', 'try_count', 'date_message'], limit: 1, order: 'date_message desc' }
      );
      diagnostico = releido?.[0] || null;
    } catch (e) {
      diagnostico = { error_al_releer: e.message };
    }

    res.json({
      ok: true,
      resultado,
      diagnostico,
      aviso: 'Mensaje enviado con send_message. Confirma con el destinatario real que le llegó, y revisa que "diagnostico.msgid" ya no venga vacío.'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cruce solo-lectura: dado un número de WhatsApp, buscar el lead de Odoo asociado
// y devolver los campos que Sylvia usa para clasificar (Prioridad / Etiquetas / Nota).
// No escribe nada — únicamente lectura, para mostrarlo junto al chat de AcruxLab.
// ===== CLASIFICACIÓN REAL — directo desde acrux.chat.conversation (no crm.lead) =====
// Descubrimos que Prioridad, Etiquetas y Nota viven en el propio registro de la
// conversación de AcruxLab, identificado por el mismo contacto_id que ya usamos.
// Esto reemplaza el cruce por teléfono contra crm.lead (que dependía de encontrar
// el lead correcto entre posibles duplicados) — aquí no hay ambigüedad posible.
app.get('/api/acrux/clasificacion/:contactoId', authMiddleware, async (req, res) => {
  try {
    const contactoId = parseInt(req.params.contactoId);
    if (!contactoId) return res.json({ ok: false, error: 'ID de contacto inválido' });

    const detalle = await odooCallLocal('acrux.chat.conversation', 'read',
      [[contactoId], ['id', 'name', 'number', 'number_format', 'priority', 'tag_ids', 'note', 'status', 'unanswered', 'last_activity', 'partner_info']]
    );
    const conv = detalle?.[0];
    if (!conv) return res.json({ ok: false, error: 'No se encontró la conversación en AcruxLab' });

    let etiquetas = [];
    if (conv.tag_ids && conv.tag_ids.length) {
      const tags = await odooCallLocal('acrux.chat.conversation.tag', 'read', [conv.tag_ids, ['id', 'name']]);
      etiquetas = (tags || []).map(t => t.name);
    }

    // partner_info trae texto libre tipo "Email: x\nTeléfono: y\nUbicación: z"
    let correo = null, ubicacion = null;
    (conv.partner_info || '').split('\n').forEach(linea => {
      if (/^email:/i.test(linea)) correo = linea.split(':').slice(1).join(':').trim();
      if (/^ubicaci/i.test(linea)) ubicacion = linea.split(':').slice(1).join(':').trim();
    });

    res.json({
      ok: true,
      contacto_id: conv.id,
      nombre_contacto: conv.name,
      numero: conv.number_format || conv.number,
      correo,
      ubicacion,
      prioridad: conv.priority || '0',
      etiquetas,
      nota: (conv.note || '').trim() || null,
      estado: conv.status || null,
      sin_responder: !!conv.unanswered,
      ultima_actividad: conv.last_activity || null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/acrux/lead-por-telefono/:numero', authMiddleware, async (req, res) => {
  try {
    const numero = (req.params.numero || '').replace(/\D/g, '').slice(-8); // últimos 8 dígitos, sin +502 ni espacios
    if (!numero) return res.json({ ok: false, error: 'Número inválido' });

    const leads = await odooCallLocal('crm.lead', 'search_read',
      [[['type', 'in', ['lead', 'opportunity']]]],
      { fields: ['id', 'name', 'partner_name', 'contact_name', 'phone', 'mobile', 'email_from', 'city', 'priority', 'tag_ids', 'x_studio_notas_1', 'x_studio_comentarios', 'write_date'], limit: 8000, order: 'write_date desc' }
    ) || [];

    const coincidencias = leads.filter(l => {
      const tel = String(l.phone || '').replace(/\D/g, '').slice(-8);
      const mov = String(l.mobile || '').replace(/\D/g, '').slice(-8);
      return tel === numero || mov === numero;
    });

    if (!coincidencias.length) return res.json({ ok: true, encontrado: false });

    // Puede haber leads duplicados con el mismo teléfono (mismo padre escribiendo por
    // más de un canal — típicamente uno real donde Sylvia trabaja, y otro que KAI crea
    // solo por el canal de Meta). Entre duplicados, preferimos el que tenga la Nota
    // (x_studio_notas_1) llena — ahí es donde vive el nombre real del alumno — en vez
    // de simplemente el más recientemente actualizado, que suele ser el auto-generado.
    const conNota = coincidencias.filter(l => l.x_studio_notas_1 && l.x_studio_notas_1.trim());
    const lead = conNota.length ? conNota[0] : coincidencias[0];

    let etiquetas = [];
    if (lead.tag_ids && lead.tag_ids.length) {
      const tags = await odooCallLocal('crm.tag', 'search_read', [[['id', 'in', lead.tag_ids]]], { fields: ['id', 'name'] });
      etiquetas = (tags || []).map(t => t.name);
    }

    // Respaldo: cuando la Nota real (x_studio_notas_1) todavía está vacía porque Sylvia
    // no ha trabajado este lead a mano, KAI a veces ya dejó el nombre del alumno en el
    // propio nombre del lead, con el patrón "(hijo: NOMBRE)" o "(hija: NOMBRE)".
    const matchHijo = (lead.name || '').match(/\(hij[oa]:\s*([^)]+)\)/i);
    const alumnoDesdeNombreLead = matchHijo ? matchHijo[1].trim() : null;

    res.json({
      ok: true,
      encontrado: true,
      lead_id: lead.id,
      posible_duplicado: coincidencias.length > 1,
      otros_leads_mismo_telefono: coincidencias.length > 1 ? coincidencias.filter(l => l.id !== lead.id).map(l => ({ id: l.id, nombre: l.name, actualizado: l.write_date })) : [],
      // Contacto = el padre/madre/encargado (quien escribe por WhatsApp), NO el alumno
      contacto_nombre: lead.contact_name || lead.partner_name || null,
      contacto_telefono: lead.phone || lead.mobile || null,
      contacto_correo: lead.email_from || null,
      contacto_ubicacion: lead.city || null,
      prioridad: lead.priority || '0', // Odoo: '0'..'3' = número de estrellas
      etiquetas,
      // Nota = donde Sylvia escribe el/los nombre(s) del alumno + anotaciones breves.
      // Si aún está vacía, usamos el nombre del alumno que KAI haya detectado como respaldo.
      nota: lead.x_studio_notas_1 || (alumnoDesdeNombreLead ? `${alumnoDesdeNombreLead} (detectado por KAI, aún sin confirmar por Sylvia)` : null),
      nivel: lead.x_studio_comentarios || null // ⚠️ pendiente #1: este mapeo de "Nivel" está sin confirmar
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== DIAGNÓSTICO — Automatizaciones/alias de Odoo que crean leads desde correo =====
// El formulario de admisiones NO pasa por KAI: llega por correo a capouilliez@gmail.com
// y Odoo lo convierte en lead solo (alias de correo / email-to-lead). Este endpoint es
// SOLO LECTURA — busca qué automatización o alias está mapeando mal "Nombre" y "Nivel",
// para que se corrija desde Odoo Studio (no desde aquí).
// ===== DIAGNÓSTICO — Nombre técnico real de los campos personalizados de crm.lead =====
// Solo lectura. Sirve para identificar, por ejemplo, cuál es el campo técnico real de
// "Nivel" (el que se ve en el formulario de Odoo), para corregir el mapeo en
// /api/odoo/actualizar-lead sin adivinar nombres de campo.
// ===== DIAGNÓSTICO — Campos reales de acrux.chat.message =====
// contact_name / contact_number vienen en false en los mensajes reales — hay que
// encontrar el campo correcto que identifica al contacto/conversación en este modelo.
app.get('/api/debug/acrux-campos-mensaje', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const campos = await odooCallLocal('acrux.chat.message', 'fields_get', [], { attributes: ['string', 'type', 'relation'] });
    if (!campos) return res.json({ ok: false, error: 'No se pudo leer fields_get' });

    const listaCampos = Object.entries(campos).map(([tecnico, def]) => ({
      campo_tecnico: tecnico, etiqueta: def.string, tipo: def.type, relacion: def.relation || null
    }));

    // Traer 1 mensaje completo con TODOS los campos (sin especificar 'fields') para ver qué trae valor real
    const idsMuestra = await odooCallLocal('acrux.chat.message', 'search', [[]], { limit: 1, order: 'date_message desc' });
    let mensajeCompleto = null;
    if (idsMuestra && idsMuestra.length) {
      const detalle = await odooCallLocal('acrux.chat.message', 'read', [idsMuestra, []]);
      mensajeCompleto = detalle?.[0] || null;
    }

    res.json({ ok: true, total_campos: listaCampos.length, campos: listaCampos, mensaje_de_muestra_completo: mensajeCompleto });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Diagnóstico: opciones válidas de un campo tipo "selection" (ej. capo_level_of_interest)
// Diagnóstico: leer la vista de formulario real de "Admisiones" (crm.lead) y buscar
// qué campo técnico corresponde a la etiqueta visible "Nivel" — esto puede ser distinto
// de field.string en fields_get, porque la vista puede sobreescribir la etiqueta mostrada.
app.get('/api/debug/vista-formulario-lead', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const uid = await getOdooUID();

    // Buscar el view_id específico de la acción "Admisiones" (la que se ve en pantalla,
    // action=1018 según la URL) — la vista genérica del modelo puede ser otra distinta.
    let viewIdEspecifico = false;
    try {
      const accion = await odooRPC('/jsonrpc', { service: 'object', method: 'execute_kw', args: [ODOO_DB, uid, ODOO_PASS_ODOO, 'ir.actions.act_window', 'read', [[parseInt(req.query.action_id) || 1018]], { fields: ['view_id', 'views', 'res_model'] }] });
      const act = accion?.[0];
      viewIdEspecifico = act?.view_id?.[0] || (act?.views || []).find(v => v[1] === 'form')?.[0] || false;
    } catch (e) { /* si falla, seguimos con false (vista por defecto) */ }

    let resultado;
    try {
      resultado = await odooRPC('/jsonrpc', { service: 'object', method: 'execute_kw', args: [ODOO_DB, uid, ODOO_PASS_ODOO, 'crm.lead', 'get_views', [[[viewIdEspecifico, 'form']]], { options: {} }] });
    } catch (eInterno) {
      return res.json({ ok: false, error_completo: eInterno.message, nota: 'Falló get_views — revisa el traceback completo aquí abajo', view_id_usado: viewIdEspecifico });
    }
    const arch = resultado?.views?.form?.arch || null;
    if (!arch) return res.json({ ok: false, error: 'No se pudo obtener el arch de la vista', crudo: resultado });

    // Buscar el texto literal "Nivel" donde sea que aparezca, y devolver el contexto
    // alrededor — más confiable que intentar parsear la estructura XML con regex exacto.
    const fragmentos = [];
    const textoBusqueda = arch.toLowerCase();
    let idx = textoBusqueda.indexOf('nivel');
    while (idx !== -1 && fragmentos.length < 15) {
      fragmentos.push(arch.substring(Math.max(0, idx - 120), idx + 130));
      idx = textoBusqueda.indexOf('nivel', idx + 5);
    }

    res.json({ ok: true, view_id_usado: viewIdEspecifico, total_apariciones_de_nivel: fragmentos.length, fragmentos, arch_length: arch.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Diagnóstico: encontrar dónde viven las "respuestas rápidas" del ChatRoom (el panel
// con el rayo ⚡ que ya vimos en capturas). Probamos los candidatos más probables.
app.get('/api/debug/plantillas-chatroom', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const uid = await getOdooUID();
    const resultado = await odooRPC('/jsonrpc', { service: 'object', method: 'execute_kw', args: [ODOO_DB, uid, ODOO_PASS_ODOO, 'acrux.chat.default.answer', 'get_for_chatroom', [], { context: { is_acrux_chat_room: true } }] });
    return res.json({ ok: true, via: 'get_for_chatroom', resultado });
  } catch (eMetodo) {
    // Si el método propio falla, probamos leer el modelo directo como respaldo
    try {
      const registros = await odooCallLocal('acrux.chat.default.answer', 'search_read', [[]], { fields: [], limit: 100 });
      return res.json({ ok: true, via: 'search_read', registros });
    } catch (eModelo) {
      return res.json({ ok: false, error_metodo: eMetodo.message, error_modelo: eModelo.message });
    }
  }
});

app.get('/api/debug/opciones-carrera', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const registros = await odooCallLocal('capouilliez.carrer', 'search_read', [[]], { fields: ['id', 'name'], limit: 50 });
    res.json({ ok: true, registros });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/opciones-campo/:campo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const campos = await odooCallLocal('crm.lead', 'fields_get', [[req.params.campo]], { attributes: ['string', 'type', 'selection'] });
    res.json({ ok: true, campo: campos?.[req.params.campo] || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/campos-crm-lead', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const campos = await odooCallLocal('crm.lead', 'fields_get', [], { attributes: ['string', 'type'] });
    if (!campos) return res.json({ ok: false, error: 'No se pudo leer fields_get de crm.lead' });

    const personalizados = Object.entries(campos)
      .filter(([tecnico]) => tecnico.startsWith('x_studio_'))
      .map(([tecnico, def]) => ({ campo_tecnico: tecnico, etiqueta: def.string, tipo: def.type }));

    // También incluir los estándar más relevantes para nombre/contacto, para comparar
    const estandar = ['name', 'partner_name', 'contact_name', 'phone', 'mobile', 'email_from', 'priority', 'tag_ids']
      .filter(k => campos[k])
      .map(k => ({ campo_tecnico: k, etiqueta: campos[k].string, tipo: campos[k].type }));

    // Búsqueda amplia: cualquier campo (sin importar prefijo técnico) cuya etiqueta
    // contenga "nivel", por si no es un campo x_studio_* como se asumía.
    const todosLosCampos = Object.entries(campos).map(([tecnico, def]) => ({ campo_tecnico: tecnico, etiqueta: def.string, tipo: def.type }));
    const q = (req.query.buscar || 'nivel').toLowerCase();
    const coincidencias = todosLosCampos.filter(c => (c.etiqueta || '').toLowerCase().includes(q));

    res.json({ ok: true, campos_personalizados_studio: personalizados, campos_estandar_relevantes: estandar, busqueda: q, coincidencias_por_etiqueta: coincidencias, total_campos_en_el_modelo: todosLosCampos.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/automatizaciones-crm-lead', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  const resultado = { ok: true };

  // 1) Automatizaciones (base.automation) ligadas al modelo crm.lead
  try {
    const modelos = await odooCallLocal('ir.model', 'search_read', [[['model', '=', 'crm.lead']]], { fields: ['id'], limit: 1 });
    const modeloId = modelos?.[0]?.id;
    const automatizaciones = await odooCallLocal('base.automation', 'search_read',
      [modeloId ? [['model_id', '=', modeloId]] : [['model_id.model', '=', 'crm.lead']]],
      { fields: ['id', 'name', 'active', 'trigger', 'action_server_ids', 'filter_domain'], limit: 50 }
    );
    resultado.automatizaciones = automatizaciones || [];

    // Traer el código/detalle de cada acción de servidor asociada
    const accionIds = [...new Set((automatizaciones || []).flatMap(a => a.action_server_ids || []))];
    if (accionIds.length) {
      const acciones = await odooCallLocal('ir.actions.server', 'search_read',
        [[['id', 'in', accionIds]]],
        { fields: ['id', 'name', 'state', 'code', 'update_field_id', 'update_path', 'value', 'evaluation_type'] }
      );
      resultado.acciones_servidor = acciones || [];
    }
  } catch (e) {
    resultado.automatizaciones_error = e.message;
  }

  // 2) Alias de correo (mail.alias) que apunten a crm.lead — ej. capouilliez@gmail.com / admisiones
  try {
    const alias = await odooCallLocal('mail.alias', 'search_read',
      [[['alias_model_id.model', '=', 'crm.lead']]],
      { fields: ['id', 'alias_name', 'alias_defaults', 'alias_force_thread_id', 'alias_domain'], limit: 20 }
    );
    resultado.alias_correo = alias || [];
  } catch (e) {
    resultado.alias_error = e.message;
  }

  res.json(resultado);
});

app.get('/api/logs/no-procesados', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const logs = await MessageLog.find({
      tenant_id: req.user.tenant_id,
      procesado: false
    }).sort({ fecha: -1 }).limit(50);
    res.json({ ok: true, total: logs.length, logs });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});


// ===== CHATS EN VIVO — handoff a humano =====

// Listar conversaciones (todas si admin, o asignadas a mí si vendedor)
app.get('/api/conversaciones', authMiddleware, async (req, res) => {
  try {
    const filtro = { tenant_id: req.user.tenant_id, estado: { $ne: 'cerrado' } };
    if (req.user.role === 'vendedor') filtro.agente_id = req.user.id;
    const convs = await Conversacion.find(filtro).sort({ ultimaActividad: -1 }).limit(100);

    // Enriquecer con nombre del Contacto en MongoDB para mostrar en el panel
    const convsEnriquecidas = await Promise.all(convs.map(async (conv) => {
      const obj = conv.toObject();
      if (!obj.nombre) {
        const contacto = await Contacto.findOne({ tenant_id: req.user.tenant_id, numero: conv.numero }).select('nombre nombre_alumno nivel_interes');
        if (contacto?.nombre) {
          obj.nombre = contacto.nombre;
          obj.nombre_alumno = contacto.nombre_alumno;
          obj.nivel_interes = contacto.nivel_interes;
        }
      }
      return obj;
    }));

    res.json({ ok: true, conversaciones: convsEnriquecidas });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Ver una conversación específica con su historial completo
app.get('/api/conversaciones/:id', authMiddleware, async (req, res) => {
  try {
    const conv = await Conversacion.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!conv) return res.status(404).json({ ok: false, error: 'No encontrada' });

    // Buscar el contacto para obtener su nivel de interés
    const contacto = await Contacto.findOne({ tenant_id: req.user.tenant_id, numero: conv.numero });

    // Sugerir imágenes según el nivel del contacto
    let imagenesSugeridas = [];
    if (contacto?.nivel_interes) {
      const nivel = contacto.nivel_interes;
      // Buscar imágenes que coincidan con el nivel o sean para todos
      imagenesSugeridas = await ImagenMarketing.find({
        tenant_id: req.user.tenant_id,
        activo: true,
        $or: [
          { nivel_educativo: nivel },
          { nivel_educativo: 'Todos' }
        ]
      }).select('-imagen_base64').limit(6); // Sin base64 para carga rápida
    } else {
      // Sin nivel conocido — mostrar imágenes generales
      imagenesSugeridas = await ImagenMarketing.find({
        tenant_id: req.user.tenant_id,
        activo: true,
        nivel_educativo: 'Todos'
      }).select('-imagen_base64').limit(4);
    }

    res.json({ ok: true, conversacion: conv, contacto, imagenes_sugeridas: imagenesSugeridas });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Agente toma/responde manualmente una conversación
app.post('/api/conversaciones/:id/responder', authMiddleware, async (req, res) => {
  try {
    const { mensaje, imagen_id, imagen_base64, imagen_mime } = req.body;
    if (!mensaje && !imagen_id && !imagen_base64) return res.status(400).json({ ok: false, error: 'Mensaje o imagen requeridos' });

    const conv = await Conversacion.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!conv) return res.status(404).json({ ok: false, error: 'No encontrada' });

    // Si nadie la había tomado, este agente la toma ahora
    if (!conv.agente_id) {
      conv.agente_id = req.user.id;
      conv.agente_nombre = req.user.nombre || req.user.email;
      conv.estado = 'humano';
    }

    let resultado;
    // Meta espera el PSID puro, sin el prefijo "ig_"/"fb_" que usamos internamente
    // para distinguir el canal en conv.numero — si se lo mandamos con prefijo, Meta
    // rechaza el envío silenciosamente (por eso no llegaba nada por IG/Messenger).
    const idExternoReal = conv.numero.replace(/^(ig_|fb_)/, '');

    if (imagen_id) {
      // Imagen del catálogo preclasificado — ahora enrutada por el canal real,
      // antes siempre intentaba mandarse por WhatsApp sin importar el canal.
      const img = await ImagenMarketing.findOne({ _id: imagen_id, tenant_id: req.user.tenant_id });
      if (!img) return res.status(404).json({ ok: false, error: 'Imagen no encontrada' });
      if (conv.canal === 'instagram' || conv.canal === 'messenger') {
        resultado = await enviarImagenInstagramOMessenger(conv.canal, img.imagen_base64, img.mime_type, idExternoReal, mensaje || '');
      } else {
        resultado = await enviarImagenDesdeDB(img, conv.numero, mensaje || '');
      }
      conv.mensajes.push({ de: 'agente', texto: mensaje ? `📷 ${img.nombre} — ${mensaje}` : `📷 ${img.nombre}` });
    } else if (imagen_base64) {
      // Imagen subida ad-hoc desde la computadora del agente (no viene del catálogo)
      if (conv.canal === 'instagram' || conv.canal === 'messenger') {
        resultado = await enviarImagenInstagramOMessenger(conv.canal, imagen_base64, imagen_mime || 'image/jpeg', idExternoReal, mensaje || '');
      } else {
        const mediaId = await subirImagenAMeta(imagen_base64, imagen_mime || 'image/jpeg');
        resultado = mediaId ? await enviarImagenWhatsAppMeta(conv.numero, mediaId, mensaje || '') : { error: { message: 'No se pudo subir la imagen a WhatsApp' } };
      }
      conv.mensajes.push({ de: 'agente', texto: mensaje ? `📷 [imagen adjunta] — ${mensaje}` : '📷 [imagen adjunta]' });
    } else {
      // Enviar por el canal real de la conversación — antes esto SIEMPRE mandaba por WhatsApp,
      // aunque la conversación fuera de Instagram o Messenger (el mensaje no llegaba a nadie).
      if (conv.canal === 'instagram') {
        resultado = await enviarMensajeInstagram(idExternoReal, mensaje);
      } else if (conv.canal === 'messenger') {
        resultado = await enviarMensajeMessenger(idExternoReal, mensaje);
      } else {
        resultado = await enviarWhatsAppMeta(conv.numero, mensaje);
      }
      conv.mensajes.push({ de: 'agente', texto: mensaje });
    }

    conv.ultimaActividad = new Date();
    await conv.save();

    // Si Meta devolvió un error (ej. falta INSTAGRAM_PAGE_TOKEN/MESSENGER_PAGE_TOKEN en Railway),
    // el mensaje quedó guardado en el historial pero NO llegó realmente al padre — avisamos.
    if (resultado && resultado.error) {
      return res.json({
        ok: false,
        error: `El mensaje se guardó pero no se pudo entregar por ${conv.canal}: ${resultado.error.message || 'error desconocido de Meta'}. Revisa que el token de página (${conv.canal === 'instagram' ? 'INSTAGRAM_PAGE_TOKEN' : conv.canal === 'messenger' ? 'MESSENGER_PAGE_TOKEN' : 'WHATSAPP_TOKEN'}) esté bien configurado en Railway.`,
        conversacion: conv
      });
    }

    res.json({ ok: true, conversacion: conv, whatsapp: resultado });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Devolver la conversación a KAI (el bot retoma el control)
app.post('/api/conversaciones/:id/devolver-a-kai', authMiddleware, async (req, res) => {
  try {
    const conv = await Conversacion.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!conv) return res.status(404).json({ ok: false, error: 'No encontrada' });

    // Generar resumen del agente para que KAI tenga contexto al retomar
    const resumenAgente = await generarResumenParaKai(conv);
    conv.resumen_agente = resumenAgente;
    conv.estado = 'cerrado';
    await conv.save();

    // Inyectar el resumen en el historial de KAI para esa conversación, para que no repita preguntas
    if (resumenAgente) {
      if (!conversaciones.has(conv.numero)) conversaciones.set(conv.numero, { historial: [], ultimaActividad: Date.now() });
      const ctx = conversaciones.get(conv.numero);
      ctx.historial.push({ role: 'assistant', content: `(Contexto interno — no mostrar tal cual: mientras hablaba con un asesor humano, esto ocurrió: ${resumenAgente}. Retoma la conversación con naturalidad, sin mencionar este resumen explícitamente, solo úsalo para no preguntar lo que ya se resolvió.)` });
      ctx.ultimaActividad = Date.now();
    }

    res.json({ ok: true, mensaje: 'KAI retoma esta conversación', conversacion: conv, resumen_agente: resumenAgente });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Marcar mi disponibilidad para recibir chats asignados
app.post('/api/mi-disponibilidad', authMiddleware, async (req, res) => {
  try {
    const { disponible } = req.body;
    // Si el agente lo apaga manualmente: queda marcado como apagado a propósito (no se reactiva solo).
    // Si lo prende manualmente: vuelve al control automático normal del sistema de inactividad.
    await UsuarioPanel.findByIdAndUpdate(req.user.id, {
      disponible: !!disponible,
      disponible_manual: !disponible, // true solo cuando se apaga manualmente
      ultima_actividad: new Date()
    });
    res.json({ ok: true, disponible: !!disponible });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/dashboard', authMiddleware, async (req, res) => {
  try {
    const [leads, perdidos, stages, reasons, tags] = await Promise.all([
      getLeads(500), getLeadsPerdidos(500), getStages(), getLostReasons(), getTags()
    ]);
    const porEtapa={}, porUsuario={}, porMotivo={};
    (leads||[]).forEach(l=>{
      const e=l.stage_id?.[1]||'Sin etapa'; porEtapa[e]=(porEtapa[e]||0)+1;
      const u=l.user_id?.[1]||'Sin asignar'; porUsuario[u]=(porUsuario[u]||0)+1;
    });
    (perdidos||[]).forEach(l=>{
      const m=l.lost_reason_id?.[1]||'Sin motivo'; porMotivo[m]=(porMotivo[m]||0)+1;
    });
    res.json({
      ok:true,
      resumen:{ totalLeads:(leads||[]).length, totalPerdidos:(perdidos||[]).length, totalEtapas:(stages||[]).length },
      porEtapa, porUsuario, porMotivo,
      ultimosLeads:(leads||[]).slice(0,10),
      stages:stages||[], reasons:reasons||[], tags:tags||[]
    });
  } catch (err) { res.status(500).json({ ok:false, error:err.message }); }
});

// Endpoint de prueba — crea un lead de prueba directo en Odoo para confirmar permisos de escritura
app.post('/api/odoo/test-escritura', authMiddleware, async (req, res) => {
  try {
    const teamId = 1;
    const leadId = await odooCallLocal('crm.lead', 'create', [{
      name: `PRUEBA ESCRITURA KAI — ${new Date().toLocaleString('es-GT')}`,
      phone: '00000000',
      description: 'Lead de prueba para confirmar que el usuario de Odoo tiene permisos de escritura. Puede eliminarse.',
      team_id: teamId,
      type: 'opportunity'
    }]);
    if (leadId) {
      res.json({ ok: true, mensaje: 'Escritura exitosa en Odoo', lead_id: leadId });
    } else {
      res.json({ ok: false, error: 'odooCallLocal no devolvió un ID — revisa logs del servidor' });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Crea 3 leads de prueba — uno por cada nivel de calor — para verificar las etiquetas en Odoo
app.post('/api/odoo/test-niveles-calor', authMiddleware, async (req, res) => {
  try {
    const teamId = 1;
    const niveles = [
      { nivel: 1, etiqueta: 'KAI — Alta Intención', nombre: 'PRUEBA Nivel 1 — Familia Pérez', telefono: '50211111111' },
      { nivel: 2, etiqueta: 'KAI — Interesado', nombre: 'PRUEBA Nivel 2 — Familia Gómez', telefono: '50222222222' },
      { nivel: 3, etiqueta: 'KAI — Exploratorio', nombre: 'PRUEBA Nivel 3 — Familia López', telefono: '50233333333' },
    ];

    const resultados = [];
    for (const n of niveles) {
      const tagId = await getOdooTagId(n.etiqueta);
      const leadId = await odooCallLocal('crm.lead', 'create', [{
        name: `Lead KAI — ${n.nombre}`,
        phone: n.telefono,
        description: `PRUEBA — Lead de demostración del nivel de calor: ${n.etiqueta}. Puede eliminarse, fue creado para validar el sistema de etiquetas.`,
        team_id: teamId,
        type: 'opportunity',
        tag_ids: tagId ? [[6, 0, [tagId]]] : undefined
      }]);
      resultados.push({ nivel: n.nivel, etiqueta: n.etiqueta, lead_id: leadId, tag_id: tagId });
    }

    res.json({ ok: true, mensaje: '3 leads de prueba creados con sus etiquetas de nivel de calor', resultados });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => res.sendFile('index.html', { root: 'public' }));

// ===== SEED DE IMÁGENES AL INICIAR =====
// Carga las imágenes del colegio en MongoDB si no existen todavía.
// Los admin/vendedores pueden agregar, modificar o eliminar imágenes desde el panel.
async function seedImagenes() {
  // Envuelto en try/catch total — nunca debe crashear el servidor
  try {
    const tenant = await Tenant.findOne({ activo: true });
    if (!tenant) return;

    let IMAGENES_SEED;
    try { IMAGENES_SEED = require('./imagenes_seed.js'); }
    catch(e) { console.log('ℹ️ imagenes_seed.js no encontrado — omitiendo'); return; }

    if (!Array.isArray(IMAGENES_SEED) || !IMAGENES_SEED.length) return;

    let nuevas = 0;
    for (const img of IMAGENES_SEED) {
      try {
        const existe = await ImagenMarketing.findOne({ tenant_id: tenant._id, nombre: img.nombre, activo: true });
        if (existe) continue;
        await ImagenMarketing.create({
          tenant_id: tenant._id,
          nombre: img.nombre,
          categoria: img.categoria || 'general',
          nivel_educativo: img.nivel_educativo || 'Todos',
          imagen_base64: img.imagen_base64,
          mime_type: img.mime_type || 'image/jpeg',
          caption: img.caption || '',
          subida_por_nombre: 'Sistema — carga inicial'
        });
        nuevas++;
      } catch(imgErr) {
        console.error(`⚠️ No se pudo cargar imagen "${img.nombre}":`, imgErr.message);
      }
    }
    console.log(nuevas > 0
      ? `🖼️ ${nuevas} imágenes cargadas en el banco`
      : `🖼️ Banco OK — ${IMAGENES_SEED.length} imágenes ya estaban cargadas`);
  } catch(e) {
    console.error('⚠️ Seed imágenes (no crítico):', e.message);
  }
}

app.listen(PORT, () => {
  console.log(`✅ KAI — Colegio Capouilliez corriendo en puerto ${PORT} | v2026.07.14-acrux`);
  console.log(`📊 Planes: Básico(${PLANES.basico.mensajes_mes}msg/${PLANES.basico.max_usuarios}usr) | Profesional(${PLANES.profesional.mensajes_mes}msg/${PLANES.profesional.max_usuarios}usr) | Empresarial(${PLANES.empresarial.mensajes_mes}msg/${PLANES.empresarial.max_usuarios}usr)`);
  // Cargar imágenes del colegio en MongoDB al iniciar (si no existen)
  setTimeout(seedImagenes, 5000); // esperar 5s a que MongoDB esté listo
});
