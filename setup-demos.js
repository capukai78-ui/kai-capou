/**
 * BOTLY INC. - Setup Usuarios Demo
 * Ejecutar: node setup-demos.js
 * 
 * Crea los 4 tenants + usuarios demo restantes en MongoDB
 * (El Colegio San José ya existe, se salta si ya está)
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => { console.error('❌ Error MongoDB:', err); process.exit(1); });

// ===== SCHEMAS (igual que index.js) =====
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
  plan: { type: String, default: 'basico' },
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

const Tenant = mongoose.model('Tenant', tenantSchema);
const User = mongoose.model('User', userSchema);

// ===== DATOS DE LOS 4 DEMOS =====
const demos = [
  {
    tenant: {
      nombre: 'Clínica Dr. Martínez GT',
      numero_whatsapp: '+15005550003',
      plan: 'profesional',
      odoo_team_id: 2,
      config: {
        bienvenida: 'Clínica Dr. Martínez — atención médica de calidad en Guatemala. Especialidades: medicina general, pediatría, ginecología y cardiología.',
        sedes: [
          { nombre: 'Sede Central', direccion: 'Zona 10, Guatemala Ciudad', telefono: '2300-1234', horario: 'L-V 8am-6pm, Sáb 8am-12pm' }
        ],
        menu: [
          { opcion: 'Agendar cita', respuesta: 'Tenemos disponibilidad: Martes 10am/2pm/4pm, Miércoles 9am/11am, Jueves 3pm. ¿Qué día le conviene?' },
          { opcion: 'Precios consulta', respuesta: 'Consulta general Q200, Especialista Q350. Incluye receta y orientación.' },
          { opcion: 'Especialidades', respuesta: 'Medicina general, Pediatría, Ginecología, Cardiología, Nutrición.' },
          { opcion: 'Resultados de laboratorio', respuesta: 'Sus resultados estarán listos en 24-48 horas. Le notificamos por WhatsApp.' }
        ]
      }
    },
    user: {
      nombre: 'Clínica Dr. Martínez',
      email: 'clinica@botly.io',
      password: 'clinica123'
    }
  },
  {
    tenant: {
      nombre: 'Farmacia San Rafael GT',
      numero_whatsapp: '+15005550002',
      plan: 'basico',
      odoo_team_id: 3,
      config: {
        bienvenida: 'Farmacia San Rafael — medicamentos genéricos y de marca con hasta 40% de descuento. Delivery gratis en compras mayores a Q150.',
        sedes: [
          { nombre: 'Sucursal Zona 1', direccion: 'Zona 1, Guatemala Ciudad', telefono: '2300-0001', horario: 'L-S 8am-8pm, Dom 9am-2pm' },
          { nombre: 'Sucursal Zona 6', direccion: 'Zona 6, Guatemala Ciudad', telefono: '2300-0002', horario: 'L-S 8am-8pm, Dom 9am-2pm' }
        ],
        menu: [
          { opcion: 'Precios medicamentos', respuesta: 'Metformina 850mg Q45/30tab, Amoxicilina 500mg Q35/12cap, Losartán 50mg Q40/30tab, Omeprazol 20mg Q28/14cap.' },
          { opcion: 'Delivery', respuesta: 'Delivery gratis en compras +Q150, zonas 1-10. Tiempo estimado: 45-60 minutos.' },
          { opcion: 'Medicamentos controlados', respuesta: 'Los medicamentos controlados requieren receta médica. Tráigala a cualquier sucursal.' },
          { opcion: 'Descuentos', respuesta: 'Tenemos hasta 40% en genéricos. Pregúntenos por el equivalente de su medicamento.' }
        ]
      }
    },
    user: {
      nombre: 'Farmacia San Rafael',
      email: 'farmacia@botly.io',
      password: 'farmacia123'
    }
  },
  {
    tenant: {
      nombre: 'Restaurante El Fogón GT',
      numero_whatsapp: '+15005550004',
      plan: 'profesional',
      odoo_team_id: 4,
      config: {
        bienvenida: 'El Fogón GT — sabores auténticos de Guatemala. Reservaciones, delivery y menú del día disponible todos los días.',
        sedes: [
          { nombre: 'Restaurante Principal', direccion: 'Zona 10, Guatemala Ciudad', telefono: '2400-5678', horario: 'L-S 12pm-10pm, Dom 12pm-8pm' }
        ],
        menu: [
          { opcion: 'Menú del día', respuesta: 'Hoy: Sopa de frijoles, Pepián de pollo con arroz, Ensalada y agua fresca. Todo por Q65.' },
          { opcion: 'Reservaciones', respuesta: 'Aceptamos reservaciones con mínimo 2 horas de anticipación. ¿Para cuántas personas y a qué hora?' },
          { opcion: 'Delivery', respuesta: 'Delivery en zonas 10, 13, 14 y 15. Costo Q20. Tiempo estimado 40-50 minutos.' },
          { opcion: 'Especialidades', respuesta: 'Carne asada, Pepián, Pollo en amarillo, Jocon, Plátanos fritos. Todos con sazón guatemalteco.' }
        ]
      }
    },
    user: {
      nombre: 'El Fogón GT',
      email: 'restaurante@botly.io',
      password: 'restaurante123'
    }
  },
  {
    tenant: {
      nombre: 'Ferretería El Constructor GT',
      numero_whatsapp: '+15005550005',
      plan: 'profesional',
      odoo_team_id: 5,
      config: {
        bienvenida: 'Ferretería El Constructor — materiales de construcción y ferretería en general. 2 sucursales en Guatemala con delivery de materiales.',
        sedes: [
          { nombre: 'Sucursal Zona 3', direccion: 'Zona 3, Guatemala Ciudad', telefono: '2500-1111', horario: 'L-S 7am-6pm' },
          { nombre: 'Sucursal Zona 8', direccion: 'Zona 8, Guatemala Ciudad', telefono: '2500-2222', horario: 'L-S 7am-6pm' }
        ],
        menu: [
          { opcion: 'Precios materiales', respuesta: 'Varilla 3/8" Q28/u (Q2,600/quintal), Block 15x20x40 Q4.50, Cemento Progreso Q68/saco, Lámina zinc 8ft Q95.' },
          { opcion: 'Delivery materiales', respuesta: 'Delivery en camioneta Q200 dentro del municipio. Mínimo Q500 en compra. ¿Cuánto material necesita?' },
          { opcion: 'Cotizaciones', respuesta: 'Con gusto le hacemos una cotización. Dígame qué materiales y cantidades necesita.' },
          { opcion: 'Stock disponible', respuesta: 'Tenemos stock en ambas sucursales. ¿Qué material busca? Le confirmo disponibilidad al instante.' }
        ]
      }
    },
    user: {
      nombre: 'Ferretería El Constructor',
      email: 'ferreteria@botly.io',
      password: 'ferreteria123'
    }
  }
];

// ===== FUNCIÓN PRINCIPAL =====
async function setupDemos() {
  console.log('\n🚀 Iniciando setup de usuarios demo...\n');

  for (const demo of demos) {
    try {
      // 1. Verificar si el tenant ya existe por número
      let tenant = await Tenant.findOne({ numero_whatsapp: demo.tenant.numero_whatsapp });

      if (tenant) {
        console.log(`⚠️  Tenant ya existe: ${demo.tenant.nombre} — actualizando config...`);
        tenant = await Tenant.findByIdAndUpdate(tenant._id, demo.tenant, { new: true });
      } else {
        tenant = await Tenant.create(demo.tenant);
        console.log(`✅ Tenant creado: ${demo.tenant.nombre}`);
      }

      // 2. Crear o actualizar usuario
      const existeUser = await User.findOne({ email: demo.user.email });

      if (existeUser) {
        console.log(`⚠️  Usuario ya existe: ${demo.user.email} — saltando...`);
      } else {
        const hash = await bcrypt.hash(demo.user.password, 10);
        await User.create({
          nombre: demo.user.nombre,
          email: demo.user.email,
          password: hash,
          tenant_id: tenant._id,
          rol: 'cliente'
        });
        console.log(`✅ Usuario creado: ${demo.user.email} / ${demo.user.password}`);
      }

      console.log('');
    } catch (err) {
      console.error(`❌ Error con ${demo.tenant.nombre}:`, err.message);
    }
  }

  // ===== RESUMEN FINAL =====
  console.log('═══════════════════════════════════════════');
  console.log('           CREDENCIALES DE ACCESO           ');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('🏫 COLEGIO      colegio@botly.io     / colegio123');
  console.log('🏥 CLÍNICA      clinica@botly.io     / clinica123');
  console.log('💊 FARMACIA     farmacia@botly.io    / farmacia123');
  console.log('🍽️  RESTAURANTE  restaurante@botly.io / restaurante123');
  console.log('🔧 FERRETERÍA   ferreteria@botly.io  / ferreteria123');
  console.log('');
  console.log('🌐 Panel: https://botpanel-gt-production.up.railway.app');
  console.log('');
  console.log('✅ Setup completado');
  console.log('═══════════════════════════════════════════');

  mongoose.connection.close();
}

setupDemos();
