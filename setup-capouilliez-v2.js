require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MONGODB_URI = process.env.MONGODB_URI;

const tenantSchema = new mongoose.Schema({
  nombre: String,
  numero_whatsapp: String,
  plan: String,
  activo: { type: Boolean, default: true },
  config: Object
});

const usuarioPanelSchema = new mongoose.Schema({
  nombre: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, enum: ['admin', 'vendedor', 'viewer'], default: 'vendedor' },
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  sedes: [String],
  activo: { type: Boolean, default: true },
  lastLogin: Date,
  creado: { type: Date, default: Date.now }
});

const Tenant = mongoose.model('Tenant', tenantSchema);
const UsuarioPanel = mongoose.model('UsuarioPanel', usuarioPanelSchema);

async function setup() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Conectado a MongoDB');

    // Crear o encontrar tenant
    let tenant = await Tenant.findOne({ nombre: 'Colegio Capouilliez' });
    if (!tenant) {
      tenant = await Tenant.create({
        nombre: 'Colegio Capouilliez',
        numero_whatsapp: '',
        plan: 'profesional',
        activo: true,
        config: {
          bienvenida: 'Colegio Capouilliez - Institución educativa de prestigio en Guatemala',
          menu: [],
          sedes: []
        }
      });
      console.log('✅ Tenant creado:', tenant._id);
    } else {
      console.log('✅ Tenant encontrado:', tenant._id);
    }

    // Usuarios
    const usuarios = [
      { nombre: 'Administrador', email: 'admin@capouilliez.edu.gt', password: 'Admin2026!', role: 'admin', sedes: ['todas'] },
      { nombre: 'Admisiones', email: 'admisiones@capouilliez.edu.gt', password: 'Admisiones2026!', role: 'vendedor', sedes: ['todas'] },
      { nombre: 'Asesor', email: 'asesor@capouilliez.edu.gt', password: 'Asesor2026!', role: 'viewer', sedes: ['todas'] }
    ];

    for (const u of usuarios) {
      const existe = await UsuarioPanel.findOne({ email: u.email });
      if (!existe) {
        const hashed = await bcrypt.hash(u.password, 10);
        await UsuarioPanel.create({ ...u, password: hashed, tenant_id: tenant._id });
        console.log(`✅ Creado: ${u.email} / ${u.password}`);
      } else {
        // Actualizar tenant_id por si acaso
        await UsuarioPanel.findOneAndUpdate({ email: u.email }, { tenant_id: tenant._id });
        console.log(`⚠️  Ya existe (tenant actualizado): ${u.email}`);
      }
    }

    console.log('\n🎉 Setup completado');
    console.log('admin@capouilliez.edu.gt / Admin2026!');
    console.log('admisiones@capouilliez.edu.gt / Admisiones2026!');
    console.log('asesor@capouilliez.edu.gt / Asesor2026!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

setup();
